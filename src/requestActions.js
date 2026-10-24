// What submitting and changing a service request does, shared by the pages and the REST API.
'use strict';
const { db, nextNumber, logActivity, nowStr } = require('./db');
const { REQUEST_STATUS_LABELS, escapeHtml } = require('./helpers');
const { sendNotification } = require('./mailer');
const slaService = require('./slaService');

// `item` is the catalog item row. Resolves { id, number }.
async function createServiceRequest({ actor, item, notes }) {
  const number = await nextNumber('request', 'REQ');
  // The SLA clock, when the request SLA is switched on (SLA settings); otherwise the columns stay empty.
  const createdAt = nowStr();
  const clock = (await slaService.newRequestClock(createdAt)) || {};
  const info = await db.prepare(`
    INSERT INTO service_requests (number, catalog_item_id, requested_by, notes, assignment_group, created_at,
      sla_started_at, sla_target_minutes, sla_clock, sla_warn_percent, sla_due_at)
    VALUES (@number, @catalog_item_id, @requested_by, @notes, @assignment_group, @created_at,
      @sla_started_at, @sla_target_minutes, @sla_clock, @sla_warn_percent, @sla_due_at)
    RETURNING id
  `).run({
    number, catalog_item_id: item.id, requested_by: actor.id, notes: notes || null,
    assignment_group: item.fulfillment_group || null, created_at: createdAt,
    sla_started_at: clock.sla_started_at || null, sla_target_minutes: clock.sla_target_minutes || null, sla_clock: clock.sla_clock || null,
    sla_warn_percent: clock.sla_warn_percent || null, sla_due_at: clock.sla_due_at || null
  });

  await logActivity('request', info.lastInsertRowid, actor.id, 'Request submitted');

  const requester = await db.prepare('SELECT full_name, email, email_notifications FROM users WHERE id = ?').get(actor.id);
  if (requester && requester.email && requester.email_notifications) {
    sendNotification({
      to: requester.email,
      toName: requester.full_name,
      subject: `[${number}] Request submitted: ${item.name}`,
      html: `<p>Hi ${escapeHtml(requester.full_name)},</p><p>Your request <strong>${number}</strong> for <strong>${escapeHtml(item.name)}</strong> has been submitted${item.fulfillment_group ? ` to ${escapeHtml(item.fulfillment_group)}` : ''}.</p><p>We'll keep you updated as it's fulfilled.</p>`,
      relatedType: 'request',
      relatedId: info.lastInsertRowid
    }).catch(() => {});
  }
  return { id: info.lastInsertRowid, number };
}

// `existing` is the row; `fields` the complete new values: status, assigned_to, assignment_group.
async function updateServiceRequest({ actor, existing, fields }) {
  const { status, assigned_to, assignment_group } = fields;
  let fulfilled_at = existing.fulfilled_at;
  if (status === 'fulfilled') {
    if (existing.status !== 'fulfilled') fulfilled_at = nowStr();
  } else {
    fulfilled_at = null;
  }

  await db.prepare(`
    UPDATE service_requests SET status = ?, assigned_to = ?, assignment_group = ?, fulfilled_at = ?, updated_at = ? WHERE id = ?
  `).run(status, assigned_to || null, assignment_group || null, fulfilled_at, nowStr(), existing.id);

  if (status !== existing.status) {
    await logActivity('request', existing.id, actor.id,
      `Status changed from ${REQUEST_STATUS_LABELS[existing.status]} to ${REQUEST_STATUS_LABELS[status]}`);
  }

  if (['fulfilled', 'rejected'].includes(status) && status !== existing.status) {
    const requester = await db.prepare('SELECT full_name, email, email_notifications FROM users WHERE id = ?').get(existing.requested_by);
    const item = await db.prepare('SELECT name FROM catalog_items WHERE id = ?').get(existing.catalog_item_id);
    if (requester && requester.email && requester.email_notifications) {
      sendNotification({
        to: requester.email,
        toName: requester.full_name,
        subject: `[${existing.number}] Request ${status}: ${item ? item.name : ''}`,
        html: `<p>Hi ${escapeHtml(requester.full_name)},</p><p>Your request <strong>${existing.number}</strong> has been <strong>${status}</strong>.</p>`,
        relatedType: 'request',
        relatedId: existing.id
      }).catch(() => {});
    }
  }
}

module.exports = { createServiceRequest, updateServiceRequest };
