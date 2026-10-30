// The choices an administrator makes about SCIM (table scim_settings, one row). The safest value is the default for each.
'use strict';
const { db } = require('../db');

async function get() {
  const r = await db.prepare('SELECT allow_admin, allow_groups, default_role FROM scim_settings WHERE id = 1').get();
  return { allowAdmin: Boolean(r && r.allow_admin), allowGroups: Boolean(r && r.allow_groups), defaultRole: r ? r.default_role : 'user' };
}

// `wanted` is { allowAdmin, allowGroups, defaultRole } (booleans and a role). Returns the list of what changed, in words.
async function save(wanted) {
  if (!['user', 'agent'].includes(wanted.defaultRole)) throw new Error('The default role must be user or agent.');
  const was = await get();
  await db.prepare('UPDATE scim_settings SET allow_admin = ?, allow_groups = ?, default_role = ? WHERE id = 1').run(wanted.allowAdmin ? 1 : 0, wanted.allowGroups ? 1 : 0, wanted.defaultRole);
  const changed = [];
  if (was.allowAdmin !== Boolean(wanted.allowAdmin)) changed.push(`SCIM may make administrators: ${wanted.allowAdmin ? 'on' : 'off'}`);
  if (was.allowGroups !== Boolean(wanted.allowGroups)) changed.push(`SCIM may change group membership: ${wanted.allowGroups ? 'on' : 'off'}`);
  if (was.defaultRole !== wanted.defaultRole) changed.push(`default role ${was.defaultRole} to ${wanted.defaultRole}`);
  return changed;
}

module.exports = { get, save };
