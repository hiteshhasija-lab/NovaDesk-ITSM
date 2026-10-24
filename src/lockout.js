// A temporary lock after repeated wrong passwords, kept per account in the database. It complements the per-address
// limit (which stops one machine guessing) by stopping many machines guessing at one account. The lock ends by itself;
// an administrator can lift it at once (Users, the person). Single sign-on and API keys are not affected.
'use strict';
const { db, nowStr } = require('./db');
const { securitySettings } = require('./settings');

const isLocked = (user, now = Date.now()) => Boolean(user.locked_until && new Date(String(user.locked_until).replace(' ', 'T') + 'Z').getTime() > now);

// Counts one wrong password. Resolves { locked, until } (locked: this failure started a lock).
async function recordFailure(user, env = process.env) {
  const { lockoutAfter, lockoutMinutes } = securitySettings(env);
  if (!lockoutAfter) return { locked: false };
  const row = await db.prepare('UPDATE users SET failed_logins = failed_logins + 1 WHERE id = ? RETURNING failed_logins').get(user.id);
  if (!row || row.failed_logins < lockoutAfter) return { locked: false };
  const until = new Date(Date.now() + lockoutMinutes * 60000).toISOString().slice(0, 19).replace('T', ' ');
  await db.prepare('UPDATE users SET locked_until = ?, failed_logins = 0 WHERE id = ?').run(until, user.id);
  return { locked: true, until };
}

async function clearFailures(userId) {
  await db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ? AND (failed_logins <> 0 OR locked_until IS NOT NULL)').run(userId);
}

module.exports = { isLocked, recordFailure, clearFailures };
