-- 0010 CSV import: one row for every file uploaded to be imported (users, configuration items, knowledge articles).
--
-- A file is judged when it is uploaded (the preview) and carried out when the person confirms, so it has to be kept in
-- between: csv holds the text until the import has run, expired or failed, then it is emptied. What is left is the record:
-- who, which file, what was added, updated and refused. status: ready (waiting for the person to confirm), running, done,
-- failed, expired. preview and result are JSON.
-- user_id is cleared, not blocked, when the person who imported is deleted.

CREATE TABLE imports (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL,                      -- users, cmdb, kb
  mode TEXT NOT NULL DEFAULT 'add',        -- add (leave what exists alone), update (change what exists too)
  options TEXT,
  filename TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  csv TEXT,
  preview TEXT,
  result TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  finished_at TEXT
);
CREATE INDEX imports_recent ON imports (created_at);
CREATE INDEX imports_user ON imports (user_id);
