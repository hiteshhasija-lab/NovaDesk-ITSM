// What becomes of one incoming message, whichever way it arrived (the mailbox, or POST /api/inbound/email):
//
//   claim it (a message is only ever handled once)  ->  refuse what must not be answered (our own mail, machines, blocked or
//   forged senders, floods)  ->  find or make the sender  ->  a reply to a ticket the sender is on adds a comment,
//   anything else opens an incident  ->  keep the files  ->  write down what was done and why.
//
// Every message ends as one row in inbound_emails, so the administrator can see what happened to each.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, logActivity, nowStr } = require('../db');
const { inboundConfig, mailConfig } = require('../settings');
const { audit } = require('../audit');
const { MAX_FILE_SIZE, BLOCKED_EXTENSIONS, uploadRoot } = require('../collab');
const incidentActions = require('../incidentActions');
const rules = require('./rules');

const MAX_FILES = 10;
const MIN_INLINE_BYTES = 10 * 1024;               // a signature logo is not an attachment
const STALE_CLAIM_MS = 10 * 60 * 1000;            // a message claimed this long ago by a run that never finished is taken again

const ownAddresses = (cfg, env) => {
  const set = new Set();
  if (cfg.address) set.add(cfg.address);
  try { const from = mailConfig(env).from; const m = from && /<([^<>]+)>|([^\s<>]+@[^\s<>]+)/.exec(from); if (m) set.add(rules.normalizeAddress(m[1] || m[2])); } catch { /* mail settings are checked elsewhere */ }
  return set;
};

async function finish(claimId, { outcome, reason = null, record = null, userId = null }) {
  await db.prepare('UPDATE inbound_emails SET outcome = ?, reason = ?, record_type = ?, record_id = ?, sender_user_id = ? WHERE id = ?')
    .run(outcome, reason ? String(reason).slice(0, 500) : null, record ? 'incident' : null, record || null, userId, claimId);
  return { outcome, reason, recordId: record, userId };
}

// A new row for this message, or null when it was handled before. A claim left unfinished long ago is taken over.
async function claim(msg, source) {
  const row = await db.prepare(`INSERT INTO inbound_emails (message_id, source, from_address, from_name, subject, size, outcome) VALUES (?, ?, ?, ?, ?, ?, 'processing')
    ON CONFLICT (message_id) DO NOTHING RETURNING id`)
    .get(msg.messageId, source, (msg.fromAddress || '').slice(0, 320), String(msg.fromName || '').slice(0, 200), String(msg.subject || '').slice(0, 300), msg.size || 0);
  if (row) return row.id;
  const old = await db.prepare("SELECT id, received_at FROM inbound_emails WHERE message_id = ? AND outcome = 'processing'").get(msg.messageId);
  if (old && old.received_at < new Date(Date.now() - STALE_CLAIM_MS).toISOString().slice(0, 19).replace('T', ' ')) {
    await db.prepare("UPDATE inbound_emails SET received_at = ? WHERE id = ? AND outcome = 'processing'").run(nowStr(), old.id);
    return old.id;
  }
  return null;
}

async function findSender(address) {
  return db.prepare('SELECT * FROM users WHERE LOWER(email) = ? ORDER BY active DESC, id LIMIT 1').get(address);
}

// A contact: an account that can receive notices and see its own tickets, but that nobody can sign in to until a
// password is set for it or it signs in with single sign-on.
async function createContact(msg) {
  const base = rules.contactUsername(msg.fromAddress);
  const unusable = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
  for (let n = 0; n < 50; n++) {
    const username = n ? `${base}.${n + 1}` : base;
    const row = await db.prepare(`INSERT INTO users (username, password_hash, full_name, email, role, active, created_from_email)
      VALUES (?, ?, ?, ?, 'user', 1, 1) ON CONFLICT (username) DO NOTHING RETURNING id`).get(username, unusable, rules.contactName(msg.fromName, msg.fromAddress), msg.fromAddress);
    if (row) {
      await audit(null, null, 'user.created', { targetType: 'user', targetId: row.id, targetName: username, detail: 'contact created from an email sent to the help desk' });
      return db.prepare('SELECT * FROM users WHERE id = ?').get(row.id);
    }
  }
  throw new Error('could not find a free user name for the sender');
}

