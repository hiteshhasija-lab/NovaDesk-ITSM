// Inbound email settings of a tenant: stored in the database (table inbound_settings, one row per tenant), checked on the way in, and turned
// into the configuration the intake works with (src/inbound/process.js: the same shape as the server's INBOUND_* settings). A tenant with no
// settings of its own, other than the default tenant (which keeps using the server's INBOUND_* settings), receives no inbound mail.
//
// Two ways in, each the tenant's own: a mailbox this server reads over IMAP, and an address (POST /api/inbound/email) that a mail system hands
// messages to, protected by a token of the tenant's own. The mailbox is chosen by the tenant's administrator, so (as for outgoing mail) its
// host must not lead to a private, local or reserved address and only the usual IMAP ports are allowed (MAIL_ALLOW_PRIVATE=true lifts both).
'use strict';
const crypto = require('crypto');
const { db, nowStr } = require('./db');
const tenancy = require('./tenancy');
const { encryptSecret, decryptSecret } = require('./mfaCrypto');
const mailSettings = require('./mailSettings');
const { inboundConfig } = require('./settings');

class InboundSettingsError extends Error {}
const PORTS = [143, 993];
const GROUPS = ['IRO-Windows', 'IRO-UNIX', 'IRO-Database', 'IRO-Network/Security', 'IRO-CloudOps', 'IRO-Build/Decom', 'IRO-Backup/Storage', 'IRO-ServiceDesk'];
const list = (t) => String(t || '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
const addr = (t) => /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(String(t || '').trim());
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

const publicRow = (r) => ({
  enabled: Boolean(r && r.enabled), host: (r && r.imap_host) || '', port: (r && r.imap_port) || 993, secure: r ? Boolean(r.imap_secure) : true, tlsVerify: r ? Boolean(r.imap_tls_verify) : true,
  user: (r && r.imap_user) || '', hasPassword: Boolean(r && r.imap_password_enc), folder: (r && r.folder) || '', processedFolder: (r && r.processed_folder) || '',
  pollSeconds: (r && r.poll_seconds) || 60, address: (r && r.address) || '', unknownSenders: (r && r.unknown_senders) || 'create', allowedDomains: (r && r.allowed_domains) || '',
  blockedSenders: (r && r.blocked_senders) || '', maxPerSenderHour: r ? r.max_per_sender_hour : 10, requireAuth: Boolean(r && r.require_auth), assignmentGroup: (r && r.assignment_group) || '',
  hasToken: Boolean(r && r.intake_token_hash), tokenPrefix: (r && r.intake_token_prefix) || '', updatedAt: (r && r.updated_at) || null,
});
const row = () => db.prepare('SELECT * FROM inbound_settings WHERE tenant_id = nd_tenant()').get();
const get = async () => publicRow(await row());

async function validate(body, existing) {
  const b = body || {};
  const enabled = b.enabled === 'on';
  const host = String(b.host || '').trim(); const port = Number(b.port);
  const user = String(b.user || '').trim(); const pass = String(b.password || '');
  const folder = String(b.folder || '').trim(); const processed = String(b.processed_folder || '').trim();
  const poll = Number(b.poll_seconds || 60); const address = String(b.address || '').trim().toLowerCase();
  const unknown = String(b.unknown_senders || 'create'); const domains = list(b.allowed_domains); const blocked = list(b.blocked_senders);
  const max = b.max_per_sender_hour === undefined || b.max_per_sender_hour === '' ? 10 : Number(b.max_per_sender_hour);
  const group = String(b.assignment_group || '').trim();
  if (host || enabled) {
    if (!host) throw new InboundSettingsError('Enter the mailbox server\'s host name, for example imap.example.com.');
    try { await mailSettings.checkHost(host); } catch (e) { if (e instanceof mailSettings.MailSettingsError) throw new InboundSettingsError(e.message.replace('mail server', 'mailbox server')); throw e; }
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new InboundSettingsError('The port must be a number (993 for TLS, 143 for STARTTLS).');
    if (!mailSettings.allowPrivate() && !PORTS.includes(port)) throw new InboundSettingsError(`The port must be ${PORTS.join(' or ')}.`);
  }
  const havePass = Boolean(pass) || Boolean(existing && existing.imap_password_enc);
  if (enabled && (!user || !havePass)) throw new InboundSettingsError('Enter the mailbox\'s user name and password.');
  if (!Number.isInteger(poll) || poll < 10 || poll > 3600) throw new InboundSettingsError('The mailbox is looked at every 10 to 3600 seconds.');
  if (address && !addr(address)) throw new InboundSettingsError('The help desk address must be an email address such as helpdesk@example.com.');
  if (!['create', 'ignore'].includes(unknown)) throw new InboundSettingsError('Choose what to do with a sender who has no account: make a contact, or ignore.');
  for (const d of domains) if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9]){0,1}\.[a-z]{2,}$/.test(d)) throw new InboundSettingsError(`"${d}" is not an email domain (for example example.com).`);
  if (!Number.isInteger(max) || max < 0 || max > 10000) throw new InboundSettingsError('Messages per sender per hour: a number from 0 (no limit) to 10000.');
  if (group && !GROUPS.includes(group)) throw new InboundSettingsError('Choose one of the assignment groups.');
  if ([...folder].length > 100 || [...processed].length > 100 || user.length > 200 || pass.length > 500) throw new InboundSettingsError('One of the values is too long.');
  return { enabled, host: host || null, port: Number.isInteger(port) ? port : null, secure: b.secure === 'on', tlsVerify: b.tls_verify === 'on', user: user || null, pass: pass || null,
    folder: folder || null, processed: processed || null, poll, address: address || null, unknown, domains: domains.join(', ') || null, blocked: blocked.join(', ') || null, max, requireAuth: b.require_auth === 'on', group: group || null };
}

