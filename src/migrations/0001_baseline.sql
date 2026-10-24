-- 0001 baseline: every table and column NovaDesk had when migrations were introduced (0.0.87).
--
-- Written so it can run on ANY database: a new empty one (it creates everything) and an existing install
-- from any earlier release (every statement is CREATE ... IF NOT EXISTS or ADD COLUMN IF NOT EXISTS, so
-- it changes nothing that is already there). Never edit this file after release; later changes go in
-- new numbered files (see README.md in this folder).
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'user', -- admin, agent, user
  department TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  email_notifications INTEGER NOT NULL DEFAULT 1,
  theme_preference TEXT NOT NULL DEFAULT 'dark', -- dark, light
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_notifications INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_preference TEXT NOT NULL DEFAULT 'dark';

CREATE TABLE IF NOT EXISTS cmdb_ci (
  id SERIAL PRIMARY KEY,
  ci_number TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  ci_type TEXT NOT NULL, -- server, network_device, application, database, workstation, storage
  environment TEXT DEFAULT 'production', -- production, staging, uat, development, dr
  status TEXT NOT NULL DEFAULT 'in_use', -- in_use, in_stock, maintenance, retired
  ip_address TEXT,
  os TEXT,
  manufacturer TEXT,
  model TEXT,
  serial_number TEXT,
  location TEXT,
  owner_id INTEGER REFERENCES users(id),
  support_group TEXT,
  cpu TEXT,
  ram TEXT,
  disk TEXT,
  purchase_date TEXT,
  warranty_expiry TEXT,
  install_date TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  updated_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE TABLE IF NOT EXISTS ci_relationships (
  id SERIAL PRIMARY KEY,
  parent_ci_id INTEGER NOT NULL REFERENCES cmdb_ci(id) ON DELETE CASCADE,
  child_ci_id INTEGER NOT NULL REFERENCES cmdb_ci(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL DEFAULT 'depends_on', -- depends_on, hosted_on, connects_to, runs_on
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE TABLE IF NOT EXISTS problems (
  id SERIAL PRIMARY KEY,
  number TEXT UNIQUE NOT NULL,
  short_description TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'new', -- new, investigating, known_error, resolved, closed
  priority INTEGER NOT NULL DEFAULT 3, -- 1 Critical .. 4 Low
  root_cause TEXT,
  workaround TEXT,
  affected_ci_id INTEGER REFERENCES cmdb_ci(id),
  raised_by INTEGER REFERENCES users(id),
  assigned_to INTEGER REFERENCES users(id),
  assignment_group TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  updated_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  resolved_at TEXT,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS incidents (
  id SERIAL PRIMARY KEY,
  number TEXT UNIQUE NOT NULL,
  short_description TEXT NOT NULL,
  description TEXT,
  category TEXT DEFAULT 'other', -- hardware, software, network, access, other
  subcategory TEXT,
  impact INTEGER NOT NULL DEFAULT 3, -- 1 High, 2 Medium, 3 Low
  urgency INTEGER NOT NULL DEFAULT 3,
  priority INTEGER NOT NULL DEFAULT 4, -- 1 Critical .. 4 Low, derived from impact+urgency
  status TEXT NOT NULL DEFAULT 'new', -- new, in_progress, on_hold, resolved, closed, cancelled
  caller_id INTEGER REFERENCES users(id),
  assigned_to INTEGER REFERENCES users(id),
  assignment_group TEXT,
  affected_ci_id INTEGER REFERENCES cmdb_ci(id),
  resolution_notes TEXT,
  problem_id INTEGER REFERENCES problems(id),
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  updated_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  resolved_at TEXT,
  closed_at TEXT,
  sla_due_at TEXT
);

CREATE TABLE IF NOT EXISTS incident_comments (
  id SERIAL PRIMARY KEY,
  incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  comment TEXT NOT NULL,
  is_work_note INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE TABLE IF NOT EXISTS changes (
  id SERIAL PRIMARY KEY,
  number TEXT UNIQUE NOT NULL,
  short_description TEXT NOT NULL,
  description TEXT,
  change_type TEXT NOT NULL DEFAULT 'normal', -- standard, normal, emergency
  risk TEXT NOT NULL DEFAULT 'medium', -- low, medium, high
  status TEXT NOT NULL DEFAULT 'draft', -- draft, submitted, approved, rejected, scheduled, in_progress, implemented, closed, cancelled
  requested_by INTEGER REFERENCES users(id),
  assigned_to INTEGER REFERENCES users(id),
  assignment_group TEXT,
  affected_ci_id INTEGER REFERENCES cmdb_ci(id),
  planned_start TEXT,
  planned_end TEXT,
  implementation_plan TEXT,
  backout_plan TEXT,
  approval_status TEXT NOT NULL DEFAULT 'pending', -- pending, approved, rejected
  approved_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  updated_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  closed_at TEXT
);

ALTER TABLE changes ADD COLUMN IF NOT EXISTS novaconnect_channel_id INTEGER;
ALTER TABLE changes ADD COLUMN IF NOT EXISTS novaconnect_conversation_id INTEGER;
ALTER TABLE changes ADD COLUMN IF NOT EXISTS assignment_group TEXT;
ALTER TABLE problems ADD COLUMN IF NOT EXISTS assignment_group TEXT;

CREATE TABLE IF NOT EXISTS change_comments (
  id SERIAL PRIMARY KEY,
  change_id INTEGER NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  comment TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE TABLE IF NOT EXISTS change_tasks (
  id SERIAL PRIMARY KEY,
  change_id INTEGER NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  task_number TEXT UNIQUE NOT NULL,
  description TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, running, done
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

-- The NovaConnect message id of the precheck card pushed for this task, if any (decom tasks
-- only). Lets a NovaDesk-side status change (the Change Tasks toggle button) push the matching
-- card's resolution back to NovaConnect, instead of leaving it stuck showing "pending" forever.
ALTER TABLE change_tasks ADD COLUMN IF NOT EXISTS novaconnect_message_id INTEGER;

CREATE TABLE IF NOT EXISTS scheduled_actions (
  id SERIAL PRIMARY KEY,
  change_id INTEGER NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL, -- destroy_vm
  run_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, executed, cancelled
  executed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

-- Delivery bookkeeping for the destroy-confirm card (see scheduler.js). A timer is only
-- 'executed' once the card reached every NovaConnect target; until then it stays 'pending' and is
-- retried, and delivered_targets remembers which targets already have the card so a retry never
-- posts a second copy there. Placed AFTER the CREATE TABLE above (an ALTER before its table exists
-- aborts the schema on a fresh database).
ALTER TABLE scheduled_actions ADD COLUMN IF NOT EXISTS delivered_targets TEXT;
ALTER TABLE scheduled_actions ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;

-- The chat cards NovaConnect shows for a decommission are a copy of NovaDesk's own records. This
-- ledger says what each card should show (desired_status) and what has been delivered, so a
-- failed callback is repaired by a background loop instead of leaving the chat wrong (see
-- cardSync.js). One row per Change + card type + task (task_id 0 = a Change-level card).
-- posted_targets / dead_targets are JSON arrays of target keys ("channel:6", "dm:7"); fail_counts
-- is a JSON object of consecutive failures per target while the receiver was otherwise reachable.
CREATE TABLE IF NOT EXISTS decom_card_sync (
  id SERIAL PRIMARY KEY,
  change_id INTEGER NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  card_type TEXT NOT NULL,
  task_id INTEGER NOT NULL DEFAULT 0,
  post_payload TEXT,
  desired_status TEXT NOT NULL,
  delivered_status TEXT,
  posted_targets TEXT NOT NULL DEFAULT '[]',
  dead_targets TEXT NOT NULL DEFAULT '[]',
  fail_counts TEXT NOT NULL DEFAULT '{}',
  done INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT NOT NULL,
  inflight_until TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  updated_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  UNIQUE (change_id, card_type, task_id)
);
CREATE INDEX IF NOT EXISTS decom_card_sync_pending ON decom_card_sync (done, next_attempt_at);

-- When NovaDesk issued the ESXi destroy for a decommission. If the answer is lost (govc timeout)
-- the host may still have destroyed the VM; a retry that finds no VM can then continue the
-- sequence instead of failing for ever (decomAutomation.runConfirmedDestroy).
ALTER TABLE changes ADD COLUMN IF NOT EXISTS vm_destroy_issued_at TEXT;

-- The CI's status before a decommission put it in maintenance mode on approval, so a cancelled
-- decommission can put it back (decomAutomation.putCiInMaintenance / restoreCiFromMaintenance).
ALTER TABLE changes ADD COLUMN IF NOT EXISTS ci_status_before_decom TEXT;

-- Who confirmed the destroy, kept with vm_destroy_issued_at so an interrupted destroy can be
-- resumed after a crash under the same confirmation (decomAutomation.resumeInterruptedDecoms).
ALTER TABLE changes ADD COLUMN IF NOT EXISTS vm_destroy_confirmed_by INTEGER;

-- The status a CI had before someone used the "Put in maintenance mode" button, so "Take out of
-- maintenance mode" puts it back (cmdb routes). Not used by the decommission flow, which keeps its
-- own record per Change (changes.ci_status_before_decom).
ALTER TABLE cmdb_ci ADD COLUMN IF NOT EXISTS status_before_maintenance TEXT;

-- Display names for people who act on a decommission through NovaConnect but have no NovaDesk
-- account. Their actions are stored under NovaDesk's default admin account (the id columns need a
-- NovaDesk user); these hold the real name so the Activity list and "Approved By" show the person
-- who acted, not the admin account. NULL means "use the account's own name".
--  activity_log.actor_name            the name shown for that activity row (added right after that table)
--  changes.approved_by_name           the name shown as the approver (cleared when approved_by changes)
--  changes.vm_destroy_confirmed_by_name  kept with vm_destroy_confirmed_by so a destroy resumed after
--                                     a restart is still attributed to the person who confirmed it
ALTER TABLE changes ADD COLUMN IF NOT EXISTS approved_by_name TEXT;
ALTER TABLE changes ADD COLUMN IF NOT EXISTS vm_destroy_confirmed_by_name TEXT;

-- Membership of assignment groups (the names in helpers.ASSIGNMENT_GROUPS). Used for who may
-- approve a decommission Change in NovaDesk: its requester or a member of IRO-Build/Decom
-- (approvalAccess.js). Edited on the user's page.
CREATE TABLE IF NOT EXISTS user_assignment_groups (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_name TEXT NOT NULL,
  PRIMARY KEY (user_id, group_name)
);

CREATE TABLE IF NOT EXISTS problem_comments (
  id SERIAL PRIMARY KEY,
  problem_id INTEGER NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  comment TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE TABLE IF NOT EXISTS catalog_items (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'general', -- hardware, software, access, other, general
  icon TEXT NOT NULL DEFAULT 'bi-box-seam',
  fulfillment_group TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE TABLE IF NOT EXISTS service_requests (
  id SERIAL PRIMARY KEY,
  number TEXT UNIQUE NOT NULL,
  catalog_item_id INTEGER REFERENCES catalog_items(id),
  requested_by INTEGER REFERENCES users(id),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'submitted', -- submitted, in_progress, fulfilled, rejected, cancelled
  assigned_to INTEGER REFERENCES users(id),
  assignment_group TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  updated_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  fulfilled_at TEXT
);

-- Must come AFTER the CREATE TABLE above: on a fresh database the table does not exist yet, and
-- an ALTER placed earlier in this script aborts the whole schema transaction (NovaDesk then
-- cannot start). Found by the fault-injection rig's first start against an empty database.
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS assignment_group TEXT;

CREATE TABLE IF NOT EXISTS kb_articles (
  id SERIAL PRIMARY KEY,
  number TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published', -- draft, published
  author_id INTEGER REFERENCES users(id),
  view_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  updated_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  recipient_email TEXT NOT NULL,
  recipient_name TEXT,
  subject TEXT NOT NULL,
  body TEXT,
  related_type TEXT, -- incident, change
  related_id INTEGER,
  preview_url TEXT,
  status TEXT NOT NULL DEFAULT 'failed', -- sent, failed, not_configured (no mail server set up)
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS error TEXT;

CREATE TABLE IF NOT EXISTS activity_log (
  id SERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL, -- incident, change
  entity_id INTEGER NOT NULL,
  actor_id INTEGER REFERENCES users(id),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

-- Display name for an action by someone with no NovaDesk account (see the changes.approved_by_name note).
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS actor_name TEXT;

CREATE TABLE IF NOT EXISTS attachments (
  id SERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL, -- incident, change, problem
  entity_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT,
  size INTEGER,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE TABLE IF NOT EXISTS watchers (
  id SERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL, -- incident, change, problem
  entity_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  UNIQUE(entity_type, entity_id, user_id)
);
  