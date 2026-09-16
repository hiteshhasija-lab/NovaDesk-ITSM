const bcrypt = require('bcryptjs');
const { db } = require('../db');
const createAsyncRouter = require('../asyncRouter');

const router = createAsyncRouter();

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: null, title: 'Log In' });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.render('login', { error: 'Invalid username or password.', title: 'Log In' });
  }
  req.session.user = { id: user.id, username: user.username, full_name: user.full_name, role: user.role, theme_preference: user.theme_preference };
  if (req.body.remember) req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 30;
  const dest = req.session.returnTo || '/';
  delete req.session.returnTo;
  res.redirect(dest);
});

router.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('register', { error: null, title: 'Create Account', form: {} });
});

router.post('/register', async (req, res) => {
  const b = req.body;
  const form = { full_name: b.full_name, username: b.username, email: b.email, department: b.department };

  if (!b.full_name || !b.username || !b.password) {
    return res.render('register', { error: 'Full name, username, and password are required.', title: 'Create Account', form });
  }
  if (b.password.length < 8) {
    return res.render('register', { error: 'Password must be at least 8 characters.', title: 'Create Account', form });
  }
  if (b.password !== b.confirm_password) {
    return res.render('register', { error: 'Password and confirmation do not match.', title: 'Create Account', form });
  }

  try {
    await db.prepare(`
      INSERT INTO users (username, password_hash, full_name, email, role, department)
      VALUES (?, ?, ?, ?, 'user', ?)
    `).run(b.username, bcrypt.hashSync(b.password, 10), b.full_name, b.email || null, b.department || null);
  } catch (e) {
    return res.render('register', { error: 'That username is already taken.', title: 'Create Account', form });
  }

  const user = await db.prepare('SELECT * FROM users WHERE username = ?').get(b.username);
  req.session.user = { id: user.id, username: user.username, full_name: user.full_name, role: user.role, theme_preference: user.theme_preference };
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
