-- 0003 SLA for service requests and changes.
--
-- A service request's target is the time to fulfil it. A change's target is the time to a decision while it
-- waits for approval (status Submitted). Both start switched off, so nothing changes until an administrator
-- enables them under SLA settings; only requests created and changes submitted after that get a clock.

ALTER TABLE sla_policies ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sla_policies ADD COLUMN enabled_at TEXT;      -- when the policy was last switched on
INSERT INTO sla_policies (applies_to, priority, target_minutes, clock, warn_percent, active) VALUES
  ('request', 0, 4320, 'calendar', 75, 0),                -- fulfil within 3 days
  ('change', 0, 2880, 'calendar', 75, 0);                 -- decide within 2 days

ALTER TABLE service_requests ADD COLUMN sla_started_at TEXT;
ALTER TABLE service_requests ADD COLUMN sla_target_minutes INTEGER;
ALTER TABLE service_requests ADD COLUMN sla_clock TEXT;
ALTER TABLE service_requests ADD COLUMN sla_warn_percent INTEGER;
ALTER TABLE service_requests ADD COLUMN sla_due_at TEXT;
ALTER TABLE service_requests ADD COLUMN sla_warned_at TEXT;
ALTER TABLE service_requests ADD COLUMN sla_breach_notified_at TEXT;

ALTER TABLE changes ADD COLUMN sla_started_at TEXT;
ALTER TABLE changes ADD COLUMN sla_target_minutes INTEGER;
ALTER TABLE changes ADD COLUMN sla_clock TEXT;
ALTER TABLE changes ADD COLUMN sla_warn_percent INTEGER;
ALTER TABLE changes ADD COLUMN sla_due_at TEXT;
ALTER TABLE changes ADD COLUMN sla_stopped_at TEXT;       -- when the decision was seen (the clock stops)
ALTER TABLE changes ADD COLUMN sla_warned_at TEXT;
ALTER TABLE changes ADD COLUMN sla_breach_notified_at TEXT;
