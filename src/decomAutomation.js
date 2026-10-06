const { db, nowStr, offsetStr, logActivity } = require('./db');
const esxi = require('./esxi');
const { pushDecomUpdate, pushDecomThinking, resolveNovaConnectCard, decomTargets } = require('./novaconnect');
const { CHANGE_STATUS_LABELS } = require('./helpers');
const { appendDecomTrackerRow } = require('./decomTracker');

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

// The last three decom steps (Destroy VM, Retire CI, Update tracker) and the Change close used to
// live only inside integrations.js's confirm-destroy route, so they only ever ran from NovaConnect's
// Confirm Destroy button. Completing "Destroy VM & release storage" in NovaDesk's own Change Tasks
// list now runs the very same sequence (pending-list enhancement, 2026-10-04), so it lives here and
// both doors call it.
const DESTROY_TASK = 'Destroy VM & release storage';
const RETIRE_TASK = 'Retire CI in CMDB';
const TRACKER_TASK = 'Update tracker & reclaim licenses';

// For the final decom summary card's "Elapsed" line — like formatSoakDuration but takes
// milliseconds and also expresses sub-minute durations.
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

function decomError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// The destroy-confirmation stage: the Change is in progress and its soak period is over (the
// scheduler's destroy_vm action is due — the same moment NovaConnect gets its Confirm Destroy card).
async function destroySoakOver(changeId) {
  const row = await db.prepare(`
    SELECT 1 FROM scheduled_actions
    WHERE change_id = ? AND action_type = 'destroy_vm' AND status IN ('pending', 'executed') AND run_at <= ?
    LIMIT 1
  `).get(changeId, nowStr());
  return !!row;
}

// The server-side gate in front of the irreversible ESXi destroy. Until this existed the only
// check was "the Change is in progress", which is true the moment it is approved, so the
// soak period was enforced only by WHEN the chat card appeared, not by the API: a direct
// confirm-destroy call right after approval would have gone straight to the ESXi calls (found by
// the fault-injection probe P12, 2026-10-06). The destroy now requires all of: the Change is
// approved, this workflow actually powered the VM off, and the soak period has run out. The
// scheduled destroy_vm row only ever exists after a successful power-off, so it also keeps the
// destroy away from any Change that never went through the decommission flow. Called from
// runConfirmedDestroy, the one place both doors (NovaConnect's Confirm Destroy and NovaDesk's
// Change Tasks button) go through.
async function assertDestroyAllowed(change) {
  const row = await db.prepare('SELECT approval_status FROM changes WHERE id = ?').get(change.id);
  if (!row || row.approval_status !== 'approved') {
    throw decomError(409, `${change.number} is not approved, so its VM cannot be destroyed.`);
  }

  const powerOff = await db.prepare(`
    SELECT status FROM change_tasks WHERE change_id = ? AND description = 'Power off — soak period'
  `).get(change.id);
  if (!powerOff || powerOff.status !== 'done') {
    throw decomError(409, `${change.number}: the VM has not been powered off yet. Destroy is only allowed after the power-off and the soak period.`);
  }

  if (!(await destroySoakOver(change.id))) {
    const timer = await db.prepare(`
      SELECT run_at FROM scheduled_actions
      WHERE change_id = ? AND action_type = 'destroy_vm' AND status = 'pending'
      ORDER BY run_at DESC LIMIT 1
    `).get(change.id);
    throw decomError(409, timer
      ? `${change.number}: the soak period is not over yet (it ends ${timer.run_at} UTC). Destroy is only allowed after that.`
      : `${change.number}: no soak period is recorded for this Change, so destroy is not allowed.`);
  }
}

