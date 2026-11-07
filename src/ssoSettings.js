// Single sign-on settings of a tenant: stored in the database (table sso_settings, one row per tenant), checked on the way in, and
// turned into the configuration src/oidc.js works with. The client secret is kept encrypted and is never given back.
//
// Which settings apply to a request: the tenant's own, when switched on; otherwise, for the DEFAULT tenant only, the server's
// OIDC_* settings (so an installation that set those carries on as before); otherwise none. The address the provider sends people
// back to is the tenant's own host name, so each tenant registers its own address with its provider.
//
// The tenant's administrator chooses the provider's address, so this server would otherwise fetch whatever address a tenant names.
// Addresses must be https and must not lead to private, local or reserved addresses (SSO_ALLOW_PRIVATE=true lifts that, for a lab
// or a provider inside your own network).
'use strict';
const { db, nowStr } = require('./db');
const tenancy = require('./tenancy');
const { encryptSecret, decryptSecret } = require('./mfaCrypto');
const net = require('./webhookNet');
const { authPolicy } = require('./settings');

class SsoSettingsError extends Error {}
const envConfig = () => authPolicy(process.env).oidc;
const allowPrivate = () => String(process.env.SSO_ALLOW_PRIVATE || '').toLowerCase() === 'true';

// Throws SsoSettingsError with a sentence unless this address may be fetched.
async function checkAddress(value, what) {
  try { await net.checkTarget(value, { allowPrivate: allowPrivate() }); } catch (err) {
    if (!(err instanceof net.WebhookUrlError)) throw err;
    const m = err.message;
    if (/private, local or reserved/.test(m)) throw new SsoSettingsError(`${what} points at a private, local or reserved address, which is not allowed (an administrator of the whole installation can allow it with SSO_ALLOW_PRIVATE).`);
    if (/must start with https/.test(m)) throw new SsoSettingsError(`${what} must start with https://.`);
    if (/user name or password/.test(m)) throw new SsoSettingsError(`${what} must not contain a user name or password.`);
    throw new SsoSettingsError(`${what}: ${m.replace(/Webhooks[^.]*\./g, '').trim()}`);
  }
}

const parseList = (text) => String(text || '').split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
const publicRow = (r) => ({
  enabled: Boolean(r && r.enabled), issuer: (r && r.issuer) || '', clientId: (r && r.client_id) || '', hasSecret: Boolean(r && r.client_secret_enc),
  buttonLabel: (r && r.button_label) || '', scopes: (r && r.scopes) || 'openid email profile', autoCreate: Boolean(r && r.auto_create),
  defaultRole: (r && r.default_role) || 'user', trustEmail: Boolean(r && r.trust_email), allowedDomains: (r && r.allowed_domains) || '', updatedAt: (r && r.updated_at) || null,
});

const row = () => db.prepare('SELECT * FROM sso_settings WHERE tenant_id = nd_tenant()').get();
async function get() { return publicRow(await row()); }

// What an administrator typed, checked. `existing` is the stored row (the secret may be left blank to keep it).
async function validate(body, existing) {
  const b = body || {};
  const enabled = b.enabled === 'on';
  const issuer = String(b.issuer || '').trim().replace(/\/+$/, '');
  const clientId = String(b.client_id || '').trim();
  const secretTyped = String(b.client_secret || '');
  const label = String(b.button_label || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const scopes = parseList(b.scopes).join(' ') || 'openid email profile';
  const role = String(b.default_role || 'user');
  const domains = parseList(b.allowed_domains);
  if (!['user', 'agent'].includes(role)) throw new SsoSettingsError('New people can be made users or agents, never administrators.');
  if (!scopes.split(' ').includes('openid')) throw new SsoSettingsError('The scopes must include openid.');
  for (const d of domains) if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9]){0,1}\.[a-z]{2,}$/.test(d)) throw new SsoSettingsError(`"${d}" is not an email domain (for example example.com).`);
  if ([...issuer].length > 300 || [...clientId].length > 200 || secretTyped.length > 500) throw new SsoSettingsError('One of the values is too long.');
  if (enabled || issuer) {
    if (!issuer) throw new SsoSettingsError('Enter the provider\'s issuer address.');
    await checkAddress(issuer, 'The issuer address');
  }
  if (enabled) {
    if (!clientId) throw new SsoSettingsError('Enter the client ID the provider gave you.');
    if (!secretTyped && !(existing && existing.client_secret_enc)) throw new SsoSettingsError('Enter the client secret the provider gave you.');
  }
  return { enabled, issuer: issuer || null, clientId: clientId || null, secret: secretTyped || null, label: label || null, scopes, role, domains: domains.join(', ') || null, autoCreate: b.auto_create === 'on', trustEmail: b.trust_email === 'on' };
}

