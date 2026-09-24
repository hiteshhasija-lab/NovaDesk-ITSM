const { db, nowStr, offsetStr, logActivity } = require('./db');
const esxi = require('./esxi');
const { pushDecomUpdate, pushDecomThinking, resolveNovaConnectCard, decomTargets } = require('./novaconnect');
const { CHANGE_STATUS_LABELS } = require('./helpers');

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
// integration exists) — an admin explicitly marks each complete or skip, from either
// NovaConnect or NovaDesk's own Change Tasks UI. The automated power-off step below is gated on
// all 3 reaching a terminal state — it used to fire unconditionally 5s after approval regardless
// of precheck status; that was changed after live testing showed power-off proceeding with only
// 1 of 3 tasks resolved, which is not the intended behavior.
const MANUAL_TASKS = DECOM_TASKS.slice(0, 3);

async function resolveEsxiHost(ciId) {
  const row = await db.prepare(`
    SELECT host.* FROM ci_relationships r
    JOIN cmdb_ci host ON host.id = r.parent_ci_id
    WHERE r.child_ci_id = ? AND r.relationship_type = 'runs_on'
    LIMIT 1
  `).get(ciId);
  return row || null;
}

async function allManualTasksResolved(changeId) {
  const rows = await db.prepare(`
    SELECT status FROM change_tasks WHERE change_id = ? AND description IN (?, ?, ?)
  `).all(changeId, ...MANUAL_TASKS);
  return rows.length === MANUAL_TASKS.length && rows.every((r) => r.status === 'done' || r.status === 'skipped');
}

// The actual power-off sequence — pulled out of the approve handler so it can be triggered from
// wherever the last of the 3 manual prechecks actually gets resolved (see
// maybeProceedWithPowerDown below), not just unconditionally from approve itself.
async function proceedWithPowerDown(change, ci, esxiHost, actorId) {
  await pushDecomUpdate(decomTargets(change), `⏳ Proceeding with the Power Down...`);
  // The dots represent "thinking" — they must stop BEFORE the real ESXi command runs, not
  // during it. Previously the power-off call ran inside the try block with thinking=false only
  // in `finally`, so it fired while the dots were still animating (caught live: power-off had
  // already executed while the animation was still showing).
  await pushDecomThinking(decomTargets(change), true);
  await sleep(10000);
  await pushDecomThinking(decomTargets(change), false);

  try {
    const sessionId = await esxi.login(esxiHost.ip_address);
    const vm = await esxi.findVm(esxiHost.ip_address, sessionId, ci.name);
    if (!vm) throw new Error(`No VM named "${ci.name}" found on ${esxiHost.name}.`);
    await esxi.powerOff(esxiHost.ip_address, sessionId, vm.vm);
    await markTaskDone(change.id, 'Power off — soak period');
    await logActivity('change', change.id, actorId, `VM powered off on ${esxiHost.name}, entering ${formatSoakDuration(SOAK_PERIOD_HOURS)} soak period`);
    await pushDecomUpdate(decomTargets(change), `✅ Power off complete — ${ci.name} is now off on ${esxiHost.name}. Entering a ${formatSoakDuration(SOAK_PERIOD_HOURS)} soak period before the destroy confirmation.`);

    await db.prepare(`
      INSERT INTO scheduled_actions (change_id, action_type, run_at) VALUES (?, 'destroy_vm', ?)
    `).run(change.id, offsetStr(0, SOAK_PERIOD_HOURS));
  } catch (e) {
    await logActivity('change', change.id, actorId, `ESXi power-off failed: ${e.message}`);
    await pushDecomUpdate(decomTargets(change), `⚠️ ${change.number} approved, but power-off on ${esxiHost.name} failed: ${e.message}. The soak-period timer was not started — this needs manual attention.`);
  }
}

