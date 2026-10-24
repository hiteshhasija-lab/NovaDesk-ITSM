// SLA settings from the database, the clock changes written back to incidents, and the sweep that emails
// warnings and breaches. The rules themselves are in sla.js.
'use strict';
const { db, logActivity } = require('./db');
const sla = require('./sla');
const { sendNotification } = require('./mailer');
const { escapeHtml } = require('./helpers');

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
async function recipientsFor(inc) {
  const wanted = (u) => u && u.email && u.email_notifications;
  if (inc.assigned_to) {
    const u = await db.prepare('SELECT id, full_name, email, email_notifications FROM users WHERE id = ? AND active = 1').get(inc.assigned_to);
    if (wanted(u)) return [u];
  }
  if (inc.assignment_group) {
    const members = await db.prepare(`
      SELECT u.id, u.full_name, u.email, u.email_notifications FROM user_assignment_groups g
      JOIN users u ON u.id = g.user_id WHERE g.group_name = ? AND u.active = 1 ORDER BY u.id
    `).all(inc.assignment_group);
    const list = members.filter(wanted);
    if (list.length) return list;
  }
  const admins = await db.prepare(`SELECT id, full_name, email, email_notifications FROM users WHERE role = 'admin' AND active = 1 ORDER BY id`).all();
  return admins.filter(wanted);
}

const PRIORITY_NAMES = { 1: 'Critical', 2: 'High', 3: 'Moderate', 4: 'Low' };

async function notifyIncident(inc, kind, remainingMinutes) {
  const people = await recipientsFor(inc);
  const breached = kind === 'breached';
  const subject = `[${inc.number}] SLA ${breached ? 'breached' : 'at risk'}: ${inc.short_description}`;
  const clockText = inc.sla_clock === 'business' ? 'business hours' : 'round the clock';
  const left = breached ? '' : `<p>About ${escapeHtml(sla.formatMinutes(Math.max(1, Math.round(remainingMinutes))))} of ${escapeHtml(clockText)} remain.</p>`;
  await Promise.allSettled(people.map((p) => sendNotification({
    to: p.email,
    toName: p.full_name,
    subject,
    html: `<p>Hi ${escapeHtml(p.full_name)},</p>
      <p>Incident <strong>${escapeHtml(inc.number)}</strong> (P${inc.priority} ${escapeHtml(PRIORITY_NAMES[inc.priority] || '')}) ${breached ? 'has missed its SLA' : 'is close to missing its SLA'}.</p>
      <p><strong>${escapeHtml(inc.short_description)}</strong></p>
      <p>Due: ${escapeHtml(inc.sla_due_at)} UTC (target ${escapeHtml(sla.formatMinutes(inc.sla_target_minutes))}, ${escapeHtml(clockText)}).</p>${left}`,
    relatedType: 'incident',
    relatedId: inc.id,
  })));
  await logActivity('incident', inc.id, null,
    `SLA ${breached ? 'breached' : 'at risk'}: ${people.length ? `emailed ${people.map((p) => p.full_name).join(', ')}` : 'nobody to email (no assignee, group member or administrator with an email address)'}`);
}

let sweeping = false;
// Sends the "at risk" and "breached" emails that are due. Each incident gets each email once: the claim
// (an UPDATE that only succeeds while the flag is empty) happens before the email, so two copies of
// NovaDesk, or two sweeps, cannot both send it. Resolves { warned, breached }.
async function sweep({ now = Date.now() } = {}) {
  if (sweeping) return { warned: 0, breached: 0 };
  sweeping = true;
  try {
    const cfg = await getConfig();
    const open = await db.prepare(`
      SELECT * FROM incidents
      WHERE status NOT IN ('resolved', 'closed', 'cancelled') AND sla_paused_at IS NULL
        AND sla_target_minutes IS NOT NULL AND sla_due_at IS NOT NULL
        AND (sla_warned_at IS NULL OR sla_breach_notified_at IS NULL)
    `).all();
    const stamp = sla.toStr(now);
    let warned = 0; let breached = 0;
    for (const inc of open) {
      const dueMs = sla.toMs(inc.sla_due_at);
      const clock = inc.sla_clock === 'business' ? 'business' : 'calendar';
      const remaining = sla.clockMinutesBetween(now, dueMs, clock, cfg.calendar);
      try {
        if (now > dueMs) {
          if (inc.sla_breach_notified_at) continue;
          const claim = await db.prepare('UPDATE incidents SET sla_breach_notified_at = ?, sla_warned_at = COALESCE(sla_warned_at, ?) WHERE id = ? AND sla_breach_notified_at IS NULL').run(stamp, stamp, inc.id);
          if (claim.changes === 1) { await notifyIncident(inc, 'breached', remaining); breached++; }
        } else if (!inc.sla_warned_at && remaining <= inc.sla_target_minutes * (1 - (inc.sla_warn_percent || 75) / 100)) {
          const claim = await db.prepare('UPDATE incidents SET sla_warned_at = ? WHERE id = ? AND sla_warned_at IS NULL').run(stamp, inc.id);
          if (claim.changes === 1) { await notifyIncident(inc, 'warning', remaining); warned++; }
        }
      } catch (err) {
        console.error(`[SLA] could not process incident ${inc.number}:`, err.message);
      }
    }
    return { warned, breached };
  } finally {
    sweeping = false;
  }
}

module.exports = { getConfig, invalidateConfig, newIncidentClock, incidentClockChanges, setSql, logClockNotes, sweep, recipientsFor };
