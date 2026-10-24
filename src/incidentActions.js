// What creating, changing and commenting on an incident does, in one place: the pages, the REST API and the
// bulk actions all go through it, so a priority change moves the SLA clock, a status change is logged and the
// right people are emailed whichever way the change was made.
'use strict';
const { db, nextNumber, logActivity, nowStr } = require('./db');
const { priorityFromImpactUrgency, INCIDENT_STATUS_LABELS, PRIORITY_LABELS, escapeHtml } = require('./helpers');
const { sendNotification } = require('./mailer');
const slaService = require('./slaService');
const { notifyWatchers } = require('./collab');

async function notifyOnCreate(incidentId) {
  const incident = await db.prepare('SELECT * FROM incidents WHERE id = ?').get(incidentId);
  const desc = escapeHtml(incident.short_description);
  const caller = await db.prepare('SELECT full_name, email, email_notifications FROM users WHERE id = ?').get(incident.caller_id);
  if (caller && caller.email && caller.email_notifications) {
    sendNotification({
      to: caller.email,
      toName: caller.full_name,
      subject: `[${incident.number}] Incident logged: ${incident.short_description}`,
      html: `<p>Hi ${escapeHtml(caller.full_name)},</p><p>Your incident <strong>${incident.number}</strong> has been logged.</p>
        <p><strong>${desc}</strong></p>
        <p>Priority: P${incident.priority} — ${PRIORITY_LABELS[incident.priority]}</p>
        <p>We'll keep you updated as it progresses.</p>`,
      relatedType: 'incident',
      relatedId: incident.id
    }).catch(() => {});
  }
  if (incident.assigned_to) {
    const assignee = await db.prepare('SELECT full_name, email, email_notifications FROM users WHERE id = ?').get(incident.assigned_to);
    if (assignee && assignee.email && assignee.email_notifications) {
      sendNotification({
        to: assignee.email,
        toName: assignee.full_name,
        subject: `[${incident.number}] Assigned to you: ${incident.short_description}`,
        html: `<p>Hi ${escapeHtml(assignee.full_name)},</p><p>Incident <strong>${incident.number}</strong> has been assigned to you.</p>
          <p><strong>${desc}</strong></p>
          <p>Priority: P${incident.priority} — ${PRIORITY_LABELS[incident.priority]}</p>`,
        relatedType: 'incident',
        relatedId: incident.id
      }).catch(() => {});
    }
  }
}

// fields: short_description, description, category, subcategory, impact, urgency, caller_id, assigned_to,
// assignment_group, affected_ci_id (already checked by the caller). Resolves { id, number }.
async function createIncident({ actor, fields }) {
  const impact = Number(fields.impact) || 3;
  const urgency = Number(fields.urgency) || 3;
  const priority = priorityFromImpactUrgency(impact, urgency);
  const number = await nextNumber('incident', 'INC');
  const createdAt = nowStr();
  const clock = await slaService.newIncidentClock(priority, createdAt);

  const info = await db.prepare(`
    INSERT INTO incidents (number, short_description, description, category, subcategory, impact, urgency, priority,
      status, caller_id, assigned_to, assignment_group, affected_ci_id, created_at, sla_due_at,
      sla_started_at, sla_target_minutes, sla_clock, sla_warn_percent, sla_paused_minutes)
    VALUES (@number, @short_description, @description, @category, @subcategory, @impact, @urgency, @priority,
      'new', @caller_id, @assigned_to, @assignment_group, @affected_ci_id, @created_at, @sla_due_at,
      @sla_started_at, @sla_target_minutes, @sla_clock, @sla_warn_percent, @sla_paused_minutes)
    RETURNING id
  `).run({
    number,
    short_description: fields.short_description,
    description: fields.description || null,
    category: fields.category || 'other',
    subcategory: fields.subcategory || null,
    impact, urgency, priority,
    caller_id: fields.caller_id,
    assigned_to: fields.assigned_to || null,
    assignment_group: fields.assignment_group || null,
    affected_ci_id: fields.affected_ci_id || null,
    created_at: createdAt,
    sla_due_at: clock.sla_due_at,
    sla_started_at: clock.sla_started_at,
    sla_target_minutes: clock.sla_target_minutes,
    sla_clock: clock.sla_clock,
    sla_warn_percent: clock.sla_warn_percent,
    sla_paused_minutes: clock.sla_paused_minutes
  });

  await logActivity('incident', info.lastInsertRowid, actor.id, 'Incident created');
  await notifyOnCreate(info.lastInsertRowid);
  return { id: info.lastInsertRowid, number };
}

