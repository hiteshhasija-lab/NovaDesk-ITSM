const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { db, logActivity } = require('./db');
const { sendNotification } = require('./mailer');

const uploadRoot = path.join(__dirname, '..', 'data', 'uploads');
if (!fs.existsSync(uploadRoot)) fs.mkdirSync(uploadRoot, { recursive: true });

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.sh', '.bat', '.cmd', '.com', '.msi', '.ps1', '.vbs', '.js', '.jar', '.app'
]);

function makeUpload(entityType) {
  const dir = path.join(uploadRoot, entityType);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const storage = multer.diskStorage({
    destination: dir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    }
  });

  const fileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (BLOCKED_EXTENSIONS.has(ext)) return cb(new Error(`Files of type "${ext}" are not allowed.`));
    cb(null, true);
  };

  return multer({ storage, limits: { fileSize: MAX_FILE_SIZE }, fileFilter });
}

// Mounts POST /:id/attachments, GET /:id/attachments/:attId/download, POST /:id/attachments/:attId/delete
// onto an existing router. `table` is the URL prefix (e.g. 'incidents') used for redirects.
// `middleware` (e.g. [requireAuth] or [requireAuth, requireRole('admin','agent')]) is applied to every route here —
// callers MUST pass at least requireAuth since this module does not enforce a session on its own.
function attachRoutes(router, entityType, { table, getEntity, canAccess, canManage, middleware = [] }) {
  const upload = makeUpload(entityType);

  router.post('/:id/attachments', ...middleware, (req, res) => {
    upload.single('file')(req, res, (err) => {
      const entity = getEntity(req.params.id);
      if (!entity) return res.status(404).render('error', { title: 'Not Found', message: 'Record not found.' });
      if (!canAccess(req, entity)) return res.status(403).render('error', { title: 'Access Denied', message: 'You cannot upload files here.' });

      if (err) {
        const message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (10MB max).' : err.message;
        return res.status(400).render('error', { title: 'Upload Failed', message });
      }
      if (!req.file) return res.redirect(`/${table}/${req.params.id}`);

      db.prepare(`
        INSERT INTO attachments (entity_type, entity_id, filename, original_name, mime_type, size, uploaded_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(entityType, req.params.id, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, req.session.user.id);

      logActivity(entityType, req.params.id, req.session.user.id, `Attached file: ${req.file.originalname}`);
      res.redirect(`/${table}/${req.params.id}`);
    });
  });

  router.get('/:id/attachments/:attId/download', ...middleware, (req, res) => {
    const entity = getEntity(req.params.id);
    if (!entity) return res.status(404).render('error', { title: 'Not Found', message: 'Record not found.' });
    if (!canAccess(req, entity)) return res.status(403).render('error', { title: 'Access Denied', message: 'You cannot view this file.' });

    const att = db.prepare('SELECT * FROM attachments WHERE id = ? AND entity_type = ? AND entity_id = ?')
      .get(req.params.attId, entityType, req.params.id);
    if (!att) return res.status(404).render('error', { title: 'Not Found', message: 'Attachment not found.' });

    res.download(path.join(uploadRoot, entityType, att.filename), att.original_name);
  });

  router.post('/:id/attachments/:attId/delete', ...middleware, (req, res) => {
    const entity = getEntity(req.params.id);
    if (!entity) return res.status(404).render('error', { title: 'Not Found', message: 'Record not found.' });

    const att = db.prepare('SELECT * FROM attachments WHERE id = ? AND entity_type = ? AND entity_id = ?')
      .get(req.params.attId, entityType, req.params.id);
    if (!att) return res.status(404).render('error', { title: 'Not Found', message: 'Attachment not found.' });

    const isUploader = att.uploaded_by === req.session.user.id;
    if (!canManage(req, entity) && !isUploader) {
      return res.status(403).render('error', { title: 'Access Denied', message: 'You cannot delete this file.' });
    }

    fs.unlink(path.join(uploadRoot, entityType, att.filename), () => {});
    db.prepare('DELETE FROM attachments WHERE id = ?').run(att.id);
    logActivity(entityType, req.params.id, req.session.user.id, `Removed attachment: ${att.original_name}`);
    res.redirect(`/${table}/${req.params.id}`);
  });
}

function getAttachments(entityType, entityId) {
  return db.prepare(`
    SELECT a.*, u.full_name AS uploader_name
    FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
    WHERE a.entity_type = ? AND a.entity_id = ?
    ORDER BY a.created_at ASC
  `).all(entityType, entityId);
}

// Mounts POST /:id/watch and POST /:id/unwatch onto an existing router.
// `middleware` (e.g. [requireAuth]) is applied to both routes — callers MUST pass at least requireAuth.
function watchRoutes(router, entityType, { table, getEntity, canAccess, middleware = [] }) {
  router.post('/:id/watch', ...middleware, (req, res) => {
    const entity = getEntity(req.params.id);
    if (!entity) return res.status(404).render('error', { title: 'Not Found', message: 'Record not found.' });
    if (!canAccess(req, entity)) return res.status(403).render('error', { title: 'Access Denied', message: 'You cannot watch this record.' });

    db.prepare(`INSERT OR IGNORE INTO watchers (entity_type, entity_id, user_id) VALUES (?, ?, ?)`)
      .run(entityType, req.params.id, req.session.user.id);
    res.redirect(`/${table}/${req.params.id}`);
  });

  router.post('/:id/unwatch', ...middleware, (req, res) => {
    db.prepare(`DELETE FROM watchers WHERE entity_type = ? AND entity_id = ? AND user_id = ?`)
      .run(entityType, req.params.id, req.session.user.id);
    res.redirect(`/${table}/${req.params.id}`);
  });
}

function getWatchers(entityType, entityId) {
  return db.prepare(`
    SELECT w.user_id, u.full_name, u.email
    FROM watchers w JOIN users u ON u.id = w.user_id
    WHERE w.entity_type = ? AND w.entity_id = ?
    ORDER BY u.full_name
  `).all(entityType, entityId);
}

function isWatching(entityType, entityId, userId) {
  return !!db.prepare(`SELECT 1 FROM watchers WHERE entity_type = ? AND entity_id = ? AND user_id = ?`)
    .get(entityType, entityId, userId);
}

// Emails every watcher except excludeUserId (typically the actor who triggered the update).
function notifyWatchers(entityType, entityId, { subject, html, excludeUserId }) {
  getWatchers(entityType, entityId)
    .filter(w => w.user_id !== excludeUserId && w.email)
    .forEach(w => {
      sendNotification({ to: w.email, toName: w.full_name, subject, html, relatedType: entityType, relatedId: entityId }).catch(() => {});
    });
}

// Removes all attachment files/rows and watcher rows for an entity — call this from a module's
// own delete route alongside its existing activity_log/notifications cleanup.
function purgeCollabData(entityType, entityId) {
  const atts = db.prepare('SELECT * FROM attachments WHERE entity_type = ? AND entity_id = ?').all(entityType, entityId);
  atts.forEach(a => fs.unlink(path.join(uploadRoot, entityType, a.filename), () => {}));
  db.prepare('DELETE FROM attachments WHERE entity_type = ? AND entity_id = ?').run(entityType, entityId);
  db.prepare('DELETE FROM watchers WHERE entity_type = ? AND entity_id = ?').run(entityType, entityId);
}

module.exports = { attachRoutes, getAttachments, watchRoutes, getWatchers, isWatching, notifyWatchers, purgeCollabData, MAX_FILE_SIZE };
