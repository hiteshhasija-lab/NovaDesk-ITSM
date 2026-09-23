const { db, nowStr } = require('./db');
const { pushDecomUpdate, decomTargets } = require('./novaconnect');

const POLL_INTERVAL_MS = 30 * 1000;

// A persisted table + polling loop, not a bare setTimeout — a podman pod recreate (routine,
// e.g. a cert rotation) would silently lose an in-memory timer, and losing a scheduled destroy
// action for an irreversible operation is not an acceptable failure mode.
async function pollScheduledActions() {
  const due = await db.prepare(`
    SELECT * FROM scheduled_actions WHERE status = 'pending' AND run_at <= ?
  `).all(nowStr());
  for (const action of due) {
    await processDueAction(action).catch((e) => console.error(`Scheduled action ${action.id} failed:`, e.message));
  }
}

async function processDueAction(action) {
  const change = await db.prepare('SELECT * FROM changes WHERE id = ?').get(action.change_id);

  // Only fire if the Change is still genuinely awaiting this destroy decision ('in_progress' —
  // the same state integrations.js's confirm-destroy/cancel-destroy guard requires). Originally
  // this only excluded 'rejected'/'cancelled', which missed 'closed' — if the Change was somehow
  // already destroyed through another path (e.g. confirm-destroy called directly, bypassing the
  // normal wait for this very card to be posted) before this action's run_at, the old guard would
  // still blindly post a stale "confirm destroy" card for an already-destroyed VM once the timer
  // caught up. Caught exactly this way (CHG0000037: destroyed early via a direct test call, then
  // the leftover scheduled action fired 5 minutes later and posted the card anyway).
  if (!change || change.status !== 'in_progress') {
    await db.prepare(`UPDATE scheduled_actions SET status = 'cancelled' WHERE id = ?`).run(action.id);
    return;
  }

  if (action.action_type === 'destroy_vm') {
    const ci = await db.prepare('SELECT * FROM cmdb_ci WHERE id = ?').get(change.affected_ci_id);
    await pushDecomUpdate(
      decomTargets(change),
      `⏳ Soak period elapsed for ${change.number} (${ci ? ci.name : 'unknown CI'}). Confirm to permanently destroy the VM and release its storage — this cannot be undone.`,
      { cardType: 'decom_confirm_destroy', changeId: change.id, changeNumber: change.number, ciName: ci ? ci.name : null, status: 'pending' }
    );
    await db.prepare(`UPDATE scheduled_actions SET status = 'executed', executed_at = ? WHERE id = ?`).run(nowStr(), action.id);
  }
}

function startScheduler() {
  setInterval(() => { pollScheduledActions().catch((e) => console.error('Scheduler poll failed:', e.message)); }, POLL_INTERVAL_MS);
}

module.exports = { startScheduler };
