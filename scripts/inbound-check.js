#!/usr/bin/env node
// Inbound email, tried against a real mail server (GreenMail: SMTP + IMAP in one test container) and a copy of NovaDesk
// that this script starts itself (port 18240) on the database named by PGHOST, PGUSER, PGPASSWORD and PGDATABASE:
//   mail in by IMAP becomes an incident and a contact, a reply becomes a comment (matched by the notice's Message-ID, or by the
//   [INC...] tag, only for someone on the incident), nothing is made twice, machines and floods are not answered,
//   files are kept or refused, the same intake over HTTP with its secret, and the administrator's page.
// Needs the demonstration users and GreenMail with the user help@desk.test (password helppw):
//   GREENMAIL_OPTS="-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=help:helppw@desk.test"
// Ports: INBOUND_TEST_SMTP_PORT (default 13025) and INBOUND_TEST_IMAP_PORT (default 13143) on INBOUND_TEST_HOST (127.0.0.1).
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const { ImapFlow } = require('imapflow');
const knexLib = require('knex');
const { dbConfig } = require('../src/settings');

const ROOT = path.join(__dirname, '..');
const HOST = process.env.INBOUND_TEST_HOST || '127.0.0.1';
const SMTP_PORT = Number(process.env.INBOUND_TEST_SMTP_PORT || 13025);
const IMAP_PORT = Number(process.env.INBOUND_TEST_IMAP_PORT || 13143);
const SECRET = 'inbound-check-secret-0123456789abcdef';
const tag = Math.random().toString(36).slice(2, 8);
const PORT = 18240; const BASE = `http://127.0.0.1:${PORT}`;
let failed = 0; let section = '';
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  [${section}] ${name}${!ok && extra ? '  -- ' + extra : ''}`); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const smtp = nodemailer.createTransport({ host: HOST, port: SMTP_PORT, secure: false });
const addr = (name) => `${name}.${tag}@corp.test`;
const ENV = {
  PORT: String(PORT), HOST: '127.0.0.1', SEED_DEMO: 'true', SLA_SWEEP_S: '3600', SESSION_SECRET: `inbound-check-${tag}`,
  SMTP_HOST: HOST, SMTP_PORT: String(SMTP_PORT), SMTP_FROM: 'NovaDesk <help@desk.test>',
  INBOUND_IMAP_HOST: HOST, INBOUND_IMAP_PORT: String(IMAP_PORT), INBOUND_IMAP_SECURE: 'false', INBOUND_IMAP_USER: 'help', INBOUND_IMAP_PASSWORD: 'helppw',
  INBOUND_ADDRESS: 'help@desk.test', INBOUND_POLL_SECONDS: '3600', INBOUND_SECRET: SECRET, INBOUND_BLOCKED_SENDERS: 'blocked.test', INBOUND_MAX_PER_SENDER_HOUR: '30',
};

class Browser {
  constructor() { this.cookie = ''; this.csrf = null; }
  jar(res) { for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]; const j = Object.fromEntries(this.cookie.split('; ').filter(Boolean).map((x) => [x.split('=')[0], x])); j[kv.split('=')[0]] = kv; this.cookie = Object.values(j).join('; '); } }
  async get(p) { const r = await fetch(BASE + p, { headers: { Cookie: this.cookie }, redirect: 'manual' }); this.jar(r); const text = await r.text(); const m = text.match(/<meta name="csrf-token" content="([^"]+)"/); if (m) this.csrf = m[1]; return { status: r.status, text, loc: r.headers.get('location') }; }
  async post(p, form = {}) { if (!this.csrf) { await this.get('/login'); if (!this.csrf) await this.get('/profile'); } const r = await fetch(BASE + p, { method: 'POST', headers: { Cookie: this.cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: this.csrf, ...form }).toString(), redirect: 'manual' }); this.jar(r); const text = await r.text(); if (r.headers.getSetCookie().length) this.csrf = null; const m = text.match(/<meta name="csrf-token" content="([^"]+)"/); if (m) this.csrf = m[1]; return { status: r.status, text, loc: r.headers.get('location') }; }
}

function startApp(env) {
  const log = [];
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => log.push(String(d))); child.stderr.on('data', (d) => log.push(String(d)));
  return { child, text: () => log.join(''), exited: new Promise((r) => child.on('exit', r)) };
}
async function healthy(app) { for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/health`)).ok) return true; } catch { /* wait */ } if (app.child.exitCode !== null) return false; await sleep(500); } return false; }

