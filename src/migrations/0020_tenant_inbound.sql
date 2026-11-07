-- 0020 Inbound email for each tenant: its own mailbox to read (IMAP) and its own address for a mail system to hand messages to over HTTP,
-- in the database, where until now there were only the server's INBOUND_* settings (which serve the default tenant).
--
-- One row per tenant. The mailbox password is kept encrypted and never shown again. The HTTP address is protected by a token of the
-- tenant's own: only a SHA-256 hash is kept (the token is shown once), and the hash is unique across tenants because it is how a
-- message handed over by HTTP finds its tenant.

CREATE TABLE inbound_settings (
  id SERIAL PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  imap_host TEXT,
  imap_port INTEGER CHECK (imap_port IS NULL OR imap_port BETWEEN 1 AND 65535),
  imap_secure INTEGER NOT NULL DEFAULT 1,
  imap_tls_verify INTEGER NOT NULL DEFAULT 1,
  imap_user TEXT,
  imap_password_enc TEXT,
  folder TEXT,
  processed_folder TEXT,
  poll_seconds INTEGER NOT NULL DEFAULT 60 CHECK (poll_seconds BETWEEN 10 AND 3600),
  address TEXT,
  unknown_senders TEXT NOT NULL DEFAULT 'create' CHECK (unknown_senders IN ('create', 'ignore')),
  allowed_domains TEXT,
  blocked_senders TEXT,
  max_per_sender_hour INTEGER NOT NULL DEFAULT 10 CHECK (max_per_sender_hour BETWEEN 0 AND 10000),
  require_auth INTEGER NOT NULL DEFAULT 0,
  assignment_group TEXT,
  intake_token_hash TEXT,
  intake_token_prefix TEXT,
  updated_at TEXT,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
SELECT nd_tenant_scope('inbound_settings');
ALTER TABLE inbound_settings ADD CONSTRAINT inbound_settings_one_per_tenant UNIQUE (tenant_id);
CREATE UNIQUE INDEX inbound_settings_token_hash ON inbound_settings (intake_token_hash) WHERE intake_token_hash IS NOT NULL;
INSERT INTO inbound_settings (tenant_id) VALUES (1);
GRANT SELECT, INSERT, UPDATE, DELETE ON inbound_settings TO novadesk_app;
GRANT USAGE, SELECT ON SEQUENCE inbound_settings_id_seq TO novadesk_app;
