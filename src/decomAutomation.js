const { db, nowStr, offsetStr, logActivity } = require('./db');
const esxi = require('./esxi');
const { pushDecomUpdate, pushDecomThinking, decomTargets } = require('./novaconnect');

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
  await pushDecomThinking(decomTargets(change), true);
  try {
    await sleep(5000);
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
  } finally {
    await pushDecomThinking(decomTargets(change), false);
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

module.exports = {
  SOAK_PERIOD_HOURS,
  formatSoakDuration,
  sleep,
  markTaskDone,
  DECOM_TASKS,
  MANUAL_TASKS,
  resolveEsxiHost,
  allManualTasksResolved,
  maybeProceedWithPowerDown
};
