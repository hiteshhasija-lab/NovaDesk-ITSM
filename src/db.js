const bcrypt = require('bcryptjs');

// Postgres returns COUNT()/SUM() as bigint and AVG() as numeric, both of which
// node-postgres parses as STRINGS by default (bigint can exceed Number.MAX_SAFE_INTEGER).
// SQLite always returned plain JS numbers for these, and the app relies on that
// (e.g. summing counts, .toFixed() on averages) — parse them as numbers here instead.
const { types: pgTypes } = require('pg');
pgTypes.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10))); // int8/bigint
pgTypes.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val))); // numeric

const knexInstance = require('knex')({
  client: 'pg',
  connection: {
    host: process.env.PGHOST || 'RHEL10',
    port: process.env.PGPORT || 5432,
    user: process.env.PGUSER || 'novadesk',
    password: process.env.PGPASSWORD || 'novadesk_dev_pw',
    database: process.env.PGDATABASE || 'novadesk'
  },
  pool: { min: 0, max: 10 }
});

// Every timestamp column is TEXT (not native TIMESTAMP), storing naive UTC strings
// formatted 'YYYY-MM-DD HH:MM:SS' — this avoids the pg driver silently turning
// timestamp columns into JS Date objects, which the rest of the app doesn't expect.
function nowStr() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}
function offsetStr(days = 0, hours = 0) {
  const ms = Date.now() + days * 86400000 + hours * 3600000;
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}
function offsetDateStr(days = 0) {
  return offsetStr(days).slice(0, 10);
}
function addHoursStr(baseStr, hours) {
  const ms = new Date(baseStr.replace(' ', 'T') + 'Z').getTime() + hours * 3600000;
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

// Thin compatibility layer so call sites keep the familiar
// db.prepare(sql).get/all/run(...) shape from the previous synchronous
// node:sqlite driver — every call site just needs `await` added.
// @name bindings (the old node:sqlite named-param style) are translated to
// knex's :name style; a single non-array object argument is treated as named
// bindings, everything else as positional ? bindings.
function prepare(sql) {
  const pgSql = sql.replace(/@(\w+)/g, ':$1');
  const bindingsFrom = (args) => {
    if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
      return args[0];
    }
    return args;
  };
  return {
    get: async (...args) => (await knexInstance.raw(pgSql, bindingsFrom(args))).rows[0],
    all: async (...args) => (await knexInstance.raw(pgSql, bindingsFrom(args))).rows,
    run: async (...args) => {
      const result = await knexInstance.raw(pgSql, bindingsFrom(args));
      return {
        lastInsertRowid: result.rows[0] ? result.rows[0].id : undefined,
        changes: result.rowCount
      };
    }
  };
}

const db = { prepare, raw: (sql, params) => knexInstance.raw(sql, params) };

const TS_DEFAULT = "DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))";

