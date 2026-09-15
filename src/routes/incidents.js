const express = require('express');
const { db, nextNumber, logActivity } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { priorityFromImpactUrgency, INCIDENT_STATUS_LABELS, PRIORITY_LABELS, SLA_HOURS, toCsv, escapeHtml, slaStatus } = require('../helpers');
const { sendNotification } = require('../mailer');
const { attachRoutes, getAttachments, watchRoutes, getWatchers, isWatching, notifyWatchers, purgeCollabData } = require('../collab');

const BOARD_STATUSES = ['new', 'in_progress', 'on_hold', 'resolved', 'closed'];

const router = express.Router();

function canAccessIncident(req, incident) {
  return req.session.user.role !== 'user' || incident.caller_id === req.session.user.id;
}
function canManageIncident(req) {
  return ['admin', 'agent'].includes(req.session.user.role);
}
function getIncidentById(id) {
  return db.prepare('SELECT * FROM incidents WHERE id = ?').get(id);
}

function loadFormLookups() {
  const users = db.prepare("SELECT id, full_name, role FROM users WHERE active = 1 ORDER BY full_name").all();
  const cis = db.prepare("SELECT id, ci_number, name FROM cmdb_ci ORDER BY name").all();
  const problems = db.prepare("SELECT id, number, short_description FROM problems WHERE status != 'closed' ORDER BY created_at DESC").all();
  return { users, cis, problems };
}

