#!/usr/bin/env node
// Custom fields, end to end, against a copy of NovaDesk that this script starts itself (port 18310) on the database named by
// PGHOST, PGUSER, PGPASSWORD and PGDATABASE: who may define fields, every refusal when defining one, the fields on the forms
// and pages of all five kinds of record (as an administrator, an agent and an end user), required fields, each kind of value,
// staff-only fields, switching a field off, the history it writes, the REST API (read and write, typed values, errors), the
// CSV exports, the OpenAPI document, and the values going when a record or a field is deleted.
// Needs the demonstration users. It adds its own fields and records and removes the fields again at the end.
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const knexLib = require('knex');
const { dbConfig } = require('../src/settings');

const ROOT = path.join(__dirname, '..');
let failed = 0; let section = '';
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  [${section}] ${name}${!ok && extra ? '  -- ' + String(extra).slice(0, 400) : ''}`); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Math.random().toString(36).slice(2, 7);

class Browser {
  constructor(base) { this.base = base; this.cookie = ''; this.csrf = null; }
  jar(res) { for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]; const j = Object.fromEntries(this.cookie.split('; ').filter(Boolean).map((x) => [x.split('=')[0], x])); j[kv.split('=')[0]] = kv; this.cookie = Object.values(j).join('; '); } }
  async raw(method, p, { form, headers = {} } = {}) {
    const h = { Cookie: this.cookie, ...headers }; let body;
    if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const res = await fetch(this.base + p, { method, headers: h, body, redirect: 'manual' });
    this.jar(res);
    const text = await res.text();
    const meta = text.match(/<meta name="csrf-token" content="([^"]+)"/); if (meta) this.csrf = meta[1];
    return { status: res.status, loc: res.headers.get('location'), text, headers: res.headers };
  }
  get(p) { return this.raw('GET', p); }
  async ensureToken() { if (!this.csrf) { await this.get('/login'); if (!this.csrf) await this.get('/profile'); } return this.csrf; }
  async post(p, form = {}, { token = true } = {}) { await this.ensureToken(); const r = await this.raw('POST', p, { form: { ...(token ? { _csrf: this.csrf } : {}), ...form } }); if (r.headers.getSetCookie().length) this.csrf = null; return r; }
  login(u, pw) { return this.post('/login', { username: u, password: pw }); }
}

function start(port, env) {
  const log = [];
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SEED_DEMO: 'true', SLA_SWEEP_S: '3600', SESSION_SECRET: `cf-check-${tag}`, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => log.push(String(d))); child.stderr.on('data', (d) => log.push(String(d)));
  return { child, text: () => log.join(''), exited: new Promise((r) => child.on('exit', r)) };
}
async function healthy(port, srv) { for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true; } catch { /* wait */ } if (srv.child.exitCode !== null) return false; await sleep(500); } return false; }

async function main() {
  const port = 18310; const base = `http://127.0.0.1:${port}`;
  const app = start(port, { PUBLIC_URL: base });
  const knex = knexLib({ client: 'pg', connection: dbConfig(process.env), pool: { min: 0, max: 3 } });
  try {
    if (!(await healthy(port, app))) throw new Error(`NovaDesk did not start: ${app.text().slice(-400)}`);
    await run(base, knex, app);
  } finally { await knex.destroy(); app.child.kill(); await app.exited; }
}

const ENTITIES = ['incident', 'request', 'change', 'problem', 'ci'];

