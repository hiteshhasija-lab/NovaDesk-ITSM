'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mailConfig } = require('../src/settings');
const { htmlToText, createSmtpTransport, sendMail, describeError } = require('../src/mailTransport');
const { startSink } = require('../scripts/smtp-sink');

const good = { SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'NovaDesk <helpdesk@example.com>' };

test('without SMTP_HOST: production sends nothing, anywhere else the old test mailbox stays', () => {
  assert.deepStrictEqual(mailConfig({ NODE_ENV: 'production' }), { mode: 'none' });
  assert.deepStrictEqual(mailConfig({}), { mode: 'sandbox' });
  assert.deepStrictEqual(mailConfig({ SMTP_HOST: '   ' }), { mode: 'sandbox' });
});

test('SMTP settings: defaults, and every bad combination says what to fix', () => {
  const c = mailConfig({ ...good });
  assert.deepStrictEqual([c.mode, c.host, c.port, c.secure, c.tlsVerify, c.user], ['smtp', 'smtp.example.com', 587, false, true, '']);
  const full = mailConfig({ ...good, SMTP_PORT: '465', SMTP_SECURE: 'true', SMTP_USER: 'u', SMTP_PASSWORD: 'p', SMTP_TLS_VERIFY: 'false' });
  assert.deepStrictEqual([full.port, full.secure, full.tlsVerify, full.user, full.pass], [465, true, false, 'u', 'p']);
  assert.throws(() => mailConfig({ SMTP_HOST: 'h' }), /SMTP_FROM is required/);
  assert.throws(() => mailConfig({ SMTP_HOST: 'h', SMTP_FROM: 'not an address' }), /SMTP_FROM is required/);
  assert.throws(() => mailConfig({ ...good, SMTP_PORT: 'abc' }), /SMTP_PORT/);
  assert.throws(() => mailConfig({ ...good, SMTP_PORT: '70000' }), /SMTP_PORT/);
  assert.throws(() => mailConfig({ ...good, SMTP_USER: 'u' }), /go together/);
  assert.throws(() => mailConfig({ ...good, SMTP_PASSWORD: 'p' }), /go together/);
  assert.throws(() => mailConfig({ ...good, SMTP_SECURE: 'yes' }), /SMTP_SECURE must be true or false/);
});

test('the plain-text version keeps paragraphs and list items', () => {
  assert.strictEqual(htmlToText('<p>Hi Jane,</p><p>It is &lt;done&gt; &amp; closed.</p><ul><li>one</li><li>two</li></ul>'), 'Hi Jane,\n\nIt is <done> & closed.\n\n- one\n- two');
});

test('a message goes through an SMTP server with sender, recipient, subject and both text and HTML', async () => {
  const sink = await startSink();
  try {
    const cfg = mailConfig({ ...good, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(sink.port) });
    await sendMail(createSmtpTransport(cfg), { from: cfg.from, to: 'jane@example.com', subject: '[INC0000042] Printer down', html: '<p>Hi Jane,</p><p>Assigned to you.</p>' });
    assert.strictEqual(sink.messages.length, 1);
    const m = sink.messages[0];
    assert.deepStrictEqual([m.from, m.to], ['helpdesk@example.com', ['jane@example.com']]);
    assert.match(m.raw, /^From: NovaDesk <helpdesk@example\.com>/m);
    assert.match(m.raw, /^Subject: \[INC0000042\] Printer down/m);
    assert.match(m.raw, /Content-Type: text\/plain/);
    assert.match(m.raw, /Content-Type: text\/html/);
    assert.match(m.raw, /Assigned to you\./);
  } finally { await sink.close(); }
});

