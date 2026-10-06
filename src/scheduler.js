const { db, nowStr, logActivity } = require('./db');
const { pushDecomUpdate, decomTargets } = require('./novaconnect');

const POLL_INTERVAL_MS = 30 * 1000;

// Identifies one NovaConnect target (a channel or a DM) in the delivered_targets bookkeeping.
const targetKey = (t) => (t.channelId ? `channel:${t.channelId}` : `dm:${t.conversationId}`);

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

    // The timer is only finished once the card has actually reached NovaConnect. It used to be
    // marked 'executed' even when the push failed (the sender swallows errors), so a NovaConnect
    // outage at the moment the timer fired lost the Confirm Destroy card for good: nothing ever
    // retried, and the Change sat in progress with the VM off (fault-injection case 4d,
    // 2026-10-06). Now an undelivered card keeps the action 'pending', so the next poll tries
    // again, and only the targets that have not received it yet are tried, so a retry never posts
    // a second copy where it already landed. While the card is undelivered the destroy can still be
    // confirmed from NovaDesk's own Change Tasks list: destroySoakOver only needs the timer to
    // be due, not delivered.
    const delivered = new Set(JSON.parse(action.delivered_targets || '[]'));
    const remaining = decomTargets(change).filter((t) => !delivered.has(targetKey(t)));
    const results = remaining.length === 0 ? [] : await pushDecomUpdate(
      remaining,
      `⏳ Soak period elapsed for ${change.number} (${ci ? ci.name : 'unknown CI'}). Confirm to permanently destroy the VM and release its storage — this cannot be undone.`,
      { cardType: 'decom_confirm_destroy', changeId: change.id, changeNumber: change.number, ciName: ci ? ci.name : null, status: 'pending' }
    );
    for (const r of results) if (r.ok) delivered.add(targetKey(r.target));
    const complete = results.every((r) => r.ok); // true when there was nothing left to send
    const attempts = (action.attempts || 0) + 1;

    await db.prepare(`
      UPDATE scheduled_actions SET delivered_targets = ?, attempts = ?, status = ?, executed_at = ? WHERE id = ?
    `).run(JSON.stringify([...delivered]), attempts, complete ? 'executed' : 'pending', complete ? nowStr() : null, action.id);

    if (!complete && attempts === 1) {
      await logActivity('change', change.id, null, 'The Confirm Destroy card could not be delivered to NovaConnect yet; it will keep retrying. The destroy can still be confirmed from this Change\'s task list.').catch(() => {});
    }
    if (complete && attempts > 1) {
      await logActivity('change', change.id, null, `The Confirm Destroy card was delivered to NovaConnect after ${attempts} attempts.`).catch(() => {});
    }
  }
}

function startScheduler() {
  setInterval(() => { pollScheduledActions().catch((e) => console.error('Scheduler poll failed:', e.message)); }, POLL_INTERVAL_MS);
}

module.exports = { startScheduler };
