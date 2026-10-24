-- 0005 personal API keys and idempotent requests for the REST API (/api/v1).
--
-- api_keys: one row per key. Only a hash of the key is stored (the key itself is shown once, when it is made).
--   scope 'read' can only read; 'write' can also create and change records. A key acts as its owner, with the
--   owner's role, and stops working when the owner is turned off.
-- api_idempotency: the answer given to a POST that carried an Idempotency-Key header, so repeating the request
--   (after a timeout, say) returns the same answer instead of creating a second record. Kept for a day.

CREATE TABLE api_keys (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL DEFAULT 'read' CHECK (scope IN ('read', 'write')),
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX api_keys_user ON api_keys (user_id);

CREATE TABLE api_idempotency (
  id SERIAL PRIMARY KEY,
  key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  idem_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER,
  response TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  UNIQUE (key_id, idem_key)
);
