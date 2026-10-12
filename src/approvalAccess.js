const { db } = require('./db');

// Who may decide (approve, reject, send back to pending) a decommission Change in NovaDesk: the
// person who requested it, or a member of the IRO-Build/Decom assignment group. A NovaDesk admin
// who is neither is not included. A decommission Change is one that came from NovaConnect or is
// assigned to that group; every other Change keeps the admin/agent rule.
const DECOM_GROUP = 'IRO-Build/Decom';

function isDecomChange(change) {
  return !!(change && (change.novaconnect_channel_id || change.novaconnect_conversation_id || change.assignment_group === DECOM_GROUP));
}

async function isGroupMember(userId, group = DECOM_GROUP) {
  if (!userId) return false;
  const row = await db.prepare('SELECT 1 AS ok FROM user_assignment_groups WHERE user_id = ? AND group_name = ?').get(userId, group);
  return !!row;
}

// `user` is the session user ({ id, role }). Non-decommission Changes: the existing admin/agent rule.
async function mayDecideApproval(user, change) {
  if (!user || !change) return false;
  if (!isDecomChange(change)) return ['admin', 'agent'].includes(user.role);
  if (change.requested_by && Number(change.requested_by) === Number(user.id)) return true;
  return isGroupMember(user.id);
}

const NOT_ALLOWED_MESSAGE = `Only the person who requested this decommission, or a member of the ${DECOM_GROUP} assignment group, can approve or reject it.`;

module.exports = { DECOM_GROUP, isDecomChange, isGroupMember, mayDecideApproval, NOT_ALLOWED_MESSAGE };
