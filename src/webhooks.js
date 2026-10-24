// Webhooks: turn the events that database triggers recorded into signed HTTP calls to the addresses an administrator
// chose, retry the ones that fail, and keep a log. The triggers are in migration 0006; the network rules are in
// webhookNet.js; the shapes of the records are the REST API's (api/resources.js).
'use strict';
const crypto = require('crypto');
const { db, nowStr } = require('./db');
const { encryptSecret, decryptSecret } = require('./mfaCrypto');
const net = require('./webhookNet');
const { entityLoaders, commentOut } = require('./api/resources');
const { iso } = require('./api/core');

// ---------------------------------------------------------------- what can be subscribed to
const RECORDS = { incident: 'Incidents', change: 'Changes', problem: 'Problems', request: 'Service requests', ci: 'Configuration items', article: 'Knowledge articles' };
const OPERATIONS = { created: 'is created', updated: 'is changed', status_changed: 'moves to another status', commented: 'gets a comment' };
const EVENT_TYPES = [];
for (const entity of Object.keys(RECORDS)) {
  for (const op of ['created', 'updated', 'status_changed']) EVENT_TYPES.push(`${entity}.${op}`);
  if (['incident', 'change', 'problem'].includes(entity)) EVENT_TYPES.push(`${entity}.commented`);
}
const allowPrivate = () => (process.env.WEBHOOK_ALLOW_PRIVATE || '').trim().toLowerCase() === 'true';
const autoDisableAfter = () => Number(process.env.WEBHOOK_AUTO_DISABLE_AFTER) || 10;
const MAX_WEBHOOKS = 20;

const subscribes = (webhook, type) => webhook.events === '*' || webhook.events.split(',').includes(type);

// ---------------------------------------------------------------- managing webhooks
const newSecret = () => `whsec_${crypto.randomBytes(32).toString('base64url')}`;

function parseEvents(selected) {
  const list = [].concat(selected || []).filter(Boolean);
  if (!list.length) throw new net.WebhookUrlError('Choose at least one event.');
  if (list.includes('*')) return '*';
  const bad = list.find((e) => !EVENT_TYPES.includes(e));
  if (bad) throw new net.WebhookUrlError(`"${bad}" is not an event NovaDesk sends.`);
  return [...new Set(list)].join(',');
}

// Resolves { id, secret }: the secret is shown once.
async function createWebhook(user, { name, url, events }) {
  const count = Number((await db.prepare('SELECT COUNT(*) AS c FROM webhooks').get()).c);
  if (count >= MAX_WEBHOOKS) throw new net.WebhookUrlError(`There are already ${MAX_WEBHOOKS} webhooks. Delete one first.`);
  await net.checkTarget(url, { allowPrivate: allowPrivate() });
  const secret = newSecret();
  const info = await db.prepare('INSERT INTO webhooks (name, url, secret_enc, events, created_by) VALUES (?, ?, ?, ?, ?) RETURNING id')
    .run(name, url, encryptSecret(secret), parseEvents(events), user.id);
  return { id: info.lastInsertRowid, secret };
}

async function rotateSecret(id) {
  const secret = newSecret();
  const done = await db.prepare('UPDATE webhooks SET secret_enc = ? WHERE id = ?').run(encryptSecret(secret), id);
  return done.changes === 1 ? secret : null;
}

async function setActive(id, active) {
  await db.prepare('UPDATE webhooks SET active = ?, disabled_reason = NULL WHERE id = ?').run(active ? 1 : 0, id);
}

// ---------------------------------------------------------------- events
// The JSON a receiver gets. `row` is an event_outbox row. The record is shown as it was right after the change (the
// snapshot the trigger took), with names filled in from the people and items it points at as they are now; so an
// event for "submitted" says submitted even if the record has moved on by the time it is sent.
async function buildPayload(row, eventId) {
  const loader = entityLoaders[row.entity];
  if (!loader) return null;
  const current = await db.prepare(loader.sql).get(row.entity_id);
  const snapshot = typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot;
  const record = snapshot ? { ...(current || {}), ...snapshot } : current;
  if (!record) return null;
  const type = `${row.entity}.${row.op}`;
  const payload = { id: eventId, type, created_at: iso(row.created_at), data: { [row.entity]: loader.out(record) } };
  if (row.op === 'status_changed') payload.previous = { status: row.previous_status };
  if (row.op === 'commented' && row.child_id) {
    const table = { incident: 'incident_comments', change: 'change_comments', problem: 'problem_comments' }[row.entity];
    const c = await db.prepare(`SELECT c.*, u.full_name AS author_name FROM ${table} c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?`).get(row.child_id);
    if (c) payload.comment = commentOut(c);
  }
  return { type, payload };
}

