const { db } = require('../db');
const mfa = require('../mfa');
const { authPolicy } = require('../settings');

const policy = authPolicy(process.env);

async function requireAuth(req, res, next) {
  if (!req.session.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }

  const fresh = await db.prepare('SELECT id, username, full_name, role, active, theme_preference FROM users WHERE id = ?').get(req.session.user.id);
  if (!fresh || !fresh.active) {
    return req.session.destroy(() => res.redirect('/login'));
  }
  // MFA_REQUIRE=admins|all: until two-step verification is on, the only pages open are the one that sets it up and
  // sign-out. People who signed in through single sign-on answer to their provider's own policy.
  if (policy.mfaRequire !== 'none' && req.session.user.via !== 'sso' && mfa.requiredFor(policy, fresh.role)
      && !/^\/(profile\/mfa|logout)(\/|\?|$)/.test(req.originalUrl) && !(await mfa.isEnabled(fresh.id))) {
    return res.redirect('/profile/mfa?required=1');
  }
  req.session.user.role = fresh.role;
  req.session.user.full_name = fresh.full_name;
  req.session.user.username = fresh.username;
  req.session.user.theme_preference = fresh.theme_preference;

  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user || !roles.includes(req.session.user.role)) {
      return res.status(403).render('error', { title: 'Access Denied', message: 'You do not have permission to view this page.' });
    }
    next();
  };
}

function attachUser(req, res, next) {
  res.locals.currentUser = req.session.user || null;
  // One-time message for the next page (for example after signing in with a recovery code).
  res.locals.flashNotice = req.session.notice || null;
  if (req.session.notice) delete req.session.notice;
  next();
}

module.exports = { requireAuth, requireRole, attachUser };
