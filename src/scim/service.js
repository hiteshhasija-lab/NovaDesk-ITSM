// What SCIM does to the database. Every rule that keeps SCIM from hurting an install lives here:
//  - an identity provider can create, change and switch off people, but cannot set a password (a person it creates signs in
//    with single sign-on, or an administrator sets one) and cannot touch an anonymised person (they do not exist to it);
//  - it cannot make an administrator, or change one, unless an administrator allowed that in SCIM settings, and it can
//    never switch off, demote or delete the only active administrator;
//  - switching a person off ends their sessions and API keys; deleting one removes them only when they have no history,
//    otherwise they are switched off (the history they are part of must stay whole);
//  - two accounts never share a username (any capitals) or an email address, because single sign-on finds people by email.
'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, nowStr } = require('../db');
const sessions = require('../sessionStore');
const apiKeys = require('../apiKeys');
const { audit } = require('../audit');
const { ASSIGNMENT_GROUPS } = require('../helpers');
const settingsStore = require('./settings');
const F = require('./filter');
const R = require('./resource');
const { applyPatch } = require('./patch');
const E = require('./errors');

const MAX_COUNT = 100;

// ---------------------------------------------------------------- people
const USER_ATTRIBUTES = {
  username: { sql: 'username' },
  externalid: { sql: 'scim_external_id', fold: false },
  id: { sql: 'id::text', fold: false },
  active: { sql: 'active', kind: 'bool' },
  'emails.value': { sql: 'email' },
  emails: { sql: 'email' },
  displayname: { sql: 'full_name' },
  'name.formatted': { sql: 'full_name' },
  department: { sql: 'department' },
};

const modelOf = (row) => ({ userName: row.username, externalId: row.scim_external_id || null, fullName: row.full_name, email: row.email || null, active: Boolean(row.active), role: row.role, department: row.department || null });
const actorOf = (token) => ({ id: null, username: `SCIM: ${token.name}` });

async function loadRow(id) {
  const n = Number(id);
  if (!/^\d+$/.test(String(id)) || !Number.isInteger(n) || n < 1 || n > 2147483647) throw E.notFound('User');
  const row = await db.prepare('SELECT * FROM users WHERE id = ? AND anonymised_at IS NULL').get(n);
  if (!row) throw E.notFound('User');
  return row;
}

async function groupsOf(userIds) {
  if (!userIds.length) return new Map();
  const rows = await db.prepare(`SELECT user_id, group_name FROM user_assignment_groups WHERE user_id IN (${userIds.map(() => '?').join(',')}) ORDER BY group_name`).all(...userIds);
  const out = new Map();
  for (const r of rows) {
    const g = GROUPS.find((x) => x.name === r.group_name);
    if (!g) continue;
    if (!out.has(r.user_id)) out.set(r.user_id, []);
    out.get(r.user_id).push(g);
  }
  return out;
}

async function present(rows, baseUrl) {
  const groups = await groupsOf(rows.map((r) => r.id));
  return rows.map((r) => R.toScim(r, { baseUrl, groups: groups.get(r.id) || [] }));
}

async function listUsers({ filter, startIndex = 1, count = MAX_COUNT }, baseUrl) {
  let where = 'anonymised_at IS NULL'; let params = [];
  if (filter) { const c = F.toSql(F.parse(filter), USER_ATTRIBUTES); where += ` AND ${c.sql}`; params = c.params; }
  const total = Number((await db.prepare(`SELECT COUNT(*) AS c FROM users WHERE ${where}`).get(...params)).c);
  const rows = count > 0 ? await db.prepare(`SELECT * FROM users WHERE ${where} ORDER BY id LIMIT ? OFFSET ?`).all(...params, count, startIndex - 1) : [];
  return { total, resources: await present(rows, baseUrl) };
}

async function getUser(id, baseUrl) {
  return (await present([await loadRow(id)], baseUrl))[0];
}

