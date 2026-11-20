-- 0022 Usage limits for each tenant, set by the people who run the installation (the platform console) and enforced by the database itself,
-- so that every way of making something is covered at once: the pages, the REST API, SCIM, single-sign-on accounts, inbound mail, CSV imports.
--
--   limit_users       active people (accounts that are switched on)            NULL = no limit
--   limit_records     incidents, requests, changes, problems, configuration items and knowledge articles together (what is stored, closed ones included)
--   limit_storage_mb  megabytes of attached files
--
-- A trigger runs before each insert (and before a person is switched on again): with no limit it does nothing; with one it takes a lock for
-- that tenant and kind (so two requests at once cannot both take the last place), counts, and refuses with the error code ND001 and a message
-- the application turns into a plain sentence. Lowering a limit below what is already used deletes nothing: it only stops new things.

ALTER TABLE tenants ADD COLUMN limit_users INTEGER CHECK (limit_users IS NULL OR limit_users >= 0);
ALTER TABLE tenants ADD COLUMN limit_records INTEGER CHECK (limit_records IS NULL OR limit_records >= 0);
ALTER TABLE tenants ADD COLUMN limit_storage_mb INTEGER CHECK (limit_storage_mb IS NULL OR limit_storage_mb >= 0);

CREATE FUNCTION nd_check_limit() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE
  kind text := TG_ARGV[0];
  lim integer;
  used bigint;
  t integer := NEW.tenant_id;
BEGIN
  IF kind = 'users' THEN SELECT limit_users INTO lim FROM tenants WHERE id = t;
  ELSIF kind = 'records' THEN SELECT limit_records INTO lim FROM tenants WHERE id = t;
  ELSE SELECT limit_storage_mb INTO lim FROM tenants WHERE id = t;
  END IF;
  IF lim IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('nd_limit:' || kind), t);
  IF kind = 'users' THEN
    IF NEW.active IS DISTINCT FROM 1 THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND OLD.active = 1 THEN RETURN NEW; END IF;   -- already counted
    SELECT count(*) INTO used FROM users WHERE tenant_id = t AND active = 1;
    IF used >= lim THEN RAISE EXCEPTION 'nd_limit:users:%', lim USING ERRCODE = 'ND001'; END IF;
  ELSIF kind = 'records' THEN
    SELECT (SELECT count(*) FROM incidents WHERE tenant_id = t) + (SELECT count(*) FROM service_requests WHERE tenant_id = t)
         + (SELECT count(*) FROM changes WHERE tenant_id = t) + (SELECT count(*) FROM problems WHERE tenant_id = t)
         + (SELECT count(*) FROM cmdb_ci WHERE tenant_id = t) + (SELECT count(*) FROM kb_articles WHERE tenant_id = t) INTO used;
    IF used >= lim THEN RAISE EXCEPTION 'nd_limit:records:%', lim USING ERRCODE = 'ND001'; END IF;
  ELSE
    SELECT coalesce(sum(size), 0) INTO used FROM attachments WHERE tenant_id = t;
    IF used + coalesce(NEW.size, 0) > lim::bigint * 1048576 THEN RAISE EXCEPTION 'nd_limit:storage:%', lim USING ERRCODE = 'ND001'; END IF;
  END IF;
  RETURN NEW;
END $f$;

CREATE TRIGGER nd_limit_users_insert BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION nd_check_limit('users');
CREATE TRIGGER nd_limit_users_active BEFORE UPDATE OF active ON users FOR EACH ROW EXECUTE FUNCTION nd_check_limit('users');
CREATE TRIGGER nd_limit_records_incidents BEFORE INSERT ON incidents FOR EACH ROW EXECUTE FUNCTION nd_check_limit('records');
CREATE TRIGGER nd_limit_records_requests BEFORE INSERT ON service_requests FOR EACH ROW EXECUTE FUNCTION nd_check_limit('records');
CREATE TRIGGER nd_limit_records_changes BEFORE INSERT ON changes FOR EACH ROW EXECUTE FUNCTION nd_check_limit('records');
CREATE TRIGGER nd_limit_records_problems BEFORE INSERT ON problems FOR EACH ROW EXECUTE FUNCTION nd_check_limit('records');
CREATE TRIGGER nd_limit_records_cis BEFORE INSERT ON cmdb_ci FOR EACH ROW EXECUTE FUNCTION nd_check_limit('records');
CREATE TRIGGER nd_limit_records_articles BEFORE INSERT ON kb_articles FOR EACH ROW EXECUTE FUNCTION nd_check_limit('records');
CREATE TRIGGER nd_limit_storage BEFORE INSERT ON attachments FOR EACH ROW EXECUTE FUNCTION nd_check_limit('storage');