const raw = (opts) => new Promise((resolve, reject) => new MailComposer({ from: 'x@corp.test', to: 'help@desk.test', ...opts }).compile().build((e, b) => (e ? reject(e) : resolve(b))));
async function hand(buf, secret = SECRET) { return fetch(`${BASE}/api/inbound/email`, { method: 'POST', headers: { 'Content-Type': 'message/rfc822', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) }, body: buf }); }
const sendMail = (o) => smtp.sendMail({ to: 'help@desk.test', ...o });

async function readMailbox(user, pass, wanted, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const c = new ImapFlow({ host: HOST, port: IMAP_PORT, secure: false, auth: { user, pass }, logger: false, disableAutoIdle: true });
    c.on('error', () => {});
    try {
      await c.connect(); const lock = await c.getMailboxLock('INBOX');
      try {
        const found = [];
        for await (const m of c.fetch('1:*', { envelope: true, source: true }, { uid: false })) found.push(m);
        const hit = found.reverse().find((m) => wanted(m));
        if (hit) return hit;
      } finally { lock.release(); }
    } catch { /* not there yet */ } finally { await c.logout().catch(() => {}); }
    await sleep(500);
  }
  return null;
}

async function main() {
  const knex = knexLib({ client: 'pg', connection: dbConfig(process.env), pool: { min: 0, max: 3 } });
  const app = startApp(ENV);
  try {
    if (!(await healthy(app))) throw new Error(`NovaDesk did not start: ${app.text().slice(-500)}`);
    await run(knex, app);
  } finally { app.child.kill(); await app.exited; }
  try { await variants(knex); } finally { await knex.destroy(); }
}

