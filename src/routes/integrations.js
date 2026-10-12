const { db, nextNumber, logActivity, nowStr, offsetStr } = require('../db');
const { escapeHtml } = require('../helpers');
const createAsyncRouter = require('../asyncRouter');
const esxi = require('../esxi');
const { pushDecomUpdate, pushDecomThinking, decomTargets } = require('../novaconnect');
const { syncCard } = require('../cardSync');
const { notifyDecom } = require('../decomNotify');
const {
  DECOM_TASKS, MANUAL_TASKS, resolveEsxiHost, maybeProceedWithPowerDown, sleep,
  announceDecomApproval, announceDecomRejection, resolvePrecheckTask, runConfirmedDestroy, restoreCiFromMaintenance
} = require('../decomAutomation');

const router = createAsyncRouter();

// A Change in one of these states is finished; nothing in the decommission flow may act on it.
const CLOSED_STATUSES = ['closed', 'cancelled', 'rejected'];

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

  // Decommission changes are always assigned to Alex Admin (username 'admin') and scheduled to
  // start immediately with a 1-day window -- there's no separate approval-to-schedule gap for
  // this automated flow, so "planned" is just "now" through "now + 1 day".
  const defaultAssignee = await db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  const plannedStart = nowStr();
  const plannedEnd = offsetStr(1);

  const number = await nextNumber('change', 'CHG');
  const change = await db.prepare(`
    INSERT INTO changes (number, short_description, description, change_type, risk, status,
      requested_by, assigned_to, assignment_group, affected_ci_id, planned_start, planned_end,
      novaconnect_channel_id, novaconnect_conversation_id, implementation_plan)
    VALUES (@number, @short_description, @description, 'normal', 'low', 'submitted',
      @requested_by, @assigned_to, @assignment_group, @affected_ci_id, @planned_start, @planned_end,
      @novaconnect_channel_id, @novaconnect_conversation_id, @implementation_plan)
    RETURNING *
  `).get({
    number,
    short_description: `Decommission ${ci.name}`,
    description: `Automated decommission request for "${ci.name}" (${ci.ci_number}), submitted from NovaConnect.`,
    requested_by: requester ? requester.id : null,
    assigned_to: defaultAssignee ? defaultAssignee.id : null,
    assignment_group: 'IRO-Build/Decom',
    affected_ci_id: ci.id,
    planned_start: plannedStart,
    planned_end: plannedEnd,
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
  notifyDecom(change.id, 'requested');

  const tasks = await db.prepare('SELECT * FROM change_tasks WHERE change_id = ? ORDER BY sequence').all(change.id);
  res.status(201).json({ change, ci, esxiHost, tasks });
});

