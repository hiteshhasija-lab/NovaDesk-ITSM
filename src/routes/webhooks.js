// Webhooks (administrators): where NovaDesk sends events, a test button, and the log of what was sent.
const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const createAsyncRouter = require('../asyncRouter');
const webhooks = require('../webhooks');
const { audit } = require('../audit');
const { WebhookUrlError } = require('../webhookNet');
const { requireFields } = require('../validate');

const router = createAsyncRouter();
router.use(requireAuth, requireRole('admin'));

async function view(req, extra = {}) {
  const hooks = await db.prepare(`
    SELECT w.*,
      (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.status = 'delivered' AND d.delivered_at >= ?) AS delivered_day,
      (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.status = 'pending') AS pending,
      (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.status = 'failed' AND d.created_at >= ?) AS failed_day
    FROM webhooks w ORDER BY w.id
  `).all(...Array(2).fill(new Date(Date.now() - 86400000).toISOString().slice(0, 19).replace('T', ' ')));
  const filter = Number(req.query.webhook) || null;
  const deliveries = await db.prepare(`
    SELECT d.id, d.webhook_id, d.event_type, d.status, d.attempts, d.last_status_code, d.last_error, d.created_at, d.delivered_at, w.name AS webhook_name
    FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id ${filter ? 'WHERE d.webhook_id = ?' : ''} ORDER BY d.id DESC LIMIT 50
  `).all(...(filter ? [filter] : []));
  return {
    title: 'Webhooks', hooks, deliveries, filter, records: webhooks.RECORDS, eventTypes: webhooks.EVENT_TYPES, operations: webhooks.OPERATIONS,
    allowPrivate: webhooks.allowPrivate(), max: webhooks.MAX_WEBHOOKS, error: null, success: null, newSecret: null, form: {}, ...extra,
  };
}

router.get('/', async (req, res) => res.render('webhooks/index', await view(req)));

router.post('/', async (req, res) => {
  if (!requireFields(req, res, [['name', 'Name'], ['url', 'Address']])) return;
  const form = { name: String(req.body.name).trim().slice(0, 80), url: String(req.body.url).trim(), events: [].concat(req.body.events || []) };
  try {
    const made = await webhooks.createWebhook(req.session.user, form);
    await audit(req, req.session.user, 'webhook.created', { targetType: 'webhook', targetId: made.id, targetName: form.name, detail: `${form.url}; events: ${form.events.join(', ')}` });
    res.render('webhooks/index', await view(req, { newSecret: made.secret, success: `Webhook "${form.name}" added. Copy the signing secret now: it is shown only this once.` }));
  } catch (err) {
    if (!(err instanceof WebhookUrlError)) throw err;
    res.status(400).render('webhooks/index', await view(req, { error: err.message, form }));
  }
});

router.post('/:id/toggle', async (req, res) => {
  const hook = await db.prepare('SELECT id, active FROM webhooks WHERE id = ?').get(Number(req.params.id) || 0);
  if (!hook) return res.status(404).render('error', { title: 'Not Found', message: 'Webhook not found.' });
  await webhooks.setActive(hook.id, !hook.active);
  await audit(req, req.session.user, 'webhook.toggled', { targetType: 'webhook', targetId: hook.id, detail: hook.active ? 'switched off' : 'switched on' });
  res.render('webhooks/index', await view(req, { success: hook.active ? 'Webhook switched off.' : 'Webhook switched on.' }));
});

router.post('/:id/test', async (req, res) => {
  const result = await webhooks.sendTest(Number(req.params.id) || 0);
  if (!result) return res.status(404).render('error', { title: 'Not Found', message: 'Webhook not found.' });
  res.render('webhooks/index', await view(req, result.ok ? { success: `Test delivered: the receiver answered ${result.status}.` } : { error: `Test failed: ${result.error}` }));
});

router.post('/:id/rotate', async (req, res) => {
  const secret = await webhooks.rotateSecret(Number(req.params.id) || 0);
  if (!secret) return res.status(404).render('error', { title: 'Not Found', message: 'Webhook not found.' });
  await audit(req, req.session.user, 'webhook.secret_replaced', { targetType: 'webhook', targetId: Number(req.params.id) });
  res.render('webhooks/index', await view(req, { newSecret: secret, success: 'New signing secret made. The old one stopped working; give the new one to the receiver. It is shown only this once.' }));
});

router.post('/:id/delete', async (req, res) => {
  const gone = await db.prepare('SELECT id, name, url FROM webhooks WHERE id = ?').get(Number(req.params.id) || 0);
  await db.prepare('DELETE FROM webhooks WHERE id = ?').run(Number(req.params.id) || 0);
  if (gone) await audit(req, req.session.user, 'webhook.deleted', { targetType: 'webhook', targetId: gone.id, targetName: gone.name, detail: gone.url });
  res.render('webhooks/index', await view(req, { success: 'Webhook deleted, with its delivery log.' }));
});

router.get('/deliveries/:id', async (req, res) => {
  const d = await db.prepare('SELECT d.*, w.name AS webhook_name, w.url FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.id = ?').get(Number(req.params.id) || 0);
  if (!d) return res.status(404).render('error', { title: 'Not Found', message: 'Delivery not found.' });
  let pretty = d.payload; try { pretty = JSON.stringify(JSON.parse(d.payload), null, 2); } catch { /* show as stored */ }
  res.render('webhooks/delivery', { title: `Delivery ${d.id}`, d, pretty });
});

router.post('/deliveries/:id/retry', async (req, res) => {
  const id = Number(req.params.id) || 0;
  const ok = await webhooks.retryDelivery(id);
  res.render('webhooks/index', await view(req, ok ? { success: 'Delivery queued again; it is sent within a few seconds.' } : { error: 'Only a failed delivery can be retried.' }));
});

module.exports = router;
