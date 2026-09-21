const { db, nextNumber, logActivity, nowStr, offsetStr } = require('../db');
const { escapeHtml } = require('../helpers');
const createAsyncRouter = require('../asyncRouter');

const router = createAsyncRouter();

const DECOM_TASKS = [
  'Verify backup completed',
  'Remove from monitoring',
  'DNS / firewall cleanup',
  'Power off — soak period',
  'Destroy VM & release storage',
  'Retire CI in CMDB',
  'Update tracker & reclaim licenses'
];

function requireSyncAuth(req, res, next) {
  const expected = process.env.SYNC_API_KEY;
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!expected || !provided || provided !== expected) {
    return res.status(401).json({ error: 'Missing or invalid service credentials.' });
  }
  next();
}
router.use(requireSyncAuth);

async function findCiByHostname(hostname) {
  return db.prepare(
    'SELECT * FROM cmdb_ci WHERE lower(name) = lower(?) OR ip_address = ? LIMIT 1'
  ).get(hostname, hostname);
}

async function resolveEsxiHost(ciId) {
  const row = await db.prepare(`
    SELECT host.* FROM ci_relationships r
    JOIN cmdb_ci host ON host.id = r.parent_ci_id
    WHERE r.child_ci_id = ? AND r.relationship_type = 'runs_on'
    LIMIT 1
  `).get(ciId);
  return row || null;
}

// POST /api/integrations/novaconnect/decommission-requests
// body: { hostname, novaconnect_channel_id, requested_by_username }
router.post('/novaconnect/decommission-requests', async (req, res) => {
  const { hostname, novaconnect_channel_id, requested_by_username } = req.body;
  if (!hostname) return res.status(400).json({ error: 'hostname is required.' });
  if (!novaconnect_channel_id) return res.status(400).json({ error: 'novaconnect_channel_id is required.' });

  const ci = await findCiByHostname(hostname);
  if (!ci) return res.status(404).json({ error: `No CMDB record found for "${hostname}".` });

  const esxiHost = await resolveEsxiHost(ci.id);
  if (!esxiHost) {
    return res.status(422).json({
      error: `"${ci.name}" has no "runs_on" relationship to an ESXi host CI — can't determine where to shut it down. Record that relationship in the CMDB first.`
    });
  }

  const requester = requested_by_username
    ? await db.prepare('SELECT id FROM users WHERE username = ?').get(requested_by_username)
    : null;

  const number = await nextNumber('change', 'CHG');
  const change = await db.prepare(`
    INSERT INTO changes (number, short_description, description, change_type, risk, status,
      requested_by, affected_ci_id, novaconnect_channel_id, implementation_plan)
    VALUES (@number, @short_description, @description, 'normal', 'low', 'submitted',
      @requested_by, @affected_ci_id, @novaconnect_channel_id, @implementation_plan)
    RETURNING *
  `).get({
    number,
    short_description: `Decommission ${ci.name}`,
    description: `Automated decommission request for "${ci.name}" (${ci.ci_number}), submitted from NovaConnect.`,
    requested_by: requester ? requester.id : null,
    affected_ci_id: ci.id,
    novaconnect_channel_id,
    implementation_plan: `Shut down and destroy ${ci.name} on ESXi host ${esxiHost.name} (${esxiHost.ip_address}) after a soak period, then retire the CI.`
  });

  for (let i = 0; i < DECOM_TASKS.length; i++) {
    const taskNumber = await nextNumber('ctask', 'CTASK');
    await db.prepare(`
      INSERT INTO change_tasks (change_id, task_number, description, sequence)
      VALUES (?, ?, ?, ?)
    `).run(change.id, taskNumber, DECOM_TASKS[i], i);
  }

  await logActivity('change', change.id, requester ? requester.id : null, 'Change request created (via NovaConnect decommission request)');

  const tasks = await db.prepare('SELECT * FROM change_tasks WHERE change_id = ? ORDER BY sequence').all(change.id);
  res.status(201).json({ change, ci, esxiHost, tasks });
});

async function loadDecomContext(changeId) {
  const change = await db.prepare('SELECT * FROM changes WHERE id = ?').get(changeId);
  if (!change) return { error: 404, message: 'Change not found.' };
  const ci = await db.prepare('SELECT * FROM cmdb_ci WHERE id = ?').get(change.affected_ci_id);
  const tasks = await db.prepare('SELECT * FROM change_tasks WHERE change_id = ? ORDER BY sequence').all(changeId);
  return { change, ci, tasks };
}

// POST /api/integrations/novaconnect/decommission-requests/:id/approve
// body: { approved_by_username }
router.post('/novaconnect/decommission-requests/:id/approve', async (req, res) => {
  const { change, ci, tasks, error, message } = await loadDecomContext(req.params.id);
  if (error) return res.status(error).json({ error: message });

  const approver = req.body.approved_by_username
    ? await db.prepare("SELECT id, role FROM users WHERE username = ?").get(req.body.approved_by_username)
    : null;
  if (!approver || approver.role !== 'admin') {
    return res.status(403).json({ error: 'Only a NovaDesk admin can approve a decommission request.' });
  }

  await db.prepare(`
    UPDATE changes SET approval_status='approved', approved_by=?, status='scheduled', updated_at=? WHERE id=?
  `).run(approver.id, nowStr(), change.id);
  await logActivity('change', change.id, approver.id, 'Decommission approved (via NovaConnect)');

  res.json({ change: await db.prepare('SELECT * FROM changes WHERE id = ?').get(change.id), ci, tasks });
});

// POST /api/integrations/novaconnect/decommission-requests/:id/reject
router.post('/novaconnect/decommission-requests/:id/reject', async (req, res) => {
  const { change, error, message } = await loadDecomContext(req.params.id);
  if (error) return res.status(error).json({ error: message });

  const rejector = req.body.rejected_by_username
    ? await db.prepare('SELECT id FROM users WHERE username = ?').get(req.body.rejected_by_username)
    : null;

  await db.prepare(`
    UPDATE changes SET approval_status='rejected', status='rejected', updated_at=? WHERE id=?
  `).run(nowStr(), change.id);
  await logActivity('change', change.id, rejector ? rejector.id : null, 'Decommission rejected (via NovaConnect)');

  res.json({ change: await db.prepare('SELECT * FROM changes WHERE id = ?').get(change.id) });
});

module.exports = router;
