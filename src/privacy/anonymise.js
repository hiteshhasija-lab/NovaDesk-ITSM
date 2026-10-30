// Anonymising a person: the account stays (so every ticket, comment and log entry still points at someone and the history
// stays whole) but nothing in it says who the person was, and it can never be signed in to again. It cannot be undone.
//
// What goes: name, username, email, department, every sign-in method (password, single sign-on, two-step verification,
// API keys, open sessions), group memberships and the records they follow. Their name, username and email are also taken
// out of the free text kept around them (notices, activity and audit logs, inbound mail, webhook copies; src/privacy/scrub.js).
// Optionally: the text of the comments they wrote, and the files they uploaded.
// What stays: the tickets and comments themselves, who did what in role terms (the anonymous account), the time of every entry.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, nowStr } = require('../db');
const sessions = require('../sessionStore');
const { uploadRoot } = require('../collab');
const { audit } = require('../audit');
const { patternsFor, scrubText, labelFor } = require('./scrub');

const REMOVED_COMMENT = '[comment removed when the account was anonymised]';

class PrivacyError extends Error {}

// Why this person cannot be anonymised right now, or null. `actor` is the administrator asking.
async function refusal(person, actor) {
  if (!person) return 'No such person.';
  if (person.anonymised_at) return 'This person has already been anonymised.';
  if (actor && person.id === actor.id) return 'You cannot anonymise your own account while you are signed in with it.';
  if (person.role === 'admin' && person.active) {
    const others = Number((await db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1 AND anonymised_at IS NULL AND id <> ?").get(person.id)).c);
    if (!others) return 'This is the only active administrator. Make someone else an administrator first.';
  }
  return null;
}

async function anonymise(personId, { actor, req = null, blankComments = false, deleteFiles = false }) {
  const person = await db.prepare('SELECT * FROM users WHERE id = ?').get(personId);
  const why = await refusal(person, actor);
  if (why) throw new PrivacyError(why);

  // Nobody can act as this person from here on, whatever happens next.
  await sessions.revokeAll(person.id);

  const identityEmails = (await db.prepare('SELECT email FROM user_identities WHERE user_id = ? AND email IS NOT NULL').all(person.id)).map((r) => r.email);
  const { patterns, skipped } = patternsFor(person, identityEmails);
  const label = labelFor(person.id);
  const unusable = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
  const files = [];
  const done = { comments: 0, files: 0, textChanged: 0 };

  await db.transaction(async (tx) => {
    // Locked out first, so a failure further down leaves nobody able to use the account.
    await tx.prepare('UPDATE users SET active = 0, password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').run(unusable, person.id);
    for (const t of ['user_identities', 'user_mfa', 'user_recovery_codes', 'user_assignment_groups', 'api_keys']) {
      await tx.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(person.id);
    }
    await tx.prepare('DELETE FROM watchers WHERE user_id = ?').run(person.id);

    if (blankComments) {
      for (const t of ['incident_comments', 'change_comments', 'problem_comments']) {
        done.comments += (await tx.prepare(`UPDATE ${t} SET comment = ? WHERE user_id = ?`).run(REMOVED_COMMENT, person.id)).changes || 0;
      }
    }
    if (deleteFiles) {
      const rows = await tx.prepare('SELECT id, entity_type, entity_id, filename FROM attachments WHERE uploaded_by = ?').all(person.id);
      for (const a of rows) {
        files.push(path.join(uploadRoot, a.entity_type, path.basename(a.filename)));
        await tx.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
        await tx.prepare('INSERT INTO activity_log (entity_type, entity_id, actor_id, message) VALUES (?, ?, ?, ?)')
          .run(a.entity_type, a.entity_id, actor.id, 'A file was removed (the account of the person who uploaded it was anonymised)');
      }
      done.files = rows.length;
    }

    done.textChanged = await scrubText(tx, patterns);
    // Their own rows in the audit log lose the address they came from too.
    await tx.prepare('UPDATE audit_log SET ip = NULL WHERE actor_id = ? OR (target_type = \'user\' AND target_id = ?)').run(person.id, person.id);

    // The person's own row last: until here its old values were still there to be found and replaced.
    let username = `anonymised-${person.id}`;
    const clash = await tx.prepare('SELECT 1 FROM users WHERE username = ? AND id <> ?').get(username, person.id);
    if (clash) username = `anonymised-${person.id}-${crypto.randomBytes(3).toString('hex')}`;
    await tx.prepare(`UPDATE users SET username = ?, full_name = ?, email = NULL, department = NULL, role = 'user', active = 0,
        email_notifications = 0, created_from_email = 0, scim_managed = 0, scim_external_id = NULL, anonymised_at = ? WHERE id = ?`).run(username, label, nowStr(), person.id);
  });

  // Files go after the database has committed: a rolled-back change must not have lost them.
  for (const f of files) fs.unlink(f, () => {});

  const detail = [
    `${done.textChanged} place${done.textChanged === 1 ? '' : 's'} in logs and notices cleaned`,
    blankComments ? `${done.comments} comment${done.comments === 1 ? '' : 's'} blanked` : 'comments kept',
    deleteFiles ? `${done.files} file${done.files === 1 ? '' : 's'} deleted` : 'files kept',
    skipped.length ? `too short to search for: ${skipped.map((s) => s.kind).join(', ')}` : null,
  ].filter(Boolean).join('; ');
  await audit(req, actor, 'privacy.anonymised', { targetType: 'user', targetId: person.id, targetName: label, detail });
  return { ...done, skipped, label };
}

module.exports = { anonymise, refusal, PrivacyError, REMOVED_COMMENT };
