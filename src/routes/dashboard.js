const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const isEndUser = req.session.user.role === 'user';
  const uid = req.session.user.id;
  const userFilter = isEndUser ? 'WHERE caller_id = ?' : '';
  const changeFilter = isEndUser ? 'WHERE requested_by = ?' : '';

  const incidentCounts = db.prepare(`
    SELECT status, COUNT(*) as c FROM incidents ${userFilter} GROUP BY status
  `).all(...(isEndUser ? [uid] : []));

  const changeCounts = db.prepare(`
    SELECT status, COUNT(*) as c FROM changes ${changeFilter} GROUP BY status
  `).all(...(isEndUser ? [uid] : []));

  const ciCounts = db.prepare(`SELECT ci_type, COUNT(*) as c FROM cmdb_ci GROUP BY ci_type`).all();
  const ciStatusCounts = db.prepare(`SELECT status, COUNT(*) as c FROM cmdb_ci GROUP BY status`).all();

  const openIncidents = db.prepare(`
    SELECT i.*, u.full_name AS caller_name, a.full_name AS assigned_name
    FROM incidents i
    LEFT JOIN users u ON u.id = i.caller_id
    LEFT JOIN users a ON a.id = i.assigned_to
    ${isEndUser ? 'WHERE i.caller_id = ? AND' : 'WHERE'} i.status NOT IN ('resolved','closed','cancelled')
    ORDER BY i.priority ASC, i.created_at DESC
    LIMIT 8
  `).all(...(isEndUser ? [uid] : []));

  const upcomingChanges = db.prepare(`
    SELECT c.*, u.full_name AS requester_name
    FROM changes c
    LEFT JOIN users u ON u.id = c.requested_by
    ${isEndUser ? 'WHERE c.requested_by = ? AND' : 'WHERE'} c.status IN ('submitted','approved','scheduled')
    ORDER BY c.planned_start ASC
    LIMIT 8
  `).all(...(isEndUser ? [uid] : []));

  const totalCis = db.prepare('SELECT COUNT(*) as c FROM cmdb_ci').get().c;
  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;

  const requestFilter = isEndUser ? 'WHERE requested_by = ?' : '';
  const openRequests = db.prepare(`
    SELECT COUNT(*) as c FROM service_requests
    ${isEndUser ? 'WHERE requested_by = ? AND' : 'WHERE'} status IN ('submitted','in_progress')
  `).get(...(isEndUser ? [uid] : [])).c;
  const requestStatusCounts = db.prepare(`
    SELECT status, COUNT(*) as c FROM service_requests ${requestFilter} GROUP BY status
  `).all(...(isEndUser ? [uid] : []));

  let openProblems = 0;
  let problemStatusCounts = [];
  if (!isEndUser) {
    openProblems = db.prepare(`
      SELECT COUNT(*) as c FROM problems WHERE status NOT IN ('resolved','closed')
    `).get().c;
    problemStatusCounts = db.prepare(`SELECT status, COUNT(*) as c FROM problems GROUP BY status`).all();
  }

  const slaBreaches = db.prepare(`
    SELECT COUNT(*) as c FROM incidents
    WHERE status NOT IN ('resolved','closed','cancelled') AND sla_due_at IS NOT NULL AND sla_due_at < datetime('now')
    ${isEndUser ? 'AND caller_id = ?' : ''}
  `).get(...(isEndUser ? [uid] : [])).c;

  const priorityCounts = db.prepare(`
    SELECT priority, COUNT(*) as c FROM incidents ${userFilter} GROUP BY priority
  `).all(...(isEndUser ? [uid] : []));

  const trendRows = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as c
    FROM incidents
    ${isEndUser ? 'WHERE caller_id = ? AND' : 'WHERE'} created_at >= date('now','-13 days')
    GROUP BY day ORDER BY day
  `).all(...(isEndUser ? [uid] : []));

  const trendMap = Object.fromEntries(trendRows.map(r => [r.day, r.c]));
  const trend = [];
  for (let i = 13; i >= 0; i--) {
    const d = db.prepare(`SELECT date('now', ?) as d`).get(`-${i} days`).d;
    trend.push({ day: d, c: trendMap[d] || 0 });
  }

  res.render('dashboard', {
    title: 'Dashboard',
    incidentCounts, changeCounts, ciCounts, ciStatusCounts, priorityCounts, trend,
    openIncidents, upcomingChanges, totalCis, totalUsers, slaBreaches,
    openRequests, requestStatusCounts, openProblems, problemStatusCounts
  });
});

module.exports = router;
