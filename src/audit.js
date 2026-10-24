// The audit log: one row for each security-relevant thing, kept apart from the activity on tickets. Recording never
// fails the action it describes (a log problem must not lock anyone out), it just reports to the server log.
'use strict';
const { db } = require('./db');

// actor: { id, username|full_name } (or null for "nobody signed in"); req gives the address.
async function audit(req, actor, action, { targetType = null, targetId = null, targetName = null, detail = null } = {}) {
  try {
    await db.prepare(`INSERT INTO audit_log (actor_id, actor_name, action, target_type, target_id, target_name, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(actor ? actor.id || null : null, actor ? (actor.full_name || actor.username || null) : null, action, targetType, targetId, targetName ? String(targetName).slice(0, 200) : null,
        detail ? String(detail).slice(0, 500) : null, req && req.ip ? String(req.ip).slice(0, 64) : null);
  } catch (err) {
    console.error(`[Audit] could not record ${action}: ${err.message}`);
  }
}

module.exports = { audit };
