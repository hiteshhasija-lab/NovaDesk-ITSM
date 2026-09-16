const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const createAsyncRouter = require('../asyncRouter');

const router = createAsyncRouter();

router.get('/', requireAuth, async (req, res) => {
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  res.render('profile', { title: 'My Profile', profileUser: user, error: null, success: null });
});

router.post('/', requireAuth, async (req, res) => {
  const b = req.body;
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);

  await db.prepare('UPDATE users SET full_name = ?, email = ?, department = ? WHERE id = ?')
    .run(b.full_name, b.email || null, b.department || null, user.id);

  req.session.user.full_name = b.full_name;

  if (b.new_password) {
    if (!bcrypt.compareSync(b.current_password || '', user.password_hash)) {
      const updated = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      return res.render('profile', { title: 'My Profile', profileUser: updated, error: 'Current password is incorrect — profile details were saved, but the password was not changed.', success: null });
    }
    if (b.new_password !== b.confirm_password) {
      const updated = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      return res.render('profile', { title: 'My Profile', profileUser: updated, error: 'New password and confirmation do not match — profile details were saved, but the password was not changed.', success: null });
    }
    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(b.new_password, 10), user.id);
  }

  const updated = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.render('profile', { title: 'My Profile', profileUser: updated, error: null, success: 'Profile updated.' });
});

router.post('/preferences', requireAuth, async (req, res) => {
  const theme = req.body.theme_preference === 'light' ? 'light' : 'dark';
  const emailNotifications = req.body.email_notifications ? 1 : 0;
  await db.prepare('UPDATE users SET theme_preference = ?, email_notifications = ? WHERE id = ?')
    .run(theme, emailNotifications, req.session.user.id);
  req.session.user.theme_preference = theme;

  const updated = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  res.render('profile', { title: 'My Profile', profileUser: updated, error: null, success: 'Preferences updated.' });
});

router.post('/theme', requireAuth, async (req, res) => {
  const theme = req.body.theme === 'light' ? 'light' : 'dark';
  await db.prepare('UPDATE users SET theme_preference = ? WHERE id = ?').run(theme, req.session.user.id);
  req.session.user.theme_preference = theme;
  res.json({ ok: true });
});

module.exports = router;
