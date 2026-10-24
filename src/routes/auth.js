const { db } = require('../db');
const createAsyncRouter = require('../asyncRouter');
const mfa = require('../mfa');
const sso = require('../oidc');
const { checkPassword, hashPassword, verifyPassword, verifyAgainstNobody } = require('../passwords');
const lockout = require('../lockout');
const { audit } = require('../audit');

const router = createAsyncRouter();

const PENDING_MS = 10 * 60 * 1000;      // how long someone has to type the code after the password

function loginView(extra = {}) {
  return { title: 'Log In', error: null, sso: sso.enabled() ? { label: sso.config.buttonLabel } : null, localLogin: sso.policy.localLogin, ...extra };
}

// Signs the person in: a fresh session (so nothing from before sign-in carries over), then the page they were
// heading to. `via` is 'password' or 'sso'.
function establishSession(req, user, { remember = false, via = 'password' } = {}) {
  const returnTo = req.session.returnTo;
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.user = { id: user.id, username: user.username, full_name: user.full_name, role: user.role, theme_preference: user.theme_preference, via };
      if (remember) req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 30;
      resolve(returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/');
    });
  });
}

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', loginView());
});

router.post('/login', async (req, res) => {
  if (!sso.policy.localLogin) return res.status(403).render('login', loginView({ error: 'Sign in with your organisation account.' }));
  const { username, password } = req.body;
  const user = await db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(typeof username === 'string' ? username : '');
  // One answer for every way of failing (no such person, wrong password, account locked), 401 so the per-address limiter counts it.
  const refuse = () => res.status(401).render('login', loginView({ error: 'Invalid username or password.' }));
  if (!user) {
    await verifyAgainstNobody(password);                          // takes as long as a real check, so timing does not reveal who exists
    await audit(req, null, 'login.failed', { detail: 'no such account' });   // the typed name is not kept: people sometimes type a password there
    return refuse();
  }
  if (lockout.isLocked(user)) {
    await verifyAgainstNobody(password);
    await audit(req, null, 'login.refused', { targetType: 'user', targetId: user.id, targetName: user.username, detail: 'account is locked' });
    return refuse();
  }
  if (!(await verifyPassword(password, user.password_hash))) {
    const result = await lockout.recordFailure(user);
    await audit(req, null, result.locked ? 'login.locked' : 'login.failed', { targetType: 'user', targetId: user.id, targetName: user.username, detail: result.locked ? `locked until ${result.until} UTC after repeated wrong passwords` : 'wrong password' });
    return refuse();
  }
  await lockout.clearFailures(user.id);
  if (await mfa.isEnabled(user.id)) {
    // Password right, but not signed in yet: the code comes next.
    const returnTo = req.session.returnTo;
    await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
    req.session.returnTo = returnTo;
    req.session.pendingMfa = { userId: user.id, remember: Boolean(req.body.remember), at: Date.now() };
    return res.redirect('/login/mfa');
  }
  const dest = await establishSession(req, user, { remember: Boolean(req.body.remember) });
  await audit(req, user, 'login.success', { targetType: 'user', targetId: user.id, targetName: user.username, detail: 'password' });
  res.redirect(dest);
});

const pendingMfa = (req) => {
  const p = req.session.pendingMfa;
  return p && Date.now() - p.at < PENDING_MS ? p : null;
};

router.get('/login/mfa', (req, res) => {
  if (!pendingMfa(req)) return res.redirect('/login');
  res.render('login-mfa', { title: 'Verify it is you', error: null });
});

router.post('/login/mfa', async (req, res) => {
  const pending = pendingMfa(req);
  if (!pending) return res.redirect('/login');
  const locked = mfa.lockedUntil(pending.userId);
  if (locked) {
    return res.status(429).render('login-mfa', { title: 'Verify it is you', error: `Too many wrong codes. Try again in ${Math.max(1, Math.ceil((locked - Date.now()) / 60000))} minutes, or use a recovery code from an administrator.` });
  }
  const user = await db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(pending.userId);
  const result = user ? await mfa.verifyLogin(pending.userId, req.body.code) : { ok: false };
  if (!result.ok) {
    const count = mfa.recordFailure(pending.userId);
    if (count === mfa.FAILURE_LIMIT) await audit(req, null, 'mfa.locked', { targetType: 'user', targetId: pending.userId, targetName: user && user.username, detail: `${count} wrong codes in a row` });
    return res.status(401).render('login-mfa', { title: 'Verify it is you', error: 'That code is not right. Check your authenticator app and try again.' });
  }
  mfa.clearFailures(pending.userId);
  req.session.pendingMfa = null;
  const dest = await establishSession(req, user, { remember: pending.remember });
  await audit(req, user, 'login.success', { targetType: 'user', targetId: user.id, targetName: user.username, detail: result.usedRecoveryCode ? 'password and recovery code' : 'password and one-time code' });
  if (result.usedRecoveryCode) req.session.notice = `You signed in with a recovery code. ${result.recoveryCodesLeft} left; make new ones under Two-step verification.`;
  res.redirect(dest);
});

