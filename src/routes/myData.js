// "Download my data": a person gets, on their own, the same file an administrator can make about them (src/privacy/person.js).
//
// Because the file holds personal details, a stolen or borrowed session must not be enough to get it:
//   * a person who signed in with a password types it again (and the code from their authenticator app, if two-step verification is on);
//   * a person who signed in through single sign-on has no password here, so a sign-in from the last RECENT_MS is accepted instead
//     (and an older one is asked to sign in again first).
// Wrong passwords count towards the same account lock-out as at sign-in. A few downloads an hour at most. Every download
// and every refusal is in the audit log, and the person is told by email that their data was downloaded.
'use strict';
const { db, nowStr } = require('../db');
const { requireAuth } = require('../middleware/auth');
const createAsyncRouter = require('../asyncRouter');
const { verifyPassword } = require('../passwords');
const lockout = require('../lockout');
const mfa = require('../mfa');
const { audit } = require('../audit');
const person = require('../privacy/person');
const { createWindowCounter } = require('../rateLimit');
const { escapeHtml } = require('../helpers');
const mailer = require('../mailer');

const RECENT_MS = 15 * 60 * 1000;
const PER_HOUR = 5;
const perHour = createWindowCounter({ windowMs: 60 * 60 * 1000, max: PER_HOUR });

const router = createAsyncRouter();
router.use(requireAuth);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const recentSso = (req) => req.session.user && req.session.user.via === 'sso' && Date.now() - Number(req.session.signedInAt || 0) < RECENT_MS;

async function view(req, extra = {}) {
  const me = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  return {
    title: 'Download my data', held: await person.counts(me), twoStep: await mfa.isEnabled(me.id), viaSso: req.session.user.via === 'sso',
    recentSso: recentSso(req), perHour: PER_HOUR, error: null, ...extra,
  };
}

router.get('/', async (req, res) => res.render('profile-data', await view(req)));

router.post('/', async (req, res) => {
  const me = await db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(req.session.user.id);
  const refuse = async (error, why, status = 400) => {
    await audit(req, req.session.user, 'privacy.self_export_refused', { targetType: 'user', targetId: req.session.user.id, targetName: req.session.user.username, detail: why });
    res.status(status).render('profile-data', await view(req, { error }));
  };
  if (!me) return refuse('This account cannot download its data.', 'account not active', 403);
  if (lockout.isLocked(me)) return refuse('This account is locked for a while after repeated wrong passwords. Try again later.', 'account is locked', 403);

  const typed = typeof req.body.password === 'string' ? req.body.password : '';
  if (typed) {
    if (!(await verifyPassword(typed, me.password_hash))) {
      const result = await lockout.recordFailure(me);
      return refuse('That password is not right.', result.locked ? 'wrong password; the account is now locked' : 'wrong password');
    }
    await lockout.clearFailures(me.id);
    // The code is asked for whenever two-step verification is on and the password is what proved who is asking.
    if (await mfa.isEnabled(me.id)) {
      if (mfa.lockedUntil(me.id)) return refuse('Too many wrong codes. Wait a few minutes and try again.', 'code step locked', 429);
      const code = await mfa.verifyLogin(me.id, req.body.code);
      if (!code.ok) { mfa.recordFailure(me.id); return refuse('That code is not right.', 'wrong two-step code'); }
      mfa.clearFailures(me.id);
    }
  } else if (!recentSso(req)) {
    return refuse(req.session.user.via === 'sso'
      ? 'You signed in some time ago. Sign out, sign in again with single sign-on, and come straight back here.'
      : 'Type your password to confirm that it is you.', 'no proof of identity given');
  }

  const hit = perHour.hit(me.id);
  if (!hit.allowed) {
    res.set('Retry-After', String(hit.resetSeconds));
    return refuse(`You have downloaded your data ${PER_HOUR} times in the last hour. Try again in ${Math.ceil(hit.resetSeconds / 60)} minutes.`, 'too many downloads', 429);
  }

  const file = await person.exportPerson(me.id, { by: me.username, generatedAt: nowStr() });
  await audit(req, req.session.user, 'privacy.self_exported', { targetType: 'user', targetId: me.id, targetName: me.username, detail: 'the person downloaded their own data' });
  if (me.email) {
    // Told, so that someone who got into the account without the person knowing cannot do this quietly. A mail server
    // that is down must not stop the download.
    mailer.sendNotificationDetailed({
      to: me.email, toName: me.full_name, subject: 'Your data was downloaded', relatedType: 'privacy', relatedId: me.id,
      html: `<p>Hi ${escapeHtml(me.full_name)},</p><p>A file with the data held about you was downloaded from your account on ${escapeHtml(nowStr())} UTC (from address ${escapeHtml(String(req.ip || 'unknown'))}).</p><p>If this was you, there is nothing to do. If it was not, change your password and sign out of your other devices, then tell your administrator.</p>`,
    }).catch((err) => console.error('[Privacy] the notice about a data download could not be sent:', err.message));
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="my-data-${nowStr().slice(0, 10).replace(/-/g, '')}.json"`);
  res.send(JSON.stringify(file, null, 2));
});

module.exports = router;
