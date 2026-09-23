const { db, nextNumber, logActivity, nowStr, offsetStr } = require('../db');
const { escapeHtml } = require('../helpers');
const createAsyncRouter = require('../asyncRouter');
const esxi = require('../esxi');
const { pushDecomUpdate } = require('../novaconnect');
const { appendDecomTrackerRow } = require('../decomTracker');

const router = createAsyncRouter();

// How long a VM sits powered-off before the destroy-confirmation prompt fires — the window
// meant to catch a mistake before the irreversible step. Configurable since "how long" is a
// judgment call, not something to hardcode.
const SOAK_PERIOD_HOURS = Number(process.env.DECOM_SOAK_PERIOD_HOURS) || 24;

// For human-facing messages only — the raw hours value (which can be a long fractional
// number for fast testing, e.g. 0.08333333333333333 for 5 minutes) is never shown directly.
// Minutes below an hour, hours below a day, days above that.
function formatSoakDuration(hours) {
  const minutes = hours * 60;
  if (minutes <= 59) {
    const m = Math.round(minutes);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  if (hours <= 24) {
    const h = Math.round(hours * 10) / 10;
    return `${Number.isInteger(h) ? h : h.toFixed(1)} hour${h === 1 ? '' : 's'}`;
  }
  const days = Math.round((hours / 24) * 10) / 10;
  return `${Number.isInteger(days) ? days : days.toFixed(1)} day${days === 1 ? '' : 's'}`;
}

async function markTaskDone(changeId, description) {
  await db.prepare(`
    UPDATE change_tasks SET status = 'done', completed_at = ? WHERE change_id = ? AND description = ?
  `).run(nowStr(), changeId, description);
}

const DECOM_TASKS = [
  'Verify backup completed',
  'Remove from monitoring',
  'DNS / firewall cleanup',
  'Power off — soak period',
  'Destroy VM & release storage',
  'Retire CI in CMDB',
  'Update tracker & reclaim licenses'
];

// The first 3 tasks have no real system behind them in this app (no backup/monitoring/DNS
// integration exists) — they're never silently marked done. Instead, an admin is asked in the
// decom channel to explicitly skip them, so the Change's task history reflects a human decision
// rather than a fabricated "automated" result.
const MANUAL_TASKS = DECOM_TASKS.slice(0, 3);

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

  const esxiHost = await resolveEsxiHost(ci.id);
  if (esxiHost) {
    try {
      const sessionId = await esxi.login(esxiHost.ip_address);
      const vm = await esxi.findVm(esxiHost.ip_address, sessionId, ci.name);
      if (!vm) throw new Error(`No VM named "${ci.name}" found on ${esxiHost.name}.`);
      await esxi.powerOff(esxiHost.ip_address, sessionId, vm.vm);
      await markTaskDone(change.id, 'Power off — soak period');
      await logActivity('change', change.id, approver.id, `VM powered off on ${esxiHost.name}, entering ${formatSoakDuration(SOAK_PERIOD_HOURS)} soak period`);
      await pushDecomUpdate(change.novaconnect_channel_id, `✅ Power off complete — ${ci.name} is now off on ${esxiHost.name}. Entering a ${formatSoakDuration(SOAK_PERIOD_HOURS)} soak period before the destroy confirmation.`);

      await db.prepare(`
        INSERT INTO scheduled_actions (change_id, action_type, run_at) VALUES (?, 'destroy_vm', ?)
      `).run(change.id, offsetStr(0, SOAK_PERIOD_HOURS));

      for (const desc of MANUAL_TASKS) {
        const task = (tasks || []).find(t => t.description === desc);
        await pushDecomUpdate(
          change.novaconnect_channel_id,
          `Pre-decommission check: **${desc}** isn't automated in NovaDesk. Confirm when completed manually, or skip if not applicable.`,
          {
            cardType: 'decom_precheck_task',
            changeId: change.id,
            changeNumber: change.number,
            taskId: task ? task.id : null,
            taskNumber: task ? task.task_number : null,
            taskDescription: desc,
            status: 'pending'
          }
        );
      }
    } catch (e) {
      await logActivity('change', change.id, approver.id, `ESXi power-off failed: ${e.message}`);
      await pushDecomUpdate(change.novaconnect_channel_id, `⚠️ ${change.number} approved, but power-off on ${esxiHost.name} failed: ${e.message}. The soak-period timer was not started — this needs manual attention.`);
    }
  }

  res.json({ change: await db.prepare('SELECT * FROM changes WHERE id = ?').get(change.id), ci, tasks });
});

// POST /novaconnect/decommission-requests/:id/skip-manual-tasks
// The 3 non-automated pre-checks — explicit human decision, not silently assumed done.
router.post('/novaconnect/decommission-requests/:id/skip-manual-tasks', async (req, res) => {
  const { change, error, message } = await loadDecomContext(req.params.id);
  if (error) return res.status(error).json({ error: message });

  const actor = req.body.skipped_by_username
    ? await db.prepare("SELECT id, role FROM users WHERE username = ?").get(req.body.skipped_by_username)
    : null;
  if (!actor || actor.role !== 'admin') {
    return res.status(403).json({ error: 'Only a NovaDesk admin can skip these tasks.' });
  }

  for (const description of MANUAL_TASKS) {
    await db.prepare(`
      UPDATE change_tasks SET status = 'skipped', completed_at = ? WHERE change_id = ? AND description = ? AND status = 'pending'
    `).run(nowStr(), change.id, description);
  }
  await logActivity('change', change.id, actor.id, `Manual pre-checks skipped by ${req.body.skipped_by_username} (not automated in NovaDesk): ${MANUAL_TASKS.join(', ')}`);

  res.json({ ok: true });
});

