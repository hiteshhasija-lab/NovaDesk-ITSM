#!/usr/bin/env node
// The REST API (/api/v1) used the way a client uses it, against a running NovaDesk with the demonstration users:
// keys made on the page, every role, reads and writes, validation, idempotency, revocation, the shapes the
// documentation promises, and (by starting its own copies) rate limits and reverse-proxy addresses.
//   node scripts/api-check.js     starts its own copies of NovaDesk (ports 18210 to 18213) on the database named by PGHOST, PGUSER,
//                                 PGPASSWORD and PGDATABASE, so it never shares sign-in limits with another run. The database needs
//                                 the demonstration users (an empty one gets them: SEED_DEMO=true is set for the copies).
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const { SHAPES, RESPONSES } = require('../src/api/spec');

let BASE = 'http://127.0.0.1:18210';
const ROOT = path.join(__dirname, '..');
let failed = 0; let section = '';
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  [${section}] ${name}${!ok && extra ? '  -- ' + extra : ''}`); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Math.random().toString(36).slice(2, 8);

class Browser {
  constructor(base = BASE) { this.base = base; this.cookie = ''; }
  async req(method, p, form) {
    const headers = { Cookie: this.cookie }; let body;
    if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = (() => { const sp = new URLSearchParams(); for (const [k, v] of Object.entries(form)) for (const x of (Array.isArray(v) ? v : [v])) sp.append(k, x); return sp.toString(); })(); }
    const res = await fetch(this.base + p, { method, headers, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]; const jar = Object.fromEntries(this.cookie.split('; ').filter(Boolean).map((x) => [x.split('=')[0], x])); jar[kv.split('=')[0]] = kv; this.cookie = Object.values(jar).join('; '); }
    return { status: res.status, loc: res.headers.get('location'), text: await res.text() };
  }
  get(p) { return this.req('GET', p); }
  post(p, f) { return this.req('POST', p, f || {}); }
  async login(u, pw) { const r = await this.post('/login', { username: u, password: pw }); if (r.status !== 302) throw new Error(`sign-in as ${u} failed (${r.status})`); return this; }
}
async function makeKey(browser, name, scope, expires = '90') {
  const r = await browser.post('/profile/api-keys', { name, scope, expires });
  const m = r.text.match(/id="newApiKey"[^>]*>(ndk_[A-Za-z0-9_-]{40})</);
  if (!m) throw new Error(`no key shown (${r.status})`);
  return m[1];
}
async function api(token, method, p, { body, headers = {}, base = BASE, rawBody, contentType } = {}) {
  const h = { ...headers }; if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (rawBody !== undefined) { payload = rawBody; h['Content-Type'] = contentType || 'application/json'; }
  else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  const res = await fetch(base + '/api/v1' + p, { method, headers: h, body: payload });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, json, text };
}

// An answer against the documented shape: exactly these properties, of these types.
function shapeProblems(name, value, path = name) {
  const out = [];
  const shape = SHAPES[name];
  if (!value || typeof value !== 'object') return [`${path} is not an object`];
  for (const k of Object.keys(value)) if (!(k in shape)) out.push(`${path}.${k} is not documented`);
  for (const [k, t] of Object.entries(shape)) {
    if (!(k in value)) { out.push(`${path}.${k} is missing`); continue; }
    const nullable = t.endsWith('?'); const base = t.replace(/\?$/, ''); const v = value[k];
    if (v === null) { if (!nullable) out.push(`${path}.${k} is null`); continue; }
    if (SHAPES[base]) out.push(...shapeProblems(base, v, `${path}.${k}`));
    else if (base === 'integer' ? !Number.isInteger(v) : base === 'object' ? typeof v !== 'object' : typeof v !== base) out.push(`${path}.${k} should be ${base}`);
  }
  return out;
}
const shapeOk = (route, body) => {
  const target = RESPONSES[route]; const items = Array.isArray(target) ? body.data : [body]; const name = Array.isArray(target) ? target[0] : target;
  const problems = items.flatMap((it, i) => shapeProblems(name, it, `${name}[${i}]`));
  if (Array.isArray(target) && !(Number.isInteger(body.page) && Number.isInteger(body.per_page) && Number.isInteger(body.total))) problems.push('page, per_page or total missing');
  return problems;
};
const errCode = (r, status, code) => r.status === status && r.json && r.json.error && r.json.error.code === code;

async function main() {
  const own = start(18210, { SEED_DEMO: 'true' });
  try {
    if (!(await healthy(18210, own))) throw new Error(`NovaDesk did not start: ${own.text().slice(-400)}`);
    await run();
  } finally { own.child.kill(); await own.exited; }
  await limits(keys);
}

let keys = null;
async function run() {
  const admin = await new Browser().login('admin', 'admin123');
  const jane = await new Browser().login('jdoe', 'agent123');
  const maria = await new Browser().login('mchen', 'user123');
  const raj = await new Browser().login('rpatel', 'user123');

  section = 'keys';
  const mariaRead = await makeKey(maria, `read ${tag}`, 'read');
  const mariaWrite = await makeKey(maria, `write ${tag}`, 'write');
  const janeRead = await makeKey(jane, `jane read ${tag}`, 'read');
  const janeWrite = await makeKey(jane, `jane write ${tag}`, 'write');
  const adminWrite = await makeKey(admin, `admin ${tag}`, 'write', 'never');
  const rajWrite = await makeKey(raj, `raj ${tag}`, 'write');
  const page = (await jane.get('/profile/api-keys')).text;
  check('the keys page lists them by prefix and never shows a key again', page.includes(`jane read ${tag}`) && page.includes(`${janeRead.slice(0, 8)}…`) && !page.includes(janeRead));
  check('without a key: 401 with a challenge', errCode(await api(null, 'GET', '/me'), 401, 'unauthorized') && (await api(null, 'GET', '/me')).headers.get('www-authenticate').startsWith('Bearer'));
  for (const [label, token] of [['a mistyped key', `${janeRead.slice(0, -1)}${janeRead.endsWith('A') ? 'B' : 'A'}`], ['a key of the wrong shape', 'ndk_short'], ['not a key at all', 'hunter2']]) {
    check(`${label}: 401 invalid_token`, errCode(await api(token, 'GET', '/me'), 401, 'invalid_token'));
  }
  const viaCookie = await fetch(`${BASE}/api/v1/me`, { headers: { Cookie: jane.cookie } });
  check('a signed-in browser session is NOT an API credential', viaCookie.status === 401);
  const me = await api(janeRead, 'GET', '/me');
  check('/me says who the key acts as', me.status === 200 && me.json.username === 'jdoe' && me.json.role === 'agent' && me.json.key.scope === 'read' && shapeOk('Me', me.json).length === 0, shapeOk('Me', me.json || {}).join('; '));
  check('a key never appears in /me or in the key list', !JSON.stringify(me.json).includes(janeRead));

  section = 'incidents';
  const key = `inc-${tag}`;
  const created = await api(janeWrite, 'POST', '/incidents', { body: { short_description: `API incident ${tag}`, description: 'made over the API', impact: 2, urgency: 1, category: 'network' }, headers: { 'Idempotency-Key': key } });
  check('create: 201, Location, the documented shape, priority worked out, SLA clock running', created.status === 201 && /\/api\/v1\/incidents\/\d+$/.test(created.headers.get('location') || '') && shapeOk('Incident', created.json).length === 0 && created.json.priority === 2 && created.json.status === 'new' && created.json.sla && created.json.sla.status === 'on_track' && created.json.caller.id === me.json.id, shapeOk('Incident', created.json || {}).join('; ') || created.text.slice(0, 200));
  const incId = created.json && created.json.id;
  const replay = await api(janeWrite, 'POST', '/incidents', { body: { short_description: `API incident ${tag}`, description: 'made over the API', impact: 2, urgency: 1, category: 'network' }, headers: { 'Idempotency-Key': key } });
  check('the same Idempotency-Key replays the first answer and creates nothing', replay.status === 201 && replay.json.id === incId && replay.headers.get('idempotent-replay') === 'true');
  const reuse = await api(janeWrite, 'POST', '/incidents', { body: { short_description: 'something else' }, headers: { 'Idempotency-Key': key } });
  check('...but the key cannot be reused for a different request', errCode(reuse, 422, 'idempotency_key_reuse'));
  const count = await api(janeRead, 'GET', `/incidents?q=${encodeURIComponent(`API incident ${tag}`)}`);
  check('exactly one incident exists after the retry', count.json.total === 1);
  check('the page shows the incident too (same record, same rules)', (await jane.get(`/incidents/${incId}`)).text.includes(`API incident ${tag}`));
  const got = await api(janeRead, 'GET', `/incidents/${incId}`);
  check('get: the documented shape', got.status === 200 && shapeOk('Incident', got.json).length === 0);
  const readOnly = await api(janeRead, 'POST', '/incidents', { body: { short_description: 'nope' } });
  check('a read-only key cannot create (403 insufficient_scope)', errCode(readOnly, 403, 'insufficient_scope'));
  const patched = await api(janeWrite, 'PATCH', `/incidents/${incId}`, { body: { status: 'on_hold', assigned_to: me.json.id } });
  check('change: On Hold pauses the SLA clock and the assignee is set', patched.status === 200 && patched.json.status === 'on_hold' && patched.json.sla.paused === true && patched.json.sla.status === 'paused' && patched.json.assigned_to.id === me.json.id, patched.text.slice(0, 200));
  const resumed = await api(janeWrite, 'PATCH', `/incidents/${incId}`, { body: { status: 'in_progress', impact: 1 } });
  check('...resuming restarts it, and a higher impact makes it P1 with a tighter target', resumed.status === 200 && resumed.json.sla.paused === false && resumed.json.priority === 1 && resumed.json.sla.target_minutes === 240, resumed.text.slice(0, 200));
  check('the activity log records the API change like any other', (await jane.get(`/incidents/${incId}`)).text.includes('SLA clock paused (On Hold)'));
  const cleared = await api(janeWrite, 'PATCH', `/incidents/${incId}`, { body: { assigned_to: null, subcategory: null } });
  check('null clears a field that allows it', cleared.status === 200 && cleared.json.assigned_to === null);
  check('an empty change is refused', errCode(await api(janeWrite, 'PATCH', `/incidents/${incId}`, { body: {} }), 400, 'invalid_request'));
  const typo = await api(janeWrite, 'PATCH', `/incidents/${incId}`, { body: { statuss: 'closed' } });
  check('a misspelt field is refused and named', errCode(typo, 400, 'invalid_request') && typo.json.error.details.some((d) => d.field === 'statuss'));
  const badEnum = await api(janeWrite, 'PATCH', `/incidents/${incId}`, { body: { status: 'finished', impact: 9 } });
  check('every problem is reported at once', badEnum.status === 400 && badEnum.json.error.details.length === 2);
  check('a reference to nobody is 422', errCode(await api(janeWrite, 'PATCH', `/incidents/${incId}`, { body: { assigned_to: 999999 } }), 422, 'invalid_reference') && errCode(await api(janeWrite, 'POST', '/incidents', { body: { short_description: 'x', affected_ci_id: 999999 } }), 422, 'invalid_reference'));
  check('an end user cannot be the assignee', errCode(await api(janeWrite, 'PATCH', `/incidents/${incId}`, { body: { assigned_to: (await api(janeRead, 'GET', '/users?role=user')).json.data[0].id } }), 422, 'invalid_reference'));

  const note = await api(janeWrite, 'POST', `/incidents/${incId}/comments`, { body: { comment: `internal ${tag}`, work_note: true } });
  const pub = await api(janeWrite, 'POST', `/incidents/${incId}/comments`, { body: { comment: `public ${tag}` } });
  check('comments: a work note and a public comment, documented shape', note.status === 201 && note.json.work_note === true && pub.status === 201 && pub.json.work_note === false && shapeOk('Comment', note.json).length === 0);
  const commentsStaff = await api(janeRead, 'GET', `/incidents/${incId}/comments`);
  check('staff see both', commentsStaff.json.total === 2 && shapeOk('CommentList', commentsStaff.json).length === 0);

  section = 'end users';
  const mine = await api(mariaWrite, 'POST', '/incidents', { body: { short_description: `Maria's incident ${tag}`, impact: 3, urgency: 3 } });
  const mineId = mine.json && mine.json.id;
  check('an end user creates an incident as themselves', mine.status === 201 && mine.json.caller.username === undefined && mine.json.caller.id !== me.json.id && mine.json.assigned_to === null);
  check('...and may not choose the caller or the assignee', errCode(await api(mariaWrite, 'POST', '/incidents', { body: { short_description: 'x', caller_id: me.json.id } }), 403, 'forbidden') && errCode(await api(mariaWrite, 'POST', '/incidents', { body: { short_description: 'x', assigned_to: me.json.id } }), 403, 'forbidden'));
  const list = await api(mariaRead, 'GET', '/incidents?per_page=200');
  check('an end user lists only their own incidents', list.status === 200 && list.json.data.length > 0 && list.json.data.every((i) => i.caller.id === mine.json.caller.id) && !list.json.data.some((i) => i.id === incId));
  check("someone else's incident is 404, not 403 (it is not revealed)", errCode(await api(mariaRead, 'GET', `/incidents/${incId}`), 404, 'not_found'));
  check('an end user cannot change an incident', errCode(await api(mariaWrite, 'PATCH', `/incidents/${mineId}`, { body: { status: 'closed' } }), 403, 'forbidden'));
  check('...but can comment on their own, and not add work notes', (await api(mariaWrite, 'POST', `/incidents/${mineId}/comments`, { body: { comment: 'thanks' } })).status === 201 && errCode(await api(mariaWrite, 'POST', `/incidents/${mineId}/comments`, { body: { comment: 'x', work_note: true } }), 403, 'forbidden'));
  await api(janeWrite, 'POST', `/incidents/${mineId}/comments`, { body: { comment: `staff only ${tag}`, work_note: true } });
  const seen = await api(mariaRead, 'GET', `/incidents/${mineId}/comments`);
  check('work notes are hidden from the end user', seen.status === 200 && seen.json.data.every((c) => !c.work_note) && !seen.text.includes(`staff only ${tag}`));
  check('an end user cannot read the staff-only parts of the API', (await Promise.all(['/users', '/changes', '/problems'].map((p) => api(mariaRead, 'GET', p)))).every((r) => errCode(r, 403, 'forbidden')) && errCode(await api(mariaWrite, 'POST', '/cis', { body: { name: 'x', ci_type: 'server' } }), 403, 'forbidden'));

  section = 'service requests';
  const items = await api(mariaRead, 'GET', '/catalog-items');
  check('the catalog can be listed by anyone', items.status === 200 && items.json.data.length > 0 && shapeOk('CatalogItemList', items.json).length === 0);
  const itemId = items.json.data[0].id;
  const req1 = await api(mariaWrite, 'POST', '/requests', { body: { catalog_item_id: itemId, notes: `API request ${tag}` }, headers: { 'Idempotency-Key': `req-${tag}` } });
  check('submit a request: 201 and the documented shape', req1.status === 201 && shapeOk('Request', req1.json).length === 0 && req1.json.status === 'submitted', shapeOk('Request', req1.json || {}).join('; '));
  check('a retry with the same key does not submit twice', (await api(mariaWrite, 'POST', '/requests', { body: { catalog_item_id: itemId, notes: `API request ${tag}` }, headers: { 'Idempotency-Key': `req-${tag}` } })).json.id === req1.json.id && (await api(mariaRead, 'GET', '/requests?per_page=200')).json.data.filter((r) => r.notes === `API request ${tag}`).length === 1);
  check('a request for something that cannot be requested is 422', errCode(await api(mariaWrite, 'POST', '/requests', { body: { catalog_item_id: 999999 } }), 422, 'invalid_reference'));
  check("an end user cannot see someone else's request, nor change one", errCode(await api(await makeKey(raj, `raj read ${tag}`, 'read'), 'GET', `/requests/${req1.json.id}`), 404, 'not_found') && errCode(await api(mariaWrite, 'PATCH', `/requests/${req1.json.id}`, { body: { status: 'fulfilled' } }), 403, 'forbidden'));
  const done = await api(janeWrite, 'PATCH', `/requests/${req1.json.id}`, { body: { status: 'fulfilled' } });
  check('staff fulfil it: fulfilled_at is set', done.status === 200 && done.json.status === 'fulfilled' && done.json.fulfilled_at && shapeOk('Request', done.json).length === 0);
  check('staff list requests with a filter', (await api(janeRead, 'GET', '/requests?status=fulfilled')).json.data.some((r) => r.id === req1.json.id));

  section = 'configuration items, changes, problems, articles, people';
  const ci = await api(janeWrite, 'POST', '/cis', { body: { name: `API-CI-${tag}`, ci_type: 'server', ip_address: '10.9.8.7', warranty_expiry: '2030-01-31' } });
  check('create a configuration item: defaults applied, documented shape', ci.status === 201 && ci.json.environment === 'production' && ci.json.status === 'in_use' && /^CI\d+/.test(ci.json.ci_number) && shapeOk('Ci', ci.json).length === 0, shapeOk('Ci', ci.json || {}).join('; ') || ci.text.slice(0, 200));
  check('change it: only what is sent changes', (await api(janeWrite, 'PATCH', `/cis/${ci.json.id}`, { body: { status: 'maintenance', notes: 'fan replaced' } })).json.status === 'maintenance' && (await api(janeRead, 'GET', `/cis/${ci.json.id}`)).json.ip_address === '10.9.8.7');
  check('...and the page shows it', (await jane.get(`/cmdb/${ci.json.id}`)).text.includes(`API-CI-${tag}`));
  check('a bad type or date is refused', errCode(await api(janeWrite, 'POST', '/cis', { body: { name: 'x', ci_type: 'toaster' } }), 400, 'invalid_request') && errCode(await api(janeWrite, 'POST', '/cis', { body: { name: 'x', ci_type: 'server', install_date: '31/01/2030' } }), 400, 'invalid_request'));
  check('search finds it', (await api(janeRead, 'GET', `/cis?q=${tag}`)).json.total === 1 && (await api(janeRead, 'GET', `/cis?ci_type=server&status=maintenance`)).json.data.some((c) => c.id === ci.json.id));
  const changes = await api(janeRead, 'GET', '/changes?per_page=5');
  check('changes can be read by staff, in the documented shape', changes.status === 200 && changes.json.data.length > 0 && shapeOk('ChangeList', changes.json).length === 0, shapeOk('ChangeList', changes.json || {}).join('; '));
  check('...one at a time', (await api(janeRead, 'GET', `/changes/${changes.json.data[0].id}`)).status === 200 && errCode(await api(janeRead, 'GET', '/changes/999999'), 404, 'not_found'));
  check('changes cannot be written through the API at all', errCode(await api(janeWrite, 'POST', '/changes', { body: { short_description: 'x' } }), 404, 'not_found') && errCode(await api(janeWrite, 'PATCH', `/changes/${changes.json.data[0].id}`, { body: { status: 'approved' } }), 404, 'not_found'));
  const problems = await api(adminWrite, 'GET', '/problems');
  check('problems can be read by staff, in the documented shape', problems.status === 200 && shapeOk('ProblemList', problems.json).length === 0, shapeOk('ProblemList', problems.json || {}).join('; '));
  const people = await api(janeRead, 'GET', '/users?q=chen');
  check('people can be found by staff, without any secrets', people.status === 200 && people.json.data.some((u) => u.username === 'mchen') && shapeOk('UserList', people.json).length === 0 && !people.text.includes('password'));
  const arts = await api(mariaRead, 'GET', '/articles');
  check('an end user reads published articles', arts.status === 200 && arts.json.data.length > 0 && arts.json.data.every((a) => a.status === 'published') && shapeOk('ArticleList', arts.json).length === 0, shapeOk('ArticleList', arts.json || {}).join('; '));
  const art = await api(mariaRead, 'GET', `/articles/${arts.json.data[0].id}`);
  check('...one with its full text', art.status === 200 && art.json.body && shapeOk('Article', art.json).length === 0);
  const draft = await jane.post('/kb', { title: `Draft ${tag}`, category: 'how-to', status: 'draft', body: 'not ready' });
  const draftId = (draft.loc || '').match(/\/kb\/(\d+)/);
  check('a draft article is hidden from end users and visible to staff', draftId && errCode(await api(mariaRead, 'GET', `/articles/${draftId[1]}`), 404, 'not_found') && (await api(janeRead, 'GET', `/articles/${draftId[1]}`)).status === 200 && (await api(janeRead, 'GET', '/articles?status=draft')).json.data.some((a) => a.title === `Draft ${tag}`));

  section = 'lists and errors';
  const p1 = await api(janeRead, 'GET', '/incidents?per_page=1&page=1'); const p2 = await api(janeRead, 'GET', '/incidents?per_page=1&page=2');
  check('pagination: pages, per_page and total (also in X-Total-Count), newest first', p1.json.data.length === 1 && p2.json.data.length === 1 && p1.json.data[0].id !== p2.json.data[0].id && p1.json.data[0].id > p2.json.data[0].id && p1.json.total >= 3 && Number(p1.headers.get('x-total-count')) === p1.json.total);
  check('...a page past the end is empty, not an error', (await api(janeRead, 'GET', '/incidents?page=99999')).json.data.length === 0);
  check('bad paging and filters are 400', (await Promise.all(['/incidents?per_page=0', '/incidents?per_page=500', '/incidents?page=abc', '/incidents?status=bogus', '/incidents?priority=9', '/incidents?unknown=1'].map((p) => api(janeRead, 'GET', p)))).every((r) => errCode(r, 400, 'invalid_request')));
  check('filters work: open, priority, caller', (await api(janeRead, 'GET', '/incidents?status=open&priority=1')).json.data.every((i) => i.priority === 1 && !['resolved', 'closed', 'cancelled'].includes(i.status)));
  check('a search with a % in it is just text', (await api(janeRead, 'GET', '/incidents?q=100%25')).status === 200);
  check('broken JSON is 400 invalid_json', errCode(await api(janeWrite, 'POST', '/incidents', { rawBody: '{"short_description": ' }), 400, 'invalid_json'));
  check('a body that is not JSON content is 415', errCode(await api(janeWrite, 'POST', '/incidents', { rawBody: 'short_description=x', contentType: 'application/x-www-form-urlencoded' }), 415, 'unsupported_media_type'));
  check('a body over 256 KB is 413, as JSON', errCode(await api(janeWrite, 'POST', '/incidents', { rawBody: JSON.stringify({ short_description: 'x', description: 'y'.repeat(300 * 1024) }) }), 413, 'payload_too_large'));
  check('a field that is too long is named', (await api(janeWrite, 'POST', '/incidents', { body: { short_description: 'x'.repeat(201) } })).json.error.details[0].field === 'short_description');
  check('ids that are not numbers, and routes that do not exist, are JSON 404s', errCode(await api(janeRead, 'GET', '/incidents/abc'), 404, 'not_found') && errCode(await api(janeRead, 'GET', '/incidents/99999999'), 404, 'not_found') && errCode(await api(janeRead, 'GET', '/nothing-here'), 404, 'not_found'));
  check('a wrong method is a JSON 404 too', errCode(await api(janeWrite, 'DELETE', `/incidents/${incId}`), 404, 'not_found'));
  check('every answer says not to cache it', (await api(janeRead, 'GET', '/me')).headers.get('cache-control') === 'no-store');
  check('rate limit headers are on every answer', (await api(janeRead, 'GET', '/me')).headers.get('x-ratelimit-limit') !== null);

  section = 'documentation';
  const spec = await fetch(`${BASE}/api/v1/openapi.json`); const doc = await spec.json();
  check('the OpenAPI document is public and lists the routes', spec.status === 200 && doc.openapi.startsWith('3.') && Object.keys(doc.paths).includes('/incidents/{id}') && Object.keys(doc.paths).length >= 15);
  const guide = await fetch(`${BASE}/api/docs`); const guideText = await guide.text();
  check('the guide is public, explains keys, errors, limits and idempotency, and lists endpoints', guide.status === 200 && /Idempotency-Key/.test(guideText) && /Authorization: Bearer/.test(guideText) && /\/api\/v1\/incidents/.test(guideText) && /rate_limited|Rate limits/.test(guideText));

  section = 'revoking';
  const revokeTarget = await makeKey(jane, `to revoke ${tag}`, 'read');
  const revokePage = (await jane.get('/profile/api-keys')).text;
  const revokeId = [...revokePage.matchAll(/\/profile\/api-keys\/(\d+)\/revoke/g)].map((m) => m[1]).sort((a, b) => b - a)[0];
  check('a new key works', (await api(revokeTarget, 'GET', '/me')).status === 200);
  const rv = await jane.post(`/profile/api-keys/${revokeId}/revoke`);
  check('revoking it stops it at once', rv.status === 200 && errCode(await api(revokeTarget, 'GET', '/me'), 401, 'invalid_token'));
  const keepKey = await makeKey(jane, `keep ${tag}`, 'read');
  const keepId = [...(await jane.get('/profile/api-keys')).text.matchAll(/\/profile\/api-keys\/(\d+)\/revoke/g)].map((m) => Number(m[1])).sort((a, b) => b - a)[0];
  const attempt = await maria.post(`/profile/api-keys/${keepId}/revoke`);
  check("one person cannot revoke another's key", /not found or is already revoked/.test(attempt.text) && (await api(keepKey, 'GET', '/me')).status === 200);
  const rajList = await api(rajWrite, 'GET', '/me');
  const usersPage = (await admin.get('/users')).text; const rajRow = (usersPage.match(/<tr[^>]*>(?:(?!<\/tr>)[\s\S])*<td>rpatel<\/td>[\s\S]*?<\/tr>/) || [''])[0]; const rajId = (rajRow.match(/\/users\/(\d+)\/edit/) || [])[1];
  check('an administrator can revoke all of someone\'s keys', rajList.status === 200 && (await admin.post(`/users/${rajId}/api-keys/revoke`)).status === 302 && errCode(await api(rajWrite, 'GET', '/me'), 401, 'invalid_token'));
  const temp = await admin.post('/users', { username: `apiuser${tag}`, full_name: 'Api Temp', email: `api.${tag}@corp.local`, role: 'agent', password: 'Temp-pass-123' });
  const tempBrowser = await new Browser().login(`apiuser${tag}`, 'Temp-pass-123'); const tempKey = await makeKey(tempBrowser, 'temp', 'write');
  const tempRow = ((await admin.get('/users')).text.match(new RegExp(`<tr[^>]*>(?:(?!</tr>)[\\s\\S])*<td>apiuser${tag}</td>[\\s\\S]*?</tr>`)) || [''])[0]; const tempId = (tempRow.match(/\/users\/(\d+)\/edit/) || [])[1];
  check('a key works for an active person', temp.status === 302 && tempId && (await api(tempKey, 'GET', '/me')).status === 200);
  await admin.post(`/users/${tempId}/update`, { username: `apiuser${tag}`, full_name: 'Api Temp', email: `api.${tag}@corp.local`, role: 'agent' });   // no "active": turned off
  check('...and stops when the person is turned off', errCode(await api(tempKey, 'GET', '/me'), 401, 'invalid_token'));
  check('too many keys are refused with a message', await (async () => { let last; for (let i = 0; i < 12; i++) last = await janeKeyAttempt(jane, `bulk ${i}`); return /already have 10 active API keys/.test(last); })());

  keys = { janeRead, janeWrite, mariaRead };
}

