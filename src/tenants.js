// The tenants (organisations) of this installation: which one a request is for, a job that runs once for each, and making a
// new one. The mechanism that keeps their data apart is in src/tenancy.js, src/db.js and migration 0015.
//
// Which tenant a request is for, in this order:
//   1. a host name listed in tenant_hosts (the address in the browser),
//   2. <slug>.TENANT_BASE_DOMAIN when TENANT_BASE_DOMAIN is set (helpdesk.example.com: acme.helpdesk.example.com is "acme"),
//   3. anything else: the default tenant (TENANT_UNKNOWN_HOST=default, the way a single-organisation install and the lab work)
//      or a refusal (TENANT_UNKNOWN_HOST=reject, for an installation that serves several organisations).
// API keys and SCIM tokens belong to a tenant themselves and need no host name.
'use strict';
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { checkPassword } = require('./passwords');
const { db, nowStr } = require('./db');
const tenancy = require('./tenancy');

const DEFAULT_ID = 1;
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9]){0,1}$/;
const HOST_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9]){0,1}$/;
const RESERVED = new Set(['www', 'api', 'admin', 'platform', 'app', 'mail', 'static', 'assets', 'health']);
class TenantError extends Error {}

const unknownPolicy = (env = process.env) => {
  const v = String(env.TENANT_UNKNOWN_HOST || 'default').trim().toLowerCase();
  if (!['default', 'reject'].includes(v)) throw new Error('TENANT_UNKNOWN_HOST must be default or reject.');
  return v;
};
const baseDomain = (env = process.env) => String(env.TENANT_BASE_DOMAIN || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');

// ---- the list of tenants, kept for a few seconds
let cache = null;
const TTL_MS = 5000;
const invalidate = () => { cache = null; };
async function load() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  const tenants = await tenancy.runPlatform(() => db.prepare('SELECT id, slug, name, status, created_at, status_changed_at, export_at, export_sha256, export_bytes, export_by, deletion_scheduled_at, deletion_requested_by, limit_users, limit_records, limit_storage_mb FROM tenants ORDER BY id').all());
  const hosts = await tenancy.runPlatform(() => db.prepare('SELECT host, tenant_id FROM tenant_hosts').all());
  const byId = new Map(tenants.map((t) => [t.id, t]));
  cache = { at: Date.now(), tenants, byId, bySlug: new Map(tenants.map((t) => [t.slug, t])), byHost: new Map(hosts.map((h) => [h.host, byId.get(h.tenant_id)])) };
  return cache;
}
const list = async () => (await load()).tenants;
const get = async (id) => (await load()).byId.get(Number(id)) || null;

const hostOf = (req) => String(req.hostname || '').toLowerCase().replace(/\.$/, '');
async function forHost(host, env = process.env) {
  const c = await load();
  let t = c.byHost.get(host);
  const base = baseDomain(env);
  if (!t && base && host.endsWith(`.${base}`)) {
    const slug = host.slice(0, -(base.length + 1));
    if (!slug.includes('.')) t = c.bySlug.get(slug);
  }
  if (!t && unknownPolicy(env) === 'default') t = c.byId.get(DEFAULT_ID);
  return t || null;
}

// ---- in a request
// Enters the tenant of the request for everything that follows. Must come after the body parsers (a context entered before
// them is lost when they hand over), so routes that run before them use pinned() or enter the tenant themselves.
function scope(env = process.env) {
  return async (req, res, next) => {
    if (req.tenantPinned) return next();
    try {
      const t = await forHost(hostOf(req), env);
      if (!t) return res.status(404).render('error', { title: 'Unknown workspace', message: 'There is no workspace at this address.' });
      if (t.status !== 'active') return res.status(503).render('error', { title: 'Workspace suspended', message: 'This workspace is suspended. Ask the people who run it.' });
      req.tenant = t; res.locals.tenant = t;
      tenancy.run(t.id, next);
    } catch (err) { next(err); }
  };
}
// For parts of the application that belong to the default tenant alone (the NovaConnect integration, mail handed over by HTTP).
const pinned = (id = DEFAULT_ID) => (req, res, next) => { req.tenantPinned = true; req.tenant = { id }; tenancy.run(id, next); };
// After a router has found the tenant by itself (an API key says which tenant it belongs to) and its body parser has run.
const enterRequestTenant = () => (req, res, next) => (req.tenantId ? tenancy.run(req.tenantId, next) : next());

