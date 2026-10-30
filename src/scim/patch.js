// SCIM PATCH (RFC 7644 section 3.5.2) applied to the internal model of src/scim/resource.js.
//
// Written for how providers really send it: "Replace" with a capital, `active` as the text "False" (Microsoft Entra ID),
// paths like `emails[type eq "work"].value` and `name.givenName`, no path at all with an object whose keys are paths, and
// attributes NovaDesk does not store (title, phoneNumbers, ...) which are accepted and ignored rather than failing the
// whole sync. An attribute that is not a SCIM User attribute at all is an invalidPath error.
'use strict';
const R = require('./resource');
const { invalidPath, invalidValue, invalidSyntax, noTarget } = require('./errors');

// SCIM User attributes NovaDesk keeps nothing for: accepted, ignored.
const IGNORED = new Set([
  'nickname', 'profileurl', 'title', 'usertype', 'preferredlanguage', 'locale', 'timezone', 'phonenumbers', 'addresses', 'ims', 'photos',
  'x509certificates', 'entitlements', 'password', 'groups', 'meta', 'id', 'manager', 'employeenumber', 'costcenter', 'organization', 'division',
]);

// "emails[type eq \"work\"].value" -> { attr: 'emails', sub: 'value', filter: 'type eq "work"' }
function parsePath(path) {
  let p = String(path).trim();
  if (!p) throw invalidPath('The path is empty.');
  let ext = false;
  const em = /^urn:ietf:params:scim:schemas:extension:enterprise:2\.0:User(?::(.*))?$/i.exec(p);
  if (em) { ext = true; p = em[1] || ''; }
  else p = p.replace(/^urn:ietf:params:scim:schemas:core:2\.0:User:/i, '');
  if (!p) return { ext, attr: '', sub: null, filter: null };
  const m = /^([A-Za-z][A-Za-z0-9_]*)(?:\[([^\]]*)\])?(?:\.([A-Za-z][A-Za-z0-9_]*))?$/.exec(p) || (() => {
    const dotted = /^([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)$/.exec(p);
    return dotted ? [p, dotted[1], null, dotted[2]] : null;
  })();
  if (!m) throw invalidPath(`"${path}" is not a path NovaDesk understands.`);
  return { ext, attr: m[1].toLowerCase(), filter: m[2] === undefined ? null : m[2], sub: m[3] ? m[3].toLowerCase() : null };
}

// Applies one set (add or replace) of `value` at the path to the model; `current` is the model before this operation.
function setValue(model, p, value) {
  if (p.ext) {
    if (!p.attr) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidValue('The enterprise extension must be an object.');
      for (const [k, v] of Object.entries(value)) setValue(model, parsePath(`urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:${k}`), v);
      return;
    }
    if (p.attr === 'department') { model.department = R.str(value, 'department', { max: R.LIMITS.department }); return; }
    if (IGNORED.has(p.attr) || ['manager', 'employeenumber', 'costcenter', 'organization', 'division'].includes(p.attr)) return;
    throw invalidPath(`"${p.attr}" is not an attribute NovaDesk knows.`);
  }
  switch (p.attr) {
    case 'username':
      if (typeof value !== 'string') throw invalidValue('userName must be a string.');
      model.userName = R.checkUserName(value.trim()); return;
    case 'externalid': model.externalId = R.str(value, 'externalId', { max: R.LIMITS.externalId }); return;
    case 'displayname': { const s = R.str(value, 'displayName', { max: R.LIMITS.fullName }); if (s) model.fullName = s; return; }
    case 'active': model.active = R.bool(value); return;
    case 'name': {
      if (p.sub) {
        const parts = R.splitName(model.fullName);
        const v = R.str(value, `name.${p.sub}`, { max: R.LIMITS.fullName }) || '';
        if (p.sub === 'formatted') { if (v) model.fullName = v; return; }
        if (p.sub === 'givenname') { model.fullName = R.joinName(v, parts.familyName) || model.fullName; return; }
        if (p.sub === 'familyname') { model.fullName = R.joinName(parts.givenName, v) || model.fullName; return; }
        return;                                                          // middleName, honorificPrefix, ...: not kept
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidValue('name must be an object.');
      for (const [k, v] of Object.entries(value)) setValue(model, { ext: false, attr: 'name', sub: k.toLowerCase(), filter: null }, v);
      return;
    }
    case 'emails': {
      // NovaDesk keeps one email: whatever is written to emails (or one of its parts) becomes it.
      if (p.sub && p.sub !== 'value') return;                             // type, primary, display: not kept
      if (p.sub === 'value') { model.email = R.checkEmail(R.str(value, 'emails.value', { max: R.LIMITS.email })); return; }
      if (typeof value === 'string') { model.email = R.checkEmail(value.trim()); return; }
      if (value && typeof value === 'object' && !Array.isArray(value)) value = [value];
      model.email = R.checkEmail(R.pickEmail(value));
      return;
    }
    case 'roles': {
      if (p.sub) return;
      const picked = R.pickRole(typeof value === 'string' ? [{ value }] : (value && !Array.isArray(value) && typeof value === 'object' ? [value] : value));
      if (picked !== undefined) model.role = picked;
      return;
    }
    default:
      if (IGNORED.has(p.attr)) return;
      throw invalidPath(`"${p.attr}" is not an attribute NovaDesk knows.`);
  }
}

