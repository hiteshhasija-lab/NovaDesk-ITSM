// The platform console's own machinery: who the operators are, how they sign in, and what is recorded. The operators are the
// people who run the installation; they are not members of any tenant, and the console exists only on its own host name
// (PLATFORM_HOST). Everything here looks across tenants, so it runs in platform mode (src/tenancy.js).
//
//   PLATFORM_HOST              the host name of the console, for example ops.helpdesk.example.com; unset = no console at all
//   PLATFORM_ALLOWED_IPS       optional: addresses (1.2.3.4) or IPv4 ranges (10.0.0.0/8) that may reach it; others get a 404
//   PLATFORM_ADMIN_USERNAME    with PLATFORM_ADMIN_PASSWORD: the first operator, made at start-up when there is none yet
//   PLATFORM_ADMIN_PASSWORD
// Signing in is by a signed cookie that carries no data of its own except who, until when, and the page token (nothing is kept
// on the server), so the console needs no session table and nothing about it is in any tenant.
'use strict';
const crypto = require('crypto');
const { db, nowStr } = require('./db');
const tenancy = require('./tenancy');
const { checkPassword, hashPassword, verifyPassword, verifyAgainstNobody } = require('./passwords');
const { sessionSecret } = require('./settings');

const COOKIE = 'nd_platform';
const LOGIN_COOKIE = 'nd_platform_login';
const LIFETIME_MS = 2 * 60 * 60 * 1000;
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60 * 1000;
class PlatformError extends Error {}

const P = (fn) => tenancy.runPlatform(fn);

function config(env = process.env) {
  const host = String(env.PLATFORM_HOST || '').trim().toLowerCase().replace(/\.$/, '');
  if (host && !/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9]){0,1}$/.test(host)) throw new Error('PLATFORM_HOST must be a host name, for example ops.helpdesk.example.com.');
  const ips = String(env.PLATFORM_ALLOWED_IPS || '').split(',').map((x) => x.trim()).filter(Boolean);
  for (const ip of ips) if (!parseRule(ip)) throw new Error(`PLATFORM_ALLOWED_IPS: "${ip}" is not an address or an IPv4 range such as 10.0.0.0/8.`);
  const user = String(env.PLATFORM_ADMIN_USERNAME || '').trim().toLowerCase(); const pass = env.PLATFORM_ADMIN_PASSWORD || '';
  if (Boolean(user) !== Boolean(pass)) throw new Error('PLATFORM_ADMIN_USERNAME and PLATFORM_ADMIN_PASSWORD go together: set both, or neither.');
  if ((user || ips.length) && !host) throw new Error('PLATFORM_ADMIN_* and PLATFORM_ALLOWED_IPS need PLATFORM_HOST (the console has no address without it).');
  return { enabled: Boolean(host), host, allowedIps: ips, bootstrap: user ? { username: user, password: pass } : null };
}

// ---- who may reach it
const v4 = (s) => { const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s); if (!m) return null; const o = m.slice(1).map(Number); return o.some((n) => n > 255) ? null : ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3]; };
function parseRule(rule) {
  const [addr, bits] = String(rule).split('/');
  if (bits === undefined) return v4(addr) !== null || /^[0-9a-f:]+$/i.test(addr) ? { exact: addr.toLowerCase() } : null;
  const base = v4(addr); const n = Number(bits);
  if (base === null || !Number.isInteger(n) || n < 0 || n > 32) return null;
  const mask = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
}
function ipAllowed(ip, rules) {
  if (!rules.length) return true;
  const addr = String(ip || '').toLowerCase().replace(/^::ffff:/, '');
  const n = v4(addr);
  return rules.some((r) => { const p = parseRule(r); return p && (p.exact !== undefined ? p.exact === addr : n !== null && ((n & p.mask) >>> 0) === p.base); });
}

// ---- the signed cookie
const key = (env = process.env) => crypto.createHash('sha256').update(`platform-console:${sessionSecret(env)}`).digest();
const b64 = (b) => Buffer.from(b).toString('base64url');
function sign(payload, env = process.env) {
  const body = b64(JSON.stringify(payload));
  return `${body}.${crypto.createHmac('sha256', key(env)).update(body).digest('base64url')}`;
}
function verify(token, env = process.env, now = Date.now()) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', key(env)).update(body).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p && p.e > now ? p : null; } catch { return null; }
}
const newToken = () => crypto.randomBytes(24).toString('base64url');
const same = (a, b) => { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y); };
const sessionCookie = (operator, env) => sign({ o: operator.id, e: Date.now() + LIFETIME_MS, c: newToken() }, env);
const readCookies = (req) => Object.fromEntries(String(req.get('cookie') || '').split(';').map((c) => c.trim().split(/=(.*)/s).slice(0, 2)).filter(([k]) => k));

