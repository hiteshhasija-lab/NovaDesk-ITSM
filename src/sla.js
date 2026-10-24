// SLA clocks: the time arithmetic and the rules for when a clock starts, pauses, moves and stops.
// Pure functions with no database, so every rule can be tested with a fixed "now" (slaService.js
// loads the settings and stores the results).
//
// A clock is either
//   'calendar'  wall-clock time, round the clock (what NovaDesk has always done), or
//   'business'  only the working hours of a business calendar count: working days, a daily start and
//               end in a time zone, and holidays.
// Times are milliseconds since the epoch here; the database keeps them as 'YYYY-MM-DD HH:MM:SS' UTC text.
'use strict';

const MIN = 60000;
const DAY = 86400000;
const MAX_DAYS_SCANNED = 3660;   // ten years: a calendar that never has working time throws instead of looping

// ---------------------------------------------------------------- time zones
const formatters = new Map();
function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(tz, f);
  }
  return f;
}
function parts(ms, tz) {
  const o = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  if (o.hour === 24) o.hour = 0;
  return o;
}
// The zone's offset from UTC at that instant, in ms (Chicago in winter: -6 h).
function offsetMs(ms, tz) {
  const p = parts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
// The instant at which a clock in `tz` reads that date and minute-of-day (daylight-saving safe).
function zonedToUtc(y, m, d, minuteOfDay, tz) {
  const guess = Date.UTC(y, m - 1, d, 0, minuteOfDay);
  const first = guess - offsetMs(guess, tz);
  return guess - offsetMs(first, tz);
}
const pad = (n) => String(n).padStart(2, '0');
const dateKey = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
function nextDate({ y, m, d }) {
  const t = new Date(Date.UTC(y, m - 1, d) + DAY);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
const weekdayOf = ({ y, m, d }) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();   // 0 = Sunday

// ---------------------------------------------------------------- calendar
function isValidTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return typeof tz === 'string' && tz.length > 0; } catch { return false; }
}

// row: { timezone, work_days: '1,2,3,4,5' (0 = Sunday), start_minute, end_minute } and holidays: ['YYYY-MM-DD', ...]
function makeCalendar(row, holidays = []) {
  const timezone = row.timezone || 'UTC';
  if (!isValidTimeZone(timezone)) throw new Error(`"${timezone}" is not a time zone (for example Europe/London or America/Chicago).`);
  const workDays = new Set(String(row.work_days === undefined ? '1,2,3,4,5' : row.work_days).split(',').filter((s) => s !== '').map(Number));
  if (!workDays.size || [...workDays].some((n) => !Number.isInteger(n) || n < 0 || n > 6)) throw new Error('Choose at least one working day.');
  const startMinute = Number(row.start_minute === undefined ? 540 : row.start_minute);
  const endMinute = Number(row.end_minute === undefined ? 1020 : row.end_minute);
  if (!Number.isInteger(startMinute) || !Number.isInteger(endMinute) || startMinute < 0 || endMinute > 1440 || endMinute <= startMinute) {
    throw new Error('The working day must start before it ends.');
  }
  return { timezone, workDays, startMinute, endMinute, holidays: new Set(holidays) };
}

function isWorkingDate(cal, date) {
  return cal.workDays.has(weekdayOf(date)) && !cal.holidays.has(dateKey(date.y, date.m, date.d));
}
function windowOf(cal, date) {
  return [zonedToUtc(date.y, date.m, date.d, cal.startMinute, cal.timezone), zonedToUtc(date.y, date.m, date.d, cal.endMinute, cal.timezone)];
}
const dateAt = (ms, tz) => { const p = parts(ms, tz); return { y: p.year, m: p.month, d: p.day }; };

// ---------------------------------------------------------------- clock arithmetic
// Working time between two instants, in ms (0 when `to` is not after `from`).
function businessMsBetween(fromMs, toMs, cal) {
  if (toMs <= fromMs) return 0;
  let total = 0;
  let date = dateAt(fromMs, cal.timezone);
  const last = dateAt(toMs, cal.timezone);
  for (let i = 0; i < MAX_DAYS_SCANNED; i++) {
    if (isWorkingDate(cal, date)) {
      const [ws, we] = windowOf(cal, date);
      const a = Math.max(ws, fromMs);
      const b = Math.min(we, toMs);
      if (b > a) total += b - a;
    }
    if (date.y === last.y && date.m === last.m && date.d === last.d) break;
    date = nextDate(date);
  }
  return total;
}

// The instant after `minutes` of working time have passed since `fromMs`. Time outside working hours
// does not count: starting Friday 16:00 with a 17:00 close, 120 minutes end Monday 10:00.
function addBusinessMs(fromMs, ms, cal) {
  if (ms <= 0) return fromMs;
  let remaining = ms;
  let date = dateAt(fromMs, cal.timezone);
  for (let i = 0; i < MAX_DAYS_SCANNED; i++) {
    if (isWorkingDate(cal, date)) {
      const [ws, we] = windowOf(cal, date);
      const start = Math.max(ws, fromMs);
      if (start < we) {
        const available = we - start;
        if (remaining <= available) return start + remaining;
        remaining -= available;
      }
    }
    date = nextDate(date);
  }
  throw new Error('The business calendar has no working time within ten years.');
}

