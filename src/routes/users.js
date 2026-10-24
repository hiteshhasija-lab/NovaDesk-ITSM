const { db } = require('../db');
const mfa = require('../mfa');
const apiKeys = require('../apiKeys');
const { checkPassword, hashPassword } = require('../passwords');
const lockout = require('../lockout');
const { audit } = require('../audit');
const { requireAuth, requireRole } = require('../middleware/auth');
const { ASSIGNMENT_GROUPS } = require('../helpers');
const createAsyncRouter = require('../asyncRouter');

const router = createAsyncRouter();

async function groupsOf(userId) {
  return (await db.prepare('SELECT group_name FROM user_assignment_groups WHERE user_id = ? ORDER BY group_name').all(userId)).map((r) => r.group_name);
}
async function saveGroups(userId, submitted) {
  const wanted = [].concat(submitted || []).filter((g) => ASSIGNMENT_GROUPS.includes(g));
  await db.prepare('DELETE FROM user_assignment_groups WHERE user_id = ?').run(userId);
  for (const g of wanted) await db.prepare('INSERT INTO user_assignment_groups (user_id, group_name) VALUES (?, ?) ON CONFLICT DO NOTHING').run(userId, g);
}

router.get('/', requireAuth, requireRole('admin'), async (req, res) => {
  const users = await db.prepare('SELECT * FROM users ORDER BY full_name').all();
  const rows = await db.prepare('SELECT user_id, group_name FROM user_assignment_groups ORDER BY group_name').all();
  const groupsByUser = {};
  for (const r of rows) (groupsByUser[r.user_id] = groupsByUser[r.user_id] || []).push(r.group_name);
  res.render('users/list', { title: 'Users', users, groupsByUser });
});

router.get('/new', requireAuth, requireRole('admin'), (req, res) => {
  res.render('users/form', { mfaStatus: null, identities: [], resetMessage: null, apiKeyCount: 0, lockedUntil: null, title: 'New User', user: null, error: null, groups: ASSIGNMENT_GROUPS, userGroups: [] });
});

