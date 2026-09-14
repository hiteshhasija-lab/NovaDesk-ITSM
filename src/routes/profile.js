const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  res.render('profile', { title: 'My Profile', profileUser: user, error: null, success: null });
});

router.post('/', requireAuth, (req, res) => {
  const b = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);

  db.prepare('UPDATE users SET full_name = ?, email = ?, department = ? WHERE id = ?')
    .run(b.full_name, b.email || null, b.department || null, user.id);

  req.session.user.full_name = b.full_name;

  if (b.new_password) {
    if (!bcrypt.compareSync(b.current_password || '', user.password_hash)) {
      const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      return res.render('profile', { title: 'My Profile', profileUser: updated, error: 'Current password is incorrect — profile details were saved, but the password was not changed.', success: null });
    }
    if (b.new_password !== b.confirm_password) {
      const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      return res.render('profile', { title: 'My Profile', profileUser: updated, error: 'New password and confirmation do not match — profile details were saved, but the password was not changed.', success: null });
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(b.new_password, 10), user.id);
  }

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.render('profile', { title: 'My Profile', profileUser: updated, error: null, success: 'Profile updated.' });
});

module.exports = router;