async function janeKeyAttempt(browser, name) { const r = await browser.post('/profile/api-keys', { name, scope: 'read', expires: '30' }); return r.text; }

// ---------------------------------------------------------------- limits and proxies (own copies of the app)
function start(port, env) {
  const log = [];
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SLA_SWEEP_S: '3600', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => log.push(String(d))); child.stderr.on('data', (d) => log.push(String(d)));
  return { child, text: () => log.join(''), exited: new Promise((r) => child.on('exit', r)) };
}
async function healthy(port, srv) { for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true; } catch { /* wait */ } if (srv.child.exitCode !== null) return false; await sleep(500); } return false; }

async function limits({ janeRead, janeWrite, mariaRead }) {
  section = 'rate limits';
  let port = 18211; let base = `http://127.0.0.1:${port}`;
  let srv = start(port, { RATE_LIMIT_API_PER_MIN: '5', RATE_LIMIT_API_WRITE_PER_MIN: '3', RATE_LIMIT_IP_PER_MIN: '0' });
  try {
    check('a copy with small API limits starts', await healthy(port, srv), srv.text().slice(-300));
    const results = []; for (let i = 0; i < 7; i++) results.push(await api(janeRead, 'GET', '/me', { base }));
    check('reads: five pass, the sixth is 429 with Retry-After and a JSON body', results.slice(0, 5).every((r) => r.status === 200) && errCode(results[5], 429, 'rate_limited') && Number(results[5].headers.get('retry-after')) > 0);
    check('the headers count down', results[0].headers.get('x-ratelimit-limit') === '5' && results[0].headers.get('x-ratelimit-remaining') === '4' && results[3].headers.get('x-ratelimit-remaining') === '1');
    check('another key has its own allowance', (await api(mariaRead, 'GET', '/me', { base })).status === 200);
    const writes = []; for (let i = 0; i < 4; i++) writes.push(await api(janeWrite, 'POST', '/requests', { base, body: { catalog_item_id: 0 } }));
    check('writes have their own, smaller allowance (3 here)', writes.slice(0, 3).every((r) => r.status !== 429) && errCode(writes[3], 429, 'rate_limited'));
    const bad = []; for (let i = 0; i < 32; i++) bad.push(await api('ndk_' + 'x'.repeat(40), 'GET', '/me', { base }));
    check('guessing keys is stopped: after 30 failures from one address, 429', bad.slice(0, 30).every((r) => r.status === 401) && errCode(bad[31], 429, 'rate_limited'));
  } finally { srv.child.kill(); await srv.exited; }

  port = 18212; base = `http://127.0.0.1:${port}`;
  srv = start(port, { RATE_LIMIT_IP_PER_MIN: '12', RATE_LIMIT_API_PER_MIN: '1000' });
  try {
    check('a copy with a small per-address limit starts', await healthy(port, srv), srv.text().slice(-300));
    const codes = []; for (let i = 0; i < 14; i++) codes.push((await fetch(`${base}/login`)).status);
    check('pages: 12 pass, then 429 with a page', codes.slice(0, 12).every((c) => c === 200) && codes[12] === 429);
    const page429 = await fetch(`${base}/login`);
    check('...a readable page with Retry-After', page429.status === 429 && /Too many requests/i.test(await page429.text()) && Number(page429.headers.get('retry-after')) > 0);
    check('the API is covered too, and answers in JSON', errCode(await api(janeRead, 'GET', '/me', { base }), 429, 'rate_limited'));
    check('/health and the stylesheets are never limited', (await fetch(`${base}/health`)).status === 200 && (await fetch(`${base}/css/style.css`)).status === 200);
    const spoof = await fetch(`${base}/login`, { headers: { 'X-Forwarded-For': '203.0.113.9' } });
    check('without TRUST_PROXY a client cannot dodge the limit by writing X-Forwarded-For', spoof.status === 429);
  } finally { srv.child.kill(); await srv.exited; }

  port = 18213; base = `http://127.0.0.1:${port}`;
  srv = start(port, { RATE_LIMIT_IP_PER_MIN: '6', TRUST_PROXY: '1' });
  try {
    check('a copy behind one proxy starts', await healthy(port, srv), srv.text().slice(-300));
    const as = async (ip) => (await fetch(`${base}/login`, { headers: { 'X-Forwarded-For': ip } })).status;
    for (let i = 0; i < 6; i++) await as('198.51.100.1');
    check('behind a proxy each client address has its own allowance', (await as('198.51.100.1')) === 429 && (await as('198.51.100.2')) === 200);
    check('...and only the address the proxy added counts (a forged first entry changes nothing)', (await (async () => { const r = await fetch(`${base}/login`, { headers: { 'X-Forwarded-For': '1.2.3.4, 198.51.100.1' } }); return r.status; })()) === 429);
  } finally { srv.child.kill(); await srv.exited; }
}

main().then(() => { console.log(failed ? `${failed} FAILED` : 'ALL PASS'); process.exit(failed ? 1 : 0); }).catch((e) => { console.error('ABORTED:', e.message); process.exit(2); });
