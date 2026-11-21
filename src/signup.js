// Self-service sign-up of new tenants: a public page on its own host name (SIGNUP_HOST) where an organisation asks for a workspace. Nothing exists until the
// person has confirmed their email address (a one-time link, used by pressing a button so a mail scanner that opens the link does not use it up), and then the tenant,
// its first administrator and its default limits are made. It does not exist unless SIGNUP_HOST is set, and refuses to start without the things it cannot do without
// (a real mail server, to send the link; TENANT_BASE_DOMAIN, so that every new tenant has an address of its own).
// Everything that can be abused is limited: per address, per email address, per day, a pause switch for the people who run the service, an optional approval step,
// domains that are refused or the only ones allowed, and a hidden field and a minimum time that only a program trips over.
'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, nowStr } = require('./db');
const tenancy = require('./tenancy');
const tenants = require('./tenants');
const limits = require('./limits');
const platform = require('./platform');
const { checkPassword } = require('./passwords');
const { sessionSecret } = require('./settings');

const USERNAME_RE = /^[A-Za-z0-9._-]{2,40}$/;
const EMAIL_RE = /^[^\s@,;<>"']{1,64}@[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9]){0,1}\.[A-Za-z]{2,}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const KEEP_DAYS = 90;

class SignupError extends Error {}

function config(env = process.env) {
  const host = String(env.SIGNUP_HOST || '').trim().toLowerCase().replace(/\.$/, '');
  if (!host) return { enabled: false };
  if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9]){0,1}$/.test(host)) throw new Error('SIGNUP_HOST must be a host name, for example signup.helpdesk.example.com.');
  const base = tenants.baseDomain(env);
  if (!base) throw new Error('SIGNUP_HOST needs TENANT_BASE_DOMAIN: every workspace made by a sign-up is reached at <short name>.<that domain>.');
  if (!String(env.SMTP_HOST || '').trim()) throw new Error('SIGNUP_HOST needs SMTP_HOST: the link that confirms an email address is sent by the installation\'s own mail server (a tenant does not exist yet).');
  if (host === String(env.PLATFORM_HOST || '').trim().toLowerCase()) throw new Error('SIGNUP_HOST and PLATFORM_HOST must be different host names.');
  if (host === base) throw new Error('SIGNUP_HOST cannot be the tenant base domain itself.');
  const list = (name) => String(env[name] || '').split(',').map((x) => x.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  const num = (name, fallback, min, max) => {
    const raw = String(env[name] === undefined ? fallback : env[name]).trim();
    if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
    return Number(raw);
  };
  const bool = (name, fallback) => { const v = String(env[name] === undefined ? fallback : env[name]).trim().toLowerCase(); if (!['true', 'false'].includes(v)) throw new Error(`${name} must be true or false.`); return v === 'true'; };
  // Limits a new workspace starts with: "none" or an empty value is no limit. The people who run the service change them per tenant in the console afterwards.
  const lim = (name, fallback) => {
    const raw = String(env[name] === undefined ? fallback : env[name]).trim().toLowerCase();
    if (raw === '' || raw === 'none') return null;
    if (!/^\d+$/.test(raw) || Number(raw) > 1000000) throw new Error(`${name} must be a whole number from 0 to 1000000, or "none".`);
    return Number(raw);
  };
  const allowed = list('SIGNUP_ALLOWED_DOMAINS'); const blocked = list('SIGNUP_BLOCKED_DOMAINS');
  for (const d of [...allowed, ...blocked]) if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) throw new Error(`"${d}" is not a domain name (SIGNUP_ALLOWED_DOMAINS and SIGNUP_BLOCKED_DOMAINS list domains such as example.com).`);
  const terms = String(env.SIGNUP_TERMS_URL || '').trim();
  if (terms && !/^https?:\/\/[^\s]+$/i.test(terms)) throw new Error('SIGNUP_TERMS_URL must be an address starting with https://.');
  const scheme = String(env.SIGNUP_SCHEME || 'https').trim().toLowerCase();
  if (!['https', 'http'].includes(scheme)) throw new Error('SIGNUP_SCHEME must be https or http.');
  return {
    enabled: true, host, base, scheme, allowed, blocked, terms: terms || null, approval: bool('SIGNUP_REQUIRE_APPROVAL', 'false'),
    maxPerDay: num('SIGNUP_MAX_PER_DAY', 50, 0, 100000), perIpPerHour: num('SIGNUP_PER_IP_PER_HOUR', 5, 1, 1000), linkHours: num('SIGNUP_LINK_HOURS', 24, 1, 168),
    limits: { users: lim('SIGNUP_LIMIT_USERS', '5'), records: lim('SIGNUP_LIMIT_RECORDS', '500'), storageMb: lim('SIGNUP_LIMIT_STORAGE_MB', '50') },
  };
}

