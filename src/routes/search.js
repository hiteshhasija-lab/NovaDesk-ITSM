const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const createAsyncRouter = require('../asyncRouter');
const customFields = require('../customFields');

const router = createAsyncRouter();

router.get('/', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  const isEndUser = req.session.user.role === 'user';
  const uid = req.session.user.id;

  const isStaff = ['admin', 'agent'].includes(req.session.user.role);

  let incidents = [];
  let changes = [];
  let cis = [];
  let problems = [];
  let requests = [];
  let articles = [];

  if (q) {
    const like = `%${q}%`;
    // A word typed here also finds records whose custom fields hold it (only fields this person may see).
    const role = req.session.user.role;
    const cf = Object.fromEntries(await Promise.all([['incident', 'i'], ['change', 'c'], ['ci', 'ci'], ['problem', 'p'], ['request', 'r']]
      .map(async ([e, a]) => [e, (await customFields.listFilter(e, a, {}, role)).search(q)])));

    incidents = await db.prepare(`
      SELECT i.*, c.name AS ci_name
      FROM incidents i
      LEFT JOIN cmdb_ci c ON c.id = i.affected_ci_id
      WHERE (i.number ILIKE ? OR i.short_description ILIKE ?${cf.incident.sql}) ${isEndUser ? 'AND i.caller_id = ?' : ''}
      ORDER BY i.created_at DESC LIMIT 15
    `).all(...(isEndUser ? [like, like, ...cf.incident.params, uid] : [like, like, ...cf.incident.params]));

    changes = await db.prepare(`
      SELECT c.*
      FROM changes c
      WHERE (c.number ILIKE ? OR c.short_description ILIKE ?${cf.change.sql}) ${isEndUser ? 'AND c.requested_by = ?' : ''}
      ORDER BY c.created_at DESC LIMIT 15
    `).all(...(isEndUser ? [like, like, ...cf.change.params, uid] : [like, like, ...cf.change.params]));

    cis = await db.prepare(`
      SELECT ci.* FROM cmdb_ci ci
      WHERE ci.name ILIKE ? OR ci.ci_number ILIKE ? OR ci.ip_address ILIKE ?${cf.ci.sql}
      ORDER BY ci.name LIMIT 15
    `).all(like, like, like, ...cf.ci.params);

    if (isStaff) {
      problems = await db.prepare(`
        SELECT p.*, c.name AS ci_name
        FROM problems p
        LEFT JOIN cmdb_ci c ON c.id = p.affected_ci_id
        WHERE p.number ILIKE ? OR p.short_description ILIKE ? OR c.name ILIKE ? OR c.ci_number ILIKE ?${cf.problem.sql}
        ORDER BY p.created_at DESC LIMIT 15
      `).all(like, like, like, like, ...cf.problem.params);
    }

    requests = await db.prepare(`
      SELECT r.*, ci.name AS item_name, ci.icon AS item_icon
      FROM service_requests r
      LEFT JOIN catalog_items ci ON ci.id = r.catalog_item_id
      WHERE (r.number ILIKE ? OR ci.name ILIKE ?${cf.request.sql}) ${isEndUser ? 'AND r.requested_by = ?' : ''}
      ORDER BY r.created_at DESC LIMIT 15
    `).all(...(isEndUser ? [like, like, ...cf.request.params, uid] : [like, like, ...cf.request.params]));

    articles = await db.prepare(`
      SELECT * FROM kb_articles
      WHERE (title ILIKE ? OR body ILIKE ?) ${isStaff ? '' : "AND status = 'published'"}
      ORDER BY updated_at DESC LIMIT 15
    `).all(like, like);
  }

  res.render('search', { title: q ? `Search: ${q}` : 'Search', q, incidents, changes, cis, problems, requests, articles, isStaff });
});

module.exports = router;
