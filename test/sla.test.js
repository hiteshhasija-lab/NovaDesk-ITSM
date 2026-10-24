'use strict';
const test = require('node:test');
const assert = require('node:assert');
const sla = require('../src/sla');

const at = (s) => new Date(s.replace(' ', 'T') + 'Z').getTime();   // 'YYYY-MM-DD HH:MM' in UTC
const show = (ms) => sla.toStr(ms).slice(0, 16);
const office = sla.makeCalendar({ timezone: 'UTC', work_days: '1,2,3,4,5', start_minute: 540, end_minute: 1020 });   // Mon-Fri 09:00-17:00

// 2026-10-30 is a Friday, 2026-11-02 the Monday after.
test('working time skips nights and weekends', () => {
  assert.strictEqual(show(sla.addBusinessMs(at('2026-10-30 16:00'), 120 * 60000, office)), '2026-11-02 10:00');   // 1 h Friday + 1 h Monday
  assert.strictEqual(show(sla.addBusinessMs(at('2026-10-31 12:00'), 60 * 60000, office)), '2026-11-02 10:00');   // started on a Saturday
  assert.strictEqual(show(sla.addBusinessMs(at('2026-11-02 07:00'), 30 * 60000, office)), '2026-11-02 09:30');   // before opening
  assert.strictEqual(show(sla.addBusinessMs(at('2026-11-02 12:00'), 0, office)), '2026-11-02 12:00');
  assert.strictEqual(show(sla.addBusinessMs(at('2026-11-02 09:00'), 40 * 3600000, office)), '2026-11-06 17:00'); // a full week ends at closing time
});

test('a holiday is not a working day', () => {
  const withHoliday = sla.makeCalendar({ timezone: 'UTC' }, ['2026-11-02']);
  assert.strictEqual(show(sla.addBusinessMs(at('2026-10-30 16:00'), 120 * 60000, withHoliday)), '2026-11-03 10:00');
});

test('working time between two instants', () => {
  assert.strictEqual(sla.clockMinutesBetween(at('2026-10-30 15:00'), at('2026-11-02 10:00'), 'business', office), 180);
  assert.strictEqual(sla.clockMinutesBetween(at('2026-10-31 08:00'), at('2026-10-31 20:00'), 'business', office), 0);   // a Saturday
  assert.strictEqual(sla.clockMinutesBetween(at('2026-11-02 10:00'), at('2026-10-30 15:00'), 'business', office), -180);   // overdue is negative
  assert.strictEqual(sla.clockMinutesBetween(at('2026-10-30 15:00'), at('2026-11-02 10:00'), 'calendar', office), 67 * 60);   // the same span on a round-the-clock calendar
});

test('the same business day is read in the calendar\'s own time zone, across the daylight-saving change', () => {
  const chicago = sla.makeCalendar({ timezone: 'America/Chicago' });   // 09:00-17:00 local; clocks go back on Sunday 1 Nov 2026
  // Friday 16:00 CDT = 21:00Z. 600 minutes: 60 left on Friday, 480 on Monday (09:00 CST = 15:00Z), 60 on Tuesday.
  assert.strictEqual(show(sla.addBusinessMs(at('2026-10-30 21:00'), 600 * 60000, chicago)), '2026-11-03 16:00');
  // The Monday window is 15:00Z-23:00Z in winter but was 14:00Z-22:00Z the Friday before.
  assert.strictEqual(sla.clockMinutesBetween(at('2026-10-30 14:00'), at('2026-10-30 22:00'), 'business', chicago), 480);
  assert.strictEqual(sla.clockMinutesBetween(at('2026-11-02 15:00'), at('2026-11-02 23:00'), 'business', chicago), 480);
  assert.strictEqual(sla.clockMinutesBetween(at('2026-11-02 14:00'), at('2026-11-02 15:00'), 'business', chicago), 0);
});

test('a calendar clock is plain wall-clock time', () => {
  assert.strictEqual(show(sla.addClockMinutes(at('2026-10-30 16:00'), 240, 'calendar', office)), '2026-10-30 20:00');
  assert.strictEqual(sla.clockMinutesBetween(at('2026-10-30 16:00'), at('2026-10-31 16:00'), 'calendar', office), 1440);
});

