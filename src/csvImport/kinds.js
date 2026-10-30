// What each kind of import (users, configuration items, knowledge articles) accepts and what it does with each row.
//
// Every kind has the same shape:
//   columns     the columns it understands: field, the name shown to people, other spellings accepted in a header, and
//               whether the column is needed ('always', or only to add a new record: 'new')
//   load()      reads what exists now, once per run
//   context()   per-run state built from that (who already exists, who has been seen in this file)
//   plan()      decides one row: add, update, unchanged, skip or error. It writes nothing, so a preview and the real run
//               decide in exactly the same way
//   apply()     carries out an add or an update
'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, nextNumber, nowStr } = require('../db');
const { checkPassword, hashPassword } = require('../passwords');
const { CI_TYPE_LABELS, CI_STATUS_LABELS, ENVIRONMENT_LABELS, ASSIGNMENT_GROUPS } = require('../helpers');
const cmdbActions = require('../cmdbActions');
const sessions = require('../sessionStore');
const { audit } = require('../audit');
const { headerKey } = require('./csv');

const lc = (s) => String(s || '').trim().toLowerCase();

// Matches a typed value to one of a set of options by key or by label, ignoring case, spaces and punctuation.
function optionPicker(labels, extra = {}) {
  const index = new Map();
  for (const [key, label] of Object.entries(labels)) { index.set(headerKey(key), key); index.set(headerKey(label), key); }
  for (const [key, words] of Object.entries(extra)) for (const w of words) index.set(headerKey(w), key);
  return (value) => index.get(headerKey(value)) || null;
}