// POST /novaconnect/decommission-requests/:id/precheck-task
// Individual manual pre-check confirmation — either Completed or Skip.
router.post('/novaconnect/decommission-requests/:id/precheck-task', async (req, res) => {
  const { change, error, message } = await loadDecomContext(req.params.id);
  if (error) return res.status(error).json({ error: message });

  const username = req.body.actor_username || req.body.skipped_by_username || req.body.completed_by_username;
  const actor = username
    ? await db.prepare("SELECT id, role FROM users WHERE username = ?").get(username)
    : null;
  if (!actor || actor.role !== 'admin') {
    return res.status(403).json({ error: 'Only a NovaDesk admin can update these tasks.' });
  }

  const action = req.body.action; // 'complete' or 'skip'
  const desc = req.body.task_description;
  const newStatus = action === 'complete' ? 'done' : 'skipped';
  const actionWord = action === 'complete' ? 'completed' : 'skipped';

  let task;
  if (req.body.task_id) {
    task = await db.prepare('SELECT * FROM change_tasks WHERE id = ? AND change_id = ?').get(req.body.task_id, change.id);
  }
  if (!task && desc) {
    task = await db.prepare('SELECT * FROM change_tasks WHERE change_id = ? AND description = ?').get(change.id, desc);
  }

  if (task) {
    await db.prepare(`
      UPDATE change_tasks SET status = ?, completed_at = ? WHERE id = ?
    `).run(newStatus, nowStr(), task.id);
    await logActivity('change', change.id, actor.id, `Manual pre-check "${task.description}" marked ${actionWord} by ${username}`);
  } else if (desc) {
    await db.prepare(`
      UPDATE change_tasks SET status = ?, completed_at = ? WHERE change_id = ? AND description = ?
    `).run(newStatus, nowStr(), change.id, desc);
    await logActivity('change', change.id, actor.id, `Manual pre-check "${desc}" marked ${actionWord} by ${username}`);
  }

  res.json({ ok: true, status: newStatus });
});

// POST /novaconnect/decommission-requests/:id/confirm-destroy
// The second, separate checkpoint — only after this does the actual (irreversible) ESXi
// destroy call happen. Deliberately requires the same admin-only check as approve, passed
// through the same way (approved_by_username, not re-derived), never auto-fired by the soak
// timer itself.
router.post('/novaconnect/decommission-requests/:id/confirm-destroy', async (req, res) => {
  const { change, ci, error, message } = await loadDecomContext(req.params.id);
  if (error) return res.status(error).json({ error: message });

  const confirmer = req.body.confirmed_by_username
    ? await db.prepare("SELECT id, role FROM users WHERE username = ?").get(req.body.confirmed_by_username)
    : null;
  if (!confirmer || confirmer.role !== 'admin') {
    return res.status(403).json({ error: 'Only a NovaDesk admin can confirm a VM destroy.' });
  }

  const esxiHost = await resolveEsxiHost(ci.id);
  if (!esxiHost) return res.status(422).json({ error: `"${ci.name}" has no resolvable ESXi host.` });

  const sessionId = await esxi.login(esxiHost.ip_address);
  const vm = await esxi.findVm(esxiHost.ip_address, sessionId, ci.name);
  if (!vm) throw new Error(`No VM named "${ci.name}" found on ${esxiHost.name} — it may already be gone.`);
  await esxi.destroyVm(esxiHost.ip_address, sessionId, vm.vm);
  await markTaskDone(change.id, 'Destroy VM & release storage');
  await logActivity('change', change.id, confirmer.id, `VM destroyed on ${esxiHost.name} (confirmed by ${req.body.confirmed_by_username})`);
  await pushDecomUpdate(change.novaconnect_channel_id, `✅ ${ci.name} destroyed on ${esxiHost.name} — storage released.`);

  await db.prepare(`UPDATE cmdb_ci SET status = 'retired', updated_at = ? WHERE id = ?`).run(nowStr(), ci.id);
  await markTaskDone(change.id, 'Retire CI in CMDB');
  await pushDecomUpdate(change.novaconnect_channel_id, `✅ ${ci.ci_number} retired in the CMDB.`);

  try {
    await appendDecomTrackerRow({
      ciNumber: ci.ci_number,
      name: ci.name,
      ciType: ci.ci_type,
      ipAddress: ci.ip_address,
      os: ci.os,
      serialNumber: ci.serial_number,
      location: ci.location,
      supportGroup: ci.support_group,
      changeNumber: change.number,
      decommissionedDate: nowStr(),
      confirmedBy: req.body.confirmed_by_username
    });
    await markTaskDone(change.id, 'Update tracker & reclaim licenses');
  } catch (e) {
    await logActivity('change', change.id, confirmer.id, `Decommissioned Tracker update failed: ${e.message}`);
    await pushDecomUpdate(change.novaconnect_channel_id, `⚠️ ${ci.name} was destroyed and retired, but updating the Decommissioned Tracker failed: ${e.message}. Update it manually.`);
  }

  const closed = await db.prepare(`
    UPDATE changes SET status = 'closed', updated_at = ?, closed_at = ? WHERE id = ? RETURNING *
  `).get(nowStr(), nowStr(), change.id);
  await logActivity('change', change.id, confirmer.id, 'Change closed — decommission complete');

  await pushDecomUpdate(
    change.novaconnect_channel_id,
    `✅ ${change.number} closed — tracker updated. Decommission of ${ci.name} complete.`,
    { cardType: 'decom_status', changeId: change.id, changeNumber: change.number, status: 'destroyed' }
  );

  res.json({ change: closed, ci: await db.prepare('SELECT * FROM cmdb_ci WHERE id = ?').get(ci.id) });
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