async function saveAttachments(incidentId, user, attachments) {
  const dir = path.join(uploadRoot, 'incident');
  fs.mkdirSync(dir, { recursive: true });
  const skipped = [];
  let kept = 0;
  for (const a of attachments) {
    if (a.inline && a.size < MIN_INLINE_BYTES) continue;
    const name = path.basename(String(a.filename || 'attachment')).replace(/[\u0000-\u001f\u007f<>:"|?*\\/]+/g, '_').slice(0, 150) || 'attachment';
    const ext = path.extname(name).toLowerCase();
    if (BLOCKED_EXTENSIONS.has(ext)) { skipped.push(`${name} (file type not allowed)`); continue; }
    if (a.size > MAX_FILE_SIZE) { skipped.push(`${name} (over ${MAX_FILE_SIZE / 1048576} MB)`); continue; }
    if (kept >= MAX_FILES) { skipped.push(`${name} (more than ${MAX_FILES} files)`); continue; }
    const stored = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${/^\.[a-z0-9]{1,10}$/.test(ext) ? ext : ''}`;
    fs.writeFileSync(path.join(dir, stored), a.content, { flag: 'wx' });
    await db.prepare('INSERT INTO attachments (entity_type, entity_id, filename, original_name, mime_type, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('incident', incidentId, stored, name, String(a.contentType).slice(0, 100), a.size, user.id);
    await logActivity('incident', incidentId, user.id, `Attached file: ${name} (from the email)`);
    kept++;
  }
  for (const s of skipped) await logActivity('incident', incidentId, user.id, `Attachment not kept: ${s}`);
  return { kept, skipped };
}

// The incident a message is a reply to, and only when the sender is on it (the caller, the assignee, a watcher or staff).
async function replyTarget(msg, sender) {
  let incident = null;
  if (msg.inReplyTo.length) {
    const marks = msg.inReplyTo.map(() => '?').join(',');
    const note = await db.prepare(`SELECT related_id FROM notifications WHERE related_type = 'incident' AND message_id IN (${marks}) ORDER BY id DESC LIMIT 1`).get(...msg.inReplyTo);
    if (note) incident = await db.prepare('SELECT * FROM incidents WHERE id = ?').get(note.related_id);
  }
  if (!incident) {
    for (const number of rules.incidentRefs(msg.subject)) {
      incident = await db.prepare('SELECT * FROM incidents WHERE number = ?').get(number);
      if (incident) break;
    }
  }
  if (!incident) return null;
  const staff = sender.role === 'admin' || sender.role === 'agent';
  const onIt = incident.caller_id === sender.id || incident.assigned_to === sender.id
    || Boolean(await db.prepare("SELECT 1 FROM watchers WHERE entity_type = 'incident' AND entity_id = ? AND user_id = ?").get(incident.id, sender.id));
  return staff || onIt ? incident : { notOnIt: incident.number };
}

// msg: from parseMessage(). source: 'imap' or 'http'. Resolves { outcome, reason, recordId } (or { outcome: 'duplicate' }).
async function processMessage(msg, { source, env = process.env } = {}) {
  const cfg = inboundConfig(env);
  const claimId = await claim(msg, source);
  if (!claimId) return { outcome: 'duplicate' };
  try {
    if (!msg.fromAddress || !/^[^\s@]+@[^\s@]+$/.test(msg.fromAddress)) return await finish(claimId, { outcome: 'rejected', reason: 'no usable sender address' });
    if (ownAddresses(cfg, env).has(msg.fromAddress)) return await finish(claimId, { outcome: 'ignored', reason: 'sent by this help desk itself' });
    const machine = rules.automatedReason(msg.headers, { from: msg.fromAddress, subject: msg.subject });
    if (machine) return await finish(claimId, { outcome: 'ignored', reason: machine });
    if (rules.blocked(msg.fromAddress, cfg.blockedSenders)) return await finish(claimId, { outcome: 'ignored', reason: 'sender is on the block list' });

    const auth = rules.authVerdict(msg.headers);
    if (auth.verdict === 'fail') return await finish(claimId, { outcome: 'rejected', reason: `the receiving mail server could not confirm the sender (spf=${auth.spf || '-'}, dkim=${auth.dkim || '-'}, dmarc=${auth.dmarc || '-'})` });
    if (cfg.requireAuth && auth.verdict !== 'pass') return await finish(claimId, { outcome: 'rejected', reason: 'the receiving mail server did not vouch for the sender (INBOUND_REQUIRE_AUTH is on)' });

    if (cfg.maxPerSenderHour) {
      const since = new Date(Date.now() - 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      const { c } = await db.prepare("SELECT COUNT(*) AS c FROM inbound_emails WHERE from_address = ? AND received_at >= ? AND id <> ?").get(msg.fromAddress, since, claimId);
      if (c >= cfg.maxPerSenderHour) return await finish(claimId, { outcome: 'ignored', reason: `more than ${cfg.maxPerSenderHour} messages from this sender in the last hour` });
    }

    const body = rules.cleanBody(msg.text);
    const real = msg.attachments.filter((a) => !(a.inline && a.size < MIN_INLINE_BYTES));
    if (!body && !real.length && !String(msg.subject || '').trim()) return await finish(claimId, { outcome: 'ignored', reason: 'empty message' });

    let sender = await findSender(msg.fromAddress);
    if (sender && !sender.active) return await finish(claimId, { outcome: 'rejected', reason: 'the sender\'s account is switched off' });
    if (!sender) {
      if (cfg.unknownSenders === 'ignore') return await finish(claimId, { outcome: 'ignored', reason: 'the sender has no account (INBOUND_UNKNOWN_SENDERS=ignore)' });
      if (!rules.domainAllowed(msg.fromAddress, cfg.allowedDomains)) return await finish(claimId, { outcome: 'ignored', reason: 'the sender\'s domain is not in INBOUND_ALLOWED_DOMAINS' });
      sender = await createContact(msg);
    }

    const target = await replyTarget(msg, sender);
    let note = target && target.notOnIt ? `mentions ${target.notOnIt}, but the sender is not on it: opened as a new incident` : null;
    const incident = target && !target.notOnIt ? target : null;

    if (incident && ['closed', 'cancelled'].includes(incident.status)) {
      note = `a reply to ${incident.number}, which is ${incident.status}: opened as a new incident`;
    } else if (incident) {
      const text = rules.stripQuoted(body) || '(no text)';
      await incidentActions.addIncidentComment({ actor: sender, incident, comment: text, isWorkNote: false });
      await logActivity('incident', incident.id, sender.id, 'Comment added by email');
      const saved = await saveAttachments(incident.id, sender, msg.attachments);
      let reopened = '';
      if (incident.status === 'resolved') {
        await incidentActions.updateIncident({ actor: sender, existing: incident, fields: { ...incident, status: 'in_progress' } });
        await logActivity('incident', incident.id, sender.id, 'Reopened: the requester replied after it was resolved');
        reopened = '; reopened';
      }
      return await finish(claimId, { outcome: 'comment', reason: `comment on ${incident.number}${reopened}${saved.skipped.length ? `; ${saved.skipped.length} file(s) not kept` : ''}`, record: incident.id, userId: sender.id });
    }

    const created = await incidentActions.createIncident({
      actor: sender,
      fields: { short_description: rules.cleanSubject(msg.subject), description: body || null, category: 'other', impact: 3, urgency: 3, caller_id: sender.id, assigned_to: null, assignment_group: cfg.assignmentGroup },
    });
    await logActivity('incident', created.id, sender.id, `Created from an email sent by ${msg.fromAddress}`);
    const saved = await saveAttachments(created.id, sender, msg.attachments);
    return await finish(claimId, { outcome: 'ticket', reason: [note, `${created.number}`, saved.skipped.length ? `${saved.skipped.length} file(s) not kept` : null].filter(Boolean).join('; '), record: created.id, userId: sender.id });
  } catch (err) {
    // Nothing is half-recorded as done: the claim is released, so the message is tried again at the next look.
    await db.prepare("DELETE FROM inbound_emails WHERE id = ? AND outcome = 'processing'").run(claimId).catch(() => {});
    throw err;
  }
}

module.exports = { processMessage };

// A message that could not even be read (not valid mail, too large): recorded, so it is not looked at again.
async function recordUnreadable({ messageId, source, size = 0, reason, outcome = 'failed' }) {
  await db.prepare(`INSERT INTO inbound_emails (message_id, source, size, outcome, reason) VALUES (?, ?, ?, ?, ?) ON CONFLICT (message_id) DO NOTHING`)
    .run(String(messageId).slice(0, 300), source, size, outcome, String(reason).slice(0, 500));
}

module.exports.recordUnreadable = recordUnreadable;

// The list of handled messages is kept INBOUND_LOG_DAYS days (the incidents they made stay). Run daily.
async function prune(env = process.env) {
  const { logDays } = inboundConfig(env);
  if (!logDays) return 0;
  const cutoff = new Date(Date.now() - logDays * 86400 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  return (await db.prepare("DELETE FROM inbound_emails WHERE received_at < ? AND outcome <> 'processing'").run(cutoff)).changes || 0;
}
function startPruning(env = process.env) {
  prune(env).catch((err) => console.error(`[Inbound] could not prune the message list: ${err.message}`));
  const timer = setInterval(() => prune(env).catch((err) => console.error(`[Inbound] could not prune the message list: ${err.message}`)), 24 * 3600 * 1000);
  timer.unref();
  return timer;
}
module.exports.prune = prune;
module.exports.startPruning = startPruning;
