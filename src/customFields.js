// Custom fields: what an administrator adds to incidents, service requests, changes, problems and configuration items
// (tables custom_fields and custom_field_values, migration 0013). This module is the one place that knows how a field is
// defined, how a typed-in value is checked and stored, and how it is shown, so the pages, the REST API and the CSV
// exports all treat it the same way.
//
// A value is stored as text: text and textarea as typed (trimmed); number in its plain decimal form; date as YYYY-MM-DD;
// select as the option's value; checkbox as "true" or "false". An empty value is not stored at all.
// Who sees a field: `audience` is 'everyone' (anyone who can see the record) or 'staff' (agents and administrators).
// A field that is switched off is hidden everywhere, and its values are kept.
'use strict';
const { db, nowStr, logActivity } = require('./db');

const ENTITIES = {
  incident: { label: 'Incidents', noun: 'incident', table: 'incidents' },
  request: { label: 'Service requests', noun: 'service request', table: 'service_requests' },
  change: { label: 'Changes', noun: 'change', table: 'changes' },
  problem: { label: 'Problems', noun: 'problem', table: 'problems' },
  ci: { label: 'Configuration items', noun: 'configuration item', table: 'cmdb_ci' },
};
const TYPES = {
  text: { label: 'Text (one line)' },
  textarea: { label: 'Text (several lines)' },
  number: { label: 'Number' },
  date: { label: 'Date' },
  select: { label: 'Choice from a list' },
  checkbox: { label: 'Yes / no' },
};
const LIMITS = { label: 60, help: 200, text: 255, textarea: 4000, options: 50, optionLabel: 60, perEntity: 30, total: 100 };
const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const OPTION_VALUE_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const isStaff = (role) => role === 'admin' || role === 'agent';

class FieldError extends Error {}

