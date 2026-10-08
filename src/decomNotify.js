// Notifications-tab entries for the decommission workflow. NovaDesk's Notifications page lists
// what sendNotification (mailer.js) records, and until 0.0.73 only the Changes pages called it
// (a Change created, assigned or approved in the NovaDesk UI). A decommission runs through
// NovaConnect and decomAutomation, which never called it, so the tab stopped updating after the
// last decommission approved from the UI (2026-10-05). This sends the same kind of notice for the
// events of a decommission, to the requester and the assignee (one notice if they are the same
// person), honouring each user's email_notifications setting.
//
// Best effort: it never throws and callers do not wait for it. Events:
//   requested  - the NovaConnect request created the Change (assignee: "Assigned to you")
//   approved / rejected / cancelled - the decision or the stop
//   completed  - the VM is destroyed and the Change is closed
//   attention  - an ESXi step failed and a person has to look
const { db } = require('./db');
const { sendNotification } = require('./mailer');
const { escapeHtml } = require('./helpers');

const SUBJECT = {
  requested: (c) => `[${c.number}] Decommission requested: ${c.short_description}`,
  approved: (c) => `[${c.number}] Change approved: ${c.short_description}`,
  rejected: (c) => `[${c.number}] Change rejected: ${c.short_description}`,
  cancelled: (c) => `[${c.number}] Change cancelled: ${c.short_description}`,
  completed: (c) => `[${c.number}] Decommission complete: ${c.short_description}`,
  attention: (c) => `[${c.number}] Needs attention: ${c.short_description}`
};

const LINE = {
  requested: 'A decommission was requested in NovaConnect and is waiting for approval.',
  approved: 'The decommission was approved; the pre-checks, power-off and soak period follow.',
  rejected: 'The decommission was rejected; nothing was changed on the host.',
  cancelled: 'The decommission was cancelled before the VM was destroyed.',
  completed: 'The VM was destroyed, the CI retired and the Change closed.',
  attention: 'A step failed and needs a person to look at the Change.'
};

async function notifyDecom(changeId, event, detail) {
  try {
    const change = await db.prepare('SELECT * FROM changes WHERE id = ?').get(changeId);
    if (!change || !SUBJECT[event]) return;
    const ci = change.affected_ci_id ? await db.prepare('SELECT name FROM cmdb_ci WHERE id = ?').get(change.affected_ci_id) : null;

    const people = [];
    const add = async (userId, role) => {
      if (!userId || people.some((p) => p.id === userId)) return;
      const u = await db.prepare('SELECT id, full_name, email, email_notifications FROM users WHERE id = ?').get(userId);
      if (u && u.email && u.email_notifications) people.push({ ...u, role });
    };
    await add(change.requested_by, 'requester');
    await add(change.assigned_to, 'assignee');

    for (const p of people) {
      const assigned = event === 'requested' && p.role === 'assignee';
      const subject = assigned ? `[${change.number}] Assigned to you: ${change.short_description}` : SUBJECT[event](change);
      sendNotification({
        to: p.email,
        toName: p.full_name,
        subject,
        html: `<p>Hi ${escapeHtml(p.full_name)},</p><p>${escapeHtml(LINE[event])}</p>
          <p><strong>${escapeHtml(change.number)}</strong>${ci ? ` — ${escapeHtml(ci.name)}` : ''}</p>
          ${detail ? `<p>${escapeHtml(detail)}</p>` : ''}`,
        relatedType: 'change',
        relatedId: change.id
      }).catch(() => {});
    }
  } catch (e) {
    console.error(`Decommission notification (${event}) for change ${changeId} failed:`, e.message);
  }
}

module.exports = { notifyDecom };
