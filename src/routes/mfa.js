// Two-step verification for the signed-in person: turn it on, new recovery codes, turn it off.
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const createAsyncRouter = require('../asyncRouter');
const mfa = require('../mfa');
const qr = require('../qr');
const { audit } = require('../audit');
const { authPolicy } = require('../settings');

const router = createAsyncRouter();
router.use(requireAuth);
// These pages show the setup key and the recovery codes: neither the browser nor a proxy keeps a copy.
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const policy = authPolicy(process.env);

// What the page shows; each route renders it with `res.render('profile-mfa', ...)`.
async function view(req, extra = {}) {
  const user = await db.prepare('SELECT id, username, full_name, email, role FROM users WHERE id = ?').get(req.session.user.id);
  const state = await mfa.status(user.id);
  const setup = state.pending ? await mfa.pendingSetup(user).catch(() => null) : null;
  // Drawn here, so the key never goes to an outside QR service. Null if the link were ever too long: the typed key still works.
  if (setup) setup.qrSvg = qr.toSvg(setup.uri, { label: 'QR code for the NovaDesk setup key' });
  const required = mfa.requiredFor(policy, user.role) && req.session.user.via !== 'sso';
  return { title: 'Two-step verification', state, setup, required, forced: Boolean(req.query.required) && required && !state.enabled, error: null, success: null, recoveryCodes: null, ...extra };
}

router.get('/', async (req, res) => res.render('profile-mfa', await view(req)));

router.post('/setup', async (req, res) => {
  const user = await db.prepare('SELECT id, username, email FROM users WHERE id = ?').get(req.session.user.id);
  if (!(await mfa.isEnabled(user.id))) await mfa.beginSetup(user);
  res.redirect('/profile/mfa');
});

router.post('/cancel', async (req, res) => {
  if (!(await mfa.isEnabled(req.session.user.id))) await mfa.disable(req.session.user.id);
  res.redirect('/profile/mfa');
});

router.post('/confirm', async (req, res) => {
  const codes = await mfa.finishSetup(req.session.user.id, req.body.code);
  if (!codes) return res.status(400).render('profile-mfa', await view(req, { error: 'That code is not right. Check your authenticator app and try again.' }));
  await audit(req, req.session.user, 'mfa.enabled', { targetType: 'user', targetId: req.session.user.id, targetName: req.session.user.username });
  res.render('profile-mfa', await view(req, { success: 'Two-step verification is on.', recoveryCodes: codes }));
});

// A current code is needed to change anything that protects the account.
async function codeOk(req) {
  const result = await mfa.verifyLogin(req.session.user.id, req.body.code);
  return result.ok;
}

router.post('/recovery-codes', async (req, res) => {
  if (!(await mfa.isEnabled(req.session.user.id)) || !(await codeOk(req))) return res.status(400).render('profile-mfa', await view(req, { error: 'That code is not right, so the recovery codes were not changed.' }));
  const fresh = await mfa.replaceRecoveryCodes(req.session.user.id);
  await audit(req, req.session.user, 'mfa.recovery_codes_replaced', { targetType: 'user', targetId: req.session.user.id, targetName: req.session.user.username });
  res.render('profile-mfa', await view(req, { success: 'New recovery codes. The old ones no longer work.', recoveryCodes: fresh }));
});

router.post('/disable', async (req, res) => {
  const user = await db.prepare('SELECT id, password_hash, role FROM users WHERE id = ?').get(req.session.user.id);
  if (mfa.requiredFor(policy, user.role) && req.session.user.via !== 'sso') return res.status(403).render('profile-mfa', await view(req, { error: 'Your organisation requires two-step verification, so it cannot be turned off.' }));
  if (!bcrypt.compareSync(req.body.password || '', user.password_hash) || !(await codeOk(req))) {
    return res.status(400).render('profile-mfa', await view(req, { error: 'The password or the code is not right, so two-step verification is still on.' }));
  }
  await mfa.disable(user.id);
  await audit(req, req.session.user, 'mfa.disabled', { targetType: 'user', targetId: user.id, targetName: req.session.user.username, detail: 'turned off by the person themselves' });
  res.render('profile-mfa', await view(req, { success: 'Two-step verification is off.' }));
});

module.exports = router;
