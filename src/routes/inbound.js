// Inbound email, for the administrator: the mailbox this workspace's help desk reads (or the installation's, for the default tenant), the address a
// mail system can hand messages to, what became of each message, and a button to look now. Settings are in src/inboundSettings.js; the poller for a
// tenant's own mailbox is src/inbound/tenantPoller.js; the HTTP address is in src/inbound/intake.js.
const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const createAsyncRouter = require('../asyncRouter');
const { inboundConfig } = require('../settings');
const poller = require('../inbound/imapPoller');
const tenantPoller = require('../inbound/tenantPoller');
const inboundSettings = require('../inboundSettings');
const tenancy = require('../tenancy');
const { audit } = require('../audit');

const router = createAsyncRouter();
router.use(requireAuth, requireRole('admin'));
const serverCfg = inboundConfig(process.env);

// What applies to this workspace: its own settings, else (default tenant) the server's, else nothing.
async function effective() {
  const t = await inboundSettings.forTenant();
  if (t && t.mailbox) return { source: 'tenant', cfg: t.cfg, status: tenantPoller.stateFor(tenancy.currentId()) };
  if (tenancy.currentId() === 1 && serverCfg.imap) return { source: 'server', cfg: serverCfg, status: poller.state() };
  return { source: t ? 'tenant' : 'none', cfg: t ? t.cfg : inboundConfig({}), status: tenantPoller.stateFor(tenancy.currentId()) };
}

async function view(extra = {}) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const counts = Object.fromEntries((await db.prepare('SELECT outcome, COUNT(*) AS c FROM inbound_emails WHERE received_at >= ? GROUP BY outcome').all(since)).map((r) => [r.outcome, r.c]));
  const rows = await db.prepare('SELECT * FROM inbound_emails ORDER BY id DESC LIMIT 50').all();
  const numbers = new Map((await db.prepare("SELECT id, number FROM incidents WHERE id IN (SELECT record_id FROM (SELECT record_id FROM inbound_emails WHERE record_id IS NOT NULL ORDER BY id DESC LIMIT 50) x)").all()).map((r) => [r.id, r.number]));
  const e = await effective();
  const s = await inboundSettings.get();
  return {
    title: 'Inbound email', source: e.source, cfg: { ...e.cfg, imap: e.cfg.imap ? { ...e.cfg.imap, pass: undefined } : null, secret: undefined },
    httpOn: e.source === 'server' ? Boolean(serverCfg.secret) : s.hasToken, serverHttp: tenancy.currentId() === 1 && Boolean(serverCfg.secret),
    status: e.status, counts, rows: rows.map((r) => ({ ...r, number: numbers.get(r.record_id) || null })), notice: null, error: null, s, form: null, newToken: null,
    groups: inboundSettings.GROUPS, ports: inboundSettings.PORTS, serverMailbox: tenancy.currentId() === 1 && Boolean(serverCfg.imap), ...extra,
  };
}

router.get('/', async (req, res) => {
  const notice = req.session.inboundNotice || null; delete req.session.inboundNotice;
  res.render('inbound/index', await view({ notice }));
});

router.post('/check', async (req, res) => {
  const e = await effective();
  const started = e.source === 'tenant' ? await tenantPoller.checkNow() : await poller.checkNow();
  await audit(req, req.session.user, 'inbound.checked', { detail: started ? 'asked the mailbox to be read now' : 'no mailbox is set up' });
  res.render('inbound/index', await view({ notice: started ? 'The mailbox was read.' : 'No mailbox is set up yet.' }));
});

router.post('/mailbox', async (req, res) => {
  let v;
  try { v = await inboundSettings.validate(req.body, await db.prepare('SELECT imap_password_enc FROM inbound_settings WHERE tenant_id = nd_tenant()').get()); } catch (err) {
    if (!(err instanceof inboundSettings.InboundSettingsError)) throw err;
    return res.status(400).render('inbound/index', await view({ error: err.message, form: req.body }));
  }
  const detail = await inboundSettings.save(v, req.session.user);
  await audit(req, req.session.user, 'inbound.settings_changed', { targetType: 'inbound', detail });
  req.session.inboundNotice = detail === 'saved without changes' ? 'Nothing changed.' : 'Saved.';
  res.redirect('/settings/inbound');
});

// The address a mail system hands messages to (POST /api/inbound/email) is protected by a token of this workspace's own, shown once.
router.post('/token', async (req, res) => {
  const token = await inboundSettings.createToken(req.session.user);
  await audit(req, req.session.user, 'inbound.token_created', { targetType: 'inbound', detail: `prefix ${token.slice(0, 8)}` });
  res.render('inbound/index', await view({ newToken: token, notice: 'The address now needs this token. It is shown only now: copy it into the mail system.' }));
});
router.post('/token/revoke', async (req, res) => {
  const done = await inboundSettings.revokeToken(req.session.user);
  if (done) await audit(req, req.session.user, 'inbound.token_revoked', { targetType: 'inbound' });
  req.session.inboundNotice = done ? 'The token was revoked: the address no longer accepts mail for this workspace.' : 'There was no token.';
  res.redirect('/settings/inbound');
});

module.exports = router;
