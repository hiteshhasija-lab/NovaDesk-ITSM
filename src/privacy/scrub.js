// Taking a person's name, username and email out of the free text NovaDesk keeps around them (notices, the activity and
// audit logs, inbound mail, webhook copies). The matching is done by the database so a large log is not read into memory.
'use strict';

// Shorter than this and a name is as likely to be part of a word as a person ("Al", "Bo"): left alone, and said so.
const MIN_LENGTH = 4;
const EMAIL_LABEL = '[email removed]';

// Where a person's identifiers can appear as text. Each entry is a table and the columns searched. Ticket text (titles,
// descriptions, comments) is deliberately not here: it is the record of the work and is written by many people.
const TEXT_PLACES = [
  { table: 'notifications', columns: ['recipient_email', 'recipient_name', 'subject', 'body'] },
  { table: 'activity_log', columns: ['actor_name', 'message'] },
  { table: 'audit_log', columns: ['actor_name', 'target_name', 'detail'] },
  { table: 'inbound_emails', columns: ['from_address', 'from_name', 'subject', 'reason'] },
  { table: 'webhook_deliveries', columns: ['payload', 'last_error'] },
  { table: 'decom_card_sync', columns: ['post_payload', 'last_error'] },
  { table: 'changes', columns: ['approved_by_name', 'vm_destroy_confirmed_by_name'] },
  { table: 'attachments', columns: ['original_name'] },
  { table: 'imports', columns: ['preview', 'result', 'csv'] },
  { table: 'api_idempotency', columns: ['response'] },
];

// The text to put where a person's name or username stood.
const labelFor = (userId) => `Anonymised user ${userId}`;

// Special characters of a Postgres regular expression, made literal. Only ASCII ones: a backslash before a letter is an
// escape sequence there, and letters like é are letters.
const escapeRegex = (s) => String(s).replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');

// What to look for, in the order to replace it (an email first, since it contains the username):
// [{ find, replaceWith, kind }]. Anything shorter than MIN_LENGTH is returned in `skipped`.
function patternsFor(user, extraEmails = []) {
  const found = []; const skipped = []; const seen = new Set();
  const add = (value, replaceWith, kind) => {
    const find = String(value || '').trim();
    if (!find || seen.has(find.toLowerCase())) return;
    seen.add(find.toLowerCase());
    if (find.length < MIN_LENGTH) { skipped.push({ kind, value: find }); return; }
    found.push({ find, replaceWith, kind });
  };
  [user.email, ...extraEmails].forEach((e) => add(e, EMAIL_LABEL, 'email'));
  add(user.full_name, labelFor(user.id), 'name');
  add(user.username, labelFor(user.id), 'username');
  return { patterns: found, skipped };
}

// The matching expression: the value standing alone (not inside a longer word or address), whatever its capitals.
const regexFor = (find) => `(^|[^[:alnum:]])${escapeRegex(find)}(?![[:alnum:]])`;

// Replaces every pattern in every place; `run` is a db or a transaction. Returns how many values were changed.
async function scrubText(run, patterns) {
  let changed = 0;
  for (const place of TEXT_PLACES) {
    for (const column of place.columns) {
      for (const p of patterns) {
        const r = await run.prepare(`UPDATE ${place.table} SET ${column} = regexp_replace(${column}, ?, ?, 'gi')
          WHERE ${column} IS NOT NULL AND strpos(lower(${column}), lower(?)) > 0`).run(regexFor(p.find), `\\1${p.replaceWith}`, p.find);
        changed += r.changes || 0;
      }
    }
  }
  return changed;
}

module.exports = { MIN_LENGTH, EMAIL_LABEL, TEXT_PLACES, labelFor, escapeRegex, regexFor, patternsFor, scrubText };