// ---- operators
const findById = (id) => P(() => db.prepare('SELECT id, username, full_name FROM platform_admins WHERE id = ?').get(id));
async function createOperator({ username, password, fullName }) {
  const name = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,40}$/.test(name)) throw new PlatformError('The username must be 2 to 40 lower-case letters, digits, dots, hyphens or underscores.');
  const weak = checkPassword(password || '', { username: name, fullName });
  if (weak) throw new PlatformError(weak);
  return P(async () => {
    if (await db.prepare('SELECT 1 AS x FROM platform_admins WHERE username = ?').get(name)) throw new PlatformError(`There is already an operator called "${name}".`);
    return (await db.prepare('INSERT INTO platform_admins (username, password_hash, full_name) VALUES (?, ?, ?) RETURNING id').get(name, await hashPassword(password), String(fullName || name).trim())).id;
  });
}
// The first operator, from the settings, when there is none: like ADMIN_USERNAME for a tenant. Never changes an existing operator.
async function bootstrap(cfg) {
  if (!cfg.enabled || !cfg.bootstrap) return null;
  const n = Number((await P(() => db.prepare('SELECT COUNT(*) AS c FROM platform_admins').get())).c);
  if (n > 0) return null;
  try { const id = await createOperator({ ...cfg.bootstrap, fullName: cfg.bootstrap.username }); console.log(`Platform console: made the first operator "${cfg.bootstrap.username}" from PLATFORM_ADMIN_USERNAME/PASSWORD.`); return id; }
  catch (err) { console.warn(`[Platform] the first operator was not made: ${err.message}`); return null; }
}
// { operator } or { error: 'invalid' | 'locked' }. An unknown name takes as long to refuse as a wrong password.
async function login(username, password) {
  const name = String(username || '').trim().toLowerCase();
  const row = await P(() => db.prepare('SELECT * FROM platform_admins WHERE username = ?').get(name));
  if (!row) { await verifyAgainstNobody(password); return { error: 'invalid' }; }
  if (row.locked_until && new Date(row.locked_until.replace(' ', 'T') + 'Z').getTime() > Date.now()) { await verifyAgainstNobody(password); return { error: 'locked' }; }
  if (!(await verifyPassword(password, row.password_hash))) {
    const f = await P(() => db.prepare('UPDATE platform_admins SET failed_logins = failed_logins + 1 WHERE id = ? RETURNING failed_logins').get(row.id));
    if (f.failed_logins >= LOCK_AFTER) await P(() => db.prepare('UPDATE platform_admins SET locked_until = ?, failed_logins = 0 WHERE id = ?').run(new Date(Date.now() + LOCK_MS).toISOString().slice(0, 19).replace('T', ' '), row.id));
    return { error: 'invalid' };
  }
  await P(() => db.prepare('UPDATE platform_admins SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').run(nowStr(), row.id));
  return { operator: { id: row.id, username: row.username, full_name: row.full_name } };
}

// ---- the record
async function audit(req, operator, action, { tenant = null, detail = null } = {}) {
  try {
    await P(() => db.prepare('INSERT INTO platform_audit (operator, action, tenant_id, tenant_slug, detail, ip) VALUES (?, ?, ?, ?, ?, ?)')
      .run(operator ? operator.username : null, action, tenant ? tenant.id : null, tenant ? tenant.slug : null, detail ? String(detail).slice(0, 500) : null, req && req.ip ? String(req.ip).slice(0, 64) : null));
  } catch (err) { console.error(`[Platform] could not record ${action}: ${err.message}`); }
}
const recentAudit = (limit = 50, tenantId = null) => P(() => (tenantId
  ? db.prepare('SELECT * FROM platform_audit WHERE tenant_id = ? ORDER BY id DESC LIMIT ?').all(tenantId, limit)
  : db.prepare('SELECT * FROM platform_audit ORDER BY id DESC LIMIT ?').all(limit)));

// ---- what the overview shows: every tenant with what it holds (counts only, never content)
async function overview() {
  return P(async () => {
    const tenants = await db.prepare(`SELECT t.id, t.slug, t.name, t.status, t.created_at,
        (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id) AS users,
        (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id AND u.active = 1) AS active_users,
        (SELECT COUNT(*) FROM incidents i WHERE i.tenant_id = t.id) AS incidents,
        (SELECT COUNT(*) FROM service_requests r WHERE r.tenant_id = t.id) AS requests,
        (SELECT COUNT(*) FROM changes c WHERE c.tenant_id = t.id) AS changes,
        (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.tenant_id = t.id) AS last_seen
      FROM tenants t ORDER BY t.id`).all();
    const hosts = await db.prepare('SELECT host, tenant_id FROM tenant_hosts ORDER BY host').all();
    return tenants.map((t) => ({ ...t, hosts: hosts.filter((h) => h.tenant_id === t.id).map((h) => h.host) }));
  });
}

module.exports = {
  COOKIE, LOGIN_COOKIE, LIFETIME_MS, PlatformError, config, ipAllowed, parseRule, sign, verify, newToken, same, sessionCookie, readCookies,
  findById, createOperator, bootstrap, login, audit, recentAudit, overview,
};