// ---- single sign-on (OpenID Connect)
const ssoFailure = (res, status, message) => res.status(status).render('login', loginView({ error: message }));

router.get('/auth/oidc/start', async (req, res) => {
  if (!sso.enabled()) return res.status(404).render('error', { title: 'Not Found', message: 'Page not found.' });
  if (req.session.user) return res.redirect('/');
  try {
    const { redirectTo, saved } = await sso.beginLogin();
    req.session.oidc = saved;
    req.session.save((err) => (err ? ssoFailure(res, 500, 'Could not start sign-in. Try again.') : res.redirect(redirectTo)));
  } catch (err) {
    if (err instanceof sso.SsoError) return ssoFailure(res, 502, err.message);
    console.error('[SSO] start failed:', err);
    ssoFailure(res, 500, 'Could not start sign-in. Try again.');
  }
});

router.get('/auth/oidc/callback', async (req, res) => {
  if (!sso.enabled()) return res.status(404).render('error', { title: 'Not Found', message: 'Page not found.' });
  const saved = req.session.oidc;
  delete req.session.oidc;                                  // each attempt can be completed once
  const { code, state, error } = req.query;
  if (error) {
    console.warn(`[SSO] sign-in refused at the provider: ${String(error).slice(0, 80)} ${String(req.query.error_description || '').slice(0, 200)}`.trim());
    return ssoFailure(res, 401, 'The sign-in was cancelled or refused by your identity provider.');
  }
  if (!saved || typeof state !== 'string' || state !== saved.state || Date.now() - saved.at > PENDING_MS) {
    return ssoFailure(res, 400, 'That sign-in link has expired or was not started here. Start again.');
  }
  if (typeof code !== 'string' || !code) return ssoFailure(res, 400, 'The identity provider did not send a sign-in code. Start again.');
  try {
    const claims = await sso.completeLogin({ code, saved });
    const { user, linked, created } = await sso.resolveUser(claims);
    const dest = await establishSession(req, user, { via: 'sso' });
    if (created) await audit(req, user, 'sso.created', { targetType: 'user', targetId: user.id, targetName: user.username, detail: `account created on first sign-in (role ${user.role})` });
    else if (linked) await audit(req, user, 'sso.linked', { targetType: 'user', targetId: user.id, targetName: user.username, detail: 'linked to the identity provider by email' });
    await audit(req, user, 'login.success', { targetType: 'user', targetId: user.id, targetName: user.username, detail: 'single sign-on' });
    res.redirect(dest);
  } catch (err) {
    if (err instanceof sso.SsoError) return ssoFailure(res, 401, err.message);
    console.error('[SSO] sign-in failed:', err);
    ssoFailure(res, 500, 'Sign-in failed. Try again, or ask an administrator.');
  }
});

router.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/');
  if (!sso.policy.localLogin) return res.redirect('/login');
  res.render('register', { error: null, title: 'Create Account', form: {} });
});

router.post('/register', async (req, res) => {
  if (!sso.policy.localLogin) return res.status(403).render('login', loginView({ error: 'Sign in with your organisation account.' }));
  const b = req.body;
  const form = { full_name: b.full_name, username: b.username, email: b.email, department: b.department };

  if (!b.full_name || !b.username || !b.password) {
    return res.render('register', { error: 'Full name, username, and password are required.', title: 'Create Account', form });
  }
  const weak = checkPassword(b.password, { username: b.username, email: b.email, fullName: b.full_name });
  if (weak) return res.render('register', { error: weak, title: 'Create Account', form });
  if (b.password !== b.confirm_password) {
    return res.render('register', { error: 'Password and confirmation do not match.', title: 'Create Account', form });
  }

  try {
    await db.prepare(`
      INSERT INTO users (username, password_hash, full_name, email, role, department)
      VALUES (?, ?, ?, ?, 'user', ?)
    `).run(b.username, await hashPassword(b.password), b.full_name, b.email || null, b.department || null);
  } catch (e) {
    return res.render('register', { error: 'That username is already taken.', title: 'Create Account', form });
  }

  const user = await db.prepare('SELECT * FROM users WHERE username = ?').get(b.username);
  await audit(req, user, 'user.registered', { targetType: 'user', targetId: user.id, targetName: user.username, detail: 'self-registration (end user)' });
  res.redirect(await establishSession(req, user));
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
