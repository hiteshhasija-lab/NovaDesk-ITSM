// How long logs and messages are kept. Every kind starts as "keep for ever"; an administrator can set a number of days
// (30 at the least) for each. Once a day NovaDesk removes what is older, in small batches, and records what it removed.
// Tickets, comments and the history on them are never removed here: that is the work record, not a log.
'use strict';
const { db, nowStr, offsetStr } = require('../db');
const { audit } = require('../audit');

const MIN_DAYS = 30;
const MAX_DAYS = 3650;
const BATCH = 5000;
const MAX_BATCHES = 200;       // 1,000,000 rows in one run; the next day's run carries on

// target id, what it is, the table and age column, and a condition that keeps unfinished work out of reach.
const TARGETS = [
  { id: 'audit_log', label: 'Audit log', table: 'audit_log', age: 'at', where: '1=1',
    help: 'Who signed in and what was changed. Many security standards ask for a year or more, so think before shortening this.' },
  { id: 'notifications', label: 'Email notices', table: 'notifications', age: 'created_at', where: '1=1',
    help: 'The record of every email NovaDesk sent, with the address and the text. A reply to a notice older than this is matched to its ticket by the ticket number in the subject instead.' },
  { id: 'inbound_emails', label: 'Inbound email record', table: 'inbound_emails', age: 'received_at', where: "outcome <> 'processing'",
    help: 'What became of each message read from the help desk mailbox. Keep it longer than mail stays in the mailbox, so a message is never handled twice.' },
  { id: 'webhook_deliveries', label: 'Webhook deliveries', table: 'webhook_deliveries', age: 'created_at', where: "status IN ('delivered', 'failed')",
    help: 'The copy of each event sent to a receiver, with its payload. Deliveries still waiting are never removed.' },
];
const BY_ID = Object.fromEntries(TARGETS.map((t) => [t.id, t]));

// "" or "forever" is no limit; otherwise a whole number of days in range. Returns { days } or { error }.
function parseDays(value) {
  const s = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  if (s === '' || s === 'forever') return { days: null };
  if (!/^\d+$/.test(s)) return { error: 'Use a whole number of days, or leave it empty to keep everything.' };
  const n = Number(s);
  if (n < MIN_DAYS) return { error: `At least ${MIN_DAYS} days.` };
  if (n > MAX_DAYS) return { error: `At most ${MAX_DAYS} days (ten years); leave it empty to keep everything.` };
  return { days: n };
}

// The oldest timestamp that is kept, as the app's text format.
const cutoffFor = (days, nowMs = Date.now()) => new Date(nowMs - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');

async function rules() {
  const stored = Object.fromEntries((await db.prepare('SELECT * FROM retention_rules').all()).map((r) => [r.target, r]));
  const out = [];
  for (const t of TARGETS) {
    const r = stored[t.id] || {};
    const days = r.keep_days || null;
    const total = Number((await db.prepare(`SELECT COUNT(*) AS c FROM ${t.table}`).get()).c);
    const due = days ? Number((await db.prepare(`SELECT COUNT(*) AS c FROM ${t.table} WHERE ${t.age} < ? AND ${t.where}`).get(cutoffFor(days))).c) : 0;
    out.push({ ...t, days, total, due, lastRunAt: r.last_run_at || null, lastRemoved: r.last_removed === undefined ? null : r.last_removed });
  }
  return out;
}

// Saves the days for each target; `submitted` is { audit_log: '365', ... }. Returns { errors: {id: msg}, changed: [...] }.
async function save(submitted, { actor, req }) {
  const errors = {}; const wanted = {};
  for (const t of TARGETS) {
    const p = parseDays(submitted[t.id]);
    if (p.error) errors[t.id] = p.error; else wanted[t.id] = p.days;
  }
  if (Object.keys(errors).length) return { errors, changed: [] };
  const was = Object.fromEntries((await db.prepare('SELECT target, keep_days FROM retention_rules').all()).map((r) => [r.target, r.keep_days]));
  const changed = [];
  // All the limits change together: a sweep that starts in the middle must not see some of them new and some old.
  await db.transaction(async (tx) => {
    for (const t of TARGETS) {
      const before = was[t.id] || null;
      if (before === wanted[t.id]) continue;
      await tx.prepare(`INSERT INTO retention_rules (target, keep_days) VALUES (?, ?) ON CONFLICT (target) DO UPDATE SET keep_days = EXCLUDED.keep_days`).run(t.id, wanted[t.id]);
      changed.push(`${t.label}: ${before ? before + ' days' : 'kept for ever'} to ${wanted[t.id] ? wanted[t.id] + ' days' : 'kept for ever'}`);
    }
  });
  if (changed.length) await audit(req, actor, 'retention.changed', { detail: changed.join('; ') });
  return { errors: {}, changed };
}

async function removeOld(target, days) {
  const cutoff = cutoffFor(days);
  let removed = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const r = await db.prepare(`DELETE FROM ${target.table} WHERE ctid IN (SELECT ctid FROM ${target.table} WHERE ${target.age} < ? AND ${target.where} LIMIT ${BATCH})`).run(cutoff);
    removed += r.changes || 0;
    if ((r.changes || 0) < BATCH) break;
  }
  return removed;
}

// Removes what is past its time. `manual` (an administrator pressing the button) runs every kind that has a limit now;
// the daily run only the kinds not done in the last 23 hours. Returns [{ id, label, days, removed }] for the kinds it ran.
async function sweep({ manual = false, actor = null, req = null } = {}) {
  const ran = [];
  for (const t of TARGETS) {
    const r = await db.prepare('SELECT keep_days FROM retention_rules WHERE target = ?').get(t.id);
    if (!r || !r.keep_days) continue;
    // Claimed before it is done, so two servers (or a button and the timer) never run the same kind at once.
    const claim = await db.prepare(`UPDATE retention_rules SET last_run_at = ? WHERE target = ? AND keep_days IS NOT NULL AND (? OR last_run_at IS NULL OR last_run_at < ?)`)
      .run(nowStr(), t.id, manual, offsetStr(0, -23));
    if (!claim.changes) continue;
    const removed = await removeOld(t, r.keep_days);
    await db.prepare('UPDATE retention_rules SET last_removed = ? WHERE target = ?').run(removed, t.id);
    ran.push({ id: t.id, label: t.label, days: r.keep_days, removed });
  }
  // Written after the sweep, so a sweep of the audit log never removes its own record.
  const did = ran.filter((r) => r.removed > 0);
  if (did.length || (manual && ran.length)) {
    await audit(req, actor, 'retention.swept', { detail: `${manual ? 'run by an administrator' : 'daily'}: ${ran.map((r) => `${r.label} ${r.removed} removed (kept ${r.days} days)`).join('; ')}` });
  }
  return ran;
}

module.exports = { TARGETS, BY_ID, MIN_DAYS, MAX_DAYS, parseDays, cutoffFor, rules, save, sweep };
