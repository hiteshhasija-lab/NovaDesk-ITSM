// The platform console: for the people who run the installation. Make a tenant (with its first administrator and its host
// names), rename it, suspend or reactivate it, add or remove host names, and give a locked-out tenant administrator a new
// password. It lives on its own host name (PLATFORM_HOST) and nowhere else, behind its own sign-in (src/platform.js), and
// every action is recorded in platform_audit. It shows counts, never the content of any tenant's records.
'use strict';
const express = require('express');
const { createLimiter } = require('../rateLimit');
const platform = require('../platform');
const tenants = require('../tenants');
const { checkPassword } = require('../passwords');
const platformMfa = require('../platformMfa');

function mount(env = process.env) {
  const cfg = platform.config(env);
  if (!cfg.enabled) return (req, res, next) => next();
  const router = express.Router();
  const secure = (req) => req.secure || String(req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https';
  const setCookie = (req, res, name, value, maxAgeMs) => res.append('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure(req) ? '; Secure' : ''}`);
  const clearCookie = (req, res, name) => res.append('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure(req) ? '; Secure' : ''}`);
  const page = (res, view, data = {}, status = 200) => { res.set('Cache-Control', 'no-store'); return res.status(status).render(view, { title: 'Platform console', host: cfg.host, flash: null, error: null, ...data }); };

  // Who is signed in: a valid signed cookie whose operator still exists.
  router.use(async (req, res, next) => {
    try {
      const token = platform.readCookies(req)[platform.COOKIE];
      const p = platform.verify(token, env);
      const op = p ? await platform.findById(p.o) : null;
      if (op && p.s === 'mfa') { req.pending = op; req.csrf = p.c; res.locals.csrf = p.c; }          // the password was right, the code is still to come
      else if (op) {
        req.operator = op; req.csrf = p.c; res.locals.operator = op; res.locals.csrf = p.c;
        req.mfa = await platformMfa.status(op.id);
        req.enrollOnly = cfg.requireMfa && !req.mfa.enabled;                                          // required, and not set up yet: only the setup pages open
      }
      next();
    } catch (err) { next(err); }
  });
  const needLogin = (req, res, next) => {
    if (!req.operator) return res.redirect('/login');
    if (req.enrollOnly && !/^\/(mfa|logout)(\/|$)/.test(req.path)) return res.redirect('/mfa');
    return next();
  };
  const needToken = (req, res, next) => (platform.same(req.body && req.body._csrf, req.csrf) ? next() : page(res, 'platform/message', { title: 'Reload the page', message: 'The page was opened in an earlier session. Reload it and try again.', operator: req.operator }, 403));

  // ---- sign in and out
  router.get('/login', (req, res) => {
    if (req.operator) return res.redirect('/');
    const t = platform.newToken();
    setCookie(req, res, platform.LOGIN_COOKIE, t, 15 * 60 * 1000);
    page(res, 'platform/login', { loginToken: t });
  });
  router.post('/login', createLimiter({ windowMs: 15 * 60 * 1000, max: 20, message: 'Too many sign-in attempts. Wait 15 minutes and try again.' }), async (req, res, next) => {
    try {
      const t = platform.readCookies(req)[platform.LOGIN_COOKIE];
      const again = (error, status = 401) => { const n = platform.newToken(); setCookie(req, res, platform.LOGIN_COOKIE, n, 15 * 60 * 1000); return page(res, 'platform/login', { loginToken: n, error }, status); };
      if (!platform.same(req.body._csrf, t)) return again('The page was opened in an earlier session. Try again.', 403);
      const r = await platform.login(req.body.username, req.body.password);
      if (r.error) {
        await platform.audit(req, null, r.error === 'locked' ? 'login.locked' : 'login.failed', { detail: `username "${String(req.body.username || '').slice(0, 40)}"` });
        return again(r.error === 'locked' ? 'This account is locked for a while after too many wrong passwords.' : 'That username and password do not match.');
      }
      clearCookie(req, res, platform.LOGIN_COOKIE);
      if ((await platformMfa.status(r.operator.id)).enabled) {
        // Right password: now the code. A short-lived cookie that opens nothing but the code page.
        await platform.audit(req, r.operator, 'login.password_ok', { detail: 'waiting for the two-step code' });
        setCookie(req, res, platform.COOKIE, platform.sessionCookie(r.operator, env, 'mfa'), platform.PENDING_MS);
        return res.redirect('/login/mfa');
      }
      await platform.audit(req, r.operator, 'login', { detail: cfg.requireMfa ? 'two-step verification still to be set up' : null });
      setCookie(req, res, platform.COOKIE, platform.sessionCookie(r.operator, env), platform.LIFETIME_MS);
      res.redirect(cfg.requireMfa ? '/mfa' : '/');
    } catch (err) { next(err); }
  });
  // ---- the code, after the password
  router.get('/login/mfa', (req, res) => (req.pending ? page(res, 'platform/login-mfa', {}) : res.redirect('/login')));
  router.post('/login/mfa', async (req, res, next) => {
    try {
      if (!req.pending) return res.redirect('/login');
      if (!platform.same(req.body._csrf, req.csrf)) return page(res, 'platform/login-mfa', { error: 'The page was opened in an earlier session. Sign in again.' }, 403);
      const op = req.pending;
      if (await platformMfa.isLocked(op.id)) { await platform.audit(req, op, 'login.locked'); return page(res, 'platform/login-mfa', { error: 'This account is locked for a while after too many wrong codes.' }, 401); }
      const r = await platformMfa.verify(op.id, req.body.code);
      if (!r.ok) {
        await platformMfa.recordFailure(op.id);
        await platform.audit(req, op, 'login.mfa_failed');
        return page(res, 'platform/login-mfa', { error: 'That code is not right. Use the current code from your authenticator app, or a recovery code.' }, 401);
      }
      await platformMfa.clearFailures(op.id);
      await platform.audit(req, op, 'login', { detail: r.usedRecoveryCode ? `a recovery code was used; ${r.recoveryCodesLeft} left` : 'two-step code' });
      setCookie(req, res, platform.COOKIE, platform.sessionCookie(op, env), platform.LIFETIME_MS);
      res.redirect('/');
    } catch (err) { next(err); }
  });

  // ---- two-step verification of the signed-in operator
  const issuer = `Platform console (${cfg.host})`;
  const mfaPage = async (req, res, extra = {}, status = 200) => page(res, 'platform/mfa', { title: 'Two-step verification', state: req.mfa, setup: req.mfa.enabled ? null : await platformMfa.pendingSetup(req.operator, issuer), required: cfg.requireMfa, forced: req.enrollOnly, codes: null, success: null, ...extra }, status);
  router.get('/mfa', needLogin, async (req, res, next) => { try { await mfaPage(req, res); } catch (e) { next(e); } });
  router.post('/mfa/setup', needLogin, needToken, async (req, res, next) => {
    try { if (!req.mfa.enabled) await platformMfa.beginSetup(req.operator, issuer); res.redirect('/mfa'); } catch (e) { next(e); }
  });
  router.post('/mfa/confirm', needLogin, needToken, async (req, res, next) => {
    try {
      const codes = await platformMfa.finishSetup(req.operator.id, req.body.code);
      if (!codes) return mfaPage(req, res, { error: 'That code is not right. Check your authenticator app and try again.' }, 400);
      await platform.audit(req, req.operator, 'mfa.enabled');
      req.mfa = await platformMfa.status(req.operator.id); req.enrollOnly = false;
      await mfaPage(req, res, { codes, success: 'Two-step verification is on. Keep these recovery codes somewhere safe: each works once, and they are not shown again.' });
    } catch (e) { next(e); }
  });
  router.post('/mfa/recovery', needLogin, needToken, async (req, res, next) => {
    try {
      if (!req.mfa.enabled || !(await platformMfa.verify(req.operator.id, req.body.code)).ok) { await platform.audit(req, req.operator, 'mfa.change_refused', { detail: 'new recovery codes' }); return mfaPage(req, res, { error: 'A current code from your authenticator app is needed to make new recovery codes.' }, 400); }
      const codes = await platformMfa.replaceRecoveryCodes(req.operator.id);
      await platform.audit(req, req.operator, 'mfa.recovery_codes_replaced');
      await mfaPage(req, res, { codes, success: 'These are your new recovery codes. The old ones no longer work.' });
    } catch (e) { next(e); }
  });
  router.post('/mfa/disable', needLogin, needToken, async (req, res, next) => {
    try {
      if (cfg.requireMfa) return mfaPage(req, res, { error: 'This installation requires two-step verification for every operator.' }, 400);
      if (!req.mfa.enabled || !(await platformMfa.verify(req.operator.id, req.body.code)).ok) { await platform.audit(req, req.operator, 'mfa.change_refused', { detail: 'switching off' }); return mfaPage(req, res, { error: 'A current code from your authenticator app is needed to switch it off.' }, 400); }
      await platformMfa.disable(req.operator.id);
      await platform.audit(req, req.operator, 'mfa.disabled');
      req.mfa = await platformMfa.status(req.operator.id);
      await mfaPage(req, res, { success: 'Two-step verification is off.' });
    } catch (e) { next(e); }
  });

  router.post('/logout', needLogin, needToken, async (req, res) => { await platform.audit(req, req.operator, 'logout'); clearCookie(req, res, platform.COOKIE); res.redirect('/login'); });

  // ---- the overview and making a tenant
  router.get('/', needLogin, async (req, res, next) => { try { page(res, 'platform/index', { title: 'Tenants', tenants: await platform.overview(), form: {}, policy: tenants.unknownPolicy(env), base: tenants.baseDomain(env) }); } catch (e) { next(e); } });
  router.post('/tenants', needLogin, needToken, async (req, res, next) => {
    const b = req.body; const form = { slug: b.slug, name: b.name, host: b.host, admin_username: b.admin_username, admin_name: b.admin_name, admin_email: b.admin_email };
    const fail = async (error) => page(res, 'platform/index', { title: 'Tenants', tenants: await platform.overview(), form, error, policy: tenants.unknownPolicy(env), base: tenants.baseDomain(env) }, 400);
    try {
      // Everything is checked before anything is made, so a refusal leaves nothing half-made.
      const slug = tenants.checkSlug(b.slug); const name = tenants.cleanName(b.name);
      const hosts = String(b.host || '').split(/[\s,]+/).filter(Boolean).map(tenants.checkHost);
      if (hosts.includes(cfg.host)) throw new tenants.TenantError('That host name is the console\'s own.');
      const username = String(b.admin_username || '').trim();
      if (!/^[A-Za-z0-9._-]{2,40}$/.test(username)) throw new tenants.TenantError('The administrator\'s username must be 2 to 40 letters, digits, dots, hyphens or underscores.');
      const weak = checkPassword(b.admin_password || '', { username, email: b.admin_email, fullName: b.admin_name });
      if (weak) throw new tenants.TenantError(weak);
      const tenant = await tenants.createTenant({ slug, name, hosts });
      await tenants.createAdmin(tenant.id, { username, password: b.admin_password, fullName: b.admin_name, email: b.admin_email });
      await platform.audit(req, req.operator, 'tenant.created', { tenant, detail: `${name}; hosts: ${hosts.join(', ') || 'none'}; first administrator ${username}` });
      res.redirect(`/tenants/${tenant.id}`);
    } catch (err) { if (err instanceof tenants.TenantError) return fail(err.message); next(err); }
  });

  // ---- one tenant
  const load = async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const t = Number.isInteger(id) && id > 0 ? (await platform.overview()).find((x) => x.id === id) : null;
      if (!t) return page(res, 'platform/message', { title: 'Not found', message: 'There is no such tenant.', operator: req.operator }, 404);
      req.tenant = t; next();
    } catch (e) { next(e); }
  };
  const show = async (req, res, extra = {}, status = 200) => page(res, 'platform/tenant', { title: req.tenant.name, tenant: req.tenant, admins: await tenants.adminsOf(req.tenant.id), history: await platform.recentAudit(30, req.tenant.id), isDefault: req.tenant.id === tenants.DEFAULT_ID, ...extra }, status);
  router.get('/tenants/:id', needLogin, load, async (req, res, next) => { try { await show(req, res); } catch (e) { next(e); } });
  const act = (action, fn) => [needLogin, needToken, load, async (req, res, next) => {
    try {
      const detail = await fn(req);
      await platform.audit(req, req.operator, action, { tenant: req.tenant, detail });
      res.redirect(`/tenants/${req.tenant.id}?done=${encodeURIComponent(action)}`);
    } catch (err) { if (err instanceof tenants.TenantError) return show(req, res, { error: err.message }, 400); next(err); }
  }];
  router.post('/tenants/:id/rename', ...act('tenant.renamed', async (req) => `${req.tenant.name} -> ${await tenants.rename(req.tenant.id, req.body.name)}`));
  router.post('/tenants/:id/hosts', ...act('tenant.host_added', async (req) => {
    const h = tenants.checkHost(req.body.host);
    if (h === cfg.host) throw new tenants.TenantError('That host name is the console\'s own.');
    return `added ${await tenants.addHost(req.tenant.id, h)}`;
  }));
  router.post('/tenants/:id/hosts/remove', ...act('tenant.host_removed', async (req) => { if (!(await tenants.removeHost(req.tenant.id, req.body.host))) throw new tenants.TenantError('That host name does not belong to this tenant.'); return `removed ${String(req.body.host).slice(0, 100)}`; }));
  router.post('/tenants/:id/status', ...act('tenant.status', async (req) => {
    const status = req.body.status === 'suspended' ? 'suspended' : 'active';
    await tenants.setStatus(req.tenant.id, status);
    return `${req.tenant.status} -> ${status}`;
  }));
  router.post('/tenants/:id/reset-admin', ...act('tenant.admin_password_reset', async (req) => {
    const user = await tenants.resetAdminPassword(req.tenant.id, req.body.username, req.body.password, req.operator.username);
    return `administrator ${user.username}`;
  }));

  router.get('/audit', needLogin, async (req, res, next) => { try { page(res, 'platform/audit', { title: 'Audit log', entries: await platform.recentAudit(200) }); } catch (e) { next(e); } });
  router.use((req, res) => page(res, 'platform/message', { title: 'Not found', message: 'There is no such page.', operator: req.operator }, 404));

  // Only this host, and only from the addresses allowed to reach it; any other request is the tenants' business (or a 404 on /login's paths of its own).
  return (req, res, next) => {
    if (tenants.hostOf(req) !== cfg.host) return next();
    if (!platform.ipAllowed(req.ip, cfg.allowedIps)) return res.status(404).type('text/plain').send('Not found');
    return router(req, res, next);
  };
}

module.exports = { mount };