async function run(knex, app) {
  const admin = new Browser(); await admin.post('/login', { username: 'admin', password: 'admin123' });
  const looked = async () => { const r = await admin.post('/settings/inbound/check'); await sleep(300); return r; };
  const one = (sql, p = []) => knex.raw(sql, p).then((r) => r.rows[0]);
  const inboundBy = (msgSubject) => one('SELECT * FROM inbound_emails WHERE subject = ? ORDER BY id DESC LIMIT 1', [msgSubject]);
  const incident = (id) => one('SELECT * FROM incidents WHERE id = ?', [id]);

  section = 'mailbox: a new message';
  const pat = addr('pat'); const subj1 = `Printer on floor 3 is jammed ${tag}`;
  await sendMail({ from: `"Pat Example" <${pat}>`, subject: subj1, text: 'Hi,\n\nThe printer next to the lift keeps jamming.\n\nThanks,\nPat' });
  await sleep(500); await looked();
  const row1 = await inboundBy(subj1);
  check('it becomes an incident', row1 && row1.outcome === 'ticket' && row1.record_id, JSON.stringify(row1 && [row1.outcome, row1.reason]));
  const inc1 = row1 && await incident(row1.record_id);
  check('with the subject as title, the text as description, and low priority', inc1 && inc1.short_description === subj1 && /printer next to the lift/.test(inc1.description) && inc1.priority === 4 && inc1.status === 'new');
  const contact = await one('SELECT * FROM users WHERE LOWER(email) = ?', [pat]);
  check('the sender, who had no account, is now a contact who cannot sign in', contact && contact.created_from_email === 1 && contact.role === 'user' && contact.full_name === 'Pat Example' && inc1 && inc1.caller_id === contact.id);
  check('...and the contact really cannot sign in with a guess', (await new Browser().post('/login', { username: contact.username, password: 'password' })).status !== 302);
  const act = await one("SELECT message FROM activity_log WHERE entity_type = 'incident' AND entity_id = ? AND message LIKE 'Created from an email%' LIMIT 1", [inc1.id]);
  check('the history says it came from an email, and from whom', act && act.message.includes(pat));

  section = 'mailbox: the acknowledgement';
  const ack = await readMailbox(pat, pat, (m) => (m.envelope.subject || '').includes(`[${inc1.number}]`));
  check('the sender gets a notice with the incident number in the subject', Boolean(ack));
  const ackText = ack ? ack.source.toString() : '';
  check('marked as automatic, so an auto-responder at their end does not answer it', /^Auto-Submitted: auto-generated/mi.test(ackText) && /^X-Auto-Response-Suppress: All/mi.test(ackText));
  check('replies go to the help desk address', /^Reply-To: .*help@desk\.test/mi.test(ackText));
  const ackId = (ackText.match(/^Message-ID:\s*<([^>]+)>/mi) || [])[1];
  const stored = await one('SELECT related_id FROM notifications WHERE message_id = ?', [ackId || 'none']);
  check('and its Message-ID is kept, to match a reply to the incident', ackId && stored && stored.related_id === inc1.id);

  section = 'mailbox: replies';
  const subjRe = `Re: [${inc1.number}] Incident logged: ${subj1}`;
  await sendMail({ from: `"Pat Example" <${pat}>`, subject: subjRe, inReplyTo: `<${ackId}>`, references: `<${ackId}>`, text: 'It jammed again this morning.\n\nOn Mon, 26 Oct 2026 at 09:00, NovaDesk <help@desk.test> wrote:\n> Your incident INC has been logged\n> We will keep you updated' });
  await sleep(500); await looked();
  const reply = await inboundBy(subjRe);
  const c1 = await one('SELECT * FROM incident_comments WHERE incident_id = ? ORDER BY id DESC LIMIT 1', [inc1.id]);
  check('a reply to the notice becomes a comment on that incident', reply && reply.outcome === 'comment' && reply.record_id === inc1.id && c1 && c1.user_id === contact.id, JSON.stringify(reply && [reply.outcome, reply.reason]));
  check('only the new text is kept, not the quoted notice below it', c1 && c1.comment === 'It jammed again this morning.' && !/NovaDesk|wrote:|>/.test(c1.comment), c1 && c1.comment);
  check('a customer comment is public, not an internal note', c1 && c1.is_work_note === 0);

  const subjTag = `[${inc1.number}] one more thing`;
  await sendMail({ from: `"Pat Example" <${pat}>`, subject: subjTag, text: 'It is also making a grinding noise.' });
  await sleep(500); await looked();
  const byTag = await inboundBy(subjTag);
  check('a message with only the [INC...] tag in its subject is matched too', byTag && byTag.outcome === 'comment' && byTag.record_id === inc1.id, JSON.stringify(byTag && [byTag.outcome, byTag.reason]));

  const stranger = addr('stranger'); const subjStr = `Re: [${inc1.number}] hello ${tag}`;
  await sendMail({ from: stranger, subject: subjStr, text: 'I am not on this incident but I know its number.' });
  await sleep(500); await looked();
  const strRow = await inboundBy(subjStr);
  const before = await one('SELECT COUNT(*) AS c FROM incident_comments WHERE incident_id = ?', [inc1.id]);
  check('someone who is not on the incident cannot add to it by quoting its number: they get an incident of their own', strRow && strRow.outcome === 'ticket' && strRow.record_id !== inc1.id && /not on it/.test(strRow.reason), JSON.stringify(strRow && [strRow.outcome, strRow.reason]));
  check('...and the first incident gained nothing', Number(before.c) === 2);

  await knex.raw("UPDATE incidents SET status = 'resolved', resolved_at = to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?", [inc1.id]);
  const subjRes = `[${inc1.number}] still broken ${tag}`;
  await sendMail({ from: `"Pat Example" <${pat}>`, subject: subjRes, text: 'It is not fixed.' });
  await sleep(500); await looked();
  const resolvedNow = await incident(inc1.id); const resRow = await inboundBy(subjRes);
  check('a reply after the incident was resolved reopens it', resRow && resRow.outcome === 'comment' && /reopened/.test(resRow.reason) && resolvedNow.status === 'in_progress' && resolvedNow.resolved_at === null, resolvedNow.status);
  await knex.raw("UPDATE incidents SET status = 'closed', closed_at = to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?", [inc1.id]);
  const subjClosed = `[${inc1.number}] it is back ${tag}`;
  await sendMail({ from: `"Pat Example" <${pat}>`, subject: subjClosed, text: 'Same printer, again.' });
  await sleep(500); await looked();
  const closedRow = await inboundBy(subjClosed);
  check('a reply after it was closed opens a new incident instead', closedRow && closedRow.outcome === 'ticket' && closedRow.record_id !== inc1.id && /closed/.test(closedRow.reason), JSON.stringify(closedRow && [closedRow.outcome, closedRow.reason]));

  section = 'mailbox: nothing twice';
  const total = Number((await one('SELECT COUNT(*) AS c FROM inbound_emails')).c);
  await looked(); await looked();
  check('looking again finds nothing new: every message was marked read', Number((await one('SELECT COUNT(*) AS c FROM inbound_emails')).c) === total);
  const dupId = `dup-${tag}@corp.test`; const subjDup = `Same message twice ${tag}`;
  await sendMail({ from: pat, subject: subjDup, text: 'once', messageId: `<${dupId}>` });
  await sendMail({ from: pat, subject: subjDup, text: 'once', messageId: `<${dupId}>` });
  await sleep(500); await looked();
  const dupTickets = Number((await one('SELECT COUNT(*) AS c FROM incidents WHERE short_description = ?', [subjDup])).c);
  check('the same message delivered twice makes one incident', dupTickets === 1, `${dupTickets}`);

  section = 'mailbox: files';
  const subjFiles = `Screenshot attached ${tag}`;
  await sendMail({ from: pat, subject: subjFiles, text: 'See attached.', attachments: [
    { filename: 'error.txt', content: 'the error text' }, { filename: 'setup.exe', content: 'MZ-not-really' },
    { filename: 'logo.png', cid: 'logo@x', content: Buffer.from('89504e470d0a1a0a', 'hex'), contentDisposition: 'inline' } ] });
  await sleep(500); await looked();
  const fRow = await inboundBy(subjFiles);
  const files = fRow ? (await knex.raw("SELECT original_name FROM attachments WHERE entity_type = 'incident' AND entity_id = ? ORDER BY id", [fRow.record_id])).rows.map((r) => r.original_name) : [];
  check('a normal file is kept on the incident', files.includes('error.txt'), files.join(','));
  check('a program file is refused, and the history says so', !files.includes('setup.exe') && Boolean(await one("SELECT 1 FROM activity_log WHERE entity_type = 'incident' AND entity_id = ? AND message LIKE 'Attachment not kept: setup.exe%'", [fRow && fRow.record_id])));
  check('a tiny inline picture (a signature logo) is not kept', !files.includes('logo.png'));
  check('the result says some files were not kept', fRow && /1 file\(s\) not kept/.test(fRow.reason), fRow && fRow.reason);

  section = 'mailbox: text only';
  const subjHtml = `<script>alert(1)</script> html ${tag}`;
  await sendMail({ from: pat, subject: subjHtml, html: '<p>The <b>printer</b> is <script>alert(2)</script>broken</p><img src="http://evil.test/x.gif">' });
  await sleep(500); await looked();
  const hRow = await inboundBy(subjHtml); const hInc = hRow && await incident(hRow.record_id);
  check('an HTML message is stored as plain text: no tags, no script, no remote image', hInc && hInc.description === 'The printer is broken' && !/<|evil/.test(hInc.description), hInc && hInc.description);
  const page = (await admin.get('/settings/inbound')).text;
  check('and the administrator\'s page shows the subject as text, never as markup', page.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !page.includes('<script>alert(1)</script>'));

  section = 'mailbox: what is not answered';
  const sendAndSee = async (subject, extra, who = pat) => { await sendMail({ from: who, subject: `${subject} ${tag}`, text: 'body', ...extra }); await sleep(400); await looked(); return inboundBy(`${subject} ${tag}`); };
  for (const [label, extra, expect] of [
    ['an out-of-office reply (Auto-Submitted)', { subject: 'Automatic reply: away', headers: { 'Auto-Submitted': 'auto-replied' } }, /automatic/i],
    ['bulk mail (Precedence)', { subject: 'Weekly deals', headers: { Precedence: 'bulk' } }, /bulk/i],
    ['a mailing list', { subject: 'List post', headers: { 'List-Id': '<news.example.test>' } }, /list|newsletter/i],
  ]) {
    const r = await sendAndSee(extra.subject, { headers: extra.headers });
    check(`${label} is ignored, with the reason written down`, r && r.outcome === 'ignored' && expect.test(r.reason), JSON.stringify(r && [r.outcome, r.reason]));
  }
  const own = await sendAndSee('From the help desk itself', {}, 'help@desk.test');
  check('mail from the help desk\'s own address is ignored (no loop with itself)', own && own.outcome === 'ignored' && /itself/.test(own.reason), JSON.stringify(own && [own.outcome, own.reason]));
  const blockedRow = await sendAndSee('From a blocked domain', {}, `x.${tag}@blocked.test`);
  check('a sender on the block list is ignored', blockedRow && blockedRow.outcome === 'ignored' && /block list/.test(blockedRow.reason), JSON.stringify(blockedRow && [blockedRow.outcome, blockedRow.reason]));
  const noIncidents = Number((await one("SELECT COUNT(*) AS c FROM incidents WHERE short_description LIKE ?", [`%${tag}`])).c);
  check('none of those made an incident', noIncidents >= 0 && !(await one("SELECT 1 FROM incidents WHERE short_description IN (?, ?, ?, ?)", [`Automatic reply: away ${tag}`, `Weekly deals ${tag}`, `List post ${tag}`, `From a blocked domain ${tag}`])));

  section = 'mailbox: floods';
  const flooder = addr('flood'); let lastRow = null;
  for (let i = 1; i <= 33; i++) await sendMail({ from: flooder, subject: `Flood ${i} ${tag}`, text: `message ${i}` });
  await sleep(1500); await looked(); await looked(); await looked();
  const floodRows = (await knex.raw("SELECT outcome FROM inbound_emails WHERE from_address = ?", [flooder])).rows.map((r) => r.outcome);
  lastRow = await one("SELECT reason FROM inbound_emails WHERE from_address = ? AND outcome = 'ignored' ORDER BY id DESC LIMIT 1", [flooder]);
  check('a sender cannot open more incidents than the limit in an hour (30 here)', floodRows.filter((o) => o === 'ticket').length === 30 && floodRows.filter((o) => o === 'ignored').length === 3, floodRows.join(','));
  check('...and the page says why', lastRow && /more than 30 messages/.test(lastRow.reason), lastRow && lastRow.reason);

  section = 'http intake';
  const noSecret = await hand(await raw({ from: addr('h1'), subject: `Via HTTP ${tag}`, text: 'handed over' }), null);
  const badSecret = await hand(await raw({ from: addr('h1'), subject: `Via HTTP ${tag}`, text: 'handed over' }), 'wrong-secret-wrong-secret-xx');
  check('without the secret, or with a wrong one: refused', noSecret.status === 401 && badSecret.status === 401);
  const msg = await raw({ from: `"Hannah Http" <${addr('h1')}>`, subject: `Via HTTP ${tag}`, text: 'handed over' });
  const ok = await hand(msg); const okBody = await ok.json();
  check('with the secret it is taken in, and the answer says what was done', ok.status === 202 && okBody.outcome === 'ticket' && okBody.incident_id, JSON.stringify(okBody));
  const again = await hand(msg); const againBody = await again.json();
  check('handing over the same message again changes nothing', again.status === 202 && againBody.outcome === 'duplicate' && Number((await one('SELECT COUNT(*) AS c FROM incidents WHERE short_description = ?', [`Via HTTP ${tag}`])).c) === 1, JSON.stringify(againBody));
  const junk = await hand(Buffer.from('')); const garbage = await hand(Buffer.from('\u0000\u0001\u0002 not an email at all'));
  check('an empty body is refused', junk.status === 400);
  check('bytes that are not an email do not crash anything (refused, or ignored as having no sender)', garbage.status === 400 || (await garbage.json()).outcome === 'rejected');
  const forged = await hand(await raw({ from: addr('h2'), subject: `Forged ${tag}`, text: 'x', headers: { 'Authentication-Results': 'mx.example.test; spf=fail smtp.mailfrom=x; dkim=none; dmarc=fail' } }));
  const forgedBody = await forged.json();
  check('mail the receiving server says is forged (DMARC fail) is rejected', forgedBody.outcome === 'rejected' && /could not confirm the sender/.test(forgedBody.reason), JSON.stringify(forgedBody));
  const forwarded = await hand(await raw({ from: addr('h3'), subject: `Forwarded ${tag}`, text: 'x', headers: { 'Authentication-Results': 'mx.example.test; spf=pass; dkim=fail; dmarc=pass' } }));
  check('a forwarded message (DKIM broke, DMARC still passes) is accepted', (await forwarded.json()).outcome === 'ticket');
  const bounce = await hand(await raw({ from: 'MAILER-DAEMON@corp.test', subject: `Undeliverable: x ${tag}`, text: 'could not deliver' }));
  check('a bounce is ignored', (await bounce.json()).outcome === 'ignored');
  const huge = await hand(Buffer.alloc(27 * 1024 * 1024, 'a'));
  check('a message over the size limit is refused before it is read', huge.status === 413, `${huge.status}`);

  section = 'administrator page';
  check('the users list marks email contacts', /email contact/.test((await admin.get('/users')).text));
  const pageHtml = (await admin.get('/settings/inbound')).text;
  check('shows the mailbox as working, and what was done with each message', /Working/.test(pageHtml) && /Incident opened/.test(pageHtml) && /Comment added/.test(pageHtml) && /Ignored/.test(pageHtml) && /Rejected/.test(pageHtml));
  check('links each result to its incident', new RegExp(`/incidents/${inc1.id}"`).test(pageHtml));
  check('never shows the mailbox password or the shared secret', !pageHtml.includes('helppw') && !pageHtml.includes(SECRET));
  check('is for administrators only', (await (async () => { const j = new Browser(); await j.post('/login', { username: 'jdoe', password: 'agent123' }); return j.get('/settings/inbound'); })()).status === 403);
  check('the log has no errors', !/\b(Error|TypeError|unhandled)/i.test(app.text().replace(/\[Inbound\] [^\n]*/g, '')), app.text().split('\n').filter((l) => /Error|unhandled/i.test(l)).slice(0, 2).join(' | '));
}

