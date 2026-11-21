// Warnings before a tenant reaches a usage limit (limits are in src/limits.js, set in the platform console).
//   * Once per level: when use of a limit first reaches 80, 90 and 100 per cent, the workspace's administrators get an email (what is used, what is
//     allowed, what to do). The level is remembered (table limit_warnings) so nothing repeats; it goes back down only after use has fallen 5 points below
//     it, so a workspace hovering around a line is not mailed again and again, and raising a limit starts it afresh.
//   * Every administrator also sees a slim notice on every page from 90 per cent (bannerFor).
//   * The platform console marks the tenants that are close (pctsOfRow, used by the overview).
// Percentages are exact (a megabyte of files is 1048576 bytes), not rounded up: 89.6 per cent is not yet 90.
'use strict';
const { db, nowStr } = require('./db');
const tenancy = require('./tenancy');
const limits = require('./limits');
const { escapeHtml } = require('./helpers');

const LEVELS = [80, 90, 100];
const HYSTERESIS = 5;
const BANNER_FROM = 90;
const LABEL = { users: 'active people', records: 'records', storage: 'attached files' };

// The highest level a percentage has reached, 0 when below the first.
const levelFor = (pct) => (pct === null || pct === undefined ? 0 : LEVELS.filter((l) => pct >= l).pop() || 0);

// What to do about a limit now at `pct`, having last told `last` (0 = nothing yet): { level (to store), send (tell them now) }.
function decide(last, pct) {
  const level = levelFor(pct);
  if (level > last) return { level, send: true };
  if (pct === null || pct === undefined || pct < last - HYSTERESIS) return { level, send: false };     // fallen clearly below (or the limit is gone): start afresh
  return { level: last, send: false };
}

// Exact percentage of each limit, null when there is no limit. A limit of 0 is full.
const pctOf = (used, limit) => (limit === null || limit === undefined ? null : (limit === 0 ? 100 : Math.min(100, (used / limit) * 100)));
function pcts(u) {
  return {
    users: pctOf(u.users.used, u.users.limit),
    records: pctOf(u.records.used, u.records.limit),
    storage: pctOf(u.storage.usedBytes, u.storage.limit === null ? null : u.storage.limit * 1048576),
  };
}
// The same for a row of the platform console's overview (which has the counts and the limits of every tenant).
function pctsOfRow(t) {
  const records = t.incidents + t.requests + t.changes + t.problems + t.cis + t.articles;
  return { users: pctOf(t.active_users, t.limit_users), records: pctOf(records, t.limit_records), storage: pctOf(Number(t.storage_bytes), t.limit_storage_mb === null ? null : t.limit_storage_mb * 1048576) };
}
const nearest = (p) => Object.entries(p).filter(([, v]) => v !== null).sort((a, b) => b[1] - a[1])[0] || null;

const SENTENCE = {
  users: (l) => `${l} active ${l === 1 ? 'person' : 'people'}`,
  records: (l) => `${l} record${l === 1 ? '' : 's'}`,
  storage: (l) => `${l} MB of attached files`,
};
const used = (kind, u) => (kind === 'users' ? u.users.used : (kind === 'records' ? u.records.used : u.storage.usedMb));
const limitOf = (kind, u) => (kind === 'users' ? u.users.limit : (kind === 'records' ? u.records.limit : u.storage.limit));
const todo = {
  users: 'Switch off people who no longer need access, or ask the people who run this service to raise the limit.',
  records: 'Delete what you no longer need, or ask the people who run this service to raise the limit.',
  storage: 'Remove files you no longer need, or ask the people who run this service to raise the limit.',
};

const wholePct = (p) => Math.floor(p);
function words(kind, level, u) {
  const l = limitOf(kind, u); const now = used(kind, u);
  const lead = level >= 100 ? `has reached its limit of ${SENTENCE[kind](l)}: nothing new of this kind can be added until room is made.`
    : `has used ${wholePct(pcts(u)[kind])}% of its limit of ${SENTENCE[kind](l)} (${now} of ${l}).`;
  return { lead, todo: todo[kind] };
}

