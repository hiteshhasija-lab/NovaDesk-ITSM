const { db, nextNumber, nowStr } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { toCsv } = require('../helpers');
const { sortRows, paginate } = require('../listquery');
const createAsyncRouter = require('../asyncRouter');

const router = createAsyncRouter();

const KB_SORT_COLUMNS = {
  updated_at: r => r.updated_at,
  title: r => r.title,
  view_count: r => r.view_count
};

router.get('/', requireAuth, async (req, res) => {
  const isStaff = ['admin', 'agent'].includes(req.session.user.role);
  const { q, category } = req.query;

  let where = [isStaff ? "1=1" : "status = 'published'"];
  let params = [];
  if (q) { where.push('(title ILIKE ? OR body ILIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (category) { where.push('category = ?'); params.push(category); }

  let articles = await db.prepare(`
    SELECT k.*, u.full_name AS author_name FROM kb_articles k
    LEFT JOIN users u ON u.id = k.author_id
    WHERE ${where.join(' AND ')}
    ORDER BY k.updated_at DESC
  `).all(...params);

  const sortOption = req.query.sort === 'title' ? 'title' : req.query.sort === 'views' ? 'views' : 'recent';
  const sortMap = { recent: ['updated_at', 'desc'], title: ['title', 'asc'], views: ['view_count', 'desc'] };
  const [sortKey, sortDir] = sortMap[sortOption];
  articles = sortRows(articles, KB_SORT_COLUMNS, sortKey, sortDir);
  const { items, pagination } = paginate(articles, req, 12);

  const categoryRows = await db.prepare('SELECT DISTINCT category FROM kb_articles ORDER BY category').all();
  const categories = categoryRows.map(r => r.category);

  res.render('kb/list', {
    title: 'Knowledge Base', articles: items, categories, filters: { q, category, sort: sortOption },
    isStaff, pagination, query: req.query
  });
});

router.get('/export.csv', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const isStaff = ['admin', 'agent'].includes(req.session.user.role);
  const { q, category } = req.query;

  let where = [isStaff ? "1=1" : "status = 'published'"];
  let params = [];
  if (q) { where.push('(title ILIKE ? OR body ILIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (category) { where.push('category = ?'); params.push(category); }

  let articles = await db.prepare(`
    SELECT k.*, u.full_name AS author_name FROM kb_articles k
    LEFT JOIN users u ON u.id = k.author_id
    WHERE ${where.join(' AND ')}
    ORDER BY k.updated_at DESC
  `).all(...params);

  const sortOption = req.query.sort === 'title' ? 'title' : req.query.sort === 'views' ? 'views' : 'recent';
  const sortMap = { recent: ['updated_at', 'desc'], title: ['title', 'asc'], views: ['view_count', 'desc'] };
  const [sortKey, sortDir] = sortMap[sortOption];
  articles = sortRows(articles, KB_SORT_COLUMNS, sortKey, sortDir);

  const csv = toCsv(articles, [
    { label: 'Number', value: r => r.number },
    { label: 'Title', value: r => r.title },
    { label: 'Category', value: r => r.category },
    { label: 'Status', value: r => r.status },
    { label: 'Author', value: r => r.author_name || '' },
    { label: 'Views', value: r => r.view_count },
    { label: 'Body', value: r => r.body },
    { label: 'Created', value: r => r.created_at },
    { label: 'Updated', value: r => r.updated_at }
  ]);

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="kb-articles.csv"');
  res.send(csv);
});

router.get('/new', requireAuth, requireRole('admin', 'agent'), (req, res) => {
  res.render('kb/form', { title: 'New Article', article: null });
});

router.post('/', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const b = req.body;
  const number = await nextNumber('kb', 'KB');
  const info = await db.prepare(`
    INSERT INTO kb_articles (number, title, category, body, status, author_id)
    VALUES (?, ?, ?, ?, ?, ?)
    RETURNING id
  `).run(number, b.title, b.category || 'general', b.body, b.status === 'draft' ? 'draft' : 'published', req.session.user.id);
  res.redirect(`/kb/${info.lastInsertRowid}`);
});

router.get('/:id', requireAuth, async (req, res) => {
  const article = await db.prepare(`
    SELECT k.*, u.full_name AS author_name FROM kb_articles k LEFT JOIN users u ON u.id = k.author_id WHERE k.id = ?
  `).get(req.params.id);
  if (!article) return res.status(404).render('error', { title: 'Not Found', message: 'Article not found.' });

  const isStaff = ['admin', 'agent'].includes(req.session.user.role);
  if (article.status === 'draft' && !isStaff) {
    return res.status(403).render('error', { title: 'Access Denied', message: 'This article is not yet published.' });
  }

  await db.prepare('UPDATE kb_articles SET view_count = view_count + 1 WHERE id = ?').run(req.params.id);
  article.view_count += 1;

  res.render('kb/show', { title: article.title, article });
});

router.get('/:id/edit', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const article = await db.prepare('SELECT * FROM kb_articles WHERE id = ?').get(req.params.id);
  if (!article) return res.status(404).render('error', { title: 'Not Found', message: 'Article not found.' });
  res.render('kb/form', { title: `Edit ${article.number}`, article });
});

router.post('/:id/update', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const b = req.body;
  await db.prepare(`
    UPDATE kb_articles SET title = ?, category = ?, body = ?, status = ?, updated_at = ? WHERE id = ?
  `).run(b.title, b.category || 'general', b.body, b.status === 'draft' ? 'draft' : 'published', nowStr(), req.params.id);
  res.redirect(`/kb/${req.params.id}`);
});

router.post('/:id/delete', requireAuth, requireRole('admin'), async (req, res) => {
  await db.prepare('DELETE FROM kb_articles WHERE id = ?').run(req.params.id);
  res.redirect('/kb');
});

module.exports = router;