// POST /api/integrations/novaconnect/decommission-status
// body: { query } where query is a server name (or CI number) or a Change number. Answers a
// "status <server|CHG...>" message typed in a decommission DM or #server-decom: for a server, its
// decommission Changes newest first (up to 5); for a Change number, that Change. Read only.
const STATUS_MATCH_LIMIT = 5;
router.post('/novaconnect/decommission-status', async (req, res) => {
  const raw = String(req.body.query || '').trim().slice(0, 120);
  if (!raw) return res.status(400).json({ error: 'query is required.' });

  const num = raw.match(/^chg0*(\d+)$/i);
  let ci = null;
  let changes = [];
  if (num) {
    const c = await db.prepare('SELECT * FROM changes WHERE number = ?').get(`CHG${String(Number(num[1])).padStart(7, '0')}`);
    if (c) changes = [c];
  } else {
    ci = await db.prepare('SELECT id, name, ci_number, status FROM cmdb_ci WHERE lower(name) = lower(?) OR lower(ci_number) = lower(?) ORDER BY id LIMIT 1').get(raw, raw);
    if (ci) {
      changes = await db.prepare(`
        SELECT * FROM changes WHERE affected_ci_id = ? AND (novaconnect_channel_id IS NOT NULL OR novaconnect_conversation_id IS NOT NULL)
        ORDER BY id DESC LIMIT ?
      `).all(ci.id, STATUS_MATCH_LIMIT);
    }
  }

  const nameOf = async (id) => (id ? ((await db.prepare('SELECT full_name FROM users WHERE id = ?').get(id)) || {}).full_name || null : null);
  const matches = [];
  for (const c of changes) {
    const isDecom = !!(c.novaconnect_channel_id || c.novaconnect_conversation_id);
    const cci = await db.prepare('SELECT name, ci_number, status FROM cmdb_ci WHERE id = ?').get(c.affected_ci_id);
    const tasks = await db.prepare('SELECT description, status, completed_at FROM change_tasks WHERE change_id = ? ORDER BY sequence').all(c.id);
    const task = (d) => tasks.find((t) => t.description === d);
    const manualDone = tasks.filter((t) => MANUAL_TASKS.includes(t.description) && (t.status === 'done' || t.status === 'skipped')).length;
    const powerTask = task('Power off — soak period');
    const destroyTask = task('Destroy VM & release storage');
    const timer = await db.prepare(`
      SELECT run_at, status FROM scheduled_actions WHERE change_id = ? AND action_type = 'destroy_vm' ORDER BY id DESC LIMIT 1
    `).get(c.id);
    const approvedRow = await db.prepare(`
      SELECT created_at FROM activity_log WHERE entity_type = 'change' AND entity_id = ?
        AND (message LIKE 'Decommission approved%' OR message LIKE 'Change approved%') ORDER BY id LIMIT 1
    `).get(c.id);

    let step;
    if (c.status === 'cancelled') step = 'Cancelled';
    else if (c.status === 'rejected' || c.approval_status === 'rejected') step = 'Rejected';
    else if (c.status === 'closed') step = destroyTask && destroyTask.status === 'done' ? 'Completed: VM destroyed and CI retired' : 'Closed';
    else if (c.approval_status !== 'approved') step = 'Waiting for approval';
    else if (manualDone < MANUAL_TASKS.length) step = `Pre-checks in progress (${manualDone} of ${MANUAL_TASKS.length} done)`;
    else if (!powerTask || powerTask.status !== 'done') step = 'Pre-checks complete; power-off not done yet (needs attention)';
    else if (destroyTask && destroyTask.status === 'done') step = 'VM destroyed; finishing the last steps';
    else if (timer && timer.status === 'pending' && timer.run_at > nowStr()) step = 'VM powered off; soak period running';
    else step = 'Soak period over; waiting for Confirm Destroy';

    matches.push({
      id: c.id, number: c.number, isDecommission: isDecom, status: c.status, approvalStatus: c.approval_status, step,
      shortDescription: c.short_description,
      ci: cci ? { name: cci.name, ciNumber: cci.ci_number, status: cci.status } : null,
      requestedBy: await nameOf(c.requested_by), assignedTo: await nameOf(c.assigned_to), approvedBy: c.approval_status === 'approved' ? await nameOf(c.approved_by) : null,
      assignmentGroup: c.assignment_group || null,
      submittedAt: c.created_at, approvedAt: approvedRow ? approvedRow.created_at : null,
      poweredOffAt: powerTask && powerTask.status === 'done' ? powerTask.completed_at : null,
      soakEndsAt: timer ? timer.run_at : null,
      destroyedAt: destroyTask && destroyTask.status === 'done' ? destroyTask.completed_at : null,
      completedAt: c.status === 'closed' ? c.closed_at : null,
      cancelledAt: c.status === 'cancelled' ? c.closed_at : null,
      tasksDone: tasks.filter((t) => t.status === 'done' || t.status === 'skipped').length, tasksTotal: tasks.length
    });
  }

  res.json({
    query: raw,
    kind: num ? 'change' : 'server',
    ci: ci ? { name: ci.name, ciNumber: ci.ci_number, status: ci.status } : null,
    matches
  });
});

