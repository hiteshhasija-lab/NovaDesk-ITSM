// Outgoing email. Every notice is recorded on the Notifications page with what happened to it.
//   SMTP_HOST set       sent through that server (settings.js mailConfig)
//   NODE_ENV=production and no SMTP_HOST   nothing is sent; the notice is recorded as "not sent"
//   otherwise           a throwaway test mailbox (ethereal.email), as before: for development and the lab
const nodemailer = require('nodemailer');
const { db } = require('./db');
const { mailConfig } = require('./settings');
const { createSmtpTransport, sendMail, describeError } = require('./mailTransport');

const config = mailConfig(process.env);   // throws at start-up when the settings do not fit together

const SANDBOX_FROM = '"NovaDesk ITSM" <notifications@novadesk.local>';
let transporterPromise = null;

function getTransporter() {
  if (!transporterPromise) {
    if (config.mode === 'smtp') {
      transporterPromise = Promise.resolve(createSmtpTransport(config));
    } else {
      transporterPromise = nodemailer.createTestAccount()
        .then(account => nodemailer.createTransport({
          host: account.smtp.host,
          port: account.smtp.port,
          secure: account.smtp.secure,
          auth: { user: account.user, pass: account.pass }
        }))
        .catch(err => {
          console.error('Notifications: could not create test mailbox (offline?):', err.message);
          transporterPromise = null; // don't cache the failure — retry on the next notification attempt
          return null;
        });
    }
  }
  return transporterPromise;
}

// How mail is set up, for the Notifications page and the start-up message. Never includes the password.
function mailSummary() {
  return { mode: config.mode, host: config.host || null, port: config.port || null, from: config.from || null };
}

async function deliver({ to, subject, html }) {
  if (config.mode === 'none') {
    return { status: 'not_configured', error: 'Email is not set up on this server (SMTP_HOST is empty), so nothing was sent.', previewUrl: null };
  }
  try {
    const transporter = await getTransporter();
    if (!transporter) return { status: 'failed', error: 'The test mailbox service could not be reached.', previewUrl: null };
    const info = await sendMail(transporter, { from: config.mode === 'smtp' ? config.from : SANDBOX_FROM, to, subject, html });
    return { status: 'sent', error: null, previewUrl: config.mode === 'smtp' ? null : (nodemailer.getTestMessageUrl(info) || null) };
  } catch (err) {
    console.error('Notifications: failed to send:', err.message);
    return { status: 'failed', error: describeError(err, config), previewUrl: null };
  }
}

// Sends one notice and records it. Resolves with { status, error, previewUrl }; never rejects because of
// the mail server (a failed send is a recorded outcome, not an error for the caller).
async function sendNotificationDetailed({ to, toName, subject, html, relatedType, relatedId }) {
  if (!to) return null;
  const result = await deliver({ to, subject, html });
  await db.prepare(`
    INSERT INTO notifications (recipient_email, recipient_name, subject, body, related_type, related_id, preview_url, status, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(to, toName || null, subject, html, relatedType || null, relatedId || null, result.previewUrl, result.status, result.error);
  return result;
}

async function sendNotification(notice) {
  const result = await sendNotificationDetailed(notice);
  return result ? result.previewUrl : null;
}

// At start-up: say how mail is set up and, with SMTP, check the server answers and accepts the sign-in.
// Never blocks the start and never throws: a mail server that is down must not stop the help desk.
function reportMailSetup() {
  if (config.mode === 'smtp') {
    console.log(`Email: sending through ${config.host}:${config.port} as ${config.from}${config.user ? ` (signed in as ${config.user})` : ''}.`);
    getTransporter().then(t => t.verify())
      .then(() => console.log('Email: the mail server accepted the connection and sign-in.'))
      .catch(err => console.warn(`Email: could not reach the mail server: ${describeError(err, config)}. Notices will be recorded as failed until it answers.`));
  } else if (config.mode === 'none') {
    console.warn('Email: SMTP_HOST is not set, so notifications are recorded but not sent. Set SMTP_HOST, SMTP_FROM (and SMTP_USER/SMTP_PASSWORD if the server needs them).');
  }
}

module.exports = { sendNotification, sendNotificationDetailed, mailSummary, reportMailSetup };
