// SLA settings from the database, the clock changes written back to incidents, and the sweep that emails
// warnings and breaches. The rules themselves are in sla.js.
'use strict';
const { db, logActivity } = require('./db');
const sla = require('./sla');
const { sendNotification } = require('./mailer');
const { escapeHtml } = require('./helpers');
const { isDecomChange, DECOM_GROUP } = require('./approvalAccess');

// ---------------------------------------------------------------- settings
const CACHE_MS = 15000;
let cache = null;
let cacheAt = 0;

const fallbackPolicy = (priority) => ({ applies_to: 'incident', priority, target_minutes: (sla.LEGACY_SLA_HOURS[priority] || sla.LEGACY_SLA_HOURS[4]) * 60, clock: 'calendar', warn_percent: 75 });

async function loadConfig() {
  const calendarRow = await db.prepare('SELECT * FROM business_calendars ORDER BY is_default DESC, id LIMIT 1').get();
  const holidays = calendarRow ? await db.prepare('SELECT * FROM business_holidays WHERE calendar_id = ? ORDER BY holiday_date').all(calendarRow.id) : [];
  const policies = await db.prepare('SELECT * FROM sla_policies ORDER BY applies_to, priority').all();
  let calendar;
  try {
    calendar = sla.makeCalendar(calendarRow || {}, holidays.map((h) => h.holiday_date));
  } catch (err) {
    console.error(`[SLA] the business calendar is not usable (${err.message}); using Monday to Friday 09:00-17:00 UTC until it is fixed.`);
    calendar = sla.makeCalendar({}, []);
  }
  const byKey = new Map(policies.map((p) => [`${p.applies_to}:${p.priority}`, p]));
  return {
    calendar, calendarRow, holidays, policies,
    policyFor: (priority) => byKey.get(`incident:${priority}`) || fallbackPolicy(priority),
    // The policy for service requests or changes, only while an administrator has it switched on.
    policyOf: (kind) => { const p = byKey.get(`${kind}:0`); return p && p.active ? p : null; },
    policyRow: (kind) => byKey.get(`${kind}:0`) || null,
  };
}

async function getConfig() {
  if (!cache || Date.now() - cacheAt > CACHE_MS) {
    cache = await loadConfig();
    cacheAt = Date.now();
    sla.setActiveCalendar(cache.calendar);
  }
  return cache;
}
function invalidateConfig() { cache = null; cacheAt = 0; }

// ---------------------------------------------------------------- incidents
// The clock columns for a new incident.
async function newIncidentClock(priority, startStr) {
  const cfg = await getConfig();
  return sla.startIncidentClock(sla.toMs(startStr), cfg.policyFor(priority), cfg.calendar);
}

// The clock columns for a new service request, or null while the request SLA is switched off.
async function newRequestClock(startStr) {
  const cfg = await getConfig();
  const policy = cfg.policyOf('request');
  if (!policy) return null;
  const c = sla.startIncidentClock(sla.toMs(startStr), policy, cfg.calendar);
  delete c.sla_paused_at; delete c.sla_paused_minutes;   // requests have no On Hold
  return c;
}

// What moving an incident to `status` / `priority` does to its clock: { changes, notes }.
async function incidentClockChanges(existing, { status, priority }) {
  const cfg = await getConfig();
  return sla.incidentTransition(existing, { status, priority }, Date.now(), cfg);
}

// `, sla_due_at = @sla_due_at, ...` for an UPDATE's SET list (empty when nothing changed). Column names
// come from sla.js only; the pattern check is a guard, not the filter.
function setSql(changes) {
  const keys = Object.keys(changes);
  for (const k of keys) if (!/^sla_[a-z_]+$/.test(k)) throw new Error(`unexpected SLA column ${k}`);
  return keys.map((k) => `, ${k} = @${k}`).join('');
}

async function logClockNotes(incidentId, actorId, notes) {
  for (const note of notes) await logActivity('incident', incidentId, actorId, note);
}

// ---------------------------------------------------------------- warnings and breaches
const PRIORITY_NAMES = { 1: 'Critical', 2: 'High', 3: 'Moderate', 4: 'Low' };
const wanted = (u) => u && u.email && u.email_notifications;
const USER_COLS = 'u.id, u.full_name, u.email, u.email_notifications';

async function adminsWithEmail() {
  const admins = await db.prepare(`SELECT id, full_name, email, email_notifications FROM users WHERE role = 'admin' AND active = 1 ORDER BY id`).all();
  return admins.filter(wanted);
}
async function groupMembers(group) {
  if (!group) return [];
  const members = await db.prepare(`
    SELECT ${USER_COLS} FROM user_assignment_groups g JOIN users u ON u.id = g.user_id
    WHERE g.group_name = ? AND u.active = 1 ORDER BY u.id
  `).all(group);
  return members.filter(wanted);
}
async function userWithEmail(id) {
  if (!id) return null;
  const u = await db.prepare('SELECT id, full_name, email, email_notifications FROM users WHERE id = ? AND active = 1').get(id);
  return wanted(u) ? u : null;
}