// Who is acting on a decommission from NovaConnect, and may they? NovaConnect decides and says so
// in acting_user { username, full_name, authorized, basis }: authorized is true only for the person
// who requested this decommission (basis "requester") or an owner or admin of the team that owns
// #server-decom or of the channel itself (basis "server-decom admin"); a NovaConnect-wide admin or a
// NovaDesk admin who is neither is NOT authorized. NovaConnect is the app that knows its own teams
// and who asked, and the call is authenticated with the shared service key (the same trust that
// already lets it name any username).
//  - acting_user present: its answer decides (it must be the boolean true and name the same
//    username as the action). The action is attributed to the person's own NovaDesk account when
//    they have one, otherwise to NovaDesk's default admin account (the Change columns need a
//    NovaDesk user id) with their own name in the activity text and notices.
//  - acting_user absent (an older NovaConnect, a direct API call): the previous rule, the username
//    must be a NovaDesk admin.
// Returns { id, role, full_name, username, basis } or null.
async function resolveDecomActor(req, username) {
  if (!username || typeof username !== 'string') return null;
  const user = await db.prepare('SELECT id, role, full_name FROM users WHERE username = ?').get(username);
  const vouch = req.body && req.body.acting_user;

  if (vouch && typeof vouch === 'object') {
    if (vouch.authorized !== true || vouch.username !== username) return null;
    const name = (typeof vouch.full_name === 'string' && vouch.full_name.trim() ? vouch.full_name.trim() : (user && user.full_name) || username).slice(0, 100);
    const basis = vouch.basis === 'requester' ? 'requester' : 'server-decom admin';
    if (user) return { id: user.id, role: 'admin', full_name: name, username, basis };
    const fallback = await db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
    return fallback ? { id: fallback.id, role: 'admin', full_name: name, username, basis } : null;
  }

  if (user && user.role === 'admin') return { id: user.id, role: 'admin', full_name: user.full_name, username, basis: null };
  return null;
}
const VIA_NC = (a) => (a.basis === 'requester' ? ` by ${a.full_name} (the requester)` : a.basis ? ` by ${a.full_name} (admin of the server-decom team)` : '');
const NOT_ALLOWED = (what) => `Only the person who requested this decommission, or an owner or admin of the server-decom team in NovaConnect, can ${what}.`;

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

  const approver = await resolveDecomActor(req, req.body.approved_by_username);
  if (!approver) return res.status(403).json({ error: NOT_ALLOWED('approve a decommission request') });
  // One-shot decision: only a still-pending, still-open Change can be approved. Without this a
  // second click (the card exists in the DM and in the channel), a stale window, or a direct call
  // re-approved a rejected or closed Change, reopened it as in progress, and re-posted the
  // approval message and first precheck card (fault-injection probes P6, P7, P9).
  if (change.approval_status !== 'pending' || CLOSED_STATUSES.includes(change.status)) {
    return res.status(409).json({ error: `${change.number} can't be approved now (status: ${change.status}, approval: ${change.approval_status}); it was probably already actioned from another window.` });
  }

  // 'in_progress', not 'scheduled' — a decom Change starts executing (prechecks, power-down)
  // the instant it's approved, not at some future planned date.
  // The state change is the real gate: it only succeeds while the Change is still pending and open,
  // so two simultaneous approvals can't both get through the read check above.
  const claimed = await db.prepare(`
    UPDATE changes SET approval_status='approved', approved_by=?, status='in_progress', updated_at=?
    WHERE id=? AND approval_status='pending' AND status NOT IN ('closed','cancelled','rejected')
    RETURNING id
  `).get(approver.id, nowStr(), change.id);
  if (!claimed) {
    return res.status(409).json({ error: `${change.number} was just actioned from another window.` });
  }
  await logActivity('change', change.id, approver.id, `Decommission approved (via NovaConnect)${VIA_NC(approver)}`);
  notifyDecom(change.id, 'approved', `Approved by ${approver.full_name} in NovaConnect.`);

  // announceDecomApproval resolves the approval card + posts "approved" FIRST, before the
  // precheck cards — see its own comment in decomAutomation.js for why order matters here.
  // Power-off no longer happens automatically after this — it's gated on all 3 manual prechecks
  // being resolved (Completed or Skipped). Whichever route ends up resolving the last of the 3
  // (precheck-task or skip-manual-tasks below, or NovaDesk's own Change Tasks Complete/Skip
  // buttons in routes/changes.js) is what actually triggers it, via maybeProceedWithPowerDown.
  await announceDecomApproval(change, approver.full_name, approver.id);

  res.json({ change: await db.prepare('SELECT * FROM changes WHERE id = ?').get(change.id), ci, tasks });
});

