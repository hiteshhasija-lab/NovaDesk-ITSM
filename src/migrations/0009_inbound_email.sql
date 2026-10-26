-- 0009 inbound email: mail sent to the help desk becomes incidents, and replies become comments.
--
-- inbound_emails   one row for every message looked at, with what was done about it (ticket, comment, ignored, rejected,
--                  failed) and why. message_id is unique, so reading the same message twice (a mailbox read again after a
--                  restart, a mail system that retries) can never make a second ticket.
-- notifications.message_id   the Message-ID of each notice NovaDesk sent: a reply that quotes it (In-Reply-To) is matched
--                  to the right incident whatever the subject says now.
-- users.created_from_email   a person who had no account and was made a contact when they first wrote in. They cannot
--                  sign in (their password is unusable) until an administrator sets one or they sign in with single sign-on.

CREATE TABLE inbound_emails (
  id BIGSERIAL PRIMARY KEY,
  received_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  message_id TEXT NOT NULL UNIQUE,         -- the Message-ID header, or a fingerprint of the message when it has none
  source TEXT NOT NULL,                    -- imap, http
  from_address TEXT,
  from_name TEXT,
  subject TEXT,
  size INTEGER,
  outcome TEXT NOT NULL,                   -- processing, ticket, comment, ignored, rejected, failed
  reason TEXT,
  record_type TEXT,                        -- incident
  record_id INTEGER,
  sender_user_id INTEGER
);
CREATE INDEX inbound_emails_recent ON inbound_emails (id DESC);
CREATE INDEX inbound_emails_sender ON inbound_emails (from_address, received_at);

ALTER TABLE notifications ADD COLUMN message_id TEXT;
CREATE INDEX notifications_message_id ON notifications (message_id) WHERE message_id IS NOT NULL;

ALTER TABLE users ADD COLUMN created_from_email INTEGER NOT NULL DEFAULT 0;
