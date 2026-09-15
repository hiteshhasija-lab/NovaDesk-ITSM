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
  req.session.user = { id: user.id, username: user.username, full_name: user.full_name, role: user.role };
  if (req.body.remember) req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 30;
  const dest = req.session.returnTo || '/';
  delete req.session.returnTo;
  res.redirect(dest);
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
