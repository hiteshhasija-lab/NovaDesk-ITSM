// "Where I am signed in": the person's own sessions, with a way to end any of them or all the others.
const { requireAuth } = require('../middleware/auth');
const createAsyncRouter = require('../asyncRouter');
const sessions = require('../sessionStore');
const { audit } = require('../audit');

const router = createAsyncRouter();
router.use(requireAuth);

async function view(req, extra = {}) {
  return { title: 'Where you are signed in', sessions: await sessions.listFor(req.session.user.id, req.sessionID), error: null, success: null, ...extra };
}

const NOTES = { one: 'Signed out of that device.', none: 'You were not signed in anywhere else.', missing: null };
router.get('/', async (req, res) => {
  const n = Number(req.query.others);
  const success = req.query.done === 'one' ? NOTES.one
    : Number.isInteger(n) && n >= 0 && req.query.done === 'others' ? (n ? `Signed out of ${n} other device${n === 1 ? '' : 's'}.` : NOTES.none) : null;
  res.render('profile-sessions', await view(req, { success, error: req.query.done === 'missing' ? 'That session was not found. It may already have ended.' : null }));
});

// Each action answers with a redirect back to the list, so reloading the page never repeats it.
router.post('/revoke-others', async (req, res) => {
  const ended = await sessions.revokeAll(req.session.user.id, req.sessionID);
  await audit(req, req.session.user, 'session.revoked_others', { targetType: 'user', targetId: req.session.user.id, targetName: req.session.user.username, detail: `${ended} other session${ended === 1 ? '' : 's'} ended by the person themselves` });
  res.redirect(`/profile/sessions?done=others&others=${ended}`);
});

router.post('/:id/revoke', async (req, res) => {
  const ok = await sessions.revokeOne(req.session.user.id, req.params.id);
  if (ok) await audit(req, req.session.user, 'session.revoked', { targetType: 'user', targetId: req.session.user.id, targetName: req.session.user.username, detail: 'one session ended by the person themselves' });
  res.redirect(`/profile/sessions?done=${ok ? 'one' : 'missing'}`);
});

module.exports = router;