// Settings that change what happens: tried on separate copies of NovaDesk (other ports, other mailboxes), and in this process.
async function variants(knex) {
  const one = (sql, p = []) => knex.raw(sql, p).then((r) => r.rows[0]);

  section = 'a mailbox that cannot be read';
  const bad = startApp({ ...ENV, PORT: '18241', INBOUND_IMAP_PASSWORD: 'not-the-password', INBOUND_POLL_SECONDS: '10', INBOUND_SECRET: '' });
  try {
    const up = async () => { for (let i = 0; i < 60; i++) { try { if ((await fetch('http://127.0.0.1:18241/health')).ok) return true; } catch { /* wait */ } await sleep(500); } return false; };
    check('NovaDesk still starts when the mailbox password is wrong', await up());
    for (let i = 0; i < 40 && !/could not read the mailbox/.test(bad.text()); i++) await sleep(500);
    check('the log says which mailbox could not be read, once', /could not read the mailbox help@127\.0\.0\.1: /.test(bad.text()) && (bad.text().match(/could not read the mailbox/g) || []).length === 1, bad.text().split('\n').filter((l) => /Inbound/.test(l)).join(' | ').slice(0, 300));
    const j = await (async () => { const r = await fetch('http://127.0.0.1:18241/login'); return r.status; })();
    check('and the rest of the help desk works', j === 200);
  } finally { bad.child.kill(); await bad.exited; }

  section = 'processed folder and size limit';
  const desk = 'desk2@desk.test';
  { // create the folder the handled mail is moved to, as the mailbox's owner would
    const c = new ImapFlow({ host: HOST, port: IMAP_PORT, secure: false, auth: { user: desk, pass: desk }, logger: false, disableAutoIdle: true });
    c.on('error', () => {});
    await smtp.sendMail({ from: addr('seed'), to: desk, subject: `seed ${tag}`, text: 'creates the mailbox' });
    await sleep(500); await c.connect(); await c.mailboxCreate('Processed').catch(() => {}); await c.logout();
  }
  const app2 = startApp({ ...ENV, PORT: '18242', INBOUND_IMAP_USER: desk, INBOUND_IMAP_PASSWORD: desk, INBOUND_ADDRESS: desk, INBOUND_PROCESSED_FOLDER: 'Processed', INBOUND_MAX_MESSAGE_MB: '1', INBOUND_POLL_SECONDS: '10', INBOUND_SECRET: '' });
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch('http://127.0.0.1:18242/health')).ok) break; } catch { /* wait */ } await sleep(500); }
    const sub = `Moved when handled ${tag}`; const big = `Far too big ${tag}`;
    await smtp.sendMail({ from: addr('mover'), to: desk, subject: sub, text: 'move me' });
    await smtp.sendMail({ from: addr('mover'), to: desk, subject: big, text: 'x', attachments: [{ filename: 'big.bin', content: Buffer.alloc(2 * 1024 * 1024, 7) }] });
    let row = null; let rowBig = null;
    for (let i = 0; i < 40 && !(row && rowBig); i++) { await sleep(500); row = await one('SELECT * FROM inbound_emails WHERE subject = ?', [sub]); rowBig = await one("SELECT * FROM inbound_emails WHERE reason LIKE '%INBOUND_MAX_MESSAGE_MB%' AND source = 'imap' AND received_at >= to_char(NOW() AT TIME ZONE 'UTC' - interval '5 minutes', 'YYYY-MM-DD HH24:MI:SS') AND message_id LIKE ?", [`imap:${desk}:%`]); if (i === 15 && !(row && rowBig)) await sleep(8000); }
    check('a handled message becomes an incident', row && row.outcome === 'ticket', JSON.stringify(row && [row.outcome, row.reason]));
    check('a message over INBOUND_MAX_MESSAGE_MB is recorded as rejected and not read', rowBig && rowBig.outcome === 'rejected', JSON.stringify(rowBig && [rowBig.outcome, rowBig.reason]));
    const inFolder = async (folder) => { const c = new ImapFlow({ host: HOST, port: IMAP_PORT, secure: false, auth: { user: desk, pass: desk }, logger: false, disableAutoIdle: true }); c.on('error', () => {}); await c.connect(); try { const lock = await c.getMailboxLock(folder); try { return c.mailbox.exists; } finally { lock.release(); } } finally { await c.logout(); } };
    check('handled messages were moved to the Processed folder, leaving the inbox empty', (await inFolder('Processed')) >= 2 && (await inFolder('INBOX')) === 0, `${await inFolder('Processed')} / ${await inFolder('INBOX')}`);
  } finally { app2.child.kill(); await app2.exited; }

  section = 'rules that depend on settings';
  const db = require('../src/db'); const { parseMessage } = require('../src/inbound/parse'); const { processMessage } = require('../src/inbound/process');
  const handle = async (opts, env) => processMessage(await parseMessage(await raw(opts)), { source: 'http', env: { ...process.env, ...env } });
  const ign = await handle({ from: `new.${tag}@nowhere.test`, subject: `Unknown ignored ${tag}`, text: 'hello' }, { INBOUND_UNKNOWN_SENDERS: 'ignore' });
  check('INBOUND_UNKNOWN_SENDERS=ignore: a sender with no account is ignored and no account is made', ign.outcome === 'ignored' && !(await one('SELECT 1 FROM users WHERE LOWER(email) = ?', [`new.${tag}@nowhere.test`])), JSON.stringify(ign));
  const known = await handle({ from: 'jane.doe@corp.local', subject: `Known sender ${tag}`, text: 'hello' }, { INBOUND_UNKNOWN_SENDERS: 'ignore' });
  check('...but a sender who has an account still gets an incident (jdoe)', known.outcome === 'ticket', JSON.stringify(known));
  const domBad = await handle({ from: `x.${tag}@other.test`, subject: `Wrong domain ${tag}`, text: 'hello' }, { INBOUND_ALLOWED_DOMAINS: 'corp.test, partner.test' });
  const domOk = await handle({ from: `y.${tag}@partner.test`, subject: `Right domain ${tag}`, text: 'hello' }, { INBOUND_ALLOWED_DOMAINS: 'corp.test, partner.test' });
  check('INBOUND_ALLOWED_DOMAINS: an unknown sender from another domain is ignored, from a listed one is accepted', domBad.outcome === 'ignored' && /INBOUND_ALLOWED_DOMAINS/.test(domBad.reason) && domOk.outcome === 'ticket', JSON.stringify([domBad, domOk]));
  const noAuth = await handle({ from: `z.${tag}@corp.test`, subject: `No auth result ${tag}`, text: 'hello' }, { INBOUND_REQUIRE_AUTH: 'true' });
  const yesAuth = await handle({ from: `w.${tag}@corp.test`, subject: `Auth passes ${tag}`, text: 'hello', headers: { 'Authentication-Results': 'mx.example.test; dmarc=pass' } }, { INBOUND_REQUIRE_AUTH: 'true' });
  check('INBOUND_REQUIRE_AUTH=true: mail the server did not vouch for is rejected, mail it vouched for is accepted', noAuth.outcome === 'rejected' && /did not vouch/.test(noAuth.reason) && yesAuth.outcome === 'ticket', JSON.stringify([noAuth, yesAuth]));
  const grouped = await handle({ from: `g.${tag}@corp.test`, subject: `Goes to a group ${tag}`, text: 'hello' }, { INBOUND_ASSIGNMENT_GROUP: 'Service Desk' });
  const gInc = grouped.recordId && await one('SELECT assignment_group FROM incidents WHERE id = ?', [grouped.recordId]);
  check('INBOUND_ASSIGNMENT_GROUP puts new incidents in that group', gInc && gInc.assignment_group === 'Service Desk', JSON.stringify(gInc));
  const inactive = await one("SELECT id FROM users WHERE username = 'rpatel'"); await knex.raw("UPDATE users SET active = 0 WHERE id = ?", [inactive.id]);
  const off = await handle({ from: 'raj.patel@corp.local', subject: `Switched off ${tag}`, text: 'hello' }, {});
  await knex.raw("UPDATE users SET active = 1 WHERE id = ?", [inactive.id]);
  check('a sender whose account is switched off is rejected, and no second account is made for the address', off.outcome === 'rejected' && /switched off/.test(off.reason) && Number((await one('SELECT COUNT(*) AS c FROM users WHERE LOWER(email) = ?', ['raj.patel@corp.local'])).c) === 1, JSON.stringify(off));
  await db.db.raw('SELECT 1');
}

main().then(() => { console.log(failed ? `${failed} FAILED` : 'ALL PASS'); process.exit(failed ? 1 : 0); }).catch((e) => { console.error('ABORTED:', e.stack || e.message); process.exit(2); });
