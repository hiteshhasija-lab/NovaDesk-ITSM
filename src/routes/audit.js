// The audit log for administrators: who did what, when and from where. Read-only; rows are never edited or deleted here.
const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const createAsyncRouter = require('../asyncRouter');
const { toCsv } = require('../helpers');

const router = createAsyncRouter();
router.use(requireAuth, requireRole('admin'));

const PAGE = 50;
const like = (q) => `%${String(q).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

function filters(query) {
  const where = ['1=1']; const params = [];
  const action = String(query.action || '').trim();
  const who = String(query.who || '').trim();
  if (action) { where.push('action LIKE ?'); params.push(`${like(action)}`); }
  if (who) { where.push('(actor_name ILIKE ? OR target_name ILIKE ?)'); params.push(like(who), like(who)); }
  return { where: where.join(' AND '), params, action, who };
}

router.get('/', async (req, res) => {
  const f = filters(req.query);
  const page = Math.max(1, Number(req.query.page) || 1);
  const total = Number((await db.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE ${f.where}`).get(...f.params)).c);
  const rows = await db.prepare(`SELECT * FROM audit_log WHERE ${f.where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...f.params, PAGE, (page - 1) * PAGE);
  const kinds = (await db.prepare(`SELECT DISTINCT split_part(action, '.', 1) AS kind FROM audit_log ORDER BY 1`).all()).map((r) => r.kind);
  res.render('audit/index', { title: 'Audit log', rows, total, page, pages: Math.max(1, Math.ceil(total / PAGE)), filter: { action: f.action, who: f.who }, kinds });
});

router.get('/export.csv', async (req, res) => {
  const f = filters(req.query);
  const rows = await db.prepare(`SELECT * FROM audit_log WHERE ${f.where} ORDER BY id DESC LIMIT 20000`).all(...f.params);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"');
  res.send(toCsv(rows, [
    { label: 'Time (UTC)', value: (r) => r.at }, { label: 'Action', value: (r) => r.action }, { label: 'By', value: (r) => r.actor_name || '' },
    { label: 'Target type', value: (r) => r.target_type || '' }, { label: 'Target', value: (r) => r.target_name || '' }, { label: 'Detail', value: (r) => r.detail || '' }, { label: 'Address', value: (r) => r.ip || '' },
  ]));
});

module.exports = router;
