const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const createAsyncRouter = require('../asyncRouter');
const { sendNotificationDetailed, mailSummary } = require('../mailer');
const { escapeHtml } = require('../helpers');

const router = createAsyncRouter();

router.get('/', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const notifications = await db.prepare(`
    SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100
  `).all();

  // The result of "Send a test email", shown once.
  const testResult = req.session.mailTest || null;
  delete req.session.mailTest;

  res.render('notifications/list', { title: 'Notifications', notifications, mail: mailSummary(), testResult });
});

// "Send a test email": an administrator checks the mail settings by sending a message to their own
// address (never to an address typed in, so this cannot be used to send mail to other people).
router.post('/test', requireAuth, requireRole('admin'), async (req, res) => {
  const me = await db.prepare('SELECT full_name, email FROM users WHERE id = ?').get(req.session.user.id);
  if (!me || !me.email) {
    req.session.mailTest = { status: 'noemail' };
    return res.redirect('/notifications');
  }
  const result = await sendNotificationDetailed({
    to: me.email,
    toName: me.full_name,
    subject: 'NovaDesk test email',
    html: `<p>Hi ${escapeHtml(me.full_name)},</p><p>This is a test message from NovaDesk. If you can read it, email notifications are working.</p>`
  });
  req.session.mailTest = { status: result.status, error: result.error, to: me.email };
  res.redirect('/notifications');
});

// One notification as it was sent, from NovaDesk's own copy (notifications.body). The Preview used
// to open the sandbox mailbox's page (ethereal.email), which deletes its messages and accounts
// within days, so every older notification answered "This message does not exist".
router.get('/:id', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const id = Number(req.params.id);
  const notification = Number.isInteger(id) && id > 0 ? await db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) : null;
  if (!notification) return res.status(404).render('error', { title: 'Not Found', message: 'Notification not found.' });
  res.render('notifications/show', { title: `Notification: ${notification.subject}`, notification });
});

module.exports = router;
