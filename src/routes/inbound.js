// Inbound email, for the administrator: is the mailbox being read, what became of each message, and a button to look now.
// The other way in, POST /api/inbound/email (for a mail system that hands messages over), is in src/inbound/intake.js.
const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const createAsyncRouter = require('../asyncRouter');
const { inboundConfig } = require('../settings');
const poller = require('../inbound/imapPoller');
const { audit } = require('../audit');

const router = createAsyncRouter();
router.use(requireAuth, requireRole('admin'));
const cfg = inboundConfig(process.env);

async function view(extra = {}) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const counts = Object.fromEntries((await db.prepare('SELECT outcome, COUNT(*) AS c FROM inbound_emails WHERE received_at >= ? GROUP BY outcome').all(since)).map((r) => [r.outcome, r.c]));
  const rows = await db.prepare('SELECT * FROM inbound_emails ORDER BY id DESC LIMIT 50').all();
  const numbers = new Map((await db.prepare("SELECT id, number FROM incidents WHERE id IN (SELECT record_id FROM (SELECT record_id FROM inbound_emails WHERE record_id IS NOT NULL ORDER BY id DESC LIMIT 50) x)").all()).map((r) => [r.id, r.number]));
  return {
    title: 'Inbound email', cfg: { ...cfg, imap: cfg.imap ? { ...cfg.imap, pass: undefined } : null, secret: undefined, hasSecret: Boolean(cfg.secret) },
    status: poller.state(), counts, rows: rows.map((r) => ({ ...r, number: numbers.get(r.record_id) || null })), notice: null, ...extra,
  };
}

router.get('/', async (req, res) => res.render('inbound/index', await view()));

router.post('/check', async (req, res) => {
  const started = await poller.checkNow();
  await audit(req, req.session.user, 'inbound.checked', { detail: started ? 'asked the mailbox to be read now' : 'no mailbox is set up' });
  res.render('inbound/index', await view({ notice: started ? 'The mailbox was read.' : 'No mailbox is set up on this server (INBOUND_IMAP_HOST).' }));
});

module.exports = router;