async function initSchema() {
  await knexInstance.raw(`
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
  created_at TEXT NOT NULL ${TS_DEFAULT}
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
  created_at TEXT NOT NULL ${TS_DEFAULT},
  updated_at TEXT NOT NULL ${TS_DEFAULT}
);

CREATE TABLE IF NOT EXISTS ci_relationships (
  id SERIAL PRIMARY KEY,
  parent_ci_id INTEGER NOT NULL REFERENCES cmdb_ci(id) ON DELETE CASCADE,
  child_ci_id INTEGER NOT NULL REFERENCES cmdb_ci(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL DEFAULT 'depends_on', -- depends_on, hosted_on, connects_to, runs_on
  created_at TEXT NOT NULL ${TS_DEFAULT}
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
  created_at TEXT NOT NULL ${TS_DEFAULT},
  updated_at TEXT NOT NULL ${TS_DEFAULT},
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
  created_at TEXT NOT NULL ${TS_DEFAULT},
  updated_at TEXT NOT NULL ${TS_DEFAULT},
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
  created_at TEXT NOT NULL ${TS_DEFAULT}
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
  affected_ci_id INTEGER REFERENCES cmdb_ci(id),
  planned_start TEXT,
  planned_end TEXT,
  implementation_plan TEXT,
  backout_plan TEXT,
  approval_status TEXT NOT NULL DEFAULT 'pending', -- pending, approved, rejected
  approved_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL ${TS_DEFAULT},
  updated_at TEXT NOT NULL ${TS_DEFAULT},
  closed_at TEXT
);

ALTER TABLE changes ADD COLUMN IF NOT EXISTS novaconnect_channel_id INTEGER;
ALTER TABLE changes ADD COLUMN IF NOT EXISTS novaconnect_conversation_id INTEGER;

CREATE TABLE IF NOT EXISTS change_comments (
  id SERIAL PRIMARY KEY,
  change_id INTEGER NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  comment TEXT NOT NULL,
  created_at TEXT NOT NULL ${TS_DEFAULT}
);

CREATE TABLE IF NOT EXISTS change_tasks (
  id SERIAL PRIMARY KEY,
  change_id INTEGER NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  task_number TEXT UNIQUE NOT NULL,
  description TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, running, done
  completed_at TEXT,
  created_at TEXT NOT NULL ${TS_DEFAULT}
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
  created_at TEXT NOT NULL ${TS_DEFAULT}
);

CREATE TABLE IF NOT EXISTS problem_comments (
  id SERIAL PRIMARY KEY,
  problem_id INTEGER NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  comment TEXT NOT NULL,
  created_at TEXT NOT NULL ${TS_DEFAULT}
);

CREATE TABLE IF NOT EXISTS catalog_items (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'general', -- hardware, software, access, other, general
  icon TEXT NOT NULL DEFAULT 'bi-box-seam',
  fulfillment_group TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL ${TS_DEFAULT}
);

CREATE TABLE IF NOT EXISTS service_requests (
  id SERIAL PRIMARY KEY,
  number TEXT UNIQUE NOT NULL,
  catalog_item_id INTEGER REFERENCES catalog_items(id),
  requested_by INTEGER REFERENCES users(id),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'submitted', -- submitted, in_progress, fulfilled, rejected, cancelled
  assigned_to INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL ${TS_DEFAULT},
  updated_at TEXT NOT NULL ${TS_DEFAULT},
  fulfilled_at TEXT
);

CREATE TABLE IF NOT EXISTS kb_articles (
  id SERIAL PRIMARY KEY,
  number TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published', -- draft, published
  author_id INTEGER REFERENCES users(id),
  view_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL ${TS_DEFAULT},
  updated_at TEXT NOT NULL ${TS_DEFAULT}
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
  status TEXT NOT NULL DEFAULT 'failed', -- sent, failed
  created_at TEXT NOT NULL ${TS_DEFAULT}
);

CREATE TABLE IF NOT EXISTS activity_log (
  id SERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL, -- incident, change
  entity_id INTEGER NOT NULL,
  actor_id INTEGER REFERENCES users(id),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL ${TS_DEFAULT}
);

CREATE TABLE IF NOT EXISTS attachments (
  id SERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL, -- incident, change, problem
  entity_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT,
  size INTEGER,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL ${TS_DEFAULT}
);

CREATE TABLE IF NOT EXISTS watchers (
  id SERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL, -- incident, change, problem
  entity_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL ${TS_DEFAULT},
  UNIQUE(entity_type, entity_id, user_id)
);
  `);
}

async function nextNumber(counterName, prefix) {
  const row = await db.prepare('SELECT value FROM counters WHERE name = ?').get(counterName);
  let next;
  if (!row) {
    next = 1;
    await db.prepare('INSERT INTO counters (name, value) VALUES (?, ?)').run(counterName, next);
  } else {
    next = row.value + 1;
    await db.prepare('UPDATE counters SET value = ? WHERE name = ?').run(next, counterName);
  }
  return `${prefix}${String(next).padStart(7, '0')}`;
}

async function logActivity(entityType, entityId, actorId, message) {
  await db.prepare(`
    INSERT INTO activity_log (entity_type, entity_id, actor_id, message) VALUES (?, ?, ?, ?)
  `).run(entityType, entityId, actorId || null, message);
}