// Who is told: the assignee; without one the assignment group; without one the administrators.
async function recipientsFor(row) {
  const assignee = await userWithEmail(row.assigned_to);
  if (assignee) return [assignee];
  const group = await groupMembers(row.assignment_group);
  if (group.length) return group;
  return adminsWithEmail();
}

// A change waits for a decision from whoever may give it: a decommission change from its requester or the
// IRO-Build/Decom group, any other change from its assignee, the assignment group's admins and agents, or
// the administrators (approvalAccess.js has the rule for who may decide).
async function approversFor(change) {
  if (isDecomChange(change)) {
    const people = [];
    const requester = await userWithEmail(change.requested_by);
    if (requester) people.push(requester);
    for (const m of await groupMembers(DECOM_GROUP)) if (!people.some((p) => p.id === m.id)) people.push(m);
    return people.length ? people : adminsWithEmail();
  }
  const assignee = await userWithEmail(change.assigned_to);
  if (assignee) { const u = await db.prepare('SELECT role FROM users WHERE id = ?').get(assignee.id); if (u && ['admin', 'agent'].includes(u.role)) return [assignee]; }
  const group = (await groupMembers(change.assignment_group));
  if (group.length) {
    const roles = await db.prepare(`SELECT id FROM users WHERE role IN ('admin', 'agent') AND id IN (${group.map(() => '?').join(',')})`).all(...group.map((g) => g.id));
    const ok = group.filter((g) => roles.some((r) => r.id === g.id));
    if (ok.length) return ok;
  }
  return adminsWithEmail();
}

// What each kind of record is called in the email and the activity log, and how it is found and read.
const KINDS = {
  incident: {
    entity: 'incident', table: 'incidents',
    select: 'SELECT * FROM incidents',
    open: "status NOT IN ('resolved', 'closed', 'cancelled') AND sla_paused_at IS NULL",
    people: recipientsFor,
    subject: (r, what) => `[${r.number}] SLA ${what}: ${r.short_description}`,
    lines: (r) => [`Incident <strong>${escapeHtml(r.number)}</strong> (P${r.priority} ${escapeHtml(PRIORITY_NAMES[r.priority] || '')})`, `<strong>${escapeHtml(r.short_description)}</strong>`],
  },
  request: {
    entity: 'request', table: 'service_requests',
    select: 'SELECT r.*, ci.name AS item_name FROM service_requests r LEFT JOIN catalog_items ci ON ci.id = r.catalog_item_id',
    alias: 'r.',
    open: "status IN ('submitted', 'in_progress')",
    people: recipientsFor,
    subject: (r, what) => `[${r.number}] SLA ${what}: ${r.item_name || 'service request'}`,
    lines: (r) => [`Service request <strong>${escapeHtml(r.number)}</strong>`, `<strong>${escapeHtml(r.item_name || '')}</strong>`],
  },
  change: {
    entity: 'change', table: 'changes',
    select: 'SELECT * FROM changes',
    open: "status = 'submitted'",
    people: approversFor,
    subject: (r, what) => `[${r.number}] SLA ${what}, waiting for approval: ${r.short_description}`,
    lines: (r) => [`Change <strong>${escapeHtml(r.number)}</strong> is waiting for a decision`, `<strong>${escapeHtml(r.short_description)}</strong>`],
  },
};

async function notifyRecord(kind, row, what, remainingMinutes) {
  const def = KINDS[kind];
  const people = await def.people(row);
  const breached = what === 'breached';
  const clockText = row.sla_clock === 'business' ? 'business hours' : 'round the clock';
  const [lead, title] = def.lines(row);
  const left = breached ? '' : `<p>About ${escapeHtml(sla.formatMinutes(Math.max(1, Math.round(remainingMinutes))))} of ${escapeHtml(clockText)} remain.</p>`;
  await Promise.allSettled(people.map((p) => sendNotification({
    to: p.email,
    toName: p.full_name,
    subject: def.subject(row, what),
    html: `<p>Hi ${escapeHtml(p.full_name)},</p>
      <p>${lead} ${breached ? 'has missed its SLA' : 'is close to missing its SLA'}.</p>
      <p>${title}</p>
      <p>Due: ${escapeHtml(row.sla_due_at)} UTC (target ${escapeHtml(sla.formatMinutes(row.sla_target_minutes))}, ${escapeHtml(clockText)}).</p>${left}`,
    relatedType: def.entity,
    relatedId: row.id,
  })));
  await logActivity(def.entity, row.id, null,
    `SLA ${what}: ${people.length ? `emailed ${people.map((p) => p.full_name).join(', ')}` : 'nobody to email (no one with an email address to tell)'}`);
}