test('a calendar must make sense', () => {
  assert.throws(() => sla.makeCalendar({ timezone: 'Mars/Olympus' }), /not a time zone/);
  assert.throws(() => sla.makeCalendar({ work_days: '' }), /at least one working day/);
  assert.throws(() => sla.makeCalendar({ work_days: '1,9' }), /at least one working day/);
  assert.throws(() => sla.makeCalendar({ start_minute: 600, end_minute: 600 }), /start before it ends/);
  assert.throws(() => sla.makeCalendar({ end_minute: 1500 }), /start before it ends/);
  // Every day a holiday: asking for working time fails instead of looping forever.
  const never = sla.makeCalendar({ timezone: 'UTC', work_days: '1' }, Array.from({ length: 800 }, (_, i) => new Date(Date.UTC(2026, 0, 5) + i * 7 * 86400000).toISOString().slice(0, 10)));
  assert.throws(() => sla.addBusinessMs(at('2026-10-30 10:00'), 60000, never), /no working time/);
});

// ---------------------------------------------------------------- incident clock
const policies = { 1: { target_minutes: 240, clock: 'calendar', warn_percent: 75 }, 3: { target_minutes: 1440, clock: 'calendar', warn_percent: 75 } };
const cfg = { calendar: office, policyFor: (p) => policies[p] };
const incident = (over = {}) => ({
  priority: 3, status: 'in_progress', created_at: '2026-10-23 10:00:00', sla_started_at: '2026-10-23 10:00:00',
  sla_target_minutes: 1440, sla_clock: 'calendar', sla_warn_percent: 75, sla_paused_at: null, sla_paused_minutes: 0,
  sla_due_at: '2026-10-24 10:00:00', sla_warned_at: null, sla_breach_notified_at: null, ...over,
});

test('a new incident gets its due time from the policy', () => {
  const c = sla.startIncidentClock(at('2026-10-23 10:00'), policies[1], office);
  assert.deepStrictEqual([c.sla_due_at, c.sla_target_minutes, c.sla_clock, c.sla_paused_minutes, c.sla_paused_at], ['2026-10-23 14:00:00', 240, 'calendar', 0, null]);
  const b = sla.startIncidentClock(at('2026-10-30 16:00'), { target_minutes: 120, clock: 'business', warn_percent: 75 }, office);
  assert.strictEqual(b.sla_due_at, '2026-11-02 10:00:00');
});

test('On Hold stops the clock, and leaving it adds the waiting time to the due time', () => {
  const held = sla.incidentTransition(incident(), { status: 'on_hold', priority: 3 }, at('2026-10-23 12:00'), cfg);
  assert.deepStrictEqual(held.changes, { sla_paused_at: '2026-10-23 12:00:00' });
  assert.deepStrictEqual(held.notes, ['SLA clock paused (On Hold)']);

  const resumed = sla.incidentTransition(incident({ sla_paused_at: '2026-10-23 12:00:00' }), { status: 'in_progress', priority: 3 }, at('2026-10-23 15:00'), cfg);
  assert.deepStrictEqual(resumed.changes, { sla_paused_at: null, sla_paused_minutes: 180, sla_due_at: '2026-10-24 13:00:00' });
  assert.match(resumed.notes[0], /SLA clock resumed; due 2026-10-24 13:00:00 UTC/);

  // Resolving straight from On Hold also counts the time already waited.
  const resolved = sla.incidentTransition(incident({ sla_paused_at: '2026-10-23 12:00:00' }), { status: 'resolved', priority: 3 }, at('2026-10-23 15:00'), cfg);
  assert.strictEqual(resolved.changes.sla_due_at, '2026-10-24 13:00:00');
  assert.strictEqual(resolved.changes.sla_paused_at, null);
});

test('moving between two other statuses touches nothing', () => {
  assert.deepStrictEqual(sla.incidentTransition(incident(), { status: 'resolved', priority: 3 }, at('2026-10-23 12:00'), cfg).changes, {});
});

test('a new priority takes the new target, measured from the start, and keeps time already waited', () => {
  const up = sla.incidentTransition(incident(), { status: 'in_progress', priority: 1 }, at('2026-10-23 11:00'), cfg);
  assert.deepStrictEqual(up.changes, { sla_target_minutes: 240, sla_due_at: '2026-10-23 14:00:00' });
  assert.deepStrictEqual(up.notes, ['SLA target is now 4 hours (P1)']);
  const afterWait = sla.incidentTransition(incident({ sla_paused_minutes: 60, sla_due_at: '2026-10-24 11:00:00' }), { status: 'in_progress', priority: 1 }, at('2026-10-23 11:00'), cfg);
  assert.strictEqual(afterWait.changes.sla_due_at, '2026-10-23 15:00:00');
});