// Is this tenant allowed to use the API and SCIM right now? (a suspended workspace is closed to them too)
async function isActive(id) { const t = await get(id); return Boolean(t && t.status === 'active'); }

// ---- background jobs
// Runs fn(tenant) once for every active tenant, one after the other, each inside its own tenant. One tenant failing never stops the rest.
async function forEachTenant(fn, label = 'job') {
  const c = await load();
  for (const t of c.tenants) {
    if (t.status !== 'active') continue;
    try { await tenancy.run(t.id, () => fn(t)); } catch (err) { console.error(`[Tenant ${t.slug}] ${label} failed: ${err.message}`); }
  }
}

// ---- making and changing tenants
function checkSlug(slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (!SLUG_RE.test(s)) throw new TenantError('The short name must be 1 to 40 letters, digits or hyphens, starting and ending with a letter or digit.');
  if (RESERVED.has(s)) throw new TenantError(`"${s}" is kept for the system; choose another short name.`);
  return s;
}
function checkHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  if (!HOST_RE.test(h) || h.includes('..') || /^\d+\.\d+\.\d+\.\d+$/.test(h)) throw new TenantError(`"${host}" is not a host name (for example help.acme.example).`);
  return h;
}

// The settings every tenant starts with: the same as a fresh installation (see migrations 0002, 0003, 0012, 0014).
async function seedDefaults() {
  await db.prepare('INSERT INTO branding_settings DEFAULT VALUES').run();
  await db.prepare('INSERT INTO scim_settings DEFAULT VALUES').run();
  await db.prepare('INSERT INTO sso_settings DEFAULT VALUES').run();
  await db.prepare('INSERT INTO mail_settings DEFAULT VALUES').run();
  await db.prepare('INSERT INTO inbound_settings DEFAULT VALUES').run();
  await db.prepare("INSERT INTO business_calendars (name, is_default) VALUES ('Business hours', 1)").run();
  await db.prepare(`INSERT INTO sla_policies (applies_to, priority, target_minutes, clock, warn_percent, active) VALUES
    ('incident', 1, 240, 'calendar', 75, 1), ('incident', 2, 480, 'calendar', 75, 1), ('incident', 3, 1440, 'calendar', 75, 1), ('incident', 4, 4320, 'calendar', 75, 1),
    ('request', 0, 4320, 'calendar', 75, 0), ('change', 0, 2880, 'calendar', 75, 0)`).run();
}

// Creates a tenant with its settings and, when given, its host names. Returns the tenant. Nothing else (no people) exists in it yet.
async function createTenant({ slug, name, hosts = [] }) {
  const s = checkSlug(slug);
  const label = String(name || '').replace(/\s+/g, ' ').trim();
  if (!label || [...label].length > 80) throw new TenantError('The name must be 1 to 80 characters.');
  const hs = [...new Set(hosts.map(checkHost))];
  const tenant = await tenancy.runPlatform(async () => {
    if (await db.prepare('SELECT 1 AS x FROM tenants WHERE slug = ?').get(s)) throw new TenantError(`There is already a tenant with the short name "${s}".`);
    for (const h of hs) if (await db.prepare('SELECT 1 AS x FROM tenant_hosts WHERE host = ?').get(h)) throw new TenantError(`The host name ${h} already belongs to a tenant.`);
    const row = await db.prepare('INSERT INTO tenants (slug, name) VALUES (?, ?) RETURNING id, slug, name, status, created_at').get(s, label);
    for (const h of hs) await db.prepare('INSERT INTO tenant_hosts (host, tenant_id) VALUES (?, ?)').run(h, row.id);
    return row;
  });
  await tenancy.run(tenant.id, seedDefaults);
  invalidate();
  return tenant;
}