// ---- tokens
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
// The form carries a signed time, so a program that posts at once (or replays an old page) is turned away, and a person who takes a coffee is not.
const FORM_MIN_MS = 3000; const FORM_MAX_MS = 2 * 60 * 60 * 1000;
const formKey = (env) => crypto.createHash('sha256').update(`signup-form|${sessionSecret(env)}`).digest();
function formToken(env, now = Date.now()) { const t = String(now); return `${t}.${crypto.createHmac('sha256', formKey(env)).update(t).digest('base64url')}`; }
function checkFormToken(env, token, now = Date.now()) {
  const [t, mac] = String(token || '').split('.');
  if (!/^\d{10,15}$/.test(t || '') || !mac) return 'The page was opened too long ago or in another session. Go back and try again.';
  const want = crypto.createHmac('sha256', formKey(env)).update(t).digest('base64url');
  if (want.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return 'The page was opened too long ago or in another session. Go back and try again.';
  const age = now - Number(t);
  if (age < FORM_MIN_MS) return 'That was very quick. Wait a moment and send it again.';
  if (age > FORM_MAX_MS) return 'The page was opened too long ago. Go back and try again.';
  return null;
}

// ---- what a request must satisfy; returns { value } or { error } (a sentence for the person)
function checkRequest(cfg, b) {
  const orgName = String(b.org_name || '').replace(/\s+/g, ' ').trim();
  if (!orgName || [...orgName].length > 80) return { error: 'Give the name of your organisation (up to 80 characters).' };
  let slug;
  try { slug = tenants.checkSlug(String(b.slug || '').trim().toLowerCase()); } catch (e) { return { error: e.message }; }
  const label = (h) => String(h || '').split('.')[0];
  if ([label(cfg.host), label(process.env.PLATFORM_HOST)].includes(slug)) return { error: `"${slug}" is kept for the system; choose another short name.` };
  const adminName = String(b.admin_name || '').replace(/\s+/g, ' ').trim();
  if (!adminName || [...adminName].length > 80) return { error: 'Give your name (up to 80 characters).' };
  const email = String(b.email || '').trim();
  if (!EMAIL_RE.test(email) || email.length > 120) return { error: 'Give an email address that can receive the link, such as name@example.com.' };
  const domain = email.split('@')[1].toLowerCase();
  const under = (list) => list.some((d) => domain === d || domain.endsWith(`.${d}`));
  if (cfg.allowed.length && !under(cfg.allowed)) return { error: 'Sign-up is open to certain email domains only, and this one is not among them. Ask the people who run this service.' };
  if (under(cfg.blocked)) return { error: 'Addresses at that domain cannot be used to sign up. Use your organisation\'s address.' };
  const username = String(b.username || '').trim();
  if (!USERNAME_RE.test(username)) return { error: 'The username must be 2 to 40 letters, digits, dots, hyphens or underscores.' };
  const weak = checkPassword(String(b.password || ''), { username, email, fullName: adminName });
  if (weak) return { error: weak };
  if (String(b.password || '') !== String(b.password2 || '')) return { error: 'The two passwords are not the same.' };
  if (cfg.terms && b.terms !== 'on') return { error: 'Tick the box to say you accept the terms.' };
  return { value: { orgName, slug, adminName, email, username, password: String(b.password) } };
}

// ---- state
const P = (fn) => tenancy.runPlatform(fn);
async function paused() { return P(async () => { const r = await db.prepare("SELECT value FROM platform_settings WHERE key = 'signup_paused'").get(); return Boolean(r && r.value === 'true'); }); }
async function setPaused(on, by) {
  return P(() => db.prepare(`INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES ('signup_paused', ?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`).run(on ? 'true' : 'false', nowStr(), by || null));
}
const hoursAhead = (h) => new Date(Date.now() + h * 3600000).toISOString().slice(0, 19).replace('T', ' ');
const hoursAgo = (h) => hoursAhead(-h);

// How many sign-ups were asked for in the last day (all of them count: a flood must not make mail or tenants).
const lastDay = () => P(async () => Number((await db.prepare('SELECT COUNT(*) AS c FROM signups WHERE created_at >= ?').get(hoursAgo(24))).c));
// How many requests this address has had in the last hour (to stop one person filling another's inbox).
const forEmail = (email) => P(async () => Number((await db.prepare('SELECT COUNT(*) AS c FROM signups WHERE lower(admin_email) = lower(?) AND created_at >= ?').get(email, hoursAgo(1))).c));

// Remembers a request and returns the token for the link. The password is kept only as a hash.
async function createPending(cfg, v, ip) {
  const token = newToken();
  await P(() => db.prepare(`INSERT INTO signups (token_hash, slug, org_name, admin_username, admin_name, admin_email, password_hash, ip, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sha(token), v.slug, v.orgName, v.username, v.adminName, v.email, bcrypt.hashSync(v.password, 10), ip ? String(ip).slice(0, 64) : null, hoursAhead(cfg.linkHours)));
  return token;
}

// The pending request a link belongs to, or null (wrong, used, expired).
async function pendingFor(token) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  return P(() => db.prepare("SELECT id, slug, org_name, admin_username, admin_name, admin_email FROM signups WHERE token_hash = ? AND status = 'pending' AND expires_at > ?").get(sha(token), nowStr()));
}

const urlFor = (cfg, slug) => `${cfg.scheme}://${slug}.${cfg.base}`;

// Makes the tenant for a confirmed request. Claimed first, so two presses of the button (or two servers) make one tenant.
// Resolves { tenant, url, suspended } or throws SignupError with a sentence for the person.
async function complete(cfg, token, { req = null, mailer } = {}) {
  if (!TOKEN_RE.test(String(token || ''))) throw new SignupError('This link is not valid.');
  const claimed = await P(() => db.prepare("UPDATE signups SET status = 'creating' WHERE token_hash = ? AND status = 'pending' AND expires_at > ? RETURNING *").get(sha(token), nowStr()));
  if (!claimed) throw new SignupError('This link has already been used, or it has expired. If you already confirmed, your workspace is ready: sign in at its address. Otherwise start again.');
  const refuse = async (note, message) => { await P(() => db.prepare("UPDATE signups SET status = 'refused', note = ?, password_hash = NULL WHERE id = ?").run(note.slice(0, 300), claimed.id)); throw new SignupError(message); };
  let tenant;
  try {
    tenant = await tenants.createTenant({ slug: claimed.slug, name: claimed.org_name, hosts: [] });
  } catch (e) {
    if (e instanceof tenants.TenantError) return refuse(e.message, `The short name "${claimed.slug}" has been taken in the meantime. Start again with another one.`);
    await P(() => db.prepare("UPDATE signups SET status = 'refused', note = ?, password_hash = NULL WHERE id = ?").run(`unexpected: ${String(e.message).slice(0, 200)}`, claimed.id));
    throw e;
  }
  try {
    await tenants.createAdmin(tenant.id, { username: claimed.admin_username, passwordHash: claimed.password_hash, fullName: claimed.admin_name, email: claimed.admin_email });
    await tenants.setLimits(tenant.id, cfg.limits);
    if (cfg.approval) await tenants.setStatus(tenant.id, 'suspended');
  } catch (e) {
    await P(() => db.prepare("UPDATE signups SET status = 'refused', note = ?, tenant_id = ?, password_hash = NULL WHERE id = ?").run(`the tenant was made but not finished: ${String(e.message).slice(0, 200)}`, tenant.id, claimed.id));
    await platform.audit(req, null, 'tenant.signup_failed', { tenant, detail: `the workspace was made but its first administrator could not be: ${String(e.message).slice(0, 200)}` });
    throw new SignupError('Your workspace could not be finished. The people who run this service have been told; please contact them.');
  }
  await P(() => db.prepare("UPDATE signups SET status = 'completed', completed_at = ?, tenant_id = ?, password_hash = NULL WHERE id = ?").run(nowStr(), tenant.id, claimed.id));
  await platform.audit(req, null, 'tenant.signed_up', { tenant, detail: `by ${claimed.admin_email}${cfg.approval ? '; waiting for approval (suspended)' : ''}; default limits ${JSON.stringify(cfg.limits)}` });
  const url = urlFor(cfg, tenant.slug);
  if (mailer) {
    const { escapeHtml } = require('./helpers');
    mailer.sendSystem({
      to: claimed.admin_email, subject: cfg.approval ? 'Your workspace is waiting for approval' : 'Your workspace is ready',
      html: cfg.approval
        ? `<p>Hi ${escapeHtml(claimed.admin_name)},</p><p>Your workspace <strong>${escapeHtml(claimed.org_name)}</strong> has been made and will be switched on once the people who run this service have looked at the request. You will be able to sign in at <a href="${escapeHtml(url)}">${escapeHtml(url)}</a> as <strong>${escapeHtml(claimed.admin_username)}</strong>.</p>`
        : `<p>Hi ${escapeHtml(claimed.admin_name)},</p><p>Your workspace <strong>${escapeHtml(claimed.org_name)}</strong> is ready. Sign in at <a href="${escapeHtml(url)}">${escapeHtml(url)}</a> as <strong>${escapeHtml(claimed.admin_username)}</strong> with the password you chose.</p>`,
    }).catch((err) => console.error(`[Signup] the welcome email could not be sent: ${err.message}`));
  }
  return { tenant, url, suspended: cfg.approval, username: claimed.admin_username, email: claimed.admin_email };
}

// For the console: the latest requests, and counts.
async function recent(limit = 100) {
  return P(async () => ({
    rows: await db.prepare('SELECT id, slug, org_name, admin_email, admin_username, status, note, created_at, completed_at, tenant_id, ip FROM signups ORDER BY id DESC LIMIT ?').all(limit),
    day: await lastDay(),
    paused: await paused(),
  }));
}

// Daily clean-up: requests nobody confirmed expire, and old rows (and the email address in them) are removed.
async function cleanup() {
  return P(async () => {
    await db.prepare("UPDATE signups SET status = 'expired', password_hash = NULL WHERE status = 'pending' AND expires_at <= ?").run(nowStr());
    await db.prepare("UPDATE signups SET status = 'expired', password_hash = NULL WHERE status = 'creating' AND created_at <= ?").run(hoursAgo(2));
    return (await db.prepare("DELETE FROM signups WHERE created_at < ? AND status <> 'pending'").run(hoursAgo(KEEP_DAYS * 24))).changes || 0;
  });
}

module.exports = { SignupError, config, formToken, checkFormToken, checkRequest, sha, newToken, paused, setPaused, lastDay, forEmail, createPending, pendingFor, complete, recent, cleanup, urlFor, KEEP_DAYS, FORM_MIN_MS };
