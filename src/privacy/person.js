// What NovaDesk holds about one person, and the file that hands it over (a "subject access" request).
//
// SECTIONS is the single list of where a person turns up. The same entries give the counts on the privacy page and the
// rows in the downloaded file, so the two cannot drift apart. Text written by someone else (another person's incident
// description, their comments on a ticket this person worked on) is not in the file: only the person's own words and the
// facts of their involvement. Secrets (password hash, two-step secret, API key hashes) are never included.
'use strict';
const { db } = require('../db');

const LIMIT = 20000;   // rows per section in the file; a section that hits it says so

// Each section: id, label, from/where (SQL after FROM, using ? once or twice for the person: bound as `bind`), select.
// bind(person) gives the parameters in order.
const byId = (p) => [p.id];
// Matching on an email only when the person has one (an anonymised person has none, and "" must not match anything).
const emailOf = (p) => p.email || '';

const SECTIONS = [
  { id: 'sign_in_methods', label: 'Single sign-on links', bind: byId,
    select: 'issuer, email, created_at, last_login_at', from: 'user_identities WHERE user_id = ? ORDER BY id' },
  { id: 'api_keys', label: 'API keys', bind: byId,
    select: 'name, prefix, scope, expires_at, last_used_at, revoked_at, created_at', from: 'api_keys WHERE user_id = ? ORDER BY id' },
  { id: 'sessions', label: 'Open sign-ins', bind: byId,
    select: 'created_at, last_seen_at, expires_at, ip, user_agent', from: 'sessions WHERE user_id = ? ORDER BY created_at' },
  { id: 'assignment_groups', label: 'Assignment groups', bind: byId,
    select: 'group_name', from: 'user_assignment_groups WHERE user_id = ? ORDER BY group_name' },
  { id: 'incidents_raised', label: 'Incidents they reported (caller)', bind: byId,
    select: 'number, short_description, description, category, priority, status, created_at, updated_at, resolved_at', from: 'incidents WHERE caller_id = ? ORDER BY id' },
  { id: 'incidents_assigned', label: 'Incidents assigned to them', bind: byId,
    select: 'number, short_description, status, created_at', from: 'incidents WHERE assigned_to = ? ORDER BY id' },
  { id: 'requests_made', label: 'Service requests they made', bind: byId,
    select: 'number, notes, status, created_at, updated_at, fulfilled_at', from: 'service_requests WHERE requested_by = ? ORDER BY id' },
  { id: 'requests_assigned', label: 'Service requests assigned to them', bind: byId,
    select: 'number, status, created_at', from: 'service_requests WHERE assigned_to = ? ORDER BY id' },
  { id: 'changes_requested', label: 'Changes they requested', bind: byId,
    select: 'number, short_description, description, change_type, risk, status, approval_status, created_at, updated_at', from: 'changes WHERE requested_by = ? ORDER BY id' },
  { id: 'changes_assigned', label: 'Changes assigned to them', bind: byId,
    select: 'number, short_description, status, created_at', from: 'changes WHERE assigned_to = ? ORDER BY id' },
  { id: 'changes_approved', label: 'Changes they approved', bind: byId,
    select: 'number, short_description, status, approval_status, created_at', from: 'changes WHERE approved_by = ? ORDER BY id' },
  { id: 'problems_raised', label: 'Problems they raised', bind: byId,
    select: 'number, short_description, description, status, created_at', from: 'problems WHERE raised_by = ? ORDER BY id' },
  { id: 'problems_assigned', label: 'Problems assigned to them', bind: byId,
    select: 'number, short_description, status, created_at', from: 'problems WHERE assigned_to = ? ORDER BY id' },
  { id: 'cis_owned', label: 'Configuration items they own', bind: byId,
    select: 'ci_number, name, ci_type, environment, status', from: 'cmdb_ci WHERE owner_id = ? ORDER BY id' },
  { id: 'cis_created', label: 'Configuration items they created', bind: byId,
    select: 'ci_number, name, ci_type, created_at', from: 'cmdb_ci WHERE created_by = ? ORDER BY id' },
  { id: 'articles', label: 'Knowledge articles they wrote', bind: byId,
    select: 'number, title, category, status, body, created_at, updated_at', from: 'kb_articles WHERE author_id = ? ORDER BY id' },
  { id: 'incident_comments', label: 'Comments they wrote on incidents', bind: byId,
    select: 'i.number AS record, c.comment, c.created_at', from: 'incident_comments c JOIN incidents i ON i.id = c.incident_id WHERE c.user_id = ? ORDER BY c.id' },
  { id: 'change_comments', label: 'Comments they wrote on changes', bind: byId,
    select: 'ch.number AS record, c.comment, c.created_at', from: 'change_comments c JOIN changes ch ON ch.id = c.change_id WHERE c.user_id = ? ORDER BY c.id' },
  { id: 'problem_comments', label: 'Comments they wrote on problems', bind: byId,
    select: 'p.number AS record, c.comment, c.created_at', from: 'problem_comments c JOIN problems p ON p.id = c.problem_id WHERE c.user_id = ? ORDER BY c.id' },
  { id: 'attachments', label: 'Files they uploaded', bind: byId,
    select: 'entity_type, entity_id, original_name, mime_type, size, created_at', from: 'attachments WHERE uploaded_by = ? ORDER BY id' },
  { id: 'watching', label: 'Records they follow', bind: byId,
    select: 'entity_type, entity_id, created_at', from: 'watchers WHERE user_id = ? ORDER BY id' },
  { id: 'activity', label: 'Entries in ticket histories made by them', bind: byId,
    select: 'entity_type, entity_id, message, created_at', from: 'activity_log WHERE actor_id = ? ORDER BY id' },
  { id: 'audit_as_actor', label: 'Audit log: what they did', bind: byId,
    select: 'at, action, target_type, target_name, detail, ip', from: 'audit_log WHERE actor_id = ? ORDER BY at' },
  { id: 'audit_as_target', label: 'Audit log: what was done to their account', bind: byId,
    select: 'at, action, actor_name, detail, ip', from: "audit_log WHERE target_type = 'user' AND target_id = ? ORDER BY at" },
  { id: 'notices', label: 'Email notices sent to them', bind: (p) => [emailOf(p), emailOf(p)],
    select: 'recipient_email, subject, body, status, related_type, related_id, created_at', from: "notifications WHERE ? <> '' AND lower(recipient_email) = lower(?) ORDER BY id" },
  { id: 'inbound', label: 'Email they sent to the help desk', bind: (p) => [emailOf(p), emailOf(p), p.id],
    select: 'received_at, from_address, from_name, subject, outcome, record_type, record_id', from: "inbound_emails WHERE (? <> '' AND lower(from_address) = lower(?)) OR sender_user_id = ? ORDER BY id" },
  { id: 'imports', label: 'Imports they ran', bind: byId,
    select: 'kind, mode, filename, status, created_at, finished_at', from: 'imports WHERE user_id = ? ORDER BY id' },
  { id: 'webhooks', label: 'Webhooks they created', bind: byId,
    select: 'name, url, events, active, created_at', from: 'webhooks WHERE created_by = ? ORDER BY id' },
];

