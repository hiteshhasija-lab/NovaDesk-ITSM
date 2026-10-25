-- 0008 sessions in the database, so a person's sign-ins can be listed and ended from anywhere.
--
-- Until now each sign-in was a file under data/sessions: nobody could see which devices were signed in, and a
-- changed or reset password could not end the sign-ins that were already open. Now each session is a row.
--   user_id      who is signed in (null while someone is only looking at the sign-in page); no foreign key, so a
--                late save of a session whose person was just deleted cannot fail; deleting a person removes theirs
--   data         the session itself (JSON): who, the anti-forgery token, the page they were heading to
--   created_at / last_seen_at / expires_at   UTC text like every other timestamp
--   ip, user_agent   where it was signed in from, shown to the person on their sessions page
-- Sessions that existed as files before this release are not carried over: everyone signs in once more.

CREATE TABLE sessions (
  sid TEXT PRIMARY KEY,
  user_id INTEGER,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expires ON sessions (expires_at);