async function admins() {
  return db.prepare("SELECT id, full_name, email FROM users WHERE role = 'admin' AND active = 1 AND anonymised_at IS NULL AND email IS NOT NULL AND email <> '' ORDER BY id").all();
}

// For the tenant in this context: looks at every limit, tells the administrators about a level newly reached. Resolves [{ kind, level, to, status }] for what it told.
async function sweep({ mailer = require('./mailer'), branding = require('./branding') } = {}) {
  const tenantId = tenancy.currentId();
  const u = await limits.usage(tenantId);
  if (!u) return [];
  const p = pcts(u);
  const told = [];
  for (const kind of limits.KINDS) {
    await db.prepare('INSERT INTO limit_warnings (kind, level) VALUES (?, 0) ON CONFLICT (tenant_id, kind) DO NOTHING').run(kind);
    const row = await db.prepare('SELECT level FROM limit_warnings WHERE kind = ?').get(kind);
    const d = decide(row.level, p[kind]);
    if (d.level === row.level && !d.send) continue;
    // Claimed before it is sent (compare and set), so two servers never tell the same thing twice.
    const claim = await db.prepare('UPDATE limit_warnings SET level = ?, percent = ?, sent_at = CASE WHEN ? THEN ? ELSE sent_at END WHERE kind = ? AND level = ?')
      .run(d.level, p[kind] === null ? null : wholePct(p[kind]), d.send, nowStr(), kind, row.level);
    if (!claim.changes || !d.send) continue;
    const w = words(kind, d.level, u);
    const name = await branding.senderName();
    const to = await admins();
    for (const a of to) {
      const subject = d.level >= 100 ? `${name}: your workspace has reached its limit of ${LABEL[kind]}` : `${name}: your workspace has used ${d.level}% of its limit of ${LABEL[kind]}`;
      const html = `<p>Hi ${escapeHtml(a.full_name)},</p><p>Your workspace ${escapeHtml(w.lead)}</p><p>${escapeHtml(w.todo)}</p><p>You can see what is used on the <em>Plan and usage</em> page in the settings.</p>`;
      let status = 'failed';
      try { const r = await mailer.sendNotificationDetailed({ to: a.email, toName: a.full_name, subject, html, relatedType: 'limit', relatedId: null }); status = r ? r.status : 'failed'; } catch (err) { console.error(`[Limits] the warning could not be sent: ${err.message}`); }
      told.push({ kind, level: d.level, to: a.email, status });
    }
    if (!to.length) told.push({ kind, level: d.level, to: null, status: 'no administrator has an email address' });
  }
  return told;
}

// What every administrator is told on each page: the limits at 90 per cent or more now. Cached for each tenant (a minute; LIMIT_BANNER_CACHE_S, only tests change it),
// and forgotten at once when an operator changes the tenant's limits.
const cache = new Map();
async function bannerFor(tenantId) {
  const hit = cache.get(tenantId);
  const keepMs = (process.env.LIMIT_BANNER_CACHE_S === undefined ? 60 : Number(process.env.LIMIT_BANNER_CACHE_S) || 0) * 1000;
  if (hit && keepMs && Date.now() - hit.at < keepMs) return hit.rows;
  const u = await limits.usage(tenantId);
  const rows = [];
  if (u) {
    const p = pcts(u);
    for (const kind of limits.KINDS) if (p[kind] !== null && p[kind] >= BANNER_FROM) rows.push({ kind, percent: wholePct(p[kind]), full: p[kind] >= 100, text: `${words(kind, p[kind] >= 100 ? 100 : 90, u).lead}` });
  }
  cache.set(tenantId, { at: Date.now(), rows });
  return rows;
}
const forgetBanner = () => cache.clear();

module.exports = { LEVELS, HYSTERESIS, levelFor, decide, pctOf, pcts, pctsOfRow, nearest, words, sweep, bannerFor, forgetBanner };
