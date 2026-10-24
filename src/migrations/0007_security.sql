-- 0007 security pass: account lockout and an audit log of security-relevant actions.
--
-- users.failed_logins / locked_until: consecutive wrong passwords, and when a temporary lock ends. Kept in the
--   database (not in memory), so a restart does not forget them and several copies of NovaDesk agree.
-- audit_log: who did what to what, and from which address: sign-ins and refusals, lockouts, password and two-step
--   changes, user and role changes, API keys, webhooks, SLA settings. Rows are only ever added.

ALTER TABLE users ADD COLUMN failed_logins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until TEXT;

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  actor_id INTEGER,                       -- no foreign key: the record outlives the person
  actor_name TEXT,
  action TEXT NOT NULL,                   -- login.success, user.updated, apikey.revoked, ...
  target_type TEXT,
  target_id INTEGER,
  target_name TEXT,
  detail TEXT,
  ip TEXT
);
CREATE INDEX audit_log_at ON audit_log (id DESC);
CREATE INDEX audit_log_action ON audit_log (action, id DESC);
