// Single sign-on, for the administrator of a tenant: the provider (OpenID Connect: Microsoft Entra ID, Google, Okta and others), the
// client ID and secret, who may be made an account, and a test of the connection. The settings and how they are checked are in
// src/ssoSettings.js; the secret is kept encrypted and never shown again.
const { requireAuth, requireRole } = require('../middleware/auth');
const createAsyncRouter = require('../asyncRouter');
const { audit } = require('../audit');
const ssoSettings = require('../ssoSettings');
const oidc = require('../oidc');
const tenancy = require('../tenancy');
const { db } = require('../db');
const { authPolicy } = require('../settings');

const router = createAsyncRouter();
router.use(requireAuth, requireRole('admin'));

async function view(req, extra = {}) {
  const env = authPolicy(process.env).oidc;
  return { title: 'Single sign-on', s: await ssoSettings.get(), redirectUri: ssoSettings.redirectUriFor(req), serverSso: env.enabled && tenancy.currentId() === 1 ? { issuer: env.issuer, label: env.buttonLabel } : null,
    peopleLinked: Number((await db.prepare('SELECT COUNT(*) AS c FROM user_identities').get()).c), error: null, notice: null, test: null, form: null, privateAllowed: ssoSettings.allowPrivate(), ...extra };
}

router.get('/', async (req, res) => {
  const notice = req.session.ssoNotice || null; delete req.session.ssoNotice;
  res.render('sso/index', await view(req, { notice }));
});

router.post('/', async (req, res) => {
  let v;
  try { v = await ssoSettings.validate(req.body, await db.prepare('SELECT client_secret_enc FROM sso_settings WHERE tenant_id = nd_tenant()').get()); } catch (err) {
    if (!(err instanceof ssoSettings.SsoSettingsError)) throw err;
    const s = await ssoSettings.get();
    return res.status(400).render('sso/index', await view(req, { error: err.message, form: req.body, s: { ...s, hasSecret: s.hasSecret } }));
  }
  const detail = await ssoSettings.save(v, req.session.user);
  await audit(req, req.session.user, 'sso.settings_changed', { targetType: 'sso', detail });
  req.session.ssoNotice = detail === 'saved without changes' ? 'Nothing changed.' : 'Saved.';
  res.redirect('/settings/sso');
});

// Does the provider answer at the saved issuer address? (Nothing is signed in and no secret is sent.)
router.post('/test', async (req, res) => {
  const s = await ssoSettings.get();
  let test;
  if (!s.issuer) test = { ok: false, text: 'Save an issuer address first.' };
  else {
    try { const r = await oidc.probe(s.issuer); test = { ok: true, text: `The provider answered. Sign-in page: ${r.authorization_endpoint}; token address: ${r.token_endpoint}; ${r.keyCount} signing key${r.keyCount === 1 ? '' : 's'}.` }; }
    catch (err) { test = { ok: false, text: err.message || 'The provider could not be reached.' }; }
  }
  await audit(req, req.session.user, 'sso.connection_tested', { targetType: 'sso', detail: test.ok ? 'answered' : 'failed' });
  res.render('sso/index', await view(req, { test }));
});

module.exports = router;