async function save(v, actor) {
  const before = publicRow(await row());
  const enc = v.pass ? encryptSecret(v.pass) : null;
  await db.prepare(`INSERT INTO inbound_settings (enabled, imap_host, imap_port, imap_secure, imap_tls_verify, imap_user, imap_password_enc, folder, processed_folder, poll_seconds, address,
      unknown_senders, allowed_domains, blocked_senders, max_per_sender_hour, require_auth, assignment_group, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (tenant_id) DO UPDATE SET enabled = EXCLUDED.enabled, imap_host = EXCLUDED.imap_host, imap_port = EXCLUDED.imap_port, imap_secure = EXCLUDED.imap_secure,
      imap_tls_verify = EXCLUDED.imap_tls_verify, imap_user = EXCLUDED.imap_user, imap_password_enc = CASE WHEN EXCLUDED.imap_user IS NULL THEN NULL ELSE COALESCE(EXCLUDED.imap_password_enc, inbound_settings.imap_password_enc) END,
      folder = EXCLUDED.folder, processed_folder = EXCLUDED.processed_folder, poll_seconds = EXCLUDED.poll_seconds, address = EXCLUDED.address, unknown_senders = EXCLUDED.unknown_senders,
      allowed_domains = EXCLUDED.allowed_domains, blocked_senders = EXCLUDED.blocked_senders, max_per_sender_hour = EXCLUDED.max_per_sender_hour, require_auth = EXCLUDED.require_auth,
      assignment_group = EXCLUDED.assignment_group, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`)
    .run(v.enabled ? 1 : 0, v.host, v.port, v.secure ? 1 : 0, v.tlsVerify ? 1 : 0, v.user, enc, v.folder, v.processed, v.poll, v.address, v.unknown, v.domains, v.blocked, v.max, v.requireAuth ? 1 : 0, v.group, nowStr(), actor ? actor.id : null);
  invalidate();
  const now = publicRow(await row());
  const parts = [];
  if (before.enabled !== now.enabled) parts.push(now.enabled ? 'mailbox switched on' : 'mailbox switched off');
  if (before.host !== now.host || before.port !== now.port) parts.push(`mailbox ${before.host || 'none'}:${before.port} -> ${now.host || 'none'}:${now.port}`);
  if (before.user !== now.user) parts.push('mailbox user name');
  if (enc) parts.push('mailbox password replaced');
  for (const [k, label] of [['secure', 'TLS from the first byte'], ['tlsVerify', 'certificate checks'], ['folder', 'folder'], ['processedFolder', 'processed folder'], ['pollSeconds', 'look interval'], ['address', 'help desk address'], ['unknownSenders', 'unknown senders'], ['allowedDomains', 'allowed domains'], ['blockedSenders', 'blocked senders'], ['maxPerSenderHour', 'per-sender limit'], ['requireAuth', 'require sender authentication'], ['assignmentGroup', 'assignment group']]) if (before[k] !== now[k]) parts.push(label);
  return parts.join('; ') || 'saved without changes';
}

