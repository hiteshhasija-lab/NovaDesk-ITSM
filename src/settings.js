// Start-up settings that decide whether an install is safe to run, kept apart from the code that
// uses them so they can be tested without a database.
//
// In production (NODE_ENV=production) nothing falls back to a built-in value: a missing database
// setting or session secret stops the start with a message naming it. Outside production the old
// development defaults still apply, so a developer's `npm run dev` and the lab (which does not set
// NODE_ENV) behave as before.
'use strict';

const DEV_SESSION_SECRET = 'itsm-dev-secret-change-me';

const isProduction = (env) => env.NODE_ENV === 'production';

function dbConfig(env) {
  if (isProduction(env)) {
    const missing = ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'].filter((name) => !env[name]);
    if (missing.length) throw new Error(`Missing settings (NODE_ENV=production): ${missing.join(', ')}. Set them in .env.`);
  }
  return {
    host: env.PGHOST || 'localhost',
    port: env.PGPORT || 5432,
    user: env.PGUSER || 'novadesk',
    password: env.PGPASSWORD || 'novadesk_dev_pw',
    database: env.PGDATABASE || 'novadesk',
  };
}

function sessionSecret(env) {
  const secret = env.SESSION_SECRET;
  if (isProduction(env)) {
    if (!secret) throw new Error('SESSION_SECRET is required (NODE_ENV=production): at least 32 characters, for example `openssl rand -hex 32`.');
    if (secret === DEV_SESSION_SECRET) throw new Error('SESSION_SECRET is still the built-in development value: set your own (NODE_ENV=production).');
    if (secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters (NODE_ENV=production).');
  }
  return secret || DEV_SESSION_SECRET;
}

// What to do when the database starts out empty (an existing database is never touched):
//   'demo'  SEED_DEMO=true: the demonstration workspace (users, assets, tickets, catalog, articles)
//   'admin' ADMIN_USERNAME + ADMIN_PASSWORD (at least PASSWORD_MIN_LENGTH, default 10, characters): one administrator, nothing else
//   'none'  neither: nobody can sign in until one of them is set; `problem` says what is wrong
function seedPlan(env, userCount) {
  if (userCount > 0) return { action: 'skip' };
  if (env.SEED_DEMO === 'true') return { action: 'demo' };
  const username = (env.ADMIN_USERNAME || '').trim();
  const password = env.ADMIN_PASSWORD || '';
  if (username && password) {
    const min = securitySettings(env).passwordMinLength;
    if (password.length < min) return { action: 'none', problem: `ADMIN_PASSWORD must be at least ${min} characters.` };
    return { action: 'admin', username, password, fullName: (env.ADMIN_FULL_NAME || '').trim() || username, email: (env.ADMIN_EMAIL || '').trim() || null };
  }
  return { action: 'none', problem: 'There are no accounts yet: set ADMIN_USERNAME and ADMIN_PASSWORD (a first administrator), or SEED_DEMO=true (the demonstration workspace), and restart.' };
}

// Outgoing email. With SMTP_HOST set, NovaDesk sends through that server (a bad combination stops the
// start and says what is wrong). Without it:
//   'sandbox'  outside production: the old behaviour, a throwaway test mailbox (ethereal.email) that
//              nobody reads; the lab and `npm run dev` keep working as before
//   'none'     NODE_ENV=production: nothing is sent and nothing leaves the server; notices are still
//              recorded on the Notifications page, marked as not sent
function mailConfig(env) {
  const host = (env.SMTP_HOST || '').trim();
  if (!host) return { mode: isProduction(env) ? 'none' : 'sandbox' };
  const port = env.SMTP_PORT ? Number(env.SMTP_PORT) : 587;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP_PORT must be a port number between 1 and 65535 (587 for STARTTLS, 465 for TLS, 25 for a plain relay).');
  const flag = (name, fallback) => {
    const v = (env[name] || '').trim().toLowerCase();
    if (!v) return fallback;
    if (v === 'true') return true;
    if (v === 'false') return false;
    throw new Error(`${name} must be true or false.`);
  };
  const user = env.SMTP_USER || '';
  const pass = env.SMTP_PASSWORD || '';
  if (Boolean(user) !== Boolean(pass)) throw new Error('SMTP_USER and SMTP_PASSWORD go together: set both, or neither for a relay that needs no sign-in.');
  const from = (env.SMTP_FROM || '').trim();
  if (!from || !/[^\s<>@]+@[^\s<>@]+/.test(from)) throw new Error('SMTP_FROM is required with SMTP_HOST: the sender address, for example NovaDesk <helpdesk@example.com>.');
  return {
    mode: 'smtp', host, port, user, pass, from,
    secure: flag('SMTP_SECURE', false),        // true: TLS from the first byte (usually port 465)
    tlsVerify: flag('SMTP_TLS_VERIFY', true),  // false only for a server with a self-signed certificate
  };
}

// Single sign-on (OpenID Connect) and two-step verification.
//   OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and PUBLIC_URL switch SSO on (all four, or none).
//   OIDC_AUTO_CREATE=true creates an account the first time someone signs in (role OIDC_DEFAULT_ROLE, never admin).
//   OIDC_TRUST_EMAIL=true matches an existing account by an email the provider did not mark verified (Microsoft
//   Entra ID does not send email_verified); use it only with an issuer that belongs to your own tenant.
//   OIDC_ALLOWED_DOMAINS limits sign-in to those email domains.
//   LOCAL_LOGIN=false hides the username and password form (needs SSO).
//   MFA_REQUIRE=admins|all makes those people set up two-step verification before they can use NovaDesk.
const isLoopbackHost = (host) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);

