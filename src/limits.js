// Usage limits of a tenant (migration 0022): what is used, what is allowed, and how a refusal from the database is told to a person.
// The limits are set by the people who run the installation (the platform console) and enforced by triggers in the database, so this module
// only reads them and words the refusal. A refusal has the error code ND001 and a message like "nd_limit:users:50".
'use strict';
const { db } = require('./db');
const tenancy = require('./tenancy');

const KINDS = ['users', 'records', 'storage'];
const parse = (err) => {
  if (!err || err.code !== 'ND001') return null;
  const m = /nd_limit:(users|records|storage):(\d+)/.exec(String(err.message || ''));
  return m ? { kind: m[1], limit: Number(m[2]) } : null;
};
const isLimitError = (err) => Boolean(parse(err));

const WHAT = {
  users: (n) => `${n} active ${n === 1 ? 'person' : 'people'}`,
  records: (n) => `${n} record${n === 1 ? '' : 's'} (incidents, requests, changes, problems, configuration items and articles together)`,
  storage: (n) => `${n} MB of attached files`,
};
const HINT = {
  users: 'Switch someone off first, or ask the people who run this service to raise the limit.',
  records: 'Delete something you no longer need, or ask the people who run this service to raise the limit.',
  storage: 'Remove a file you no longer need, or ask the people who run this service to raise the limit.',
};
// A sentence for a person.
const sentence = (err) => { const p = parse(err); return p ? `This workspace has reached its limit of ${WHAT[p.kind](p.limit)}. ${HINT[p.kind]}` : null; };
// A short reason for a log line.
const reason = (err) => { const p = parse(err); return p ? `the workspace has reached its limit of ${WHAT[p.kind](p.limit)}` : null; };

// What a tenant uses and is allowed. Counts only (never content). Runs across tenants (platform mode) for the one tenant named.
async function usage(tenantId) {
  const id = Number(tenantId);
  const r = await tenancy.runPlatform(() => db.prepare(`SELECT
      (SELECT COUNT(*) FROM users WHERE tenant_id = ? AND active = 1) AS users,
      (SELECT COUNT(*) FROM users WHERE tenant_id = ?) AS users_all,
      (SELECT COUNT(*) FROM incidents WHERE tenant_id = ?) AS incidents, (SELECT COUNT(*) FROM service_requests WHERE tenant_id = ?) AS requests,
      (SELECT COUNT(*) FROM changes WHERE tenant_id = ?) AS changes, (SELECT COUNT(*) FROM problems WHERE tenant_id = ?) AS problems,
      (SELECT COUNT(*) FROM cmdb_ci WHERE tenant_id = ?) AS cis, (SELECT COUNT(*) FROM kb_articles WHERE tenant_id = ?) AS articles,
      (SELECT COALESCE(SUM(size), 0) FROM attachments WHERE tenant_id = ?) AS storage_bytes,
      t.limit_users, t.limit_records, t.limit_storage_mb FROM tenants t WHERE t.id = ?`).get(id, id, id, id, id, id, id, id, id, id));
  if (!r) return null;
  const records = r.incidents + r.requests + r.changes + r.problems + r.cis + r.articles;
  return {
    users: { used: r.users, all: r.users_all, limit: r.limit_users },
    records: { used: records, limit: r.limit_records, parts: { incidents: r.incidents, requests: r.requests, changes: r.changes, problems: r.problems, 'configuration items': r.cis, articles: r.articles } },
    storage: { usedBytes: Number(r.storage_bytes), usedMb: Math.round(Number(r.storage_bytes) / 1048576 * 10) / 10, limit: r.limit_storage_mb },
  };
}
const percent = (used, limit) => (limit === null || limit === undefined ? null : (limit === 0 ? 100 : Math.min(100, Math.round(used / limit * 100))));

// What an operator typed for the three limits: blank means no limit, otherwise a whole number from 0 to 1 000 000.
function parseLimits(body) {
  const out = {};
  for (const [field, key, label] of [['limit_users', 'users', 'people'], ['limit_records', 'records', 'records'], ['limit_storage_mb', 'storageMb', 'storage']]) {
    const raw = String((body || {})[field] === undefined ? '' : body[field]).trim();
    if (raw === '') { out[key] = null; continue; }
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n > 1000000) throw new Error(`The limit for ${label} must be a whole number from 0 to 1000000, or empty for no limit.`);
    out[key] = n;
  }
  return out;
}

module.exports = { KINDS, parse, isLimitError, sentence, reason, usage, percent, parseLimits };