function pickDate(value) {
  const m = /^(\d{4})[-/](\d{2})[-/](\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function pickBool(value) {
  const v = lc(value);
  if (['yes', 'y', 'true', '1', 'active', 'enabled', 'on'].includes(v)) return 1;
  if (['no', 'n', 'false', '0', 'inactive', 'disabled', 'off'].includes(v)) return 0;
  return null;
}

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const tooLong = (label, value, max) => (value.length > max ? `${label} is longer than ${max} characters` : null);

// ---------------------------------------------------------------------------------------------------------- users
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@+-]{1,63}$/;
const pickRole = optionPicker({ admin: 'Administrator', agent: 'Agent', user: 'User' }, { user: ['end user', 'requester', 'customer'] });
const pickGroup = optionPicker(Object.fromEntries(ASSIGNMENT_GROUPS.map((g) => [g, g])));

const users = {
  id: 'users',
  label: 'Users',
  noun: 'user',
  icon: 'bi-people',
  roles: ['admin'],
  maxRows: 1000,
  intro: 'People who sign in to NovaDesk. Passwords are not needed: anyone added without one signs in with single sign-on, or an administrator sets a password from the Users page.',
  columns: [
    { field: 'username', label: 'Username', required: 'always', aliases: ['username', 'user', 'login', 'loginname', 'userid', 'samaccountname'], help: 'Letters, digits and . _ - @ +, 2 to 64 characters. Matched without regard to capitals.', example: 'sam.lee' },
    { field: 'full_name', label: 'Full name', required: 'new', aliases: ['fullname', 'name', 'displayname'], help: 'Needed for a new user.', example: 'Sam Lee' },
    { field: 'email', label: 'Email', aliases: ['email', 'emailaddress', 'mail'], help: 'Replies to notices and mail to the help desk are matched on it, so each address can belong to one person.', example: 'sam.lee@example.com' },
    { field: 'role', label: 'Role', aliases: ['role'], help: 'admin, agent or user. A new user is a user when this is empty.', example: 'agent' },
    { field: 'department', label: 'Department', aliases: ['department', 'dept'], example: 'Infrastructure' },
    { field: 'groups', label: 'Assignment groups', aliases: ['groups', 'assignmentgroups', 'assignmentgroup', 'group'], help: `Any of ${ASSIGNMENT_GROUPS.join(', ')}, separated by ; or |.`, example: 'IRO-Windows;IRO-ServiceDesk' },
    { field: 'active', label: 'Active', aliases: ['active', 'enabled'], help: 'yes or no. A new user is active when this is empty.', example: 'yes' },
    { field: 'password', label: 'Password', aliases: ['password', 'initialpassword'], help: 'Optional, new users only, and must pass the password rules. A file with passwords in it should be deleted afterwards.', example: '', optionalInTemplate: true },
  ],
  ignoredHeaders: [],
  templateRows: [
    ['sam.lee', 'Sam Lee', 'sam.lee@example.com', 'agent', 'Infrastructure', 'IRO-Windows;IRO-ServiceDesk', 'yes', ''],
    ['pat.kim', 'Pat Kim', 'pat.kim@example.com', 'user', 'Finance', '', 'yes', ''],
  ],

  async load() {
    const rows = await db.prepare('SELECT id, username, full_name, email, role, department, active, anonymised_at FROM users').all();
    const groups = {};
    for (const g of await db.prepare('SELECT user_id, group_name FROM user_assignment_groups').all()) (groups[g.user_id] = groups[g.user_id] || []).push(g.group_name);
    return { rows, groups };
  },

  context({ rows, groups }, { actor }) {
    const byUsername = new Map(rows.map((u) => [lc(u.username), u]));
    const emailOwner = new Map();
    for (const u of rows) if (u.email) emailOwner.set(lc(u.email), u.username);
    return {
      actor, byUsername, emailOwner, groups,
      seen: new Map(),
      activeAdmins: new Set(rows.filter((u) => u.role === 'admin' && u.active).map((u) => u.id)),
    };
  },

  plan(v, ctx, row, { mode }) {
    const key = v.username;
    if (!v.username) return { action: 'error', key, message: 'Username is empty.' };
    if (!USERNAME_RE.test(v.username)) return { action: 'error', key, message: 'Username can only hold letters, digits and . _ - @ + (2 to 64 characters, starting with a letter or digit).' };
    const lower = lc(v.username);
    if (ctx.seen.has(lower)) return { action: 'error', key, message: `Same username as row ${ctx.seen.get(lower)}.` };
    ctx.seen.set(lower, row);

    const errors = [];
    let role; if (v.role) { role = pickRole(v.role); if (!role) errors.push(`Role "${v.role}" is not admin, agent or user`); }
    let active; if (v.active) { active = pickBool(v.active); if (active === null) errors.push(`Active "${v.active}" is not yes or no`); }
    if (v.email && (!EMAIL_RE.test(v.email) || v.email.length > 254)) errors.push(`"${v.email}" is not an email address`);
    for (const [label, value, max] of [['Full name', v.full_name, 200], ['Department', v.department, 200]]) { const e = tooLong(label, value, max); if (e) errors.push(e); }
    let groups; if (v.groups) {
      groups = [];
      const bad = [];
      for (const g of v.groups.split(/[;|]/).map((s) => s.trim()).filter(Boolean)) { const p = pickGroup(g); if (p) { if (!groups.includes(p)) groups.push(p); } else bad.push(g); }
      if (bad.length) errors.push(`Unknown assignment group${bad.length === 1 ? '' : 's'}: ${bad.join(', ')}`);
    }
    const existing = ctx.byUsername.get(lower);

    if (v.email && !errors.length) {
      const owner = ctx.emailOwner.get(lc(v.email));
      if (owner && lc(owner) !== lower) errors.push(`Email ${v.email} already belongs to ${owner}`);
    }

    if (existing) {
      if (mode !== 'update') return { action: 'skip', key, message: 'Already exists.' };
      if (existing.anonymised_at) return { action: 'error', key, message: 'This person was anonymised and can no longer be changed.' };
      if (v.password) errors.push('A password cannot be set for an existing user here (use the Users page)');
      const changes = {};
      if (v.full_name && v.full_name !== existing.full_name) changes.full_name = v.full_name;
      if (v.email && lc(v.email) !== lc(existing.email)) changes.email = v.email;
      if (v.department && v.department !== existing.department) changes.department = v.department;
      if (role && role !== existing.role) changes.role = role;
      if (active !== undefined && active !== null && active !== existing.active) changes.active = active;
      const had = (ctx.groups[existing.id] || []).slice().sort().join('|');
      const groupsChange = groups !== undefined && groups.slice().sort().join('|') !== had;

      if ((changes.role !== undefined || changes.active !== undefined) && existing.id === ctx.actor.id) errors.push('Your own role and active status cannot be changed by an import');
      const wasAdmin = existing.role === 'admin' && existing.active;
      const willBeAdmin = (changes.role || existing.role) === 'admin' && (changes.active === undefined ? existing.active : changes.active);
      if (!errors.length && wasAdmin && !willBeAdmin) {
        ctx.activeAdmins.delete(existing.id);
        if (!ctx.activeAdmins.size) { ctx.activeAdmins.add(existing.id); errors.push('That would leave NovaDesk without an active administrator'); }
      }
      if (errors.length) return { action: 'error', key, message: `${errors.join('. ')}.` };
      if (changes.email) ctx.emailOwner.set(lc(changes.email), existing.username);
      if (!Object.keys(changes).length && !groupsChange) return { action: 'unchanged', key, message: 'Nothing to change.' };
      return { action: 'update', key, message: `${[...Object.keys(changes).map((c) => c.replace('_', ' ')), ...(groupsChange ? ['assignment groups'] : [])].join(', ')}`, data: { existing, changes, groups: groupsChange ? groups : undefined } };
    }

    if (!v.full_name) errors.push('Full name is empty');
    if (v.password) { const weak = checkPassword(v.password, { username: v.username, email: v.email, fullName: v.full_name }); if (weak) errors.push(weak.replace(/\.$/, '')); }
    if (errors.length) return { action: 'error', key, message: `${errors.join('. ')}.` };
    if (v.email) ctx.emailOwner.set(lc(v.email), v.username);
    if ((role || 'user') === 'admin' && (active === undefined ? 1 : active)) ctx.activeAdmins.add(`new:${lower}`);
    return { action: 'add', key, message: `${role || 'user'}${v.password ? ', with a password' : ', no password yet'}`, data: { username: v.username, full_name: v.full_name, email: v.email || null, role: role || 'user', department: v.department || null, active: active === undefined ? 1 : active, groups: groups || [], password: v.password || null } };
  },

  async apply(item, ctx, { req, actor }) {
    const d = item.data;
    const saveGroups = async (userId, wanted) => {
      await db.prepare('DELETE FROM user_assignment_groups WHERE user_id = ?').run(userId);
      for (const g of wanted) await db.prepare('INSERT INTO user_assignment_groups (user_id, group_name) VALUES (?, ?) ON CONFLICT DO NOTHING').run(userId, g);
    };
    if (item.action === 'add') {
      // Nobody can sign in with a made-up hash; the person gets in through single sign-on, or once an administrator sets a password.
      if (!ctx.unusable) ctx.unusable = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
      const hash = d.password ? await hashPassword(d.password) : ctx.unusable;
      const made = await db.prepare(`INSERT INTO users (username, password_hash, full_name, email, role, department, active)
        VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(d.username, hash, d.full_name, d.email, d.role, d.department, d.active);
      await saveGroups(made.id, d.groups);
      await audit(req, actor, 'user.created', { targetType: 'user', targetId: made.id, targetName: d.username, detail: `role ${d.role}; added by a CSV import` });
      return;
    }
    const { existing, changes, groups } = d;
    const cols = Object.keys(changes);
    if (cols.length) {
      const allowed = ['full_name', 'email', 'role', 'department', 'active'];
      if (cols.some((c) => !allowed.includes(c))) throw new Error('unexpected column in an update');
      await db.prepare(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => changes[c]), existing.id);
    }
    if (groups !== undefined) await saveGroups(existing.id, groups);
    await audit(req, actor, 'user.updated', { targetType: 'user', targetId: existing.id, targetName: existing.username, detail: `${item.message}; changed by a CSV import` });
    if (changes.active === 0) {
      const ended = await sessions.revokeAll(existing.id);
      await audit(req, actor, 'session.revoked_all', { targetType: 'user', targetId: existing.id, targetName: existing.username, detail: `account switched off by a CSV import; ${ended} open session${ended === 1 ? '' : 's'} ended` });
    }
  },
};

// ------------------------------------------------------------------------------------- configuration items
const pickCiType = optionPicker(CI_TYPE_LABELS, { network_device: ['network', 'switch', 'router'], workstation: ['laptop', 'desktop'] });
const pickEnvironment = optionPicker(ENVIRONMENT_LABELS, { production: ['prod'], development: ['dev'], staging: ['stage'], dr: ['disaster-recovery'] });
const pickCiStatus = optionPicker(CI_STATUS_LABELS);
const CI_TEXT = [['ip_address', 'IP address'], ['os', 'OS'], ['manufacturer', 'Manufacturer'], ['model', 'Model'], ['serial_number', 'Serial number'], ['location', 'Location'], ['support_group', 'Support group'], ['cpu', 'CPU'], ['ram', 'RAM'], ['disk', 'Disk']];
const CI_DATES = [['purchase_date', 'Purchase date'], ['warranty_expiry', 'Warranty expiry'], ['install_date', 'Install date']];

const cmdb = {
  id: 'cmdb',
  label: 'Configuration items',
  noun: 'configuration item',
  icon: 'bi-hdd-network',
  roles: ['admin', 'agent'],
  maxRows: 5000,
  identity: ['ci_number', 'name'],
  intro: 'Servers, network devices, applications, databases, workstations and storage for the CMDB. A file exported from the CMDB page can be edited and imported again.',
  columns: [
    { field: 'ci_number', label: 'CI Number', aliases: ['cinumber', 'ci', 'number', 'id'], help: 'Says which existing item a row is. NovaDesk gives new items their own numbers.', example: '' },
    { field: 'name', label: 'Name', required: 'new', aliases: ['name', 'hostname', 'ciname'], help: 'Needed for a new item.', example: 'PRD-WEB-03' },
    { field: 'ci_type', label: 'Type', required: 'new', aliases: ['type', 'citype', 'class'], help: `One of ${Object.values(CI_TYPE_LABELS).join(', ')}.`, example: 'Server' },
    { field: 'environment', label: 'Environment', aliases: ['environment', 'env'], help: `${Object.values(ENVIRONMENT_LABELS).join(', ')}. Production when empty on a new item.`, example: 'Production' },
    { field: 'status', label: 'Status', aliases: ['status'], help: `${Object.values(CI_STATUS_LABELS).join(', ')}. In Use when empty on a new item.`, example: 'In Use' },
    { field: 'ip_address', label: 'IP Address', aliases: ['ipaddress', 'ip'], example: '10.0.1.23' },
    { field: 'os', label: 'OS', aliases: ['os', 'operatingsystem'], example: 'RHEL 9' },
    { field: 'manufacturer', label: 'Manufacturer', aliases: ['manufacturer', 'vendor', 'make'], example: 'Dell' },
    { field: 'model', label: 'Model', aliases: ['model'], example: 'PowerEdge R650' },
    { field: 'serial_number', label: 'Serial Number', aliases: ['serialnumber', 'serial'], example: 'SN12345' },
    { field: 'location', label: 'Location', aliases: ['location', 'site'], example: 'DC1 Rack 4' },
    { field: 'owner', label: 'Owner', aliases: ['owner', 'ownername', 'ownerusername'], help: 'A username, an email address or a full name that belongs to one person.', example: 'sam.lee' },
    { field: 'support_group', label: 'Support Group', aliases: ['supportgroup', 'group'], example: 'IRO-Windows' },
    { field: 'cpu', label: 'CPU', aliases: ['cpu', 'cpus', 'vcpu'], example: '8' },
    { field: 'ram', label: 'RAM', aliases: ['ram', 'memory'], example: '32 GB' },
    { field: 'disk', label: 'Disk', aliases: ['disk', 'storage'], example: '500 GB' },
    { field: 'purchase_date', label: 'Purchase Date', aliases: ['purchasedate', 'purchased'], help: 'Written YYYY-MM-DD.', example: '2024-03-01' },
    { field: 'warranty_expiry', label: 'Warranty Expiry', aliases: ['warrantyexpiry', 'warranty', 'warrantyend'], help: 'Written YYYY-MM-DD.', example: '2027-03-01' },
    { field: 'install_date', label: 'Install Date', aliases: ['installdate', 'installed'], help: 'Written YYYY-MM-DD.', example: '2024-03-15' },
    { field: 'notes', label: 'Notes', aliases: ['notes', 'description', 'comments'], example: '' },
  ],
  ignoredHeaders: ['dateadded', 'created', 'createdat', 'updated', 'updatedat'],
  templateRows: [
    ['', 'PRD-WEB-03', 'Server', 'Production', 'In Use', '10.0.1.23', 'RHEL 9', 'Dell', 'PowerEdge R650', 'SN12345', 'DC1 Rack 4', 'sam.lee', 'IRO-UNIX', '8', '32 GB', '500 GB', '2024-03-01', '2027-03-01', '2024-03-15', ''],
    ['', 'CORE-SW-02', 'Network Device', 'Production', 'In Stock', '10.0.0.3', '', 'Cisco', 'C9300', 'SN67890', 'DC1 Rack 1', '', 'IRO-Network/Security', '', '', '', '', '', '', 'Spare core switch'],
  ],

  async load() {
    return {
      cis: await db.prepare('SELECT * FROM cmdb_ci').all(),
      people: await db.prepare('SELECT id, username, email, full_name FROM users WHERE active = 1').all(),
    };
  },

  context({ cis, people }) {
    const group = (rows, keyFn) => { const m = new Map(); for (const r of rows) { const k = keyFn(r); if (!k) continue; (m.get(k) || m.set(k, []).get(k)).push(r); } return m; };
    return {
      byNumber: new Map(cis.map((c) => [String(c.ci_number).toUpperCase(), c])),
      byName: group(cis, (c) => lc(c.name)),
      ownerByUsername: group(people, (p) => lc(p.username)),
      ownerByEmail: group(people, (p) => lc(p.email)),
      ownerByName: group(people, (p) => lc(p.full_name)),
      seenExisting: new Map(),   // ci id -> row that already dealt with it
      seenNew: new Map(),        // name|type -> row that already adds it
    };
  },

  resolveOwner(value, ctx) {
    const k = lc(value);
    for (const m of [ctx.ownerByUsername, ctx.ownerByEmail, ctx.ownerByName]) {
      const hits = m.get(k);
      if (hits && hits.length === 1) return { id: hits[0].id };
      if (hits && hits.length > 1) return { error: `Owner "${value}" matches ${hits.length} people (${hits.map((h) => h.username).join(', ')}); use a username` };
    }
    return { error: `Owner "${value}" is not an active user` };
  },

  plan(v, ctx, row, { mode }) {
    const errors = [];
    let type; if (v.ci_type) { type = pickCiType(v.ci_type); if (!type) errors.push(`Type "${v.ci_type}" is not one of ${Object.values(CI_TYPE_LABELS).join(', ')}`); }
    let environment; if (v.environment) { environment = pickEnvironment(v.environment); if (!environment) errors.push(`Environment "${v.environment}" is not one of ${Object.values(ENVIRONMENT_LABELS).join(', ')}`); }
    let status; if (v.status) { status = pickCiStatus(v.status); if (!status) errors.push(`Status "${v.status}" is not one of ${Object.values(CI_STATUS_LABELS).join(', ')}`); }
    const texts = {};
    for (const [f, label] of CI_TEXT) if (v[f]) { texts[f] = v[f]; const e = tooLong(label, v[f], 500); if (e) errors.push(e); }
    if (v.notes) { texts.notes = v.notes; const e = tooLong('Notes', v.notes, 5000); if (e) errors.push(e); }
    if (v.name) { const e = tooLong('Name', v.name, 200); if (e) errors.push(e); }
    for (const [f, label] of CI_DATES) if (v[f]) { const d = pickDate(v[f]); if (d) texts[f] = d; else errors.push(`${label} "${v[f]}" is not a date written YYYY-MM-DD`); }
    let owner_id; if (v.owner) { const r = this.resolveOwner(v.owner, ctx); if (r.error) errors.push(r.error); else owner_id = r.id; }

    // Which item is this row? By CI number when it has one, otherwise by name (and type, when given).
    let existing = null; let note = null; let key = v.name || v.ci_number;
    if (v.ci_number) {
      existing = ctx.byNumber.get(v.ci_number.toUpperCase()) || null;
      key = existing ? existing.ci_number : v.ci_number;
      if (!existing) note = `${v.ci_number} is not in NovaDesk, so a new number is given`;
    } else if (v.name) {
      let hits = ctx.byName.get(lc(v.name)) || [];
      if (type) hits = hits.filter((c) => c.ci_type === type);
      if (hits.length > 1) return { action: 'error', key, message: `More than one item is called "${v.name}" (${hits.map((h) => h.ci_number).join(', ')}). Add a CI Number column to say which.` };
      existing = hits[0] || null;
    } else {
      return { action: 'error', key: '', message: 'Neither a CI Number nor a Name is given.' };
    }

    if (existing) {
      const earlier = ctx.seenExisting.get(existing.id);
      if (earlier) return { action: 'error', key, message: `${existing.ci_number} is already dealt with in row ${earlier}.` };
      ctx.seenExisting.set(existing.id, row);
      if (mode !== 'update') return { action: 'skip', key, message: `Already exists (${existing.ci_number}).` };
      const wanted = { ...texts };
      if (v.name && v.ci_number) wanted.name = v.name;   // found by its name, the name is not what changes
      if (type) wanted.ci_type = type;
      if (environment) wanted.environment = environment;
      if (status) wanted.status = status;
      if (owner_id !== undefined) wanted.owner_id = owner_id;
      const changes = {};
      for (const [c, val] of Object.entries(wanted)) if ((existing[c] === null || existing[c] === undefined ? '' : existing[c]) !== val) changes[c] = val;
      if (errors.length) return { action: 'error', key, message: `${errors.join('. ')}.` };
      if (!Object.keys(changes).length) return { action: 'unchanged', key, message: 'Nothing to change.' };
      return { action: 'update', key, message: Object.keys(changes).map((c) => c.replace(/_/g, ' ')).join(', '), data: { existing, changes } };
    }

    if (!v.name) errors.push('Name is empty');
    if (!type && !v.ci_type) errors.push('Type is empty');
    if (errors.length) return { action: 'error', key, message: `${errors.join('. ')}.` };
    const dup = `${lc(v.name)}|${type}`;
    if (ctx.seenNew.has(dup)) return { action: 'error', key, message: `Same name and type as row ${ctx.seenNew.get(dup)}.` };
    ctx.seenNew.set(dup, row);
    return { action: 'add', key, message: note || `${CI_TYPE_LABELS[type]}`, data: { name: v.name, ci_type: type, environment, status, owner_id, ...texts } };
  },

  async apply(item, ctx, { actor }) {
    if (item.action === 'add') {
      const made = await cmdbActions.createCi({ actor, fields: item.data });
      item.message = `${item.message}; ${made.ci_number}`;
      return;
    }
    await cmdbActions.updateCi({ existing: item.data.existing, fields: { ...item.data.existing, ...item.data.changes } });
  },
};

// ------------------------------------------------------------------------------------------ knowledge base
const pickKbStatus = optionPicker({ published: 'Published', draft: 'Draft' }, { published: ['publish', 'live'] });

const kb = {
  id: 'kb',
  label: 'Knowledge articles',
  noun: 'article',
  icon: 'bi-journal-text',
  roles: ['admin', 'agent'],
  maxRows: 5000,
  identity: ['number', 'title'],
  intro: 'Knowledge base articles. The body is plain text; line breaks are kept. A file exported from the Knowledge Base page can be edited and imported again.',
  columns: [
    { field: 'number', label: 'Number', aliases: ['number', 'kbnumber', 'id'], help: 'Says which existing article a row is.', example: '' },
    { field: 'title', label: 'Title', required: 'new', aliases: ['title', 'subject', 'name'], help: 'Needed for a new article.', example: 'How to reset your VPN token' },
    { field: 'category', label: 'Category', aliases: ['category', 'topic'], help: '"general" when empty on a new article.', example: 'Network' },
    { field: 'status', label: 'Status', aliases: ['status'], help: 'published or draft.', example: 'published' },
    { field: 'body', label: 'Body', required: 'new', aliases: ['body', 'content', 'text', 'article'], help: 'Needed for a new article.', example: 'Open the VPN client, choose Reset token, ...' },
  ],
  ignoredHeaders: ['author', 'views', 'viewcount', 'created', 'createdat', 'updated', 'updatedat'],
  templateRows: [
    ['', 'How to reset your VPN token', 'Network', 'published', 'Open the VPN client, choose Reset token, then follow the steps.'],
    ['', 'Printer queue is stuck', 'Workplace', 'draft', 'Restart the Print Spooler service.\nIf that does not help, ask the service desk.'],
  ],

  async load() { return { articles: await db.prepare('SELECT id, number, title, category, body, status FROM kb_articles').all() }; },

  context({ articles }) {
    const byTitle = new Map();
    for (const a of articles) (byTitle.get(lc(a.title)) || byTitle.set(lc(a.title), []).get(lc(a.title))).push(a);
    return { byNumber: new Map(articles.map((a) => [String(a.number).toUpperCase(), a])), byTitle, seenExisting: new Map(), seenNew: new Map() };
  },

  plan(v, ctx, row, { mode, defaultStatus }) {
    const errors = [];
    let status; if (v.status) { status = pickKbStatus(v.status); if (!status) errors.push(`Status "${v.status}" is not published or draft`); }
    for (const [label, value, max] of [['Title', v.title, 300], ['Category', v.category, 100], ['Body', v.body, 100000]]) { const e = tooLong(label, value, max); if (e) errors.push(e); }

    let existing = null; let note = null; let key = v.title || v.number;
    if (v.number) {
      existing = ctx.byNumber.get(v.number.toUpperCase()) || null;
      key = existing ? existing.number : v.number;
      if (!existing) note = `${v.number} is not in NovaDesk, so a new number is given`;
    } else if (v.title) {
      const hits = ctx.byTitle.get(lc(v.title)) || [];
      if (hits.length > 1) return { action: 'error', key, message: `More than one article is titled "${v.title}" (${hits.map((h) => h.number).join(', ')}). Add a Number column to say which.` };
      existing = hits[0] || null;
    } else {
      return { action: 'error', key: '', message: 'Neither a Number nor a Title is given.' };
    }

    if (existing) {
      const earlier = ctx.seenExisting.get(existing.id);
      if (earlier) return { action: 'error', key, message: `${existing.number} is already dealt with in row ${earlier}.` };
      ctx.seenExisting.set(existing.id, row);
      if (mode !== 'update') return { action: 'skip', key, message: `Already exists (${existing.number}).` };
      const wanted = {};
      if (v.title && v.number) wanted.title = v.title;   // found by its title, the title is not what changes
      if (v.category) wanted.category = v.category;
      if (v.body) wanted.body = v.body;
      if (status) wanted.status = status;
      const changes = {};
      for (const [c, val] of Object.entries(wanted)) if (existing[c] !== val) changes[c] = val;
      if (errors.length) return { action: 'error', key, message: `${errors.join('. ')}.` };
      if (!Object.keys(changes).length) return { action: 'unchanged', key, message: 'Nothing to change.' };
      return { action: 'update', key, message: Object.keys(changes).join(', '), data: { existing, changes } };
    }

    if (!v.title) errors.push('Title is empty');
    if (!v.body) errors.push('Body is empty');
    if (errors.length) return { action: 'error', key, message: `${errors.join('. ')}.` };
    const dup = lc(v.title);
    if (ctx.seenNew.has(dup)) return { action: 'error', key, message: `Same title as row ${ctx.seenNew.get(dup)}.` };
    ctx.seenNew.set(dup, row);
    const finalStatus = status || (defaultStatus === 'published' ? 'published' : 'draft');
    return { action: 'add', key, message: note || finalStatus, data: { title: v.title, category: v.category || 'general', body: v.body, status: finalStatus } };
  },

  async apply(item, ctx, { actor }) {
    if (item.action === 'add') {
      const d = item.data;
      const number = await nextNumber('kb', 'KB');
      await db.prepare('INSERT INTO kb_articles (number, title, category, body, status, author_id) VALUES (?, ?, ?, ?, ?, ?)').run(number, d.title, d.category, d.body, d.status, actor.id);
      item.message = `${item.message}; ${number}`;
      return;
    }
    const { existing, changes } = item.data;
    const merged = { ...existing, ...changes };
    await db.prepare('UPDATE kb_articles SET title = ?, category = ?, body = ?, status = ?, updated_at = ? WHERE id = ?').run(merged.title, merged.category, merged.body, merged.status, nowStr(), existing.id);
  },
};

const KINDS = { users, cmdb, kb };
module.exports = { KINDS, users, cmdb, kb, pickDate, pickBool, optionPicker };
