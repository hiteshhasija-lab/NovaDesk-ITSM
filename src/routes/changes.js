const dayjs = require('dayjs');
const { db, nextNumber, logActivity, nowStr } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { CHANGE_STATUS_LABELS, toCsv, escapeHtml } = require('../helpers');
const { sendNotification } = require('../mailer');
const { attachRoutes, getAttachments, watchRoutes, getWatchers, isWatching, notifyWatchers, purgeCollabData } = require('../collab');
const { parseSort, sortRows, paginate } = require('../listquery');
const createAsyncRouter = require('../asyncRouter');

const router = createAsyncRouter();

const BOARD_STATUSES = ['draft', 'submitted', 'approved', 'scheduled', 'in_progress', 'implemented', 'closed'];

const CHANGE_SORT_COLUMNS = {
  number: r => r.number,
  risk: r => ({ low: 1, medium: 2, high: 3 }[r.risk] || 0),
  status: r => r.status,
  planned_start: r => r.planned_start || ''
};

function canAccessChange(req, change) {
  return req.session.user.role !== 'user' || change.requested_by === req.session.user.id;
}
function canManageChange(req) {
  return ['admin', 'agent'].includes(req.session.user.role);
}
function getChangeById(id) {
  return db.prepare('SELECT * FROM changes WHERE id = ?').get(id);
}

function deriveApprovalStatus(newStatus, existing, actorId) {
  let approval_status = existing.approval_status;
  let approved_by = existing.approved_by;
  if (['approved', 'scheduled', 'in_progress', 'implemented', 'closed'].includes(newStatus)) {
    if (existing.approval_status !== 'approved') {
      approval_status = 'approved';
      approved_by = actorId;
    }
  } else if (newStatus === 'rejected') {
    approval_status = 'rejected';
  } else if (['draft', 'submitted'].includes(newStatus)) {
    approval_status = 'pending';
    approved_by = null;
  }
  return { approval_status, approved_by };
}

async function loadFormLookups() {
  const users = await db.prepare("SELECT id, full_name, role FROM users WHERE active = 1 ORDER BY full_name").all();
  const cis = await db.prepare("SELECT id, ci_number, name FROM cmdb_ci ORDER BY name").all();
  return { users, cis };
}