test('a notice says it is automatic, and where a reply should go (so replies can become comments, and auto-responders stay quiet)', async () => {
  const sink = await startSink();
  try {
    const cfg = mailConfig({ ...good, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(sink.port) });
    const info = await sendMail(createSmtpTransport(cfg), { from: cfg.from, to: 'jane@example.com', subject: '[INC0000042] Printer down', html: '<p>x</p>', replyTo: 'help@example.com' });
    const m = sink.messages[0];
    assert.match(m.raw, /^Auto-Submitted: auto-generated/m);
    assert.match(m.raw, /^X-Auto-Response-Suppress: All/m);
    assert.match(m.raw, /^Reply-To: help@example\.com/m);
    assert.match(m.raw, /^Message-ID: <[^>]+>/m, 'a Message-ID, which NovaDesk keeps to match a reply');
    assert.ok(info.messageId && m.raw.includes(info.messageId.replace(/^<|>$/g, '')), 'and sendMail hands it back');
    await sendMail(createSmtpTransport(cfg), { from: cfg.from, to: 'jane@example.com', subject: 'no reply-to', html: '<p>x</p>' });
    assert.ok(!/^Reply-To:/m.test(sink.messages[1].raw), 'no Reply-To unless the help desk address is set');
  } finally { await sink.close(); }
});

test('a subject with a line break cannot add headers', async () => {
  const sink = await startSink();
  try {
    const cfg = mailConfig({ ...good, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(sink.port) });
    await sendMail(createSmtpTransport(cfg), { from: cfg.from, to: 'jane@example.com', subject: 'Hello\r\nBcc: attacker@example.com', html: '<p>x</p>' });
    assert.doesNotMatch(sink.messages[0].raw, /^Bcc:/m);
  } finally { await sink.close(); }
});

test('a server that is not there is an error that names it', async () => {
  const sink = await startSink(); const port = sink.port; await sink.close();
  const cfg = mailConfig({ ...good, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port) });
  await assert.rejects(sendMail(createSmtpTransport(cfg), { from: cfg.from, to: 'a@example.com', subject: 's', html: '<p>x</p>' }), (err) => {
    assert.match(describeError(err, cfg), new RegExp(`127\\.0\\.0\\.1:${port}`));
    return true;
  });
});

test('sign-in credentials are never sent over a connection that cannot be encrypted', async () => {
  const sink = await startSink({ auth: { user: 'mailer', pass: 'secret' } });   // offers AUTH but no TLS
  try {
    const cfg = mailConfig({ ...good, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(sink.port), SMTP_USER: 'mailer', SMTP_PASSWORD: 'secret' });
    await assert.rejects(sendMail(createSmtpTransport(cfg), { from: cfg.from, to: 'a@example.com', subject: 's', html: '<p>x</p>' }), /STARTTLS|TLS/i);
    assert.strictEqual(sink.messages.length, 0);
  } finally { await sink.close(); }
});

// Over TLS from the first byte (port 465 style) with a sign-in: the way most mail providers work.
// Needs openssl to make a throwaway certificate; skipped where it is missing.
let tlsMaterial = null;
try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-mail-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-subj', '/CN=localhost', '-days', '1'], { stdio: 'ignore' });
  tlsMaterial = { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
} catch { /* no openssl */ }

test('TLS with a sign-in: the right password delivers, the wrong one is refused', { skip: !tlsMaterial && 'openssl not available' }, async () => {
  const sink = await startSink({ tls: tlsMaterial, auth: { user: 'mailer', pass: 'secret' } });
  try {
    const base = { ...good, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(sink.port), SMTP_SECURE: 'true', SMTP_TLS_VERIFY: 'false', SMTP_USER: 'mailer' };
    const ok = mailConfig({ ...base, SMTP_PASSWORD: 'secret' });
    await sendMail(createSmtpTransport(ok), { from: ok.from, to: 'jane@example.com', subject: 'signed in', html: '<p>x</p>' });
    assert.strictEqual(sink.messages.length, 1);
    const bad = mailConfig({ ...base, SMTP_PASSWORD: 'wrong' });
    await assert.rejects(sendMail(createSmtpTransport(bad), { from: bad.from, to: 'jane@example.com', subject: 'no', html: '<p>x</p>' }), /Invalid login|535|Authentication/i);
    assert.strictEqual(sink.messages.length, 1);
    // A certificate nobody vouches for is refused unless SMTP_TLS_VERIFY=false.
    const strict = mailConfig({ ...base, SMTP_PASSWORD: 'secret', SMTP_TLS_VERIFY: 'true' });
    await assert.rejects(sendMail(createSmtpTransport(strict), { from: strict.from, to: 'jane@example.com', subject: 'no', html: '<p>x</p>' }), /self.signed|certificate/i);
  } finally { await sink.close(); }
});