async function loadPerson(userId) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

// How many rows each section would hold, for the privacy page. [{id, label, count}] with the empty ones left out.
async function counts(person) {
  const out = [];
  for (const s of SECTIONS) {
    const n = Number((await db.prepare(`SELECT COUNT(*) AS c FROM ${s.from.replace(/ ORDER BY.*$/, '')}`).get(...s.bind(person))).c);
    if (n) out.push({ id: s.id, label: s.label, count: n });
  }
  return out;
}

// The profile as it is stored, without anything secret.
const profileOf = (p) => ({
  id: p.id, username: p.username, full_name: p.full_name, email: p.email, role: p.role, department: p.department,
  active: Boolean(p.active), email_notifications: Boolean(p.email_notifications), theme: p.theme_preference,
  created_at: p.created_at, created_from_email: Boolean(p.created_from_email), anonymised_at: p.anonymised_at || null,
});

// The whole file: a plain object, ready to be written as JSON.
async function exportPerson(userId, { by, generatedAt }) {
  const person = await loadPerson(userId);
  if (!person) return null;
  const sections = {}; const truncated = [];
  for (const s of SECTIONS) {
    const rows = await db.prepare(`SELECT ${s.select} FROM ${s.from} LIMIT ${LIMIT + 1}`).all(...s.bind(person));
    if (rows.length > LIMIT) { rows.length = LIMIT; truncated.push(s.id); }
    sections[s.id] = rows;
  }
  const mfa = await db.prepare('SELECT enabled, created_at, enabled_at FROM user_mfa WHERE user_id = ?').get(person.id);
  const codes = await db.prepare('SELECT COUNT(*) AS total, COUNT(used_at) AS used FROM user_recovery_codes WHERE user_id = ?').get(person.id);
  return {
    about: {
      what: `Everything NovaDesk holds about ${person.full_name} (${person.username}) that identifies them or was written by them.`,
      generated_at: generatedAt, generated_by: by,
      times: 'All times are UTC.',
      not_included: [
        'Password hashes, the two-step verification secret, recovery codes and API key secrets (they are never shown to anyone).',
        'Text written by other people on the same records (their descriptions and comments); only the facts of this person\'s involvement are listed.',
        'Copies kept elsewhere: server backups, the mail server, and other systems connected to NovaDesk.',
      ],
      truncated_sections: truncated,
    },
    profile: profileOf(person),
    two_step_verification: mfa ? { enabled: Boolean(mfa.enabled), set_up_at: mfa.created_at, enabled_at: mfa.enabled_at, recovery_codes: Number(codes.total), recovery_codes_used: Number(codes.used) } : null,
    ...sections,
  };
}

module.exports = { SECTIONS, LIMIT, loadPerson, counts, exportPerson, profileOf };
