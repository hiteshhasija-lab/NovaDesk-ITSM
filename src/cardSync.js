// Keeps NovaConnect's decommission cards in step with NovaDesk's own records.
//
// The cards in the chat are a copy of NovaDesk's state, and NovaDesk used to update them with
// fire-and-forget calls: if one failed (receiver down, misrouted, 5xx, timeout) the chat stayed
// wrong for good, with live buttons on finished work or the card the operator needed never
// arriving (fault-injection experiment E2, 2026-10-06: every faulted run stayed wrong after the
// fault cleared). Now every card goes through syncCard(): it records what the card should show
// (desired_status) in the decom_card_sync ledger, tries to deliver immediately (so normal timing
// is unchanged), and anything undelivered is retried by reconcileCards() until the chat matches.
//
// Covered: the approval, pre-check, confirm-destroy and summary cards. Plain informational chat
// lines ("approved by ...", "power off complete") and the thinking dots stay best-effort: losing
// one is cosmetic, nothing actionable depends on it.
const { db, nowStr, logActivity } = require('./db');
const { pushDecomUpdate, resolveNovaConnectCard, novaConnectHealthy, decomTargets } = require('./novaconnect');

// Card types NovaConnect can resolve in place (its decomCards.js RESOLVABLE list). The summary is
// post-only.
const RESOLVABLE = new Set(['decom_approval', 'decom_precheck_task', 'decom_confirm_destroy']);

// A card that never reached the chat before its work finished is not posted late: an old
// "Completed" or "Destroyed" card appearing out of order adds nothing. Copies that already exist
// are still resolved.
const TERMINAL = {
  decom_precheck_task: ['done', 'skipped'],
  decom_confirm_destroy: ['destroyed', 'cancelled']
};

const LABEL = {
  decom_approval: 'approval card update',
  decom_precheck_task: 'pre-check card',
  decom_confirm_destroy: 'Confirm Destroy card',
  decom_summary: 'summary card'
};

// Tunable by environment so the test rig can exercise the long-outage rules in seconds.
const BACKOFF_BASE_S = Number(process.env.CARD_SYNC_BACKOFF_BASE_S) || 30;
const BACKOFF_MAX_S = Number(process.env.CARD_SYNC_BACKOFF_MAX_S) || 120;
const DEAD_AFTER = Number(process.env.CARD_SYNC_DEAD_AFTER) || 30;
const GIVE_UP_DAYS = 7;
const CLAIM_SECONDS = 60;
const SETTLED = ['closed', 'cancelled', 'rejected'];

const secondsFromNow = (s) => new Date(Date.now() + s * 1000).toISOString().slice(0, 19).replace('T', ' ');
const targetKey = (t) => (t.channelId ? `channel:${t.channelId}` : `dm:${t.conversationId}`);
const backoffSeconds = (attempts) => Math.min(BACKOFF_BASE_S * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_S);

// Records that `cardType` (for `taskId`, if any) should show `desiredStatus`, then tries to make
// it so right away. `post` ({ body, metadata }) is given only by callers that create the card;
// callers that merely change its status leave it out. Never throws; resolves to true when the chat
// is already up to date, false when the loop will finish the job.
async function syncCard(change, { cardType, taskId = null, desiredStatus, post = null }) {
  try {
    const now = nowStr();
    const row = await db.prepare(`
      INSERT INTO decom_card_sync (change_id, card_type, task_id, post_payload, desired_status, done, next_attempt_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT (change_id, card_type, task_id) DO UPDATE SET
        desired_status = EXCLUDED.desired_status,
        post_payload = COALESCE(EXCLUDED.post_payload, decom_card_sync.post_payload),
        done = 0,
        next_attempt_at = EXCLUDED.next_attempt_at,
        updated_at = EXCLUDED.updated_at
      RETURNING id
    `).get(change.id, cardType, taskId ?? 0, post ? JSON.stringify(post) : null, desiredStatus, now, now);
    return await deliver(row.id);
  } catch (e) {
    console.error(`Card sync for ${cardType} on change ${change && change.id} failed:`, e.message);
    return false;
  }
}

// Claims the row (so the inline attempt and the loop can never both post the same card), delivers,
// and releases it.
async function deliver(id) {
  const claimed = await db.prepare(`
    UPDATE decom_card_sync SET inflight_until = ?
    WHERE id = ? AND (inflight_until IS NULL OR inflight_until < ?)
    RETURNING *
  `).get(secondsFromNow(CLAIM_SECONDS), id, nowStr());
  if (!claimed) return false;
  try {
    return await deliverClaimed(claimed);
  } finally {
    await db.prepare('UPDATE decom_card_sync SET inflight_until = NULL WHERE id = ?').run(id).catch(() => {});
  }
}

