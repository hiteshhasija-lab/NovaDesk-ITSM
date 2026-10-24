// SLA settings (administrators): the business calendar, its holidays and the targets per priority.
// Changes apply to incidents created from then on and to incidents whose priority changes; the due time
// of an incident already in flight does not move because a policy was edited.
const { db, nowStr } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const createAsyncRouter = require('../asyncRouter');
const sla = require('../sla');
const slaService = require('../slaService');
const { audit } = require('../audit');

const router = createAsyncRouter();
router.use(requireAuth, requireRole('admin'));

const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
const PRIORITIES = [[1, 'P1 Critical'], [2, 'P2 High'], [3, 'P3 Moderate'], [4, 'P4 Low']];
const MAX_TARGET_MINUTES = 365 * 24 * 60;

const hhmm = (minute) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
function parseTime(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!m) return null;
  const minute = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[2]) < 60 && minute <= 1440 ? minute : null;
}
const flash = (req, type, text) => { req.session.slaMessage = { type, text }; };
const back = (req, res) => res.redirect('/settings/sla');

const OTHER_TARGETS = [
  ['request', 'Service requests', 'Time to fulfil a request, counted from when it is submitted. Rejected and cancelled requests are left out.'],
  ['change', 'Changes', 'Time to a decision (approved or rejected) while a change is Submitted and waiting for approval. Applies to changes submitted after you switch it on.'],
];

router.get('/', async (req, res) => {
  const cfg = await slaService.getConfig();
  const row = cfg.calendarRow;
  const policies = PRIORITIES.map(([priority, label]) => {
    const p = cfg.policyFor(priority);
    return { priority, label, hours: p.target_minutes / 60, clock: p.clock, warn: p.warn_percent };
  });
  const message = req.session.slaMessage || null;
  delete req.session.slaMessage;
  res.render('sla/settings', {
    title: 'SLA settings', message, DAYS, policies,
    calendar: { id: row.id, name: row.name, timezone: row.timezone, workDays: new Set(String(row.work_days).split(',').filter(Boolean).map(Number)), start: hhmm(row.start_minute), end: hhmm(row.end_minute) },
    holidays: cfg.holidays,
    otherTargets: OTHER_TARGETS.map(([kind, label, help]) => {
      const p = cfg.policyRow(kind) || { target_minutes: 4320, clock: 'calendar', warn_percent: 75, active: 0 };
      return { kind, label, help, enabled: Boolean(p.active), hours: p.target_minutes / 60, clock: p.clock, warn: p.warn_percent };
    }),
    timezones: typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'],
  });
});

router.post('/calendar', async (req, res) => {
  const b = req.body;
  const days = [].concat(b.work_days || []).map(Number);
  const start = parseTime(b.start);
  const end = parseTime(b.end);
  const timezone = String(b.timezone || '').trim();
  try {
    if (start === null || end === null) throw new Error('Enter the start and end of the working day as hours and minutes, for example 09:00 and 17:00.');
    sla.makeCalendar({ timezone, work_days: days.join(','), start_minute: start, end_minute: end });
  } catch (err) {
    flash(req, 'danger', err.message);
    return back(req, res);
  }
  const row = (await slaService.getConfig()).calendarRow;
  await db.prepare('UPDATE business_calendars SET timezone = ?, work_days = ?, start_minute = ?, end_minute = ? WHERE id = ?')
    .run(timezone, days.sort((a, c) => a - c).join(','), start, end, row.id);
  slaService.invalidateConfig();
  await audit(req, req.session.user, 'sla.settings_changed', { detail: `business hours: ${timezone}, days ${days.join(',')}, ${b.start} to ${b.end}` });
  flash(req, 'success', 'Business hours saved.');
  back(req, res);
});

router.post('/holidays', async (req, res) => {
  const date = String(req.body.holiday_date || '').trim();
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
  if (!valid) {
    flash(req, 'danger', 'Choose a date for the holiday.');
    return back(req, res);
  }
  const row = (await slaService.getConfig()).calendarRow;
  await db.prepare('INSERT INTO business_holidays (calendar_id, holiday_date, name) VALUES (?, ?, ?) ON CONFLICT (calendar_id, holiday_date) DO UPDATE SET name = EXCLUDED.name')
    .run(row.id, date, String(req.body.name || '').trim().slice(0, 100) || null);
  slaService.invalidateConfig();
  await audit(req, req.session.user, 'sla.settings_changed', { detail: `holiday added: ${date}` });
  flash(req, 'success', `${date} added as a holiday.`);
  back(req, res);
});

