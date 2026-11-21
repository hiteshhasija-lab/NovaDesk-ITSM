-- 0025 Self-service sign-up of new tenants (src/signup.js, src/routes/signup.js), only where SIGNUP_HOST is set.
--
-- signups: one row for each request made on the sign-up page. It belongs to nobody yet (the tenant does not exist until the person has
-- confirmed their email address), so like the tenants table it is shared and only the platform side reads it. The link in the email holds a long
-- random token; only a hash of it is kept. The password the person chose is kept only as a bcrypt hash, only until the tenant is made, then removed.
--   status: pending (waiting for the link to be used), creating (being made right now), completed, refused (could not be made: the reason is in note), expired
-- platform_settings: switches of the platform that the people who run it change in the console without restarting (for now: sign-ups paused).

CREATE TABLE signups (
  id SERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL,
  org_name TEXT NOT NULL,
  admin_username TEXT NOT NULL,
  admin_name TEXT NOT NULL,
  admin_email TEXT NOT NULL,
  password_hash TEXT,
  ip TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'creating', 'completed', 'refused', 'expired')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL
);
CREATE INDEX signups_created ON signups (created_at);
CREATE INDEX signups_email ON signups (lower(admin_email), created_at);

CREATE TABLE platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  updated_by TEXT
);
