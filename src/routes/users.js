const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, requireRole('admin'), (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY full_name').all();
  res.render('users/list', { title: 'Users', users });
});

router.get('/new', requireAuth, requireRole('admin'), (req, res) => {
  res.render('users/form', { title: 'New User', user: null, error: null });
});

router.post('/', requireAuth, requireRole('admin'), (req, res) => {
  const b = req.body;
  try {
    db.prepare(`
      INSERT INTO users (username, password_hash, full_name, email, role, department)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(b.username, bcrypt.hashSync(b.password || 'changeme123', 10), b.full_name, b.email || null, b.role || 'user', b.department || null);
    res.redirect('/users');
  } catch (e) {
    res.render('users/form', { title: 'New User', user: b, error: 'Username already exists or invalid data.' });
  }
});

router.get('/:id/edit', requireAuth, requireRole('admin'), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).render('error', { title: 'Not Found', message: 'User not found.' });
  res.render('users/form', { title: `Edit ${user.full_name}`, user, error: null });
});

router.post('/:id/update', requireAuth, requireRole('admin'), (req, res) => {
  const b = req.body;
  db.prepare(`
    UPDATE users SET full_name=?, email=?, role=?, department=?, active=? WHERE id=?
  `).run(b.full_name, b.email || null, b.role, b.department || null, b.active === 'on' ? 1 : 0, req.params.id);

  if (b.password) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(b.password, 10), req.params.id);
  }
  res.redirect('/users');
});

module.exports = router;