// POST /novaconnect/decommission-requests/:id/skip-manual-tasks
// The 3 non-automated pre-checks — explicit human decision, not silently assumed done.
router.post('/novaconnect/decommission-requests/:id/skip-manual-tasks', async (req, res) => {
  const { change, tasks, error, message } = await loadDecomContext(req.params.id);
  if (error) return res.status(error).json({ error: message });

  const actor = await resolveDecomActor(req, req.body.skipped_by_username);
  if (!actor) return res.status(403).json({ error: NOT_ALLOWED('skip these tasks') });
  if (change.approval_status !== 'approved' || CLOSED_STATUSES.includes(change.status)) {
    return res.status(409).json({ error: `${change.number}: the pre-checks can only be skipped while the Change is approved and open (status: ${change.status}, approval: ${change.approval_status}).` });
  }
  if (!(tasks || []).some((t) => MANUAL_TASKS.includes(t.description) && t.status === 'pending')) {
    return res.status(409).json({ error: `${change.number}: there are no pending pre-checks left to skip.` });
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
  const actor = await resolveDecomActor(req, username);
  if (!actor) return res.status(403).json({ error: NOT_ALLOWED('update these tasks') });
  // Pre-checks belong to an approved, open Change, and each can be resolved once. Without this a
  // pre-check could be completed before approval, and a repeat click re-ran the pacing step and
  // posted another copy of the next card (probes P10, P11).
  if (change.approval_status !== 'approved' || CLOSED_STATUSES.includes(change.status)) {
    return res.status(409).json({ error: `${change.number}: pre-checks can only be updated while the Change is approved and open (status: ${change.status}, approval: ${change.approval_status}).` });
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

  if (task && task.status !== 'pending') {
    return res.status(409).json({ error: `${change.number}: "${task.description}" is already ${task.status === 'done' ? 'completed' : task.status}; it was probably already actioned from another window.` });
  }
  if (task && !(await resolvePrecheckTask(change, task, newStatus, actor.id, username))) {
    return res.status(409).json({ error: `${change.number}: "${task.description}" was just actioned from another window.` });
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

  const confirmer = await resolveDecomActor(req, req.body.confirmed_by_username);
  if (!confirmer) return res.status(403).json({ error: NOT_ALLOWED('confirm a VM destroy') });

  // The whole sequence (destroy, retire, tracker, close, summary) is shared with NovaDesk's own
  // Change Tasks list, where completing "Destroy VM & release storage" runs the same thing.
  try {
    const closed = await runConfirmedDestroy(change, ci, { id: confirmer.id, username: req.body.confirmed_by_username });
    res.json({ change: closed, ci: await db.prepare('SELECT * FROM cmdb_ci WHERE id = ?').get(ci.id) });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
});

// POST /novaconnect/decommission-requests/:id/cancel-destroy
// The Cancel option next to Confirm Destroy — backs out of the destroy at the last checkpoint
// by powering the VM back on (undoing the earlier power-off) and marking the Change cancelled,
// rather than proceeding to the irreversible step. Same admin-only gate as confirm-destroy.
router.post('/novaconnect/decommission-requests/:id/cancel-destroy', async (req, res) => {
  const { change, ci, error, message } = await loadDecomContext(req.params.id);
  if (error) return res.status(error).json({ error: message });

  const canceller = await resolveDecomActor(req, req.body.cancelled_by_username);
  if (!canceller) return res.status(403).json({ error: NOT_ALLOWED('cancel a VM destroy') });

  // See the matching guard in confirm-destroy above — same dual-posted-card race, same fix.
  if (change.status !== 'in_progress') {
    return res.status(409).json({ error: `${change.number} is no longer awaiting a destroy decision (current status: ${change.status}) — this was likely already actioned from another window.` });
  }

  const esxiHost = await resolveEsxiHost(ci.id);
  if (!esxiHost) return res.status(422).json({ error: `"${ci.name}" has no resolvable ESXi host.` });

  // Same "dots stop before the real command runs" pacing as confirm-destroy above.
  await pushDecomThinking(decomTargets(change), true);
  await sleep(10000);
  await pushDecomThinking(decomTargets(change), false);

  try {
    const sessionId = await esxi.login(esxiHost.ip_address);
    const vm = await esxi.findVm(esxiHost.ip_address, sessionId, ci.name);
    if (!vm) throw new Error(`No VM named "${ci.name}" found on ${esxiHost.name} — it may already be gone.`);
    // Already on counts as done: an earlier power-on may have completed without NovaDesk hearing back.
    if (esxi.powerStateOf(vm.raw) !== 'poweredOn') await esxi.powerOn(esxiHost.ip_address, sessionId, vm.vm);
  } catch (e) {
    await logActivity('change', change.id, canceller.id, `Cancelling the destroy failed: ${String(e.message).trim().replace(/[.\s]+$/, '')}. ${change.number} is still waiting for a destroy decision; Cancel can be tried again.`).catch(() => {});
    await pushDecomUpdate(decomTargets(change), `⚠️ Cancelling the destroy of ${ci.name} failed: ${String(e.message).trim().replace(/[.\s]+$/, '')}. ${change.number} is still waiting for a destroy decision; Cancel can be tried again.`).catch(() => {});
    return res.status(502).json({ error: `Cancelling failed: ${e.message}` });
  }
  await db.prepare(`
    UPDATE change_tasks SET status = 'pending', completed_at = NULL WHERE change_id = ? AND description = 'Power off — soak period'
  `).run(change.id);
  await logActivity('change', change.id, canceller.id, `Destroy cancelled by ${req.body.cancelled_by_username} — ${ci.name} powered back on`);

  const cancelled = await db.prepare(`
    UPDATE changes SET status = 'cancelled', updated_at = ?, closed_at = ? WHERE id = ? RETURNING *
  `).get(nowStr(), nowStr(), change.id);
  await logActivity('change', change.id, canceller.id, 'Change cancelled — decommission stopped before destroy');
  await restoreCiFromMaintenance(change, canceller.id).catch((e) => console.error('restoreCiFromMaintenance failed:', e.message));
  notifyDecom(change.id, 'cancelled', `Cancelled by ${req.body.cancelled_by_username} in NovaConnect; the VM was powered back on.`);

  // See the matching resolve in confirm-destroy above — same reasoning, same fix.
  await syncCard(change, { cardType: 'decom_confirm_destroy', desiredStatus: 'cancelled' });
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

  const rejector = await resolveDecomActor(req, req.body.rejected_by_username);
  if (!rejector) return res.status(403).json({ error: NOT_ALLOWED('reject a decommission request') });
  // Same one-shot rule as approve. Once approved, work has started (prechecks, power-off), so
  // stopping it goes through the Cancel path, not a late "reject" that left tasks and cards behind
  // (probe P8).
  if (change.approval_status !== 'pending' || CLOSED_STATUSES.includes(change.status)) {
    return res.status(409).json({ error: `${change.number} can't be rejected now (status: ${change.status}, approval: ${change.approval_status}); it was probably already actioned from another window.` });
  }

  const claimed = await db.prepare(`
    UPDATE changes SET approval_status='rejected', status='rejected', updated_at=?
    WHERE id=? AND approval_status='pending' AND status NOT IN ('closed','cancelled','rejected')
    RETURNING id
  `).get(nowStr(), change.id);
  if (!claimed) {
    return res.status(409).json({ error: `${change.number} was just actioned from another window.` });
  }
  await logActivity('change', change.id, rejector.id, `Decommission rejected (via NovaConnect)${VIA_NC(rejector)}`);
  notifyDecom(change.id, 'rejected', `Rejected by ${rejector.full_name} in NovaConnect.`);

  await announceDecomRejection(change, rejector.full_name);

  res.json({ change: await db.prepare('SELECT * FROM changes WHERE id = ?').get(change.id) });
});

module.exports = router;
