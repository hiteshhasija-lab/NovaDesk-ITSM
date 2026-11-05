-- 0013 Custom fields: fields an administrator adds to incidents, service requests, changes, problems and configuration
-- items (src/customFields.js), for what each organisation wants to record that NovaDesk does not ask for out of the box.
--
-- custom_fields is the definition (what the field is called, what kind of value it holds, whether it is required, who may
-- see it); custom_field_values holds the value a record has for it, one row per record and field, as text (a record with no
-- value for a field has no row). A field is never given a column on the record tables, so adding one changes no table.
-- key and field_type never change once a field exists; deactivating a field hides it everywhere and keeps its values;
-- deleting one removes its values (ON DELETE CASCADE). audience says who sees and fills it in: everyone who can see the
-- record, or only agents and administrators.
-- The triggers remove a record's values when the record is deleted, whichever route deletes it.

CREATE TABLE custom_fields (
  id SERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('incident', 'request', 'change', 'problem', 'ci')),
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL CHECK (field_type IN ('text', 'textarea', 'number', 'date', 'select', 'checkbox')),
  options TEXT,                                   -- select: JSON list of { value, label }
  required INTEGER NOT NULL DEFAULT 0,
  audience TEXT NOT NULL DEFAULT 'everyone' CHECK (audience IN ('everyone', 'staff')),
  help TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  UNIQUE (entity_type, key)
);

CREATE TABLE custom_field_values (
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  field_id INTEGER NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  PRIMARY KEY (entity_type, entity_id, field_id)
);
CREATE INDEX custom_field_values_field ON custom_field_values (field_id);

CREATE FUNCTION custom_field_values_cleanup() RETURNS trigger AS $$
BEGIN
  DELETE FROM custom_field_values WHERE entity_type = TG_ARGV[0] AND entity_id = OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER incidents_custom_field_values AFTER DELETE ON incidents FOR EACH ROW EXECUTE FUNCTION custom_field_values_cleanup('incident');
CREATE TRIGGER service_requests_custom_field_values AFTER DELETE ON service_requests FOR EACH ROW EXECUTE FUNCTION custom_field_values_cleanup('request');
CREATE TRIGGER changes_custom_field_values AFTER DELETE ON changes FOR EACH ROW EXECUTE FUNCTION custom_field_values_cleanup('change');
CREATE TRIGGER problems_custom_field_values AFTER DELETE ON problems FOR EACH ROW EXECUTE FUNCTION custom_field_values_cleanup('problem');
CREATE TRIGGER cmdb_ci_custom_field_values AFTER DELETE ON cmdb_ci FOR EACH ROW EXECUTE FUNCTION custom_field_values_cleanup('ci');