// The gate: called after ANY manual precheck task changes state, from either app — a
// NovaConnect precheck-task/skip-manual-tasks click, or NovaDesk's own Change Tasks toggle
// button (see routes/changes.js). Power-off only actually happens once here, whichever call
// site happens to be the one that resolves the last of the 3 tasks. Safe to call speculatively
// any time a task changes state — it's a no-op unless the Change is approved, power-off hasn't
// already run, and all 3 manual tasks are now resolved.
async function maybeProceedWithPowerDown(changeId, actorId) {
  const change = await db.prepare('SELECT * FROM changes WHERE id = ?').get(changeId);
  if (!change || change.approval_status !== 'approved') return;

  const powerOffTask = await db.prepare(`
    SELECT status FROM change_tasks WHERE change_id = ? AND description = 'Power off — soak period'
  `).get(changeId);
  if (!powerOffTask || powerOffTask.status !== 'pending') return; // already ran, or no such task

  if (!(await allManualTasksResolved(changeId))) return;

  const ci = await db.prepare('SELECT * FROM cmdb_ci WHERE id = ?').get(change.affected_ci_id);
  if (!ci) return;
  const esxiHost = await resolveEsxiHost(ci.id);
  if (!esxiHost) return;

  await proceedWithPowerDown(change, ci, esxiHost, actorId);
}

// Posts the precheck card for the next unresolved MANUAL_TASK (by sequence), if any remain —
// one at a time, not all 3 at once. Relies on the 3 always being resolved in order: a later
// task's card is never posted until the earlier one is resolved, so "the lowest-sequence
// MANUAL_TASK still pending" is always unambiguous. No-ops once all 3 are resolved.
async function postNextPrecheckCard(change) {
  const tasks = await db.prepare('SELECT * FROM change_tasks WHERE change_id = ? ORDER BY sequence').all(change.id);
  const nextTask = MANUAL_TASKS
    .map((desc) => tasks.find((t) => t.description === desc))
    .find((t) => t && t.status === 'pending');
  if (!nextTask) return;

  await pushDecomUpdate(
    decomTargets(change),
    `Pre-decommission check: **${nextTask.description}**. Confirm when completed, or skip if not applicable.`,
    {
      cardType: 'decom_precheck_task',
      changeId: change.id,
      changeNumber: change.number,
      taskId: nextTask.id,
      taskNumber: nextTask.task_number,
      taskDescription: nextTask.description,
      status: 'pending'
    }
  );
}

// Resolves the approval card + posts the "approved" confirmation + posts the FIRST precheck
// card (the other 2 follow one at a time, via postNextPrecheckCard, as each prior one gets
// resolved — see resolvePrecheckTask below). Shared by both the NovaConnect-triggered approve
// route AND NovaDesk's own Change approve action (routes/changes.js) — a Change can be approved
// either way, and until this was shared, approving directly in NovaDesk's own UI left the
// NovaConnect approval card stuck on "pending" forever, since none of this ever ran for that path.
async function announceDecomApproval(change, approverFullName) {
  await resolveNovaConnectCard({ changeId: change.id, cardType: 'decom_approval' }, 'approved');
  await pushDecomUpdate(
    decomTargets(change),
    `✅ ${change.number} approved by ${approverFullName}. Scheduled for decommission.`,
    { cardType: 'decom_status', changeId: change.id, changeNumber: change.number, status: 'approved' }
  );

  const ci = await db.prepare('SELECT * FROM cmdb_ci WHERE id = ?').get(change.affected_ci_id);
  if (!ci) return;
  const esxiHost = await resolveEsxiHost(ci.id);
  if (!esxiHost) return;

  // Same pacing as the CI-search and power-down steps — otherwise the first precheck card lands
  // in the same instant as the approval confirmation above.
  await pushDecomThinking(decomTargets(change), true);
  await sleep(10000);
  await pushDecomThinking(decomTargets(change), false);

  await postNextPrecheckCard(change);
}

async function announceDecomRejection(change, rejectorFullName) {
  await resolveNovaConnectCard({ changeId: change.id, cardType: 'decom_approval' }, 'rejected');
  await pushDecomUpdate(
    decomTargets(change),
    `❌ ${change.number} rejected by ${rejectorFullName}.`,
    { cardType: 'decom_status', changeId: change.id, changeNumber: change.number, status: 'rejected' }
  );
}