async function deliverClaimed(row) {
  const now = nowStr();
  const change = await db.prepare('SELECT * FROM changes WHERE id = ?').get(row.change_id);
  if (!change) {
    await db.prepare('UPDATE decom_card_sync SET done = 1, last_error = ? WHERE id = ?').run('change no longer exists', row.id);
    return true;
  }

  const payload = row.post_payload ? JSON.parse(row.post_payload) : null;
  const postedBefore = new Set(JSON.parse(row.posted_targets));
  const posted = new Set(postedBefore);
  const dead = new Set(JSON.parse(row.dead_targets));
  const failCounts = JSON.parse(row.fail_counts);
  const desired = row.desired_status;
  const label = LABEL[row.card_type] || row.card_type;

  const skipLatePost = !!payload && (TERMINAL[row.card_type] || []).includes(desired);
  const toPost = payload && !skipLatePost
    ? decomTargets(change).filter((t) => !posted.has(targetKey(t)) && !dead.has(targetKey(t)))
    : [];

  let deliveredStatus = row.delivered_status;
  let anySuccess = false;
  let anyFailure = false;
  let lastError = null;
  const failedKeys = [];

  // 1. Post the card wherever it is missing, already showing its current status, so a card that
  //    arrives late never offers buttons for work that has since finished.
  if (toPost.length) {
    const metadata = RESOLVABLE.has(row.card_type) ? { ...payload.metadata, status: desired } : payload.metadata;
    // One key per card and target: NovaConnect stores a keyed message once, so a resend after a
    // lost answer cannot show the card twice (NovaConnect 1.0.183 and later; see novaconnect.js).
    const results = await pushDecomUpdate(toPost, payload.body, metadata, { idempotencyKeyBase: `novadesk-card:${row.change_id}:${row.card_type}:${row.task_id}` });
    for (const r of results) {
      const k = targetKey(r.target);
      if (r.ok) { posted.add(k); delete failCounts[k]; anySuccess = true; } else { anyFailure = true; failedKeys.push(k); lastError = 'card post failed'; }
    }
  }

  // 2. Copies that existed before this pass may show an older status: resolve them. (A copy posted
  //    in step 1 already shows the desired status.)
  const nothingExists = payload && postedBefore.size === 0;
  let needsResolve = RESOLVABLE.has(row.card_type) && deliveredStatus !== desired && !nothingExists;
  if (needsResolve) {
    const ok = await resolveNovaConnectCard({ changeId: row.change_id, cardType: row.card_type, taskId: row.task_id || null }, desired);
    if (ok) { deliveredStatus = desired; anySuccess = true; } else { anyFailure = true; lastError = lastError || 'card resolve failed'; }
  } else if (deliveredStatus !== desired) {
    // Nothing to resolve: either every copy was just posted with this status, nothing exists to
    // update (a late post was skipped), or the card type is post-only.
    const postedNow = toPost.some((t) => posted.has(targetKey(t)));
    const freshlyPostedAll = postedNow && toPost.every((t) => posted.has(targetKey(t)) || dead.has(targetKey(t)));
    if (skipLatePost || freshlyPostedAll || !payload) deliveredStatus = desired;
  }

  // 3. A target that keeps failing while NovaConnect itself is healthy is probably gone for good
  //    (a deleted channel). After DEAD_AFTER such failures stop trying it. While NovaConnect is
  //    down nothing is counted, so an outage can never mark a target dead.
  if (failedKeys.length && (anySuccess || await novaConnectHealthy())) {
    for (const k of failedKeys) {
      failCounts[k] = (failCounts[k] || 0) + 1;
      if (failCounts[k] >= DEAD_AFTER) {
        dead.add(k);
        await logActivity('change', change.id, null, `The ${label} could not be delivered to NovaConnect (${k}) after ${failCounts[k]} attempts while NovaConnect was reachable; giving up on that target.`).catch(() => {});
      }
    }
  }

  const remaining = toPost.filter((t) => !posted.has(targetKey(t)) && !dead.has(targetKey(t)));
  const complete = remaining.length === 0 && deliveredStatus === desired;
  const attempts = complete ? 0 : row.attempts + (anyFailure ? 1 : 0);

  await db.prepare(`
    UPDATE decom_card_sync SET posted_targets = ?, dead_targets = ?, fail_counts = ?, delivered_status = ?,
      done = ?, attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ?
    WHERE id = ?
  `).run(JSON.stringify([...posted]), JSON.stringify([...dead]), JSON.stringify(failCounts), deliveredStatus,
    complete ? 1 : 0, attempts, complete ? null : lastError, complete ? now : secondsFromNow(backoffSeconds(Math.max(attempts, 1))), now, row.id);

  if (!complete && row.attempts === 0 && anyFailure) {
    const suffix = row.card_type === 'decom_confirm_destroy' ? ' The destroy can still be confirmed from this Change\'s task list.' : '';
    await logActivity('change', change.id, null, `The ${label} could not be delivered to NovaConnect yet; it will keep retrying.${suffix}`).catch(() => {});
  }
  if (complete && row.attempts > 0) {
    await logActivity('change', change.id, null, `The ${label} was delivered to NovaConnect after ${row.attempts + 1} attempts.`).catch(() => {});
  }
  return complete;
}

