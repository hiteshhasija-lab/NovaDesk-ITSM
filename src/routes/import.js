// CSV import: choose a file, see what it would do, confirm. Users are for administrators; configuration items and knowledge
// articles are for administrators and agents (the same people who may add them one at a time).
const multer = require('multer');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const createAsyncRouter = require('../asyncRouter');
const { toCsv } = require('../helpers');
const csrf = require('../csrf');
const importer = require('../csvImport');

const router = createAsyncRouter();
router.use(requireAuth, requireRole('admin', 'agent'));

// The file is read into memory (it is capped) and checked by the route after its form fields are in.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: importer.MAX_BYTES, files: 1, fields: 10 } });

const allowed = (req, kind) => kind && kind.roles.includes(req.session.user.role);
const kindOr404 = (req, res) => {
  const kind = importer.KINDS[req.params.kind];
  if (!kind) { res.status(404).render('error', { title: 'Not Found', message: 'There is no such kind of import.' }); return null; }
  if (!allowed(req, kind)) { res.status(403).render('error', { title: 'Access Denied', message: 'You cannot import this kind of record.' }); return null; }
  return kind;
};
const fmt = (row) => ({ ...row, preview: row.preview ? JSON.parse(row.preview) : null, result: row.result ? JSON.parse(row.result) : null });

async function recent(req) {
  await importer.cleanup();
  const admin = req.session.user.role === 'admin';
  const rows = await db.prepare(`SELECT i.id, i.kind, i.mode, i.filename, i.status, i.created_at, i.result, u.full_name AS who
    FROM imports i LEFT JOIN users u ON u.id = i.user_id ${admin ? '' : 'WHERE i.user_id = ?'} ORDER BY i.id DESC LIMIT 15`).all(...(admin ? [] : [req.session.user.id]));
  return rows.map((r) => ({ ...r, result: r.result ? JSON.parse(r.result) : null }));
}

router.get('/', async (req, res) => {
  const kinds = Object.values(importer.KINDS).filter((k) => allowed(req, k));
  res.render('import/index', { title: 'Import data', kinds, recent: await recent(req), KINDS: importer.KINDS });
});

// A file with the columns NovaDesk understands and two example rows.
router.get('/:kind/template.csv', async (req, res) => {
  const kind = kindOr404(req, res); if (!kind) return;
  const cols = kind.columns.filter((c) => !c.optionalInTemplate);
  const csv = toCsv(kind.templateRows, cols.map((c) => ({ label: c.label, value: (r) => r[kind.columns.indexOf(c)] })));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${kind.id}-import-template.csv"`);
  res.send(csv);
});

router.get('/job/:id', async (req, res) => {
  const row = await db.prepare(`SELECT id, kind, mode, options, filename, user_id, status, preview, result, created_at, finished_at FROM imports WHERE id = ?`).get(Number(req.params.id) || 0);
  if (!row || (req.session.user.role !== 'admin' && row.user_id !== req.session.user.id)) return res.status(404).render('error', { title: 'Not Found', message: 'Import not found.' });
  const kind = importer.KINDS[row.kind];
  if (!allowed(req, kind)) return res.status(403).render('error', { title: 'Access Denied', message: 'You cannot import this kind of record.' });
  res.render('import/job', { title: `Import ${kind.label.toLowerCase()}`, kind, job: fmt(row), options: JSON.parse(row.options || '{}') });
});

// The rows that were not imported, as a file to correct and upload again.
router.get('/job/:id/problems.csv', async (req, res) => {
  const row = await db.prepare('SELECT id, kind, user_id, preview, result FROM imports WHERE id = ?').get(Number(req.params.id) || 0);
  if (!row || (req.session.user.role !== 'admin' && row.user_id !== req.session.user.id)) return res.status(404).render('error', { title: 'Not Found', message: 'Import not found.' });
  const data = fmt(row);
  const problems = (data.result && data.result.problems) || (data.preview && data.preview.problems) || [];
  const csv = toCsv(problems, [
    { label: 'Row', value: (p) => p.row }, { label: 'Item', value: (p) => p.key },
    { label: 'Result', value: (p) => p.action }, { label: 'Why', value: (p) => p.message },
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="import-${row.id}-problems.csv"`);
  res.send(csv);
});

router.post('/job/:id/run', async (req, res) => {
  const row = await db.prepare('SELECT id, kind, user_id FROM imports WHERE id = ?').get(Number(req.params.id) || 0);
  if (!row || (req.session.user.role !== 'admin' && row.user_id !== req.session.user.id)) return res.status(404).render('error', { title: 'Not Found', message: 'Import not found.' });
  if (!allowed(req, importer.KINDS[row.kind])) return res.status(403).render('error', { title: 'Access Denied', message: 'You cannot import this kind of record.' });
  try {
    await importer.run(row.id, { req, actor: req.session.user });
  } catch (err) {
    if (!(err instanceof importer.ImportError)) throw err;
    return res.status(409).render('error', { title: 'Import not run', message: err.message });
  }
  res.redirect(`/import/job/${row.id}`);
});

router.post('/job/:id/cancel', async (req, res) => {
  const row = await db.prepare('SELECT id, kind, user_id FROM imports WHERE id = ?').get(Number(req.params.id) || 0);
  if (!row || (req.session.user.role !== 'admin' && row.user_id !== req.session.user.id)) return res.status(404).render('error', { title: 'Not Found', message: 'Import not found.' });
  await db.prepare("UPDATE imports SET status = 'expired', csv = NULL WHERE id = ? AND status = 'ready'").run(row.id);
  res.redirect(`/import/${row.kind}`);
});

router.get('/:kind', async (req, res) => {
  const kind = kindOr404(req, res); if (!kind) return;
  res.render('import/kind', { title: `Import ${kind.label.toLowerCase()}`, kind, error: null, values: { mode: 'add', defaultStatus: 'draft' } });
});

router.post('/:kind', (req, res) => {
  const kind = kindOr404(req, res); if (!kind) return;
  upload.single('file')(req, res, async (err) => {
    try {
      // Multipart, so the general check could not read the form: it is checked here, once the fields are in.
      if (!csrf.checkRequest(req)) return csrf.refuse(req, res);
      const again = (error) => res.status(400).render('import/kind', { title: `Import ${kind.label.toLowerCase()}`, kind, error, values: { mode: req.body.mode === 'update' ? 'update' : 'add', defaultStatus: req.body.defaultStatus === 'published' ? 'published' : 'draft' } });
      if (err) return again(err.code === 'LIMIT_FILE_SIZE' ? `The file is larger than ${importer.MAX_BYTES / 1048576} MB.` : err.message);
      if (!req.file) return again('Choose a CSV file to import.');
      const id = await importer.preview({ kindId: kind.id, options: req.body, filename: req.file.originalname, buffer: req.file.buffer, actor: req.session.user });
      res.redirect(`/import/job/${id}`);
    } catch (e) {
      if (e instanceof importer.ImportError) return res.status(400).render('import/kind', { title: `Import ${kind.label.toLowerCase()}`, kind, error: e.message, values: { mode: req.body.mode === 'update' ? 'update' : 'add', defaultStatus: req.body.defaultStatus === 'published' ? 'published' : 'draft' } });
      console.error(`[Import] ${e.stack || e}`);
      res.status(500).render('error', { title: 'Import failed', message: 'The file could not be read.' });
    }
  });
});

module.exports = router;
