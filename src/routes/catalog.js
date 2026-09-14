const express = require('express');
const { db, nextNumber, logActivity } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { REQUEST_STATUS_LABELS, escapeHtml } = require('../helpers');
const { sendNotification } = require('../mailer');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const items = db.prepare(`SELECT * FROM catalog_items WHERE active = 1 ORDER BY category, name`).all();
  res.render('catalog/browse', { title: 'Service Catalog', items });
});

router.get('/manage', requireAuth, requireRole('admin'), (req, res) => {
  const items = db.prepare(`SELECT * FROM catalog_items ORDER BY category, name`).all();
  res.render('catalog/manage', { title: 'Manage Catalog', items });
});

router.post('/manage', requireAuth, requireRole('admin'), (req, res) => {
  const b = req.body;
  db.prepare(`
    INSERT INTO catalog_items (name, description, category, icon, fulfillment_group)
    VALUES (?, ?, ?, ?, ?)
  `).run(b.name, b.description || null, b.category || 'general', b.icon || 'bi-box-seam', b.fulfillment_group || null);
  res.redirect('/catalog/manage');
});

router.post('/manage/:id/toggle', requireAuth, requireRole('admin'), (req, res) => {
  db.prepare('UPDATE catalog_items SET active = 1 - active WHERE id = ?').run(req.params.id);
  res.redirect('/catalog/manage');
});

router.get('/:id/request', requireAuth, (req, res) => {
  const item = db.prepare('SELECT * FROM catalog_items WHERE id = ? AND active = 1').get(req.params.id);
  if (!item) return res.status(404).render('error', { title: 'Not Found', message: 'Catalog item not found.' });
  res.render('catalog/request-form', { title: `Request: ${item.name}`, item });
});

router.post('/:id/request', requireAuth, (req, res) => {
  const item = db.prepare('SELECT * FROM catalog_items WHERE id = ? AND active = 1').get(req.params.id);
  if (!item) return res.status(404).render('error', { title: 'Not Found', message: 'Catalog item not found.' });

  const number = nextNumber('request', 'REQ');
  const info = db.prepare(`
    INSERT INTO service_requests (number, catalog_item_id, requested_by, notes)
    VALUES (?, ?, ?, ?)
  `).run(number, item.id, req.session.user.id, req.body.notes || null);

  logActivity('request', info.lastInsertRowid, req.session.user.id, 'Request submitted');

  const requester = db.prepare('SELECT full_name, email FROM users WHERE id = ?').get(req.session.user.id);
  if (requester && requester.email) {
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
