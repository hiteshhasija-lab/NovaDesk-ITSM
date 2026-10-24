// The REST API's resources. Reads and writes go through the same functions the pages use (incidentActions,
// requestActions, cmdbActions), so an incident created or changed through the API gets its SLA clock, activity
// entries and emails exactly as one made in the browser.
'use strict';
const { db } = require('../db');
const { slaStatus, requestSlaStatus, changeSlaStatus } = require('../helpers');
const incidentActions = require('../incidentActions');
const requestActions = require('../requestActions');
const cmdbActions = require('../cmdbActions');
const { respond, notFound, forbidden, unprocessable, PAGING, paging, iso, idParam } = require('./core');

const STAFF = ['admin', 'agent'];
const isStaff = (user) => STAFF.includes(user.role);
const INCIDENT_STATUSES = ['new', 'in_progress', 'on_hold', 'resolved', 'closed', 'cancelled'];
const REQUEST_STATUSES = ['submitted', 'in_progress', 'fulfilled', 'rejected', 'cancelled'];
const CHANGE_STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'scheduled', 'in_progress', 'implemented', 'closed', 'cancelled'];
const PROBLEM_STATUSES = ['new', 'investigating', 'known_error', 'resolved', 'closed'];
const CI_TYPES = ['server', 'network_device', 'application', 'database', 'workstation', 'storage'];
const CI_STATUSES = ['in_use', 'in_stock', 'maintenance', 'retired'];
const ENVIRONMENTS = ['production', 'staging', 'uat', 'development', 'dr'];
const CATEGORIES = ['hardware', 'software', 'network', 'access', 'other'];

const publicUrl = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
const htmlUrl = (path) => (publicUrl ? `${publicUrl}${path}` : null);
const ref = (id, name) => (id ? { id, name: name || null } : null);

const slaOut = (row, state) => (row.sla_due_at ? { due_at: iso(row.sla_due_at), status: state.key, target_minutes: row.sla_target_minutes || null, clock: row.sla_clock || null, paused: Boolean(row.sla_paused_at) } : null);