// The approval clock of a change is kept by watching its status, so none of the places that approve, reject
// or cancel a change (including the decommission flow) has to know about SLAs:
//   - a change that is Submitted and has no clock gets one, started at its last update (within a sweep of
//     when it was submitted), if the policy was already on at that time
//   - a change that is no longer Submitted has its clock stopped
//   - a change sent back to Submitted after a decision starts a fresh clock
async function maintainChangeClocks(now, cfg) {
  const stamp = sla.toStr(now);
  await db.prepare(`UPDATE changes SET sla_stopped_at = updated_at WHERE sla_started_at IS NOT NULL AND sla_stopped_at IS NULL AND status <> 'submitted'`).run();
  const policy = cfg.policyOf('change');
  if (!policy || !policy.enabled_at) return;
  const waiting = await db.prepare(`
    SELECT * FROM changes WHERE status = 'submitted' AND updated_at >= ? AND (sla_started_at IS NULL OR sla_stopped_at IS NOT NULL)
  `).all(policy.enabled_at);
  for (const ch of waiting) {
    const clock = sla.startIncidentClock(sla.toMs(ch.updated_at), policy, cfg.calendar);
    delete clock.sla_paused_at; delete clock.sla_paused_minutes;
    clock.sla_stopped_at = null;
    const keys = Object.keys(clock);
    for (const k of keys) if (!/^sla_[a-z_]+$/.test(k)) throw new Error(`unexpected SLA column ${k}`);
    await db.prepare(`UPDATE changes SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id AND (sla_started_at IS NULL OR sla_stopped_at IS NOT NULL)`)
      .run({ ...clock, id: ch.id });
  }
  return stamp;
}

let sweeping = false;
// Sends the "at risk" and "breached" emails that are due, for incidents, service requests and changes. Each
// record gets each email once: the claim (an UPDATE that only succeeds while the flag is empty) happens before
// the email, so two copies of NovaDesk, or two sweeps, cannot both send it. Resolves { warned, breached }.
async function sweep({ now = Date.now() } = {}) {
  if (sweeping) return { warned: 0, breached: 0 };
  sweeping = true;
  try {
    const cfg = await getConfig();
    await maintainChangeClocks(now, cfg).catch((err) => console.error('[SLA] could not update change clocks:', err.message));
    const stamp = sla.toStr(now);
    let warned = 0; let breached = 0;
    for (const [kind, def] of Object.entries(KINDS)) {
      const alias = def.alias || '';
      const open = await db.prepare(`
        ${def.select}
        WHERE ${def.open.replace(/\b(status|sla_paused_at)\b/g, `${alias}$1`)} AND ${alias}sla_target_minutes IS NOT NULL AND ${alias}sla_due_at IS NOT NULL
          AND (${alias}sla_warned_at IS NULL OR ${alias}sla_breach_notified_at IS NULL)
      `).all();
      for (const row of open) {
        const dueMs = sla.toMs(row.sla_due_at);
        const clock = row.sla_clock === 'business' ? 'business' : 'calendar';
        const remaining = sla.clockMinutesBetween(now, dueMs, clock, cfg.calendar);
        try {
          if (now > dueMs) {
            if (row.sla_breach_notified_at) continue;
            const claim = await db.prepare(`UPDATE ${def.table} SET sla_breach_notified_at = ?, sla_warned_at = COALESCE(sla_warned_at, ?) WHERE id = ? AND sla_breach_notified_at IS NULL`).run(stamp, stamp, row.id);
            if (claim.changes === 1) { await notifyRecord(kind, row, 'breached', remaining); breached++; }
          } else if (!row.sla_warned_at && remaining <= row.sla_target_minutes * (1 - (row.sla_warn_percent || 75) / 100)) {
            const claim = await db.prepare(`UPDATE ${def.table} SET sla_warned_at = ? WHERE id = ? AND sla_warned_at IS NULL`).run(stamp, row.id);
            if (claim.changes === 1) { await notifyRecord(kind, row, 'at risk', remaining); warned++; }
          }
        } catch (err) {
          console.error(`[SLA] could not process ${kind} ${row.number}:`, err.message);
        }
      }
    }
    return { warned, breached };
  } finally {
    sweeping = false;
  }
}

module.exports = { getConfig, invalidateConfig, newIncidentClock, newRequestClock, incidentClockChanges, setSql, logClockNotes, sweep, recipientsFor, approversFor };
