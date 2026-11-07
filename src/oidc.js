// Single sign-on with OpenID Connect (authorization code flow with PKCE), for Microsoft Entra ID, Google and any
// provider that publishes /.well-known/openid-configuration. Settings are in settings.js (oidcConfig); the token
// checks are in jwt.js. This module talks to the provider and decides which NovaDesk account the person is.
'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, nowStr } = require('./db');
const { authPolicy } = require('./settings');
const { verifyIdToken, TokenError } = require('./jwt');

const policy = authPolicy(process.env);       // throws at start-up when the settings do not fit together
// What a request uses (the tenant's own settings, or for the default tenant the server's OIDC_* settings) comes from
// ssoSettings.forRequest(req) and is passed to every function below as `cfg`.
const ssoSettings = require('./ssoSettings');

// What a person is told when sign-in fails. Details go to the server log instead.
class SsoError extends Error {}

const TIMEOUT_MS = 10000;
const METADATA_TTL_MS = 60 * 60 * 1000;
const JWKS_MIN_REFETCH_MS = (Number(process.env.OIDC_JWKS_MIN_REFETCH_S) || 60) * 1000;   // only tests and CI change this
// Kept for each provider (by its issuer address).
const metadataCache = new Map();   // issuer -> { m, at }
const jwksCache = new Map();       // issuer -> { keys, at }

const isLoopback = (u) => ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
function checkEndpoint(name, value) {
  let u;
  try { u = new URL(value); } catch { throw new SsoError(`The identity provider's ${name} is not a web address.`); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u))) throw new SsoError(`The identity provider's ${name} is not https.`);
  return value;
}

async function getJson(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

// A tenant's administrator chose the provider's address, so every address this server is about to fetch is checked first.
async function guard(cfg, url, what) {
  if (cfg.source !== 'tenant') return;
  try { await ssoSettings.checkAddress(url, what); } catch (err) {
    if (!(err instanceof ssoSettings.SsoSettingsError)) throw err;
    console.error(`[SSO] refused to contact ${what}: ${err.message}`);
    throw new SsoError('The identity provider\'s address is not allowed. Ask an administrator.');
  }
}

async function getMetadata(cfg) {
  const hit = metadataCache.get(cfg.issuer);
  if (hit && Date.now() - hit.at < METADATA_TTL_MS) return hit.m;
  await guard(cfg, cfg.issuer, 'the issuer address');
  let m;
  try { m = await getJson(`${cfg.issuer}/.well-known/openid-configuration`); } catch (err) {
    console.error(`[SSO] could not read the provider's configuration: ${err.message}`);
    throw new SsoError('The identity provider could not be reached. Try again in a moment, or sign in with your NovaDesk password.');
  }
  if (!m.issuer || m.issuer.replace(/\/+$/, '') !== cfg.issuer) {
    console.error(`[SSO] the provider reports issuer ${m.issuer}, expected ${cfg.issuer}`);
    throw new SsoError('The identity provider is not set up the way NovaDesk expects. Ask an administrator to check the issuer address.');
  }
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) { checkEndpoint(k, m[k]); await guard(cfg, m[k], `the provider's ${k}`); }
  metadataCache.set(cfg.issuer, { m, at: Date.now() });
  return m;
}

async function getJwks(cfg, force = false) {
  const hit = jwksCache.get(cfg.issuer);
  if (!force && hit && Date.now() - hit.at < METADATA_TTL_MS) return hit.keys;
  if (force && hit && Date.now() - hit.at < JWKS_MIN_REFETCH_MS) return hit.keys;     // at most one refetch a minute
  const m = await getMetadata(cfg);
  try {
    const keys = await getJson(m.jwks_uri);
    jwksCache.set(cfg.issuer, { keys, at: Date.now() });
    return keys;
  } catch (err) {
    console.error(`[SSO] could not fetch the provider's keys: ${err.message}`);
    throw new SsoError('The identity provider could not be reached. Try again in a moment.');
  }
}

const randomToken = () => crypto.randomBytes(32).toString('base64url');

// The first step: where to send the browser, and what to remember in the session until it comes back.
async function beginLogin(cfg) {
  const m = await getMetadata(cfg);
  const state = randomToken(); const nonce = randomToken(); const verifier = randomToken();
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const url = new URL(m.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: cfg.clientId, redirect_uri: cfg.redirectUri, scope: cfg.scopes.join(' '),
    state, nonce, code_challenge: challenge, code_challenge_method: 'S256',
  }).toString();
  return { redirectTo: url.toString(), saved: { state, nonce, verifier, at: Date.now() } };
}