// The first administrator of a tenant. The password follows the same rules as everyone's. Returns the new user's id.
async function createAdmin(tenantId, { username, password, fullName, email }) {
  const name = String(username || '').trim();
  if (!/^[A-Za-z0-9._-]{2,40}$/.test(name)) throw new TenantError('The username must be 2 to 40 letters, digits, dots, hyphens or underscores.');
  const weak = checkPassword(password || '', { username: name, email, fullName });
  if (weak) throw new TenantError(weak);
  return tenancy.run(tenantId, async () => {
    if (await db.prepare('SELECT 1 AS x FROM users WHERE username = ?').get(name)) throw new TenantError(`There is already a person called "${name}" in this tenant.`);
    const row = await db.prepare("INSERT INTO users (username, password_hash, full_name, email, role) VALUES (?, ?, ?, ?, 'admin') RETURNING id")
      .get(name, bcrypt.hashSync(password, 10), String(fullName || name).trim(), email ? String(email).trim() : null);
    // As on a fresh installation: the first administrator may approve decommissions until someone else is put in the group.
    await db.prepare(`INSERT INTO user_assignment_groups (user_id, group_name)
      SELECT ?, 'IRO-Build/Decom' WHERE NOT EXISTS (SELECT 1 FROM user_assignment_groups WHERE group_name = 'IRO-Build/Decom')`).run(row.id);
    return row.id;
  });
}

const cleanName = (name) => {
  const label = String(name || '').replace(/\s+/g, ' ').trim();
  if (!label || [...label].length > 80) throw new TenantError('The name must be 1 to 80 characters.');
  return label;
};
async function rename(id, name) {
  const label = cleanName(name);
  await tenancy.runPlatform(() => db.prepare('UPDATE tenants SET name = ? WHERE id = ?').run(label, Number(id)));
  invalidate();
  return label;
}
async function addHost(id, host) {
  const h = checkHost(host);
  await tenancy.runPlatform(async () => {
    if (await db.prepare('SELECT 1 AS x FROM tenant_hosts WHERE host = ?').get(h)) throw new TenantError(`The host name ${h} already belongs to a tenant.`);
    await db.prepare('INSERT INTO tenant_hosts (host, tenant_id) VALUES (?, ?)').run(h, Number(id));
  });
  invalidate();
  return h;
}
async function removeHost(id, host) {
  const h = String(host || '').trim().toLowerCase();
  const done = await tenancy.runPlatform(() => db.prepare('DELETE FROM tenant_hosts WHERE host = ? AND tenant_id = ?').run(h, Number(id)));
  invalidate();
  return done.changes === 1;
}
// The administrators of a tenant (names only), for the console.
const adminsOf = (id) => tenancy.run(id, () => db.prepare("SELECT username, full_name, email, active FROM users WHERE role = 'admin' ORDER BY id").all());

// Support: a new password for one of a tenant's administrators who is locked out. It ends that person's sessions and clears a lock,
// and the tenant's own audit log says that the platform did it.
async function resetAdminPassword(tenantId, username, password, operatorName) {
  const name = String(username || '').trim();
  const weak = checkPassword(password || '', { username: name });
  if (weak) throw new TenantError(weak);
  return tenancy.run(tenantId, async () => {
    const user = await db.prepare("SELECT id, username, full_name, email FROM users WHERE username = ? AND role = 'admin'").get(name);
    if (!user) throw new TenantError(`This tenant has no administrator called "${name}".`);
    const w = checkPassword(password, { username: user.username, email: user.email, fullName: user.full_name });
    if (w) throw new TenantError(w);
    await db.prepare('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').run(bcrypt.hashSync(password, 10), user.id);
    const ended = (await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id)).changes;
    await db.prepare("INSERT INTO audit_log (actor_id, actor_name, action, target_type, target_id, target_name, detail) VALUES (NULL, ?, 'platform.password_reset', 'user', ?, ?, ?)")
      .run(`Platform operator ${operatorName || ''}`.trim(), user.id, user.username, `password set by the people who run this installation; ${ended} open session${ended === 1 ? '' : 's'} ended`);
    return user;
  });
}