router.get('/', requireAuth, async (req, res) => {
  const { status, risk, change_type, assigned_to, q } = req.query;
  const isEndUser = req.session.user.role === 'user';
  let where = [];
  let params = [];

  if (isEndUser) { where.push('c.requested_by = ?'); params.push(req.session.user.id); }
  if (status === 'open') { where.push("c.status IN ('submitted','approved','scheduled','in_progress')"); }
  else if (status) { where.push('c.status = ?'); params.push(status); }
  if (risk) { where.push('c.risk = ?'); params.push(risk); }
  if (change_type) { where.push('c.change_type = ?'); params.push(change_type); }
  if (assigned_to === 'unassigned') { where.push('c.assigned_to IS NULL'); }
  else if (assigned_to) { where.push('c.assigned_to = ?'); params.push(assigned_to); }
  if (q) {
    where.push('(c.number ILIKE ? OR c.short_description ILIKE ? OR ci.name ILIKE ? OR ci.ci_number ILIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  let changes = await db.prepare(`
    SELECT c.*, u.full_name AS requester_name, a.full_name AS assigned_name, ci.name AS ci_name
    FROM changes c
    LEFT JOIN users u ON u.id = c.requested_by
    LEFT JOIN users a ON a.id = c.assigned_to
    LEFT JOIN cmdb_ci ci ON ci.id = c.affected_ci_id
    ${whereSql}
    ORDER BY c.planned_start ASC, c.created_at DESC
  `).all(...params);

  const sort = parseSort(req, CHANGE_SORT_COLUMNS, 'planned_start', 'asc');
  changes = sortRows(changes, CHANGE_SORT_COLUMNS, sort.key, sort.dir);
  const { items, pagination } = paginate(changes, req);

  const assignableUsers = await db.prepare("SELECT id, full_name FROM users WHERE active = 1 AND role != 'user' ORDER BY full_name").all();
  const staffUsers = isEndUser ? [] : assignableUsers;

  res.render('changes/list', {
    title: 'Change Requests', changes: items, filters: { status, risk, change_type, assigned_to, q },
    staffUsers, assignableUsers, sort, pagination, query: req.query
  });
});

router.get('/new', requireAuth, async (req, res) => {
  const { users, cis } = await loadFormLookups();
  res.render('changes/form', { title: 'New Change Request', change: null, users, cis });
});

router.get('/export.csv', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const { status, risk, change_type, assigned_to, q } = req.query;
  const isEndUser = req.session.user.role === 'user';
  let where = [];
  let params = [];

  if (isEndUser) { where.push('c.requested_by = ?'); params.push(req.session.user.id); }
  if (status === 'open') { where.push("c.status IN ('submitted','approved','scheduled','in_progress')"); }
  else if (status) { where.push('c.status = ?'); params.push(status); }
  if (risk) { where.push('c.risk = ?'); params.push(risk); }
  if (change_type) { where.push('c.change_type = ?'); params.push(change_type); }
  if (assigned_to === 'unassigned') { where.push('c.assigned_to IS NULL'); }
  else if (assigned_to) { where.push('c.assigned_to = ?'); params.push(assigned_to); }
  if (q) {
    where.push('(c.number ILIKE ? OR c.short_description ILIKE ? OR ci.name ILIKE ? OR ci.ci_number ILIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  let changes = await db.prepare(`
    SELECT c.*, u.full_name AS requester_name, a.full_name AS assigned_name, ci.name AS ci_name
    FROM changes c
    LEFT JOIN users u ON u.id = c.requested_by
    LEFT JOIN users a ON a.id = c.assigned_to
    LEFT JOIN cmdb_ci ci ON ci.id = c.affected_ci_id
    ${whereSql}
    ORDER BY c.planned_start ASC, c.created_at DESC
  `).all(...params);

  const sort = parseSort(req, CHANGE_SORT_COLUMNS, 'planned_start', 'asc');
  changes = sortRows(changes, CHANGE_SORT_COLUMNS, sort.key, sort.dir);

  const csv = toCsv(changes, [
    { label: 'Number', value: r => r.number },
    { label: 'Short Description', value: r => r.short_description },
    { label: 'Type', value: r => r.change_type },
    { label: 'Risk', value: r => r.risk },
    { label: 'Status', value: r => CHANGE_STATUS_LABELS[r.status] },
    { label: 'Requested By', value: r => r.requester_name || '' },
    { label: 'Assigned To', value: r => r.assigned_name || '' },
    { label: 'Affected CI', value: r => r.ci_name || '' },
    { label: 'Planned Start', value: r => r.planned_start || '' },
    { label: 'Created', value: r => r.created_at }
  ]);

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="changes.csv"');
  res.send(csv);
});

router.get('/board', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const changes = await db.prepare(`
    SELECT c.*, u.full_name AS requester_name, a.full_name AS assigned_name, ci.name AS ci_name
    FROM changes c
    LEFT JOIN users u ON u.id = c.requested_by
    LEFT JOIN users a ON a.id = c.assigned_to
    LEFT JOIN cmdb_ci ci ON ci.id = c.affected_ci_id
    WHERE c.status IN ('draft','submitted','approved','scheduled','in_progress','implemented','closed')
    ORDER BY c.planned_start ASC, c.created_at DESC
  `).all();

  const columns = BOARD_STATUSES.map(status => ({
    status,
    label: CHANGE_STATUS_LABELS[status],
    items: changes.filter(c => c.status === status)
  }));

  res.render('changes/board', { title: 'Change Board', columns });
});

router.get('/calendar', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const monthParam = req.query.month;
  const monthStart = (monthParam && /^\d{4}-\d{2}$/.test(monthParam) ? dayjs(monthParam + '-01') : dayjs().startOf('month')).startOf('month');
  const monthEnd = monthStart.endOf('month');

  const allScheduled = await db.prepare(`
    SELECT c.*, ci.name AS ci_name
    FROM changes c
    LEFT JOIN cmdb_ci ci ON ci.id = c.affected_ci_id
    WHERE c.planned_start IS NOT NULL AND c.status NOT IN ('cancelled','rejected')
  `).all();

  const conflictIds = new Set();
  for (let i = 0; i < allScheduled.length; i++) {
    for (let j = i + 1; j < allScheduled.length; j++) {
      const a = allScheduled[i], b = allScheduled[j];
      if (!a.affected_ci_id || a.affected_ci_id !== b.affected_ci_id) continue;
      const aStart = dayjs(a.planned_start.replace(' ', 'T'));
      const aEnd = a.planned_end ? dayjs(a.planned_end.replace(' ', 'T')) : aStart.add(1, 'hour');
      const bStart = dayjs(b.planned_start.replace(' ', 'T'));
      const bEnd = b.planned_end ? dayjs(b.planned_end.replace(' ', 'T')) : bStart.add(1, 'hour');
      if (aStart.isBefore(bEnd) && bStart.isBefore(aEnd)) {
        conflictIds.add(a.id);
        conflictIds.add(b.id);
      }
    }
  }

  const monthChanges = allScheduled.filter(c => {
    const d = dayjs(c.planned_start.replace(' ', 'T'));
    return !d.isBefore(monthStart) && !d.isAfter(monthEnd);
  });

  const firstWeekday = monthStart.day();
  const daysInMonth = monthEnd.date();
  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = monthStart.date(d).format('YYYY-MM-DD');
    const dayChanges = monthChanges
      .filter(c => c.planned_start.slice(0, 10) === dateStr)
      .map(c => ({ ...c, conflict: conflictIds.has(c.id) }));
    cells.push({ day: d, dateStr, changes: dayChanges });
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  res.render('changes/calendar', {
    title: 'Change Calendar',
    weeks,
    monthLabel: monthStart.format('MMMM YYYY'),
    prevMonth: monthStart.subtract(1, 'month').format('YYYY-MM'),
    nextMonth: monthStart.add(1, 'month').format('YYYY-MM'),
    conflictCount: [...conflictIds].filter(id => monthChanges.some(c => c.id === id)).length
  });
});

router.post('/:id/status', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const { status } = req.body;
  if (!BOARD_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const existing = await db.prepare('SELECT * FROM changes WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  let closed_at = existing.closed_at;
  if (status === 'closed') {
    if (existing.status !== 'closed') closed_at = nowStr();
  } else {
    closed_at = null;
  }

  const { approval_status, approved_by } = deriveApprovalStatus(status, existing, req.session.user.id);

  await db.prepare(`
    UPDATE changes SET status = ?, closed_at = ?, approval_status = ?, approved_by = ?, updated_at = ?
    WHERE id = ?
  `).run(status, closed_at, approval_status, approved_by, nowStr(), req.params.id);

  if (status !== existing.status) {
    await logActivity('change', existing.id, req.session.user.id,
      `Status changed from ${CHANGE_STATUS_LABELS[existing.status]} to ${CHANGE_STATUS_LABELS[status]} (board)`);
  }

  res.json({ ok: true });
});

router.post('/', requireAuth, async (req, res) => {
  const b = req.body;
  const number = await nextNumber('change', 'CHG');
  const info = await db.prepare(`
    INSERT INTO changes (number, short_description, description, change_type, risk, status, requested_by,
      assigned_to, affected_ci_id, planned_start, planned_end, implementation_plan, backout_plan)
    VALUES (@number, @short_description, @description, @change_type, @risk, 'draft', @requested_by,
      @assigned_to, @affected_ci_id, @planned_start, @planned_end, @implementation_plan, @backout_plan)
    RETURNING id
  `).run({
    number,
    short_description: b.short_description,
    description: b.description || null,
    change_type: b.change_type || 'normal',
    risk: b.risk || 'medium',
    requested_by: req.session.user.id,
    assigned_to: b.assigned_to || null,
    affected_ci_id: b.affected_ci_id || null,
    planned_start: b.planned_start || null,
    planned_end: b.planned_end || null,
    implementation_plan: b.implementation_plan || null,
    backout_plan: b.backout_plan || null
  });

  await logActivity('change', info.lastInsertRowid, req.session.user.id, 'Change request created');
  await notifyOnCreate(info.lastInsertRowid);

  res.redirect(`/changes/${info.lastInsertRowid}`);
});

async function notifyOnCreate(changeId) {
  const change = await db.prepare('SELECT * FROM changes WHERE id = ?').get(changeId);
  const desc = escapeHtml(change.short_description);
  const requester = await db.prepare('SELECT full_name, email, email_notifications FROM users WHERE id = ?').get(change.requested_by);
  if (requester && requester.email && requester.email_notifications) {
    sendNotification({
      to: requester.email,
      toName: requester.full_name,
      subject: `[${change.number}] Change request submitted: ${change.short_description}`,
      html: `<p>Hi ${escapeHtml(requester.full_name)},</p><p>Your change request <strong>${change.number}</strong> has been logged as a draft.</p>
        <p><strong>${desc}</strong></p>
        <p>Risk: ${change.risk[0].toUpperCase() + change.risk.slice(1)}</p>
        <p>It will need CAB approval before it can be scheduled.</p>`,
      relatedType: 'change',
      relatedId: change.id
    }).catch(() => {});
  }
  if (change.assigned_to) {
    const assignee = await db.prepare('SELECT full_name, email, email_notifications FROM users WHERE id = ?').get(change.assigned_to);
    if (assignee && assignee.email && assignee.email_notifications) {
      sendNotification({
        to: assignee.email,
        toName: assignee.full_name,
        subject: `[${change.number}] Assigned to you: ${change.short_description}`,
        html: `<p>Hi ${escapeHtml(assignee.full_name)},</p><p>Change request <strong>${change.number}</strong> has been assigned to you.</p>
          <p><strong>${desc}</strong></p>`,
        relatedType: 'change',
        relatedId: change.id
      }).catch(() => {});
    }
  }
}

router.get('/:id', requireAuth, async (req, res) => {
  const change = await db.prepare(`
    SELECT c.*, u.full_name AS requester_name, a.full_name AS assigned_name, ci.name AS ci_name, ci.ci_number,
      ap.full_name AS approver_name
    FROM changes c
    LEFT JOIN users u ON u.id = c.requested_by
    LEFT JOIN users a ON a.id = c.assigned_to
    LEFT JOIN cmdb_ci ci ON ci.id = c.affected_ci_id
    LEFT JOIN users ap ON ap.id = c.approved_by
    WHERE c.id = ?
  `).get(req.params.id);

  if (!change) return res.status(404).render('error', { title: 'Not Found', message: 'Change request not found.' });
  if (req.session.user.role === 'user' && change.requested_by !== req.session.user.id) {
    return res.status(403).render('error', { title: 'Access Denied', message: 'You cannot view this change request.' });
  }

  const comments = await db.prepare(`
    SELECT cc.*, u.full_name AS author_name FROM change_comments cc
    LEFT JOIN users u ON u.id = cc.user_id WHERE cc.change_id = ? ORDER BY cc.created_at ASC, cc.id ASC
  `).all(req.params.id);

  const activity = await db.prepare(`
    SELECT al.*, u.full_name AS actor_name
    FROM activity_log al LEFT JOIN users u ON u.id = al.actor_id
    WHERE al.entity_type = 'change' AND al.entity_id = ?
    ORDER BY al.created_at ASC, al.id ASC
  `).all(req.params.id);

  const timeline = [
    ...comments.map(c => ({ type: 'comment', id: c.id, created_at: c.created_at, author_name: c.author_name, text: c.comment })),
    ...activity.map(a => ({ type: 'activity', id: a.id, created_at: a.created_at, author_name: a.actor_name, text: a.message }))
  ].sort((x, y) => x.created_at.localeCompare(y.created_at) || ((x.id || 0) - (y.id || 0)));

  const tasks = await db.prepare('SELECT * FROM change_tasks WHERE change_id = ? ORDER BY sequence').all(req.params.id);
  const { users, cis } = await loadFormLookups();
  const attachments = await getAttachments('change', change.id);
  const watchers = await getWatchers('change', change.id);
  const watching = await isWatching('change', change.id, req.session.user.id);
  res.render('changes/show', { title: change.number, change, timeline, tasks, users, cis, attachments, watchers, watching });
});

router.post('/:id/tasks/:taskId/toggle', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const change = await getChangeById(req.params.id);
  if (!change) return res.status(404).render('error', { title: 'Not Found', message: 'Change request not found.' });

  const task = await db.prepare('SELECT * FROM change_tasks WHERE id = ? AND change_id = ?').get(req.params.taskId, req.params.id);
  if (!task) return res.status(404).render('error', { title: 'Not Found', message: 'Change task not found.' });

  const nowDone = task.status !== 'done';
  await db.prepare('UPDATE change_tasks SET status = ?, completed_at = ? WHERE id = ?')
    .run(nowDone ? 'done' : 'pending', nowDone ? nowStr() : null, task.id);
  await logActivity('change', change.id, req.session.user.id,
    `${task.task_number} (${task.description}) marked ${nowDone ? 'done' : 'pending'}`);

  res.redirect(`/changes/${change.id}`);
});

router.post('/:id/update', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const b = req.body;
  const existing = await db.prepare('SELECT * FROM changes WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).render('error', { title: 'Not Found', message: 'Change request not found.' });

  let closed_at = existing.closed_at;
  if (b.status === 'closed') {
    if (existing.status !== 'closed') closed_at = nowStr();
  } else {
    closed_at = null;
  }

  const { approval_status, approved_by } = deriveApprovalStatus(b.status, existing, req.session.user.id);

  await db.prepare(`
    UPDATE changes SET short_description=@short_description, description=@description, change_type=@change_type,
      risk=@risk, status=@status, assigned_to=@assigned_to, affected_ci_id=@affected_ci_id,
      planned_start=@planned_start, planned_end=@planned_end, implementation_plan=@implementation_plan,
      backout_plan=@backout_plan, approval_status=@approval_status, approved_by=@approved_by,
      updated_at=@updated_at, closed_at=@closed_at
    WHERE id=@id
  `).run({
    id: req.params.id,
    short_description: b.short_description,
    description: b.description || null,
    change_type: b.change_type,
    risk: b.risk,
    status: b.status,
    assigned_to: b.assigned_to || null,
    affected_ci_id: b.affected_ci_id || null,
    planned_start: b.planned_start || null,
    planned_end: b.planned_end || null,
    implementation_plan: b.implementation_plan || null,
    backout_plan: b.backout_plan || null,
    approval_status,
    approved_by,
    closed_at,
    updated_at: nowStr()
  });

  const actorId = req.session.user.id;
  if (b.status !== existing.status) {
    await logActivity('change', existing.id, actorId,
      `Status changed from ${CHANGE_STATUS_LABELS[existing.status]} to ${CHANGE_STATUS_LABELS[b.status]}`);
  }
  const newAssignedTo = b.assigned_to ? Number(b.assigned_to) : null;
  if (newAssignedTo !== existing.assigned_to) {
    const newNameRow = newAssignedTo ? await db.prepare('SELECT full_name FROM users WHERE id = ?').get(newAssignedTo) : null;
    const oldNameRow = existing.assigned_to ? await db.prepare('SELECT full_name FROM users WHERE id = ?').get(existing.assigned_to) : null;
    await logActivity('change', existing.id, actorId,
      `Reassigned from ${(oldNameRow || {}).full_name || 'Unassigned'} to ${(newNameRow || {}).full_name || 'Unassigned'}`);
  }

  if (newAssignedTo && newAssignedTo !== existing.assigned_to) {
    const assignee = await db.prepare('SELECT full_name, email, email_notifications FROM users WHERE id = ?').get(newAssignedTo);
    if (assignee && assignee.email && assignee.email_notifications) {
      sendNotification({
        to: assignee.email,
        toName: assignee.full_name,
        subject: `[${existing.number}] Assigned to you: ${b.short_description}`,
        html: `<p>Hi ${escapeHtml(assignee.full_name)},</p><p>Change request <strong>${existing.number}</strong> has been assigned to you.</p>
          <p><strong>${escapeHtml(b.short_description)}</strong></p>`,
        relatedType: 'change',
        relatedId: existing.id
      }).catch(() => {});
    }
  }

  if (b.status !== existing.status) {
    await notifyWatchers('change', existing.id, {
      subject: `[${existing.number}] Status changed: ${CHANGE_STATUS_LABELS[b.status]}`,
      html: `<p>Change request <strong>${existing.number}</strong> — <strong>${escapeHtml(b.short_description)}</strong></p>
        <p>Status changed from ${CHANGE_STATUS_LABELS[existing.status]} to ${CHANGE_STATUS_LABELS[b.status]}.</p>`,
      excludeUserId: actorId
    });
  }

  res.redirect(`/changes/${req.params.id}`);
});

router.post('/:id/approve', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const decision = req.body.decision === 'reject' ? 'rejected' : 'approved';
  const newStatus = decision === 'approved' ? 'scheduled' : 'rejected';
  const existing = await db.prepare('SELECT * FROM changes WHERE id = ?').get(req.params.id);

  await db.prepare(`
    UPDATE changes SET approval_status=?, approved_by=?, status=?, updated_at=? WHERE id=?
  `).run(decision, req.session.user.id, newStatus, nowStr(), req.params.id);

  if (existing) {
    await logActivity('change', existing.id, req.session.user.id, `Change ${decision} by CAB`);
    const requester = await db.prepare('SELECT full_name, email, email_notifications FROM users WHERE id = ?').get(existing.requested_by);
    if (requester && requester.email && requester.email_notifications) {
      sendNotification({
        to: requester.email,
        toName: requester.full_name,
        subject: `[${existing.number}] Change ${decision}: ${existing.short_description}`,
        html: `<p>Hi ${escapeHtml(requester.full_name)},</p><p>Your change request <strong>${existing.number}</strong> has been <strong>${decision}</strong>.</p>
          <p><strong>${escapeHtml(existing.short_description)}</strong></p>`,
        relatedType: 'change',
        relatedId: existing.id
      }).catch(() => {});
    }
  }

  res.redirect(`/changes/${req.params.id}`);
});

router.post('/:id/cancel', requireAuth, async (req, res) => {
  const existing = await db.prepare('SELECT * FROM changes WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).render('error', { title: 'Not Found', message: 'Change request not found.' });

  const isOwner = existing.requested_by === req.session.user.id;
  const isStaff = ['admin', 'agent'].includes(req.session.user.role);
  if (!isOwner && !isStaff) {
    return res.status(403).render('error', { title: 'Access Denied', message: 'You cannot cancel this change request.' });
  }
  if (!['draft', 'submitted'].includes(existing.status)) {
    return res.status(400).render('error', { title: 'Cannot Cancel', message: 'This change has already moved past the request stage and can no longer be self-cancelled. Ask an agent to update its status.' });
  }

  await db.prepare(`UPDATE changes SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(nowStr(), req.params.id);
  await logActivity('change', existing.id, req.session.user.id, 'Change cancelled by requester');
  res.redirect(`/changes/${req.params.id}`);
});

router.post('/:id/comments', requireAuth, async (req, res) => {
  const change = await db.prepare('SELECT * FROM changes WHERE id = ?').get(req.params.id);
  if (!change) return res.status(404).render('error', { title: 'Not Found', message: 'Change request not found.' });
  if (req.session.user.role === 'user' && change.requested_by !== req.session.user.id) {
    return res.status(403).render('error', { title: 'Access Denied', message: 'You cannot comment on this change request.' });
  }
  await db.prepare(`INSERT INTO change_comments (change_id, user_id, comment) VALUES (?, ?, ?)`)
    .run(req.params.id, req.session.user.id, req.body.comment);

  await notifyWatchers('change', change.id, {
    subject: `[${change.number}] New comment`,
    html: `<p>Change request <strong>${change.number}</strong> — <strong>${escapeHtml(change.short_description)}</strong></p>
      <p>${escapeHtml(req.session.user.full_name)} commented:</p>
      <p>${escapeHtml(req.body.comment)}</p>`,
    excludeUserId: req.session.user.id
  });

  res.redirect(`/changes/${req.params.id}`);
});

router.post('/:id/delete', requireAuth, requireRole('admin'), async (req, res) => {
  await db.prepare(`DELETE FROM activity_log WHERE entity_type = 'change' AND entity_id = ?`).run(req.params.id);
  await db.prepare(`DELETE FROM notifications WHERE related_type = 'change' AND related_id = ?`).run(req.params.id);
  await purgeCollabData('change', req.params.id);
  await db.prepare('DELETE FROM changes WHERE id = ?').run(req.params.id);
  res.redirect('/changes');
});

router.post('/bulk-update', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const { ids, status, assigned_to } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'No change requests selected' });
  if (!status && assigned_to === undefined) return res.status(400).json({ error: 'No changes specified' });

  const actorId = req.session.user.id;
  let updated = 0;

  for (const id of ids) {
    const existing = await db.prepare('SELECT * FROM changes WHERE id = ?').get(id);
    if (!existing) continue;

    const newStatus = status || existing.status;
    let closed_at = existing.closed_at;
    if (newStatus === 'closed') {
      if (existing.status !== 'closed') closed_at = nowStr();
    } else {
      closed_at = null;
    }

    const newAssignedTo = assigned_to !== undefined ? (assigned_to || null) : existing.assigned_to;
    const { approval_status, approved_by } = deriveApprovalStatus(newStatus, existing, actorId);

    await db.prepare(`
      UPDATE changes SET status = ?, assigned_to = ?, closed_at = ?, approval_status = ?, approved_by = ?, updated_at = ?
      WHERE id = ?
    `).run(newStatus, newAssignedTo, closed_at, approval_status, approved_by, nowStr(), id);

    if (status && status !== existing.status) {
      await logActivity('change', id, actorId, `Status changed from ${CHANGE_STATUS_LABELS[existing.status]} to ${CHANGE_STATUS_LABELS[status]} (bulk action)`);
    }
    if (assigned_to !== undefined && Number(newAssignedTo) !== existing.assigned_to) {
      const nameRow = newAssignedTo ? await db.prepare('SELECT full_name FROM users WHERE id = ?').get(newAssignedTo) : null;
      await logActivity('change', id, actorId, `Reassigned to ${(nameRow || {}).full_name || 'Unassigned'} (bulk action)`);
    }
    updated++;
  }

  res.json({ ok: true, updated });
});

attachRoutes(router, 'change', {
  table: 'changes',
  getEntity: getChangeById,
  canAccess: canAccessChange,
  canManage: canManageChange,
  middleware: [requireAuth]
});
watchRoutes(router, 'change', {
  table: 'changes',
  getEntity: getChangeById,
  canAccess: canAccessChange,
  middleware: [requireAuth]
});

module.exports = router;