async function seedIfEmpty() {
  const userCount = (await db.prepare('SELECT COUNT(*) AS c FROM users').get()).c;
  if (Number(userCount) > 0) return;

  const insertUser = db.prepare(`
    INSERT INTO users (username, password_hash, full_name, email, role, department)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING id
  `);
  const mkHash = (pw) => bcrypt.hashSync(pw, 10);

  const admin = await insertUser.run('admin', mkHash('admin123'), 'Alex Admin', 'admin@corp.local', 'admin', 'IT Operations');
  const agent1 = await insertUser.run('jdoe', mkHash('agent123'), 'Jane Doe', 'jane.doe@corp.local', 'agent', 'Infrastructure Support');
  const agent2 = await insertUser.run('bsmith', mkHash('agent123'), 'Bob Smith', 'bob.smith@corp.local', 'agent', 'Network Operations');
  const user1 = await insertUser.run('mchen', mkHash('user123'), 'Maria Chen', 'maria.chen@corp.local', 'user', 'Finance');
  const user2 = await insertUser.run('rpatel', mkHash('user123'), 'Raj Patel', 'raj.patel@corp.local', 'user', 'Sales');

  const adminId = admin.lastInsertRowid;
  const agent1Id = agent1.lastInsertRowid;
  const agent2Id = agent2.lastInsertRowid;
  const user1Id = user1.lastInsertRowid;
  const user2Id = user2.lastInsertRowid;

  const insertCi = db.prepare(`
    INSERT INTO cmdb_ci (ci_number, name, ci_type, environment, status, ip_address, os, manufacturer, model,
      serial_number, location, owner_id, support_group, cpu, ram, disk, purchase_date, warranty_expiry, install_date, notes, created_by)
    VALUES (@ci_number, @name, @ci_type, @environment, @status, @ip_address, @os, @manufacturer, @model,
      @serial_number, @location, @owner_id, @support_group, @cpu, @ram, @disk, @purchase_date, @warranty_expiry, @install_date, @notes, @created_by)
    RETURNING id
  `);

  const ciSeed = [
    { name: 'PRD-WEB-01', ci_type: 'server', environment: 'production', status: 'in_use', ip_address: '10.10.1.11', os: 'Ubuntu 22.04 LTS', manufacturer: 'Dell', model: 'PowerEdge R740', serial_number: 'DL740-88221', location: 'DC1 - Rack A12', owner_id: agent1Id, support_group: 'Infrastructure Support', cpu: '2x Xeon Silver 4210 (20 cores)', ram: '128 GB', disk: '2 TB SSD RAID10', purchase_date: '2022-03-15', warranty_expiry: '2027-03-15', install_date: '2022-04-01', notes: 'Primary production web server (nginx + app tier).' },
    { name: 'PRD-WEB-02', ci_type: 'server', environment: 'production', status: 'in_use', ip_address: '10.10.1.12', os: 'Ubuntu 22.04 LTS', manufacturer: 'Dell', model: 'PowerEdge R740', serial_number: 'DL740-88222', location: 'DC1 - Rack A12', owner_id: agent1Id, support_group: 'Infrastructure Support', cpu: '2x Xeon Silver 4210 (20 cores)', ram: '128 GB', disk: '2 TB SSD RAID10', purchase_date: '2022-03-15', warranty_expiry: '2027-03-15', install_date: '2022-04-01', notes: 'Secondary/failover production web server, load-balanced with PRD-WEB-01.' },
    { name: 'PRD-DB-01', ci_type: 'database', environment: 'production', status: 'in_use', ip_address: '10.10.2.21', os: 'RHEL 9', manufacturer: 'HPE', model: 'ProLiant DL380 Gen10', serial_number: 'HPE380-55110', location: 'DC1 - Rack B04', owner_id: agent2Id, support_group: 'Database Team', cpu: '2x Xeon Gold 6248 (40 cores)', ram: '256 GB', disk: '8 TB NVMe RAID10', purchase_date: '2021-11-01', warranty_expiry: '2026-11-01', install_date: '2021-12-05', notes: 'PostgreSQL 15 primary cluster node. Hosts core ERP database.' },
    { name: 'PRD-DB-02-REPLICA', ci_type: 'database', environment: 'production', status: 'in_use', ip_address: '10.10.2.22', os: 'RHEL 9', manufacturer: 'HPE', model: 'ProLiant DL380 Gen10', serial_number: 'HPE380-55111', location: 'DC2 - Rack B04', owner_id: agent2Id, support_group: 'Database Team', cpu: '2x Xeon Gold 6248 (40 cores)', ram: '256 GB', disk: '8 TB NVMe RAID10', purchase_date: '2021-11-01', warranty_expiry: '2026-11-01', install_date: '2021-12-05', notes: 'Streaming replica for DR failover.' },
    { name: 'CORE-SW-01', ci_type: 'network_device', environment: 'production', status: 'in_use', ip_address: '10.10.0.1', os: 'Cisco IOS-XE 17.9', manufacturer: 'Cisco', model: 'Catalyst 9500', serial_number: 'CIS9500-33021', location: 'DC1 - Network Room', owner_id: agent2Id, support_group: 'Network Operations', cpu: '-', ram: '-', disk: '-', purchase_date: '2020-06-10', warranty_expiry: '2025-06-10', install_date: '2020-07-01', notes: 'Core distribution switch for DC1.' },
    { name: 'EDGE-FW-01', ci_type: 'network_device', environment: 'production', status: 'in_use', ip_address: '10.10.0.254', os: 'PAN-OS 11.1', manufacturer: 'Palo Alto', model: 'PA-5220', serial_number: 'PA5220-77441', location: 'DC1 - Network Room', owner_id: agent2Id, support_group: 'Network Operations', cpu: '-', ram: '-', disk: '-', purchase_date: '2021-02-01', warranty_expiry: '2026-02-01', install_date: '2021-02-20', notes: 'Perimeter firewall / VPN concentrator.' },
    { name: 'ERP-APP', ci_type: 'application', environment: 'production', status: 'in_use', ip_address: null, os: null, manufacturer: 'In-house', model: 'v4.2', serial_number: null, location: 'PRD-WEB-01 / PRD-WEB-02', owner_id: adminId, support_group: 'Applications Team', cpu: null, ram: null, disk: null, purchase_date: null, warranty_expiry: null, install_date: '2022-04-10', notes: 'Company ERP application, runs on PRD-WEB cluster with PRD-DB-01 backend.' },
    { name: 'EMAIL-SVC', ci_type: 'application', environment: 'production', status: 'in_use', ip_address: null, os: null, manufacturer: 'Microsoft', model: 'Exchange Online', serial_number: null, location: 'Cloud (M365)', owner_id: adminId, support_group: 'Applications Team', cpu: null, ram: null, disk: null, purchase_date: null, warranty_expiry: null, install_date: '2019-01-01', notes: 'Corporate email via Microsoft 365 tenant.' },
    { name: 'BKUP-NAS-01', ci_type: 'storage', environment: 'production', status: 'in_use', ip_address: '10.10.3.30', os: 'Synology DSM 7', manufacturer: 'Synology', model: 'RS4021xs+', serial_number: 'SYN4021-99871', location: 'DC1 - Rack C02', owner_id: agent1Id, support_group: 'Infrastructure Support', cpu: '-', ram: '64 GB', disk: '48 TB (RAID6)', purchase_date: '2023-01-20', warranty_expiry: '2028-01-20', install_date: '2023-02-01', notes: 'Nightly backup target for all production servers.' },
    { name: 'WKS-FIN-014', ci_type: 'workstation', environment: 'production', status: 'in_use', ip_address: '10.20.4.14', os: 'Windows 11 Pro', manufacturer: 'Lenovo', model: 'ThinkCentre M90t', serial_number: 'LEN90T-40021', location: 'HQ 3F - Finance', owner_id: user1Id, support_group: 'Desktop Support', cpu: 'Intel i7-12700', ram: '16 GB', disk: '512 GB SSD', purchase_date: '2023-05-01', warranty_expiry: '2026-05-01', install_date: '2023-05-10', notes: "Maria Chen's primary workstation." },
    { name: 'WKS-SALES-022', ci_type: 'workstation', environment: 'production', status: 'in_use', ip_address: '10.20.5.22', os: 'Windows 11 Pro', manufacturer: 'Lenovo', model: 'ThinkCentre M90t', serial_number: 'LEN90T-40022', location: 'HQ 2F - Sales', owner_id: user2Id, support_group: 'Desktop Support', cpu: 'Intel i7-12700', ram: '16 GB', disk: '512 GB SSD', purchase_date: '2023-05-01', warranty_expiry: '2026-05-01', install_date: '2023-05-10', notes: "Raj Patel's primary workstation." },
    { name: 'SPARE-SRV-09', ci_type: 'server', environment: 'development', status: 'in_stock', ip_address: null, os: null, manufacturer: 'Dell', model: 'PowerEdge R640', serial_number: 'DL640-11009', location: 'DC1 - Storage Room', owner_id: agent1Id, support_group: 'Infrastructure Support', cpu: '2x Xeon Silver 4114', ram: '64 GB', disk: '1 TB SSD', purchase_date: '2020-08-01', warranty_expiry: '2025-08-01', install_date: null, notes: 'Unallocated spare, in stock for redeployment.' }
  ];

  const ciIds = {};
  for (const ci of ciSeed) {
    const ci_number = await nextNumber('ci', 'CI');
    const info = await insertCi.run({ ci_number, created_by: adminId, ...ci });
    ciIds[ci.name] = info.lastInsertRowid;
  }

  const insertRel = db.prepare(`
    INSERT INTO ci_relationships (parent_ci_id, child_ci_id, relationship_type) VALUES (?, ?, ?)
  `);
  await insertRel.run(ciIds['ERP-APP'], ciIds['PRD-WEB-01'], 'runs_on');
  await insertRel.run(ciIds['ERP-APP'], ciIds['PRD-WEB-02'], 'runs_on');
  await insertRel.run(ciIds['ERP-APP'], ciIds['PRD-DB-01'], 'depends_on');
  await insertRel.run(ciIds['PRD-DB-02-REPLICA'], ciIds['PRD-DB-01'], 'depends_on');
  await insertRel.run(ciIds['PRD-WEB-01'], ciIds['CORE-SW-01'], 'connects_to');
  await insertRel.run(ciIds['PRD-WEB-02'], ciIds['CORE-SW-01'], 'connects_to');
  await insertRel.run(ciIds['CORE-SW-01'], ciIds['EDGE-FW-01'], 'connects_to');
  await insertRel.run(ciIds['BKUP-NAS-01'], ciIds['PRD-DB-01'], 'connects_to');

  function priorityFrom(impact, urgency) {
    const score = impact + urgency;
    if (score <= 2) return 1;
    if (score === 3) return 2;
    if (score === 4) return 3;
    return 4;
  }

  const insertIncident = db.prepare(`
    INSERT INTO incidents (number, short_description, description, category, subcategory, impact, urgency, priority,
      status, caller_id, assigned_to, assignment_group, affected_ci_id, resolution_notes, resolved_at, closed_at, created_at, sla_due_at)
    VALUES (@number, @short_description, @description, @category, @subcategory, @impact, @urgency, @priority,
      @status, @caller_id, @assigned_to, @assignment_group, @affected_ci_id, @resolution_notes, @resolved_at, @closed_at, @created_at, @sla_due_at)
    RETURNING id
  `);

  const SLA_HOURS = { 1: 4, 2: 8, 3: 24, 4: 72 };

  const incidentSeed = [
    { short_description: 'Production web servers responding slowly', description: 'Users report the ERP app is taking 10-15s to load pages during peak hours.', category: 'software', subcategory: 'performance', impact: 1, urgency: 1, status: 'in_progress', caller_id: user1Id, assigned_to: agent1Id, assignment_group: 'Infrastructure Support', affected_ci_id: ciIds['PRD-WEB-01'], created_at: offsetStr(-2) },
    { short_description: 'Cannot connect to VPN from home', description: 'User unable to establish VPN tunnel since this morning, gets timeout error.', category: 'network', subcategory: 'vpn', impact: 3, urgency: 2, status: 'new', caller_id: user2Id, assigned_to: null, assignment_group: 'Network Operations', affected_ci_id: ciIds['EDGE-FW-01'], created_at: offsetStr(-1) },
    { short_description: 'Database replication lag on PRD-DB-02', description: 'Monitoring alert fired for replication lag exceeding 5 minutes on the DR replica.', category: 'software', subcategory: 'database', impact: 2, urgency: 1, status: 'resolved', caller_id: agent2Id, assigned_to: agent2Id, assignment_group: 'Database Team', affected_ci_id: ciIds['PRD-DB-02-REPLICA'], resolution_notes: 'Restarted replication stream after clearing a network blip; lag recovered to <1s.', resolved_at: offsetStr(0, -3), created_at: offsetStr(-1) },
    { short_description: "Workstation won't boot", description: "Maria Chen's workstation shows a blue screen on startup.", category: 'hardware', subcategory: 'workstation', impact: 3, urgency: 3, status: 'closed', caller_id: user1Id, assigned_to: agent1Id, assignment_group: 'Desktop Support', affected_ci_id: ciIds['WKS-FIN-014'], resolution_notes: 'Reseated RAM module and ran disk check; issue resolved.', resolved_at: offsetStr(-5), closed_at: offsetStr(-4), created_at: offsetStr(-6) },
    { short_description: 'Email delivery delayed to external domains', description: 'Outbound email to some external domains is delayed by 30+ minutes.', category: 'software', subcategory: 'email', impact: 2, urgency: 2, status: 'new', caller_id: user2Id, assigned_to: null, assignment_group: 'Applications Team', affected_ci_id: ciIds['EMAIL-SVC'], created_at: offsetStr(0, -4) },
    { short_description: 'Backup job failed on BKUP-NAS-01', description: "Last night's backup job for PRD-DB-01 failed with a storage quota error.", category: 'hardware', subcategory: 'storage', impact: 2, urgency: 2, status: 'in_progress', caller_id: agent1Id, assigned_to: agent1Id, assignment_group: 'Infrastructure Support', affected_ci_id: ciIds['BKUP-NAS-01'], created_at: offsetStr(0, -10) }
  ];

  const incidentIds = {};
  for (const inc of incidentSeed) {
    const priority = priorityFrom(inc.impact, inc.urgency);
    const number = await nextNumber('incident', 'INC');
    const created_at = inc.created_at || nowStr();
    const resolved_at = inc.resolved_at || null;
    const closed_at = inc.closed_at || null;
    const slaHours = SLA_HOURS[priority] || SLA_HOURS[4];
    const sla_due_at = addHoursStr(created_at, slaHours);
    const incInfo = await insertIncident.run({
      number,
      short_description: inc.short_description,
      description: inc.description || null,
      category: inc.category,
      subcategory: inc.subcategory || null,
      impact: inc.impact,
      urgency: inc.urgency,
      priority,
      status: inc.status,
      caller_id: inc.caller_id,
      assigned_to: inc.assigned_to,
      assignment_group: inc.assignment_group,
      affected_ci_id: inc.affected_ci_id || null,
      resolution_notes: inc.resolution_notes || null,
      resolved_at,
      closed_at,
      created_at,
      sla_due_at
    });
    incidentIds[inc.short_description] = incInfo.lastInsertRowid;
  }

  const insertProblem = db.prepare(`
    INSERT INTO problems (number, short_description, description, status, priority, root_cause, workaround,
      affected_ci_id, raised_by, assigned_to, created_at)
    VALUES (@number, @short_description, @description, @status, @priority, @root_cause, @workaround,
      @affected_ci_id, @raised_by, @assigned_to, @created_at)
    RETURNING id
  `);

  const problemSeed = [
    {
      short_description: 'Recurring performance degradation on PRD-WEB cluster',
      description: 'Multiple incidents reported over the past month for slow page loads during peak hours, all tracing back to the production web tier.',
      status: 'investigating', priority: 2, root_cause: null,
      workaround: 'Restart the nginx service on the affected node during peak hours to temporarily relieve memory pressure.',
      affected_ci_id: ciIds['PRD-WEB-01'], raised_by: agent1Id, assigned_to: agent1Id,
      created_at: offsetStr(-2), linkedIncident: 'Production web servers responding slowly'
    },
    {
      short_description: 'Intermittent replication lag on DR replica',
      description: 'Replication lag between PRD-DB-01 and its DR replica intermittently exceeds threshold under load.',
      status: 'known_error', priority: 3,
      root_cause: 'Network jitter on the inter-DC link causes the replication stream to stall under sustained write load.',
      workaround: 'Manually restart the replication stream when lag exceeds 5 minutes. Permanent fix requires a QoS policy change on the WAN link.',
      affected_ci_id: ciIds['PRD-DB-02-REPLICA'], raised_by: agent2Id, assigned_to: agent2Id,
      created_at: offsetStr(-1), linkedIncident: 'Database replication lag on PRD-DB-02'
    }
  ];

  for (const p of problemSeed) {
    const number = await nextNumber('problem', 'PRB');
    const info = await insertProblem.run({
      number,
      short_description: p.short_description,
      description: p.description,
      status: p.status,
      priority: p.priority,
      root_cause: p.root_cause || null,
      workaround: p.workaround || null,
      affected_ci_id: p.affected_ci_id || null,
      raised_by: p.raised_by,
      assigned_to: p.assigned_to,
      created_at: p.created_at
    });
    if (p.linkedIncident && incidentIds[p.linkedIncident]) {
      await db.prepare('UPDATE incidents SET problem_id = ? WHERE id = ?').run(info.lastInsertRowid, incidentIds[p.linkedIncident]);
    }
  }

  const insertChange = db.prepare(`
    INSERT INTO changes (number, short_description, description, change_type, risk, status, requested_by, assigned_to,
      affected_ci_id, planned_start, planned_end, implementation_plan, backout_plan, approval_status, approved_by, created_at)
    VALUES (@number, @short_description, @description, @change_type, @risk, @status, @requested_by, @assigned_to,
      @affected_ci_id, @planned_start, @planned_end, @implementation_plan, @backout_plan, @approval_status, @approved_by, @created_at)
    RETURNING id
  `);

  const changeSeed = [
    { short_description: 'Apply security patches to PRD-WEB cluster', description: 'Monthly OS security patching for PRD-WEB-01 and PRD-WEB-02, rolling restart.', change_type: 'standard', risk: 'low', status: 'scheduled', requested_by: agent1Id, assigned_to: agent1Id, affected_ci_id: ciIds['PRD-WEB-01'], planned_start: offsetStr(2, 22), planned_end: offsetStr(3, 1), implementation_plan: 'Patch PRD-WEB-02 first, verify health checks, then patch PRD-WEB-01.', backout_plan: 'Revert via snapshot if health checks fail post-patch.', approval_status: 'approved', approved_by: adminId },
    { short_description: 'Upgrade core switch firmware', description: 'Upgrade CORE-SW-01 to IOS-XE 17.12 to address a known vulnerability.', change_type: 'normal', risk: 'high', status: 'submitted', requested_by: agent2Id, assigned_to: agent2Id, affected_ci_id: ciIds['CORE-SW-01'], planned_start: offsetStr(5, 23), planned_end: offsetStr(6, 2), implementation_plan: 'Upgrade during maintenance window; failover traffic to secondary path during reboot.', backout_plan: 'Roll back firmware image from backup partition.', approval_status: 'pending', approved_by: null },
    { short_description: 'Expand PRD-DB-01 storage volume', description: 'Add 2TB to the primary database storage volume ahead of Q4 growth.', change_type: 'normal', risk: 'medium', status: 'implemented', requested_by: agent2Id, assigned_to: agent2Id, affected_ci_id: ciIds['PRD-DB-01'], planned_start: offsetStr(-3), planned_end: offsetStr(-3, 2), implementation_plan: 'Online volume expansion using LVM, no downtime expected.', backout_plan: 'Shrink not supported; restore from backup if corruption occurs.', approval_status: 'approved', approved_by: adminId, closed_at: offsetStr(-2) },
    { short_description: 'Emergency firewall rule change for active exploit', description: 'Block outbound traffic to known malicious IP ranges following threat intel alert.', change_type: 'emergency', risk: 'high', status: 'implemented', requested_by: adminId, assigned_to: agent2Id, affected_ci_id: ciIds['EDGE-FW-01'], planned_start: offsetStr(-1), planned_end: offsetStr(-1, 1), implementation_plan: 'Apply emergency ACL via CLI, verified with security team.', backout_plan: 'Remove ACL entries if legitimate traffic is blocked.', approval_status: 'approved', approved_by: adminId, closed_at: offsetStr(0, -20) },
    { short_description: 'Deploy ERP application v4.3', description: 'Roll out ERP application update with reporting module fixes.', change_type: 'normal', risk: 'medium', status: 'draft', requested_by: adminId, assigned_to: agent1Id, affected_ci_id: ciIds['ERP-APP'], planned_start: offsetStr(10), planned_end: offsetStr(10, 3), implementation_plan: 'Blue-green deploy to PRD-WEB-02 first, then PRD-WEB-01.', backout_plan: 'Revert to v4.2 container image.', approval_status: 'pending', approved_by: null }
  ];

  for (const ch of changeSeed) {
    const number = await nextNumber('change', 'CHG');
    const info = await insertChange.run({
      number,
      short_description: ch.short_description,
      description: ch.description || null,
      change_type: ch.change_type,
      risk: ch.risk,
      status: ch.status,
      requested_by: ch.requested_by,
      assigned_to: ch.assigned_to,
      affected_ci_id: ch.affected_ci_id || null,
      planned_start: ch.planned_start || null,
      planned_end: ch.planned_end || null,
      implementation_plan: ch.implementation_plan || null,
      backout_plan: ch.backout_plan || null,
      approval_status: ch.approval_status,
      approved_by: ch.approved_by || null,
      created_at: nowStr()
    });
    if (ch.closed_at) {
      await db.prepare('UPDATE changes SET closed_at = ? WHERE id = ?').run(ch.closed_at, info.lastInsertRowid);
    }
  }

  const insertCatalogItem = db.prepare(`
    INSERT INTO catalog_items (name, description, category, icon, fulfillment_group)
    VALUES (@name, @description, @category, @icon, @fulfillment_group)
    RETURNING id
  `);
  const catalogSeed = [
    { name: 'New Laptop', description: 'Request a new company laptop for a new starter or a hardware refresh.', category: 'hardware', icon: 'bi-laptop', fulfillment_group: 'Desktop Support' },
    { name: 'Software License', description: 'Request a license for approved business software (e.g. Adobe, Visio, project tools).', category: 'software', icon: 'bi-file-earmark-code', fulfillment_group: 'Applications Team' },
    { name: 'VPN Access', description: 'Request remote VPN access for working outside the office.', category: 'access', icon: 'bi-shield-lock', fulfillment_group: 'Network Operations' },
    { name: 'New Starter Setup', description: 'Full onboarding request: accounts, hardware, and access for a new employee.', category: 'access', icon: 'bi-person-plus', fulfillment_group: 'Service Desk' },
    { name: 'Mobile Phone', description: 'Request a company mobile phone and line.', category: 'hardware', icon: 'bi-phone', fulfillment_group: 'Desktop Support' },
    { name: 'Distribution List Change', description: 'Add or remove members from an email distribution list.', category: 'software', icon: 'bi-envelope-plus', fulfillment_group: 'Applications Team' }
  ];
  const catalogIds = {};
  for (const item of catalogSeed) {
    const info = await insertCatalogItem.run(item);
    catalogIds[item.name] = info.lastInsertRowid;
  }

  const insertRequest = db.prepare(`
    INSERT INTO service_requests (number, catalog_item_id, requested_by, notes, status, assigned_to, created_at, fulfilled_at)
    VALUES (@number, @catalog_item_id, @requested_by, @notes, @status, @assigned_to, @created_at, @fulfilled_at)
    RETURNING id
  `);
  const requestSeed = [
    { catalog_item_id: catalogIds['New Laptop'], requested_by: user2Id, notes: 'My current laptop battery no longer holds a charge.', status: 'in_progress', assigned_to: agent1Id, created_at: offsetStr(-2), fulfilled_at: null },
    { catalog_item_id: catalogIds['VPN Access'], requested_by: user1Id, notes: 'Need to work from home two days a week.', status: 'fulfilled', assigned_to: agent2Id, created_at: offsetStr(-6), fulfilled_at: offsetStr(-5) },
    { catalog_item_id: catalogIds['Software License'], requested_by: user2Id, notes: 'Need a Visio license for network diagrams.', status: 'submitted', assigned_to: null, created_at: offsetStr(0, -3), fulfilled_at: null }
  ];
  for (const r of requestSeed) {
    const number = await nextNumber('request', 'REQ');
    await insertRequest.run({
      number,
      catalog_item_id: r.catalog_item_id,
      requested_by: r.requested_by,
      notes: r.notes,
      status: r.status,
      assigned_to: r.assigned_to,
      created_at: r.created_at,
      fulfilled_at: r.fulfilled_at || null
    });
  }

  const insertKb = db.prepare(`
    INSERT INTO kb_articles (number, title, category, body, status, author_id)
    VALUES (@number, @title, @category, @body, 'published', @author_id)
    RETURNING id
  `);
  const kbSeed = [
    {
      title: 'How to reset your VPN connection',
      category: 'network',
      author_id: agent2Id,
      body: 'If your VPN client fails to connect or drops frequently:\n\n1. Disconnect and fully quit the VPN client (check the system tray/menu bar, not just the window).\n2. Restart your computer\'s network adapter — on Windows, disable then re-enable the adapter; on Mac, toggle Wi-Fi off and on.\n3. Relaunch the VPN client and sign in again.\n4. If it still fails, confirm your account has active VPN Access (Service Catalog > VPN Access) — access can lapse after long inactivity.\n\nIf the issue persists after these steps, log an incident with the exact error message shown by the client.'
    },
    {
      title: 'Fixing slow performance on PRD-WEB servers',
      category: 'infrastructure',
      author_id: agent1Id,
      body: 'The production web tier (PRD-WEB-01 / PRD-WEB-02) is a known source of intermittent slowness during peak hours — see Problem PRB0000001.\n\nWorkaround while the root cause is investigated:\n1. Check current load: SSH in and run the standard monitoring dashboard.\n2. If memory pressure is high, restart the nginx service on the affected node only (never both at once — this is a load-balanced pair).\n3. Confirm the other node is healthy before restarting either.\n4. Note the restart in the incident\'s work notes with a timestamp, and link the incident to PRB0000001 if it isn\'t already.\n\nThis is a mitigation, not a fix — a permanent resolution is still pending the problem investigation.'
    },
    {
      title: 'Requesting software you don\'t see in the catalog',
      category: 'general',
      author_id: adminId,
      body: 'The Service Catalog covers commonly requested items. If the software or hardware you need isn\'t listed:\n\n1. Log an incident instead, categorized as "Software" or "Hardware".\n2. Include the specific product name, version, and business justification.\n3. The Applications Team will evaluate the request and, if approved, may add it to the catalog for future requests.\n\nLicensed software always requires manager approval before procurement — include your manager on the incident as a watcher if your process requires it.'
    },
    {
      title: 'Understanding incident priority (P1–P4)',
      category: 'general',
      author_id: adminId,
      body: 'Incident priority is calculated automatically from Impact x Urgency, not set directly:\n\n- P1 (Critical): High impact + high urgency. Production down, many users affected. Target resolution: 4 hours.\n- P2 (High): Significant impact or urgency. Target resolution: 8 hours.\n- P3 (Moderate): Limited impact, most common priority. Target resolution: 24 hours.\n- P4 (Low): Minor issue, single user, workaround available. Target resolution: 72 hours.\n\nIf you believe an incident is mis-prioritized, don\'t edit the priority directly — adjust the Impact/Urgency fields to reflect reality, and the priority will recalculate.'
    }
  ];
  for (const kb of kbSeed) {
    const number = await nextNumber('kb', 'KB');
    await insertKb.run({ number, title: kb.title, category: kb.category, body: kb.body, author_id: kb.author_id });
  }
}

async function initDb() {
  await initSchema();
  await seedIfEmpty();
}

module.exports = { db, nextNumber, logActivity, initDb, nowStr, offsetStr, offsetDateStr, addHoursStr };