router.get('/', requireAuth, (req, res) => {
  const { status, priority, q, sla, assigned_to } = req.query;
  const isEndUser = req.session.user.role === 'user';
  let where = [];
  let params = [];

  if (isEndUser) {
    where.push('i.caller_id = ?');
    params.push(req.session.user.id);
  }
  if (status === 'open') { where.push("i.status IN ('new','in_progress','on_hold')"); }
  else if (status) { where.push('i.status = ?'); params.push(status); }
  if (priority) { where.push('i.priority = ?'); params.push(priority); }
  if (assigned_to === 'unassigned') { where.push('i.assigned_to IS NULL'); }
  else if (assigned_to) { where.push('i.assigned_to = ?'); params.push(assigned_to); }
  if (q) {
    where.push('(i.number LIKE ? OR i.short_description LIKE ? OR c.name LIKE ? OR c.ci_number LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  let incidents = db.prepare(`
    SELECT i.*, u.full_name AS caller_name, a.full_name AS assigned_name, c.name AS ci_name
    FROM incidents i
    LEFT JOIN users u ON u.id = i.caller_id
    LEFT JOIN users a ON a.id = i.assigned_to
    LEFT JOIN cmdb_ci c ON c.id = i.affected_ci_id
    ${whereSql}
    ORDER BY i.priority ASC, i.created_at DESC
  `).all(...params);

  if (sla) {
    incidents = incidents.filter(inc => slaStatus(inc).key === sla);
  }

  const assignableUsers = db.prepare("SELECT id, full_name FROM users WHERE active = 1 AND role != 'user' ORDER BY full_name").all();
  const staffUsers = isEndUser ? [] : assignableUsers;

  res.render('incidents/list', { title: 'Incidents', incidents, filters: { status, priority, q, sla, assigned_to }, staffUsers, assignableUsers });
});

router.get('/new', requireAuth, (req, res) => {
  const { users, cis } = loadFormLookups();
  res.render('incidents/form', { title: 'New Incident', incident: null, users, cis });
});

router.get('/export.csv', requireAuth, requireRole('admin', 'agent'), (req, res) => {
  const incidents = db.prepare(`
    SELECT i.*, u.full_name AS caller_name, a.full_name AS assigned_name, c.name AS ci_name
    FROM incidents i
    LEFT JOIN users u ON u.id = i.caller_id
    LEFT JOIN users a ON a.id = i.assigned_to
    LEFT JOIN cmdb_ci c ON c.id = i.affected_ci_id
    ORDER BY i.created_at DESC
  `).all();

  const csv = toCsv(incidents, [
    { label: 'Number', value: r => r.number },
    { label: 'Short Description', value: r => r.short_description },
    { label: 'Priority', value: r => `P${r.priority} - ${PRIORITY_LABELS[r.priority]}` },
    { label: 'Status', value: r => INCIDENT_STATUS_LABELS[r.status] },
    { label: 'Caller', value: r => r.caller_name || '' },
    { label: 'Assigned To', value: r => r.assigned_name || '' },
    { label: 'Assignment Group', value: r => r.assignment_group || '' },
    { label: 'Affected CI', value: r => r.ci_name || '' },
    { label: 'SLA Due', value: r => r.sla_due_at || '' },
    { label: 'Created', value: r => r.created_at }
  ]);

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="incidents.csv"');
  res.send(csv);
});

router.get('/board', requireAuth, requireRole('admin', 'agent'), (req, res) => {
  const incidents = db.prepare(`
    SELECT i.*, u.full_name AS caller_name, a.full_name AS assigned_name, c.name AS ci_name
    FROM incidents i
    LEFT JOIN users u ON u.id = i.caller_id
    LEFT JOIN users a ON a.id = i.assigned_to
    LEFT JOIN cmdb_ci c ON c.id = i.affected_ci_id
    WHERE i.status IN ('new','in_progress','on_hold','resolved','closed')
    ORDER BY i.priority ASC, i.created_at DESC
  `).all();

  const columns = BOARD_STATUSES.map(status => ({
    status,
    label: INCIDENT_STATUS_LABELS[status],
    items: incidents.filter(i => i.status === status)
  }));

  res.render('incidents/board', { title: 'Incident Board', columns });
});

router.post('/:id/status', requireAuth, requireRole('admin', 'agent'), (req, res) => {
  const { status } = req.body;
  if (!BOARD_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const existing = db.prepare('SELECT * FROM incidents WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  let resolved_at = existing.resolved_at;
  let closed_at = existing.closed_at;
  if (status === 'resolved') {
    if (existing.status !== 'resolved') resolved_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
  } else if (status !== 'closed') {
    resolved_at = null;
  }
  if (status === 'closed') {
    if (existing.status !== 'closed') closed_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
  } else {
    closed_at = null;
  }

  db.prepare(`UPDATE incidents SET status = ?, resolved_at = ?, closed_at = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status, resolved_at, closed_at, req.params.id);

  if (status !== existing.status) {
    logActivity('incident', existing.id, req.session.user.id,
      `Status changed from ${INCIDENT_STATUS_LABELS[existing.status]} to ${INCIDENT_STATUS_LABELS[status]} (board)`);
  }

  res.json({ ok: true });
});

router.post('/', requireAuth, (req, res) => {
  const b = req.body;
  const impact = Number(b.impact) || 3;
  const urgency = Number(b.urgency) || 3;
  const priority = priorityFromImpactUrgency(impact, urgency);
  const number = nextNumber('incident', 'INC');
  const isEndUser = req.session.user.role === 'user';

  const slaHours = SLA_HOURS[priority] || SLA_HOURS[4];

  const info = db.prepare(`
    INSERT INTO incidents (number, short_description, description, category, subcategory, impact, urgency, priority,
      status, caller_id, assigned_to, assignment_group, affected_ci_id, sla_due_at)
    VALUES (@number, @short_description, @description, @category, @subcategory, @impact, @urgency, @priority,
      'new', @caller_id, @assigned_to, @assignment_group, @affected_ci_id, datetime('now', '+${slaHours} hours'))
  `).run({
    number,
    short_description: b.short_description,
    description: b.description || null,
    category: b.category || 'other',
    subcategory: b.subcategory || null,
    impact, urgency, priority,
    caller_id: isEndUser ? req.session.user.id : (b.caller_id || req.session.user.id),
    assigned_to: isEndUser ? null : (b.assigned_to || null),
    assignment_group: b.assignment_group || null,
    affected_ci_id: b.affected_ci_id || null
  });

  logActivity('incident', info.lastInsertRowid, req.session.user.id, 'Incident created');
  notifyOnCreate(info.lastInsertRowid);

  res.redirect(`/incidents/${info.lastInsertRowid}`);
});

function notifyOnCreate(incidentId) {
  const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(incidentId);
  const desc = escapeHtml(incident.short_description);
  const caller = db.prepare('SELECT full_name, email FROM users WHERE id = ?').get(incident.caller_id);
  if (caller && caller.email) {
    sendNotification({
      to: caller.email,
      toName: caller.full_name,
      subject: `[${incident.number}] Incident logged: ${incident.short_description}`,
      html: `<p>Hi ${escapeHtml(caller.full_name)},</p><p>Your incident <strong>${incident.number}</strong> has been logged.</p>
        <p><strong>${desc}</strong></p>
        <p>Priority: P${incident.priority} — ${PRIORITY_LABELS[incident.priority]}</p>
        <p>We'll keep you updated as it progresses.</p>`,
      relatedType: 'incident',
      relatedId: incident.id
    }).catch(() => {});
  }
  if (incident.assigned_to) {
    const assignee = db.prepare('SELECT full_name, email FROM users WHERE id = ?').get(incident.assigned_to);
    if (assignee && assignee.email) {
      sendNotification({
        to: assignee.email,
        toName: assignee.full_name,
        subject: `[${incident.number}] Assigned to you: ${incident.short_description}`,
        html: `<p>Hi ${escapeHtml(assignee.full_name)},</p><p>Incident <strong>${incident.number}</strong> has been assigned to you.</p>
          <p><strong>${desc}</strong></p>
          <p>Priority: P${incident.priority} — ${PRIORITY_LABELS[incident.priority]}</p>`,
        relatedType: 'incident',
        relatedId: incident.id
      }).catch(() => {});
    }
  }
}

router.get('/:id', requireAuth, (req, res) => {
  const incident = db.prepare(`
    SELECT i.*, u.full_name AS caller_name, a.full_name AS assigned_name, c.name AS ci_name, c.id AS ci_id, c.ci_number,
      p.number AS problem_number, p.status AS problem_status
    FROM incidents i
    LEFT JOIN users u ON u.id = i.caller_id
    LEFT JOIN users a ON a.id = i.assigned_to
    LEFT JOIN cmdb_ci c ON c.id = i.affected_ci_id
    LEFT JOIN problems p ON p.id = i.problem_id
    WHERE i.id = ?
  `).get(req.params.id);

  if (!incident) return res.status(404).render('error', { title: 'Not Found', message: 'Incident not found.' });

  if (req.session.user.role === 'user' && incident.caller_id !== req.session.user.id) {
    return res.status(403).render('error', { title: 'Access Denied', message: 'You cannot view this incident.' });
  }

  const isEndUser = req.session.user.role === 'user';
  const comments = db.prepare(`
    SELECT ic.*, u.full_name AS author_name
    FROM incident_comments ic LEFT JOIN users u ON u.id = ic.user_id
    WHERE ic.incident_id = ? ${isEndUser ? 'AND ic.is_work_note = 0' : ''}
    ORDER BY ic.created_at ASC
  `).all(req.params.id);

  const activity = db.prepare(`
    SELECT al.*, u.full_name AS actor_name
    FROM activity_log al LEFT JOIN users u ON u.id = al.actor_id
    WHERE al.entity_type = 'incident' AND al.entity_id = ?
    ORDER BY al.created_at ASC
  `).all(req.params.id);

  const timeline = [
    ...comments.map(c => ({ type: 'comment', created_at: c.created_at, author_name: c.author_name, text: c.comment, is_work_note: !!c.is_work_note })),
    ...activity.map(a => ({ type: 'activity', created_at: a.created_at, author_name: a.actor_name, text: a.message }))
  ].sort((x, y) => x.created_at.localeCompare(y.created_at));

  const words = incident.short_description.split(/\s+/).filter(w => w.length > 4).slice(0, 5);
  let relatedArticles = [];
  if (words.length) {
    const conditions = words.map(() => '(title LIKE ? OR body LIKE ?)').join(' OR ');
    const params = words.flatMap(w => [`%${w}%`, `%${w}%`]);
    relatedArticles = db.prepare(`
      SELECT id, number, title FROM kb_articles WHERE status = 'published' AND (${conditions}) LIMIT 3
    `).all(...params);
  }

  const { users, cis, problems } = loadFormLookups();
  const attachments = getAttachments('incident', incident.id);
  const watchers = getWatchers('incident', incident.id);
  const watching = isWatching('incident', incident.id, req.session.user.id);
  res.render('incidents/show', { title: incident.number, incident, timeline, users, cis, problems, relatedArticles, attachments, watchers, watching });
});

router.post('/:id/update', requireAuth, requireRole('admin', 'agent'), (req, res) => {
  const b = req.body;
  const existing = db.prepare('SELECT * FROM incidents WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).render('error', { title: 'Not Found', message: 'Incident not found.' });

  const impact = Number(b.impact) || existing.impact;
  const urgency = Number(b.urgency) || existing.urgency;
  const priority = priorityFromImpactUrgency(impact, urgency);
  const status = b.status || existing.status;

  let resolved_at = existing.resolved_at;
  let closed_at = existing.closed_at;
  if (status === 'resolved') {
    if (existing.status !== 'resolved') resolved_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
  } else if (status !== 'closed') {
    resolved_at = null;
  }
  if (status === 'closed') {
    if (existing.status !== 'closed') closed_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
  } else {
    closed_at = null;
  }

  db.prepare(`
    UPDATE incidents SET short_description=@short_description, description=@description, category=@category,
      subcategory=@subcategory, impact=@impact, urgency=@urgency, priority=@priority, status=@status,
      assigned_to=@assigned_to, assignment_group=@assignment_group, affected_ci_id=@affected_ci_id,
      resolution_notes=@resolution_notes, problem_id=@problem_id, resolved_at=@resolved_at, closed_at=@closed_at, updated_at=datetime('now')
    WHERE id=@id
  `).run({
    id: req.params.id,
    short_description: b.short_description,
    description: b.description || null,
    category: b.category || 'other',
    subcategory: b.subcategory || null,
    impact, urgency, priority, status,
    assigned_to: b.assigned_to || null,
    assignment_group: b.assignment_group || null,
    affected_ci_id: b.affected_ci_id || null,
    resolution_notes: b.resolution_notes || null,
    problem_id: b.problem_id || null,
    resolved_at, closed_at
  });

  if ((b.problem_id || null) !== existing.problem_id && b.problem_id) {
    logActivity('incident', existing.id, req.session.user.id, `Linked to problem`);
  }

  const actorId = req.session.user.id;
  if (status !== existing.status) {
    logActivity('incident', existing.id, actorId,
      `Status changed from ${INCIDENT_STATUS_LABELS[existing.status]} to ${INCIDENT_STATUS_LABELS[status]}`);
  }
  if (priority !== existing.priority) {
    logActivity('incident', existing.id, actorId,
      `Priority changed from P${existing.priority} to P${priority}`);
  }
  const newAssignedTo = b.assigned_to ? Number(b.assigned_to) : null;
  if (newAssignedTo !== existing.assigned_to) {
    const newName = newAssignedTo ? (db.prepare('SELECT full_name FROM users WHERE id = ?').get(newAssignedTo) || {}).full_name : null;
    const oldName = existing.assigned_to ? (db.prepare('SELECT full_name FROM users WHERE id = ?').get(existing.assigned_to) || {}).full_name : null;
    logActivity('incident', existing.id, actorId,
      `Reassigned from ${oldName || 'Unassigned'} to ${newName || 'Unassigned'}`);
  }
  const newGroup = b.assignment_group || null;
  if (newGroup !== existing.assignment_group) {
    logActivity('incident', existing.id, actorId,
      `Assignment group changed from ${existing.assignment_group || '—'} to ${newGroup || '—'}`);
  }

  if (newAssignedTo && newAssignedTo !== existing.assigned_to) {
    const assignee = db.prepare('SELECT full_name, email FROM users WHERE id = ?').get(newAssignedTo);
    if (assignee && assignee.email) {
      sendNotification({
        to: assignee.email,
        toName: assignee.full_name,
        subject: `[${existing.number}] Assigned to you: ${b.short_description}`,
        html: `<p>Hi ${escapeHtml(assignee.full_name)},</p><p>Incident <strong>${existing.number}</strong> has been assigned to you.</p>
          <p><strong>${escapeHtml(b.short_description)}</strong></p>
          <p>Priority: P${priority} — ${PRIORITY_LABELS[priority]}</p>`,
        relatedType: 'incident',
        relatedId: existing.id
      }).catch(() => {});
    }
  }

  if (status !== existing.status) {
    notifyWatchers('incident', existing.id, {
      subject: `[${existing.number}] Status changed: ${INCIDENT_STATUS_LABELS[status]}`,
      html: `<p>Incident <strong>${existing.number}</strong> — <strong>${escapeHtml(b.short_description)}</strong></p>
        <p>Status changed from ${INCIDENT_STATUS_LABELS[existing.status]} to ${INCIDENT_STATUS_LABELS[status]}.</p>`,
      excludeUserId: actorId
    });
  }

  res.redirect(`/incidents/${req.params.id}`);
});

router.post('/:id/comments', requireAuth, (req, res) => {
  const isEndUser = req.session.user.role === 'user';
  const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(req.params.id);
  if (!incident) return res.status(404).render('error', { title: 'Not Found', message: 'Incident not found.' });
  if (isEndUser && incident.caller_id !== req.session.user.id) {
    return res.status(403).render('error', { title: 'Access Denied', message: 'You cannot comment on this incident.' });
  }
  const isWorkNote = !isEndUser && req.body.is_work_note === 'on';
  db.prepare(`
    INSERT INTO incident_comments (incident_id, user_id, comment, is_work_note)
    VALUES (?, ?, ?, ?)
  `).run(req.params.id, req.session.user.id, req.body.comment, isWorkNote ? 1 : 0);

  if (!isWorkNote) {
    notifyWatchers('incident', incident.id, {
      subject: `[${incident.number}] New comment`,
      html: `<p>Incident <strong>${incident.number}</strong> — <strong>${escapeHtml(incident.short_description)}</strong></p>
        <p>${escapeHtml(req.session.user.full_name)} commented:</p>
        <p>${escapeHtml(req.body.comment)}</p>`,
      excludeUserId: req.session.user.id
    });
  }

  res.redirect(`/incidents/${req.params.id}`);
});

router.post('/:id/delete', requireAuth, requireRole('admin'), (req, res) => {
  db.prepare(`DELETE FROM activity_log WHERE entity_type = 'incident' AND entity_id = ?`).run(req.params.id);
  db.prepare(`DELETE FROM notifications WHERE related_type = 'incident' AND related_id = ?`).run(req.params.id);
  purgeCollabData('incident', req.params.id);
  db.prepare('DELETE FROM incidents WHERE id = ?').run(req.params.id);
  res.redirect('/incidents');
});

router.post('/bulk-update', requireAuth, requireRole('admin', 'agent'), (req, res) => {
  const { ids, status, assigned_to } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'No incidents selected' });
  if (!status && assigned_to === undefined) return res.status(400).json({ error: 'No changes specified' });

  const actorId = req.session.user.id;
  let updated = 0;

  for (const id of ids) {
    const existing = db.prepare('SELECT * FROM incidents WHERE id = ?').get(id);
    if (!existing) continue;

    const newStatus = status || existing.status;
    let resolved_at = existing.resolved_at;
    let closed_at = existing.closed_at;
    if (newStatus === 'resolved') {
      if (existing.status !== 'resolved') resolved_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
    } else if (newStatus !== 'closed') {
      resolved_at = null;
    }
    if (newStatus === 'closed') {
      if (existing.status !== 'closed') closed_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
    } else {
      closed_at = null;
    }

    const newAssignedTo = assigned_to !== undefined ? (assigned_to || null) : existing.assigned_to;

    db.prepare(`UPDATE incidents SET status = ?, assigned_to = ?, resolved_at = ?, closed_at = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(newStatus, newAssignedTo, resolved_at, closed_at, id);

    if (status && status !== existing.status) {
      logActivity('incident', id, actorId, `Status changed from ${INCIDENT_STATUS_LABELS[existing.status]} to ${INCIDENT_STATUS_LABELS[status]} (bulk action)`);
    }
    if (assigned_to !== undefined && Number(newAssignedTo) !== existing.assigned_to) {
      const name = newAssignedTo ? (db.prepare('SELECT full_name FROM users WHERE id = ?').get(newAssignedTo) || {}).full_name : 'Unassigned';
      logActivity('incident', id, actorId, `Reassigned to ${name} (bulk action)`);
    }
    updated++;
  }

  res.json({ ok: true, updated });
});

attachRoutes(router, 'incident', {
  table: 'incidents',
  getEntity: getIncidentById,
  canAccess: canAccessIncident,
  canManage: canManageIncident,
  middleware: [requireAuth]
});
watchRoutes(router, 'incident', {
  table: 'incidents',
  getEntity: getIncidentById,
  canAccess: canAccessIncident,
  middleware: [requireAuth]
});

module.exports = router;