function oidcConfig(env) {
  const issuer = (env.OIDC_ISSUER || '').trim().replace(/\/+$/, '');
  const clientId = (env.OIDC_CLIENT_ID || '').trim();
  const clientSecret = env.OIDC_CLIENT_SECRET || '';
  const publicUrl = (env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (!issuer && !clientId && !clientSecret) return { enabled: false };
  const missing = [['OIDC_ISSUER', issuer], ['OIDC_CLIENT_ID', clientId], ['OIDC_CLIENT_SECRET', clientSecret], ['PUBLIC_URL', publicUrl]].filter(([, v]) => !v).map(([n]) => n);
  if (missing.length) throw new Error(`Single sign-on needs ${missing.join(', ')} as well (set all of OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and PUBLIC_URL, or none of them).`);
  const url = (name, value) => {
    let u;
    try { u = new URL(value); } catch { throw new Error(`${name} is not a web address.`); }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname))) throw new Error(`${name} must start with https:// (plain http is only accepted for localhost).`);
    return u;
  };
  url('OIDC_ISSUER', issuer);
  url('PUBLIC_URL', publicUrl);
  const flag = (name) => (env[name] || '').trim().toLowerCase() === 'true';
  const role = (env.OIDC_DEFAULT_ROLE || 'user').trim().toLowerCase();
  if (!['user', 'agent'].includes(role)) throw new Error('OIDC_DEFAULT_ROLE must be user or agent: administrators are never created by single sign-on.');
  return {
    enabled: true, issuer, clientId, clientSecret,
    redirectUri: `${publicUrl}/auth/oidc/callback`,
    scopes: (env.OIDC_SCOPES || 'openid email profile').trim().split(/\s+/).filter(Boolean),
    buttonLabel: (env.OIDC_BUTTON_LABEL || 'Sign in with SSO').trim().slice(0, 60),
    autoCreate: flag('OIDC_AUTO_CREATE'),
    defaultRole: role,
    trustEmail: flag('OIDC_TRUST_EMAIL'),
    allowedDomains: (env.OIDC_ALLOWED_DOMAINS || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
  };
}

function authPolicy(env) {
  const oidc = oidcConfig(env);
  const localLogin = (env.LOCAL_LOGIN || 'true').trim().toLowerCase() !== 'false';
  if (!localLogin && !oidc.enabled) throw new Error('LOCAL_LOGIN=false hides the password form, so single sign-on has to be set up (OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, PUBLIC_URL) or nobody could sign in.');
  const mfaRequire = (env.MFA_REQUIRE || 'none').trim().toLowerCase();
  if (!['none', 'admins', 'all'].includes(mfaRequire)) throw new Error('MFA_REQUIRE must be none, admins or all.');
  return { oidc, localLogin, mfaRequire };
}

// Running behind a reverse proxy: how many proxies sit in front of NovaDesk, so that the client's address (used for
// rate limits and sign-in throttling) is read from X-Forwarded-For and cannot be forged by the client.
// TRUST_PROXY=1 (one proxy), 2, ... or loopback / linklocal / uniquelocal or a list of addresses. Not "true":
// that would believe whatever the client writes.
function trustProxy(env) {
  const v = (env.TRUST_PROXY || '').trim();
  if (!v || v.toLowerCase() === 'false' || v === '0') return false;
  if (/^\d+$/.test(v)) return Number(v);
  if (v.toLowerCase() === 'true') throw new Error('TRUST_PROXY=true would believe any address a client claims. Use the number of proxies in front of NovaDesk (for example 1), or the proxy\'s address (for example loopback or 10.0.0.5).');
  return v;
}

// Allowances per minute. RATE_LIMIT_IP_PER_MIN: all routes, per address. RATE_LIMIT_API_PER_MIN: API reads, per key.
// RATE_LIMIT_API_WRITE_PER_MIN: API creates and changes, per key. RATE_LIMIT_LOGIN_FAILURES: refused sign-ins per address per
// 15 minutes (default 20). 0 turns a limit off.
function rateLimits(env) {
  const num = (name, fallback) => {
    const raw = (env[name] || '').trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 1000000) throw new Error(`${name} must be a whole number of requests per minute (0 turns the limit off).`);
    return n;
  };
  return { ipPerMinute: num('RATE_LIMIT_IP_PER_MIN', 1200), apiPerMinute: num('RATE_LIMIT_API_PER_MIN', 300), apiWritePerMinute: num('RATE_LIMIT_API_WRITE_PER_MIN', 60), loginFailuresPer15Min: num('RATE_LIMIT_LOGIN_FAILURES', 20) };
}

// Password and lockout rules. PASSWORD_MIN_LENGTH (8 to 64, default 10). LOCKOUT_AFTER wrong passwords in a row lock
// the account for LOCKOUT_MINUTES (defaults 10 and 15; LOCKOUT_AFTER=0 turns locking off).
function securitySettings(env) {
  const whole = (name, fallback, min, max) => {
    const raw = (env[name] || '').trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
    return n;
  };
  return {
    passwordMinLength: whole('PASSWORD_MIN_LENGTH', 10, 8, 64),
    lockoutAfter: whole('LOCKOUT_AFTER', 10, 0, 1000),
    lockoutMinutes: whole('LOCKOUT_MINUTES', 15, 1, 10080),
  };
}

module.exports = { dbConfig, sessionSecret, seedPlan, mailConfig, oidcConfig, authPolicy, trustProxy, rateLimits, securitySettings, DEV_SESSION_SECRET };