test('a due time that moves into the future re-arms the breach email, and the warning only when plenty of time is left', () => {
  const notified = incident({ sla_paused_at: '2026-10-24 09:00:00', sla_due_at: '2026-10-24 10:00:00', sla_warned_at: '2026-10-24 08:00:00', sla_breach_notified_at: '2026-10-24 10:01:00' });
  // Held at 09:00 on the due day, resumed 24 hours later: due moves a day on, and an hour is left, so
  // the breach email may be sent again if it is missed, but the warning has already been given.
  const r = sla.incidentTransition(notified, { status: 'in_progress', priority: 3 }, at('2026-10-25 09:00'), cfg);
  assert.strictEqual(r.changes.sla_due_at, '2026-10-25 10:00:00');
  assert.strictEqual(r.changes.sla_breach_notified_at, null);
  assert.strictEqual(r.changes.sla_warned_at, undefined);

  // A P1 (4 h) that was warned and then lowered to P3 (24 h) has most of its time back: both re-arm.
  const p1 = incident({ priority: 1, sla_target_minutes: 240, sla_due_at: '2026-10-23 14:00:00', sla_warned_at: '2026-10-23 13:00:00', sla_breach_notified_at: '2026-10-23 14:01:00' });
  const lowered = sla.incidentTransition(p1, { status: 'in_progress', priority: 3 }, at('2026-10-23 14:30'), cfg);
  assert.strictEqual(lowered.changes.sla_due_at, '2026-10-24 10:00:00');
  assert.strictEqual(lowered.changes.sla_warned_at, null);
  assert.strictEqual(lowered.changes.sla_breach_notified_at, null);
});

test('on a business clock the waiting time counts only in working hours', () => {
  const inc = incident({ priority: 3, created_at: '2026-10-30 16:00:00', sla_started_at: '2026-10-30 16:00:00', sla_target_minutes: 120, sla_clock: 'business', sla_due_at: '2026-11-02 10:00:00' });
  const held = sla.incidentTransition(inc, { status: 'on_hold', priority: 3 }, at('2026-10-30 16:30'), cfg);
  const resumed = sla.incidentTransition({ ...inc, ...held.changes }, { status: 'in_progress', priority: 3 }, at('2026-11-02 09:30'), cfg);
  // 30 working minutes on Friday + 30 on Monday were waited: due moves from Mon 10:00 to Mon 11:00.
  assert.strictEqual(resumed.changes.sla_paused_minutes, 60);
  assert.strictEqual(resumed.changes.sla_due_at, '2026-11-02 11:00:00');
});

test('an incident that has no stored target is left alone', () => {
  const legacy = incident({ sla_target_minutes: null, sla_clock: null });
  assert.deepStrictEqual(sla.incidentTransition(legacy, { status: 'on_hold', priority: 1 }, at('2026-10-23 12:00'), cfg), { changes: {}, notes: [] });
});

test('what people see: on track, at risk, breached, paused, met', () => {
  const state = (over, now) => sla.incidentSlaState(incident(over), at(now), office).key;
  assert.strictEqual(state({}, '2026-10-23 12:00'), 'on_track');
  assert.strictEqual(state({}, '2026-10-24 03:59'), 'on_track');        // 25% of 24 h = 6 h left
  assert.strictEqual(state({}, '2026-10-24 04:01'), 'at_risk');
  assert.strictEqual(state({}, '2026-10-24 10:01'), 'breached');
  assert.strictEqual(state({ sla_paused_at: '2026-10-24 09:00:00' }, '2026-10-30 10:00'), 'paused');
  assert.strictEqual(state({ resolved_at: '2026-10-24 09:59:00', status: 'resolved' }, '2026-10-30 10:00'), 'met');
  assert.strictEqual(state({ resolved_at: '2026-10-24 10:01:00', status: 'resolved' }, '2026-10-30 10:00'), 'breached');
  assert.strictEqual(state({ status: 'cancelled' }, '2026-10-30 10:00'), 'closed');
  assert.strictEqual(state({ sla_due_at: null }, '2026-10-30 10:00'), 'none');
});