router.post('/holidays/:id/delete', async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isInteger(id) && id > 0) await db.prepare('DELETE FROM business_holidays WHERE id = ?').run(id);
  slaService.invalidateConfig();
  await audit(req, req.session.user, 'sla.settings_changed', { detail: `holiday removed (id ${id})` });
  flash(req, 'success', 'Holiday removed.');
  back(req, res);
});

router.post('/policies', async (req, res) => {
  const updates = [];
  for (const [priority, label] of PRIORITIES) {
    const hours = Number(req.body[`hours_${priority}`]);
    const minutes = Math.round(hours * 60);
    const clock = req.body[`clock_${priority}`];
    const warn = Number(req.body[`warn_${priority}`]);
    if (!Number.isFinite(hours) || minutes < 1 || minutes > MAX_TARGET_MINUTES) { flash(req, 'danger', `${label}: the target must be between one minute and a year (enter hours, for example 4 or 0.5).`); return back(req, res); }
    if (!['calendar', 'business'].includes(clock)) { flash(req, 'danger', `${label}: choose how the clock counts.`); return back(req, res); }
    if (!Number.isInteger(warn) || warn < 1 || warn > 99) { flash(req, 'danger', `${label}: the warning point must be a whole percentage from 1 to 99.`); return back(req, res); }
    updates.push([minutes, clock, warn, priority]);
  }
  for (const u of updates) {
    await db.prepare("UPDATE sla_policies SET target_minutes = ?, clock = ?, warn_percent = ? WHERE applies_to = 'incident' AND priority = ?").run(...u);
  }
  slaService.invalidateConfig();
  await audit(req, req.session.user, 'sla.settings_changed', { detail: `incident targets: ${updates.map((u) => `P${u[3]} ${u[0]} min ${u[1]} warn ${u[2]}%`).join('; ')}` });
  flash(req, 'success', 'SLA targets saved. They apply to incidents created from now on, and to incidents whose priority changes.');
  back(req, res);
});

// Service requests and changes: switched on or off, with a target, a clock and a warning point each.
router.post('/targets', async (req, res) => {
  const cfg = await slaService.getConfig();
  const updates = [];
  for (const [kind, label] of OTHER_TARGETS) {
    const hours = Number(req.body[`hours_${kind}`]);
    const minutes = Math.round(hours * 60);
    const clock = req.body[`clock_${kind}`];
    const warn = Number(req.body[`warn_${kind}`]);
    if (!Number.isFinite(hours) || minutes < 1 || minutes > MAX_TARGET_MINUTES) { flash(req, 'danger', `${label}: the target must be between one minute and a year (enter hours, for example 24 or 0.5).`); return back(req, res); }
    if (!['calendar', 'business'].includes(clock)) { flash(req, 'danger', `${label}: choose how the clock counts.`); return back(req, res); }
    if (!Number.isInteger(warn) || warn < 1 || warn > 99) { flash(req, 'danger', `${label}: the warning point must be a whole percentage from 1 to 99.`); return back(req, res); }
    updates.push({ kind, minutes, clock, warn, enabled: req.body[`enabled_${kind}`] === 'on' });
  }
  for (const u of updates) {
    const was = cfg.policyRow(u.kind);
    // Switching on stamps the moment: only requests created, and changes submitted, from then on get a clock.
    const enabledAt = u.enabled && !(was && was.active) ? nowStr() : (was ? was.enabled_at : null);
    await db.prepare("UPDATE sla_policies SET target_minutes = ?, clock = ?, warn_percent = ?, active = ?, enabled_at = ? WHERE applies_to = ? AND priority = 0")
      .run(u.minutes, u.clock, u.warn, u.enabled ? 1 : 0, enabledAt, u.kind);
  }
  slaService.invalidateConfig();
  await audit(req, req.session.user, 'sla.settings_changed', { detail: `request/change targets: ${updates.map((u) => `${u.kind} ${u.enabled ? 'on' : 'off'} ${u.minutes} min ${u.clock} warn ${u.warn}%`).join('; ')}` });
  flash(req, 'success', 'SLA targets for requests and changes saved. They apply from now on.');
  back(req, res);
});

module.exports = router;
