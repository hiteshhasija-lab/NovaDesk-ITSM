-- 0011 Privacy tools: anonymising a person, and how long logs and messages are kept.
--
-- users.anonymised_at is set when an administrator anonymises a person (src/privacy/anonymise.js): the name, username,
-- email and every sign-in method are gone, the account cannot be used again, and the tickets and comments they took part
-- in keep pointing at the account so the history stays whole. NULL for everybody else.
--
-- retention_rules says how many days each kind of log or message is kept (src/privacy/retention.js). No row, or keep_days
-- NULL, means keep for ever, which is how every install starts. 30 days is the shortest allowed. last_run_at and
-- last_removed describe the most recent sweep of that kind.

ALTER TABLE users ADD COLUMN anonymised_at TEXT;

CREATE TABLE retention_rules (
  target TEXT PRIMARY KEY,                 -- audit_log, notifications, inbound_emails, webhook_deliveries
  keep_days INTEGER CHECK (keep_days IS NULL OR keep_days >= 30),
  last_run_at TEXT,
  last_removed INTEGER
);
