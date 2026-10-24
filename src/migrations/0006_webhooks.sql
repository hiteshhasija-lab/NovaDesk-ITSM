-- 0006 webhooks: NovaDesk tells other systems when records change.
--
-- webhooks: where to send (url), the shared secret that signs every delivery (stored encrypted), which events.
-- event_outbox: one row per thing that happened to a record. Database triggers write it, on every table that
--   matters, so every way of changing a record is covered (the pages, the API, the integrations and the
--   decommission automation) without any of that code knowing about webhooks. Nothing is written while no webhook
--   is switched on, and a trigger that fails can never block the change that caused it.
-- webhook_deliveries: what is sent to each webhook for each event, how many tries, and how it went.

CREATE TABLE webhooks (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  events TEXT NOT NULL,                         -- comma separated event types, or * for all of them
  active INTEGER NOT NULL DEFAULT 1,
  disabled_reason TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE TABLE event_outbox (
  id BIGSERIAL PRIMARY KEY,
  entity TEXT NOT NULL,                         -- incident, change, problem, request, ci, article
  entity_id INTEGER NOT NULL,
  op TEXT NOT NULL,                             -- created, updated, status_changed, commented
  previous_status TEXT,
  child_id INTEGER,                             -- the comment, for commented
  snapshot JSONB,                               -- the record as it was right after the change (what a receiver is shown)
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  processed_at TEXT
);
CREATE INDEX event_outbox_pending ON event_outbox (id) WHERE processed_at IS NULL;

CREATE TABLE webhook_deliveries (
  id SERIAL PRIMARY KEY,
  webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_status_code INTEGER,
  last_error TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  UNIQUE (webhook_id, event_id)
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_webhook ON webhook_deliveries (webhook_id, id DESC);

-- The record without the columns that change all the time without anyone editing it: updated_at (one-second
-- precision, so it cannot tell two quick edits apart), the SLA bookkeeping the sweep writes, and article view counts.
CREATE FUNCTION nd_record_content(j jsonb) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb) FROM jsonb_each(j)
  WHERE key NOT LIKE 'sla\_%' AND key NOT IN ('updated_at', 'view_count')
$$ LANGUAGE sql IMMUTABLE;

-- A record was created, changed or moved to another status. TG_ARGV[0] names the kind of record.
CREATE FUNCTION nd_emit_record_event() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM webhooks WHERE active = 1) THEN RETURN NULL; END IF;
  BEGIN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO event_outbox (entity, entity_id, op, snapshot) VALUES (TG_ARGV[0], NEW.id, 'created', to_jsonb(NEW));
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
      INSERT INTO event_outbox (entity, entity_id, op, previous_status, snapshot) VALUES (TG_ARGV[0], NEW.id, 'status_changed', OLD.status, to_jsonb(NEW));
    ELSIF nd_record_content(to_jsonb(NEW)) IS DISTINCT FROM nd_record_content(to_jsonb(OLD)) THEN
      INSERT INTO event_outbox (entity, entity_id, op, snapshot) VALUES (TG_ARGV[0], NEW.id, 'updated', to_jsonb(NEW));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;   -- an event that cannot be recorded must never stop the change itself
  END;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- A comment was added. TG_ARGV[0] is the kind of record, TG_ARGV[1] the column that points at it. Internal work
-- notes on incidents are never announced.
CREATE FUNCTION nd_emit_comment_event() RETURNS trigger AS $$
DECLARE
  parent_id INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM webhooks WHERE active = 1) THEN RETURN NULL; END IF;
  BEGIN
    IF TG_ARGV[0] = 'incident' THEN
      IF NEW.is_work_note <> 0 THEN RETURN NULL; END IF;
      parent_id := NEW.incident_id;
    ELSIF TG_ARGV[0] = 'change' THEN
      parent_id := NEW.change_id;
    ELSE
      parent_id := NEW.problem_id;
    END IF;
    INSERT INTO event_outbox (entity, entity_id, op, child_id) VALUES (TG_ARGV[0], parent_id, 'commented', NEW.id);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER nd_event_incident AFTER INSERT OR UPDATE ON incidents FOR EACH ROW EXECUTE FUNCTION nd_emit_record_event('incident');
CREATE TRIGGER nd_event_change AFTER INSERT OR UPDATE ON changes FOR EACH ROW EXECUTE FUNCTION nd_emit_record_event('change');
CREATE TRIGGER nd_event_problem AFTER INSERT OR UPDATE ON problems FOR EACH ROW EXECUTE FUNCTION nd_emit_record_event('problem');
CREATE TRIGGER nd_event_request AFTER INSERT OR UPDATE ON service_requests FOR EACH ROW EXECUTE FUNCTION nd_emit_record_event('request');
CREATE TRIGGER nd_event_ci AFTER INSERT OR UPDATE ON cmdb_ci FOR EACH ROW EXECUTE FUNCTION nd_emit_record_event('ci');
CREATE TRIGGER nd_event_article AFTER INSERT OR UPDATE ON kb_articles FOR EACH ROW EXECUTE FUNCTION nd_emit_record_event('article');
CREATE TRIGGER nd_event_incident_comment AFTER INSERT ON incident_comments FOR EACH ROW EXECUTE FUNCTION nd_emit_comment_event('incident');
CREATE TRIGGER nd_event_change_comment AFTER INSERT ON change_comments FOR EACH ROW EXECUTE FUNCTION nd_emit_comment_event('change');
CREATE TRIGGER nd_event_problem_comment AFTER INSERT ON problem_comments FOR EACH ROW EXECUTE FUNCTION nd_emit_comment_event('problem');
