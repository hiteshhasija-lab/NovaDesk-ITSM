-- 0017 Single sign-on settings for each tenant, in the database, where until now there were only the server's OIDC_* settings.
--
-- One row per tenant. The client secret is kept encrypted (like the two-step verification secrets) and is never shown again after it is
-- saved. A tenant whose row is switched off has no single sign-on, except that the default tenant keeps using the server's OIDC_*
-- settings when it has no setting of its own, so an installation that set those carries on exactly as before.

CREATE TABLE sso_settings (
  id SERIAL PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  issuer TEXT,
  client_id TEXT,
  client_secret_enc TEXT,
  button_label TEXT,
  scopes TEXT,
  auto_create INTEGER NOT NULL DEFAULT 0,
  default_role TEXT NOT NULL DEFAULT 'user' CHECK (default_role IN ('user', 'agent')),
  trust_email INTEGER NOT NULL DEFAULT 0,
  allowed_domains TEXT,
  updated_at TEXT,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
SELECT nd_tenant_scope('sso_settings');
ALTER TABLE sso_settings ADD CONSTRAINT sso_settings_one_per_tenant UNIQUE (tenant_id);
INSERT INTO sso_settings (tenant_id) VALUES (1);
GRANT SELECT, INSERT, UPDATE, DELETE ON sso_settings TO novadesk_app;
GRANT USAGE, SELECT ON SEQUENCE sso_settings_id_seq TO novadesk_app;