// A VM's size as ESXi reports it (govc vm.info -json, the `raw` that esxi.findVm returns), in the
// CMDB's own style: "1 vCPU", "512 MB", "1 GB". Used for the summary's "Reclaimed" line when the
// CI's CPU/RAM/Disk fields are empty — the batch of test CIs created on 2026-09-24 (DECOM-TEST-19
// onwards) has none, so their summaries showed "—".
function sizeLabel(mb) {
  if (!(mb > 0)) return null;
  if (mb < 1024) return `${Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}
function hardwareFromVm(raw) {
  const config = raw && (raw.config || raw.Config);
  const hw = config && (config.hardware || config.Hardware);
  if (!hw) return null;
  const cpus = hw.numCPU ?? hw.NumCPU;
  const diskBytes = (hw.device || hw.Device || []).reduce((sum, d) => {
    const bytes = d.capacityInBytes ?? d.CapacityInBytes;
    const kb = d.capacityInKB ?? d.CapacityInKB;
    return sum + (bytes > 0 ? bytes : kb > 0 ? kb * 1024 : 0);
  }, 0);
  return {
    cpu: cpus > 0 ? `${cpus} vCPU` : null,
    ram: sizeLabel(hw.memoryMB ?? hw.MemoryMB),
    disk: sizeLabel(diskBytes / 1048576)
  };
}

// `fromEsxi` (optional): the VM's size from hardwareFromVm, filling any CPU/RAM/Disk the CI lacks.
async function postDecomSummary(change, ci, trackerRow, cmdbStatus, fromEsxi) {
  const cpu = ci.cpu || (fromEsxi && fromEsxi.cpu);
  const ram = ci.ram || (fromEsxi && fromEsxi.ram);
  const disk = ci.disk || (fromEsxi && fromEsxi.disk);
  // cpu already reads as self-explanatory ("1 vCPU"), but ram/disk are bare magnitudes
  // ("512 MB", "1 GB") with nothing distinguishing which is which once joined — label those two.
  const reclaimedParts = [
    cpu || null,
    ram ? `${ram} RAM` : null,
    disk ? `${disk} storage` : null
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
      cmdbStatus,
      reclaimed: reclaimedParts.length ? reclaimedParts.join(' · ') : '—',
      trackerRow: trackerRow || '—',
      elapsedReal: formatElapsed(Date.now() - createdAtMs)
    }
  );
}

// One destroy at a time per Change: the card is dual-posted in NovaConnect and NovaDesk's task list
// is a third door, and the sequence takes ~30 s (paced steps) before the Change leaves 'in_progress'.
const destroysRunning = new Set();

// Destroy the VM on ESXi, retire the CI, update the tracker, close the Change and post the summary —
// each step announced in NovaConnect. `confirmer` is { id, username } of the admin who confirmed.
// Throws an Error with .status (409/422) for a request that can't proceed; ESXi failures throw as-is.
async function runConfirmedDestroy(change, ci, confirmer) {
  // Claimed before the first await, so two confirmations arriving together can't both start.
  if (destroysRunning.has(change.id)) throw decomError(409, `${change.number}: the destroy is already running.`);
  destroysRunning.add(change.id);
  try {
    // The destroy-confirmation card is dual-posted (DM + server-decom), so the same action is
    // clickable from two message copies (and from NovaDesk). Once the first one moves the Change
    // off 'in_progress', reject the rest instead of re-running the ESXi calls. Re-read the Change:
    // the caller's copy may be from before another door finished.
    const current = await db.prepare('SELECT status FROM changes WHERE id = ?').get(change.id);
    if (!current || current.status !== 'in_progress') {
      throw decomError(409, `${change.number} is no longer awaiting a destroy decision (current status: ${current ? current.status : 'deleted'}) — this was likely already actioned from another window.`);
    }
    await assertDestroyAllowed(change);
    const esxiHost = await resolveEsxiHost(ci.id);
    if (!esxiHost) throw decomError(422, `"${ci.name}" has no resolvable ESXi host.`);

    // Dots stop BEFORE the real destroy command runs, not during it — see proceedWithPowerDown.
    await pushDecomThinking(decomTargets(change), true);
    await sleep(10000);
    await pushDecomThinking(decomTargets(change), false);

    const sessionId = await esxi.login(esxiHost.ip_address);
    const vm = await esxi.findVm(esxiHost.ip_address, sessionId, ci.name);
    if (!vm) throw new Error(`No VM named "${ci.name}" found on ${esxiHost.name} — it may already be gone.`);
    const fromEsxi = hardwareFromVm(vm.raw); // read before it's gone, for the summary
    await esxi.destroyVm(esxiHost.ip_address, sessionId, vm.vm);
    await markTaskDone(change.id, DESTROY_TASK);
    await logActivity('change', change.id, confirmer.id, `VM destroyed on ${esxiHost.name} (confirmed by ${confirmer.username})`);

    // Resolve the confirm-destroy card whichever door was used, or it stays stuck showing
    // "Confirm Destroy" with active buttons.
    await resolveNovaConnectCard({ changeId: change.id, cardType: 'decom_confirm_destroy' }, 'destroyed');
    await pushDecomUpdate(decomTargets(change), `✅ ${ci.name} destroyed on ${esxiHost.name} — storage released.`);

    // Same pacing as the other steps — otherwise "retired in the CMDB" lands in the same instant.
    await pushDecomThinking(decomTargets(change), true);
    await sleep(10000);
    await pushDecomThinking(decomTargets(change), false);

    await db.prepare(`UPDATE cmdb_ci SET status = 'retired', updated_at = ? WHERE id = ?`).run(nowStr(), ci.id);
    await markTaskDone(change.id, RETIRE_TASK);
    await pushDecomUpdate(decomTargets(change), `✅ ${ci.ci_number} retired in the CMDB.`);

    await pushDecomThinking(decomTargets(change), true);
    await sleep(10000);
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
        confirmedBy: confirmer.username
      });
      await markTaskDone(change.id, TRACKER_TASK);
    } catch (e) {
      await logActivity('change', change.id, confirmer.id, `Decommissioned Tracker update failed: ${e.message}`);
      await pushDecomUpdate(decomTargets(change), `⚠️ ${ci.name} was destroyed and retired, but updating the Decommissioned Tracker failed: ${e.message}. Update it manually.`);
    }

    const closed = await db.prepare(`
      UPDATE changes SET status = 'closed', updated_at = ?, closed_at = ? WHERE id = ? RETURNING *
    `).get(nowStr(), nowStr(), change.id);
    await logActivity('change', change.id, confirmer.id, 'Change closed — decommission complete');
    await postDecomSummary(change, ci, trackerRow, 'CI retired, audit-frozen', fromEsxi);
    return closed;
  } finally {
    destroysRunning.delete(change.id);
  }
}

// "Retire CI in CMDB" / "Update tracker & reclaim licenses" completed by hand in NovaDesk: by the
// user's choice these only report to NovaConnect (the CI record and the tracker are not touched).
// Once all 7 tasks are resolved, the Change closes and the summary card posts, as after a destroy.
async function announceManualFinalTask(change, task, actor) {
  await pushDecomUpdate(decomTargets(change), `✅ ${task.task_number} — ${task.description} marked complete in NovaDesk by ${actor.fullName}.`);
  const tasks = await db.prepare('SELECT status FROM change_tasks WHERE change_id = ?').all(change.id);
  const fresh = await db.prepare('SELECT * FROM changes WHERE id = ?').get(change.id);
  if (!tasks.length || !tasks.every((t) => t.status === 'done' || t.status === 'skipped')) return;
  if (!fresh || fresh.status === 'closed' || fresh.status === 'cancelled' || fresh.status === 'rejected') return;
  await db.prepare(`UPDATE changes SET status = 'closed', updated_at = ?, closed_at = ? WHERE id = ?`).run(nowStr(), nowStr(), change.id);
  await logActivity('change', change.id, actor.id, 'Change closed — all decommission tasks resolved');
  const ci = await db.prepare('SELECT * FROM cmdb_ci WHERE id = ?').get(change.affected_ci_id);
  if (!ci) return;
  const cmdbStatus = ci.status === 'retired' ? 'CI retired, audit-frozen' : `CI status unchanged (${ci.status}) — final tasks marked complete in NovaDesk`;
  await postDecomSummary(fresh, ci, null, cmdbStatus);
}

module.exports = {
  DESTROY_TASK,
  RETIRE_TASK,
  TRACKER_TASK,
  formatElapsed,
  destroySoakOver,
  runConfirmedDestroy,
  announceManualFinalTask,
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
