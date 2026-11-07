// Outgoing email, for the administrator of a tenant: the mail server and sender this workspace's notices go out through, instead of the
// installation's. Settings and how they are checked are in src/mailSettings.js; the password is kept encrypted and never shown again.
const { requireAuth, requireRole } = require('../middleware/auth');
const createAsyncRouter = require('../asyncRouter');
const { audit } = require('../audit');
const mailSettings = require('../mailSettings');
const mailer = require('../mailer');
const { describeError } = require('../mailTransport');
const { db } = require('../db');

const router = createAsyncRouter();
router.use(requireAuth, requireRole('admin'));

async function view(req, extra = {}) {
  return { title: 'Email settings', s: await mailSettings.get(), now: await mailer.mailSummary(), privateAllowed: mailSettings.allowPrivate(), ports: mailSettings.PORTS, error: null, notice: null, test: null, form: null, ...extra };
}

router.get('/', async (req, res) => {
  const notice = req.session.mailNotice || null; delete req.session.mailNotice;
  res.render('mail/index', await view(req, { notice }));
});

router.post('/', async (req, res) => {
  let v;
  try { v = await mailSettings.validate(req.body, await db.prepare('SELECT password_enc FROM mail_settings WHERE tenant_id = nd_tenant()').get()); } catch (err) {
    if (!(err instanceof mailSettings.MailSettingsError)) throw err;
    return res.status(400).render('mail/index', await view(req, { error: err.message, form: req.body }));
  }
  const detail = await mailSettings.save(v, req.session.user);
  await audit(req, req.session.user, 'mail.settings_changed', { targetType: 'mail', detail });
  req.session.mailNotice = detail === 'saved without changes' ? 'Nothing changed.' : 'Saved. Emails sent from now on use these settings.';
  res.redirect('/settings/mail');
});

// Does the saved mail server answer and accept the sign-in? Nothing is sent. (To send a real message: Notifications > Send a test email to me.)
router.post('/test', async (req, res) => {
  const cfg = await mailSettings.forTenant();
  let test;
  if (!cfg) test = { ok: false, text: 'Switch the settings on and save them first: this tests the saved settings.' };
  else {
    try { await mailer.verifyConnection(cfg); test = { ok: true, text: `The mail server ${cfg.host}:${cfg.port} answered${cfg.user ? ' and accepted the sign-in' : ''}.` }; }
    catch (err) { test = { ok: false, text: `The mail server did not accept the connection: ${describeError(err, cfg).replace(cfg.pass || '\u0000', '***')}` }; }
  }
  await audit(req, req.session.user, 'mail.connection_tested', { targetType: 'mail', detail: test.ok ? 'answered' : 'failed' });
  res.render('mail/index', await view(req, { test }));
});

module.exports = router;