function addClockMinutes(fromMs, minutes, clock, cal) {
  return clock === 'business' ? addBusinessMs(fromMs, minutes * MIN, cal) : fromMs + minutes * MIN;
}
// Signed: negative when `toMs` is before `fromMs` (an overdue clock).
function clockMinutesBetween(fromMs, toMs, clock, cal) {
  if (toMs < fromMs) return -clockMinutesBetween(toMs, fromMs, clock, cal);
  return (clock === 'business' ? businessMsBetween(fromMs, toMs, cal) : toMs - fromMs) / MIN;
}

// ---------------------------------------------------------------- stored form
const toMs = (str) => (str ? new Date(String(str).replace(' ', 'T') + 'Z').getTime() : null);
const toStr = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

// ---------------------------------------------------------------- incident rules
// Hours NovaDesk used before SLA policies were configurable; still the fallback for an incident that
// has no stored target.
const LEGACY_SLA_HOURS = { 1: 4, 2: 8, 3: 24, 4: 72 };

// What a new incident's clock looks like. policy: { target_minutes, clock, warn_percent }.
function startIncidentClock(startMs, policy, cal) {
  return {
    sla_started_at: toStr(startMs),
    sla_target_minutes: policy.target_minutes,
    sla_clock: policy.clock,
    sla_warn_percent: policy.warn_percent,
    sla_paused_at: null,
    sla_paused_minutes: 0,
    sla_due_at: toStr(addClockMinutes(startMs, policy.target_minutes, policy.clock, cal)),
    sla_warned_at: null,
    sla_breach_notified_at: null,
  };
}

// What changes on the clock when an incident moves to `status` and `priority` at `nowMs`.
//   - entering On Hold stops the clock; leaving it (or resolving, closing, cancelling) restarts it and
//     the time spent waiting is added to the due time, counted the way the clock counts (business
//     minutes on a business clock)
//   - a new priority takes the new policy's target, measured from when the incident started
// existing: the incident row. Returns { changes, notes }: columns to write (only those that differ) and
// short sentences for the activity log. Incidents without a stored target are left alone.
function incidentTransition(existing, { status, priority }, nowMs, cfg) {
  const changes = {};
  const notes = [];
  if (!existing.sla_target_minutes || !existing.sla_due_at) return { changes, notes };

  let { sla_target_minutes: target, sla_clock: clock, sla_warn_percent: warn } = existing;
  let pausedAt = existing.sla_paused_at || null;
  let pausedMinutes = existing.sla_paused_minutes || 0;
  const cal = cfg.calendar;

  if (pausedAt && status !== 'on_hold') {
    const since = toMs(pausedAt);
    pausedMinutes += Math.round(clockMinutesBetween(since, nowMs, clock, cal));
    pausedAt = null;
    notes.push('SLA clock resumed');
  } else if (!pausedAt && status === 'on_hold') {
    pausedAt = toStr(nowMs);
    notes.push('SLA clock paused (On Hold)');
  }

  if (priority !== undefined && priority !== existing.priority) {
    const policy = cfg.policyFor(priority);
    if (policy) {
      target = policy.target_minutes; clock = policy.clock; warn = policy.warn_percent;
      notes.push(`SLA target is now ${formatMinutes(target)} (P${priority})`);
    }
  }

  const startMs = toMs(existing.sla_started_at || existing.created_at);
  const dueMs = addClockMinutes(startMs, target + pausedMinutes, clock, cal);
  const due = toStr(dueMs);

  if (pausedAt !== (existing.sla_paused_at || null)) changes.sla_paused_at = pausedAt;
  if (pausedMinutes !== (existing.sla_paused_minutes || 0)) changes.sla_paused_minutes = pausedMinutes;
  if (target !== existing.sla_target_minutes) changes.sla_target_minutes = target;
  if (clock !== existing.sla_clock) changes.sla_clock = clock;
  if (warn !== existing.sla_warn_percent) changes.sla_warn_percent = warn;
  if (due !== existing.sla_due_at) {
    changes.sla_due_at = due;
    if (notes.some((n) => n === 'SLA clock resumed')) notes[notes.indexOf('SLA clock resumed')] = `SLA clock resumed; due ${due} UTC`;
    // A due time that moved into the future re-arms the warning and breach emails for it.
    if (dueMs > nowMs && existing.sla_breach_notified_at) changes.sla_breach_notified_at = null;
    const remaining = clockMinutesBetween(nowMs, dueMs, clock, cal);
    if (existing.sla_warned_at && remaining > target * (1 - (warn || 75) / 100)) changes.sla_warned_at = null;
  }
  return { changes, notes };
}