async function setStatus(id, status) {
  if (Number(id) === DEFAULT_ID && status !== 'active') throw new TenantError('The default tenant cannot be suspended.');
  if (!['active', 'suspended'].includes(status)) throw new TenantError('Status must be active or suspended.');
  const t = await get(id);
  if (t && t.status === 'pending_deletion') throw new TenantError('This tenant is waiting to be deleted: call the deletion off first.');
  await tenancy.runPlatform(() => db.prepare('UPDATE tenants SET status = ?, status_changed_at = ? WHERE id = ?').run(status, nowStr(), Number(id)));
  invalidate();
}

// The limits of a tenant (src/limits.js): people, stored records, megabytes of attached files; null = no limit. Lowering one below what is used
// deletes nothing, it only stops new things.
async function setLimits(id, { users = null, records = null, storageMb = null }) {
  await tenancy.runPlatform(() => db.prepare('UPDATE tenants SET limit_users = ?, limit_records = ?, limit_storage_mb = ? WHERE id = ?').run(users, records, storageMb, Number(id)));
  invalidate();
}

// ---- leaving the service: export, then delete (src/tenantExport.js; the platform console asks for each step)
const graceDays = (env = process.env) => {
  const raw = env.TENANT_DELETE_GRACE_DAYS;
  if (raw === undefined || String(raw).trim() === '') return 7;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 365) throw new Error('TENANT_DELETE_GRACE_DAYS must be a whole number of days from 0 to 365.');
  return n;
};
async function recordExport(id, { sha256, bytes }, operatorName) {
  await tenancy.runPlatform(() => db.prepare('UPDATE tenants SET export_at = ?, export_sha256 = ?, export_bytes = ?, export_by = ? WHERE id = ?').run(nowStr(), sha256, bytes, operatorName, Number(id)));
  invalidate();
}
// What stands between this tenant and deletion, as a sentence, or null when it may be scheduled.
async function deletionBlocker(id) {
  const t = await get(id);
  if (!t) return 'There is no such tenant.';
  if (Number(id) === DEFAULT_ID) return 'The default tenant cannot be deleted.';
  if (t.status === 'pending_deletion') return 'Deletion is already scheduled.';
  if (t.status !== 'suspended') return 'Suspend the tenant first: its people must stop changing things before the final export.';
  if (!t.export_at || !t.status_changed_at || t.export_at <= t.status_changed_at) return 'Make a final export first: one made after the tenant was suspended.';
  return null;
}
async function scheduleDeletion(id, operatorName, env = process.env) {
  const blocker = await deletionBlocker(id);
  if (blocker) throw new TenantError(blocker);
  const days = graceDays(env);
  const when = new Date(Date.now() + days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  await tenancy.runPlatform(() => db.prepare("UPDATE tenants SET status = 'pending_deletion', deletion_scheduled_at = ?, deletion_requested_by = ? WHERE id = ? AND status = 'suspended'").run(when, operatorName, Number(id)));
  invalidate();
  return { when, days };
}
async function cancelDeletion(id) {
  const t = await get(id);
  if (!t || t.status !== 'pending_deletion') throw new TenantError('Deletion is not scheduled for this tenant.');
  await tenancy.runPlatform(() => db.prepare("UPDATE tenants SET status = 'suspended', deletion_scheduled_at = NULL, deletion_requested_by = NULL WHERE id = ? AND status = 'pending_deletion'").run(Number(id)));
  invalidate();
}

// The tables that hold a tenant's data, in the order rows can be removed: a table only after every table that points at it.
async function purgeOrder(tx) {
  const tables = (await tx.prepare("SELECT relname AS t FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relkind = 'r' AND relrowsecurity").all()).map((r) => r.t);
  const fks = await tx.prepare("SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent FROM pg_constraint c WHERE c.contype = 'f' AND c.confdeltype IN ('a', 'r') AND c.conrelid <> c.confrelid").all();
  const kids = new Map(tables.map((t) => [t, new Set()]));
  for (const f of fks) if (kids.has(f.child) && kids.has(f.parent)) kids.get(f.parent).add(f.child);
  const left = new Set(tables); const order = [];
  while (left.size) {
    const ready = [...left].filter((t) => [...kids.get(t)].every((k) => !left.has(k)));
    if (!ready.length) throw new Error(`cannot order the tables for deletion (a cycle): ${[...left].join(', ')}`);
    for (const t of ready.sort()) { order.push(t); left.delete(t); }
  }
  return order;
}

// Removes a tenant and everything it owns: its rows (all or nothing, and checked to be gone), its hosts, its attached files. Only a tenant whose
// scheduled time has come (or `due` is false, for tests and tools) and never the default tenant. Returns what was removed.
async function purge(id, { due = true } = {}) {
  const t = await get(id);
  if (!t) throw new TenantError('There is no such tenant.');
  if (Number(id) === DEFAULT_ID) throw new TenantError('The default tenant cannot be deleted.');
  if (t.status !== 'pending_deletion') throw new TenantError('Deletion has not been scheduled for this tenant.');
  if (due && t.deletion_scheduled_at > nowStr()) throw new TenantError(`Deletion is scheduled for ${t.deletion_scheduled_at} UTC.`);
  const files = await tenancy.run(Number(id), () => db.prepare('SELECT entity_type, filename FROM attachments').all());
  const counts = {};
  await tenancy.runPlatform(() => db.transaction(async (tx) => {
    const order = await purgeOrder(tx);
    for (let pass = 0; pass < 2; pass++) {       // twice: a delete trigger may leave something behind in a table already done
      for (const name of order) counts[name] = (counts[name] || 0) + (await tx.prepare(`DELETE FROM "${name}" WHERE tenant_id = ?`).run(Number(id))).changes;
    }
    for (const name of order) {
      const left = Number((await tx.prepare(`SELECT COUNT(*) AS c FROM "${name}" WHERE tenant_id = ?`).get(Number(id))).c);
      if (left) throw new Error(`${left} row${left === 1 ? '' : 's'} of the tenant remain in ${name}: nothing was deleted`);
    }
    await tx.prepare('DELETE FROM tenant_hosts WHERE tenant_id = ?').run(Number(id));
    await tx.prepare('DELETE FROM tenants WHERE id = ?').run(Number(id));
  }));
  invalidate();
  // The files go only after the rows are certainly gone (the other way round a failure would leave rows without their files).
  const root = require('./tenantExport').UPLOAD_ROOT; let removed = 0;
  for (const f of files) { try { fs.unlinkSync(path.join(root, String(f.entity_type), path.basename(String(f.filename)))); removed++; } catch { /* already gone */ } }
  return { rows: Object.values(counts).reduce((a, b) => a + b, 0), tables: Object.keys(counts).length, files: removed, slug: t.slug, name: t.name };
}
// Every tenant whose time has come. One that fails is reported and tried again next time; the others carry on.
async function purgeDue(onDone = () => {}) {
  const due = (await load()).tenants.filter((t) => t.status === 'pending_deletion' && t.deletion_scheduled_at <= nowStr());
  for (const t of due) {
    try { onDone(t, await purge(t.id)); } catch (err) { console.error(`[Tenant ${t.slug}] deletion failed: ${err.message}`); }
  }
  return due.length;
}

module.exports = {
  DEFAULT_ID, TenantError, unknownPolicy, baseDomain, list, get, forHost, scope, pinned, enterRequestTenant, isActive,
  forEachTenant, createTenant, createAdmin, setStatus, setLimits, graceDays, recordExport, deletionBlocker, scheduleDeletion, cancelDeletion, purge, purgeDue, purgeOrder, rename, addHost, removeHost, adminsOf, resetAdminPassword, cleanName, checkSlug, checkHost, invalidate, hostOf,
};
