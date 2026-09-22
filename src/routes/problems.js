const { db, nextNumber, logActivity, nowStr } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { PROBLEM_STATUS_LABELS, PRIORITY_LABELS, toCsv, escapeHtml } = require('../helpers');
const { attachRoutes, getAttachments, watchRoutes, getWatchers, isWatching, notifyWatchers, purgeCollabData } = require('../collab');
const { parseSort, sortRows, paginate } = require('../listquery');
const createAsyncRouter = require('../asyncRouter');

const router = createAsyncRouter();
const staffOnly = [requireAuth, requireRole('admin', 'agent')];

const PROBLEM_SORT_COLUMNS = {
  number: r => r.number,
  priority: r => r.priority,
  status: r => r.status,
  created_at: r => r.created_at
};

function getProblemById(id) {
  return db.prepare('SELECT * FROM problems WHERE id = ?').get(id);
}
function canAccessProblem() {
  return true; // this whole module is already gated to admin/agent
}
function canManageProblem() {
  return true;
}

async function loadFormLookups() {
  const users = await db.prepare("SELECT id, full_name, role FROM users WHERE active = 1 AND role != 'user' ORDER BY full_name").all();
  const cis = await db.prepare("SELECT id, ci_number, name FROM cmdb_ci ORDER BY name").all();
  return { users, cis };
}

