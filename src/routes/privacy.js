// Privacy tools for administrators: what NovaDesk holds about a person (and a file that hands it over), anonymising a
// person, and how long logs and messages are kept. Everything here is recorded in the audit log.
const { db, nowStr } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const createAsyncRouter = require('../asyncRouter');
const { audit } = require('../audit');
const person = require('../privacy/person');
const retention = require('../privacy/retention');
const inactive = require('../privacy/inactive');
const { anonymise, refusal, PrivacyError } = require('../privacy/anonymise');
const { patternsFor, MIN_LENGTH } = require('../privacy/scrub');

const router = createAsyncRouter();
router.use(requireAuth, requireRole('admin'));

const like = (q) => `%${String(q).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

async function indexView(extra = {}) {
  const recent = await db.prepare("SELECT * FROM audit_log WHERE action LIKE 'privacy.%' OR action LIKE 'retention.%' ORDER BY id DESC LIMIT 15").all();
  const inactiveRule = await inactive.rule();
  return {
    title: 'Privacy', people: null, q: '', rules: await retention.rules(), min: retention.MIN_DAYS, max: retention.MAX_DAYS, errors: {}, values: null, notice: null, recent,
    inactiveRule, inactiveWaiting: await inactive.waiting(inactiveRule.days), inactiveError: null, inactiveValue: null, ...extra,
  };
}

router.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  const people = q
    ? await db.prepare('SELECT id, username, full_name, email, role, active, anonymised_at FROM users WHERE full_name ILIKE ? OR username ILIKE ? OR email ILIKE ? ORDER BY full_name LIMIT 25').all(like(q), like(q), like(q))
    : null;
  res.render('privacy/index', await indexView({ people, q }));
});

router.post('/retention', async (req, res) => {
  const submitted = {};
  for (const t of retention.TARGETS) submitted[t.id] = req.body[`days_${t.id}`];
  const result = await retention.save(submitted, { actor: req.session.user, req });
  if (Object.keys(result.errors).length) return res.status(400).render('privacy/index', await indexView({ errors: result.errors, values: submitted }));
  res.render('privacy/index', await indexView({ notice: result.changed.length ? 'Saved. Anything older than these limits is removed in the next daily run, or when you press "Run now".' : 'Nothing changed.' }));
});

router.post('/retention/run', async (req, res) => {
  const ran = await retention.sweep({ manual: true, actor: req.session.user, req });
  const total = ran.reduce((n, r) => n + r.removed, 0);
  res.render('privacy/index', await indexView({ notice: !ran.length ? 'No limit is set, so nothing was removed.' : `Done: ${total} record${total === 1 ? '' : 's'} removed (${ran.map((r) => `${r.label} ${r.removed}`).join(', ')}).` }));
});

// Anonymise accounts that have been switched off for a long time (src/privacy/inactive.js).
router.post('/inactive', async (req, res) => {
  const result = await inactive.save(req.body.inactive_days, { actor: req.session.user, req });
  if (result.error) return res.status(400).render('privacy/index', await indexView({ inactiveError: result.error, inactiveValue: req.body.inactive_days }));
  res.render('privacy/index', await indexView({ notice: result.changed ? 'Saved. Accounts switched off for longer than that are anonymised in the next daily run, or when you press "Anonymise now".' : 'Nothing changed.' }));
});

router.post('/inactive/run', async (req, res) => {
  const r = await inactive.sweep({ manual: true, actor: req.session.user, req });
  res.render('privacy/index', await indexView({ notice: !r.ran ? 'No rule is set, so nothing was anonymised.' : `Done: ${r.anonymised} account${r.anonymised === 1 ? '' : 's'} anonymised${r.skipped ? `, ${r.skipped} left alone` : ''}.` }));
});

async function personView(p, actor, extra = {}) {
  const why = await refusal(p, actor);
  const { patterns, skipped } = patternsFor(p, (await db.prepare('SELECT email FROM user_identities WHERE user_id = ? AND email IS NOT NULL').all(p.id)).map((r) => r.email));
  return { title: `Privacy: ${p.full_name}`, p, held: await person.counts(p), refuse: why, searched: patterns, skipped, minLength: MIN_LENGTH, error: null, ...extra };
}
const find = async (req, res) => {
  const p = await db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id) || 0);
  if (!p) res.status(404).render('error', { title: 'Not Found', message: 'User not found.' });
  return p;
};

router.get('/person/:id', async (req, res) => {
  const p = await find(req, res); if (!p) return;
  res.render('privacy/person', await personView(p, req.session.user));
});

// POST, not GET: it writes an audit entry, and a link that is followed by a browser's prefetch must not do that.
router.post('/person/:id/export', async (req, res) => {
  const p = await find(req, res); if (!p) return;
  const file = await person.exportPerson(p.id, { by: req.session.user.username, generatedAt: nowStr() });
  await audit(req, req.session.user, 'privacy.exported', { targetType: 'user', targetId: p.id, targetName: p.username, detail: 'all data held about the person downloaded' });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', `attachment; filename="novadesk-person-${p.id}-${nowStr().slice(0, 10).replace(/-/g, '')}.json"`);
  res.send(JSON.stringify(file, null, 2));
});

router.post('/person/:id/anonymise', async (req, res) => {
  const p = await find(req, res); if (!p) return;
  const again = async (error) => res.status(400).render('privacy/person', await personView(p, req.session.user, { error }));
  if (String(req.body.confirm || '').trim() !== p.username) return again('Type the username exactly as shown to confirm.');
  if (req.body.understand !== 'on') return again('Tick the box to say you understand that this cannot be undone.');
  try {
    const r = await anonymise(p.id, { actor: req.session.user, req, blankComments: req.body.blank_comments === 'on', deleteFiles: req.body.delete_files === 'on' });
    console.log(`[Privacy] ${req.session.user.username} anonymised user ${p.id} (${r.textChanged} text places cleaned)`);
  } catch (err) {
    if (err instanceof PrivacyError) return again(err.message);
    throw err;
  }
  res.redirect(`/privacy/person/${p.id}?done=1`);
});

module.exports = router;
