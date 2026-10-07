const { db, nowStr } = require('./db');
const { syncCard, reconcileCards } = require('./cardSync');

const POLL_INTERVAL_MS = 30 * 1000;
// How often the card ledger is retried (cardSync.js); only the test rig changes this.
const CARD_SYNC_POLL_MS = (Number(process.env.CARD_SYNC_POLL_S) || 30) * 1000;

// A slow poll (a receiver that takes a while to answer) must not overlap the next one, or the same
// due action would be processed twice at once.
let polling = false;

// A persisted table + polling loop, not a bare setTimeout — a podman pod recreate (routine,
// e.g. a cert rotation) would silently lose an in-memory timer, and losing a scheduled destroy
// action for an irreversible operation is not an acceptable failure mode.
async function pollScheduledActions() {
  if (polling) return;
  polling = true;
  try {
    const due = await db.prepare(`
      SELECT * FROM scheduled_actions WHERE status = 'pending' AND run_at <= ?
    `).all(nowStr());
    for (const action of due) {
      await processDueAction(action).catch((e) => console.error(`Scheduled action ${action.id} failed:`, e.message));
    }
  } finally {
    polling = false;
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

    // Delivery of the card is the card ledger's job (cardSync.js): it records the card, tries
    // right away, and keeps retrying until every NovaConnect target has it, without ever posting a
    // second copy where it already landed. Once it is recorded the timer's job is done. (Until
    // 0.0.68 this marked the timer executed even when the card failed to send, and a NovaConnect
    // outage at that moment lost the Confirm Destroy card for good: fault-injection case 4d.)
    // While the card is undelivered the destroy can still be confirmed from NovaDesk's own Change
    // Tasks list: destroySoakOver only needs the timer to be due, not delivered.
    await syncCard(change, {
      cardType: 'decom_confirm_destroy',
      desiredStatus: 'pending',
      post: {
        body: `⏳ Soak period elapsed for ${change.number} (${ci ? ci.name : 'unknown CI'}). Confirm to permanently destroy the VM and release its storage — this cannot be undone.`,
        metadata: { cardType: 'decom_confirm_destroy', changeId: change.id, changeNumber: change.number, ciName: ci ? ci.name : null }
      }
    });
    // syncCard never throws, so confirm the card really is in the ledger before finishing the
    // timer: if recording it failed (a database hiccup) the timer stays pending and the next poll
    // tries again, rather than losing the card.
    const recorded = await db.prepare(`SELECT id FROM decom_card_sync WHERE change_id = ? AND card_type = 'decom_confirm_destroy' AND task_id = 0`).get(change.id);
    if (!recorded) return;
    await db.prepare(`UPDATE scheduled_actions SET status = 'executed', executed_at = ?, attempts = attempts + 1 WHERE id = ?`).run(nowStr(), action.id);
  }
}

function startScheduler() {
  setInterval(() => { pollScheduledActions().catch((e) => console.error('Scheduler poll failed:', e.message)); }, POLL_INTERVAL_MS);
  // Separate loop from the timers: a slow or unreachable NovaConnect can hold the card retries for
  // minutes, and that must never delay a destroy timer.
  setInterval(() => { reconcileCards().catch((e) => console.error('Card reconcile failed:', e.message)); }, CARD_SYNC_POLL_MS);
}

module.exports = { startScheduler };
