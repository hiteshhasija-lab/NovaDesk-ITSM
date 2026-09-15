const express = require('express');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const RANGE_DAYS = { '7': 7, '30': 30, '90': 90 };

router.get('/', requireAuth, requireRole('admin', 'agent'), (req, res) => {
  const days = RANGE_DAYS[req.query.range] || 30;
  const cutoff = db.prepare(`SELECT date('now', ?) as d`).get(`-${days} days`).d;

  const mttr = db.prepare(`
    SELECT AVG((julianday(resolved_at) - julianday(created_at)) * 24) as avg_hours, COUNT(*) as c
    FROM incidents
    WHERE resolved_at IS NOT NULL AND resolved_at >= ?
  `).get(cutoff);

  const mttrByPriority = db.prepare(`
    SELECT priority, AVG((julianday(resolved_at) - julianday(created_at)) * 24) as avg_hours, COUNT(*) as c
    FROM incidents
    WHERE resolved_at IS NOT NULL AND resolved_at >= ?
    GROUP BY priority ORDER BY priority ASC
  `).all(cutoff);

  const slaRow = db.prepare(`
    SELECT
      SUM(CASE WHEN resolved_at <= sla_due_at THEN 1 ELSE 0 END) as met,
      COUNT(*) as total
    FROM incidents
    WHERE resolved_at IS NOT NULL AND sla_due_at IS NOT NULL AND resolved_at >= ?
  `).get(cutoff);
  const slaCompliance = slaRow.total > 0 ? Math.round((slaRow.met / slaRow.total) * 100) : null;

  const changeOutcomes = db.prepare(`
    SELECT status, COUNT(*) as c FROM changes
    WHERE created_at >= ? AND status IN ('implemented','closed','rejected','cancelled')
    GROUP BY status
  `).all(cutoff);
  const changeSuccess = changeOutcomes.reduce((s, r) => ['implemented', 'closed'].includes(r.status) ? s + r.c : s, 0);
  const changeTotal = changeOutcomes.reduce((s, r) => s + r.c, 0);
  const changeSuccessRate = changeTotal > 0 ? Math.round((changeSuccess / changeTotal) * 100) : null;

  const ticketsCreated = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM incidents WHERE created_at >= ?) +
      (SELECT COUNT(*) FROM changes WHERE created_at >= ?) +
      (SELECT COUNT(*) FROM problems WHERE created_at >= ?) as total
  `).get(cutoff, cutoff, cutoff).total;

  const volumeRows = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as c FROM incidents WHERE created_at >= ? GROUP BY day
  `).all(cutoff);
  const volumeMap = Object.fromEntries(volumeRows.map(r => [r.day, r.c]));
  const volume = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = db.prepare(`SELECT date('now', ?) as d`).get(`-${i} days`).d;
    volume.push({ day: d, c: volumeMap[d] || 0 });
  }

  const priorityBreakdown = db.prepare(`
    SELECT priority, COUNT(*) as c FROM incidents WHERE created_at >= ? GROUP BY priority ORDER BY priority ASC
  `).all(cutoff);

  const agentWorkload = db.prepare(`
    SELECT u.id, u.full_name,
      (SELECT COUNT(*) FROM incidents i WHERE i.assigned_to = u.id AND i.status NOT IN ('resolved','closed','cancelled')) as open_incidents,
      (SELECT COUNT(*) FROM changes c WHERE c.assigned_to = u.id AND c.status IN ('submitted','approved','scheduled')) as open_changes,
      (SELECT COUNT(*) FROM problems p WHERE p.assigned_to = u.id AND p.status NOT IN ('resolved','closed')) as open_problems
    FROM users u
    WHERE u.role IN ('admin','agent') AND u.active = 1
    ORDER BY u.full_name
  `).all().map(r => ({ ...r, total: r.open_incidents + r.open_changes + r.open_problems }));

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

module.exports = router;