// `existing` is the row as it is now; `fields` the complete new values (the page's form always sends all of
// them, the API merges a partial change over the row first): short_description, description, category,
// subcategory, impact, urgency, status, assigned_to, assignment_group, affected_ci_id, resolution_notes, problem_id.
async function updateIncident({ actor, existing, fields: b }) {
  const impact = Number(b.impact) || existing.impact;
  const urgency = Number(b.urgency) || existing.urgency;
  const priority = priorityFromImpactUrgency(impact, urgency);
  const status = b.status || existing.status;

  let resolved_at = existing.resolved_at;
  let closed_at = existing.closed_at;
  if (status === 'resolved') {
    if (existing.status !== 'resolved') resolved_at = nowStr();
  } else if (status !== 'closed') {
    resolved_at = null;
  }
  if (status === 'closed') {
    if (existing.status !== 'closed') closed_at = nowStr();
  } else {
    closed_at = null;
  }

  const clockChange = await slaService.incidentClockChanges(existing, { status, priority });

  await db.prepare(`
    UPDATE incidents SET short_description=@short_description, description=@description, category=@category,
      subcategory=@subcategory, impact=@impact, urgency=@urgency, priority=@priority, status=@status,
      assigned_to=@assigned_to, assignment_group=@assignment_group, affected_ci_id=@affected_ci_id,
      resolution_notes=@resolution_notes, problem_id=@problem_id, resolved_at=@resolved_at, closed_at=@closed_at, updated_at=@updated_at${slaService.setSql(clockChange.changes)}
    WHERE id=@id
  `).run({
    ...clockChange.changes,
    id: existing.id,
    short_description: b.short_description,
    description: b.description || null,
    category: b.category || 'other',
    subcategory: b.subcategory || null,
    impact, urgency, priority, status,
    assigned_to: b.assigned_to || null,
    assignment_group: b.assignment_group || null,
    affected_ci_id: b.affected_ci_id || null,
    resolution_notes: b.resolution_notes || null,
    problem_id: b.problem_id || null,
    resolved_at, closed_at,
    updated_at: nowStr()
  });

  if ((b.problem_id || null) !== existing.problem_id && b.problem_id) {
    await logActivity('incident', existing.id, actor.id, `Linked to problem`);
  }

  const actorId = actor.id;
  if (status !== existing.status) {
    await logActivity('incident', existing.id, actorId,
      `Status changed from ${INCIDENT_STATUS_LABELS[existing.status]} to ${INCIDENT_STATUS_LABELS[status]}`);
  }
  await slaService.logClockNotes(existing.id, actorId, clockChange.notes);
  if (priority !== existing.priority) {
    await logActivity('incident', existing.id, actorId,
      `Priority changed from P${existing.priority} to P${priority}`);
  }
  const newAssignedTo = b.assigned_to ? Number(b.assigned_to) : null;
  if (newAssignedTo !== existing.assigned_to) {
    const newNameRow = newAssignedTo ? await db.prepare('SELECT full_name FROM users WHERE id = ?').get(newAssignedTo) : null;
    const oldNameRow = existing.assigned_to ? await db.prepare('SELECT full_name FROM users WHERE id = ?').get(existing.assigned_to) : null;
    await logActivity('incident', existing.id, actorId,
      `Reassigned from ${(oldNameRow || {}).full_name || 'Unassigned'} to ${(newNameRow || {}).full_name || 'Unassigned'}`);
  }
  const newGroup = b.assignment_group || null;
  if (newGroup !== existing.assignment_group) {
    await logActivity('incident', existing.id, actorId,
      `Assignment group changed from ${existing.assignment_group || '—'} to ${newGroup || '—'}`);
  }

  if (newAssignedTo && newAssignedTo !== existing.assigned_to) {
    const assignee = await db.prepare('SELECT full_name, email, email_notifications FROM users WHERE id = ?').get(newAssignedTo);
    if (assignee && assignee.email && assignee.email_notifications) {
      sendNotification({
        to: assignee.email,
        toName: assignee.full_name,
        subject: `[${existing.number}] Assigned to you: ${b.short_description}`,
        html: `<p>Hi ${escapeHtml(assignee.full_name)},</p><p>Incident <strong>${existing.number}</strong> has been assigned to you.</p>
          <p><strong>${escapeHtml(b.short_description)}</strong></p>
          <p>Priority: P${priority} — ${PRIORITY_LABELS[priority]}</p>`,
        relatedType: 'incident',
        relatedId: existing.id
      }).catch(() => {});
    }
  }

  if (status !== existing.status) {
    await notifyWatchers('incident', existing.id, {
      subject: `[${existing.number}] Status changed: ${INCIDENT_STATUS_LABELS[status]}`,
      html: `<p>Incident <strong>${existing.number}</strong> — <strong>${escapeHtml(b.short_description)}</strong></p>
        <p>Status changed from ${INCIDENT_STATUS_LABELS[existing.status]} to ${INCIDENT_STATUS_LABELS[status]}.</p>`,
      excludeUserId: actorId
    });
  }
  return { priority, status };
}

// A comment, or (staff only) an internal work note. Resolves the new comment's id.
async function addIncidentComment({ actor, incident, comment, isWorkNote }) {
  const info = await db.prepare(`
    INSERT INTO incident_comments (incident_id, user_id, comment, is_work_note)
    VALUES (?, ?, ?, ?)
    RETURNING id
  `).run(incident.id, actor.id, comment, isWorkNote ? 1 : 0);

  if (!isWorkNote) {
    await notifyWatchers('incident', incident.id, {
      subject: `[${incident.number}] New comment`,
      html: `<p>Incident <strong>${incident.number}</strong> — <strong>${escapeHtml(incident.short_description)}</strong></p>
        <p>${escapeHtml(actor.full_name)} commented:</p>
        <p>${escapeHtml(comment)}</p>`,
      excludeUserId: actor.id
    });
  }
  return info.lastInsertRowid;
}

module.exports = { createIncident, updateIncident, addIncidentComment, notifyOnCreate };
