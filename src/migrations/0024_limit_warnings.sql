-- 0024 Warnings before a tenant reaches a usage limit (src/limitWarnings.js).
--
-- One row for each limit (people, records, files) that a tenant has come close to: the highest warning level (80, 90 or 100 per cent)
-- that has been told to the workspace's administrators by email, when, and the percentage then. It is what stops the same warning being sent
-- every time the job runs: a warning goes out when a higher level is reached, and the row goes back down only when use has fallen clearly below
-- the level (5 points), so use hovering around a line does not send mail again and again. The row is the tenant's own (row level security
-- as for every table that holds an organisation's data).

CREATE TABLE limit_warnings (
  kind TEXT NOT NULL CHECK (kind IN ('users', 'records', 'storage')),
  level INTEGER NOT NULL DEFAULT 0 CHECK (level IN (0, 80, 90, 100)),
  percent INTEGER,
  sent_at TEXT
);
SELECT nd_tenant_scope('limit_warnings');
ALTER TABLE limit_warnings ADD CONSTRAINT limit_warnings_one_per_kind UNIQUE (tenant_id, kind);