// The generic Change edit form, board drag, bulk-update, and requester self-cancel can all
// change a decom Change's status/approval_status too, outside the dedicated approve/reject/
// confirm-destroy/cancel-destroy actions that already push their own rich announcements. Without
// this, NovaConnect has no way to know — the chat just goes stale (this is exactly what happened
// to CHG0000038: cancelled via the edit form, and the chat sat showing a now-stale "needs manual
// attention" warning forever, with nothing ever telling it the Change had moved on).
//
// The inverse of proceedWithPowerDown — powers a VM back on and reverts the "Power off — soak
// period" task to pending, for a Change that gets cancelled AFTER its VM was already powered
// off but was cancelled through a path other than the dedicated Cancel button (which already
// did this itself). Returns whether it actually powered something back on, so callers can word
// their announcement accordingly. Silently no-ops (not an error) if the VM was never powered off
// in the first place — cancelling a Change that never got that far has nothing to revert.
async function revertPowerOffIfNeeded(change, actorId) {
  const powerOffTask = await db.prepare(`
    SELECT status FROM change_tasks WHERE change_id = ? AND description = 'Power off — soak period'
  `).get(change.id);
  if (!powerOffTask || powerOffTask.status !== 'done') return false;

  const ci = await db.prepare('SELECT * FROM cmdb_ci WHERE id = ?').get(change.affected_ci_id);
  if (!ci) return false;
  const esxiHost = await resolveEsxiHost(ci.id);
  if (!esxiHost) return false;

  try {
    const sessionId = await esxi.login(esxiHost.ip_address);
    const vm = await esxi.findVm(esxiHost.ip_address, sessionId, ci.name);
    if (!vm) {
      await logActivity('change', change.id, actorId, `Could not power ${ci.name} back on after cancellation — no VM found on ${esxiHost.name}.`);
      return false;
    }
    await esxi.powerOn(esxiHost.ip_address, sessionId, vm.vm);
    await db.prepare(`
      UPDATE change_tasks SET status = 'pending', completed_at = NULL WHERE change_id = ? AND description = 'Power off — soak period'
    `).run(change.id);
    await logActivity('change', change.id, actorId, `${ci.name} powered back on on ${esxiHost.name} after cancellation`);
    return true;
  } catch (e) {
    await logActivity('change', change.id, actorId, `Failed to power ${ci.name} back on after cancellation: ${e.message}`);
    return false;
  }
}

