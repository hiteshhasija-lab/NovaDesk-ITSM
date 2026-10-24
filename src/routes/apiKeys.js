// Personal API keys for the signed-in person: make one (shown once), see them, revoke them.
const { requireAuth } = require('../middleware/auth');
const createAsyncRouter = require('../asyncRouter');
const apiKeys = require('../apiKeys');
const { requireFields } = require('../validate');

const router = createAsyncRouter();
router.use(requireAuth);

const EXPIRY_DAYS = { '30': 30, '90': 90, '365': 365, never: 0 };

async function view(req, extra = {}) {
  return { title: 'API keys', keys: await apiKeys.listKeys(req.session.user.id), max: apiKeys.MAX_KEYS_PER_USER, publicUrl: (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, ''), newKey: null, error: null, success: null, ...extra };
}

router.get('/', async (req, res) => res.render('profile-api-keys', await view(req)));

router.post('/', async (req, res) => {
  if (!requireFields(req, res, [['name', 'Name']])) return;
  const name = String(req.body.name).trim().slice(0, 80);
  const days = EXPIRY_DAYS[req.body.expires] ?? 90;
  try {
    const made = await apiKeys.createKey(req.session.user.id, { name, scope: req.body.scope === 'write' ? 'write' : 'read', expiresInDays: days });
    res.render('profile-api-keys', await view(req, { newKey: made.token, success: 'API key made. Copy it now: it is shown only this once.' }));
  } catch (err) {
    if (err.code !== 'too_many_keys') throw err;
    res.status(400).render('profile-api-keys', await view(req, { error: err.message }));
  }
});

router.post('/:id/revoke', async (req, res) => {
  const ok = await apiKeys.revokeKey(req.session.user.id, Number(req.params.id) || 0);
  res.render('profile-api-keys', await view(req, ok ? { success: 'API key revoked. It stops working at once.' } : { error: 'That key was not found or is already revoked.' }));
});

module.exports = router;
