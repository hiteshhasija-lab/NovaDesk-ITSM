// Outgoing mail settings of a tenant: stored in the database (table mail_settings, one row per tenant), checked on the way in, and
// turned into the configuration src/mailer.js sends with (the same shape as the server's SMTP_* settings). A tenant whose settings are
// switched off uses the server's, so an installation that set SMTP_* carries on as before. The password is kept encrypted and never given back.
//
// A tenant's administrator chooses the mail server this installation connects to, so (as with single sign-on) the host must not lead to
// a private, local or reserved address, and only the usual mail ports are allowed. MAIL_ALLOW_PRIVATE=true lifts both, for a lab or a
// mail server inside your own network.
'use strict';
const dns = require('dns').promises;
const net = require('net');
const { db, nowStr } = require('./db');
const tenancy = require('./tenancy');
const { encryptSecret, decryptSecret } = require('./mfaCrypto');
const { isPrivateAddress } = require('./webhookNet');

class MailSettingsError extends Error {}
const allowPrivate = () => String(process.env.MAIL_ALLOW_PRIVATE || '').toLowerCase() === 'true';
const PORTS = [25, 465, 587, 2525];

async function checkHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!net.isIP(h) && (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9]){0,1}$/.test(h) || h.length > 253)) throw new MailSettingsError('Enter the mail server\'s host name, for example smtp.example.com.');
  if (allowPrivate()) return h;
  let addresses;
  if (net.isIP(h)) addresses = [{ address: h }];
  else { try { addresses = await dns.lookup(h, { all: true }); } catch { throw new MailSettingsError(`The name ${h} could not be looked up. Check the spelling.`); } }
  if (!addresses.length) throw new MailSettingsError(`The name ${h} has no address.`);
  if (addresses.some((a) => isPrivateAddress(a.address))) throw new MailSettingsError(`${h} points at a private, local or reserved address, which is not allowed (an administrator of the whole installation can allow it with MAIL_ALLOW_PRIVATE).`);
  return h;
}
const address = (text) => { const m = /[^\s<>@"]+@[^\s<>@"]+\.[^\s<>@"]+/.exec(String(text || '')); return m ? m[0] : null; };

const publicRow = (r) => ({
  enabled: Boolean(r && r.enabled), host: (r && r.host) || '', port: (r && r.port) || 587, secure: Boolean(r && r.secure), tlsVerify: r ? Boolean(r.tls_verify) : true,
  username: (r && r.username) || '', hasPassword: Boolean(r && r.password_enc), from: (r && r.from_address) || '', replyTo: (r && r.reply_to) || '', updatedAt: (r && r.updated_at) || null,
});
const row = () => db.prepare('SELECT * FROM mail_settings WHERE tenant_id = nd_tenant()').get();
const get = async () => publicRow(await row());

// (a ticked box sends 'on' and an unticked one sends nothing, so tlsVerify is true only when the box was ticked)
async function validate(body, existing) {
  const b = body || {};
  const enabled = b.enabled === 'on';
  const host = String(b.host || '').trim();
  const port = Number(b.port);
  const user = String(b.username || '').trim();
  const pass = String(b.password || '');
  const from = String(b.from_address || '').replace(/[\r\n]+/g, ' ').trim();
  const replyTo = String(b.reply_to || '').replace(/[\r\n]+/g, ' ').trim();
  if (host || enabled) {
    if (!host) throw new MailSettingsError('Enter the mail server\'s host name.');
    await checkHost(host);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new MailSettingsError('The port must be a number from 1 to 65535 (587 for STARTTLS, 465 for TLS, 25 for a plain relay).');
    if (!allowPrivate() && !PORTS.includes(port)) throw new MailSettingsError(`The port must be one of ${PORTS.join(', ')}.`);
  }
  const havePass = Boolean(pass) || Boolean(existing && existing.password_enc);
  if (enabled && Boolean(user) !== havePass) throw new MailSettingsError('The user name and the password go together: give both, or neither for a server that needs no sign-in.');
  if (enabled && !user && pass) throw new MailSettingsError('A password needs a user name.');
  if (enabled && !address(from)) throw new MailSettingsError('Enter the sender address, for example Acme Help Desk <helpdesk@acme.example>.');
  if (replyTo && !address(replyTo)) throw new MailSettingsError('The reply-to address is not an email address.');
  if ([...from].length > 200 || [...replyTo].length > 200 || user.length > 200 || pass.length > 500) throw new MailSettingsError('One of the values is too long.');
  return { enabled, host: host || null, port: Number.isInteger(port) ? port : null, secure: b.secure === 'on', tlsVerify: b.tls_verify === 'on', user: user || null, pass: pass || null, from: from || null, replyTo: replyTo || null, clearPassword: !user };
}

async function save(v, actor) {
  const before = publicRow(await row());
  const enc = v.pass ? encryptSecret(v.pass) : null;
  await db.prepare(`INSERT INTO mail_settings (enabled, host, port, secure, tls_verify, username, password_enc, from_address, reply_to, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (tenant_id) DO UPDATE SET enabled = EXCLUDED.enabled, host = EXCLUDED.host, port = EXCLUDED.port, secure = EXCLUDED.secure, tls_verify = EXCLUDED.tls_verify,
      username = EXCLUDED.username, password_enc = CASE WHEN EXCLUDED.username IS NULL THEN NULL ELSE COALESCE(EXCLUDED.password_enc, mail_settings.password_enc) END,
      from_address = EXCLUDED.from_address, reply_to = EXCLUDED.reply_to, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`)
    .run(v.enabled ? 1 : 0, v.host, v.port, v.secure ? 1 : 0, v.tlsVerify ? 1 : 0, v.user, enc, v.from, v.replyTo, nowStr(), actor ? actor.id : null);
  invalidate();
  const now = publicRow(await row());
  const parts = [];
  if (before.enabled !== now.enabled) parts.push(now.enabled ? 'switched on' : 'switched off');
  if (before.host !== now.host || before.port !== now.port) parts.push(`server ${before.host || 'none'}:${before.port} -> ${now.host || 'none'}:${now.port}`);
  if (before.secure !== now.secure) parts.push('TLS from the first byte');
  if (before.tlsVerify !== now.tlsVerify) parts.push(now.tlsVerify ? 'certificate checks on' : 'certificate checks OFF');
  if (before.username !== now.username) parts.push('user name');
  if (enc) parts.push('password replaced');
  if (before.from !== now.from) parts.push(`sender ${before.from || 'none'} -> ${now.from || 'none'}`);
  if (before.replyTo !== now.replyTo) parts.push('reply-to');
  return parts.join('; ') || 'saved without changes';
}

// ---- what a message uses
const cache = new Map();
const TTL_MS = 5000;
function invalidate() { cache.delete(tenancy.currentId() || 0); }
async function loadRow() {
  const key = tenancy.currentId() || 0;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await row();
  cache.set(key, { at: Date.now(), value });
  return value;
}
// The tenant's own configuration (the shape of mailConfig in settings.js), or null: use the server's.
async function forTenant() {
  const r = await loadRow();
  if (!r || !r.enabled || !r.host || !r.from_address) return null;
  let pass = '';
  if (r.password_enc) {
    try { pass = decryptSecret(r.password_enc); } catch { console.error('[Mail] the stored mail password cannot be read (SESSION_SECRET or MFA_ENCRYPTION_KEY has changed): save it again under Settings > Email. Using the server\'s mail settings meanwhile.'); return null; }
  }
  return { mode: 'smtp', source: 'tenant', host: r.host, port: r.port || 587, user: r.username || '', pass, from: r.from_address, replyTo: r.reply_to || null, secure: Boolean(r.secure), tlsVerify: Boolean(r.tls_verify) };
}

module.exports = { MailSettingsError, get, validate, save, forTenant, invalidate, checkHost, allowPrivate, address, PORTS };
