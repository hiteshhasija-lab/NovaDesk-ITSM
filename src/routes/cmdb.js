const { db, nextNumber, nowStr } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { CI_TYPE_LABELS, CI_STATUS_LABELS, ENVIRONMENT_LABELS, toCsv } = require('../helpers');
const { parseSort, sortRows, paginate } = require('../listquery');
const createAsyncRouter = require('../asyncRouter');

const router = createAsyncRouter();

const CI_SORT_COLUMNS = {
  ci_number: r => r.ci_number,
  name: r => r.name,
  ci_type: r => r.ci_type,
  status: r => r.status,
  created_at: r => r.created_at
};

async function loadFormLookups(excludeId) {
  const users = await db.prepare("SELECT id, full_name, role FROM users WHERE active = 1 ORDER BY full_name").all();
  const cis = await db.prepare(`SELECT id, ci_number, name FROM cmdb_ci ${excludeId ? 'WHERE id != ?' : ''} ORDER BY name`)
    .all(...(excludeId ? [excludeId] : []));
  return { users, cis };
}

router.get('/', requireAuth, async (req, res) => {
  const { ci_type, status, environment, location, q } = req.query;
  let where = [];
  let params = [];
  if (ci_type) { where.push('ci.ci_type = ?'); params.push(ci_type); }
  if (status) { where.push('ci.status = ?'); params.push(status); }
  if (environment) { where.push('ci.environment = ?'); params.push(environment); }
  if (location) { where.push('ci.location = ?'); params.push(location); }
  if (q) { where.push('(ci.name ILIKE ? OR ci.ci_number ILIKE ? OR ci.ip_address ILIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  let items = await db.prepare(`
    SELECT ci.*, u.full_name AS owner_name
    FROM cmdb_ci ci LEFT JOIN users u ON u.id = ci.owner_id
    ${whereSql}
    ORDER BY ci.ci_type, ci.name
  `).all(...params);

  const sort = parseSort(req, CI_SORT_COLUMNS, 'ci_type', 'asc');
  items = sortRows(items, CI_SORT_COLUMNS, sort.key, sort.dir);
  const { items: pagedItems, pagination } = paginate(items, req);

  const locationRows = await db.prepare("SELECT DISTINCT location FROM cmdb_ci WHERE location IS NOT NULL AND location != '' ORDER BY location").all();
  const locations = locationRows.map(r => r.location);

  res.render('cmdb/list', {
    title: 'CMDB - Configuration Items', items: pagedItems, filters: { ci_type, status, environment, location, q },
    locations, sort, pagination, query: req.query
  });
});

router.get('/new', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const { users, cis } = await loadFormLookups();
  res.render('cmdb/form', { title: 'New Configuration Item', ci: null, users, cis, relationships: [] });
});

router.get('/export.csv', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const items = await db.prepare(`
    SELECT ci.*, u.full_name AS owner_name
    FROM cmdb_ci ci LEFT JOIN users u ON u.id = ci.owner_id
    ORDER BY ci.ci_type, ci.name
  `).all();

  const csv = toCsv(items, [
    { label: 'CI Number', value: r => r.ci_number },
    { label: 'Name', value: r => r.name },
    { label: 'Type', value: r => CI_TYPE_LABELS[r.ci_type] || r.ci_type },
    { label: 'Environment', value: r => ENVIRONMENT_LABELS[r.environment] || r.environment },
    { label: 'Status', value: r => CI_STATUS_LABELS[r.status] },
    { label: 'IP Address', value: r => r.ip_address || '' },
    { label: 'OS', value: r => r.os || '' },
    { label: 'Location', value: r => r.location || '' },
    { label: 'Date (Added)', value: r => r.created_at || '' },
    { label: 'Owner', value: r => r.owner_name || '' },
    { label: 'Serial Number', value: r => r.serial_number || '' },
    { label: 'Warranty Expiry', value: r => r.warranty_expiry || '' }
  ]);

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="cmdb.csv"');
  res.send(csv);
});

router.post('/', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const b = req.body;
  const ci_number = await nextNumber('ci', 'CI');
  const info = await db.prepare(`
    INSERT INTO cmdb_ci (ci_number, name, ci_type, environment, status, ip_address, os, manufacturer, model,
      serial_number, location, owner_id, support_group, cpu, ram, disk, purchase_date, warranty_expiry,
      install_date, notes, created_by)
    VALUES (@ci_number, @name, @ci_type, @environment, @status, @ip_address, @os, @manufacturer, @model,
      @serial_number, @location, @owner_id, @support_group, @cpu, @ram, @disk, @purchase_date, @warranty_expiry,
      @install_date, @notes, @created_by)
    RETURNING id
  `).run({
    ci_number,
    name: b.name,
    ci_type: b.ci_type,
    environment: b.environment || 'production',
    status: b.status || 'in_use',
    ip_address: b.ip_address || null,
    os: b.os || null,
    manufacturer: b.manufacturer || null,
    model: b.model || null,
    serial_number: b.serial_number || null,
    location: b.location || null,
    owner_id: b.owner_id || null,
    support_group: b.support_group || null,
    cpu: b.cpu || null,
    ram: b.ram || null,
    disk: b.disk || null,
    purchase_date: b.purchase_date || null,
    warranty_expiry: b.warranty_expiry || null,
    install_date: b.install_date || null,
    notes: b.notes || null,
    created_by: req.session.user.id
  });
  res.redirect(`/cmdb/${info.lastInsertRowid}`);
});

router.get('/:id', requireAuth, async (req, res) => {
  const ci = await db.prepare(`
    SELECT ci.*, u.full_name AS owner_name FROM cmdb_ci ci LEFT JOIN users u ON u.id = ci.owner_id WHERE ci.id = ?
  `).get(req.params.id);
  if (!ci) return res.status(404).render('error', { title: 'Not Found', message: 'Configuration item not found.' });

  const relationships = await db.prepare(`
    SELECT r.*, p.name AS parent_name, p.ci_number AS parent_number, ch.name AS child_name, ch.ci_number AS child_number
    FROM ci_relationships r
    JOIN cmdb_ci p ON p.id = r.parent_ci_id
    JOIN cmdb_ci ch ON ch.id = r.child_ci_id
    WHERE r.parent_ci_id = ? OR r.child_ci_id = ?
  `).all(req.params.id, req.params.id);

  const relatedIncidents = await db.prepare(`
    SELECT id, number, short_description, status, priority FROM incidents WHERE affected_ci_id = ? ORDER BY created_at DESC LIMIT 10
  `).all(req.params.id);

  const relatedChanges = await db.prepare(`
    SELECT id, number, short_description, status, risk FROM changes WHERE affected_ci_id = ? ORDER BY created_at DESC LIMIT 10
  `).all(req.params.id);

  const upstream = relationships
    .filter(r => r.parent_ci_id === ci.id)
    .map(r => ({ id: r.child_ci_id, number: r.child_number, name: r.child_name, relationship_type: r.relationship_type }));

  const downstream = relationships
    .filter(r => r.child_ci_id === ci.id)
    .map(r => ({ id: r.parent_ci_id, number: r.parent_number, name: r.parent_name, relationship_type: r.relationship_type }));

  const { users, cis } = await loadFormLookups(ci.id);
  res.render('cmdb/show', { title: `${ci.ci_number} - ${ci.name}`, ci, relationships, upstream, downstream, relatedIncidents, relatedChanges, users, cis });
});

router.get('/:id/edit', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const ci = await db.prepare('SELECT * FROM cmdb_ci WHERE id = ?').get(req.params.id);
  if (!ci) return res.status(404).render('error', { title: 'Not Found', message: 'Configuration item not found.' });
  const { users, cis } = await loadFormLookups(ci.id);
  res.render('cmdb/form', { title: `Edit ${ci.ci_number}`, ci, users, cis, relationships: [] });
});

router.post('/:id/update', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const b = req.body;
  await db.prepare(`
    UPDATE cmdb_ci SET name=@name, ci_type=@ci_type, environment=@environment, status=@status, ip_address=@ip_address,
      os=@os, manufacturer=@manufacturer, model=@model, serial_number=@serial_number, location=@location,
      owner_id=@owner_id, support_group=@support_group, cpu=@cpu, ram=@ram, disk=@disk,
      purchase_date=@purchase_date, warranty_expiry=@warranty_expiry, install_date=@install_date, notes=@notes,
      updated_at=@updated_at
    WHERE id=@id
  `).run({
    id: req.params.id,
    name: b.name,
    ci_type: b.ci_type,
    environment: b.environment || 'production',
    status: b.status || 'in_use',
    ip_address: b.ip_address || null,
    os: b.os || null,
    manufacturer: b.manufacturer || null,
    model: b.model || null,
    serial_number: b.serial_number || null,
    location: b.location || null,
    owner_id: b.owner_id || null,
    support_group: b.support_group || null,
    cpu: b.cpu || null,
    ram: b.ram || null,
    disk: b.disk || null,
    purchase_date: b.purchase_date || null,
    warranty_expiry: b.warranty_expiry || null,
    install_date: b.install_date || null,
    notes: b.notes || null,
    updated_at: nowStr()
  });
  res.redirect(`/cmdb/${req.params.id}`);
});

router.post('/:id/relationships', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const { child_ci_id, relationship_type } = req.body;
  if (child_ci_id && Number(child_ci_id) !== Number(req.params.id)) {
    await db.prepare(`INSERT INTO ci_relationships (parent_ci_id, child_ci_id, relationship_type) VALUES (?, ?, ?)`)
      .run(req.params.id, child_ci_id, relationship_type || 'depends_on');
  }
  res.redirect(`/cmdb/${req.params.id}`);
});

router.post('/:id/relationships/:relId/delete', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  await db.prepare('DELETE FROM ci_relationships WHERE id = ?').run(req.params.relId);
  res.redirect(`/cmdb/${req.params.id}`);
});

router.post('/:id/delete', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    await db.prepare('DELETE FROM cmdb_ci WHERE id = ?').run(req.params.id);
    res.redirect('/cmdb');
  } catch (err) {
    if (err.code === '23503') { // Postgres foreign_key_violation
      return res.status(400).render('error', {
        title: 'Cannot Delete',
        message: 'This configuration item is still referenced by one or more incidents, changes, or problems. Reassign or close those records first, or set its status to Retired instead of deleting it.'
      });
    }
    throw err;
  }
});

module.exports = router;
