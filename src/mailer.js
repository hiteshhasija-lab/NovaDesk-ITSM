const nodemailer = require('nodemailer');
const { db } = require('./db');

let transporterPromise = null;

function getTransporter() {
  if (!transporterPromise) {
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
  return transporterPromise;
}

async function sendNotification({ to, toName, subject, html, relatedType, relatedId }) {
  if (!to) return null;
  let previewUrl = null;
  let status = 'failed';

  try {
    const transporter = await getTransporter();
    if (transporter) {
      const info = await transporter.sendMail({
        from: '"NovaDesk ITSM" <notifications@novadesk.local>',
        to,
        subject,
        html
      });
      previewUrl = nodemailer.getTestMessageUrl(info) || null;
      status = 'sent';
    }
  } catch (err) {
    console.error('Notifications: failed to send:', err.message);
  }

  db.prepare(`
    INSERT INTO notifications (recipient_email, recipient_name, subject, body, related_type, related_id, preview_url, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(to, toName || null, subject, html, relatedType || null, relatedId || null, previewUrl, status);

  return previewUrl;
}

module.exports = { sendNotification };