async function save(v, actor) {
  const before = publicRow(await row());
  const enc = v.secret ? encryptSecret(v.secret) : null;
  await db.prepare(`INSERT INTO sso_settings (enabled, issuer, client_id, client_secret_enc, button_label, scopes, auto_create, default_role, trust_email, allowed_domains, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (tenant_id) DO UPDATE SET enabled = EXCLUDED.enabled, issuer = EXCLUDED.issuer, client_id = EXCLUDED.client_id,
      client_secret_enc = COALESCE(EXCLUDED.client_secret_enc, sso_settings.client_secret_enc), button_label = EXCLUDED.button_label, scopes = EXCLUDED.scopes,
      auto_create = EXCLUDED.auto_create, default_role = EXCLUDED.default_role, trust_email = EXCLUDED.trust_email, allowed_domains = EXCLUDED.allowed_domains,
      updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`)
    .run(v.enabled ? 1 : 0, v.issuer, v.clientId, enc, v.label, v.scopes, v.autoCreate ? 1 : 0, v.role, v.trustEmail ? 1 : 0, v.domains, nowStr(), actor ? actor.id : null);
  invalidate();
  const now = publicRow(await row());
  const parts = [];
  if (before.enabled !== now.enabled) parts.push(now.enabled ? 'switched on' : 'switched off');
  if (before.issuer !== now.issuer) parts.push(`issuer ${before.issuer || 'none'} -> ${now.issuer || 'none'}`);
  if (before.clientId !== now.clientId) parts.push('client id');
  if (enc) parts.push('client secret replaced');
  for (const [k, label] of [['buttonLabel', 'button label'], ['scopes', 'scopes'], ['autoCreate', 'automatic accounts'], ['defaultRole', 'role of new people'], ['trustEmail', 'trust unverified email'], ['allowedDomains', 'allowed domains']]) if (before[k] !== now[k]) parts.push(label);
  return parts.join('; ') || 'saved without changes';
}

// ---- what a request uses
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
const originOf = (req) => `${req.protocol}://${req.get('host')}`;

// The configuration for this request's tenant, or { enabled: false }.
async function forRequest(req) {
  const r = await loadRow();
  if (r && r.enabled && r.issuer && r.client_id && r.client_secret_enc) {
    let secret;
    try { secret = decryptSecret(r.client_secret_enc); } catch { console.error('[SSO] the stored client secret cannot be read (SESSION_SECRET or MFA_ENCRYPTION_KEY has changed since it was saved): save it again under Settings > Single sign-on.'); return { enabled: false }; }
    return {
      enabled: true, source: 'tenant', issuer: r.issuer.replace(/\/+$/, ''), clientId: r.client_id, clientSecret: secret,
      redirectUri: `${originOf(req)}/auth/oidc/callback`, scopes: String(r.scopes || 'openid email profile').split(/\s+/).filter(Boolean),
      buttonLabel: r.button_label || 'Sign in with SSO', autoCreate: Boolean(r.auto_create), defaultRole: r.default_role, trustEmail: Boolean(r.trust_email),
      allowedDomains: parseList(r.allowed_domains),
    };
  }
  const env = envConfig();
  if (env.enabled && tenancy.currentId() === 1) return { ...env, source: 'server' };
  return { enabled: false };
}
const redirectUriFor = (req) => `${originOf(req)}/auth/oidc/callback`;

module.exports = { SsoSettingsError, get, validate, save, forRequest, invalidate, checkAddress, redirectUriFor, allowPrivate, parseList };
