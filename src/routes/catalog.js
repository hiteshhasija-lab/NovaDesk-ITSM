const { db } = require('../db');
const requestActions = require('../requestActions');
const { requireAuth, requireRole } = require('../middleware/auth');
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
  const created = await requestActions.createServiceRequest({ actor: req.session.user, item, notes: req.body.notes });
  res.redirect(`/requests/${created.id}`);
});

module.exports = router;