async function onlyActiveAdmin(row) {
  if (row.role !== 'admin' || !row.active) return false;
  return Number((await db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1 AND anonymised_at IS NULL AND id <> ?").get(row.id)).c) === 0;
}

async function checkUnique(next, selfId) {
  const byName = await db.prepare('SELECT id FROM users WHERE lower(username) = lower(?) AND id <> ?').get(next.userName, selfId || 0);
  if (byName) throw E.uniqueness(`userName "${next.userName}" is already taken.`);
  if (next.email) {
    const byEmail = await db.prepare('SELECT id FROM users WHERE lower(email) = lower(?) AND id <> ?').get(next.email, selfId || 0);
    if (byEmail) throw E.uniqueness(`The email address ${next.email} already belongs to another account.`);
  }
}

function checkRole(role, previous, settings) {
  if (role === previous) return;
  if ((role === 'admin' || previous === 'admin') && !settings.allowAdmin) {
    throw E.mutability('Administrator roles are managed in NovaDesk: SCIM may not grant or take away the administrator role (an administrator can allow it in the SCIM settings).');
  }
}

async function createUser(model, token, req) {
  const settings = await settingsStore.get();
  const next = {
    userName: model.userName, externalId: model.externalId === undefined ? null : model.externalId, fullName: model.fullName || model.userName,
    email: model.email === undefined ? null : model.email, active: model.active === undefined ? true : model.active,
    role: model.role === undefined ? settings.defaultRole : model.role, department: model.department === undefined ? null : model.department,
  };
  if (next.role === 'admin' && !settings.allowAdmin) throw E.mutability('SCIM may not create an administrator (an administrator can allow it in the SCIM settings).');
  await checkUnique(next, 0);
  const unusable = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
  let id;
  try {
    id = (await db.prepare(`INSERT INTO users (username, password_hash, full_name, email, role, department, active, scim_managed, scim_external_id, scim_updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?) RETURNING id`).run(next.userName, unusable, next.fullName, next.email, next.role, next.department, next.active ? 1 : 0, next.externalId, nowStr())).lastInsertRowid;
  } catch (err) {
    if (err.code === '23505') throw E.uniqueness(`userName "${next.userName}" is already taken.`);
    throw err;
  }
  await audit(req, actorOf(token), 'scim.user.created', { targetType: 'user', targetId: id, targetName: next.userName, detail: `provisioned (role ${next.role}${next.active ? '' : ', switched off'})` });
  return id;
}

const FIELD_NAMES = { userName: 'username', externalId: 'external id', fullName: 'name', email: 'email', role: 'role', department: 'department', active: 'active' };

// Writes `next` over `row`. Returns { changed: [...] } and does nothing when nothing differs.
async function applyChange(row, next, token, req) {
  const settings = await settingsStore.get();
  const before = modelOf(row);
  const changed = Object.keys(FIELD_NAMES).filter((k) => before[k] !== next[k]);
  if (!changed.length) return { changed };
  if (changed.includes('userName') || changed.includes('email')) await checkUnique(next, row.id);
  if (changed.includes('role')) checkRole(next.role, row.role, settings);
  if ((changed.includes('role') && next.role !== 'admin') || (changed.includes('active') && !next.active)) {
    if (await onlyActiveAdmin(row)) throw E.mutability('This is the only active administrator, so SCIM cannot switch it off or demote it. Make someone else an administrator first.');
  }
  try {
    await db.prepare(`UPDATE users SET username = ?, full_name = ?, email = ?, role = ?, department = ?, active = ?, scim_external_id = ?, scim_managed = 1, scim_updated_at = ? WHERE id = ?`)
      .run(next.userName, next.fullName, next.email, next.role, next.department, next.active ? 1 : 0, next.externalId, nowStr(), row.id);
  } catch (err) {
    if (err.code === '23505') throw E.uniqueness(`userName "${next.userName}" is already taken.`);
    throw err;
  }
  let action = 'scim.user.updated';
  let detail = `changed: ${changed.map((k) => FIELD_NAMES[k]).join(', ')}`;
  if (changed.includes('active')) {
    if (!next.active) {
      const ended = await sessions.revokeAll(row.id);
      const keys = await apiKeys.revokeAllKeys(row.id);
      action = 'scim.user.deactivated';
      detail = `switched off by the identity provider; ${ended} open session${ended === 1 ? '' : 's'} ended, ${keys} API key${keys === 1 ? '' : 's'} revoked${changed.length > 1 ? `; also changed: ${changed.filter((k) => k !== 'active').map((k) => FIELD_NAMES[k]).join(', ')}` : ''}`;
    } else {
      action = 'scim.user.reactivated';
      detail = `switched on by the identity provider${changed.length > 1 ? `; also changed: ${changed.filter((k) => k !== 'active').map((k) => FIELD_NAMES[k]).join(', ')}` : ''}`;
    }
  }
  await audit(req, actorOf(token), action, { targetType: 'user', targetId: row.id, targetName: next.userName, detail });
  return { changed };
}

async function replaceUser(id, input, token, req) {
  const row = await loadRow(id);
  const cur = modelOf(row);
  // PUT replaces the person: what the request leaves out is cleared, except the role and whether the account is on, which
  // a provider that does not manage them must not reset.
  const next = {
    userName: input.userName, externalId: input.externalId === undefined ? null : input.externalId, fullName: input.fullName || cur.fullName,
    email: input.email === undefined ? null : input.email, active: input.active === undefined ? cur.active : input.active,
    role: input.role === undefined ? cur.role : input.role, department: input.department === undefined ? null : input.department,
  };
  await applyChange(row, next, token, req);
}

async function patchUser(id, body, token, req) {
  const row = await loadRow(id);
  const next = applyPatch(body, modelOf(row));
  await applyChange(row, next, token, req);
}

async function deleteUser(id, token, req) {
  const row = await loadRow(id);
  if (await onlyActiveAdmin(row)) throw E.mutability('This is the only active administrator, so SCIM cannot delete it.');
  await sessions.revokeAll(row.id);
  await apiKeys.revokeAllKeys(row.id);
  let outcome = 'removed';
  try {
    await db.prepare('DELETE FROM users WHERE id = ?').run(row.id);
  } catch (err) {
    if (err.code !== '23503') throw err;
    await db.prepare('UPDATE users SET active = 0, scim_managed = 1, scim_updated_at = ? WHERE id = ?').run(nowStr(), row.id);
    outcome = 'switched off (they have tickets or history, which stay)';
  }
  await audit(req, actorOf(token), 'scim.user.deleted', { targetType: 'user', targetId: row.id, targetName: row.username, detail: outcome });
}

// ---------------------------------------------------------------- groups (NovaDesk's assignment groups: a fixed list)
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const GROUPS = ASSIGNMENT_GROUPS.map((name) => ({ id: slug(name), name }));

async function membersOf(groupName) {
  return db.prepare(`SELECT u.id, u.full_name FROM user_assignment_groups g JOIN users u ON u.id = g.user_id WHERE g.group_name = ? AND u.anonymised_at IS NULL ORDER BY u.id`).all(groupName);
}
const groupResource = (g, members, baseUrl) => ({
  schemas: [R.CORE_GROUP], id: g.id, displayName: g.name,
  members: members.map((m) => ({ value: String(m.id), display: m.full_name, $ref: `${baseUrl}/Users/${m.id}`, type: 'User' })),
  meta: { resourceType: 'Group', location: `${baseUrl}/Groups/${g.id}` },
});

async function listGroups({ filter, startIndex = 1, count = MAX_COUNT }, baseUrl) {
  let list = GROUPS;
  if (filter) {
    const tree = F.parse(filter);
    list = GROUPS.filter((g) => F.evaluate(tree, g, { id: (x) => x.id, displayname: (x) => x.name }));
  }
  const page = count > 0 ? list.slice(startIndex - 1, startIndex - 1 + count) : [];
  const out = [];
  for (const g of page) out.push(groupResource(g, await membersOf(g.name), baseUrl));
  return { total: list.length, resources: out };
}

function findGroup(id) {
  const g = GROUPS.find((x) => x.id === String(id).toLowerCase());
  if (!g) throw E.notFound('Group');
  return g;
}
async function getGroup(id, baseUrl) { const g = findGroup(id); return groupResource(g, await membersOf(g.name), baseUrl); }

async function requireGroupWrites() {
  if (!(await settingsStore.get()).allowGroups) throw E.forbidden('Changing group membership through SCIM is switched off. An administrator can allow it in the SCIM settings.');
}

async function memberIds(values) {
  const ids = [];
  for (const m of values) {
    const raw = m && typeof m === 'object' ? m.value : m;
    if (raw === undefined || raw === null || !/^\d+$/.test(String(raw))) throw E.invalidValue(`"${raw}" is not the id of a person.`);
    ids.push(Number(raw));
  }
  if (ids.length) {
    const found = new Set((await db.prepare(`SELECT id FROM users WHERE anonymised_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`).all(...ids)).map((r) => r.id));
    const missing = ids.filter((i) => !found.has(i));
    if (missing.length) throw E.invalidValue(`No such person: ${missing.join(', ')}.`);
  }
  return [...new Set(ids)];
}

async function setMembership(g, wanted, token, req) {
  const current = new Set((await membersOf(g.name)).map((m) => m.id));
  const target = new Set(wanted);
  const add = [...target].filter((i) => !current.has(i)); const drop = [...current].filter((i) => !target.has(i));
  for (const i of add) await db.prepare('INSERT INTO user_assignment_groups (user_id, group_name) VALUES (?, ?) ON CONFLICT DO NOTHING').run(i, g.name);
  for (const i of drop) await db.prepare('DELETE FROM user_assignment_groups WHERE user_id = ? AND group_name = ?').run(i, g.name);
  if (add.length || drop.length) {
    await db.prepare(`UPDATE users SET scim_updated_at = ? WHERE id IN (${[...add, ...drop].map(() => '?').join(',')})`).run(nowStr(), ...add, ...drop);
    await audit(req, actorOf(token), 'scim.group.members', { targetType: 'group', targetName: g.name, detail: `${add.length} added, ${drop.length} removed (${[...add.map((i) => `+${i}`), ...drop.map((i) => `-${i}`)].join(' ')})` });
  }
}

async function replaceGroup(id, body, token, req) {
  const g = findGroup(id);
  await requireGroupWrites();
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw E.invalidSyntax('The body must be a JSON object holding a SCIM Group.');
  if (body.displayName !== undefined && String(body.displayName) !== g.name) throw E.mutability('The name of a group cannot be changed through SCIM: groups are fixed in NovaDesk.');
  await setMembership(g, await memberIds(Array.isArray(body.members) ? body.members : []), token, req);
}

async function patchGroup(id, body, token, req) {
  const g = findGroup(id);
  await requireGroupWrites();
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw E.invalidSyntax('The body must be a SCIM PatchOp.');
  if (Array.isArray(body.schemas) && !body.schemas.includes(R.PATCH_OP)) throw E.invalidSyntax(`schemas must include ${R.PATCH_OP}.`);
  const ops = body.Operations || body.operations;
  if (!Array.isArray(ops) || !ops.length) throw E.invalidSyntax('Operations must be a list with at least one operation.');
  if (ops.length > 100) throw E.invalidSyntax('At most 100 operations in one request.');
  const members = new Set((await membersOf(g.name)).map((m) => m.id));
  for (const op of ops) {
    const kind = String((op && op.op) || '').toLowerCase();
    if (!['add', 'replace', 'remove'].includes(kind)) throw E.invalidSyntax(`"${op && op.op}" is not an operation (add, replace, remove).`);
    const path = op.path === undefined || op.path === null ? '' : String(op.path).trim();
    const lower = path.toLowerCase();
    if (lower === 'displayname') {
      if (kind !== 'remove' && String(op.value) !== g.name) throw E.mutability('The name of a group cannot be changed through SCIM: groups are fixed in NovaDesk.');
      continue;
    }
    const filtered = /^members\[\s*value\s+eq\s+"?(\d+)"?\s*\]$/i.exec(path);
    if (filtered) {
      if (kind !== 'remove') throw E.invalidPath('A path that names one member can only be used to remove it.');
      members.delete(Number(filtered[1])); continue;
    }
    if (lower === 'members' || (!path && op.value && typeof op.value === 'object' && !Array.isArray(op.value))) {
      let value = op.value;
      if (!path) {                                          // no path: the value's own keys are the paths
        if (value.members === undefined) { if (value.displayName !== undefined && value.displayName !== g.name) throw E.mutability('The name of a group cannot be changed through SCIM: groups are fixed in NovaDesk.'); continue; }
        value = value.members;
      }
      if (kind === 'remove' && value === undefined) { members.clear(); continue; }
      if (!Array.isArray(value)) throw E.invalidValue('members must be a list.');
      const ids = await memberIds(value);
      if (kind === 'add') ids.forEach((i) => members.add(i));
      else if (kind === 'remove') ids.forEach((i) => members.delete(i));
      else { members.clear(); ids.forEach((i) => members.add(i)); }
      continue;
    }
    throw E.invalidPath(`"${path}" is not something NovaDesk can change on a group (members, displayName).`);
  }
  await setMembership(g, [...members], token, req);
}

module.exports = {
  MAX_COUNT, USER_ATTRIBUTES, GROUPS, slug, modelOf, listUsers, getUser, createUser, replaceUser, patchUser, deleteUser,
  listGroups, getGroup, replaceGroup, patchGroup, loadRow, present,
};
