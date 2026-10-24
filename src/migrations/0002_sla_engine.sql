-- 0002 SLA engine: business-hour calendars, configurable SLA policies, and the clock columns on incidents.
--
-- Nothing changes for an existing install until an administrator edits the settings: the default policies
-- are the targets NovaDesk always used (P1 4 h, P2 8 h, P3 24 h, P4 72 h, round the clock, warning in the
-- last 25%). Incidents that already exist get their stored target worked out from the due time they have,
-- so their due times do not move.

CREATE TABLE business_calendars (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  work_days TEXT NOT NULL DEFAULT '1,2,3,4,5',      -- 0 = Sunday ... 6 = Saturday
  start_minute INTEGER NOT NULL DEFAULT 540,         -- minutes after midnight, local time: 540 = 09:00
  end_minute INTEGER NOT NULL DEFAULT 1020,          -- 1020 = 17:00
  is_default INTEGER NOT NULL DEFAULT 0
);
INSERT INTO business_calendars (name, is_default) VALUES ('Business hours', 1);

CREATE TABLE business_holidays (
  id SERIAL PRIMARY KEY,
  calendar_id INTEGER NOT NULL REFERENCES business_calendars(id) ON DELETE CASCADE,
  holiday_date TEXT NOT NULL,                        -- YYYY-MM-DD, a local date in the calendar's time zone
  name TEXT,
  UNIQUE (calendar_id, holiday_date)
);

CREATE TABLE sla_policies (
  id SERIAL PRIMARY KEY,
  applies_to TEXT NOT NULL,                          -- incident (request and change follow)
  priority INTEGER NOT NULL DEFAULT 0,               -- incident priority 1-4; 0 where priority does not apply
  target_minutes INTEGER NOT NULL CHECK (target_minutes > 0),
  clock TEXT NOT NULL DEFAULT 'calendar' CHECK (clock IN ('calendar', 'business')),
  warn_percent INTEGER NOT NULL DEFAULT 75 CHECK (warn_percent BETWEEN 1 AND 99),
  UNIQUE (applies_to, priority)
);
INSERT INTO sla_policies (applies_to, priority, target_minutes) VALUES
  ('incident', 1, 240), ('incident', 2, 480), ('incident', 3, 1440), ('incident', 4, 4320);

ALTER TABLE incidents ADD COLUMN sla_started_at TEXT;
ALTER TABLE incidents ADD COLUMN sla_target_minutes INTEGER;
ALTER TABLE incidents ADD COLUMN sla_clock TEXT;
ALTER TABLE incidents ADD COLUMN sla_warn_percent INTEGER;
ALTER TABLE incidents ADD COLUMN sla_paused_at TEXT;
ALTER TABLE incidents ADD COLUMN sla_paused_minutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE incidents ADD COLUMN sla_warned_at TEXT;
ALTER TABLE incidents ADD COLUMN sla_breach_notified_at TEXT;

-- Existing incidents: the target is whatever their due time already says (due - created), round the clock.
UPDATE incidents SET
  sla_started_at = created_at,
  sla_target_minutes = GREATEST(1, ROUND(EXTRACT(EPOCH FROM (sla_due_at::timestamp - created_at::timestamp)) / 60)::int),
  sla_clock = 'calendar',
  sla_warn_percent = 75
WHERE sla_due_at ~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$' AND created_at ~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$';

-- Incidents already On Hold are treated as paused since they were last touched.
UPDATE incidents SET sla_paused_at = updated_at
WHERE status = 'on_hold' AND sla_target_minutes IS NOT NULL AND updated_at ~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$';

-- Open incidents that are already past due, or already inside their warning window, count as notified, so
-- the first sweep after this release does not email about every old incident at once. (CASE keeps the
-- timestamp cast away from any row whose text is not a timestamp.)
UPDATE incidents SET sla_breach_notified_at = to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
WHERE status NOT IN ('resolved', 'closed', 'cancelled') AND sla_target_minutes IS NOT NULL
  AND CASE WHEN sla_due_at ~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$' THEN sla_due_at::timestamp < (NOW() AT TIME ZONE 'UTC') ELSE false END;
UPDATE incidents SET sla_warned_at = to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
WHERE status NOT IN ('resolved', 'closed', 'cancelled') AND sla_target_minutes IS NOT NULL
  AND CASE WHEN sla_due_at ~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$'
           THEN (sla_due_at::timestamp - (sla_target_minutes * 0.25) * interval '1 minute') < (NOW() AT TIME ZONE 'UTC')
           ELSE false END;
