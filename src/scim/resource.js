// The two-way mapping between a NovaDesk person and a SCIM User (RFC 7643 section 4.1), kept free of the database so it
// can be tested alone. NovaDesk stores one name (full_name), one email, one role and one department; SCIM's richer
// shapes are reduced to those on the way in and rebuilt on the way out.
//
// The internal model, used throughout src/scim: { userName, externalId, fullName, email, active, role, department }.
// On the way in a field that is `undefined` was not mentioned (leave it alone); null means "clear it".
'use strict';
const { invalidValue, invalidSyntax } = require('./errors');

const CORE_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const ENTERPRISE_USER = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
const CORE_GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST_RESPONSE = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const PATCH_OP = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

const ROLES = ['admin', 'agent', 'user'];
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@+-]{1,63}$/;
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const LIMITS = { fullName: 200, email: 254, department: 200, externalId: 200 };

// The "2026-10-30 03:15:09" text NovaDesk stores, as the ISO 8601 time SCIM wants.
const iso = (s) => (s ? `${String(s).replace(' ', 'T')}Z` : undefined);

const str = (v, label, { max, allowEmpty = false } = {}) => {
  if (v === null) return null;
  if (typeof v !== 'string') throw invalidValue(`${label} must be a string.`);
  const s = v.trim();
  if (!s) { if (allowEmpty) return null; return null; }
  if (max && s.length > max) throw invalidValue(`${label} is longer than ${max} characters.`);
  return s;
};

// Booleans as the providers actually send them: Microsoft Entra ID sends "True" and "False" as text.
function bool(v, label = 'active') {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string' && /^(true|false)$/i.test(v.trim())) return v.trim().toLowerCase() === 'true';
  throw invalidValue(`${label} must be true or false.`);
}

function role(v) {
  const s = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
  if (!ROLES.includes(s)) throw invalidValue(`"${v}" is not a role NovaDesk has (${ROLES.join(', ')}).`);
  return s;
}

// A name in parts, as NovaDesk holds it: one string. "Jane" + "Doe" -> "Jane Doe".
const joinName = (given, family) => [given, family].map((s) => (s || '').trim()).filter(Boolean).join(' ') || null;
// And back: the first word is the given name, the rest the family name (NovaDesk keeps only the whole).
function splitName(full) {
  const s = String(full || '').trim();
  const i = s.indexOf(' ');
  return i < 0 ? { givenName: s, familyName: '' } : { givenName: s.slice(0, i), familyName: s.slice(i + 1).trim() };
}

// The email to keep out of a list: the primary one, else a work one, else the first.
function pickEmail(list) {
  if (!Array.isArray(list)) throw invalidValue('emails must be a list.');
  const items = list.map((e) => (typeof e === 'string' ? { value: e } : e)).filter((e) => e && typeof e === 'object' && e.value);
  if (!items.length) return null;
  const best = items.find((e) => e.primary === true || e.primary === 'true' || e.primary === 'True') || items.find((e) => String(e.type || '').toLowerCase() === 'work') || items[0];
  return String(best.value).trim();
}

function pickRole(list) {
  if (!Array.isArray(list)) throw invalidValue('roles must be a list.');
  const items = list.map((r) => (typeof r === 'string' ? { value: r } : r)).filter((r) => r && typeof r === 'object' && (r.value || r.display));
  if (!items.length) return undefined;
  const best = items.find((r) => r.primary === true || r.primary === 'true' || r.primary === 'True') || items[0];
  return role(best.value || best.display);
}

function checkEmail(email) {
  if (email === null || email === undefined) return email;
  if (!EMAIL_RE.test(email) || email.length > LIMITS.email) throw invalidValue(`"${email}" is not an email address.`);
  return email;
}
function checkUserName(name) {
  if (!USERNAME_RE.test(name)) throw invalidValue('userName can only hold letters, digits and . _ - @ + (2 to 64 characters, starting with a letter or digit).');
  return name;
}