router.post('/', requireAuth, requireRole('admin'), async (req, res) => {
  const b = req.body;
  const again = (error) => res.render('users/form', { mfaStatus: null, identities: [], resetMessage: null, apiKeyCount: 0, lockedUntil: null, title: 'New User', user: b, error, groups: ASSIGNMENT_GROUPS, userGroups: [].concat(b.groups || []) });
  // There is no default password: whoever is made has to be given one that passes the rules.
  const weak = checkPassword(b.password, { username: b.username, email: b.email, fullName: b.full_name });
  if (weak) return again(weak);
  try {
    await db.prepare(`
      INSERT INTO users (username, password_hash, full_name, email, role, department)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(b.username, await hashPassword(b.password), b.full_name, b.email || null, b.role || 'user', b.department || null);
    const created = await db.prepare('SELECT id FROM users WHERE username = ?').get(b.username);
    if (created) await saveGroups(created.id, b.groups);
    await audit(req, req.session.user, 'user.created', { targetType: 'user', targetId: created && created.id, targetName: b.username, detail: `role ${b.role || 'user'}` });
    res.redirect('/users');
  } catch (e) {
    again('Username already exists or invalid data.');
  }
});

router.get('/:id/edit', requireAuth, requireRole('admin'), async (req, res) => {
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).render('error', { title: 'Not Found', message: 'User not found.' });
  const identities = await db.prepare('SELECT issuer, email, last_login_at FROM user_identities WHERE user_id = ? ORDER BY id').all(user.id);
  res.render('users/form', { title: `Edit ${user.full_name}`, user, error: null, groups: ASSIGNMENT_GROUPS, userGroups: await groupsOf(user.id), mfaStatus: await mfa.status(user.id), identities, apiKeyCount: (await apiKeys.listKeys(user.id)).filter((k) => !k.revoked_at).length, lockedUntil: lockout.isLocked(user) ? user.locked_until : null, resetMessage: req.query.mfa === 'reset' ? 'Two-step verification was turned off for this person. They can set it up again.' : (req.query.keys === 'revoked' ? 'All of this person\'s API keys were revoked.' : (req.query.unlocked ? 'The account is unlocked.' : null)) });
});

// Switch off every API key a person has (a leaked key, or someone leaving).
router.post('/:id/api-keys/revoke', requireAuth, requireRole('admin'), async (req, res) => {
  const user = await db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).render('error', { title: 'Not Found', message: 'User not found.' });
  const n = await apiKeys.revokeAllKeys(user.id);
  console.log(`[API] ${req.session.user.username} revoked ${n} API key(s) of ${user.username}`);
  await audit(req, req.session.user, 'apikey.revoked_all', { targetType: 'user', targetId: user.id, targetName: user.username, detail: `${n} key(s) revoked by an administrator` });
  res.redirect(`/users/${user.id}/edit?keys=revoked`);
});

// Someone lost their phone and their recovery codes: an administrator turns two-step verification off for them.
router.post('/:id/mfa/reset', requireAuth, requireRole('admin'), async (req, res) => {
  const user = await db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).render('error', { title: 'Not Found', message: 'User not found.' });
  await mfa.disable(user.id);
  console.log(`[MFA] ${req.session.user.username} reset two-step verification for ${user.username}`);
  await audit(req, req.session.user, 'mfa.reset', { targetType: 'user', targetId: user.id, targetName: user.username, detail: 'turned off by an administrator' });
  res.redirect(`/users/${user.id}/edit?mfa=reset`);
});

router.post('/:id/update', requireAuth, requireRole('admin'), async (req, res) => {
  const b = req.body;
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).render('error', { title: 'Not Found', message: 'User not found.' });
  const again = (error) => res.render('users/form', { mfaStatus: null, identities: [], resetMessage: null, apiKeyCount: 0, lockedUntil: null, title: `Edit ${user.full_name}`, user: { ...user, ...b }, error, groups: ASSIGNMENT_GROUPS, userGroups: [].concat(b.groups || []) });

  // The last active administrator can neither be demoted nor switched off: nobody could manage NovaDesk afterwards.
  const staysAdmin = b.role === 'admin' && b.active === 'on';
  if (user.role === 'admin' && user.active && !staysAdmin) {
    const others = Number((await db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1 AND id <> ?").get(user.id)).c);
    if (!others) return again('This is the only active administrator, so it cannot be demoted or switched off. Make someone else an administrator first.');
  }
  if (b.password) {
    const weak = checkPassword(b.password, { username: b.username, email: b.email, fullName: b.full_name });
    if (weak) return again(weak);
  }

  try {
    await db.prepare(`
      UPDATE users SET username=?, full_name=?, email=?, role=?, department=?, active=? WHERE id=?
    `).run(b.username, b.full_name, b.email || null, b.role, b.department || null, b.active === 'on' ? 1 : 0, req.params.id);
  } catch (e) {
    return again('Username already exists or invalid data.');
  }
  await saveGroups(user.id, b.groups);

  const changes = [];
  if (b.role !== user.role) changes.push(`role ${user.role} to ${b.role}`);
  if ((b.active === 'on' ? 1 : 0) !== user.active) changes.push(b.active === 'on' ? 'switched on' : 'switched off');
  if (b.username !== user.username) changes.push(`username ${user.username} to ${b.username}`);
  if ((b.email || null) !== user.email) changes.push('email changed');
  if (changes.length) await audit(req, req.session.user, 'user.updated', { targetType: 'user', targetId: user.id, targetName: b.username, detail: changes.join('; ') });

  if (b.password) {
    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(b.password), req.params.id);
    await lockout.clearFailures(user.id);
    await audit(req, req.session.user, 'password.reset', { targetType: 'user', targetId: user.id, targetName: b.username, detail: 'set by an administrator' });
  }
  res.redirect('/users');
});

// Lifts a lock after wrong passwords at once (it also ends by itself).
router.post('/:id/unlock', requireAuth, requireRole('admin'), async (req, res) => {
  const user = await db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).render('error', { title: 'Not Found', message: 'User not found.' });
  await lockout.clearFailures(user.id);
  await audit(req, req.session.user, 'user.unlocked', { targetType: 'user', targetId: user.id, targetName: user.username });
  res.redirect(`/users/${user.id}/edit?unlocked=1`);
});

// Switch off every API key a person has (a leaked key, or someone leaving).
router.post('/:id/api-keys/revoke', requireAuth, requireRole('admin'), async (req, res) => {
  const user = await db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).render('error', { title: 'Not Found', message: 'User not found.' });
  const n = await apiKeys.revokeAllKeys(user.id);
  console.log(`[API] ${req.session.user.username} revoked ${n} API key(s) of ${user.username}`);
  res.redirect(`/users/${user.id}/edit?keys=revoked`);
});

// Someone lost their phone and their recovery codes: an administrator turns two-step verification off for them.
router.post('/:id/mfa/reset', requireAuth, requireRole('admin'), async (req, res) => {
  const user = await db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).render('error', { title: 'Not Found', message: 'User not found.' });
  await mfa.disable(user.id);
  console.log(`[MFA] ${req.session.user.username} reset two-step verification for ${user.username}`);
  res.redirect(`/users/${user.id}/edit?mfa=reset`);
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
    return res.render('users/form', { mfaStatus: null, identities: [], resetMessage: null, apiKeyCount: 0, lockedUntil: null,
      title: `Edit ${user.full_name}`,
      user: { ...user, ...b },
      error: 'Username already exists or invalid data.',
      groups: ASSIGNMENT_GROUPS,
      userGroups: [].concat(b.groups || [])
    });
  }
  await saveGroups(user.id, b.groups);

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
    await audit(req, req.session.user, 'user.deleted', { targetType: 'user', targetId: id, targetName: user.username, detail: `role ${user.role}` });
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
