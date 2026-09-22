const { db, offsetDateStr } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const createAsyncRouter = require('../asyncRouter');

const router = createAsyncRouter();

const RANGE_DAYS = { '7': 7, '30': 30, '90': 90 };

router.get('/', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const days = RANGE_DAYS[req.query.range] || 30;
  const cutoff = offsetDateStr(-days);

  const mttr = await db.prepare(`
    SELECT AVG((EXTRACT(EPOCH FROM (resolved_at::timestamp - created_at::timestamp))) / 3600) as avg_hours, COUNT(*) as c
    FROM incidents
    WHERE resolved_at IS NOT NULL AND resolved_at >= ?
  `).get(cutoff);

  const mttrByPriority = await db.prepare(`
    SELECT priority, AVG((EXTRACT(EPOCH FROM (resolved_at::timestamp - created_at::timestamp))) / 3600) as avg_hours, COUNT(*) as c
    FROM incidents
    WHERE resolved_at IS NOT NULL AND resolved_at >= ?
    GROUP BY priority ORDER BY priority ASC
  `).all(cutoff);

  const slaRow = await db.prepare(`
    SELECT
      SUM(CASE WHEN resolved_at <= sla_due_at THEN 1 ELSE 0 END) as met,
      COUNT(*) as total
    FROM incidents
    WHERE resolved_at IS NOT NULL AND sla_due_at IS NOT NULL AND resolved_at >= ?
  `).get(cutoff);
  const slaCompliance = slaRow.total > 0 ? Math.round((slaRow.met / slaRow.total) * 100) : null;

  const changeOutcomes = await db.prepare(`
    SELECT status, COUNT(*) as c FROM changes
    WHERE created_at >= ? AND status IN ('implemented','closed','rejected','cancelled')
    GROUP BY status
  `).all(cutoff);
  const changeSuccess = changeOutcomes.reduce((s, r) => ['implemented', 'closed'].includes(r.status) ? s + r.c : s, 0);
  const changeTotal = changeOutcomes.reduce((s, r) => s + r.c, 0);
  const changeSuccessRate = changeTotal > 0 ? Math.round((changeSuccess / changeTotal) * 100) : null;

  const ticketsCreated = (await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM incidents WHERE created_at >= ?) +
      (SELECT COUNT(*) FROM changes WHERE created_at >= ?) +
      (SELECT COUNT(*) FROM problems WHERE created_at >= ?) as total
  `).get(cutoff, cutoff, cutoff)).total;

  const volumeRows = await db.prepare(`
    SELECT SUBSTRING(created_at, 1, 10) as day, COUNT(*) as c FROM incidents WHERE created_at >= ? GROUP BY day
  `).all(cutoff);
  const volumeMap = Object.fromEntries(volumeRows.map(r => [r.day, r.c]));
  const volume = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = offsetDateStr(-i);
    volume.push({ day: d, c: volumeMap[d] || 0 });
  }

  const priorityBreakdown = await db.prepare(`
    SELECT priority, COUNT(*) as c FROM incidents WHERE created_at >= ? GROUP BY priority ORDER BY priority ASC
  `).all(cutoff);

  const agentWorkloadRows = await db.prepare(`
    SELECT u.id, u.full_name,
      (SELECT COUNT(*) FROM incidents i WHERE i.assigned_to = u.id AND i.status NOT IN ('resolved','closed','cancelled')) as open_incidents,
      (SELECT COUNT(*) FROM changes c WHERE c.assigned_to = u.id AND c.status IN ('submitted','approved','scheduled')) as open_changes,
      (SELECT COUNT(*) FROM problems p WHERE p.assigned_to = u.id AND p.status NOT IN ('resolved','closed')) as open_problems
    FROM users u
    WHERE u.role IN ('admin','agent') AND u.active = 1
    ORDER BY u.full_name
  `).all();
  const agentWorkload = agentWorkloadRows.map(r => ({ ...r, total: r.open_incidents + r.open_changes + r.open_problems }));

  res.render('reports', {
    title: 'Reports',
    days,
    mttr,
    mttrByPriority,
    slaCompliance,
    slaRow,
    changeSuccessRate,
    changeTotal,
    ticketsCreated,
    volume,
    priorityBreakdown,
    agentWorkload
  });
});

router.get('/new', requireAuth, requireRole('admin', 'agent'), (req, res) => {
  res.render('reports/form', { title: 'New Report' });
});

router.post('/generate', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const { source, range, format } = req.body;
  if (format === 'csv') {
    const rangeParam = range && range !== 'all' ? `?range=${range}` : '';
    if (source === 'incidents') return res.redirect('/incidents/export.csv' + rangeParam);
    if (source === 'changes') return res.redirect('/changes/export.csv' + rangeParam);
    if (source === 'problems') return res.redirect('/problems/export.csv' + rangeParam);
    if (source === 'cmdb') return res.redirect('/cmdb/export.csv' + rangeParam);
    if (source === 'requests') return res.redirect('/requests/export.csv' + rangeParam);
    return res.redirect('/reports/export.csv' + rangeParam);
  }
  const rangeParam = range && range !== 'all' ? `?range=${range}` : '';
  res.redirect('/reports' + rangeParam);
});

router.get('/export.csv', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const days = RANGE_DAYS[req.query.range] || 30;
  const agentWorkloadRows = await db.prepare(`
    SELECT u.id, u.full_name,
      (SELECT COUNT(*) FROM incidents i WHERE i.assigned_to = u.id AND i.status NOT IN ('resolved','closed','cancelled')) as open_incidents,
      (SELECT COUNT(*) FROM changes c WHERE c.assigned_to = u.id AND c.status IN ('submitted','approved','scheduled')) as open_changes,
      (SELECT COUNT(*) FROM problems p WHERE p.assigned_to = u.id AND p.status NOT IN ('resolved','closed')) as open_problems
    FROM users u
    WHERE u.role IN ('admin','agent') AND u.active = 1
    ORDER BY u.full_name
  `).all();

  const toCsv = require('../helpers').toCsv;
  const csv = toCsv(agentWorkloadRows, [
    { label: 'Agent Name', value: r => r.full_name },
    { label: 'Open Incidents', value: r => r.open_incidents },
    { label: 'Open Changes', value: r => r.open_changes },
    { label: 'Open Problems', value: r => r.open_problems },
    { label: 'Total Open Workload', value: r => (r.open_incidents + r.open_changes + r.open_problems) }
  ]);

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="reports-summary-${days}d.csv"`);
  res.send(csv);
});

module.exports = router;