// `preUpdateChange` must be the row as read BEFORE the update (its novaconnect_channel_id/
// conversation_id don't change, but its prior status/approval_status are what "did this actually
// change" is judged against). A transition INTO approved/rejected for the first time is routed
// through the same rich flow the dedicated routes use (so, e.g., precheck cards still get posted
// if someone approves via the edit form instead of the Approve button) rather than a generic
// note. A transition INTO cancelled powers the VM back on if it was already off — the dedicated
// Cancel button (next to Confirm Destroy) already did this; this covers every OTHER way a decom
// Change can be cancelled (edit form, board, bulk-update, requester self-cancel), which
// previously left the VM stuck off with nothing to bring it back — caught live via CHG0000042.
// Anything else gets a plain status-change message so the chat is never left silent.
async function announceGenericDecomStatusChange(preUpdateChange, newStatus, newApprovalStatus, actorFullName, actorId) {
  if (!preUpdateChange || !(preUpdateChange.novaconnect_channel_id || preUpdateChange.novaconnect_conversation_id)) return;
  if (newStatus === preUpdateChange.status && newApprovalStatus === preUpdateChange.approval_status) return;

  if (newApprovalStatus === 'approved' && preUpdateChange.approval_status !== 'approved') {
    await announceDecomApproval({ ...preUpdateChange, approval_status: newApprovalStatus, status: newStatus }, actorFullName);
    return;
  }
  if (newApprovalStatus === 'rejected' && preUpdateChange.approval_status !== 'rejected') {
    await announceDecomRejection(preUpdateChange, actorFullName);
    return;
  }

  if (newStatus === 'cancelled') {
    const poweredBackOn = await revertPowerOffIfNeeded(preUpdateChange, actorId);
    await resolveNovaConnectCard({ changeId: preUpdateChange.id, cardType: 'decom_confirm_destroy' }, 'cancelled').catch(() => {});
    await pushDecomUpdate(
      decomTargets(preUpdateChange),
      poweredBackOn
        ? `🛑 ${preUpdateChange.number} cancelled${actorFullName ? ` by ${actorFullName}` : ''} — the VM was powered back on automatically (updated directly in NovaDesk).`
        : `🛑 ${preUpdateChange.number} cancelled${actorFullName ? ` by ${actorFullName}` : ''} (updated directly in NovaDesk).`,
      { cardType: 'decom_status', changeId: preUpdateChange.id, changeNumber: preUpdateChange.number, status: 'cancelled' }
    );
    return;
  }

  const label = CHANGE_STATUS_LABELS[newStatus] || newStatus;
  await pushDecomUpdate(
    decomTargets(preUpdateChange),
    `ℹ️ ${preUpdateChange.number} status changed to "${label}"${actorFullName ? ` by ${actorFullName}` : ''} (updated directly in NovaDesk).`,
    { cardType: 'decom_status', changeId: preUpdateChange.id, changeNumber: preUpdateChange.number, status: newStatus }
  );
}

// Resolves one manual precheck task (Completed or Skipped): updates the task row, logs it,
// resolves every copy of the NovaConnect card for it (so the card flips to its final state
// before, not after, any power-down messages that might follow — same ordering fix as
// announceDecomApproval), then checks whether this was the last of the 3, in which case
// maybeProceedWithPowerDown actually fires the power-off. Shared by NovaConnect's
// precheck-task route AND NovaDesk's own Change Tasks Complete/Skip buttons.
async function resolvePrecheckTask(change, task, newStatus, actorId, actorLabel) {
  await db.prepare(`
    UPDATE change_tasks SET status = ?, completed_at = ? WHERE id = ?
  `).run(newStatus, newStatus === 'pending' ? null : nowStr(), task.id);
  const actionWord = newStatus === 'done' ? 'completed' : newStatus === 'skipped' ? 'skipped' : 'reset to pending';
  await logActivity('change', change.id, actorId, `Manual pre-check "${task.description}" marked ${actionWord}${actorLabel ? ` by ${actorLabel}` : ''}`);

  if (change.novaconnect_channel_id || change.novaconnect_conversation_id) {
    await resolveNovaConnectCard({ changeId: change.id, cardType: 'decom_precheck_task', taskId: task.id }, newStatus).catch(() => {});
  }

  if (newStatus === 'done' || newStatus === 'skipped') {
    // Same pacing as every other decom step, after a Complete/Skip action specifically (not a
    // reset back to pending).
    await pushDecomThinking(decomTargets(change), true);
    await sleep(10000);
    await pushDecomThinking(decomTargets(change), false);

    // The 3 precheck cards appear one at a time, not all together — post the next one now that
    // this one is resolved (no-ops once all 3 are done). maybeProceedWithPowerDown itself
    // no-ops unless this was the last of the 3, so calling both unconditionally is safe: exactly
    // one of them ever does anything on a given call.
    await postNextPrecheckCard(change);
    await maybeProceedWithPowerDown(change.id, actorId);
  }
}

module.exports = {
  SOAK_PERIOD_HOURS,
  formatSoakDuration,
  sleep,
  markTaskDone,
  DECOM_TASKS,
  MANUAL_TASKS,
  resolveEsxiHost,
  allManualTasksResolved,
  maybeProceedWithPowerDown,
  announceDecomApproval,
  announceDecomRejection,
  announceGenericDecomStatusChange,
  resolvePrecheckTask,
  postNextPrecheckCard
};