test('a custom warning percentage moves the at-risk point', () => {
  const state = (warn, now) => sla.incidentSlaState(incident({ sla_warn_percent: warn }), at(now), office).key;
  assert.strictEqual(state(50, '2026-10-23 21:59'), 'on_track');    // 50% of 24 h used at 22:00
  assert.strictEqual(state(50, '2026-10-23 22:01'), 'at_risk');
});

test('an incident from before SLA policies falls back to the old targets', () => {
  const legacy = { priority: 1, status: 'new', sla_due_at: '2026-10-23 14:00:00', sla_target_minutes: null };
  assert.strictEqual(sla.incidentSlaState(legacy, at('2026-10-23 12:00'), office).key, 'on_track');
  assert.strictEqual(sla.incidentSlaState(legacy, at('2026-10-23 13:30'), office).key, 'at_risk');   // last 25% of 4 h
});

test('minutes read as people write them', () => {
  assert.deepStrictEqual([240, 60, 1440, 2880, 90, 45, 1, 4320].map(sla.formatMinutes), ['4 hours', '1 hour', '1 day', '2 days', '1 h 30 min', '45 minutes', '1 minute', '3 days']);
});

// ---------------------------------------------------------------- service requests and changes
test('a service request: open until fulfilled, met when fulfilled before the due time', () => {
  const req = (over) => ({ sla_due_at: '2026-10-26 10:00:00', sla_target_minutes: 4320, sla_clock: 'calendar', sla_warn_percent: 75, status: 'submitted', fulfilled_at: null, ...over });
  const state = (over, now) => sla.requestSlaState(req(over), at(now), office).key;
  assert.strictEqual(state({}, '2026-10-23 10:00'), 'on_track');
  assert.strictEqual(state({}, '2026-10-26 01:00'), 'at_risk');                                  // last 25% of 3 days
  assert.strictEqual(state({}, '2026-10-26 10:01'), 'breached');
  assert.strictEqual(state({ status: 'fulfilled', fulfilled_at: '2026-10-26 09:59:00' }, '2026-10-30 10:00'), 'met');
  assert.strictEqual(state({ status: 'fulfilled', fulfilled_at: '2026-10-26 10:01:00' }, '2026-10-30 10:00'), 'breached');
  assert.strictEqual(state({ status: 'rejected' }, '2026-10-30 10:00'), 'closed');
  assert.strictEqual(state({ status: 'cancelled' }, '2026-10-30 10:00'), 'closed');
  assert.strictEqual(state({ sla_due_at: null }, '2026-10-30 10:00'), 'none');                  // the SLA was off when it was made
});

test('a change: the clock runs while it is Submitted and stops at the decision', () => {
  const ch = (over) => ({ sla_due_at: '2026-10-26 10:00:00', sla_target_minutes: 2880, sla_clock: 'calendar', sla_warn_percent: 75, status: 'submitted', sla_stopped_at: null, updated_at: '2026-10-24 10:00:00', ...over });
  const state = (over, now) => sla.changeSlaState(ch(over), at(now), office).key;
  assert.strictEqual(state({}, '2026-10-24 12:00'), 'on_track');
  assert.strictEqual(state({}, '2026-10-26 01:00'), 'at_risk');   // last 25% of 2 days
  assert.strictEqual(state({}, '2026-10-27 00:00'), 'breached');
  assert.strictEqual(state({ status: 'approved', sla_stopped_at: '2026-10-25 09:00:00' }, '2026-10-30 10:00'), 'met');
  assert.strictEqual(state({ status: 'rejected', sla_stopped_at: '2026-10-26 12:00:00' }, '2026-10-30 10:00'), 'breached');
  assert.strictEqual(state({ status: 'approved', sla_stopped_at: null, updated_at: '2026-10-25 09:00:00' }, '2026-10-30 10:00'), 'met');   // decision not yet stamped: last update stands in
  assert.strictEqual(state({ sla_due_at: null }, '2026-10-30 10:00'), 'none');
});

test('a business clock for a request counts working hours only: 8 working hours from Friday 16:00', () => {
  const c = sla.startIncidentClock(at('2026-10-30 16:00'), { target_minutes: 8 * 60, clock: 'business', warn_percent: 75 }, office);
  // 1 h left on Friday, then Monday 09:00-16:00 (7 h): due Monday 16:00.
  assert.strictEqual(c.sla_due_at, '2026-11-02 16:00:00');
});