// Moves recorded events to the webhooks that want them: one pending delivery per webhook per event. Each event is
// claimed first (an UPDATE only one copy of NovaDesk can win), so it is fanned out once.
async function dispatchOutbox({ limit = 100 } = {}) {
  const claimed = await db.prepare(`
    UPDATE event_outbox SET processed_at = ?
    WHERE id IN (SELECT id FROM event_outbox WHERE processed_at IS NULL ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED)
    RETURNING *
  `).all(nowStr(), limit);
  if (!claimed.length) return 0;
  const hooks = await db.prepare('SELECT id, events FROM webhooks WHERE active = 1').all();
  for (const row of claimed.sort((a, b) => a.id - b.id)) {
    try {
      const wanted = hooks.filter((h) => subscribes(h, `${row.entity}.${row.op}`));
      if (!wanted.length) continue;
      const eventId = `evt_${crypto.randomUUID()}`;
      const built = await buildPayload(row, eventId);
      if (!built) continue;
      const body = JSON.stringify(built.payload);
      for (const h of wanted) {
        await db.prepare(`INSERT INTO webhook_deliveries (webhook_id, event_id, event_type, payload, next_attempt_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (webhook_id, event_id) DO NOTHING`)
          .run(h.id, eventId, built.type, body, nowStr());
      }
    } catch (err) { console.error(`[Webhooks] could not fan out event ${row.id}: ${err.message}`); }
  }
  await db.prepare(`DELETE FROM event_outbox WHERE processed_at IS NOT NULL AND processed_at < ?`).run(new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 19).replace('T', ' '));
  return claimed.length;
}

// ---------------------------------------------------------------- delivering
const secondsFromNow = (s) => new Date(Date.now() + s * 1000).toISOString().slice(0, 19).replace('T', ' ');

// The signing secret is stored encrypted with a key from MFA_ENCRYPTION_KEY, or else from SESSION_SECRET: if that
// changed since the webhook was made, the secret cannot be read and a new one has to be made.
function readSecret(webhook) {
  try { return decryptSecret(webhook.secret_enc); } catch {
    throw new Error('the signing secret cannot be read (SESSION_SECRET or MFA_ENCRYPTION_KEY has changed since it was made): use "New secret" on this webhook');
  }
}

