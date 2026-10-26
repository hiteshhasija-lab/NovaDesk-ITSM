// Reads the help desk's mailbox over IMAP: every INBOUND_POLL_SECONDS it looks for unread messages, hands each to the
// intake (process.js) and marks it read only once it has been dealt with. A message that could not be dealt with
// because something was down (the database, say) stays unread and is tried again at the next look.
'use strict';
const { ImapFlow } = require('imapflow');
const { inboundConfig } = require('../settings');
const parse = require('./parse');
const intake = require('./process');

// What the poller calls out to; tests replace these (and the mail client) to try it without a mail server or a database.
const deps = { parseMessage: parse.parseMessage, processMessage: intake.processMessage, recordUnreadable: intake.recordUnreadable, createClient: null };

const BATCH = 25;                          // messages dealt with per look; the rest wait for the next one
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TRIES = 3;
const attempts = new Map();               // message key -> failed tries (kept in memory: a restart gives a message a fresh start)

const state = { configured: false, mailbox: null, folder: null, running: false, lastStartedAt: null, lastFinishedAt: null, lastOk: null, lastError: null, lastHandled: 0, failures: 0, nextAt: null };
let timer = null;
let cfg = null;

function connect() {
  if (deps.createClient) return deps.createClient(cfg);
  const c = cfg.imap;
  const client = new ImapFlow({
    host: c.host, port: c.port, secure: c.secure, auth: { user: c.user, pass: c.pass },
    tls: { rejectUnauthorized: c.tlsVerify }, logger: false, disableAutoIdle: true,
    greetingTimeout: 15000, socketTimeout: 60000,
  });
  client.on('error', () => { /* reported through the failed call; an unhandled 'error' event would stop the process */ });
  return client;
}

async function lookOnce() {
  const c = cfg.imap;
  const client = connect();
  let handled = 0;
  await client.connect();
  try {
    const lock = await client.getMailboxLock(c.folder);
    try {
      const uids = (await client.search({ seen: false }, { uid: true })) || [];
      for (const uid of uids.sort((x, y) => x - y).slice(0, BATCH)) {
        const key = `imap:${c.user}:${c.folder}:${client.mailbox.uidValidity}:${uid}`;
        let done = true;
        try {
          const head = await client.fetchOne(uid, { size: true }, { uid: true });
          if (head && head.size > cfg.maxMessageBytes) {
            await deps.recordUnreadable({ messageId: key, source: 'imap', size: head.size, reason: `larger than the ${Math.round(cfg.maxMessageBytes / 1048576)} MB limit (INBOUND_MAX_MESSAGE_MB): not read`, outcome: 'rejected' });
          } else {
            const full = await client.fetchOne(uid, { source: true }, { uid: true });
            let parsed = null;
            try { parsed = await deps.parseMessage(full.source); } catch (err) { await deps.recordUnreadable({ messageId: key, source: 'imap', size: head ? head.size : 0, reason: `could not be read as an email: ${err.message}` }); }
            if (parsed) await deps.processMessage(parsed, { source: 'imap' });
          }
          attempts.delete(key);
        } catch (err) {
          // Something was down (the database, say): leave the message unread and try again at the next look, a few times;
          // a message that keeps failing is written down and set aside so it cannot hold up the ones behind it.
          const n = (attempts.get(key) || 0) + 1;
          attempts.set(key, n);
          console.warn(`[Inbound] a message could not be handled (try ${n} of ${MAX_TRIES}): ${err.message}`);
          if (n >= MAX_TRIES) {
            // Set aside only if that can be written down: with the database down it cannot, and the message must wait.
            try {
              await deps.recordUnreadable({ messageId: key, source: 'imap', reason: `could not be handled after ${MAX_TRIES} tries: ${String(err.message).slice(0, 200)}` });
              attempts.delete(key);
            } catch { done = false; }
          } else done = false;
        }
        if (done) {
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
          if (c.processedFolder) await client.messageMove(uid, c.processedFolder, { uid: true }).catch((e) => console.warn(`[Inbound] could not move a message to ${c.processedFolder}: ${e.message}`));
          handled++;
        }
      }
    } finally { lock.release(); }
  } finally { await client.logout().catch(() => client.close()); }
  return handled;
}

async function poll() {
  if (state.running || !cfg || !cfg.imap) return;
  state.running = true; state.lastStartedAt = new Date().toISOString();
  let timeout;
  try {
    const handled = await Promise.race([lookOnce(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('the mailbox did not answer in time')), POLL_TIMEOUT_MS); })]);
    if (state.lastError) console.log('[Inbound] the mailbox answers again.');
    Object.assign(state, { lastOk: new Date().toISOString(), lastError: null, lastHandled: handled, failures: 0 });
    if (handled) console.log(`[Inbound] ${handled} message${handled === 1 ? '' : 's'} handled.`);
  } catch (err) {
    state.failures++;
    const text = String((err && (err.responseText || err.message)) || err).slice(0, 300);
    if (text !== state.lastError) console.warn(`[Inbound] could not read the mailbox ${cfg.imap.user}@${cfg.imap.host}: ${text}`);
    state.lastError = text;
  } finally {
    clearTimeout(timeout);
    state.running = false; state.lastFinishedAt = new Date().toISOString();
    schedule();
  }
}

function schedule() {
  clearTimeout(timer);
  const wait = Math.min(cfg.imap.pollSeconds * 2 ** Math.min(state.failures, 4), 900) * 1000;   // a mailbox that fails is asked less and less often
  state.nextAt = new Date(Date.now() + wait).toISOString();
  timer = setTimeout(poll, wait);
  timer.unref();
}

function start(env = process.env) {
  cfg = inboundConfig(env);
  state.configured = Boolean(cfg.imap);
  if (!cfg.imap) return false;
  state.mailbox = `${cfg.imap.user} at ${cfg.imap.host}`; state.folder = cfg.imap.folder;
  console.log(`Inbound email: reading ${cfg.imap.folder} of ${cfg.imap.user} at ${cfg.imap.host}:${cfg.imap.port} every ${cfg.imap.pollSeconds} s; unknown senders: ${cfg.unknownSenders}.`);
  clearTimeout(timer);
  timer = setTimeout(poll, 3000);
  timer.unref();
  return true;
}
function stop() { clearTimeout(timer); timer = null; }
// "Check now": look at once, and resolve when that look is over.
async function checkNow() { if (!cfg || !cfg.imap) return false; clearTimeout(timer); await poll(); return true; }

module.exports = { start, stop, checkNow, state: () => ({ ...state }), lookOnce, _test: { deps, setConfig: (c) => { cfg = c; }, attempts, MAX_TRIES } };
