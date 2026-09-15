const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const createAsyncRouter = require('../asyncRouter');

const router = createAsyncRouter();

router.get('/', requireAuth, requireRole('admin'), async (req, res) => {
  const users = await db.prepare('SELECT * FROM users ORDER BY full_name').all();
  res.render('users/list', { title: 'Users', users });
});

router.get('/new', requireAuth, requireRole('admin'), (req, res) => {
  res.render('users/form', { title: 'New User', user: null, error: null });
});

router.post('/', requireAuth, requireRole('admin'), async (req, res) => {
  const b = req.body;
  try {
    await db.prepare(`
      INSERT INTO users (username, password_hash, full_name, email, role, department)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(b.username, bcrypt.hashSync(b.password || 'changeme123', 10), b.full_name, b.email || null, b.role || 'user', b.department || null);
    res.redirect('/users');
  } catch (e) {
    res.render('users/form', { title: 'New User', user: b, error: 'Username already exists or invalid data.' });
  }
});

router.get('/:id/edit', requireAuth, requireRole('admin'), async (req, res) => {
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).render('error', { title: 'Not Found', message: 'User not found.' });
  res.render('users/form', { title: `Edit ${user.full_name}`, user, error: null });
});

router.post('/:id/update', requireAuth, requireRole('admin'), async (req, res) => {
  const b = req.body;
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).render('error', { title: 'Not Found', message: 'User not found.' });

  try {
    await db.prepare(`
      UPDATE users SET username=?, full_name=?, email=?, role=?, department=?, active=? WHERE id=?
    `).run(b.username, b.full_name, b.email || null, b.role, b.department || null, b.active === 'on' ? 1 : 0, req.params.id);
  } catch (e) {
    return res.render('users/form', {
      title: `Edit ${user.full_name}`,
      user: { ...user, ...b },
      error: 'Username already exists or invalid data.'
    });
  }

  if (b.password) {
    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(b.password, 10), req.params.id);
  }
  res.redirect('/users');
});

router.post('/:id/delete', requireAuth, requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).render('error', { title: 'Not Found', message: 'User not found.' });

  if (id === req.session.user.id) {
    return res.status(400).render('error', { title: 'Cannot Delete', message: 'You cannot delete your own account while logged in.' });
  }
  if (user.role === 'admin') {
    const { c: adminCount } = await db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin' AND active = 1").get();
    if (adminCount <= 1) {
      return res.status(400).render('error', { title: 'Cannot Delete', message: 'This is the only active admin account. Promote another user to admin before deleting this one.' });
    }
  }

  try {
    await db.prepare('DELETE FROM users WHERE id = ?').run(id);
    res.redirect('/users');
  } catch (err) {
    if (err.code === '23503') {
      return res.status(400).render('error', {
        title: 'Cannot Delete',
        message: 'This user has existing tickets, comments, or activity history and cannot be deleted. Set them to inactive instead.'
      });
    }
    throw err;
  }
});

module.exports = router;