// "Cost centre" -> "cost_centre"
const keyFromLabel = (label) => String(label || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[0-9_]+/, '').slice(0, 40);
const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// ---------------------------------------------------------------- definitions
const parseOptions = (text) => { try { const v = JSON.parse(text || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const shape = (row) => ({
  id: row.id, entityType: row.entity_type, key: row.key, label: row.label, type: row.field_type, options: row.field_type === 'select' ? parseOptions(row.options) : [],
  required: Boolean(row.required), audience: row.audience, help: row.help || '', position: row.position, active: Boolean(row.active),
});

// Active fields for a kind of record, in order. `role` limits them to what that person may see ('user' sees 'everyone' ones).
async function definitions(entity, { role = 'admin', includeInactive = false } = {}) {
  const rows = await db.prepare(`SELECT * FROM custom_fields WHERE entity_type = ? ${includeInactive ? '' : 'AND active = 1'} ORDER BY position, id`).all(entity);
  return rows.map(shape).filter((d) => isStaff(role) || d.audience === 'everyone');
}
async function definition(id) {
  const row = await db.prepare('SELECT * FROM custom_fields WHERE id = ?').get(id);
  return row ? shape(row) : null;
}

// One option per line: "Label", or "value|Label". Returns [{ value, label }] or throws FieldError.
function parseOptionLines(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new FieldError('A choice list needs at least one choice, one per line.');
  if (lines.length > LIMITS.options) throw new FieldError(`A choice list can have at most ${LIMITS.options} choices.`);
  const out = []; const seen = new Set();
  for (const line of lines) {
    const bar = line.indexOf('|');
    const label = (bar >= 0 ? line.slice(bar + 1) : line).trim();
    const value = bar >= 0 ? line.slice(0, bar).trim().toLowerCase() : slug(label);
    if (!label) throw new FieldError(`"${line}" has no label.`);
    if (label.length > LIMITS.optionLabel) throw new FieldError(`The choice "${label.slice(0, 30)}..." is longer than ${LIMITS.optionLabel} characters.`);
    if (!OPTION_VALUE_RE.test(value)) throw new FieldError(`The choice "${label}" needs a value of letters, digits, - and _ (write it as value|Label).`);
    if (seen.has(value)) throw new FieldError(`Two choices have the value "${value}".`);
    seen.add(value); out.push({ value, label });
  }
  return out;
}
const optionsToLines = (options) => options.map((o) => (slug(o.label) === o.value ? o.label : `${o.value}|${o.label}`)).join('\n');

// A new field from the administrator's form. Returns the cleaned definition or throws FieldError.
async function validateNew(input) {
  const entity = String(input.entity_type || '');
  if (!ENTITIES[entity]) throw new FieldError('Choose what the field is for.');
  const label = String(input.label || '').trim();
  if (!label) throw new FieldError('Give the field a label.');
  if (label.length > LIMITS.label) throw new FieldError(`The label is longer than ${LIMITS.label} characters.`);
  const key = String(input.key || '').trim().toLowerCase() || keyFromLabel(label);
  if (!KEY_RE.test(key)) throw new FieldError('The key must start with a letter and hold only lowercase letters, digits and _ (40 characters at most). It is used in the API and cannot be changed later.');
  const type = String(input.field_type || '');
  if (!TYPES[type]) throw new FieldError('Choose what kind of value the field holds.');
  const options = type === 'select' ? parseOptionLines(input.options) : null;
  const help = String(input.help || '').trim();
  if (help.length > LIMITS.help) throw new FieldError(`The help text is longer than ${LIMITS.help} characters.`);
  const audience = input.audience === 'staff' ? 'staff' : 'everyone';
  const counts = await db.prepare('SELECT COUNT(*) FILTER (WHERE entity_type = ?) AS here, COUNT(*) AS total FROM custom_fields').get(entity);
  if (Number(counts.here) >= LIMITS.perEntity) throw new FieldError(`There are already ${LIMITS.perEntity} custom fields for ${ENTITIES[entity].label.toLowerCase()}.`);
  if (Number(counts.total) >= LIMITS.total) throw new FieldError(`There are already ${LIMITS.total} custom fields in all.`);
  return { entity, key, label, type, options, required: input.required === 'on' || input.required === true, audience, help };
}

async function create(clean) {
  const clash = await db.prepare('SELECT 1 FROM custom_fields WHERE entity_type = ? AND key = ?').get(clean.entity, clean.key);
  if (clash) throw new FieldError(`There is already a field with the key "${clean.key}" for ${ENTITIES[clean.entity].label.toLowerCase()}.`);
  const next = Number((await db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM custom_fields WHERE entity_type = ?').get(clean.entity)).n);
  try {
    const row = await db.prepare(`INSERT INTO custom_fields (entity_type, key, label, field_type, options, required, audience, help, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .run(clean.entity, clean.key, clean.label, clean.type, clean.options ? JSON.stringify(clean.options) : null, clean.required ? 1 : 0, clean.audience, clean.help || null, next);
    return row.lastInsertRowid;
  } catch (err) {
    if (err.code === '23505') throw new FieldError(`There is already a field with the key "${clean.key}" for ${ENTITIES[clean.entity].label.toLowerCase()}.`);
    throw err;
  }
}

// Changes to an existing field. The key and kind of value never change. Choices can be added and renamed, but one that
// records still use cannot be taken out. Returns the list of what changed, in words.
async function update(id, input) {
  const was = await definition(id);
  if (!was) throw new FieldError('No such field.');
  const label = String(input.label === undefined ? was.label : input.label).trim();
  if (!label) throw new FieldError('Give the field a label.');
  if (label.length > LIMITS.label) throw new FieldError(`The label is longer than ${LIMITS.label} characters.`);
  const help = String(input.help === undefined ? was.help : input.help).trim();
  if (help.length > LIMITS.help) throw new FieldError(`The help text is longer than ${LIMITS.help} characters.`);
  const required = input.required === undefined ? was.required : (input.required === 'on' || input.required === true);
  const audience = input.audience === undefined ? was.audience : (input.audience === 'staff' ? 'staff' : 'everyone');
  const active = input.active === undefined ? was.active : (input.active === 'on' || input.active === true);
  let options = was.options;
  if (was.type === 'select' && input.options !== undefined) {
    options = parseOptionLines(input.options);
    const gone = was.options.filter((o) => !options.some((n) => n.value === o.value));
    for (const o of gone) {
      const used = Number((await db.prepare('SELECT COUNT(*) AS c FROM custom_field_values WHERE field_id = ? AND value = ?').get(id, o.value)).c);
      if (used) throw new FieldError(`The choice "${o.label}" cannot be removed: ${used} record${used === 1 ? '' : 's'} use${used === 1 ? 's' : ''} it. Rename it instead, or clear it on those records first.`);
    }
  }
  const changed = [];
  if (label !== was.label) changed.push(`label "${was.label}" to "${label}"`);
  if (help !== was.help) changed.push('help text');
  if (required !== was.required) changed.push(required ? 'now required' : 'no longer required');
  if (audience !== was.audience) changed.push(audience === 'staff' ? 'now staff only' : 'now visible to everyone');
  if (active !== was.active) changed.push(active ? 'switched on' : 'switched off');
  if (JSON.stringify(options) !== JSON.stringify(was.options)) changed.push('choices');
  if (changed.length) {
    await db.prepare('UPDATE custom_fields SET label = ?, help = ?, required = ?, audience = ?, active = ?, options = ? WHERE id = ?')
      .run(label, help || null, required ? 1 : 0, audience, active ? 1 : 0, was.type === 'select' ? JSON.stringify(options) : null, id);
  }
  return changed;
}

// Moves a field one place up or down among those for the same kind of record.
async function move(id, direction) {
  const f = await definition(id);
  if (!f) return false;
  const rows = await db.prepare('SELECT id FROM custom_fields WHERE entity_type = ? ORDER BY position, id').all(f.entityType);
  const ids = rows.map((r) => r.id);
  const i = ids.indexOf(id); const j = direction === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= ids.length) return false;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await db.transaction(async (tx) => { for (let p = 0; p < ids.length; p++) await tx.prepare('UPDATE custom_fields SET position = ? WHERE id = ?').run(p + 1, ids[p]); });
  return true;
}

// Removes a field and every value it holds. Returns how many values went.
async function remove(id) {
  const n = Number((await db.prepare('SELECT COUNT(*) AS c FROM custom_field_values WHERE field_id = ?').get(id)).c);
  await db.prepare('DELETE FROM custom_fields WHERE id = ?').run(id);
  return n;
}

async function usage() {
  const rows = await db.prepare('SELECT field_id, COUNT(*) AS c FROM custom_field_values GROUP BY field_id').all();
  return new Map(rows.map((r) => [r.field_id, Number(r.c)]));
}

// ---------------------------------------------------------------- checking a value
const present = (v) => v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '');
// A required field has to hold something; a required yes/no has to be yes.
const isMissing = (def, value) => def.required && (value === null || (def.type === 'checkbox' && value !== 'true'));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// One typed-in value for a field. Returns { value } (text to store, or null for "empty") or { error }.
function checkValue(def, raw, { form = false } = {}) {
  const name = def.label;
  if (def.type === 'checkbox') {
    if (form) return { value: raw === 'on' || raw === 'true' || raw === '1' || raw === true ? 'true' : 'false' };
    if (raw === null || raw === undefined || raw === '') return { value: null };
    if (raw === true || raw === 'true') return { value: 'true' };
    if (raw === false || raw === 'false') return { value: 'false' };
    return { error: `${name} must be true or false.` };
  }
  if (!present(raw)) return { value: null };
  switch (def.type) {
    case 'text': case 'textarea': {
      if (typeof raw !== 'string') return { error: `${name} must be text.` };
      const max = def.type === 'text' ? LIMITS.text : LIMITS.textarea;
      const s = def.type === 'text' ? raw.replace(/\s*[\r\n]+\s*/g, ' ').trim() : raw.replace(/\r\n?/g, '\n').trim();
      if (s.length > max) return { error: `${name} is longer than ${max} characters.` };
      return { value: s };
    }
    case 'number': {
      const s = typeof raw === 'number' ? String(raw) : (typeof raw === 'string' ? raw.trim() : null);
      if (s === null || !/^-?\d+(\.\d+)?$/.test(s)) return { error: `${name} must be a number, like 12 or 3.5.` };
      const n = Number(s);
      if (!Number.isFinite(n) || Math.abs(n) >= 1e15 || s.replace(/^-/, '').replace('.', '').replace(/^0+/, '').length > 15) return { error: `${name} is too large or has too many digits.` };
      return { value: String(n) };
    }
    case 'date': {
      if (typeof raw !== 'string' || !DATE_RE.test(raw.trim())) return { error: `${name} must be a date like 2026-12-31.` };
      const s = raw.trim();
      const when = new Date(`${s}T00:00:00Z`);
      if (Number.isNaN(when.getTime()) || when.toISOString().slice(0, 10) !== s) return { error: `${name} is not a real date.` };
      return { value: s };
    }
    case 'select': {
      if (typeof raw !== 'string') return { error: `${name} must be one of the choices.` };
      const s = raw.trim();
      const hit = def.options.find((o) => o.value === s.toLowerCase()) || def.options.find((o) => o.label.toLowerCase() === s.toLowerCase());
      if (!hit) return { error: `${name} must be one of: ${def.options.map((o) => o.label).join(', ')}.` };
      return { value: hit.value };
    }
    default: return { error: `${name} has an unknown type.` };
  }
}

// What a stored value looks like to a person.
function display(def, value) {
  if (value === undefined || value === null || value === '') return '';
  if (def.type === 'checkbox') return value === 'true' ? 'Yes' : 'No';
  if (def.type === 'select') { const o = def.options.find((x) => x.value === value); return o ? o.label : value; }
  return value;
}
// And to a program (the API): numbers as numbers, checkboxes as booleans, choices as their value.
function typed(def, value) {
  if (value === undefined || value === null) return null;
  if (def.type === 'number') return Number(value);
  if (def.type === 'checkbox') return value === 'true';
  return value;
}

// ---------------------------------------------------------------- values
async function valuesFor(entity, id) {
  const rows = await db.prepare('SELECT field_id, value FROM custom_field_values WHERE entity_type = ? AND entity_id = ?').all(entity, id);
  return new Map(rows.map((r) => [r.field_id, r.value]));
}
// Several records at once: Map(entity id -> Map(field id -> value)).
async function valuesForMany(entity, ids) {
  const out = new Map(ids.map((id) => [id, new Map()]));
  if (!ids.length) return out;
  const rows = await db.prepare(`SELECT entity_id, field_id, value FROM custom_field_values WHERE entity_type = ? AND entity_id IN (${ids.map(() => '?').join(',')})`).all(entity, ...ids);
  for (const r of rows) out.get(r.entity_id).set(r.field_id, r.value);
  return out;
}

// The fields of a record as a page needs them: [{ ...definition, value, display }], for the fields `role` may see.
async function forPage(entity, id, role) {
  const defs = await definitions(entity, { role });
  const values = id ? await valuesFor(entity, id) : new Map();
  return defs.map((d) => ({ ...d, value: values.get(d.id) || '', display: display(d, values.get(d.id)) }));
}

// What a page sends: inputs named cf_<key>. A checkbox that is not ticked sends nothing, so on a form it means "no".
// Returns { errors: [text], apply(id, actor) } where apply stores what was entered and resolves the changes made.
async function fromForm(entity, body, { role, existingId = null } = {}) {
  const defs = await definitions(entity, { role });
  const current = existingId ? await valuesFor(entity, existingId) : new Map();
  const errors = []; const next = new Map();
  for (const d of defs) {
    const r = checkValue(d, (body || {})[`cf_${d.key}`], { form: true });
    if (r.error) { errors.push(r.error); continue; }
    if (isMissing(d, r.value)) { errors.push(d.type === 'checkbox' ? `${d.label} must be ticked.` : `${d.label} is required.`); continue; }
    next.set(d.id, r.value);
  }
  return { errors, apply: (id, actor) => save(entity, id, defs, current, next, actor, existingId ? null : 'created') };
}

// What the API sends: { key: value } (a key that is left out is left alone; null or "" clears it). `creating` makes the
// required fields count. Unknown keys are an error. Returns { errors: [{field, message}], apply }.
async function fromApi(entity, input, { role, creating = false, existingId = null } = {}) {
  const defs = await definitions(entity, { role });
  const errors = []; const next = new Map();
  const given = input === undefined || input === null ? {} : input;
  if (typeof given !== 'object' || Array.isArray(given)) return { errors: [{ field: 'custom_fields', message: 'must be an object of key: value pairs' }], apply: async () => [] };
  const byKey = new Map(defs.map((d) => [d.key, d]));
  for (const key of Object.keys(given)) if (!byKey.has(key)) errors.push({ field: `custom_fields.${key}`, message: 'is not a custom field you can set here' });
  const current = existingId ? await valuesFor(entity, existingId) : new Map();
  for (const d of defs) {
    const mentioned = Object.prototype.hasOwnProperty.call(given, d.key);
    if (!mentioned) { if (creating && d.required) errors.push({ field: `custom_fields.${d.key}`, message: d.type === 'checkbox' ? 'must be true' : 'is required' }); continue; }
    const r = checkValue(d, given[d.key], { form: false });
    if (r.error) { errors.push({ field: `custom_fields.${d.key}`, message: r.error.replace(`${d.label} `, '') }); continue; }
    if (isMissing(d, r.value)) { errors.push({ field: `custom_fields.${d.key}`, message: d.type === 'checkbox' ? 'must be true' : 'is required' }); continue; }
    next.set(d.id, r.value);
  }
  return { errors, apply: (id, actor) => save(entity, id, defs, current, next, actor, creating ? 'created' : null) };
}

// Writes the values in `next` (Map field id -> text or null) over `current`, and notes the changes in the record's history.
async function save(entity, id, defs, current, next, actor, mode) {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const changes = [];
  for (const [fieldId, value] of next) {
    const d = byId.get(fieldId);
    const before = current.has(fieldId) ? current.get(fieldId) : null;
    if (before === value) continue;
    if (d.type === 'checkbox' && value === 'false' && before === null) continue;      // an unticked box that was never ticked is not a change
    if (value === null) {
      await db.prepare('DELETE FROM custom_field_values WHERE entity_type = ? AND entity_id = ? AND field_id = ?').run(entity, id, fieldId);
    } else {
      await db.prepare(`INSERT INTO custom_field_values (entity_type, entity_id, field_id, value, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (entity_type, entity_id, field_id) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`).run(entity, id, fieldId, value, nowStr());
    }
    changes.push({ field: d.label, key: d.key, from: before, to: value, fromText: display(d, before), toText: display(d, value) });
  }
  // A record just made says "created" once, in its own history; later changes are noted one by one.
  if (changes.length && mode !== 'created') {
    await db.prepare(`UPDATE ${ENTITIES[entity].table} SET updated_at = ? WHERE id = ?`).run(nowStr(), id);
    const clip = (s) => (String(s).length > 60 ? `${String(s).slice(0, 57)}...` : String(s));
    for (const c of changes) {
      const text = c.to === null ? `${c.field} cleared` : (c.from === null ? `${c.field} set to "${clip(c.toText)}"` : `${c.field} changed from "${clip(c.fromText)}" to "${clip(c.toText)}"`);
      await logActivity(entity, id, actor && actor.id, text);
    }
  }
  return changes;
}

// ---------------------------------------------------------------- for the API and the CSV exports
// Adds `custom_fields` ({ key: typed value or null }) to each row, for the fields `role` may see. Mutates and returns rows.
async function attachToRows(entity, rows, role) {
  const defs = await definitions(entity, { role });
  const many = await valuesForMany(entity, rows.map((r) => r.id));
  for (const r of rows) {
    const vals = many.get(r.id) || new Map();
    r.custom_fields = Object.fromEntries(defs.map((d) => [d.key, typed(d, vals.get(d.id))]));
  }
  return rows;
}

// Extra columns for a CSV export of these rows: [{ label, value(row) }], one per field the role may see.
async function csvColumns(entity, rows, role) {
  const defs = await definitions(entity, { role });
  if (!defs.length) return [];
  const many = await valuesForMany(entity, rows.map((r) => r.id));
  return defs.map((d) => ({ label: d.label, value: (r) => display(d, (many.get(r.id) || new Map()).get(d.id)) }));
}

// A page's answer to custom field values it cannot accept: the same kind of answer as a missing required field.
const refuse = (res, errors) => res.status(400).render('error', { title: 'Check the form', message: errors.join(' ') });

module.exports = {
  refuse, ENTITIES, TYPES, LIMITS, KEY_RE, FieldError, isStaff, keyFromLabel, slug,
  definitions, definition, parseOptionLines, optionsToLines, validateNew, create, update, move, remove, usage,
  checkValue, display, typed, valuesFor, valuesForMany, forPage, fromForm, fromApi, attachToRows, csvColumns,
};