// ---- the token for the HTTP address
async function createToken(actor) {
  const token = `ndi_${crypto.randomBytes(30).toString('base64url')}`;
  await db.prepare(`INSERT INTO inbound_settings (intake_token_hash, intake_token_prefix, updated_at, updated_by) VALUES (?, ?, ?, ?)
    ON CONFLICT (tenant_id) DO UPDATE SET intake_token_hash = EXCLUDED.intake_token_hash, intake_token_prefix = EXCLUDED.intake_token_prefix, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`)
    .run(hashToken(token), token.slice(0, 8), nowStr(), actor ? actor.id : null);
  invalidate();
  return token;
}
async function revokeToken(actor) {
  const done = await db.prepare('UPDATE inbound_settings SET intake_token_hash = NULL, intake_token_prefix = NULL, updated_at = ?, updated_by = ? WHERE tenant_id = nd_tenant() AND intake_token_hash IS NOT NULL').run(nowStr(), actor ? actor.id : null);
  invalidate();
  return done.changes === 1;
}
// Which tenant a token belongs to (across tenants: the token is how the request finds its tenant), or null.
async function tenantOfToken(token) {
  if (!/^ndi_[A-Za-z0-9_-]{40}$/.test(String(token || ''))) return null;
  const r = await tenancy.runPlatform(() => db.prepare('SELECT tenant_id FROM inbound_settings WHERE intake_token_hash = ?').get(hashToken(token)));
  return r ? r.tenant_id : null;
}
// Is there any token or mailbox at all? (With none anywhere the HTTP address does not exist: nothing to probe.)
let anyAt = 0; let anyVal = false;
async function anyTenantToken() {
  if (Date.now() - anyAt < 5000) return anyVal;
  anyVal = Number((await tenancy.runPlatform(() => db.prepare('SELECT COUNT(*) AS c FROM inbound_settings WHERE intake_token_hash IS NOT NULL').get())).c) > 0;
  anyAt = Date.now();
  return anyVal;
}

// ---- what the intake uses
const cache = new Map();
const TTL_MS = 5000;
function invalidate() { cache.delete(tenancy.currentId() || 0); anyAt = 0; }
async function loadRow() {
  const key = tenancy.currentId() || 0;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await row();
  cache.set(key, { at: Date.now(), value });
  return value;
}
// An environment in the shape inboundConfig() reads, so everything downstream (the rules, the intake) works unchanged.
function envFor(r) {
  const env = { INBOUND_LOG_DAYS: process.env.INBOUND_LOG_DAYS, INBOUND_MAX_MESSAGE_MB: process.env.INBOUND_MAX_MESSAGE_MB };
  if (r.enabled && r.imap_host) {
    let pass = '';
    try { pass = r.imap_password_enc ? decryptSecret(r.imap_password_enc) : ''; } catch { console.error('[Inbound] the stored mailbox password cannot be read (SESSION_SECRET or MFA_ENCRYPTION_KEY has changed): save it again under Settings > Inbound email.'); return null; }
    Object.assign(env, { INBOUND_IMAP_HOST: r.imap_host, INBOUND_IMAP_PORT: String(r.imap_port || 993), INBOUND_IMAP_USER: r.imap_user || '', INBOUND_IMAP_PASSWORD: pass,
      INBOUND_IMAP_SECURE: r.imap_secure ? 'true' : 'false', INBOUND_IMAP_TLS_VERIFY: r.imap_tls_verify ? 'true' : 'false', INBOUND_FOLDER: r.folder || 'INBOX', INBOUND_PROCESSED_FOLDER: r.processed_folder || '', INBOUND_POLL_SECONDS: String(r.poll_seconds) });
  }
  Object.assign(env, { INBOUND_ADDRESS: r.address || '', INBOUND_UNKNOWN_SENDERS: r.unknown_senders, INBOUND_ALLOWED_DOMAINS: r.allowed_domains || '', INBOUND_BLOCKED_SENDERS: r.blocked_senders || '',
    INBOUND_MAX_PER_SENDER_HOUR: String(r.max_per_sender_hour), INBOUND_REQUIRE_AUTH: r.require_auth ? 'true' : 'false', INBOUND_ASSIGNMENT_GROUP: r.assignment_group || '' });
  // so the tenant's own sender address is recognised as "this help desk itself" (no loops)
  return env;
}
// { cfg, env, mailbox } for this tenant's own settings, or null (then: the default tenant uses the server's; the others receive nothing).
async function forTenant() {
  const r = await loadRow();
  if (!r || (!(r.enabled && r.imap_host) && !r.intake_token_hash)) return null;
  const env = envFor(r);
  if (!env) return null;
  const mail = await mailSettings.forTenant();
  if (mail && mail.from) { env.SMTP_HOST = mail.host; env.SMTP_FROM = mail.from; env.SMTP_PORT = String(mail.port); if (mail.user) { env.SMTP_USER = mail.user; env.SMTP_PASSWORD = mail.pass || 'x'; } }
  let cfg;
  try { cfg = inboundConfig(env); } catch (err) { console.error(`[Inbound] this tenant's settings are not usable: ${err.message}`); return null; }
  return { cfg, env, mailbox: Boolean(cfg.imap) };
}
const mailboxEnabled = async () => { const r = await loadRow(); return Boolean(r && r.enabled && r.imap_host); };

module.exports = { InboundSettingsError, GROUPS, PORTS, get, validate, save, createToken, revokeToken, tenantOfToken, anyTenantToken, forTenant, mailboxEnabled, invalidate, hashToken };