// One try. Resolves { ok, status, error }. Writes the outcome to the delivery row, schedules the next try or gives up.
async function attempt(delivery, webhook) {
  const delays = net.retryDelays();
  let ok = false; let status = null; let error = null;
  try {
    const target = await net.checkTarget(webhook.url, { allowPrivate: allowPrivate() });
    const body = delivery.payload;
    const res = await net.postJson(target, {
      'Content-Type': 'application/json', 'User-Agent': 'NovaDesk-Webhooks/1',
      'X-NovaDesk-Event': delivery.event_type, 'X-NovaDesk-Event-Id': delivery.event_id, 'X-NovaDesk-Delivery': String(delivery.id),
      'X-NovaDesk-Signature': net.sign(readSecret(webhook), body),
    }, body);
    status = res.status;
    ok = res.status >= 200 && res.status < 300;
    if (!ok) error = res.status >= 300 && res.status < 400 ? `the receiver answered ${res.status} (redirects are not followed)` : `the receiver answered ${res.status}${res.snippet ? `: ${res.snippet.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`;
  } catch (err) { error = err.message; }

  const attempts = delivery.attempts + 1;
  if (ok) {
    await db.prepare(`UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, last_status_code = ?, last_error = NULL, delivered_at = ? WHERE id = ?`).run(attempts, status, nowStr(), delivery.id);
  } else if (attempts > delays.length) {
    await db.prepare(`UPDATE webhook_deliveries SET status = 'failed', attempts = ?, last_status_code = ?, last_error = ? WHERE id = ?`).run(attempts, status, error, delivery.id);
    if (delivery.event_type !== 'ping') await maybeDisable(webhook);
  } else {
    await db.prepare(`UPDATE webhook_deliveries SET attempts = ?, last_status_code = ?, last_error = ?, next_attempt_at = ? WHERE id = ?`).run(attempts, status, error, secondsFromNow(delays[attempts - 1]), delivery.id);
  }
  return { ok, status, error };
}

// A receiver that has failed this many deliveries in a row is switched off, so it is not called for ever.
async function maybeDisable(webhook) {
  const n = autoDisableAfter();
  const recent = await db.prepare(`SELECT status FROM webhook_deliveries WHERE webhook_id = ? AND status <> 'pending' AND event_type <> 'ping' ORDER BY id DESC LIMIT ?`).all(webhook.id, n);
  if (recent.length === n && recent.every((r) => r.status === 'failed')) {
    await db.prepare(`UPDATE webhooks SET active = 0, disabled_reason = ? WHERE id = ? AND active = 1`).run(`Switched off after ${n} failed deliveries in a row. Fix the receiver, then switch it on again.`, webhook.id);
    console.warn(`[Webhooks] ${webhook.name} switched off after ${n} failed deliveries in a row`);
  }
}

let delivering = false;
// Sends what is due. A delivery is claimed first (the next try is pushed out two minutes, only one copy wins), so a
// crash mid-send means a retry, never a lost delivery and never two at once.
async function deliverDue({ limit = 20 } = {}) {
  if (delivering) return 0;
  delivering = true;
  try {
    const due = await db.prepare(`
      SELECT d.*, w.url, w.name, w.secret_enc, w.active FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
      WHERE d.status = 'pending' AND d.next_attempt_at <= ? ORDER BY d.next_attempt_at, d.id LIMIT ?
    `).all(nowStr(), limit);
    let sent = 0;
    for (const d of due) {
      const claim = await db.prepare(`UPDATE webhook_deliveries SET next_attempt_at = ? WHERE id = ? AND status = 'pending' AND next_attempt_at = ?`).run(secondsFromNow(120), d.id, d.next_attempt_at);
      if (claim.changes !== 1) continue;
      if (!d.active) { await db.prepare(`UPDATE webhook_deliveries SET status = 'failed', last_error = 'the webhook was switched off' WHERE id = ?`).run(d.id); continue; }
      await attempt(d, { id: d.webhook_id, name: d.name, url: d.url, secret_enc: d.secret_enc }).catch((err) => console.error(`[Webhooks] delivery ${d.id}: ${err.message}`));
      sent++;
    }
    return sent;
  } finally { delivering = false; }
}

// A test message (type "ping") to one webhook, sent now. Resolves { ok, status, error }.
async function sendTest(webhookId) {
  const webhook = await db.prepare('SELECT * FROM webhooks WHERE id = ?').get(webhookId);
  if (!webhook) return null;
  const eventId = `evt_${crypto.randomUUID()}`;
  const payload = JSON.stringify({ id: eventId, type: 'ping', created_at: iso(nowStr()), data: { message: 'This is a test from NovaDesk.', webhook: { id: webhook.id, name: webhook.name } } });
  const info = await db.prepare(`INSERT INTO webhook_deliveries (webhook_id, event_id, event_type, payload, next_attempt_at, attempts) VALUES (?, ?, 'ping', ?, ?, 99) RETURNING id`).run(webhook.id, eventId, payload, secondsFromNow(600));   // not due: the scheduler must not pick a test up
  // attempts starts high so a failed test is final (a test is never retried) and does not count toward switching a webhook off
  const delivery = await db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(info.lastInsertRowid);
  const result = await attempt(delivery, webhook);
  await db.prepare(`UPDATE webhook_deliveries SET attempts = 1 WHERE id = ?`).run(delivery.id);
  return result;
}

async function retryDelivery(id) {
  const done = await db.prepare(`UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL WHERE id = ? AND status = 'failed' AND event_type <> 'ping'`).run(nowStr(), id);
  return done.changes === 1;
}

module.exports = { _testing: { readSecret }, EVENT_TYPES, RECORDS, OPERATIONS, MAX_WEBHOOKS, subscribes, parseEvents, createWebhook, rotateSecret, setActive, buildPayload, dispatchOutbox, deliverDue, sendTest, retryDelivery, allowPrivate };