// The second step, when the provider sends the person back with a code: trade it for the ID token, check
// the token, and return its claims.
async function completeLogin(cfg, { code, saved }) {
  const m = await getMetadata(cfg);
  const form = new URLSearchParams({
    grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri, client_id: cfg.clientId,
    client_secret: cfg.clientSecret, code_verifier: saved.verifier,
  });
  let token;
  try {
    const res = await fetch(m.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
    token = await res.json().catch(() => ({}));
    if (!res.ok || !token.id_token) {
      console.error(`[SSO] the provider refused the code: ${res.status} ${token.error || ''} ${token.error_description || ''}`.trim());
      throw new SsoError('The identity provider did not accept the sign-in. Try again.');
    }
  } catch (err) {
    if (err instanceof SsoError) throw err;
    console.error(`[SSO] could not reach the token endpoint: ${err.message}`);
    throw new SsoError('The identity provider could not be reached. Try again in a moment.');
  }
  const args = { issuer: cfg.issuer, clientId: cfg.clientId, nonce: saved.nonce };
  try {
    try { return verifyIdToken(token.id_token, { ...args, jwks: await getJwks(cfg) }); } catch (err) {
      if (!(err instanceof TokenError) || err.code !== 'unknown_kid') throw err;
      return verifyIdToken(token.id_token, { ...args, jwks: await getJwks(cfg, true) });   // keys rotate: look once more
    }
  } catch (err) {
    if (err instanceof TokenError) { console.error(`[SSO] token refused: ${err.message}`); throw new SsoError(err.message); }
    throw err;
  }
}

// ---------------------------------------------------------------- which account is this?
const normalizeEmail = (e) => (typeof e === 'string' && e.includes('@') ? e.trim().toLowerCase() : null);

async function uniqueUsername(email) {
  const base = (email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '') || 'user').slice(0, 40);
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? base : `${base}${i + 1}`;
    if (!(await db.prepare('SELECT 1 AS x FROM users WHERE username = ?').get(candidate))) return candidate;
  }
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

// Resolves { user } for the signed-in person, or throws SsoError saying why not. The identity is the provider's
// stable subject id; the first time, an existing account is matched by email, and only when the provider says the
// email is verified (or OIDC_TRUST_EMAIL=true); otherwise an account is created, if OIDC_AUTO_CREATE=true.
async function resolveUser(cfg, claims) {
  const issuer = cfg.issuer;
  const claimedEmail = normalizeEmail(claims.email);
  const email = claimedEmail || normalizeEmail(claims.preferred_username);
  const verified = (Boolean(claimedEmail) && (claims.email_verified === true || claims.email_verified === 'true')) || cfg.trustEmail;

  if (cfg.allowedDomains.length) {
    const domain = email ? email.split('@')[1] : null;
    if (!domain || !cfg.allowedDomains.includes(domain)) throw new SsoError('Your email domain is not allowed to sign in to this NovaDesk.');
  }

  const linked = await db.prepare(`
    SELECT u.*, i.id AS identity_id FROM user_identities i JOIN users u ON u.id = i.user_id WHERE i.issuer = ? AND i.subject = ?
  `).get(issuer, claims.sub);
  if (linked) {
    if (!linked.active) throw new SsoError('Your NovaDesk account is turned off. Ask an administrator.');
    await db.prepare('UPDATE user_identities SET last_login_at = ?, email = ? WHERE id = ?').run(nowStr(), email, linked.identity_id);
    return { user: linked };
  }

  if (!email) throw new SsoError('The identity provider did not share an email address, so NovaDesk cannot tell which account is yours. Ask an administrator.');

  const matches = await db.prepare('SELECT * FROM users WHERE lower(email) = ?').all(email);
  if (matches.length && !verified) throw new SsoError('The identity provider has not verified your email address, so it cannot be matched to your NovaDesk account. Ask an administrator.');
  if (matches.length > 1) throw new SsoError('More than one NovaDesk account has your email address. Ask an administrator to sort it out.');
  if (matches.length === 1) {
    const user = matches[0];
    if (!user.active) throw new SsoError('Your NovaDesk account is turned off. Ask an administrator.');
    await db.prepare('INSERT INTO user_identities (user_id, issuer, subject, email, last_login_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (tenant_id, issuer, subject) DO NOTHING').run(user.id, issuer, claims.sub, email, nowStr());
    console.log(`[SSO] linked ${user.username} to ${issuer} (matched by email)`);
    return { user, linked: true };
  }

  if (cfg.autoCreate && verified) {
    const username = await uniqueUsername(email);
    const created = await db.prepare(`
      INSERT INTO users (username, password_hash, full_name, email, role) VALUES (?, ?, ?, ?, ?) RETURNING id
    `).run(username, bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10), String(claims.name || email.split('@')[0]).slice(0, 100), email, cfg.defaultRole);
    await db.prepare('INSERT INTO user_identities (user_id, issuer, subject, email, last_login_at) VALUES (?, ?, ?, ?, ?)').run(created.lastInsertRowid, issuer, claims.sub, email, nowStr());
    console.log(`[SSO] created ${username} (${cfg.defaultRole}) from ${issuer}`);
    return { user: await db.prepare('SELECT * FROM users WHERE id = ?').get(created.lastInsertRowid), created: true };
  }
  throw new SsoError(`There is no NovaDesk account for ${email}. Ask an administrator to create one.`);
}

// For the administrator's "Test the connection": does the provider answer, and does it name itself as expected? Nothing is signed in.
async function probe(issuer) {
  const cfg = { source: 'tenant', issuer: String(issuer).replace(/\/+$/, '') };
  metadataCache.delete(cfg.issuer); jwksCache.delete(cfg.issuer);
  const m = await getMetadata(cfg);
  const keys = await getJwks(cfg, false);
  return { authorization_endpoint: m.authorization_endpoint, token_endpoint: m.token_endpoint, keyCount: Array.isArray(keys && keys.keys) ? keys.keys.length : 0 };
}

const forRequest = (req) => ssoSettings.forRequest(req);

module.exports = { forRequest, probe, policy, beginLogin, completeLogin, resolveUser, SsoError };
