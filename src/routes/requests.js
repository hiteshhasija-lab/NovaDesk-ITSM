const { db, logActivity, nowStr } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { REQUEST_STATUS_LABELS, toCsv, reportRangeCutoff } = require('../helpers');
const requestActions = require('../requestActions');
const { parseSort, sortRows, paginate } = require('../listquery');
const createAsyncRouter = require('../asyncRouter');

const router = createAsyncRouter();

const REQUEST_SORT_COLUMNS = {
  number: r => r.number,
  item_name: r => r.item_name || '',
  status: r => r.status,
  created_at: r => r.created_at
};

router.get('/', requireAuth, async (req, res) => {
  const isEndUser = req.session.user.role === 'user';
  const uid = req.session.user.id;
  const { status, requested_by, assigned_to, q } = req.query;

  let where = [];
  let params = [];
  if (isEndUser) { where.push('r.requested_by = ?'); params.push(uid); }
  if (status === 'open') { where.push("r.status IN ('submitted','in_progress')"); }
  else if (status) { where.push('r.status = ?'); params.push(status); }
  if (!isEndUser && requested_by) { where.push('r.requested_by = ?'); params.push(requested_by); }
  if (!isEndUser) {
    if (assigned_to === 'unassigned') { where.push('r.assigned_to IS NULL'); }
    else if (assigned_to) { where.push('r.assigned_to = ?'); params.push(assigned_to); }
  }
  if (q) { where.push('(r.number ILIKE ? OR ci.name ILIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  let requests = await db.prepare(`
    SELECT r.*, ci.name AS item_name, ci.icon AS item_icon, u.full_name AS requester_name, a.full_name AS assigned_name
    FROM service_requests r
    LEFT JOIN catalog_items ci ON ci.id = r.catalog_item_id
    LEFT JOIN users u ON u.id = r.requested_by
    LEFT JOIN users a ON a.id = r.assigned_to
    ${whereSql}
    ORDER BY r.created_at DESC
  `).all(...params);

  const sort = parseSort(req, REQUEST_SORT_COLUMNS, 'created_at', 'desc');
  requests = sortRows(requests, REQUEST_SORT_COLUMNS, sort.key, sort.dir);
  const { items, pagination } = paginate(requests, req);

  const requesterUsers = isEndUser ? [] : await db.prepare("SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name").all();
  const assignableUsers = isEndUser ? [] : await db.prepare("SELECT id, full_name FROM users WHERE active = 1 AND role != 'user' ORDER BY full_name").all();

  res.render('catalog/requests-list', {
    title: 'My Requests', requests: items, filters: { status, requested_by, assigned_to, q },
    isEndUser, requesterUsers, assignableUsers, sort, pagination, query: req.query
  });
});

router.get('/export.csv', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const isEndUser = req.session.user.role === 'user';
  const uid = req.session.user.id;
  const { status, requested_by, assigned_to, q } = req.query;

  let where = [];
  let params = [];
  if (isEndUser) { where.push('r.requested_by = ?'); params.push(uid); }
  if (status === 'open') { where.push("r.status IN ('submitted','in_progress')"); }
  else if (status) { where.push('r.status = ?'); params.push(status); }
  if (!isEndUser && requested_by) { where.push('r.requested_by = ?'); params.push(requested_by); }
  if (!isEndUser) {
    if (assigned_to === 'unassigned') { where.push('r.assigned_to IS NULL'); }
    else if (assigned_to) { where.push('r.assigned_to = ?'); params.push(assigned_to); }
  }
  if (q) { where.push('(r.number ILIKE ? OR ci.name ILIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    const rangeCutoff = reportRangeCutoff(req.query.range);
  if (rangeCutoff) { where.push('r.created_at >= ?'); params.push(rangeCutoff); }
const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  let requests = await db.prepare(`
    SELECT r.*, ci.name AS item_name, u.full_name AS requester_name, a.full_name AS assigned_name
    FROM service_requests r
    LEFT JOIN catalog_items ci ON ci.id = r.catalog_item_id
    LEFT JOIN users u ON u.id = r.requested_by
    LEFT JOIN users a ON a.id = r.assigned_to
    ${whereSql}
    ORDER BY r.created_at DESC
  `).all(...params);

  const sort = parseSort(req, REQUEST_SORT_COLUMNS, 'created_at', 'desc');
  requests = sortRows(requests, REQUEST_SORT_COLUMNS, sort.key, sort.dir);

  const csv = toCsv(requests, [
    { label: 'Number', value: r => r.number },
    { label: 'Item', value: r => r.item_name || '' },
    { label: 'Status', value: r => REQUEST_STATUS_LABELS[r.status] },
    { label: 'Requested By', value: r => r.requester_name || '' },
    { label: 'Assigned To', value: r => r.assigned_name || '' },
    { label: 'Notes', value: r => r.notes || '' },
    { label: 'Created', value: r => r.created_at },
    { label: 'Fulfilled', value: r => r.fulfilled_at || '' }
  ]);

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="service-requests.csv"');
  res.send(csv);
});

router.get('/:id', requireAuth, async (req, res) => {
  const request = await db.prepare(`
    SELECT r.*, ci.name AS item_name, ci.description AS item_description, ci.fulfillment_group,
      u.full_name AS requester_name, a.full_name AS assigned_name
    FROM service_requests r
    LEFT JOIN catalog_items ci ON ci.id = r.catalog_item_id
    LEFT JOIN users u ON u.id = r.requested_by
    LEFT JOIN users a ON a.id = r.assigned_to
    WHERE r.id = ?
  `).get(req.params.id);

  if (!request) return res.status(404).render('error', { title: 'Not Found', message: 'Request not found.' });
  if (req.session.user.role === 'user' && request.requested_by !== req.session.user.id) {
    return res.status(403).render('error', { title: 'Access Denied', message: 'You cannot view this request.' });
  }

  const activity = await db.prepare(`
    SELECT al.*, u.full_name AS actor_name FROM activity_log al
    LEFT JOIN users u ON u.id = al.actor_id
    WHERE al.entity_type = 'request' AND al.entity_id = ? ORDER BY al.created_at ASC
  `).all(req.params.id);

  const staffUsers = await db.prepare("SELECT id, full_name FROM users WHERE active = 1 AND role != 'user' ORDER BY full_name").all();

  res.render('catalog/request-show', { title: request.number, request, activity, staffUsers });
});

router.post('/:id/update', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const existing = await db.prepare('SELECT * FROM service_requests WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).render('error', { title: 'Not Found', message: 'Request not found.' });
  await requestActions.updateServiceRequest({ actor: req.session.user, existing, fields: req.body });
  res.redirect(`/requests/${req.params.id}`);
});

router.post('/:id/cancel', requireAuth, async (req, res) => {
  const existing = await db.prepare('SELECT * FROM service_requests WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).render('error', { title: 'Not Found', message: 'Request not found.' });

  const isOwner = existing.requested_by === req.session.user.id;
  const isStaff = ['admin', 'agent'].includes(req.session.user.role);
  if (!isOwner && !isStaff) {
    return res.status(403).render('error', { title: 'Access Denied', message: 'You cannot cancel this request.' });
  }
  if (existing.status !== 'submitted') {
    return res.status(400).render('error', { title: 'Cannot Cancel', message: 'This request is already being worked on and can no longer be self-cancelled.' });
  }

  await db.prepare(`UPDATE service_requests SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(nowStr(), req.params.id);
  await logActivity('request', existing.id, req.session.user.id, 'Request cancelled');
  res.redirect(`/requests/${req.params.id}`);
});

module.exports = router;
