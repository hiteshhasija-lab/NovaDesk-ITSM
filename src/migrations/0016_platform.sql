-- 0016 The platform console: the people who run the installation (not the people of any tenant) and a record of what they did.
--
-- Both tables are shared on purpose, like tenants: they belong to no tenant (no tenant_id, no row level security). Nothing a
-- tenant does reads or writes them. The console (src/routes/platform.js) exists only when PLATFORM_HOST is set.

CREATE TABLE platform_admins (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE CHECK (username = lower(username)),
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

-- tenant_id has no foreign key: an entry outlives a tenant that was removed.
CREATE TABLE platform_audit (
  id SERIAL PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  operator TEXT,
  action TEXT NOT NULL,
  tenant_id INTEGER,
  tenant_slug TEXT,
  detail TEXT,
  ip TEXT
);
CREATE INDEX platform_audit_tenant_idx ON platform_audit (tenant_id);