function formatMinutes(min) {
  if (min % 1440 === 0) return `${min / 1440} day${min === 1440 ? '' : 's'}`;
  if (min % 60 === 0) return `${min / 60} hour${min === 60 ? '' : 's'}`;
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'}`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

// The calendar the pages use to read business-clock incidents. slaService.js sets it when the settings load;
// until then (and in tests) it is Monday to Friday 09:00-17:00 UTC.
let activeCalendar = null;
const setActiveCalendar = (cal) => { activeCalendar = cal; };
const getActiveCalendar = () => activeCalendar || (activeCalendar = makeCalendar({}, []));

// ---------------------------------------------------------------- state shown to people
// { key, label, badge, remainingMinutes } for one incident. key: none, paused, met, breached, closed,
// at_risk, on_track. `nowMs` and `cal` default to now and a 24 x 7 calendar.
function incidentSlaState(inc, nowMs = Date.now(), cal = null) {
  if (!inc.sla_due_at) return { key: 'none', label: '—', badge: 'secondary', remainingMinutes: null };
  const dueMs = toMs(inc.sla_due_at);

  if (inc.resolved_at) {
    return toMs(inc.resolved_at) > dueMs
      ? { key: 'breached', label: 'Breached', badge: 'danger', remainingMinutes: null }
      : { key: 'met', label: 'Met SLA', badge: 'success', remainingMinutes: null };
  }
  if (['closed', 'cancelled'].includes(inc.status)) return { key: 'closed', label: '—', badge: 'secondary', remainingMinutes: null };
  if (inc.sla_paused_at) return { key: 'paused', label: 'Paused', badge: 'info', remainingMinutes: null };

  const clock = inc.sla_clock === 'business' && cal ? 'business' : 'calendar';
  const remaining = clockMinutesBetween(nowMs, dueMs, clock, cal);
  if (nowMs > dueMs) return { key: 'breached', label: 'Breached', badge: 'danger', remainingMinutes: remaining };

  const target = inc.sla_target_minutes || (LEGACY_SLA_HOURS[inc.priority] || LEGACY_SLA_HOURS[4]) * 60;
  const warn = inc.sla_warn_percent || 75;
  if (remaining <= target * (1 - warn / 100)) return { key: 'at_risk', label: 'At Risk', badge: 'warning', remainingMinutes: remaining };
  return { key: 'on_track', label: 'On Track', badge: 'success', remainingMinutes: remaining };
}

// ---------------------------------------------------------------- service requests and changes
// Same shape as an incident's state, for things that have a start, a due time and a single end.
//   doneAt   when it was finished (null while open)
//   isOpen   still running: a request being fulfilled, a change waiting for approval
function genericSlaState(rec, { doneAt, isOpen }, nowMs = Date.now(), cal = null) {
  if (!rec.sla_due_at) return { key: 'none', label: '—', badge: 'secondary', remainingMinutes: null };
  const dueMs = toMs(rec.sla_due_at);
  if (doneAt) {
    return toMs(doneAt) > dueMs
      ? { key: 'breached', label: 'Breached', badge: 'danger', remainingMinutes: null }
      : { key: 'met', label: 'Met SLA', badge: 'success', remainingMinutes: null };
  }
  if (!isOpen) return { key: 'closed', label: '—', badge: 'secondary', remainingMinutes: null };
  const clock = rec.sla_clock === 'business' && cal ? 'business' : 'calendar';
  const remaining = clockMinutesBetween(nowMs, dueMs, clock, cal);
  if (nowMs > dueMs) return { key: 'breached', label: 'Breached', badge: 'danger', remainingMinutes: remaining };
  const target = rec.sla_target_minutes || 1;
  const warn = rec.sla_warn_percent || 75;
  if (remaining <= target * (1 - warn / 100)) return { key: 'at_risk', label: 'At Risk', badge: 'warning', remainingMinutes: remaining };
  return { key: 'on_track', label: 'On Track', badge: 'success', remainingMinutes: remaining };
}

// A request is open until it is fulfilled, rejected or cancelled; fulfilling it on time meets the SLA.
function requestSlaState(request, nowMs = Date.now(), cal = null) {
  return genericSlaState(request, {
    doneAt: request.status === 'fulfilled' ? request.fulfilled_at : null,
    isOpen: ['submitted', 'in_progress'].includes(request.status),
  }, nowMs, cal);
}

// A change's clock runs while it waits for approval. The decision time is stamped when the sweep sees it
// (until then the last update is the best answer).
function changeSlaState(change, nowMs = Date.now(), cal = null) {
  const waiting = change.status === 'submitted';
  return genericSlaState(change, { doneAt: waiting ? null : (change.sla_stopped_at || change.updated_at), isOpen: waiting }, nowMs, cal);
}

module.exports = {
  genericSlaState, requestSlaState, changeSlaState,
  MIN, LEGACY_SLA_HOURS,
  isValidTimeZone, makeCalendar, zonedToUtc,
  businessMsBetween, addBusinessMs, addClockMinutes, clockMinutesBetween,
  toMs, toStr, formatMinutes,
  startIncidentClock, incidentTransition, incidentSlaState,
  setActiveCalendar, getActiveCalendar,
};