router.get('/', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const { status, priority, assigned_to, q } = req.query;
  let where = [];
  let params = [];
  if (status === 'open') { where.push("p.status NOT IN ('resolved','closed')"); }
  else if (status) { where.push('p.status = ?'); params.push(status); }
  if (priority) { where.push('p.priority = ?'); params.push(priority); }
  if (assigned_to === 'unassigned') { where.push('p.assigned_to IS NULL'); }
  else if (assigned_to) { where.push('p.assigned_to = ?'); params.push(assigned_to); }
  if (q) {
    where.push('(p.number ILIKE ? OR p.short_description ILIKE ? OR c.name ILIKE ? OR c.ci_number ILIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  let problems = await db.prepare(`
    SELECT p.*, a.full_name AS assigned_name, c.name AS ci_name,
      (SELECT COUNT(*) FROM incidents i WHERE i.problem_id = p.id) AS incident_count
    FROM problems p
    LEFT JOIN users a ON a.id = p.assigned_to
    LEFT JOIN cmdb_ci c ON c.id = p.affected_ci_id
    ${whereSql}
    ORDER BY p.priority ASC, p.created_at DESC
  `).all(...params);

  const sort = parseSort(req, PROBLEM_SORT_COLUMNS, 'priority', 'asc');
  problems = sortRows(problems, PROBLEM_SORT_COLUMNS, sort.key, sort.dir);
  const { items, pagination } = paginate(problems, req);

  const assignableUsers = await db.prepare("SELECT id, full_name FROM users WHERE active = 1 AND role != 'user' ORDER BY full_name").all();

  res.render('problems/list', {
    title: 'Problems', problems: items, filters: { status, priority, assigned_to, q },
    assignableUsers, sort, pagination, query: req.query
  });
});

router.get('/export.csv', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const { status, priority, assigned_to, q } = req.query;
  let where = [];
  let params = [];
  if (status === 'open') { where.push("p.status NOT IN ('resolved','closed')"); }
  else if (status) { where.push('p.status = ?'); params.push(status); }
  if (priority) { where.push('p.priority = ?'); params.push(priority); }
  if (assigned_to === 'unassigned') { where.push('p.assigned_to IS NULL'); }
  else if (assigned_to) { where.push('p.assigned_to = ?'); params.push(assigned_to); }
  if (q) {
    where.push('(p.number ILIKE ? OR p.short_description ILIKE ? OR c.name ILIKE ? OR c.ci_number ILIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  let problems = await db.prepare(`
    SELECT p.*, a.full_name AS assigned_name, c.name AS ci_name,
      (SELECT COUNT(*) FROM incidents i WHERE i.problem_id = p.id) AS incident_count
    FROM problems p
    LEFT JOIN users a ON a.id = p.assigned_to
    LEFT JOIN cmdb_ci c ON c.id = p.affected_ci_id
    ${whereSql}
    ORDER BY p.priority ASC, p.created_at DESC
  `).all(...params);

  const sort = parseSort(req, PROBLEM_SORT_COLUMNS, 'priority', 'asc');
  problems = sortRows(problems, PROBLEM_SORT_COLUMNS, sort.key, sort.dir);

  const csv = toCsv(problems, [
    { label: 'Number', value: r => r.number },
    { label: 'Short Description', value: r => r.short_description },
    { label: 'Priority', value: r => `P${r.priority} - ${PRIORITY_LABELS[r.priority]}` },
    { label: 'Status', value: r => PROBLEM_STATUS_LABELS[r.status] },
    { label: 'Assigned To', value: r => r.assigned_name || '' },
    { label: 'Affected CI', value: r => r.ci_name || '' },
    { label: 'Linked Incidents', value: r => r.incident_count },
    { label: 'Root Cause', value: r => r.root_cause || '' },
    { label: 'Workaround', value: r => r.workaround || '' },
    { label: 'Created', value: r => r.created_at },
    { label: 'Resolved', value: r => r.resolved_at || '' },
    { label: 'Closed', value: r => r.closed_at || '' }
  ]);

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="problems.csv"');
  res.send(csv);
});

router.get('/new', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const { users, cis } = await loadFormLookups();
  res.render('problems/form', { title: 'New Problem', problem: null, users, cis });
});

router.post('/', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const b = req.body;
  const number = await nextNumber('problem', 'PRB');
  const info = await db.prepare(`
    INSERT INTO problems (number, short_description, description, priority, affected_ci_id, raised_by, assigned_to)
    VALUES (@number, @short_description, @description, @priority, @affected_ci_id, @raised_by, @assigned_to)
    RETURNING id
  `).run({
    number,
    short_description: b.short_description,
    description: b.description || null,
    priority: Number(b.priority) || 3,
    affected_ci_id: b.affected_ci_id || null,
    raised_by: req.session.user.id,
    assigned_to: b.assigned_to || null
  });

  await logActivity('problem', info.lastInsertRowid, req.session.user.id, 'Problem raised');
  res.redirect(`/problems/${info.lastInsertRowid}`);
});

router.get('/:id', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const problem = await db.prepare(`
    SELECT p.*, u.full_name AS raiser_name, a.full_name AS assigned_name, c.name AS ci_name, c.ci_number
    FROM problems p
    LEFT JOIN users u ON u.id = p.raised_by
    LEFT JOIN users a ON a.id = p.assigned_to
    LEFT JOIN cmdb_ci c ON c.id = p.affected_ci_id
    WHERE p.id = ?
  `).get(req.params.id);

  if (!problem) return res.status(404).render('error', { title: 'Not Found', message: 'Problem not found.' });

  const linkedIncidents = await db.prepare(`
    SELECT id, number, short_description, status, priority FROM incidents WHERE problem_id = ? ORDER BY created_at DESC
  `).all(req.params.id);

  const comments = await db.prepare(`
    SELECT pc.*, u.full_name AS author_name FROM problem_comments pc
    LEFT JOIN users u ON u.id = pc.user_id WHERE pc.problem_id = ? ORDER BY pc.created_at ASC
  `).all(req.params.id);

  const activity = await db.prepare(`
    SELECT al.*, u.full_name AS actor_name FROM activity_log al
    LEFT JOIN users u ON u.id = al.actor_id
    WHERE al.entity_type = 'problem' AND al.entity_id = ? ORDER BY al.created_at ASC
  `).all(req.params.id);

  const timeline = [
    ...comments.map(c => ({ type: 'comment', created_at: c.created_at, author_name: c.author_name, text: c.comment })),
    ...activity.map(a => ({ type: 'activity', created_at: a.created_at, author_name: a.actor_name, text: a.message }))
  ].sort((x, y) => x.created_at.localeCompare(y.created_at));

  const { users, cis } = await loadFormLookups();
  const attachments = await getAttachments('problem', problem.id);
  const watchers = await getWatchers('problem', problem.id);
  const watching = await isWatching('problem', problem.id, req.session.user.id);
  res.render('problems/show', { title: problem.number, problem, linkedIncidents, timeline, users, cis, attachments, watchers, watching });
});

router.post('/:id/update', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const b = req.body;
  const existing = await db.prepare('SELECT * FROM problems WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).render('error', { title: 'Not Found', message: 'Problem not found.' });

  const status = b.status || existing.status;
  let resolved_at = existing.resolved_at;
  let closed_at = existing.closed_at;
  if (status === 'resolved') {
    if (existing.status !== 'resolved') resolved_at = nowStr();
  } else if (status !== 'closed') {
    resolved_at = null;
  }
  if (status === 'closed') {
    if (existing.status !== 'closed') closed_at = nowStr();
  } else {
    closed_at = null;
  }

  await db.prepare(`
    UPDATE problems SET short_description=@short_description, description=@description, status=@status,
      priority=@priority, root_cause=@root_cause, workaround=@workaround, affected_ci_id=@affected_ci_id,
      assigned_to=@assigned_to, resolved_at=@resolved_at, closed_at=@closed_at, updated_at=@updated_at
    WHERE id=@id
  `).run({
    id: req.params.id,
    short_description: b.short_description,
    description: b.description || null,
    status,
    priority: Number(b.priority) || existing.priority,
    root_cause: b.root_cause || null,
    workaround: b.workaround || null,
    affected_ci_id: b.affected_ci_id || null,
    assigned_to: b.assigned_to || null,
    resolved_at, closed_at,
    updated_at: nowStr()
  });

  if (status !== existing.status) {
    await logActivity('problem', existing.id, req.session.user.id,
      `Status changed from ${PROBLEM_STATUS_LABELS[existing.status]} to ${PROBLEM_STATUS_LABELS[status]}`);
    await notifyWatchers('problem', existing.id, {
      subject: `[${existing.number}] Status changed: ${PROBLEM_STATUS_LABELS[status]}`,
      html: `<p>Problem <strong>${existing.number}</strong> — <strong>${escapeHtml(b.short_description)}</strong></p>
        <p>Status changed from ${PROBLEM_STATUS_LABELS[existing.status]} to ${PROBLEM_STATUS_LABELS[status]}.</p>`,
      excludeUserId: req.session.user.id
    });
  }

  res.redirect(`/problems/${req.params.id}`);
});

router.post('/:id/comments', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const problem = await db.prepare('SELECT * FROM problems WHERE id = ?').get(req.params.id);
  if (!problem) return res.status(404).render('error', { title: 'Not Found', message: 'Problem not found.' });

  await db.prepare(`INSERT INTO problem_comments (problem_id, user_id, comment) VALUES (?, ?, ?)`)
    .run(req.params.id, req.session.user.id, req.body.comment);

  await notifyWatchers('problem', problem.id, {
    subject: `[${problem.number}] New comment`,
    html: `<p>Problem <strong>${problem.number}</strong> — <strong>${escapeHtml(problem.short_description)}</strong></p>
      <p>${escapeHtml(req.session.user.full_name)} commented:</p>
      <p>${escapeHtml(req.body.comment)}</p>`,
    excludeUserId: req.session.user.id
  });

  res.redirect(`/problems/${req.params.id}`);
});

router.post('/:id/delete', requireAuth, requireRole('admin'), async (req, res) => {
  await db.prepare('UPDATE incidents SET problem_id = NULL WHERE problem_id = ?').run(req.params.id);
  await db.prepare(`DELETE FROM activity_log WHERE entity_type = 'problem' AND entity_id = ?`).run(req.params.id);
  await db.prepare(`DELETE FROM notifications WHERE related_type = 'problem' AND related_id = ?`).run(req.params.id);
  await purgeCollabData('problem', req.params.id);
  await db.prepare('DELETE FROM problems WHERE id = ?').run(req.params.id);
  res.redirect('/problems');
});

attachRoutes(router, 'problem', {
  table: 'problems',
  getEntity: getProblemById,
  canAccess: canAccessProblem,
  canManage: canManageProblem,
  middleware: staffOnly
});
watchRoutes(router, 'problem', {
  table: 'problems',
  getEntity: getProblemById,
  canAccess: canAccessProblem,
  middleware: staffOnly
});

module.exports = router;
