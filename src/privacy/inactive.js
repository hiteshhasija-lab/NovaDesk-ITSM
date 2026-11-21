// Anonymising accounts that have been switched off for a long time, by itself (the rule is off until an administrator sets it).
//
// "Inactive" here is what the Users page calls inactive: the account is switched off. How long it has been off is
// users.deactivated_at, kept by the database (migration 0023), and switching the account on again starts afresh. Accounts
// that are switched on are never touched, whatever they last did. The rule is a number of days (30 at least), kept in
// retention_rules under the target 'inactive_accounts' so it is per tenant like the other privacy limits.
//
// What happens to a person is exactly what an administrator's "Anonymise" does (src/privacy/anonymise.js), with the
// comments and uploaded files kept (those need a person's decision; the page for the person can still blank them
// before the day). It cannot be undone, so the page shows who is next, and on what day, well before it happens.
'use strict';
const { db, nowStr, offsetStr } = require('../db');
const { audit } = require('../audit');
const { anonymise, PrivacyError } = require('./anonymise');
const retention = require('./retention');

const TARGET = 'inactive_accounts';
const BATCH = 200;                      // people per run; the next run carries on

// "" is off; otherwise a whole number of days in range. Returns { days } or { error }.
function parseDays(value) {
  const s = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  if (s === '' || s === 'off' || s === 'never') return { days: null };
  if (!/^\d+$/.test(s)) return { error: 'Use a whole number of days, or leave it empty to turn this off.' };
  const n = Number(s);
  if (n < retention.MIN_DAYS) return { error: `At least ${retention.MIN_DAYS} days.` };
  if (n > retention.MAX_DAYS) return { error: `At most ${retention.MAX_DAYS} days (ten years); leave it empty to turn this off.` };
  return { days: n };
}

async function rule() {
  const r = await db.prepare('SELECT keep_days, last_run_at, last_removed FROM retention_rules WHERE target = ?').get(TARGET);
  return { days: r && r.keep_days ? r.keep_days : null, lastRunAt: r ? r.last_run_at : null, lastCount: r && r.last_removed !== null ? r.last_removed : null };
}

const addDays = (text, days) => new Date(new Date(`${text.replace(' ', 'T')}Z`).getTime() + days * 86400000).toISOString().slice(0, 10);

// Who is switched off and not yet anonymised, longest-off first, with the day each would be anonymised (when a rule is set).
async function waiting(days, limit = 25) {
  const rows = await db.prepare(`SELECT id, username, full_name, email, role, deactivated_at FROM users
      WHERE active = 0 AND anonymised_at IS NULL AND deactivated_at IS NOT NULL ORDER BY deactivated_at, id LIMIT ?`).all(limit);
  const total = Number((await db.prepare('SELECT COUNT(*) AS c FROM users WHERE active = 0 AND anonymised_at IS NULL AND deactivated_at IS NOT NULL').get()).c);
  const cutoff = days ? retention.cutoffFor(days) : null;
  const due = cutoff ? Number((await db.prepare('SELECT COUNT(*) AS c FROM users WHERE active = 0 AND anonymised_at IS NULL AND deactivated_at IS NOT NULL AND deactivated_at < ?').get(cutoff)).c) : 0;
  return { total, due, people: rows.map((p) => ({ ...p, on: days ? addDays(p.deactivated_at, days) : null, overdue: Boolean(cutoff && p.deactivated_at < cutoff) })) };
}

async function save(input, { actor, req }) {
  const p = parseDays(input);
  if (p.error) return { error: p.error };
  const was = await rule();
  if (was.days === p.days) return { changed: false };
  await db.prepare(`INSERT INTO retention_rules (target, keep_days) VALUES (?, ?) ON CONFLICT (tenant_id, target) DO UPDATE SET keep_days = EXCLUDED.keep_days`).run(TARGET, p.days);
  await audit(req, actor, 'retention.inactive_accounts_changed', { detail: `Inactive accounts: ${was.days ? `anonymised after ${was.days} days off` : 'not anonymised'} to ${p.days ? `anonymised after ${p.days} days off` : 'not anonymised'}` });
  return { changed: true };
}

// Anonymises the people who have been off for longer than the rule. The daily run only goes once in 23 hours;
// `manual` (an administrator pressing the button) goes now. Resolves { ran, anonymised, skipped } (ran: false when it was not its time).
async function sweep({ manual = false, actor = null, req = null } = {}) {
  const r = await rule();
  if (!r.days) return { ran: false, anonymised: 0, skipped: 0 };
  // Claimed before it is done, so two servers (or the button and the timer) never run it at once.
  const claim = await db.prepare('UPDATE retention_rules SET last_run_at = ? WHERE target = ? AND keep_days IS NOT NULL AND (? OR last_run_at IS NULL OR last_run_at < ?)')
    .run(nowStr(), TARGET, manual, offsetStr(0, -23));
  if (!claim.changes) return { ran: false, anonymised: 0, skipped: 0 };
  const cutoff = retention.cutoffFor(r.days);
  const due = await db.prepare(`SELECT id FROM users WHERE active = 0 AND anonymised_at IS NULL AND deactivated_at IS NOT NULL AND deactivated_at < ? ORDER BY deactivated_at, id LIMIT ${BATCH}`).all(cutoff);
  let anonymised = 0; let skipped = 0;
  for (const p of due) {
    try {
      // Re-checked just before, in one statement: someone switched on a moment ago must not be anonymised.
      const still = await db.prepare('SELECT 1 AS ok FROM users WHERE id = ? AND active = 0 AND anonymised_at IS NULL AND deactivated_at < ?').get(p.id, cutoff);
      if (!still) { skipped += 1; continue; }
      await anonymise(p.id, { actor, req });
      anonymised += 1;
    } catch (err) {
      skipped += 1;
      if (!(err instanceof PrivacyError)) console.error(`[Privacy] could not anonymise user ${p.id}: ${err.message}`);
    }
  }
  await db.prepare('UPDATE retention_rules SET last_removed = ? WHERE target = ?').run(anonymised, TARGET);
  if (anonymised || skipped || manual) {
    await audit(req, actor, 'privacy.inactive_swept', { detail: `${manual ? 'run by an administrator' : 'daily'}: ${anonymised} account${anonymised === 1 ? '' : 's'} anonymised (off for more than ${r.days} days)${skipped ? `, ${skipped} left alone` : ''}` });
  }
  return { ran: true, anonymised, skipped };
}

module.exports = { TARGET, parseDays, rule, waiting, save, sweep, addDays };
