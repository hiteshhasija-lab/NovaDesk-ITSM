// Sending one email, apart from the database so it can be tested against a small SMTP server.
// mailer.js records what happens to the Notifications page.
'use strict';
const nodemailer = require('nodemailer');

const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// A plain-text version of the notice's HTML: mail servers and spam filters like a message to have one.
function htmlToText(html) {
  return decode(String(html || '')
    .replace(/<\s*(\/p|\/h[1-6]|\/ul|\/ol|\/table)\s*>/gi, '\n\n')
    .replace(/<\s*(br|\/div|\/li|\/tr)\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function createSmtpTransport(config) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    // Credentials never cross the network unencrypted: when signing in, the connection must be upgraded.
    requireTLS: !config.secure && Boolean(config.user),
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
    tls: { rejectUnauthorized: config.tlsVerify },
    // A mail server that does not answer must not hold a request or a notice for minutes.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
}

async function sendMail(transport, { from, to, subject, html, replyTo }) {
  // Notices are machine-made: Auto-Submitted tells other systems' auto-responders (and our own inbound mail) not to answer them.
  const info = await transport.sendMail({
    from, to, subject, html, text: htmlToText(html),
    ...(replyTo ? { replyTo } : {}),
    headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
  });
  const rejected = info.rejected || [];
  if (rejected.length) throw new Error(`The mail server refused the recipient: ${rejected.join(', ')}`);
  return info;
}

// What a person should read when sending failed. nodemailer's messages are already plain; this adds the
// one thing they leave out: which server.
function describeError(err, config) {
  const where = config && config.host ? ` (${config.host}:${config.port})` : '';
  return `${err && err.message ? err.message : String(err)}${where}`.slice(0, 500);
}

module.exports = { htmlToText, createSmtpTransport, sendMail, describeError };
