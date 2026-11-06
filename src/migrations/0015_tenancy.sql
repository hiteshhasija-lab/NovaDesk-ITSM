-- 0015 Multi-tenancy: several organisations (tenants) share one installation and one database, and cannot see each other.
--
-- How it works (src/tenancy.js, src/tenants.js, src/db.js):
--   * every table that holds an organisation's data gets a tenant_id; the application reaches the database as the restricted
--     role novadesk_app (SET ROLE on every connection), which is subject to row level security: a policy on each table lets a
--     statement see and write only the rows of the tenant named by the setting app.tenant_id, which the database layer sets for
--     every statement from the tenant of the request. A query that forgets to filter still cannot see another tenant's rows,
--     and an INSERT that names another tenant's id is refused.
--   * app.platform = 'on' lifts that, for the few things that must look across tenants (finding which tenant an API key or a
--     host name belongs to, the background sweeps, session clean-up). Only src/tenancy.js sets it.
--   * tenant_id has no fixed default: an INSERT takes the tenant of the statement's own setting, so without one it fails
--     loudly instead of landing in the wrong tenant.
--   * names that were unique across the whole installation are now unique within a tenant (usernames, ticket numbers, ...).
--
-- Everything that exists today becomes tenant 1, "default": nothing changes for a single organisation.
-- Future migrations that add a table for an organisation's data call nd_tenant_scope('the_table') (defined here).

CREATE TABLE tenants (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9]){0,1}$'),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
INSERT INTO tenants (id, slug, name) VALUES (1, 'default', 'Default');
SELECT setval(pg_get_serial_sequence('tenants', 'id'), 1);

-- The host names (the address in the browser) that belong to a tenant. A host that is not listed here is the default tenant's
-- or refused, as TENANT_UNKNOWN_HOST says; <slug>.TENANT_BASE_DOMAIN needs no row.
CREATE TABLE tenant_hosts (
  host TEXT PRIMARY KEY CHECK (host = lower(host)),
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE
);

-- The restricted role. It is not a login: the application's own login role switches to it on every connection.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'novadesk_app') THEN
    BEGIN
      CREATE ROLE novadesk_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    EXCEPTION WHEN duplicate_object THEN NULL;   -- another installation or test on the same server made it a moment ago
    END;
  END IF;
  IF NOT pg_has_role(current_user, 'novadesk_app', 'MEMBER') THEN
    EXECUTE format('GRANT novadesk_app TO %I', current_user);
  END IF;
END $$;

-- The tenant of the statement that is running (NULL when none is set): what tenant_id defaults to and what the policies compare with.
CREATE FUNCTION nd_tenant() RETURNS integer LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('app.tenant_id', true), '')::int $f$;

-- Adds tenant_id and the row level security to one table.
CREATE FUNCTION nd_tenant_scope(tbl regclass) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  name text := (SELECT relname FROM pg_class WHERE oid = tbl);
BEGIN
  EXECUTE format('ALTER TABLE %s ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id)', tbl);
  EXECUTE format('ALTER TABLE %s ALTER COLUMN tenant_id SET DEFAULT nd_tenant()', tbl);
  EXECUTE format('CREATE INDEX %I ON %s (tenant_id)', left(name, 50) || '_tenant_idx', tbl);
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format($p$CREATE POLICY tenant_isolation ON %s
    USING ((SELECT coalesce(current_setting('app.platform', true), '')) = 'on' OR tenant_id = (SELECT nd_tenant()))
    WITH CHECK ((SELECT coalesce(current_setting('app.platform', true), '')) = 'on' OR tenant_id = (SELECT nd_tenant()))$p$, tbl);
END $fn$;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT table_name FROM information_schema.tables
           WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
             AND table_name NOT IN ('schema_migrations', 'tenants', 'tenant_hosts')
           ORDER BY table_name
  LOOP
    PERFORM nd_tenant_scope(format('%I.%I', current_schema(), t)::regclass);
  END LOOP;
END $$;

-- Names that were unique across the installation are unique within a tenant. (API key and SCIM token hashes, session ids and
-- the like stay unique across everything: they are how a request finds its tenant.)
DO $$
DECLARE
  spec text[]; tbl text; cols text; cname text;
BEGIN
  FOREACH spec SLICE 1 IN ARRAY ARRAY[
    ARRAY['users', 'username'], ARRAY['incidents', 'number'], ARRAY['changes', 'number'], ARRAY['problems', 'number'],
    ARRAY['service_requests', 'number'], ARRAY['kb_articles', 'number'], ARRAY['cmdb_ci', 'ci_number'],
    ARRAY['change_tasks', 'task_number'], ARRAY['custom_fields', 'entity_type, key'], ARRAY['sla_policies', 'applies_to, priority'],
    ARRAY['user_identities', 'issuer, subject'], ARRAY['inbound_emails', 'message_id']
  ] LOOP
    tbl := spec[1]; cols := spec[2];
    SELECT c.conname INTO cname FROM pg_constraint c
      WHERE c.conrelid = format('%I.%I', current_schema(), tbl)::regclass AND c.contype = 'u'
        AND (SELECT string_agg(a.attname, ', ' ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) = cols;
    IF cname IS NULL THEN RAISE EXCEPTION 'expected a unique constraint on %(%)', tbl, cols; END IF;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', tbl, cname);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (tenant_id, %s)', tbl, left(tbl || '_tenant_' || replace(replace(cols, ', ', '_'), ' ', ''), 60), cols);
  END LOOP;
END $$;

-- Per-tenant counters and retention rules: the primary key gains the tenant.
ALTER TABLE counters DROP CONSTRAINT counters_pkey;
ALTER TABLE counters ADD PRIMARY KEY (tenant_id, name);
ALTER TABLE retention_rules DROP CONSTRAINT retention_rules_pkey;
ALTER TABLE retention_rules ADD PRIMARY KEY (tenant_id, target);

-- One row of settings for each tenant, where there used to be one row for the installation (id = 1).
DO $$
DECLARE t text; cname text;
BEGIN
  FOREACH t IN ARRAY ARRAY['branding_settings', 'scim_settings'] LOOP
    FOR cname IN SELECT c.conname FROM pg_constraint c WHERE c.conrelid = format('%I.%I', current_schema(), t)::regclass AND c.contype = 'c' LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, cname);
    END LOOP;
    EXECUTE format('CREATE SEQUENCE %I START 2 OWNED BY %I.id', t || '_id_seq', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN id SET DEFAULT nextval(%L)', t, t || '_id_seq');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (tenant_id)', t, t || '_one_per_tenant');
  END LOOP;
END $$;
-- (scim_settings and branding_settings keep their own CHECKs on the other columns? They had none besides id = 1 and the role list,
-- which are put back here.)
ALTER TABLE scim_settings ADD CONSTRAINT scim_settings_default_role_check CHECK (default_role IN ('user', 'agent'));
ALTER TABLE branding_settings ADD CONSTRAINT branding_settings_login_background_check CHECK (login_background IN ('builtin', 'plain', 'custom'));

-- The restricted role may use everything that exists now and everything this role of ours creates later.
DO $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO novadesk_app', current_schema());
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO novadesk_app', current_schema());
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO novadesk_app', current_schema());
  EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO novadesk_app', current_schema());
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO novadesk_app', current_schema());
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO novadesk_app', current_schema());
END $$;