// ---------------------------------------------------------------- serializers (the documented shapes)
const incidentOut = (r) => ({
  id: r.id, number: r.number, short_description: r.short_description, description: r.description, category: r.category, subcategory: r.subcategory,
  impact: r.impact, urgency: r.urgency, priority: r.priority, status: r.status,
  caller: ref(r.caller_id, r.caller_name), assigned_to: ref(r.assigned_to, r.assigned_name), assignment_group: r.assignment_group,
  affected_ci_id: r.affected_ci_id, problem_id: r.problem_id, resolution_notes: r.resolution_notes,
  created_at: iso(r.created_at), updated_at: iso(r.updated_at), resolved_at: iso(r.resolved_at), closed_at: iso(r.closed_at),
  sla: slaOut(r, slaStatus(r)), html_url: htmlUrl(`/incidents/${r.id}`),
});
const requestOut = (r) => ({
  id: r.id, number: r.number, status: r.status, catalog_item: ref(r.catalog_item_id, r.item_name), requested_by: ref(r.requested_by, r.requester_name),
  assigned_to: ref(r.assigned_to, r.assigned_name), assignment_group: r.assignment_group, notes: r.notes,
  created_at: iso(r.created_at), updated_at: iso(r.updated_at), fulfilled_at: iso(r.fulfilled_at),
  sla: slaOut(r, requestSlaStatus(r)), html_url: htmlUrl(`/requests/${r.id}`),
});
const changeOut = (r) => ({
  id: r.id, number: r.number, short_description: r.short_description, description: r.description, change_type: r.change_type, risk: r.risk,
  status: r.status, approval_status: r.approval_status, requested_by: ref(r.requested_by, r.requester_name), assigned_to: ref(r.assigned_to, r.assigned_name),
  assignment_group: r.assignment_group, affected_ci_id: r.affected_ci_id, planned_start: r.planned_start, planned_end: r.planned_end,
  created_at: iso(r.created_at), updated_at: iso(r.updated_at), closed_at: iso(r.closed_at),
  approval_sla: slaOut(r, changeSlaStatus(r)), html_url: htmlUrl(`/changes/${r.id}`),
});
const problemOut = (r) => ({
  id: r.id, number: r.number, short_description: r.short_description, description: r.description, status: r.status, priority: r.priority,
  root_cause: r.root_cause, workaround: r.workaround, affected_ci_id: r.affected_ci_id, raised_by: ref(r.raised_by, r.raiser_name), assigned_to: ref(r.assigned_to, r.assigned_name),
  assignment_group: r.assignment_group, created_at: iso(r.created_at), updated_at: iso(r.updated_at), resolved_at: iso(r.resolved_at), closed_at: iso(r.closed_at),
  html_url: htmlUrl(`/problems/${r.id}`),
});
const ciOut = (r) => ({
  id: r.id, ci_number: r.ci_number, name: r.name, ci_type: r.ci_type, environment: r.environment, status: r.status, ip_address: r.ip_address, os: r.os,
  manufacturer: r.manufacturer, model: r.model, serial_number: r.serial_number, location: r.location, owner: ref(r.owner_id, r.owner_name), support_group: r.support_group,
  cpu: r.cpu, ram: r.ram, disk: r.disk, purchase_date: r.purchase_date, warranty_expiry: r.warranty_expiry, install_date: r.install_date, notes: r.notes,
  created_at: iso(r.created_at), updated_at: iso(r.updated_at), html_url: htmlUrl(`/cmdb/${r.id}`),
});
const articleOut = (r, withBody) => ({
  id: r.id, number: r.number, title: r.title, category: r.category, status: r.status, author: ref(r.author_id, r.author_name), view_count: r.view_count,
  ...(withBody ? { body: r.body } : { summary: String(r.body || '').replace(/\s+/g, ' ').slice(0, 200) }),
  created_at: iso(r.created_at), updated_at: iso(r.updated_at), html_url: htmlUrl(`/kb/${r.id}`),
});
const userOut = (r) => ({ id: r.id, username: r.username, full_name: r.full_name, email: r.email, role: r.role, department: r.department, active: Boolean(r.active) });
const commentOut = (r) => ({ id: r.id, comment: r.comment, work_note: Boolean(r.is_work_note), author: ref(r.user_id, r.author_name), created_at: iso(r.created_at) });

