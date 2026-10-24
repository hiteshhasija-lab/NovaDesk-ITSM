-- 0004 single sign-on and two-step verification.
--
-- user_identities: which account an identity provider's user (issuer + subject) signs in to. Matched on the
--   provider's stable subject id from then on, so changing someone's email does not break or hijack the link.
-- user_mfa: one row per person who started two-step verification. The secret is stored encrypted; enabled = 0
--   while setup is unfinished. last_counter is the last 30-second step accepted, so a code cannot be reused.
-- user_recovery_codes: one-time codes for when the phone is lost, stored as hashes only.

CREATE TABLE user_identities (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  last_login_at TEXT,
  UNIQUE (issuer, subject)
);
CREATE INDEX user_identities_user ON user_identities (user_id);

CREATE TABLE user_mfa (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  last_counter BIGINT NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  enabled_at TEXT
);

CREATE TABLE user_recovery_codes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX user_recovery_codes_user ON user_recovery_codes (user_id);