async function run(base, knex, app) {
  const q = async (sql, params = []) => (await knex.raw(sql, params)).rows;
  const one = async (sql, params = []) => (await q(sql, params))[0];
  const count = async (sql, params = []) => Number((await one(sql, params)).c);
  const admin = new Browser(base); await admin.login('admin', 'admin123');
  const jane = new Browser(base); await jane.login('jdoe', 'agent123');
  const maria = new Browser(base); await maria.login('mchen', 'user123');
  const anon = new Browser(base);
  const adminId = (await one("SELECT id FROM users WHERE username = 'admin'")).id;
  const mariaId = (await one("SELECT id FROM users WHERE username = 'mchen'")).id;
  const K = (name) => `${name}_${tag}`;                                       // keys are unique to this run
  const value = (html, name) => { const m = html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`)); return m ? m[1] : null; };
  const has = (html, name) => html.includes(`name="${name}"`);

  // What a browser would send for the custom fields on a page: every input as it stands (a form always sends all of them; a box that
  // is not ticked sends nothing).
  const decode = (t) => t.replace(/&#34;|&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const formState = (html) => {
    const out = {};
    for (const m of html.matchAll(/<input[^>]*type="(?:text|number|date)"[^>]*name="(cf_[^"]+)"[^>]*value="([^"]*)"/g)) out[m[1]] = decode(m[2]);
    for (const m of html.matchAll(/<input[^>]*type="checkbox"[^>]*name="(cf_[^"]+)"([^>]*)>/g)) if (/\bchecked\b/.test(m[2])) out[m[1]] = 'on';
    for (const m of html.matchAll(/<select[^>]*name="(cf_[^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) { const sel = m[2].match(/<option value="([^"]*)" selected>/); out[m[1]] = sel ? sel[1] : ''; }
    for (const m of html.matchAll(/<textarea[^>]*name="(cf_[^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) out[m[1]] = decode(m[2]);
    return out;
  };
  // The tables are this script's to start from: leftovers of an earlier run on a shared database are cleared.
  await q("DELETE FROM custom_fields WHERE key LIKE '%\\_' || ?", [tag]);

  const defineVia = async (b, fields) => b.post('/settings/fields', fields);
  const defineField = async (entity, key, label, type, extra = {}) => {
    const r = await defineVia(admin, { entity_type: entity, label, key: K(key), field_type: type, ...extra });
    const row = await one('SELECT id FROM custom_fields WHERE entity_type = ? AND key = ?', [entity, K(key)]);
    return { r, id: row && row.id, key: K(key) };
  };
  // What the edit page sends: a ticked box is "on", an unticked one is not sent at all. `on` and `required` are ticked unless said otherwise.
  const editField = (id, fields = {}, { on = true, required = false } = {}) => admin.post(`/settings/fields/${id}`, { ...(on ? { active: 'on' } : {}), ...(required ? { required: 'on' } : {}), ...fields });
  const fieldRow = (id) => one('SELECT * FROM custom_fields WHERE id = ?', [id]);
  const lastAudit = (action) => one('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1', [action]);

  // ---------------------------------------------------------------------------------------------------- who may
  section = 'who may';
  check('signed out: sent to sign in', (await anon.get('/settings/fields')).status === 302);
  check('an agent and a plain user can open neither the page nor a field, and change nothing', (await jane.get('/settings/fields')).status === 403 && (await maria.get('/settings/fields')).status === 403 && (await maria.get('/settings/fields/1')).status === 403
    && (await jane.post('/settings/fields', { entity_type: 'incident', label: 'x', field_type: 'text' })).status === 403 && (await maria.post('/settings/fields/1', { label: 'x' })).status === 403 && (await jane.post('/settings/fields/1/delete')).status === 403 && (await jane.post('/settings/fields/1/move', { direction: 'up' })).status === 403);
  const page = await admin.get('/settings/fields');
  check('the administrator sees every kind of record and the add form, and the menu links to it', page.status === 200 && ['Incidents', 'Service requests', 'Changes', 'Problems', 'Configuration items'].every((x) => page.text.includes(x)) && page.text.includes('Add a field') && /href="\/settings\/fields"/.test((await admin.get('/users')).text));
  const before = await count('SELECT count(*) AS c FROM custom_fields');
  check('a forged post without the page token is refused and makes nothing', (await admin.post('/settings/fields', { entity_type: 'incident', label: 'Forged', key: K('forged'), field_type: 'text' }, { token: false })).status === 403 && await count('SELECT count(*) AS c FROM custom_fields') === before);
  check('an unknown or non-numeric field is a 404', (await admin.get('/settings/fields/999999')).status === 404 && (await admin.get('/settings/fields/abc')).status === 404 && (await admin.get('/settings/fields/0')).status === 404 && (await admin.post('/settings/fields/999999/delete')).status === 404 && (await admin.post('/settings/fields/999999/move', { direction: 'up' })).status === 404);

  // ----------------------------------------------------------------------------------------------- defining a field
  section = 'defining';
  const refused = async (name, fields, pattern) => {
    const n = await count('SELECT count(*) AS c FROM custom_fields');
    const r = await defineVia(admin, fields);
    check(`${name} is refused with a reason`, r.status === 400 && pattern.test(r.text) && await count('SELECT count(*) AS c FROM custom_fields') === n, `${r.status} ${(r.text.match(/alert-danger[^>]*>([^<]*)/) || [])[1]}`);
  };
  await refused('no kind of record', { label: 'x', field_type: 'text' }, /Choose what the field is for/);
  await refused('an unknown kind of record', { entity_type: 'widget', label: 'x', field_type: 'text' }, /Choose what the field is for/);
  await refused('no label', { entity_type: 'incident', label: '   ', field_type: 'text' }, /Give the field a label/);
  await refused('a label over 60 characters', { entity_type: 'incident', label: 'x'.repeat(61), field_type: 'text' }, /longer than 60/);
  await refused('a bad key', { entity_type: 'incident', label: 'x', key: 'Bad Key', field_type: 'text' }, /key must start with a letter/);
  await refused('a key that starts with a digit', { entity_type: 'incident', label: 'x', key: '1abc', field_type: 'text' }, /key must start with a letter/);
  await refused('a label that makes no key', { entity_type: 'incident', label: '!!!', field_type: 'text' }, /key must start with a letter/);
  await refused('no kind of value', { entity_type: 'incident', label: 'x', key: K('x'), field_type: '' }, /Choose what kind of value/);
  await refused('an unknown kind of value', { entity_type: 'incident', label: 'x', key: K('x'), field_type: 'file' }, /Choose what kind of value/);
  await refused('a choice list with no choices', { entity_type: 'incident', label: 'x', key: K('x'), field_type: 'select', options: '  \n ' }, /at least one choice/);
  await refused('two choices with the same value', { entity_type: 'incident', label: 'x', key: K('x'), field_type: 'select', options: 'Red\nred' }, /Two choices/);
  await refused('help text over 200 characters', { entity_type: 'incident', label: 'x', key: K('x'), field_type: 'text', help: 'h'.repeat(201) }, /longer than 200/);

  const costCentre = await defineField('incident', 'cost_centre', 'Cost centre', 'text', { help: 'The code on your budget sheet.', required: 'on' });
  check('a field is made: 200 with a notice; stored as given; key from the field, position first', costCentre.r.status === 200 && /was added to incidents/.test(costCentre.r.text) && (await fieldRow(costCentre.id)).label === 'Cost centre' && (await fieldRow(costCentre.id)).required === 1 && (await fieldRow(costCentre.id)).position >= 1);
  const auto = await defineVia(admin, { entity_type: 'incident', label: `Impact area ${tag}`, field_type: 'text' });
  const autoRow = await one("SELECT * FROM custom_fields WHERE entity_type = 'incident' AND key = ?", [`impact_area_${tag}`]);
  check('left empty, the key is made from the label', auto.status === 200 && Boolean(autoRow));
  check('the same key twice for one kind of record is refused; for another kind it is fine', await (async () => {
    const dup = await defineVia(admin, { entity_type: 'incident', label: 'Again', key: K('cost_centre'), field_type: 'text' });
    const other = await defineField('request', 'cost_centre', 'Cost centre', 'text');
    return dup.status === 400 && /already a field with the key/.test(dup.text) && other.r.status === 200 && Boolean(other.id);
  })());
  const audit = await lastAudit('customfield.created');
  check('defining is in the audit log: what, for which kind, who', audit && audit.target_type === 'custom_field' && /^request:cost_centre_/.test(audit.target_name) && audit.actor_name);
  const urgencyBand = await defineField('incident', 'band', 'Service band', 'select', { options: 'Gold\nsilver|Silver\nBronze' });
  check('a choice list stores its choices, values made from labels', JSON.stringify(JSON.parse((await fieldRow(urgencyBand.id)).options)) === JSON.stringify([{ value: 'gold', label: 'Gold' }, { value: 'silver', label: 'Silver' }, { value: 'bronze', label: 'Bronze' }]));
  const staffOnly = await defineField('incident', 'root', 'Root cause note', 'textarea', { audience: 'staff' });
  const qty = await defineField('incident', 'qty', 'Affected users', 'number');
  const due = await defineField('incident', 'due', 'Customer deadline', 'date');
  const flag = await defineField('incident', 'vip', 'Executive impact', 'checkbox');
  check('every kind of value can be defined', [qty, due, flag, staffOnly].every((f) => f.id) && (await fieldRow(staffOnly.id)).audience === 'staff');
  check('the page lists them, with their kind and who sees them', await (async () => { const t = (await admin.get('/settings/fields')).text; return t.includes('Cost centre') && t.includes('Choice from a list') && t.includes('Agents and administrators') && t.includes('Yes / no'); })());
  // the 30-per-kind limit
  const have = await count("SELECT count(*) AS c FROM custom_fields WHERE entity_type = 'ci'");
  for (let i = have; i < 30; i++) await q("INSERT INTO custom_fields (entity_type, key, label, field_type, position) VALUES ('ci', ?, 'filler', 'text', ?)", [`filler_${i}_${tag}`, 100 + i]);
  await refused('a 31st field for one kind of record', { entity_type: 'ci', label: 'One too many', key: K('toomany'), field_type: 'text' }, /already 30 custom fields/);
  await q("DELETE FROM custom_fields WHERE key LIKE 'filler\\_%' AND key LIKE ?", [`%_${tag}`]);

  // ----------------------------------------------------------------------------------------------- editing a field
  section = 'editing';
  const editPage = await admin.get(`/settings/fields/${urgencyBand.id}`);
  check('the edit page shows the field, its kind and key (which cannot change), and its choices', editPage.status === 200 && editPage.text.includes('Service band') && editPage.text.includes(`<code>${urgencyBand.key}</code>`) && editPage.text.includes('Gold') && editPage.text.includes('Silver') && editPage.text.includes('Bronze'));
  const edited = await editField(urgencyBand.id, { label: 'Service tier', help: 'Contract tier', key: 'hacked', field_type: 'number', options: 'Gold\nsilver|Silver\nBronze\nPlatinum' });
  const bandRow = await fieldRow(urgencyBand.id);
  check('label, help and choices change; the key and the kind of value cannot', edited.status === 200 && /Saved/.test(edited.text) && bandRow.label === 'Service tier' && bandRow.help === 'Contract tier' && bandRow.key === urgencyBand.key && bandRow.field_type === 'select' && JSON.parse(bandRow.options).length === 4);
  check('editing is in the audit log, naming what changed', /label "Service band" to "Service tier"/.test((await lastAudit('customfield.updated')).detail) && /choices/.test((await lastAudit('customfield.updated')).detail));
  check('saving with nothing changed says so and writes no entry', await (async () => { const n = await count("SELECT count(*) AS c FROM audit_log WHERE action = 'customfield.updated'"); const r = await editField(urgencyBand.id, { label: 'Service tier', help: 'Contract tier', options: 'Gold\nsilver|Silver\nBronze\nPlatinum' }); return /Nothing changed/.test(r.text) && n === await count("SELECT count(*) AS c FROM audit_log WHERE action = 'customfield.updated'"); })());
  check('a blank label or a help text over 200 characters is refused, nothing saved', (await editField(urgencyBand.id, { label: ' ' })).status === 400 && (await editField(urgencyBand.id, { label: 'Service tier', help: 'h'.repeat(201) })).status === 400 && (await fieldRow(urgencyBand.id)).label === 'Service tier');
  check('a choice list cannot be emptied or given duplicate values', (await editField(urgencyBand.id, { label: 'Service tier', options: '' })).status === 400 && (await editField(urgencyBand.id, { label: 'Service tier', options: 'a|A\na|B' })).status === 400 && JSON.parse((await fieldRow(urgencyBand.id)).options).length === 4);

  // ------------------------------------------------------------------------------------------------------ ordering
  section = 'ordering';
  const order = async () => (await q("SELECT key FROM custom_fields WHERE entity_type = 'incident' AND key LIKE ? ORDER BY position, id", [`%_${tag}`])).map((r) => r.key);
  const o0 = await order();
  await admin.post(`/settings/fields/${urgencyBand.id}/move`, { direction: 'up' });
  const o1 = await order();
  check('moving a field up swaps it with the one above', o1.indexOf(urgencyBand.key) === o0.indexOf(urgencyBand.key) - 1 && o1.length === o0.length);
  await admin.post(`/settings/fields/${urgencyBand.id}/move`, { direction: 'down' });
  check('and down puts it back', (await order()).join() === o0.join());
  const top = await one('SELECT id FROM custom_fields WHERE entity_type = ? ORDER BY position, id LIMIT 1', ['incident']);
  const topBefore = await order();
  const edge = await admin.post(`/settings/fields/${top.id}/move`, { direction: 'up' });
  check('moving the first up (or the last down) changes nothing and is not an error', edge.status === 302 && (await order()).join() === topBefore.join());
  check('positions stay a clean 1..n after moves', await (async () => { const p = (await q("SELECT position FROM custom_fields WHERE entity_type = 'incident' ORDER BY position")).map((r) => r.position); return p.every((v, i) => i === 0 || v >= p[i - 1]); })());
  check('moving is audited', (await lastAudit('customfield.moved')).detail === 'moved down');

  // --------------------------------------------------------------------------------------------------- the forms
  section = 'forms';
  const newForm = await admin.get('/incidents/new');
  check('the new-incident form carries the fields, in order, with their help and required marks', newForm.status === 200 && has(newForm.text, `cf_${costCentre.key}`) && has(newForm.text, `cf_${urgencyBand.key}`) && newForm.text.includes('The code on your budget sheet.')
    && new RegExp(`name="cf_${costCentre.key}"[^>]*required`).test(newForm.text) && newForm.text.indexOf(`cf_${costCentre.key}`) < newForm.text.indexOf(`cf_${urgencyBand.key}`));
  const kinds = { number: /<input type="number" step="any"[^>]*name="cf_/.test(newForm.text), date: /<input type="date"[^>]*name="cf_/.test(newForm.text), checkbox: /<input class="form-check-input" type="checkbox"[^>]*name="cf_/.test(newForm.text), textarea: /<textarea[^>]*name="cf_/.test(newForm.text), select: new RegExp(`<select[^>]*name="cf_${urgencyBand.key}"`).test(newForm.text), option: /<option value="platinum"\s*>Platinum<\/option>/.test(newForm.text) };
  check('each kind of value gets its own kind of input', Object.values(kinds).every(Boolean), JSON.stringify(kinds));
  const endUserForm = await maria.get('/incidents/new');
  check('an end user sees the fields meant for everyone and not the staff-only one', has(endUserForm.text, `cf_${costCentre.key}`) && !has(endUserForm.text, `cf_${staffOnly.key}`) && has(newForm.text, `cf_${staffOnly.key}`) && /staff only/.test(newForm.text));
  const nIncidents = await count('SELECT count(*) AS c FROM incidents');
  const refusedCreate = async (name, body, pattern, who = admin) => {
    const n = await count('SELECT count(*) AS c FROM incidents');
    const r = await who.post('/incidents', { short_description: `Refused ${name} ${tag}`, ...body });
    check(`creating an incident with ${name} is refused with a reason, and makes nothing`, r.status === 400 && pattern.test(r.text) && await count('SELECT count(*) AS c FROM incidents') === n, `${r.status} ${(r.text.match(/class="[^"]*">([^<]*(required|must|longer)[^<]*)/) || [])[1]}`);
  };
  await refusedCreate('a required field left empty', {}, /Cost centre is required/);
  await refusedCreate('a required field of spaces', { [`cf_${costCentre.key}`]: '   ' }, /Cost centre is required/);
  await refusedCreate('a number that is not a number', { [`cf_${costCentre.key}`]: 'CC1', [`cf_${qty.key}`]: 'twelve' }, /Affected users must be a number/);
  await refusedCreate('an impossible date', { [`cf_${costCentre.key}`]: 'CC1', [`cf_${due.key}`]: '2026-13-45' }, /not a real date|like 2026-12-31/);
  await refusedCreate('a choice that is not on the list', { [`cf_${costCentre.key}`]: 'CC1', [`cf_${urgencyBand.key}`]: 'diamond' }, /Service tier must be one of/);
  await refusedCreate('text that is too long', { [`cf_${costCentre.key}`]: 'x'.repeat(256) }, /longer than 255/);
  await refusedCreate('several problems at once, all named', { [`cf_${qty.key}`]: 'x', [`cf_${due.key}`]: 'y' }, /Cost centre is required[\s\S]*Affected users must be a number[\s\S]*Customer deadline/);
  await refusedCreate('an end user leaving the required field empty', {}, /Cost centre is required/, maria);

  // --------------------------------------------------------------------------------------------- an incident, as staff
  section = 'an incident';
  const made = await admin.post('/incidents', {
    short_description: `Printer on fire ${tag}`, [`cf_${costCentre.key}`]: ' CC-4711 ', [`cf_${qty.key}`]: '12.50', [`cf_${due.key}`]: '2026-12-31', [`cf_${urgencyBand.key}`]: 'Silver',
    [`cf_${flag.key}`]: 'on', [`cf_${staffOnly.key}`]: 'Line 1\r\nLine 2',
  });
  const incId = Number((made.loc || '').split('/').pop());
  check('created: redirected to the incident', made.status === 302 && incId > 0, `${made.status} ${made.loc}`);
  const stored = Object.fromEntries((await q('SELECT f.key, v.value FROM custom_field_values v JOIN custom_fields f ON f.id = v.field_id WHERE v.entity_type = ? AND v.entity_id = ?', ['incident', incId])).map((r) => [r.key, r.value]));
  check('values are stored as clean text: trimmed, a number in plain form, a choice by its value, a ticked box as true, lines kept', stored[costCentre.key] === 'CC-4711' && stored[qty.key] === '12.5' && stored[due.key] === '2026-12-31' && stored[urgencyBand.key] === 'silver' && stored[flag.key] === 'true' && stored[staffOnly.key] === 'Line 1\nLine 2', JSON.stringify(stored));
  check('an empty optional field stores nothing at all', !(`impact_area_${tag}` in stored));
  const show = await admin.get(`/incidents/${incId}`);
  check('the page shows them in the edit form: values filled in, the chosen option selected, the box ticked', value(show.text, `cf_${costCentre.key}`) === 'CC-4711' && value(show.text, `cf_${qty.key}`) === '12.5' && value(show.text, `cf_${due.key}`) === '2026-12-31' && /<option value="silver" selected>/.test(show.text) && new RegExp(`name="cf_${flag.key}"[^>]*checked`).test(show.text) && show.text.includes('Line 1\nLine 2'));
  check('creating wrote no "changed" lines in the history', await count("SELECT count(*) AS c FROM activity_log WHERE entity_type = 'incident' AND entity_id = ? AND message LIKE '%set to%'", [incId]) === 0);

  // --------------------------------------------------------------------------------------------- the end user's view
  section = 'an end user';
  const mine = await maria.post('/incidents', { short_description: `Mouse broken ${tag}`, [`cf_${costCentre.key}`]: 'CC-1', [`cf_${staffOnly.key}`]: 'a user trying to write a staff note', [`cf_${urgencyBand.key}`]: 'gold' });
  const myId = Number((mine.loc || '').split('/').pop());
  check('an end user creates an incident with the fields meant for everyone', mine.status === 302 && myId > 0 && (await one('SELECT v.value FROM custom_field_values v JOIN custom_fields f ON f.id = v.field_id WHERE v.entity_id = ? AND f.key = ? AND v.entity_type = ?', [myId, urgencyBand.key, 'incident'])).value === 'gold');
  check('a staff-only value in an end user\'s post is ignored, not stored', await count('SELECT count(*) AS c FROM custom_field_values WHERE entity_type = ? AND entity_id = ? AND field_id = ?', ['incident', myId, staffOnly.id]) === 0);
  const myPage = await maria.get(`/incidents/${myId}`);
  check('their page lists the fields meant for everyone as read-only details (a label and a value, no input)', myPage.status === 200 && /<dt class="col-sm-3">Cost centre<\/dt><dd[^>]*>CC-1<\/dd>/.test(myPage.text) && /<dt class="col-sm-3">Service tier<\/dt><dd[^>]*>Gold<\/dd>/.test(myPage.text) && !has(myPage.text, `cf_${costCentre.key}`));
  check('and never the staff-only one', !myPage.text.includes('Root cause note'));
  check('an end user cannot change a record through the update route (staff only), so cannot edit values there either', (await maria.post(`/incidents/${myId}/update`, { short_description: 'x', [`cf_${costCentre.key}`]: 'HACK' })).status === 403 && (await one('SELECT v.value FROM custom_field_values v WHERE v.entity_id = ? AND v.field_id = ? AND v.entity_type = ?', [myId, costCentre.id, 'incident'])).value === 'CC-1');
  check('an end user cannot read another person\'s incident, with or without fields', (await maria.get(`/incidents/${incId}`)).status === 403);

  // ------------------------------------------------------------------------------------------------ changing values
  section = 'changing values';
  const upd = async (extra, who = admin, id = incId) => {
    const state = formState((await admin.get(`/incidents/${id}`)).text);
    const body = { short_description: `Printer on fire ${tag}`, status: 'in_progress', impact: '2', urgency: '2', ...state, ...extra };
    for (const k of Object.keys(body)) if (body[k] === null) delete body[k];
    return who.post(`/incidents/${id}/update`, body);
  };
  const acts = (id = incId) => q("SELECT message FROM activity_log WHERE entity_type = 'incident' AND entity_id = ? ORDER BY id", [id]).then((r) => r.map((x) => x.message));
  const updatedBefore = (await one('SELECT updated_at FROM incidents WHERE id = ?', [incId])).updated_at;
  await sleep(1100);
  const r1 = await upd({ [`cf_${costCentre.key}`]: 'CC-9999', [`cf_${qty.key}`]: '7', [`cf_${due.key}`]: '2026-12-31', [`cf_${urgencyBand.key}`]: 'gold', [`cf_${flag.key}`]: 'on', [`cf_${staffOnly.key}`]: 'Line 1\nLine 2' });
  const log1 = await acts();
  check('an agent changes values: the page redirects back', r1.status === 302);
  check('each change is written in the history with the old and the new value, by label (a choice by its label, not its value)', log1.includes('Cost centre changed from "CC-4711" to "CC-9999"') && log1.includes('Affected users changed from "12.5" to "7"') && log1.includes('Service tier changed from "Silver" to "Gold"'), log1.join(' | '));
  check('a value that did not change writes nothing (the deadline, the ticked box, the notes)', !log1.some((m) => /Customer deadline|Executive impact|Root cause note/.test(m)));
  check('and the record\'s updated time moved', (await one('SELECT updated_at FROM incidents WHERE id = ?', [incId])).updated_at > updatedBefore);
  await upd({ [`cf_${costCentre.key}`]: 'CC-9999', [`cf_${qty.key}`]: '7', [`cf_${due.key}`]: '', [`cf_${urgencyBand.key}`]: 'gold', [`cf_${flag.key}`]: null, [`cf_${staffOnly.key}`]: 'Line 1\nLine 2' });
  const log2 = await acts();
  check('clearing an optional value removes it, and says "cleared"', log2.includes('Customer deadline cleared') && await count('SELECT count(*) AS c FROM custom_field_values WHERE entity_type = ? AND entity_id = ? AND field_id = ?', ['incident', incId, due.id]) === 0);
  check('unticking a box that was ticked is a change to "No"', log2.includes('Executive impact changed from "Yes" to "No"') && (await one('SELECT value FROM custom_field_values WHERE entity_id = ? AND field_id = ? AND entity_type = ?', [incId, flag.id, 'incident'])).value === 'false');
  const titleBefore = (await one('SELECT short_description, status FROM incidents WHERE id = ?', [incId]));
  const bad = await upd({ short_description: 'Should not be saved', status: 'resolved', [`cf_${costCentre.key}`]: '' });
  check('clearing a required value is refused, and nothing else in the same save is applied either', bad.status === 400 && /Cost centre is required/.test(bad.text) && JSON.stringify(await one('SELECT short_description, status FROM incidents WHERE id = ?', [incId])) === JSON.stringify(titleBefore));
  const badNumber = await upd({ [`cf_${costCentre.key}`]: 'CC-9999', [`cf_${qty.key}`]: '1e9x' });
  check('a bad value in an update is refused, and the stored value stays', badNumber.status === 400 && (await one('SELECT value FROM custom_field_values WHERE entity_id = ? AND field_id = ? AND entity_type = ?', [incId, qty.id, 'incident'])).value === '7');
  const jr = await upd({ [`cf_${costCentre.key}`]: 'CC-JANE', [`cf_${staffOnly.key}`]: 'agent note' }, jane);
  check('an agent can fill in staff-only fields too, and the history names them', jr.status === 302 && (await acts()).some((m) => /Root cause note changed from "Line 1\nLine 2" to "agent note"/.test(m)));
  const parallel = await Promise.all([1, 2, 3, 4].map((i) => upd({ [`cf_${costCentre.key}`]: `CC-PAR-${i}` })));
  check('four saves at once all succeed, and exactly one value is left', parallel.every((r) => r.status === 302) && await count('SELECT count(*) AS c FROM custom_field_values WHERE entity_type = ? AND entity_id = ? AND field_id = ?', ['incident', incId, costCentre.id]) === 1);

  // ------------------------------------------------------------------------------------------------- hostile values
  section = 'hostile values';
  const evil = '<script>alert(1)</script> "quoted" & \'single\'';
  await upd({ [`cf_${costCentre.key}`]: evil, [`cf_${staffOnly.key}`]: '<img src=x onerror=alert(1)>' });
  const evilPage = await admin.get(`/incidents/${incId}`);
  check('markup in a value comes out as text on the edit form, in an attribute and in a textarea', !evilPage.text.includes('<script>alert(1)</script> "quoted"') && !evilPage.text.includes('<img src=x onerror') && evilPage.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  await q('UPDATE custom_field_values SET value = ? WHERE entity_type = ? AND entity_id = ? AND field_id = ?', [evil, 'incident', myId, costCentre.id]);
  check('and as read-only details for an end user', !(await maria.get(`/incidents/${myId}`)).text.includes('<script>alert(1)</script>'));
  check('and in the history', !(await admin.get(`/incidents/${incId}`)).text.includes('<img src=x onerror'));
  await upd({ [`cf_${costCentre.key}`]: 'CC-FINAL', [`cf_${staffOnly.key}`]: 'note' });
  const crafted = await upd({ [`cf_${costCentre.key}`]: 'CC-FINAL', 'cf_nosuchfield': 'x', 'cf___proto__': 'x', 'cf_constructor': 'x' });
  check('inputs named after fields that do not exist are ignored (no error, nothing stored)', crafted.status === 302 && await count("SELECT count(*) AS c FROM custom_field_values WHERE value = 'x'") === 0);

  // ---------------------------------------------------------------------------------------------- switching one off
  section = 'switching off';
  const offRes = await editField(urgencyBand.id, { label: 'Service tier', options: 'Gold\nsilver|Silver\nBronze\nPlatinum' }, { on: false });   // the "on" box not ticked
  check('a field switched off (the box left empty) is saved as off', offRes.status === 200 && (await fieldRow(urgencyBand.id)).active === 0 && /switched off/.test((await lastAudit('customfield.updated')).detail));
  const offForm = await admin.get('/incidents/new'); const offShow = await admin.get(`/incidents/${incId}`);
  check('hidden from the forms and the page, but its values are kept', !has(offForm.text, `cf_${urgencyBand.key}`) && !has(offShow.text, `cf_${urgencyBand.key}`) && await count('SELECT count(*) AS c FROM custom_field_values WHERE field_id = ?', [urgencyBand.id]) >= 2);
  check('and a post that still names it is ignored, the stored value left alone', (await upd({ [`cf_${costCentre.key}`]: 'CC-FINAL', [`cf_${urgencyBand.key}`]: 'bronze' })).status === 302 && (await one('SELECT value FROM custom_field_values WHERE entity_id = ? AND field_id = ? AND entity_type = ?', [incId, urgencyBand.id, 'incident'])).value === 'gold');
  const onRes = await editField(urgencyBand.id, { label: 'Service tier', options: 'Gold\nsilver|Silver\nBronze\nPlatinum' });
  check('switched on again, it is back with its value', onRes.status === 200 && /<option value="gold" selected>/.test((await admin.get(`/incidents/${incId}`)).text));

  // ------------------------------------------------------------------------------------------- choices that are in use
  section = 'choices in use';
  const removeUsed = await editField(urgencyBand.id, { label: 'Service tier', options: 'silver|Silver\nBronze\nPlatinum' });
  check('a choice that records use cannot be removed, and the message says how many', removeUsed.status === 400 && /Gold&#34; cannot be removed: 2 records use it/.test(removeUsed.text) && JSON.parse((await fieldRow(urgencyBand.id)).options).some((o) => o.value === 'gold'), (removeUsed.text.match(/alert-danger[^>]*>([^<]*)/) || [])[1]);
  const renamed = await editField(urgencyBand.id, { label: 'Service tier', options: 'gold|Gold plus\nsilver|Silver\nBronze\nPlatinum' });
  check('renaming a choice is fine, and records show the new label', renamed.status === 200 && (await admin.get(`/incidents/${incId}`)).text.includes('Gold plus') && /Gold plus/.test((await maria.get(`/incidents/${myId}`)).text));
  const removeUnused = await editField(urgencyBand.id, { label: 'Service tier', options: 'gold|Gold plus\nsilver|Silver\nPlatinum' });
  check('a choice nobody uses can be removed', removeUnused.status === 200 && JSON.parse((await fieldRow(urgencyBand.id)).options).length === 3);

  // ------------------------------------------------------------------------------- the other four kinds of record
  section = 'the other kinds of record';
  const reqField = (await one("SELECT id, key FROM custom_fields WHERE entity_type = 'request' AND key = ?", [K('cost_centre')]));
  const reqFlag = await defineField('request', 'urgent', 'Needed by auditors', 'checkbox', { required: 'on' });
  const probField = await defineField('problem', 'team', 'Owning team', 'select', { options: 'Network\nStorage', required: 'on' });
  const chgField = await defineField('change', 'window', 'Change window', 'date', { required: 'on' });
  const ciField = await defineField('ci', 'contract', 'Support contract', 'text', { required: 'on' });
  const ciNum = await defineField('ci', 'cost', 'Annual cost', 'number', { audience: 'staff' });
  const catalog = await one('SELECT id FROM catalog_items WHERE active = 1 ORDER BY id LIMIT 1');

  // service requests
  const reqForm = await maria.get(`/catalog/${catalog.id}/request`);
  check('request form shows its own fields (not the incident ones)', has(reqForm.text, `cf_${reqField.key}`) && has(reqForm.text, `cf_${reqFlag.key}`) && !has(reqForm.text, `cf_${qty.key}`) && !has(reqForm.text, `cf_${staffOnly.key}`));
  const nReq = await count('SELECT count(*) AS c FROM service_requests');
  check('a required yes/no must be ticked: unticked is refused', (await maria.post(`/catalog/${catalog.id}/request`, { notes: 'x', [`cf_${reqField.key}`]: 'CC-7' })).status === 400 && await count('SELECT count(*) AS c FROM service_requests') === nReq);
  const reqMade = await maria.post(`/catalog/${catalog.id}/request`, { notes: `x ${tag}`, [`cf_${reqField.key}`]: 'CC-7', [`cf_${reqFlag.key}`]: 'on' });
  const reqId = Number((reqMade.loc || '').split('/').pop());
  check('a request is made with its fields', reqMade.status === 302 && reqId > 0 && await count('SELECT count(*) AS c FROM custom_field_values WHERE entity_type = ? AND entity_id = ?', ['request', reqId]) === 2);
  check('the requester sees them as details; staff get inputs in the update form', /<dt class="col-sm-6">Cost centre<\/dt><dd[^>]*>CC-7<\/dd>/.test((await maria.get(`/requests/${reqId}`)).text) && value((await admin.get(`/requests/${reqId}`)).text, `cf_${reqField.key}`) === 'CC-7');
  const reqUp = await admin.post(`/requests/${reqId}/update`, { status: 'in_progress', assigned_to: String(adminId), assignment_group: '', [`cf_${reqField.key}`]: 'CC-8', [`cf_${reqFlag.key}`]: 'on' });
  check('staff change a request\'s value and the request\'s history says so', reqUp.status === 302 && (await q("SELECT message FROM activity_log WHERE entity_type = 'request' AND entity_id = ?", [reqId])).some((r) => r.message === 'Cost centre changed from "CC-7" to "CC-8"'));
  check('a required field left empty on a request update is refused', (await admin.post(`/requests/${reqId}/update`, { status: 'fulfilled', [`cf_${reqField.key}`]: 'CC-8' })).status === 400 && (await one('SELECT status FROM service_requests WHERE id = ?', [reqId])).status === 'in_progress');

  // problems
  const probForm = await admin.get('/problems/new');
  check('problem form has its field', has(probForm.text, `cf_${probField.key}`) && /<option value="storage"\s*>Storage<\/option>/.test(probForm.text));
  check('a problem without its required choice is refused', (await admin.post('/problems', { short_description: `Prob ${tag}` })).status === 400);
  const probMade = await admin.post('/problems', { short_description: `Prob ${tag}`, priority: '3', [`cf_${probField.key}`]: 'Storage' });
  const probId = Number((probMade.loc || '').split('/').pop());
  check('a problem is made with its value, and the page shows it selected', probMade.status === 302 && /<option value="storage" selected>/.test((await admin.get(`/problems/${probId}`)).text));
  const probUp = await admin.post(`/problems/${probId}/update`, { short_description: `Prob ${tag}`, status: 'investigating', priority: '3', [`cf_${probField.key}`]: 'network' });
  check('and it changes on update, with the history saying so', probUp.status === 302 && (await q("SELECT message FROM activity_log WHERE entity_type = 'problem' AND entity_id = ?", [probId])).some((r) => r.message === 'Owning team changed from "Storage" to "Network"'));
  check('an end user cannot open problems at all', (await maria.get(`/problems/${probId}`)).status === 403 && (await maria.get('/problems/new')).status === 403);

  // changes
  const chgForm = await maria.get('/changes/new');
  check('change form has its field', has(chgForm.text, `cf_${chgField.key}`));
  check('a change without its required date is refused', (await maria.post('/changes', { short_description: `Chg ${tag}`, change_type: 'normal', risk: 'low' })).status === 400);
  const chgMade = await maria.post('/changes', { short_description: `Chg ${tag}`, change_type: 'normal', risk: 'low', [`cf_${chgField.key}`]: '2026-11-30' });
  const chgId = Number((chgMade.loc || '').split('/').pop());
  check('a change is made with its value (an end user can raise one)', chgMade.status === 302 && chgId > 0 && (await one('SELECT value FROM custom_field_values WHERE entity_type = ? AND entity_id = ?', ['change', chgId])).value === '2026-11-30');
  check('the requester sees it as a detail; staff get an input', /<dt class="col-sm-3">Change window<\/dt><dd[^>]*>2026-11-30<\/dd>/.test((await maria.get(`/changes/${chgId}`)).text) && value((await admin.get(`/changes/${chgId}`)).text, `cf_${chgField.key}`) === '2026-11-30');
  const chgUp = await admin.post(`/changes/${chgId}/update`, { short_description: `Chg ${tag}`, change_type: 'normal', risk: 'low', status: 'draft', [`cf_${chgField.key}`]: '2026-12-01' });
  check('staff change it, and the history says so', chgUp.status === 302 && (await q("SELECT message FROM activity_log WHERE entity_type = 'change' AND entity_id = ?", [chgId])).some((r) => r.message === 'Change window changed from "2026-11-30" to "2026-12-01"'));
  check('a bad date on a change update is refused and the change is untouched', (await admin.post(`/changes/${chgId}/update`, { short_description: `Chg X ${tag}`, change_type: 'normal', risk: 'low', status: 'draft', [`cf_${chgField.key}`]: 'soon' })).status === 400 && (await one('SELECT short_description FROM changes WHERE id = ?', [chgId])).short_description === `Chg ${tag}`);

  // configuration items
  const ciForm = await admin.get('/cmdb/new');
  check('CI form has its fields', has(ciForm.text, `cf_${ciField.key}`) && has(ciForm.text, `cf_${ciNum.key}`));
  check('a CI without its required field is refused', (await admin.post('/cmdb', { name: `Srv ${tag}`, ci_type: 'server' })).status === 400);
  const ciMade = await admin.post('/cmdb', { name: `Srv ${tag}`, ci_type: 'server', [`cf_${ciField.key}`]: 'GOLD-24x7', [`cf_${ciNum.key}`]: '1200.5' });
  const ciId = Number((ciMade.loc || '').split('/').pop());
  check('a CI is made with its values', ciMade.status === 302 && ciId > 0 && await count('SELECT count(*) AS c FROM custom_field_values WHERE entity_type = ? AND entity_id = ?', ['ci', ciId]) === 2);
  const ciShow = await admin.get(`/cmdb/${ciId}`);
  check('the CI page shows them as details, and the edit page as inputs', /<dt class="col-sm-4">Support contract<\/dt><dd[^>]*>GOLD-24x7<\/dd>/.test(ciShow.text) && /<dt class="col-sm-4">Annual cost<\/dt><dd[^>]*>1200.5<\/dd>/.test(ciShow.text) && value((await admin.get(`/cmdb/${ciId}/edit`)).text, `cf_${ciNum.key}`) === '1200.5');
  const ciUser = await maria.get(`/cmdb/${ciId}`);
  check('an end user who can open a CI sees only the fields meant for everyone', ciUser.status === 200 && ciUser.text.includes('GOLD-24x7') && !ciUser.text.includes('Annual cost'));
  const ciUp = await admin.post(`/cmdb/${ciId}/update`, { name: `Srv ${tag}`, ci_type: 'server', status: 'in_use', environment: 'production', [`cf_${ciField.key}`]: 'GOLD-24x7', [`cf_${ciNum.key}`]: '999' });
  check('and a CI\'s value changes on update', ciUp.status === 302 && (await one('SELECT value FROM custom_field_values WHERE entity_type = ? AND entity_id = ? AND field_id = ?', ['ci', ciId, ciNum.id])).value === '999');

  // ---------------------------------------------------------------------------------------------------- the API
  section = 'the API';
  const key = async (b, scope) => (await b.post('/profile/api-keys', { name: `cf ${scope} ${tag}`, scope, expires: '' })).text.match(/ndk_[A-Za-z0-9_-]{40}/)[0];
  const adminKey = await key(admin, 'write'); const userKey = await key(maria, 'write');
  const api = async (method, p, body, k = adminKey, headers = {}) => {
    const res = await fetch(`${base}/api/v1${p}`, { method, headers: { Authorization: `Bearer ${k}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* none */ }
    return { status: res.status, json, text };
  };
  const g = await api('GET', `/incidents/${incId}`);
  check('an incident carries its custom fields: numbers as numbers, yes/no as booleans, an unset one as null, a choice as its value', g.status === 200 && g.json.custom_fields[costCentre.key] === 'CC-FINAL' && g.json.custom_fields[qty.key] === 7 && g.json.custom_fields[flag.key] === false && g.json.custom_fields[due.key] === null && g.json.custom_fields[urgencyBand.key] === 'gold' && g.json.custom_fields[staffOnly.key] === 'note', g.text.slice(0, 500));
  const gu = await api('GET', `/incidents/${myId}`, undefined, userKey);
  check('an end user\'s key sees only the fields meant for everyone', gu.status === 200 && costCentre.key in gu.json.custom_fields && !(staffOnly.key in gu.json.custom_fields));
  const list = await api('GET', '/incidents?per_page=50');
  check('the list carries them too, for every row', list.status === 200 && list.json.data.length > 1 && list.json.data.every((r) => r.custom_fields && typeof r.custom_fields === 'object') && list.json.data.find((r) => r.id === incId).custom_fields[costCentre.key] === 'CC-FINAL');
  const post = await api('POST', '/incidents', { short_description: `Via API ${tag}`, custom_fields: { [costCentre.key]: 'CC-API', [qty.key]: 3, [due.key]: '2027-01-15', [urgencyBand.key]: 'Platinum', [flag.key]: true } });
  check('creating with custom_fields: 201, the values come back typed (a choice given by its label)', post.status === 201 && post.json.custom_fields[costCentre.key] === 'CC-API' && post.json.custom_fields[qty.key] === 3 && post.json.custom_fields[urgencyBand.key] === 'platinum' && post.json.custom_fields[flag.key] === true && post.json.custom_fields[due.key] === '2027-01-15', post.text.slice(0, 400));
  const apiId = post.json && post.json.id;
  const needs = async (name, body, k, field, re) => { const r = await api('POST', '/incidents', { short_description: `API ${name} ${tag}`, ...body }, k); check(`API: ${name} is a 400 naming the field`, r.status === 400 && r.json.error.details.some((d) => d.field === field && re.test(d.message)), r.text.slice(0, 300)); };
  const nBefore = await count('SELECT count(*) AS c FROM incidents');
  await needs('a missing required field', {}, adminKey, `custom_fields.${costCentre.key}`, /required/);
  await needs('a null for a required field', { custom_fields: { [costCentre.key]: null } }, adminKey, `custom_fields.${costCentre.key}`, /required/);
  await needs('an unknown key', { custom_fields: { [costCentre.key]: 'x', nonsense: 1 } }, adminKey, 'custom_fields.nonsense', /not a custom field/);
  await needs('a number sent as text that is not one', { custom_fields: { [costCentre.key]: 'x', [qty.key]: 'many' } }, adminKey, `custom_fields.${qty.key}`, /number/);
  await needs('a text where a number is expected, as an object', { custom_fields: { [costCentre.key]: 'x', [qty.key]: {} } }, adminKey, `custom_fields.${qty.key}`, /number/);
  await needs('a choice not on the list', { custom_fields: { [costCentre.key]: 'x', [urgencyBand.key]: 'diamond' } }, adminKey, `custom_fields.${urgencyBand.key}`, /one of/);
  await needs('a yes/no that is not a boolean', { custom_fields: { [costCentre.key]: 'x', [flag.key]: 'maybe' } }, adminKey, `custom_fields.${flag.key}`, /true or false/);
  await needs('a staff-only key from an end user', { custom_fields: { [costCentre.key]: 'x', [staffOnly.key]: 'y' } }, userKey, `custom_fields.${staffOnly.key}`, /not a custom field/);
  const arr = await api('POST', '/incidents', { short_description: 'x', custom_fields: [1] });
  check('API: custom_fields must be an object', arr.status === 400 && arr.json.error.details.some((d) => d.field === 'custom_fields' && /object/.test(d.message)));
  check('API: custom_fields as a string is refused too', (await api('POST', '/incidents', { short_description: 'x', custom_fields: 'a=b' })).status === 400);
  check('and none of those refusals made an incident', await count('SELECT count(*) AS c FROM incidents') === nBefore);
  const patch = await api('PATCH', `/incidents/${apiId}`, { custom_fields: { [qty.key]: 4.5 } });
  check('PATCH with only custom_fields changes just that value, the others stay', patch.status === 200 && patch.json.custom_fields[qty.key] === 4.5 && patch.json.custom_fields[costCentre.key] === 'CC-API' && patch.json.custom_fields[urgencyBand.key] === 'platinum');
  check('PATCH null clears an optional value', (await api('PATCH', `/incidents/${apiId}`, { custom_fields: { [due.key]: null } })).json.custom_fields[due.key] === null && await count('SELECT count(*) AS c FROM custom_field_values WHERE entity_type = ? AND entity_id = ? AND field_id = ?', ['incident', apiId, due.id]) === 0);
  const clearReq = await api('PATCH', `/incidents/${apiId}`, { custom_fields: { [costCentre.key]: '' } });
  check('PATCH cannot clear a required value', clearReq.status === 400 && (await api('GET', `/incidents/${apiId}`)).json.custom_fields[costCentre.key] === 'CC-API');
  check('PATCH writes the history like a page does, naming the API as no one in particular (the key\'s owner)', (await q("SELECT message FROM activity_log WHERE entity_type = 'incident' AND entity_id = ?", [apiId])).some((r) => r.message === 'Affected users changed from "3" to "4.5"'));
  check('an empty PATCH body is still refused', (await api('PATCH', `/incidents/${apiId}`, {})).status === 400);
  const idem = { 'Idempotency-Key': `cf-${tag}` };
  const i1 = await api('POST', '/incidents', { short_description: `Idem ${tag}`, custom_fields: { [costCentre.key]: 'CC-IDEM' } }, adminKey, idem);
  const i2 = await api('POST', '/incidents', { short_description: `Idem ${tag}`, custom_fields: { [costCentre.key]: 'CC-IDEM' } }, adminKey, idem);
  check('a retried POST with the same Idempotency-Key makes one incident with one set of values', i1.status === 201 && i2.status === 201 && i1.json.id === i2.json.id && await count('SELECT count(*) AS c FROM custom_field_values WHERE entity_type = ? AND entity_id = ?', ['incident', i1.json.id]) === 1);
  // requests and CIs (write), changes and problems (read)
  const reqPost = await api('POST', '/requests', { catalog_item_id: catalog.id, notes: 'api', custom_fields: { [reqField.key]: 'CC-R', [reqFlag.key]: true } }, userKey);
  check('a request can be made through the API with its fields, as an end user', reqPost.status === 201 && reqPost.json.custom_fields[reqField.key] === 'CC-R' && reqPost.json.custom_fields[reqFlag.key] === true, reqPost.text.slice(0, 300));
  check('a required yes/no must be true through the API too', (await api('POST', '/requests', { catalog_item_id: catalog.id, custom_fields: { [reqField.key]: 'x', [reqFlag.key]: false } }, userKey)).status === 400);
  check('staff change a request\'s value through the API', (await api('PATCH', `/requests/${reqPost.json.id}`, { custom_fields: { [reqField.key]: 'CC-R2' } })).json.custom_fields[reqField.key] === 'CC-R2');
  check('an end user\'s key cannot change a request at all', (await api('PATCH', `/requests/${reqPost.json.id}`, { custom_fields: { [reqField.key]: 'HACK' } }, userKey)).status === 403);
  const ciPost = await api('POST', '/cis', { name: `ApiSrv ${tag}`, ci_type: 'server', custom_fields: { [ciField.key]: 'SILVER', [ciNum.key]: 10 } });
  check('a CI can be made through the API with its fields', ciPost.status === 201 && ciPost.json.custom_fields[ciField.key] === 'SILVER' && ciPost.json.custom_fields[ciNum.key] === 10);
  check('and changed, and listed with them', (await api('PATCH', `/cis/${ciPost.json.id}`, { custom_fields: { [ciNum.key]: 11 } })).json.custom_fields[ciNum.key] === 11 && (await api('GET', '/cis?per_page=100')).json.data.find((c) => c.id === ciPost.json.id).custom_fields[ciField.key] === 'SILVER');
  check('a CI needs its required field through the API', (await api('POST', '/cis', { name: 'nope', ci_type: 'server' })).status === 400);
  check('an end user\'s key sees a CI without the staff-only field', !(ciNum.key in (await api('GET', `/cis/${ciPost.json.id}`, undefined, userKey)).json.custom_fields) && (ciField.key in (await api('GET', `/cis/${ciPost.json.id}`, undefined, userKey)).json.custom_fields));
  check('changes and problems are read-only in the API, and show their fields', (await api('GET', `/changes/${chgId}`)).json.custom_fields[chgField.key] === '2026-12-01' && (await api('GET', `/problems/${probId}`)).json.custom_fields[probField.key] === 'network' && (await api('GET', '/changes')).json.data.every((c) => c.custom_fields) && (await api('GET', '/problems')).json.data.every((c) => c.custom_fields));
  const spec = await fetch(`${base}/api/v1/openapi.json`).then((r) => r.json());
  const schemaHas = (name) => spec.components.schemas[name] && spec.components.schemas[name].properties.custom_fields;
  check('the OpenAPI document describes custom_fields in every shape, and in the bodies that accept it', ['Incident', 'Request', 'Change', 'Problem', 'Ci'].every(schemaHas)
    && ['post', 'patch'].every((m) => spec.paths['/incidents' + (m === 'patch' ? '/{id}' : '')][m].requestBody.content['application/json'].schema.properties.custom_fields.type === 'object'));
  check('a switched-off field is gone from the API, and back when switched on', await (async () => {
    await editField(qty.id, { label: 'Affected users' }, { on: false });
    const off = (await api('GET', `/incidents/${incId}`)).json.custom_fields;
    const set = await api('PATCH', `/incidents/${incId}`, { custom_fields: { [qty.key]: 1 } });
    await editField(qty.id, { label: 'Affected users' });
    return !(qty.key in off) && set.status === 400 && (await api('GET', `/incidents/${incId}`)).json.custom_fields[qty.key] === 7;
  })());
  check('a read-only key can read custom fields but not write them', await (async () => { const ro = await key(admin, 'read'); return (await api('GET', `/incidents/${incId}`, undefined, ro)).json.custom_fields[costCentre.key] === 'CC-FINAL' && (await api('PATCH', `/incidents/${incId}`, { custom_fields: { [costCentre.key]: 'x' } }, ro)).status === 403; })());

  // ---------------------------------------------------------------------------------------------------------- CSV
  section = 'CSV export';
  await upd({ [`cf_${costCentre.key}`]: '=SUM(A1)', [`cf_${qty.key}`]: '7', [`cf_${urgencyBand.key}`]: 'gold', [`cf_${staffOnly.key}`]: 'a, "quoted"\nline two', [`cf_${flag.key}`]: 'on' });
  const csv = await admin.get('/incidents/export.csv');
  const header = csv.text.split('\n')[0];
  check('the export has a column for each active field, by label, after the usual ones', csv.status === 200 && header.endsWith('Created,Cost centre,Impact area ' + tag + ',Service tier,Root cause note,Affected users,Customer deadline,Executive impact') || (header.includes('Cost centre') && header.indexOf('Created') < header.indexOf('Cost centre')), header);
  const line = csv.text.split('\n').find((l) => l.includes(`Printer on fire ${tag}`)) || '';
  check('a choice is shown by its label, a yes/no as Yes or No, and a value that starts with = cannot run as a formula', csv.text.includes('Gold plus') && csv.text.includes('Yes') && /'=SUM\(A1\)/.test(csv.text), line);
  check('commas, quotes and line breaks in a value are quoted properly', csv.text.includes('"a, ""quoted""\nline two"'));
  check('an agent can export; an end user cannot', (await jane.get('/incidents/export.csv')).status === 200 && (await maria.get('/incidents/export.csv')).status === 403);
  check('a switched-off field is not in the export', await (async () => { await editField(urgencyBand.id, { label: 'Service tier', options: 'gold|Gold plus\nsilver|Silver\nPlatinum' }, { on: false }); const t = (await admin.get('/incidents/export.csv')).text.split('\n')[0]; await editField(urgencyBand.id, { label: 'Service tier', options: 'gold|Gold plus\nsilver|Silver\nPlatinum' }); return !t.includes('Service tier'); })());
  for (const [entity, url, name] of [['request', '/requests/export.csv', 'Cost centre'], ['problem', '/problems/export.csv', 'Owning team'], ['change', '/changes/export.csv', 'Change window'], ['ci', '/cmdb/export.csv', 'Support contract']]) {
    const r = await admin.get(url);
    check(`the ${entity} export has its columns`, r.status === 200 && r.text.split('\n')[0].includes(name), r.text.split('\n')[0]);
  }
  check('the CI export shows the values', (await admin.get('/cmdb/export.csv')).text.includes('GOLD-24x7'));

  // ------------------------------------------------------------------------------------------------------ webhooks
  section = 'webhooks';
  const webhooks = require('../src/webhooks');
  const built = await webhooks.buildPayload({ entity: 'incident', entity_id: incId, op: 'updated', created_at: '2026-10-30 12:00:00', snapshot: null }, 'evt_check');
  const wf = built && built.payload.data.incident.custom_fields;
  check('an event for an incident carries every active custom field (a receiver is an integration, so staff-only ones too), typed as in the API', wf && wf[costCentre.key] === '=SUM(A1)' && wf[qty.key] === 7 && wf[flag.key] === true && wf[staffOnly.key] === 'a, "quoted"\nline two' && wf[due.key] === null);
  const builtCi = await webhooks.buildPayload({ entity: 'ci', entity_id: ciId, op: 'created', created_at: '2026-10-30 12:00:00', snapshot: null }, 'evt_check2');
  check('and so does an event for a configuration item', builtCi && builtCi.payload.data.ci.custom_fields[ciField.key] === 'GOLD-24x7' && builtCi.payload.data.ci.custom_fields[ciNum.key] === 999);

  // ---------------------------------------------------------------------------------------- automated record creation
  section = 'automated creation';
  const actions = require('../src/incidentActions');
  const auto1 = await actions.createIncident({ actor: { id: adminId, full_name: 'x' }, fields: { short_description: `By a mail ${tag}`, caller_id: mariaId } });
  check('a record made by something that is not a form (inbound email, decommissioning) is not held up by required fields, and has no values', auto1.id > 0 && await count('SELECT count(*) AS c FROM custom_field_values WHERE entity_type = ? AND entity_id = ?', ['incident', auto1.id]) === 0);
  check('and it can be completed later in the page: the required field is asked for on the next save', (await upd({}, admin, auto1.id)).status === 400 && (await upd({ [`cf_${costCentre.key}`]: 'CC-LATE' }, admin, auto1.id)).status === 302);
  void actions;

  // ------------------------------------------------------------------------------------------------------ deleting
  section = 'deleting';
  const gone = await admin.post('/incidents', { short_description: `To delete ${tag}`, [`cf_${costCentre.key}`]: 'CC-DEL' });
  const goneId = Number(gone.loc.split('/').pop());
  check('before: the record has a value', await count('SELECT count(*) AS c FROM custom_field_values WHERE entity_type = ? AND entity_id = ?', ['incident', goneId]) === 1);
  await admin.post(`/incidents/${goneId}/delete`);
  check('deleting a record deletes its values, through the page', await count('SELECT count(*) AS c FROM incidents WHERE id = ?', [goneId]) === 0 && await count('SELECT count(*) AS c FROM custom_field_values WHERE entity_type = ? AND entity_id = ?', ['incident', goneId]) === 0);
  const rawGone = (await q("INSERT INTO incidents (number, short_description, caller_id) VALUES (?, 'raw', ?) RETURNING id", [`INCRAW-${tag}`, mariaId]))[0].id;
  await q('INSERT INTO custom_field_values (entity_type, entity_id, field_id, value) VALUES (?, ?, ?, ?)', ['incident', rawGone, costCentre.id, 'raw']);
  await q('DELETE FROM incidents WHERE id = ?', [rawGone]);
  check('and by any other route (straight in the database)', await count('SELECT count(*) AS c FROM custom_field_values WHERE entity_type = ? AND entity_id = ?', ['incident', rawGone]) === 0);
  const fieldCount = await count('SELECT count(*) AS c FROM custom_field_values WHERE field_id = ?', [urgencyBand.id]);
  const delPage = await admin.get(`/settings/fields/${urgencyBand.id}`);
  check('the delete button says how many values will go', delPage.text.includes(`${fieldCount} stored value`) && delPage.text.includes('data-confirm'));
  const del = await admin.post(`/settings/fields/${urgencyBand.id}/delete`);
  check('deleting a field deletes its values, and says how many', del.status === 200 && new RegExp(`its ${fieldCount} stored value`).test(del.text) && await count('SELECT count(*) AS c FROM custom_field_values WHERE field_id = ?', [urgencyBand.id]) === 0 && await count('SELECT count(*) AS c FROM custom_fields WHERE id = ?', [urgencyBand.id]) === 0);
  check('it is in the audit log', (await lastAudit('customfield.deleted')).detail.includes(`${fieldCount} value`));
  check('the record\'s page works without the field, and the other fields are untouched', (await admin.get(`/incidents/${incId}`)).status === 200 && (await one('SELECT value FROM custom_field_values WHERE entity_type = ? AND entity_id = ? AND field_id = ?', ['incident', incId, costCentre.id])).value === '=SUM(A1)');

  // clean up: this script's fields (and, with them, their values) go; the records it made stay like any test data
  await q("DELETE FROM custom_fields WHERE key LIKE '%\\_' || ?", [tag]);
  section = 'the log';
  const errors = app.text().split('\n').filter((l) => /error|unhandled|exception|failed/i.test(l));
  check('the server log shows no errors from any of this', errors.length === 0, errors.slice(-3).join(' | '));
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASS');
  process.exitCode = failed ? 1 : 0;
}

// The incident actions module opens its own database pool in this process, so end explicitly rather than wait for it to idle out.
main().then(() => process.exit(process.exitCode || 0), (e) => { console.error(e); process.exit(1); });