const list = (rows, total, p, map) => respond({ data: rows.map(map), page: p.page, per_page: p.perPage, total }, { headers: { 'X-Total-Count': String(total) } });
const like = (q) => `%${String(q).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

async function mustUser(id, field, { staffOnly = false } = {}) {
  const u = await db.prepare('SELECT id, role FROM users WHERE id = ? AND active = 1').get(id);
  if (!u || (staffOnly && !STAFF.includes(u.role))) throw unprocessable(`${field} ${id} is not ${staffOnly ? 'an active agent or administrator' : 'an active user'}.`, [{ field, message: 'does not refer to a usable user' }]);
}
async function mustExist(table, id, field) {
  if (!(await db.prepare(`SELECT 1 AS ok FROM ${table} WHERE id = ?`).get(id))) throw unprocessable(`${field} ${id} does not exist.`, [{ field, message: 'does not exist' }]);
}

function register(api) {
  const { route } = api;

  // ---------------------------------------------------------------- me, users
  route('GET', '/me', { tag: 'Account', summary: 'The person this API key acts as', scope: 'read', response: 'Me' },
    async (req) => ({ id: req.api.user.id, username: req.api.user.username, full_name: req.api.user.full_name, email: req.api.user.email, role: req.api.user.role, key: req.api.key }));

  route('GET', '/users', { tag: 'Account', summary: 'List people (agents and administrators only)', description: 'Useful for finding the id to assign an incident to.', scope: 'read', roles: STAFF, response: 'UserList',
    query: { q: { type: 'string', max: 100, description: 'Matches name, username or email.' }, role: { type: 'enum', values: ['admin', 'agent', 'user'] }, active: { type: 'enum', values: ['true', 'false'], description: 'Default: active people only.' }, ...PAGING } },
  async (req, { query }) => {
    const where = ['1=1']; const params = [];
    where.push(`active = ${query.active === 'false' ? 0 : 1}`);
    if (query.role) { where.push('role = ?'); params.push(query.role); }
    if (query.q) { where.push("(full_name ILIKE ? OR username ILIKE ? OR email ILIKE ?)"); const l = like(query.q); params.push(l, l, l); }
    const p = paging(query);
    const total = Number((await db.prepare(`SELECT COUNT(*) AS c FROM users WHERE ${where.join(' AND ')}`).get(...params)).c);
    const rows = await db.prepare(`SELECT id, username, full_name, email, role, department, active FROM users WHERE ${where.join(' AND ')} ORDER BY id LIMIT ? OFFSET ?`).all(...params, p.perPage, p.offset);
    return list(rows, total, p, userOut);
  });

  // ---------------------------------------------------------------- incidents
  const INCIDENT_SELECT = `SELECT i.*, cu.full_name AS caller_name, au.full_name AS assigned_name FROM incidents i
    LEFT JOIN users cu ON cu.id = i.caller_id LEFT JOIN users au ON au.id = i.assigned_to`;
  const loadIncident = async (req, id) => {
    const row = await db.prepare(`${INCIDENT_SELECT} WHERE i.id = ?`).get(id);
    if (!row || (!isStaff(req.api.user) && row.caller_id !== req.api.user.id)) throw notFound('Incident');
    return row;
  };
  const INCIDENT_FIELDS = {
    short_description: { type: 'string', max: 200, description: 'One line saying what is wrong.' },
    description: { type: 'string', max: 10000, nullable: true },
    category: { type: 'enum', values: CATEGORIES, description: 'Default: other.' },
    subcategory: { type: 'string', max: 100, nullable: true },
    impact: { type: 'integer', min: 1, max: 3, description: '1 high, 2 medium, 3 low (default 3). With urgency it sets the priority.' },
    urgency: { type: 'integer', min: 1, max: 3, description: '1 high, 2 medium, 3 low (default 3).' },
    assignment_group: { type: 'string', max: 100, nullable: true },
    affected_ci_id: { type: 'integer', min: 1, nullable: true, description: 'A configuration item id.' },
  };

  route('GET', '/incidents', { tag: 'Incidents', summary: 'List incidents', description: 'End users see only incidents they raised; agents and administrators see all.', scope: 'read', response: 'IncidentList',
    query: { status: { type: 'enum', values: [...INCIDENT_STATUSES, 'open'], description: '"open" means not resolved, closed or cancelled.' }, priority: { type: 'integer', min: 1, max: 4 },
      assigned_to: { type: 'integer', min: 1 }, caller_id: { type: 'integer', min: 1, description: 'Agents and administrators only.' }, q: { type: 'string', max: 100, description: 'Matches number, short description and description.' }, ...PAGING } },
  async (req, { query }) => {
    const where = ['1=1']; const params = [];
    if (!isStaff(req.api.user)) { where.push('i.caller_id = ?'); params.push(req.api.user.id); } else if (query.caller_id) { where.push('i.caller_id = ?'); params.push(query.caller_id); }
    if (query.status === 'open') where.push("i.status NOT IN ('resolved','closed','cancelled')"); else if (query.status) { where.push('i.status = ?'); params.push(query.status); }
    if (query.priority) { where.push('i.priority = ?'); params.push(query.priority); }
    if (query.assigned_to) { where.push('i.assigned_to = ?'); params.push(query.assigned_to); }
    if (query.q) { where.push('(i.number ILIKE ? OR i.short_description ILIKE ? OR i.description ILIKE ?)'); const l = like(query.q); params.push(l, l, l); }
    const p = paging(query);
    const total = Number((await db.prepare(`SELECT COUNT(*) AS c FROM incidents i WHERE ${where.join(' AND ')}`).get(...params)).c);
    const rows = await db.prepare(`${INCIDENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY i.id DESC LIMIT ? OFFSET ?`).all(...params, p.perPage, p.offset);
    return list(rows, total, p, incidentOut);
  });

  route('GET', '/incidents/:id', { tag: 'Incidents', summary: 'Get an incident', scope: 'read', response: 'Incident' },
    async (req) => incidentOut(await loadIncident(req, idParam(req))));

  route('POST', '/incidents', { tag: 'Incidents', summary: 'Create an incident', description: 'Send an Idempotency-Key header to make a retry safe. Agents and administrators may also set caller_id and assigned_to; for end users the caller is always themselves.', scope: 'write', status: 201, response: 'Incident',
    body: { ...INCIDENT_FIELDS, short_description: { ...INCIDENT_FIELDS.short_description, required: true },
      caller_id: { type: 'integer', min: 1, description: 'Agents and administrators only. Default: the key\'s owner.' },
      assigned_to: { type: 'integer', min: 1, nullable: true, description: 'Agents and administrators only: an active agent or administrator.' } } },
  async (req, { body }) => {
    const staff = isStaff(req.api.user);
    if (!staff && (body.caller_id !== undefined || body.assigned_to !== undefined)) throw forbidden('Only agents and administrators can set caller_id or assigned_to.');
    if (body.caller_id) await mustUser(body.caller_id, 'caller_id');
    if (body.assigned_to) await mustUser(body.assigned_to, 'assigned_to', { staffOnly: true });
    if (body.affected_ci_id) await mustExist('cmdb_ci', body.affected_ci_id, 'affected_ci_id');
    const created = await incidentActions.createIncident({ actor: req.api.user, fields: { ...body, caller_id: staff ? (body.caller_id || req.api.user.id) : req.api.user.id, assigned_to: staff ? body.assigned_to : null } });
    return respond(incidentOut(await loadIncident(req, created.id)), { status: 201, headers: { Location: `/api/v1/incidents/${created.id}` } });
  });

  route('PATCH', '/incidents/:id', { tag: 'Incidents', summary: 'Change an incident', description: 'Send only the fields to change. Moving to On Hold stops the SLA clock; a new impact or urgency recalculates the priority and the SLA target.', scope: 'write', roles: STAFF, response: 'Incident', partialBody: true,
    body: { ...INCIDENT_FIELDS, status: { type: 'enum', values: INCIDENT_STATUSES }, resolution_notes: { type: 'string', max: 10000, nullable: true },
      assigned_to: { type: 'integer', min: 1, nullable: true, description: 'An active agent or administrator; null unassigns.' }, problem_id: { type: 'integer', min: 1, nullable: true } } },
  async (req, { body }) => {
    const existing = await loadIncident(req, idParam(req));
    if (body.assigned_to) await mustUser(body.assigned_to, 'assigned_to', { staffOnly: true });
    if (body.affected_ci_id) await mustExist('cmdb_ci', body.affected_ci_id, 'affected_ci_id');
    if (body.problem_id) await mustExist('problems', body.problem_id, 'problem_id');
    const keep = ['short_description', 'description', 'category', 'subcategory', 'impact', 'urgency', 'status', 'assigned_to', 'assignment_group', 'affected_ci_id', 'resolution_notes', 'problem_id'];
    const fields = Object.fromEntries(keep.map((k) => [k, Object.prototype.hasOwnProperty.call(body, k) ? body[k] : existing[k]]));
    await incidentActions.updateIncident({ actor: req.api.user, existing, fields });
    return incidentOut(await loadIncident(req, existing.id));
  });

  route('GET', '/incidents/:id/comments', { tag: 'Incidents', summary: 'List an incident\'s comments', description: 'Internal work notes are included for agents and administrators only.', scope: 'read', response: 'CommentList', query: { ...PAGING } },
    async (req, { query }) => {
      const incident = await loadIncident(req, idParam(req));
      const hideNotes = isStaff(req.api.user) ? '' : 'AND c.is_work_note = 0';
      const p = paging(query);
      const total = Number((await db.prepare(`SELECT COUNT(*) AS c FROM incident_comments c WHERE c.incident_id = ? ${hideNotes}`).get(incident.id)).c);
      const rows = await db.prepare(`SELECT c.*, u.full_name AS author_name FROM incident_comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.incident_id = ? ${hideNotes} ORDER BY c.id LIMIT ? OFFSET ?`).all(incident.id, p.perPage, p.offset);
      return list(rows, total, p, commentOut);
    });

  route('POST', '/incidents/:id/comments', { tag: 'Incidents', summary: 'Add a comment or an internal work note', scope: 'write', status: 201, response: 'Comment',
    body: { comment: { type: 'string', max: 10000, required: true }, work_note: { type: 'boolean', description: 'Internal note, hidden from the caller. Agents and administrators only.' } } },
  async (req, { body }) => {
    const incident = await loadIncident(req, idParam(req));
    if (body.work_note && !isStaff(req.api.user)) throw forbidden('Only agents and administrators can add work notes.');
    const id = await incidentActions.addIncidentComment({ actor: req.api.user, incident, comment: body.comment, isWorkNote: Boolean(body.work_note) });
    const row = await db.prepare('SELECT c.*, u.full_name AS author_name FROM incident_comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(id);
    return respond(commentOut(row), { status: 201 });
  });

  // ---------------------------------------------------------------- service requests
  const REQUEST_SELECT = `SELECT r.*, ci.name AS item_name, ru.full_name AS requester_name, au.full_name AS assigned_name FROM service_requests r
    LEFT JOIN catalog_items ci ON ci.id = r.catalog_item_id LEFT JOIN users ru ON ru.id = r.requested_by LEFT JOIN users au ON au.id = r.assigned_to`;
  const loadRequest = async (req, id) => {
    const row = await db.prepare(`${REQUEST_SELECT} WHERE r.id = ?`).get(id);
    if (!row || (!isStaff(req.api.user) && row.requested_by !== req.api.user.id)) throw notFound('Request');
    return row;
  };

  route('GET', '/catalog-items', { tag: 'Service requests', summary: 'List what can be requested', scope: 'read', response: 'CatalogItemList', query: { ...PAGING } },
    async (req, { query }) => {
      const p = paging(query);
      const total = Number((await db.prepare('SELECT COUNT(*) AS c FROM catalog_items WHERE active = 1').get()).c);
      const rows = await db.prepare('SELECT id, name, description, category, fulfillment_group FROM catalog_items WHERE active = 1 ORDER BY name LIMIT ? OFFSET ?').all(p.perPage, p.offset);
      return list(rows, total, p, (r) => ({ id: r.id, name: r.name, description: r.description, category: r.category, fulfillment_group: r.fulfillment_group }));
    });

  route('GET', '/requests', { tag: 'Service requests', summary: 'List service requests', description: 'End users see only their own.', scope: 'read', response: 'RequestList',
    query: { status: { type: 'enum', values: REQUEST_STATUSES }, catalog_item_id: { type: 'integer', min: 1 }, requested_by: { type: 'integer', min: 1, description: 'Agents and administrators only.' }, ...PAGING } },
  async (req, { query }) => {
    const where = ['1=1']; const params = [];
    if (!isStaff(req.api.user)) { where.push('r.requested_by = ?'); params.push(req.api.user.id); } else if (query.requested_by) { where.push('r.requested_by = ?'); params.push(query.requested_by); }
    if (query.status) { where.push('r.status = ?'); params.push(query.status); }
    if (query.catalog_item_id) { where.push('r.catalog_item_id = ?'); params.push(query.catalog_item_id); }
    const p = paging(query);
    const total = Number((await db.prepare(`SELECT COUNT(*) AS c FROM service_requests r WHERE ${where.join(' AND ')}`).get(...params)).c);
    const rows = await db.prepare(`${REQUEST_SELECT} WHERE ${where.join(' AND ')} ORDER BY r.id DESC LIMIT ? OFFSET ?`).all(...params, p.perPage, p.offset);
    return list(rows, total, p, requestOut);
  });

  route('GET', '/requests/:id', { tag: 'Service requests', summary: 'Get a service request', scope: 'read', response: 'Request' },
    async (req) => requestOut(await loadRequest(req, idParam(req))));

  route('POST', '/requests', { tag: 'Service requests', summary: 'Submit a service request', description: 'Send an Idempotency-Key header to make a retry safe.', scope: 'write', status: 201, response: 'Request',
    body: { catalog_item_id: { type: 'integer', min: 1, required: true }, notes: { type: 'string', max: 5000, nullable: true } } },
  async (req, { body }) => {
    const item = await db.prepare('SELECT * FROM catalog_items WHERE id = ? AND active = 1').get(body.catalog_item_id);
    if (!item) throw unprocessable(`catalog_item_id ${body.catalog_item_id} is not an item that can be requested.`, [{ field: 'catalog_item_id', message: 'does not refer to an active catalog item' }]);
    const created = await requestActions.createServiceRequest({ actor: req.api.user, item, notes: body.notes });
    return respond(requestOut(await loadRequest(req, created.id)), { status: 201, headers: { Location: `/api/v1/requests/${created.id}` } });
  });

  route('PATCH', '/requests/:id', { tag: 'Service requests', summary: 'Change a service request', scope: 'write', roles: STAFF, response: 'Request', partialBody: true,
    body: { status: { type: 'enum', values: REQUEST_STATUSES }, assigned_to: { type: 'integer', min: 1, nullable: true }, assignment_group: { type: 'string', max: 100, nullable: true } } },
  async (req, { body }) => {
    const existing = await loadRequest(req, idParam(req));
    if (body.assigned_to) await mustUser(body.assigned_to, 'assigned_to', { staffOnly: true });
    const fields = { status: body.status || existing.status,
      assigned_to: Object.prototype.hasOwnProperty.call(body, 'assigned_to') ? body.assigned_to : existing.assigned_to,
      assignment_group: Object.prototype.hasOwnProperty.call(body, 'assignment_group') ? body.assignment_group : existing.assignment_group };
    await requestActions.updateServiceRequest({ actor: req.api.user, existing, fields });
    return requestOut(await loadRequest(req, existing.id));
  });

  // ---------------------------------------------------------------- changes and problems (read-only)
  const CHANGE_SELECT = `SELECT c.*, ru.full_name AS requester_name, au.full_name AS assigned_name FROM changes c
    LEFT JOIN users ru ON ru.id = c.requested_by LEFT JOIN users au ON au.id = c.assigned_to`;
  route('GET', '/changes', { tag: 'Changes', summary: 'List changes (read-only)', description: 'Approving, rejecting and cancelling a change follow their own rules (including the decommission workflow) and stay in the NovaDesk pages.', scope: 'read', roles: STAFF, response: 'ChangeList',
    query: { status: { type: 'enum', values: CHANGE_STATUSES }, q: { type: 'string', max: 100 }, ...PAGING } },
  async (req, { query }) => {
    const where = ['1=1']; const params = [];
    if (query.status) { where.push('c.status = ?'); params.push(query.status); }
    if (query.q) { where.push('(c.number ILIKE ? OR c.short_description ILIKE ?)'); const l = like(query.q); params.push(l, l); }
    const p = paging(query);
    const total = Number((await db.prepare(`SELECT COUNT(*) AS c FROM changes c WHERE ${where.join(' AND ')}`).get(...params)).c);
    const rows = await db.prepare(`${CHANGE_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.id DESC LIMIT ? OFFSET ?`).all(...params, p.perPage, p.offset);
    return list(rows, total, p, changeOut);
  });
  route('GET', '/changes/:id', { tag: 'Changes', summary: 'Get a change', scope: 'read', roles: STAFF, response: 'Change' },
    async (req) => { const row = await db.prepare(`${CHANGE_SELECT} WHERE c.id = ?`).get(idParam(req)); if (!row) throw notFound('Change'); return changeOut(row); });

  const PROBLEM_SELECT = `SELECT p.*, ru.full_name AS raiser_name, au.full_name AS assigned_name FROM problems p
    LEFT JOIN users ru ON ru.id = p.raised_by LEFT JOIN users au ON au.id = p.assigned_to`;
  route('GET', '/problems', { tag: 'Problems', summary: 'List problems (read-only)', scope: 'read', roles: STAFF, response: 'ProblemList',
    query: { status: { type: 'enum', values: PROBLEM_STATUSES }, q: { type: 'string', max: 100 }, ...PAGING } },
  async (req, { query }) => {
    const where = ['1=1']; const params = [];
    if (query.status) { where.push('p.status = ?'); params.push(query.status); }
    if (query.q) { where.push('(p.number ILIKE ? OR p.short_description ILIKE ?)'); const l = like(query.q); params.push(l, l); }
    const p = paging(query);
    const total = Number((await db.prepare(`SELECT COUNT(*) AS c FROM problems p WHERE ${where.join(' AND ')}`).get(...params)).c);
    const rows = await db.prepare(`${PROBLEM_SELECT} WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT ? OFFSET ?`).all(...params, p.perPage, p.offset);
    return list(rows, total, p, problemOut);
  });
  route('GET', '/problems/:id', { tag: 'Problems', summary: 'Get a problem', scope: 'read', roles: STAFF, response: 'Problem' },
    async (req) => { const row = await db.prepare(`${PROBLEM_SELECT} WHERE p.id = ?`).get(idParam(req)); if (!row) throw notFound('Problem'); return problemOut(row); });

  // ---------------------------------------------------------------- configuration items
  const CI_SELECT = 'SELECT c.*, u.full_name AS owner_name FROM cmdb_ci c LEFT JOIN users u ON u.id = c.owner_id';
  const CI_FIELDS = {
    name: { type: 'string', max: 200 }, ci_type: { type: 'enum', values: CI_TYPES }, environment: { type: 'enum', values: ENVIRONMENTS, description: 'Default: production.' },
    status: { type: 'enum', values: CI_STATUSES, description: 'Default: in_use.' }, ip_address: { type: 'string', max: 64, nullable: true }, os: { type: 'string', max: 100, nullable: true },
    manufacturer: { type: 'string', max: 100, nullable: true }, model: { type: 'string', max: 100, nullable: true }, serial_number: { type: 'string', max: 100, nullable: true },
    location: { type: 'string', max: 200, nullable: true }, owner_id: { type: 'integer', min: 1, nullable: true }, support_group: { type: 'string', max: 100, nullable: true },
    cpu: { type: 'string', max: 100, nullable: true }, ram: { type: 'string', max: 100, nullable: true }, disk: { type: 'string', max: 100, nullable: true },
    purchase_date: { type: 'date', nullable: true }, warranty_expiry: { type: 'date', nullable: true }, install_date: { type: 'date', nullable: true }, notes: { type: 'string', max: 5000, nullable: true },
  };
  route('GET', '/cis', { tag: 'Configuration items', summary: 'List configuration items', scope: 'read', response: 'CiList',
    query: { ci_type: { type: 'enum', values: CI_TYPES }, status: { type: 'enum', values: CI_STATUSES }, environment: { type: 'enum', values: ENVIRONMENTS }, q: { type: 'string', max: 100, description: 'Matches number, name, address and serial number.' }, ...PAGING } },
  async (req, { query }) => {
    const where = ['1=1']; const params = [];
    for (const f of ['ci_type', 'status', 'environment']) if (query[f]) { where.push(`c.${f} = ?`); params.push(query[f]); }
    if (query.q) { where.push('(c.ci_number ILIKE ? OR c.name ILIKE ? OR c.ip_address ILIKE ? OR c.serial_number ILIKE ?)'); const l = like(query.q); params.push(l, l, l, l); }
    const p = paging(query);
    const total = Number((await db.prepare(`SELECT COUNT(*) AS c FROM cmdb_ci c WHERE ${where.join(' AND ')}`).get(...params)).c);
    const rows = await db.prepare(`${CI_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.id DESC LIMIT ? OFFSET ?`).all(...params, p.perPage, p.offset);
    return list(rows, total, p, ciOut);
  });
  route('GET', '/cis/:id', { tag: 'Configuration items', summary: 'Get a configuration item', scope: 'read', response: 'Ci' },
    async (req) => { const row = await db.prepare(`${CI_SELECT} WHERE c.id = ?`).get(idParam(req)); if (!row) throw notFound('Configuration item'); return ciOut(row); });
  route('POST', '/cis', { tag: 'Configuration items', summary: 'Create a configuration item', description: 'Send an Idempotency-Key header to make a retry safe.', scope: 'write', roles: STAFF, status: 201, response: 'Ci',
    body: { ...CI_FIELDS, name: { ...CI_FIELDS.name, required: true }, ci_type: { ...CI_FIELDS.ci_type, required: true } } },
  async (req, { body }) => {
    if (body.owner_id) await mustUser(body.owner_id, 'owner_id');
    const created = await cmdbActions.createCi({ actor: req.api.user, fields: body });
    return respond(ciOut(await db.prepare(`${CI_SELECT} WHERE c.id = ?`).get(created.id)), { status: 201, headers: { Location: `/api/v1/cis/${created.id}` } });
  });
  route('PATCH', '/cis/:id', { tag: 'Configuration items', summary: 'Change a configuration item', scope: 'write', roles: STAFF, response: 'Ci', partialBody: true, body: CI_FIELDS },
    async (req, { body }) => {
      const existing = await db.prepare('SELECT * FROM cmdb_ci WHERE id = ?').get(idParam(req));
      if (!existing) throw notFound('Configuration item');
      if (body.owner_id) await mustUser(body.owner_id, 'owner_id');
      const fields = Object.fromEntries(cmdbActions.CI_COLUMNS.map((k) => [k, Object.prototype.hasOwnProperty.call(body, k) ? body[k] : existing[k]]));
      await cmdbActions.updateCi({ existing, fields });
      return ciOut(await db.prepare(`${CI_SELECT} WHERE c.id = ?`).get(existing.id));
    });

  // ---------------------------------------------------------------- knowledge base
  const KB_SELECT = 'SELECT k.*, u.full_name AS author_name FROM kb_articles k LEFT JOIN users u ON u.id = k.author_id';
  route('GET', '/articles', { tag: 'Knowledge base', summary: 'List knowledge articles', description: 'End users see published articles only.', scope: 'read', response: 'ArticleList',
    query: { q: { type: 'string', max: 100, description: 'Matches title and text.' }, category: { type: 'string', max: 50 }, status: { type: 'enum', values: ['draft', 'published'], description: 'Agents and administrators only.' }, ...PAGING } },
  async (req, { query }) => {
    const where = ['1=1']; const params = [];
    if (!isStaff(req.api.user)) where.push("k.status = 'published'"); else if (query.status) { where.push('k.status = ?'); params.push(query.status); }
    if (query.category) { where.push('k.category = ?'); params.push(query.category); }
    if (query.q) { where.push('(k.title ILIKE ? OR k.body ILIKE ? OR k.number ILIKE ?)'); const l = like(query.q); params.push(l, l, l); }
    const p = paging(query);
    const total = Number((await db.prepare(`SELECT COUNT(*) AS c FROM kb_articles k WHERE ${where.join(' AND ')}`).get(...params)).c);
    const rows = await db.prepare(`${KB_SELECT} WHERE ${where.join(' AND ')} ORDER BY k.id DESC LIMIT ? OFFSET ?`).all(...params, p.perPage, p.offset);
    return list(rows, total, p, (r) => articleOut(r, false));
  });
  route('GET', '/articles/:id', { tag: 'Knowledge base', summary: 'Get a knowledge article', scope: 'read', response: 'Article' },
    async (req) => {
      const row = await db.prepare(`${KB_SELECT} WHERE k.id = ?`).get(idParam(req));
      if (!row || (!isStaff(req.api.user) && row.status !== 'published')) throw notFound('Article');
      return articleOut(row, true);
    });
}

module.exports = { register, INCIDENT_STATUSES, REQUEST_STATUSES };
