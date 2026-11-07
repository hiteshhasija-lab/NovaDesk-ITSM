-- 0018 Outgoing mail settings for each tenant, in the database, where until now there were only the server's SMTP_* settings.
--
-- One row per tenant. A tenant whose row is switched off (the default) uses the server's mail settings exactly as before. The SMTP
-- password is kept encrypted and is never shown again.

CREATE TABLE mail_settings (
  id SERIAL PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  host TEXT,
  port INTEGER CHECK (port IS NULL OR port BETWEEN 1 AND 65535),
  secure INTEGER NOT NULL DEFAULT 0,
  tls_verify INTEGER NOT NULL DEFAULT 1,
  username TEXT,
  password_enc TEXT,
  from_address TEXT,
  reply_to TEXT,
  updated_at TEXT,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
SELECT nd_tenant_scope('mail_settings');
ALTER TABLE mail_settings ADD CONSTRAINT mail_settings_one_per_tenant UNIQUE (tenant_id);
INSERT INTO mail_settings (tenant_id) VALUES (1);
GRANT SELECT, INSERT, UPDATE, DELETE ON mail_settings TO novadesk_app;
GRANT USAGE, SELECT ON SEQUENCE mail_settings_id_seq TO novadesk_app;
