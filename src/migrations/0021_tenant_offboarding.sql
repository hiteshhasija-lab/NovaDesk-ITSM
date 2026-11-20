-- 0021 Leaving the service: a tenant can be exported and then deleted (src/tenantExport.js, src/tenants.js, the platform console).
--
-- A tenant that is to be deleted is first suspended, then given a final export, then scheduled for deletion with a grace period (it can
-- still be called off); a background job removes its data when the time comes. The columns here only record where it is in that
-- road: the tenants table belongs to no tenant. status_changed_at is when the tenant was last suspended or reactivated (an export is
-- final only if it was made after that); export_* describe the latest export (its SHA-256 and size, never its content).

DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = format('%I.tenants', current_schema())::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%status%' LOOP
    EXECUTE format('ALTER TABLE tenants DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE tenants ADD CONSTRAINT tenants_status_check CHECK (status IN ('active', 'suspended', 'pending_deletion'));
ALTER TABLE tenants ADD COLUMN status_changed_at TEXT;
ALTER TABLE tenants ADD COLUMN export_at TEXT;
ALTER TABLE tenants ADD COLUMN export_sha256 TEXT;
ALTER TABLE tenants ADD COLUMN export_bytes BIGINT;
ALTER TABLE tenants ADD COLUMN export_by TEXT;
ALTER TABLE tenants ADD COLUMN deletion_scheduled_at TEXT;
ALTER TABLE tenants ADD COLUMN deletion_requested_by TEXT;