function removeValue(model, p) {
  if (p.ext) {
    if (!p.attr) { model.department = null; return; }
    if (p.attr === 'department') { model.department = null; return; }
    if (IGNORED.has(p.attr) || ['manager', 'employeenumber', 'costcenter', 'organization', 'division'].includes(p.attr)) return;
    throw invalidPath(`"${p.attr}" is not an attribute NovaDesk knows.`);
  }
  switch (p.attr) {
    case 'username': throw noTarget('userName cannot be removed.');
    case 'active': throw noTarget('active cannot be removed; set it to false instead.');
    case 'displayname': return;                                           // a person always has a name
    case 'name': return;
    case 'externalid': model.externalId = null; return;
    case 'emails': if (!p.sub || p.sub === 'value') model.email = null; return;
    case 'roles': return;                                                 // a person always has a role; it stays as it is
    default:
      if (IGNORED.has(p.attr)) return;
      throw invalidPath(`"${p.attr}" is not an attribute NovaDesk knows.`);
  }
}

// Returns a new model: `current` with the operations applied, in order. Throws a ScimError for a bad request.
function applyPatch(body, current) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalidSyntax('The body must be a SCIM PatchOp.');
  if (Array.isArray(body.schemas) && !body.schemas.includes(R.PATCH_OP)) throw invalidSyntax(`schemas must include ${R.PATCH_OP}.`);
  const ops = body.Operations || body.operations;
  if (!Array.isArray(ops) || !ops.length) throw invalidSyntax('Operations must be a list with at least one operation.');
  if (ops.length > 100) throw invalidSyntax('At most 100 operations in one request.');
  const model = { ...current };
  for (const op of ops) {
    if (!op || typeof op !== 'object') throw invalidSyntax('Each operation must be an object.');
    const kind = String(op.op || '').toLowerCase();
    if (!['add', 'replace', 'remove'].includes(kind)) throw invalidSyntax(`"${op.op}" is not an operation (add, replace, remove).`);
    if (kind === 'remove') {
      if (op.path === undefined || op.path === null || op.path === '') throw noTarget('A remove operation needs a path.');
      removeValue(model, parsePath(op.path));
      continue;
    }
    if (op.value === undefined) throw invalidValue(`A ${kind} operation needs a value.`);
    if (op.path === undefined || op.path === null || op.path === '') {
      if (!op.value || typeof op.value !== 'object' || Array.isArray(op.value)) throw invalidValue(`A ${kind} operation without a path needs an object as its value.`);
      for (const [k, v] of Object.entries(op.value)) {
        if (/^urn:ietf:params:scim:schemas:extension:enterprise:2\.0:User$/i.test(k)) { setValue(model, parsePath(k), v); continue; }
        setValue(model, parsePath(k), v);
      }
      continue;
    }
    setValue(model, parsePath(op.path), op.value);
  }
  return model;
}

module.exports = { applyPatch, parsePath, IGNORED };
