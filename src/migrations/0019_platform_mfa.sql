-- 0019 Two-step verification for the platform console's operators: the same kind of secret and one-time recovery codes as the
-- tenants' people have, kept in tables of their own (like platform_admins they belong to no tenant: no tenant_id, no row level security).

CREATE TABLE platform_mfa (
  admin_id INTEGER PRIMARY KEY REFERENCES platform_admins(id) ON DELETE CASCADE,
  secret_enc TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  last_counter BIGINT NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  enabled_at TEXT
);

CREATE TABLE platform_recovery_codes (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX platform_recovery_codes_admin_idx ON platform_recovery_codes (admin_id);
