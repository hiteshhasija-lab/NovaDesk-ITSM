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
//   'admin' ADMIN_USERNAME + ADMIN_PASSWORD (at least 8 characters): one administrator, nothing else
//   'none'  neither: nobody can sign in until one of them is set; `problem` says what is wrong
function seedPlan(env, userCount) {
  if (userCount > 0) return { action: 'skip' };
  if (env.SEED_DEMO === 'true') return { action: 'demo' };
  const username = (env.ADMIN_USERNAME || '').trim();
  const password = env.ADMIN_PASSWORD || '';
  if (username && password) {
    if (password.length < 8) return { action: 'none', problem: 'ADMIN_PASSWORD must be at least 8 characters.' };
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

module.exports = { dbConfig, sessionSecret, seedPlan, mailConfig, DEV_SESSION_SECRET };
