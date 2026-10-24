const { db, nextNumber, logActivity, nowStr } = require('../db');
const slaService = require('../slaService');
const { requireAuth, requireRole } = require('../middleware/auth');
const { REQUEST_STATUS_LABELS, escapeHtml } = require('../helpers');
const { sendNotification } = require('../mailer');
const createAsyncRouter = require('../asyncRouter');
const { requireFields } = require('../validate');

const router = createAsyncRouter();

router.get('/', requireAuth, async (req, res) => {
  const items = await db.prepare(`SELECT * FROM catalog_items WHERE active = 1 ORDER BY category, name`).all();
  res.render('catalog/browse', { title: 'Service Catalog', items });
});

router.get('/manage', requireAuth, requireRole('admin'), async (req, res) => {
  const items = await db.prepare(`SELECT * FROM catalog_items ORDER BY category, name`).all();
  res.render('catalog/manage', { title: 'Manage Catalog', items });
});

router.post('/manage', requireAuth, requireRole('admin'), async (req, res) => {
  if (!requireFields(req, res, [['name', 'Name']])) return;
  const b = req.body;
  await db.prepare(`
    INSERT INTO catalog_items (name, description, category, icon, fulfillment_group)
    VALUES (?, ?, ?, ?, ?)
  `).run(b.name, b.description || null, b.category || 'general', b.icon || 'bi-box-seam', b.fulfillment_group || null);
  res.redirect('/catalog/manage');
});

router.post('/manage/:id/toggle', requireAuth, requireRole('admin'), async (req, res) => {
  await db.prepare('UPDATE catalog_items SET active = 1 - active WHERE id = ?').run(req.params.id);
  res.redirect('/catalog/manage');
});

router.get('/:id/request', requireAuth, async (req, res) => {
  const item = await db.prepare('SELECT * FROM catalog_items WHERE id = ? AND active = 1').get(req.params.id);
  if (!item) return res.status(404).render('error', { title: 'Not Found', message: 'Catalog item not found.' });
  res.render('catalog/request-form', { title: `Request: ${item.name}`, item });
});

router.post('/:id/request', requireAuth, async (req, res) => {
  const item = await db.prepare('SELECT * FROM catalog_items WHERE id = ? AND active = 1').get(req.params.id);
  if (!item) return res.status(404).render('error', { title: 'Not Found', message: 'Catalog item not found.' });

  const number = await nextNumber('request', 'REQ');
  // The SLA clock, when the request SLA is switched on (SLA settings); otherwise the columns stay empty.
  const createdAt = nowStr();
  const clock = (await slaService.newRequestClock(createdAt)) || {};
  const info = await db.prepare(`
    INSERT INTO service_requests (number, catalog_item_id, requested_by, notes, assignment_group, created_at,
      sla_started_at, sla_target_minutes, sla_clock, sla_warn_percent, sla_due_at)
    VALUES (@number, @catalog_item_id, @requested_by, @notes, @assignment_group, @created_at,
      @sla_started_at, @sla_target_minutes, @sla_clock, @sla_warn_percent, @sla_due_at)
    RETURNING id
  `).run({
    number, catalog_item_id: item.id, requested_by: req.session.user.id, notes: req.body.notes || null,
    assignment_group: item.fulfillment_group || null, created_at: createdAt,
    sla_started_at: clock.sla_started_at || null, sla_target_minutes: clock.sla_target_minutes || null, sla_clock: clock.sla_clock || null,
    sla_warn_percent: clock.sla_warn_percent || null, sla_due_at: clock.sla_due_at || null
  });

  await logActivity('request', info.lastInsertRowid, req.session.user.id, 'Request submitted');

  const requester = await db.prepare('SELECT full_name, email, email_notifications FROM users WHERE id = ?').get(req.session.user.id);
  if (requester && requester.email && requester.email_notifications) {
    sendNotification({
      to: requester.email,
      toName: requester.full_name,
      subject: `[${number}] Request submitted: ${item.name}`,
      html: `<p>Hi ${escapeHtml(requester.full_name)},</p><p>Your request <strong>${number}</strong> for <strong>${escapeHtml(item.name)}</strong> has been submitted${item.fulfillment_group ? ` to ${escapeHtml(item.fulfillment_group)}` : ''}.</p><p>We'll keep you updated as it's fulfilled.</p>`,
      relatedType: 'request',
      relatedId: info.lastInsertRowid
    }).catch(() => {});
  }

  res.redirect(`/requests/${info.lastInsertRowid}`);
});

module.exports = router;