// Called on a timer. Retries every card that is not yet in step; on an open Change it never gives
// up (a retry is one HTTP call, at most every BACKOFF_MAX_S), and for a Change that has long since
// finished it stops after GIVE_UP_DAYS.
let reconciling = false;
async function reconcileCards() {
  if (reconciling) return;
  reconciling = true;
  try {
    const cutoff = new Date(Date.now() - GIVE_UP_DAYS * 86400000).toISOString().slice(0, 19).replace('T', ' ');
    await db.prepare(`
      UPDATE decom_card_sync AS s SET done = 1, last_error = 'gave up after ${GIVE_UP_DAYS} days'
      FROM changes AS c
      WHERE c.id = s.change_id AND s.done = 0 AND c.status IN ('${SETTLED.join("','")}') AND s.updated_at < ?
    `).run(cutoff);

    const due = await db.prepare(`
      SELECT id FROM decom_card_sync WHERE done = 0 AND next_attempt_at <= ? ORDER BY id LIMIT 50
    `).all(nowStr());
    for (const r of due) {
      await deliver(r.id).catch((e) => console.error(`Card sync ${r.id} failed:`, e.message));
    }
  } finally {
    reconciling = false;
  }
}

// For the Change page: the cards that are not (fully) in the chat yet, in plain language. Cards
// that are fully delivered produce nothing, so the page stays quiet when everything is fine.
const FRIENDLY_CARD = {
  decom_approval: 'The approval card',
  decom_precheck_task: 'The pre-check card',
  decom_confirm_destroy: 'The Confirm Destroy card',
  decom_summary: 'The summary card'
};
const FRIENDLY_STATUS = {
  approved: 'Approved', rejected: 'Rejected', done: 'Completed', skipped: 'Skipped',
  pending: 'Waiting for action', destroyed: 'Destroyed', cancelled: 'Cancelled', posted: 'Posted'
};

async function describePendingCards(changeId) {
  const rows = await db.prepare(`
    SELECT s.*, t.description AS task_description
    FROM decom_card_sync s
    LEFT JOIN change_tasks t ON t.id = s.task_id AND s.task_id <> 0
    WHERE s.change_id = ? AND (s.done = 0 OR s.dead_targets <> '[]')
    ORDER BY s.id
  `).all(changeId);

  return rows.map((r) => {
    const base = `${FRIENDLY_CARD[r.card_type] || r.card_type}${r.card_type === 'decom_precheck_task' && r.task_description ? ` (${r.task_description})` : ''}`;
    const posted = JSON.parse(r.posted_targets);
    const dead = JSON.parse(r.dead_targets);
    const retrying = r.done === 0;
    let text;
    if (!retrying) {
      const where = dead.map((k) => (k.startsWith('dm:') ? 'a direct message' : 'a channel')).join(' and ');
      text = `${base} could not be delivered to ${where}; NovaDesk stopped trying after repeated failures while NovaConnect itself was reachable.`;
    } else if (r.post_payload && posted.length === 0) {
      text = `${base} has not reached the chat yet.`;
    } else {
      text = `${base} still shows an old status in the chat; it should show "${FRIENDLY_STATUS[r.desired_status] || r.desired_status}".`;
    }
    return { text, retrying, attempts: r.attempts, error: r.last_error, nextAttemptAt: retrying ? r.next_attempt_at : null };
  });
}

module.exports = { syncCard, reconcileCards, describePendingCards };
