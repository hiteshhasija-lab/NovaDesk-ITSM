const { db, nextNumber, logActivity, nowStr } = require('../db');
const { escapeHtml } = require('../helpers');
const createAsyncRouter = require('../asyncRouter');
const esxi = require('../esxi');
const { pushDecomUpdate, pushDecomThinking, resolveNovaConnectCard, decomTargets } = require('../novaconnect');
const { appendDecomTrackerRow } = require('../decomTracker');
const {
  DECOM_TASKS, MANUAL_TASKS, resolveEsxiHost, markTaskDone, maybeProceedWithPowerDown, sleep,
  announceDecomApproval, announceDecomRejection, resolvePrecheckTask
} = require('../decomAutomation');

const router = createAsyncRouter();

// For the final decom summary card's "Elapsed" line — same shape as decomAutomation's
// formatSoakDuration but takes milliseconds and also expresses sub-minute durations, since the
// "sim" figure (how long this request's own automation took) is typically seconds, not hours.
function formatElapsed(ms) {
  const seconds = ms / 1000;
  if (seconds < 60) return `~${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `~${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `~${Math.round(hours)}h`;
  const days = Math.round(hours / 24);
  return `~${days} day${days === 1 ? '' : 's'}`;
}

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

// POST /api/integrations/novaconnect/decommission-requests
// body: { hostname, novaconnect_channel_id | novaconnect_conversation_id, requested_by_username }
router.post('/novaconnect/decommission-requests', async (req, res) => {
  const { hostname, novaconnect_channel_id, novaconnect_conversation_id, requested_by_username } = req.body;
  if (!hostname) return res.status(400).json({ error: 'hostname is required.' });
  if (!novaconnect_channel_id && !novaconnect_conversation_id) {
    return res.status(400).json({ error: 'novaconnect_channel_id or novaconnect_conversation_id is required.' });
  }

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
      requested_by, affected_ci_id, novaconnect_channel_id, novaconnect_conversation_id, implementation_plan)
    VALUES (@number, @short_description, @description, 'normal', 'low', 'submitted',
      @requested_by, @affected_ci_id, @novaconnect_channel_id, @novaconnect_conversation_id, @implementation_plan)
    RETURNING *
  `).get({
    number,
    short_description: `Decommission ${ci.name}`,
    description: `Automated decommission request for "${ci.name}" (${ci.ci_number}), submitted from NovaConnect.`,
    requested_by: requester ? requester.id : null,
    affected_ci_id: ci.id,
    novaconnect_channel_id: novaconnect_channel_id || null,
    novaconnect_conversation_id: novaconnect_conversation_id || null,
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
    ? await db.prepare("SELECT id, role, full_name FROM users WHERE username = ?").get(req.body.approved_by_username)
    : null;
  if (!approver || approver.role !== 'admin') {
    return res.status(403).json({ error: 'Only a NovaDesk admin can approve a decommission request.' });
  }

  // 'in_progress', not 'scheduled' — a decom Change starts executing (prechecks, power-down)
  // the instant it's approved, not at some future planned date.
  await db.prepare(`
    UPDATE changes SET approval_status='approved', approved_by=?, status='in_progress', updated_at=? WHERE id=?
  `).run(approver.id, nowStr(), change.id);
  await logActivity('change', change.id, approver.id, 'Decommission approved (via NovaConnect)');

  // announceDecomApproval resolves the approval card + posts "approved" FIRST, before the
  // precheck cards — see its own comment in decomAutomation.js for why order matters here.
  // Power-off no longer happens automatically after this — it's gated on all 3 manual prechecks
  // being resolved (Completed or Skipped). Whichever route ends up resolving the last of the 3
  // (precheck-task or skip-manual-tasks below, or NovaDesk's own Change Tasks Complete/Skip
  // buttons in routes/changes.js) is what actually triggers it, via maybeProceedWithPowerDown.
  await announceDecomApproval(change, approver.full_name);

  res.json({ change: await db.prepare('SELECT * FROM changes WHERE id = ?').get(change.id), ci, tasks });
});

// POST /novaconnect/decommission-requests/:id/skip-manual-tasks
// The 3 non-automated pre-checks — explicit human decision, not silently assumed done.
router.post('/novaconnect/decommission-requests/:id/skip-manual-tasks', async (req, res) => {
  const { change, tasks, error, message } = await loadDecomContext(req.params.id);
  if (error) return res.status(error).json({ error: message });

  const actor = req.body.skipped_by_username
    ? await db.prepare("SELECT id, role FROM users WHERE username = ?").get(req.body.skipped_by_username)
    : null;
  if (!actor || actor.role !== 'admin') {
    return res.status(403).json({ error: 'Only a NovaDesk admin can skip these tasks.' });
  }

  // Resolves each individual precheck card too, not just the bulk "skip all" button's own card
  // — otherwise the 3 individual cards stay stuck showing "pending" with active buttons even
  // though they're actually skipped underneath.
  for (const description of MANUAL_TASKS) {
    const task = (tasks || []).find((t) => t.description === description && t.status === 'pending');
    if (task) await resolvePrecheckTask(change, task, 'skipped', actor.id, req.body.skipped_by_username);
  }

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

  let task;
  if (req.body.task_id) {
    task = await db.prepare('SELECT * FROM change_tasks WHERE id = ? AND change_id = ?').get(req.body.task_id, change.id);
  }
  if (!task && desc) {
    task = await db.prepare('SELECT * FROM change_tasks WHERE change_id = ? AND description = ?').get(change.id, desc);
  }

  if (task) {
    await resolvePrecheckTask(change, task, newStatus, actor.id, username);
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

  // The destroy-confirmation card is dual-posted (DM + server-decom), so the same action is
  // clickable from two different message copies — a user with both open can click Confirm
  // Destroy (or Cancel, below) from each. Once the first click moves the Change off
  // 'in_progress', reject the second cleanly instead of re-running the ESXi calls, which would
  // fail ungracefully (e.g. destroying an already-destroyed VM) and 500.
  if (change.status !== 'in_progress') {
    return res.status(409).json({ error: `${change.number} is no longer awaiting a destroy decision (current status: ${change.status}) — this was likely already actioned from another window.` });
  }

  const esxiHost = await resolveEsxiHost(ci.id);
  if (!esxiHost) return res.status(422).json({ error: `"${ci.name}" has no resolvable ESXi host.` });

  const startedAt = Date.now();

  await pushDecomThinking(decomTargets(change), true);
  let vm;
  try {
    const sessionId = await esxi.login(esxiHost.ip_address);
    vm = await esxi.findVm(esxiHost.ip_address, sessionId, ci.name);
    if (!vm) throw new Error(`No VM named "${ci.name}" found on ${esxiHost.name} — it may already be gone.`);
    await esxi.destroyVm(esxiHost.ip_address, sessionId, vm.vm);
  } finally {
    await pushDecomThinking(decomTargets(change), false);
  }
  await markTaskDone(change.id, 'Destroy VM & release storage');
  await logActivity('change', change.id, confirmer.id, `VM destroyed on ${esxiHost.name} (confirmed by ${req.body.confirmed_by_username})`);

  // Resolve the confirm-destroy card here, same as approve/reject/precheck-task — this route
  // can be reached without a NovaConnect card ever having been clicked (this is exactly how it
  // was caught: a confirm-destroy driven directly via this endpoint left the card stuck showing
  // "Confirm Destroy" with active buttons, since only NovaConnect's own relay route used to
  // resolve it). Resolving here makes it correct regardless of which door was used.
  await resolveNovaConnectCard({ changeId: change.id, cardType: 'decom_confirm_destroy' }, 'destroyed');
  await pushDecomUpdate(decomTargets(change), `✅ ${ci.name} destroyed on ${esxiHost.name} — storage released.`);

  // Same pacing as the other steps — otherwise "retired in the CMDB" lands in the same instant
  // as "destroyed".
  await pushDecomThinking(decomTargets(change), true);
  await sleep(5000);
  await pushDecomThinking(decomTargets(change), false);

  await db.prepare(`UPDATE cmdb_ci SET status = 'retired', updated_at = ? WHERE id = ?`).run(nowStr(), ci.id);
  await markTaskDone(change.id, 'Retire CI in CMDB');
  await pushDecomUpdate(decomTargets(change), `✅ ${ci.ci_number} retired in the CMDB.`);

  // Same pacing before the tracker-update/close/summary sequence below.
  await pushDecomThinking(decomTargets(change), true);
  await sleep(5000);
  await pushDecomThinking(decomTargets(change), false);

  let trackerRow = null;
  try {
    trackerRow = await appendDecomTrackerRow({
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
    await pushDecomUpdate(decomTargets(change), `⚠️ ${ci.name} was destroyed and retired, but updating the Decommissioned Tracker failed: ${e.message}. Update it manually.`);
  }

  const closed = await db.prepare(`
    UPDATE changes SET status = 'closed', updated_at = ?, closed_at = ? WHERE id = ? RETURNING *
  `).get(nowStr(), nowStr(), change.id);
  await logActivity('change', change.id, confirmer.id, 'Change closed — decommission complete');

  // ci.cpu already reads as self-explanatory ("1 vCPU"), but ci.ram/ci.disk are bare
  // magnitudes ("512 MB", "1 GB") with nothing distinguishing which is which once joined —
  // label those two explicitly.
  const reclaimedParts = [
    ci.cpu || null,
    ci.ram ? `${ci.ram} RAM` : null,
    ci.disk ? `${ci.disk} storage` : null
  ].filter(Boolean);
  const createdAtMs = new Date(`${change.created_at.replace(' ', 'T')}Z`).getTime();
  await pushDecomUpdate(
    decomTargets(change),
    `🎉 ${ci.name} decommissioned.`,
    {
      cardType: 'decom_summary',
      changeId: change.id,
      changeNumber: change.number,
      ciName: ci.name,
      changeStatus: 'Closed / Successful',
      cmdbStatus: 'CI retired, audit-frozen',
      reclaimed: reclaimedParts.length ? reclaimedParts.join(' · ') : '—',
      trackerRow: trackerRow || '—',
      elapsedSim: formatElapsed(Date.now() - startedAt),
      elapsedReal: formatElapsed(Date.now() - createdAtMs)
    }
  );

  res.json({ change: closed, ci: await db.prepare('SELECT * FROM cmdb_ci WHERE id = ?').get(ci.id) });
});

// POST /novaconnect/decommission-requests/:id/cancel-destroy
// The Cancel option next to Confirm Destroy — backs out of the destroy at the last checkpoint
// by powering the VM back on (undoing the earlier power-off) and marking the Change cancelled,
// rather than proceeding to the irreversible step. Same admin-only gate as confirm-destroy.
router.post('/novaconnect/decommission-requests/:id/cancel-destroy', async (req, res) => {
  const { change, ci, error, message } = await loadDecomContext(req.params.id);
  if (error) return res.status(error).json({ error: message });

  const canceller = req.body.cancelled_by_username
    ? await db.prepare("SELECT id, role FROM users WHERE username = ?").get(req.body.cancelled_by_username)
    : null;
  if (!canceller || canceller.role !== 'admin') {
    return res.status(403).json({ error: 'Only a NovaDesk admin can cancel a VM destroy.' });
  }

  // See the matching guard in confirm-destroy above — same dual-posted-card race, same fix.
  if (change.status !== 'in_progress') {
    return res.status(409).json({ error: `${change.number} is no longer awaiting a destroy decision (current status: ${change.status}) — this was likely already actioned from another window.` });
  }

  const esxiHost = await resolveEsxiHost(ci.id);
  if (!esxiHost) return res.status(422).json({ error: `"${ci.name}" has no resolvable ESXi host.` });

  const sessionId = await esxi.login(esxiHost.ip_address);
  const vm = await esxi.findVm(esxiHost.ip_address, sessionId, ci.name);
  if (!vm) throw new Error(`No VM named "${ci.name}" found on ${esxiHost.name} — it may already be gone.`);
  await esxi.powerOn(esxiHost.ip_address, sessionId, vm.vm);
  await db.prepare(`
    UPDATE change_tasks SET status = 'pending', completed_at = NULL WHERE change_id = ? AND description = 'Power off — soak period'
  `).run(change.id);
  await logActivity('change', change.id, canceller.id, `Destroy cancelled by ${req.body.cancelled_by_username} — ${ci.name} powered back on`);

  const cancelled = await db.prepare(`
    UPDATE changes SET status = 'cancelled', updated_at = ?, closed_at = ? WHERE id = ? RETURNING *
  `).get(nowStr(), nowStr(), change.id);
  await logActivity('change', change.id, canceller.id, 'Change cancelled — decommission stopped before destroy');

  // See the matching resolve in confirm-destroy above — same reasoning, same fix.
  await resolveNovaConnectCard({ changeId: change.id, cardType: 'decom_confirm_destroy' }, 'cancelled');
  await pushDecomUpdate(
    decomTargets(change),
    `🛑 ${change.number} cancelled — ${ci.name} powered back on, destroy did not proceed.`,
    { cardType: 'decom_status', changeId: change.id, changeNumber: change.number, status: 'cancelled' }
  );

  res.json({ change: cancelled, ci });
});

// POST /api/integrations/novaconnect/decommission-requests/:id/reject
router.post('/novaconnect/decommission-requests/:id/reject', async (req, res) => {
  const { change, error, message } = await loadDecomContext(req.params.id);
  if (error) return res.status(error).json({ error: message });

  const rejector = req.body.rejected_by_username
    ? await db.prepare('SELECT id, full_name FROM users WHERE username = ?').get(req.body.rejected_by_username)
    : null;

  await db.prepare(`
    UPDATE changes SET approval_status='rejected', status='rejected', updated_at=? WHERE id=?
  `).run(nowStr(), change.id);
  await logActivity('change', change.id, rejector ? rejector.id : null, 'Decommission rejected (via NovaConnect)');

  await announceDecomRejection(change, rejector ? rejector.full_name : (req.body.rejected_by_username || 'someone'));

  res.json({ change: await db.prepare('SELECT * FROM changes WHERE id = ?').get(change.id) });
});

module.exports = router;
