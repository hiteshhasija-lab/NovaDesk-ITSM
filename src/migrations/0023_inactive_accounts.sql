-- 0023 Inactive accounts: when was a person switched off? (src/privacy/inactive.js)
--
-- users.deactivated_at is the moment an account went from on to off, kept by a trigger so that EVERY way of switching someone off
-- is covered (the Users page, SCIM, a CSV import, anything that follows) and switching them on again clears it. An administrator
-- can ask for accounts that have been off for a number of days to be anonymised automatically; that rule lives in retention_rules
-- (target 'inactive_accounts', keep_days = days off) so it is per tenant like the other privacy limits and is off until it is set.
--
-- People who are already switched off when this runs start their clock now: nobody is anonymised on the strength of a date
-- that was never recorded.

ALTER TABLE users ADD COLUMN deactivated_at TEXT;

CREATE FUNCTION nd_user_deactivated() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.active = 1 THEN
    NEW.deactivated_at := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.deactivated_at IS NULL THEN NEW.deactivated_at := to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'); END IF;
  ELSIF OLD.active = 1 THEN
    NEW.deactivated_at := to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
  END IF;
  RETURN NEW;
END $f$;

CREATE TRIGGER nd_user_deactivated BEFORE INSERT OR UPDATE OF active ON users
  FOR EACH ROW EXECUTE FUNCTION nd_user_deactivated();

UPDATE users SET deactivated_at = to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE active = 0 AND anonymised_at IS NULL;