// A request body (POST or PUT) to the internal model. `userName` is required.
function parseUser(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalidSyntax('The body must be a JSON object holding a SCIM User.');
  if (Array.isArray(body.schemas) && body.schemas.length && !body.schemas.includes(CORE_USER)) throw invalidSyntax(`schemas must include ${CORE_USER}.`);
  const out = {};
  if (body.userName === undefined || body.userName === null || typeof body.userName !== 'string' || !body.userName.trim()) throw invalidValue('userName is required.');
  out.userName = checkUserName(body.userName.trim());
  if (body.externalId !== undefined) out.externalId = str(body.externalId, 'externalId', { max: LIMITS.externalId });
  const name = body.name;
  if (name !== undefined && name !== null && (typeof name !== 'object' || Array.isArray(name))) throw invalidValue('name must be an object.');
  const display = body.displayName !== undefined ? str(body.displayName, 'displayName', { max: LIMITS.fullName }) : undefined;
  const formatted = name && name.formatted !== undefined ? str(name.formatted, 'name.formatted', { max: LIMITS.fullName }) : undefined;
  const parts = name ? joinName(str(name.givenName ?? '', 'name.givenName'), str(name.familyName ?? '', 'name.familyName')) : null;
  out.fullName = display || formatted || parts || undefined;
  if (out.fullName && out.fullName.length > LIMITS.fullName) throw invalidValue(`The name is longer than ${LIMITS.fullName} characters.`);
  if (body.emails !== undefined) out.email = checkEmail(body.emails === null ? null : pickEmail(body.emails));
  if (body.active !== undefined) out.active = bool(body.active);
  if (body.roles !== undefined) { const r = body.roles === null ? undefined : pickRole(body.roles); if (r !== undefined) out.role = r; }
  const ext = body[ENTERPRISE_USER];
  if (ext !== undefined && ext !== null) {
    if (typeof ext !== 'object' || Array.isArray(ext)) throw invalidValue(`${ENTERPRISE_USER} must be an object.`);
    if (ext.department !== undefined) out.department = str(ext.department, 'department', { max: LIMITS.department });
  }
  return out;
}

// A NovaDesk person (a users row, with `groups` = [{ id, name }] added by the caller) as a SCIM User.
function toScim(row, { baseUrl = '', groups = [] } = {}) {
  const { givenName, familyName } = splitName(row.full_name);
  const location = `${baseUrl}/Users/${row.id}`;
  const out = {
    schemas: [CORE_USER, ENTERPRISE_USER],
    id: String(row.id),
    ...(row.scim_external_id ? { externalId: row.scim_external_id } : {}),
    userName: row.username,
    name: { formatted: row.full_name, givenName, ...(familyName ? { familyName } : {}) },
    displayName: row.full_name,
    active: Boolean(row.active),
    ...(row.email ? { emails: [{ value: row.email, type: 'work', primary: true }] } : {}),
    roles: [{ value: row.role, primary: true }],
    groups: groups.map((g) => ({ value: g.id, display: g.name, $ref: `${baseUrl}/Groups/${g.id}` })),
    [ENTERPRISE_USER]: row.department ? { department: row.department } : {},
    meta: { resourceType: 'User', created: iso(row.created_at), lastModified: iso(row.scim_updated_at || row.created_at), location },
  };
  return out;
}

// ?attributes= and ?excludedAttributes= (RFC 7644 section 3.4.2.5). Always kept: schemas, id.
function project(resource, { attributes, excludedAttributes } = {}) {
  const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  const inc = list(attributes); const exc = list(excludedAttributes);
  if (!inc.length && !exc.length) return resource;
  const out = {};
  const top = (k) => k.toLowerCase();
  for (const [k, v] of Object.entries(resource)) {
    if (k === 'schemas' || k === 'id') { out[k] = v; continue; }
    const key = top(k);
    if (inc.length) {
      const hit = inc.some((a) => top(a) === key || top(a).startsWith(`${key}.`));
      if (!hit) continue;
      if (v && typeof v === 'object' && !Array.isArray(v) && !inc.some((a) => top(a) === key)) {
        const sub = {}; for (const [sk, sv] of Object.entries(v)) if (inc.some((a) => top(a) === `${key}.${sk.toLowerCase()}`)) sub[sk] = sv;
        out[k] = sub; continue;
      }
    }
    if (exc.some((a) => top(a) === key)) continue;
    out[k] = v;
  }
  return out;
}

module.exports = { CORE_USER, ENTERPRISE_USER, CORE_GROUP, LIST_RESPONSE, PATCH_OP, ROLES, USERNAME_RE, EMAIL_RE, LIMITS, iso, bool, role, str, joinName, splitName, pickEmail, pickRole, checkEmail, checkUserName, parseUser, toScim, project };
