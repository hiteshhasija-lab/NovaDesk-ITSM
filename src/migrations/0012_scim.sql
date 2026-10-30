-- 0012 SCIM provisioning: an identity provider (Okta, Microsoft Entra ID, ...) creates, changes and switches off
-- people in NovaDesk through /scim/v2 (src/scim/), instead of an administrator doing it by hand.
--
-- users.scim_managed is 1 once SCIM has created or changed the account (the Users page says so); scim_external_id is the
-- provider's own id for the person (SCIM externalId); scim_updated_at is the last time SCIM changed it (SCIM's
-- meta.lastModified). scim_tokens are the bearer tokens a provider sends: only a SHA-256 hash is kept, the token itself is
-- shown once when it is made. scim_settings is one row of choices an administrator makes: whether SCIM may make someone an
-- administrator, whether it may change group membership, and the role a new person gets when the provider names none.
-- Everything starts switched off or at its safest: no token exists until an administrator makes one.

ALTER TABLE users ADD COLUMN scim_managed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN scim_external_id TEXT;
ALTER TABLE users ADD COLUMN scim_updated_at TEXT;
CREATE INDEX users_scim_external ON users (scim_external_id) WHERE scim_external_id IS NOT NULL;

CREATE TABLE scim_tokens (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE TABLE scim_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  allow_admin INTEGER NOT NULL DEFAULT 0,
  allow_groups INTEGER NOT NULL DEFAULT 0,
  default_role TEXT NOT NULL DEFAULT 'user' CHECK (default_role IN ('user', 'agent'))
);
INSERT INTO scim_settings (id) VALUES (1);
