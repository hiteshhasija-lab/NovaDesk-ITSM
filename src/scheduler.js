const { db, nowStr } = require('./db');
const { pushDecomUpdate } = require('./novaconnect');

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

  // Re-check the Change hasn't been cancelled/rejected since this was scheduled — the soak
  // period exists precisely so there's a window to catch a mistake before the irreversible step.
  if (!change || change.status === 'rejected' || change.status === 'cancelled') {
    await db.prepare(`UPDATE scheduled_actions SET status = 'cancelled' WHERE id = ?`).run(action.id);
    return;
  }

  if (action.action_type === 'destroy_vm') {
    const ci = await db.prepare('SELECT * FROM cmdb_ci WHERE id = ?').get(change.affected_ci_id);
    await pushDecomUpdate(
      change.novaconnect_channel_id,
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
