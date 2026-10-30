// SCIM provisioning, for the administrator: the address and tokens an identity provider needs, and the few choices that
// limit what it may do. The protocol itself is in src/scim/. Everything here is recorded in the audit log.
const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const createAsyncRouter = require('../asyncRouter');
const { audit } = require('../audit');
const tokens = require('../scim/tokens');
const settingsStore = require('../scim/settings');

const router = createAsyncRouter();
router.use(requireAuth, requireRole('admin'));

const publicUrl = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');

async function view(req, extra = {}) {
  const [list, settings, recent, managed] = await Promise.all([
    tokens.listTokens(),
    settingsStore.get(),
    db.prepare("SELECT * FROM audit_log WHERE action LIKE 'scim.%' ORDER BY id DESC LIMIT 20").all(),
    db.prepare('SELECT COUNT(*) AS c FROM users WHERE scim_managed = 1 AND anonymised_at IS NULL').get(),
  ]);
  return {
    title: 'SCIM provisioning', tokens: list, settings, recent, managed: Number(managed.c), maxTokens: tokens.MAX_ACTIVE,
    baseUrl: `${publicUrl || `${req.protocol}://${req.get('host')}`}/scim/v2`, urlIsGuess: !publicUrl,
    newToken: null, error: null, notice: null, ...extra,
  };
}

router.get('/', async (req, res) => res.render('scim/index', await view(req)));

router.post('/tokens', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).render('scim/index', await view(req, { error: 'Give the token a name, for example the provider it is for.' }));
  const days = req.body.expires === 'never' ? null : Number(req.body.expires);
  if (days !== null && ![90, 180, 365].includes(days)) return res.status(400).render('scim/index', await view(req, { error: 'Choose when the token expires.' }));
  let made;
  try { made = await tokens.createToken({ name, expiresInDays: days, createdBy: req.session.user.id }); } catch (err) {
    if (err.code === 'too_many_tokens') return res.status(400).render('scim/index', await view(req, { error: err.message }));
    throw err;
  }
  await audit(req, req.session.user, 'scim.token.created', { targetType: 'scim_token', targetId: made.id, targetName: name, detail: days ? `expires in ${days} days` : 'does not expire' });
  res.render('scim/index', await view(req, { newToken: { name, value: made.token } }));
});

router.post('/tokens/:id/revoke', async (req, res) => {
  const id = Number(req.params.id) || 0;
  const row = await db.prepare('SELECT id, name FROM scim_tokens WHERE id = ?').get(id);
  if (!row) return res.status(404).render('error', { title: 'Not Found', message: 'Token not found.' });
  if (await tokens.revokeToken(id)) await audit(req, req.session.user, 'scim.token.revoked', { targetType: 'scim_token', targetId: id, targetName: row.name });
  res.render('scim/index', await view(req, { notice: `The token "${row.name}" no longer works.` }));
});

router.post('/settings', async (req, res) => {
  const wanted = { allowAdmin: req.body.allow_admin === 'on', allowGroups: req.body.allow_groups === 'on', defaultRole: req.body.default_role };
  if (!['user', 'agent'].includes(wanted.defaultRole)) return res.status(400).render('scim/index', await view(req, { error: 'The default role must be user or agent.' }));
  const changed = await settingsStore.save(wanted);
  if (changed.length) await audit(req, req.session.user, 'scim.settings.changed', { detail: changed.join('; ') });
  res.render('scim/index', await view(req, { notice: changed.length ? 'Saved.' : 'Nothing changed.' }));
});

module.exports = router;
