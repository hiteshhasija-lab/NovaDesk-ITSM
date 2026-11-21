#!/usr/bin/env node
// Custom fields in lists, search and CSV import, end to end, against a copy of NovaDesk that this script starts itself (port 18430) on the database named by
// PGHOST, PGUSER, PGPASSWORD and PGDATABASE: that every list can be filtered by a custom field (text, choice, number and date ranges, yes/no), alone and together with
// the other filters and the search box, that the CSV export follows the filter, that the search box and the global search find a word held in a custom field, that a value a
// person may not see (a staff-only field, a field switched off) can neither be filtered on nor found, that nothing typed can break the query, and that configuration
// items can be imported (and updated) with their custom fields, with every refusal said row by row. Needs the demonstration users.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const knexLib = require('knex');
const { dbConfig } = require('../src/settings');

const ROOT = path.join(__dirname, '..');
let failed = 0; let section = '';
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  [${section}] ${name}${!ok && extra ? '  -- ' + String(extra).slice(0, 500) : ''}`); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Math.random().toString(36).slice(2, 7);
const PORT = 18430;

// A browser: its own cookies, talking to one server.
class Browser {
  constructor(port, host) { this.port = port; this.host = host; this.cookie = ''; this.csrf = null; }
  jar(setCookies) { for (const c of setCookies || []) { const kv = c.split(';')[0]; const j = Object.fromEntries(this.cookie.split('; ').filter(Boolean).map((x) => [x.split('=')[0], x])); j[kv.split('=')[0]] = kv; this.cookie = Object.values(j).join('; '); } }
  raw(method, p, { form, multipart, json, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const h = { Host: this.host, ...headers }; if (this.cookie) h.Cookie = this.cookie;
      let body = null;
      if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; body = Buffer.from(new URLSearchParams(form).toString()); }
      if (json !== undefined) { h['Content-Type'] = 'application/json'; body = Buffer.from(JSON.stringify(json)); }
      if (multipart) { h['Content-Type'] = multipart.type; body = multipart.buf; }
      if (body) h['Content-Length'] = body.length;
      const req = http.request({ host: '127.0.0.1', port: this.port, path: p, method, headers: h }, (res) => {
        const chunks = []; res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          this.jar(res.headers['set-cookie']);
          const buf = Buffer.concat(chunks); const text = buf.toString('utf8');
          const meta = text.match(/<meta name="csrf-token" content="([^"]+)"/); if (meta) this.csrf = meta[1];
          let data = null; try { data = JSON.parse(text); } catch { /* html */ }
          resolve({ status: res.statusCode, loc: res.headers.location || null, text, buf, data, headers: res.headers });
        });
      });
      req.on('error', reject); if (body) req.write(body); req.end();
    });
  }
  get(p, headers) { return this.raw('GET', p, { headers }); }
  async ensureToken() { if (!this.csrf) { await this.get('/login'); if (!this.csrf) await this.get('/profile'); } return this.csrf; }
  async post(p, form = {}) { await this.ensureToken(); const r = await this.raw('POST', p, { form: { _csrf: this.csrf, ...form } }); if (r.headers['set-cookie']) this.csrf = null; return r; }
  async upload(p, name, content) {
    await this.ensureToken();
    const fd = new FormData(); fd.append('_csrf', this.csrf); fd.append('file', new Blob([content], { type: 'text/plain' }), name);
    const resp = new Response(fd);
    return this.raw('POST', p, { multipart: { buf: Buffer.from(await resp.arrayBuffer()), type: resp.headers.get('content-type') } });
  }
  async login(u, pw) { const r = await this.post('/login', { username: u, password: pw }); this.csrf = null; return r; }
  async api(method, p, key, json) { return this.raw(method, `/api/v1${p}`, { json, headers: { Authorization: `Bearer ${key}` } }); }
  async scim(method, p, token, json) { return this.raw(method, `/scim/v2${p}`, { json, headers: { Authorization: `Bearer ${token}`, Accept: 'application/scim+json' } }); }
}

function start(env) {
  const log = [];
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SEED_DEMO: 'true', SLA_SWEEP_S: '3600', SESSION_SECRET: `cff-${tag}`, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => log.push(String(d))); child.stderr.on('data', (d) => log.push(String(d)));
  return { child, text: () => log.join(''), exited: new Promise((r) => child.on('exit', r)) };
}
async function healthy(srv) { for (let i = 0; i < 60; i++) { try { if ((await new Browser(PORT, 'x.test').get('/health')).status === 200) return true; } catch { /* wait */ } if (srv.child.exitCode !== null) return false; await sleep(500); } return false; }

async function main() {
  const knex = knexLib({ client: 'pg', connection: dbConfig(process.env), pool: { min: 0, max: 3, afterCreate: (c, done) => c.query("SELECT set_config('app.tenant_id', '1', false)", (e) => done(e, c)) } });
  const app = start({});
  try {
    if (!(await healthy(app))) throw new Error(`NovaDesk did not start: ${app.text().slice(-400)}`);
    await run(knex);
  } catch (e) { console.error(`server output (tail):\n${app.text().slice(-1500)}`); throw e;
  } finally { await knex.destroy(); app.child.kill(); await app.exited; }
}

async function run(knex) {
  const q = async (sql, params = []) => (await knex.raw(sql, params)).rows;
  const one = async (sql, params = []) => (await q(sql, params))[0];
  const T = (s) => `${s}${tag}`;           // keys and words made for this run only
  const admin = new Browser(PORT, 'help.test'); await admin.login('admin', 'admin123');
  const jane = new Browser(PORT, 'help.test'); await jane.login('jdoe', 'agent123');
  const maria = new Browser(PORT, 'help.test'); await maria.login('mchen', 'user123');
  const mariaId = (await one("SELECT id FROM users WHERE username = 'mchen'")).id;

  // ---- the fields. This script's own fields (marked in their help text) are removed before and after: a required one left behind would stop other scripts making items.
  const MARK = 'custom-find-check';
  const dropMine = () => q('DELETE FROM custom_fields WHERE help = ?', [MARK]);
  await dropMine();
  const define = (entity, key, label, type, extra = {}) => admin.post('/settings/fields', { entity_type: entity, key: T(key), label: `${label} ${tag}`, field_type: type, help: MARK, ...extra });
  const fid = async (entity, key) => (await one('SELECT id FROM custom_fields WHERE entity_type = ? AND key = ?', [entity, T(key)])).id;
  await define('incident', 'region', 'Region', 'select', { options: 'EMEA\nAPAC\nnorth-america|North America' });
  await define('incident', 'cost', 'Cost', 'number');
  await define('incident', 'ends', 'Contract end', 'date');
  await define('incident', 'vip', 'VIP', 'checkbox');
  await define('incident', 'note', 'Note', 'text');
  await define('incident', 'secret', 'Secret', 'text', { audience: 'staff' });
  await define('ci', 'rack', 'Rack', 'text');
  await define('ci', 'tier', 'Tier', 'select', { options: 'Gold\nSilver' });
  await define('ci', 'crit', 'Critical', 'checkbox');
  await define('ci', 'bought', 'Bought', 'date');
  await define('ci', 'budget', 'Budget', 'number');
  await define('ci', 'team', 'Team', 'text', { required: 'on' });
  for (const e of ['change', 'problem', 'request']) await define(e, 'tag', 'Tag', 'text');
  const k = (key) => `cf_${T(key)}`;

  section = 'making the data';
  const mkInc = (name, cf, who = admin) => who.post('/incidents', { short_description: `${name} ${tag}`, description: 'x', impact: '3', urgency: '3', ...cf });
  const made = {
    a: await mkInc('Alpha', { [k('region')]: 'emea', [k('cost')]: '120', [k('ends')]: '2026-03-15', [k('vip')]: 'on', [k('note')]: `printer jam ${tag}`, [k('secret')]: `ticket-${tag}-alpha` }),
    b: await mkInc('Bravo', { [k('region')]: 'apac', [k('cost')]: '80.5', [k('ends')]: '2026-09-30', [k('note')]: `100% done ${tag}`, [k('secret')]: `ticket-${tag}-bravo` }),
    c: await mkInc('Charlie', { [k('region')]: 'north-america', [k('cost')]: '2000', [k('ends')]: '2027-01-01', [k('vip')]: 'on', [k('note')]: `1000 done ${tag}` }),
    d: await mkInc('Delta', {}),
  };
  check('four incidents were made', Object.values(made).every((r) => r.status === 302), Object.values(made).map((r) => r.status).join());
  const numberOf = async (name) => (await one('SELECT number FROM incidents WHERE short_description = ?', [`${name} ${tag}`])).number;
  const N = { a: await numberOf('Alpha'), b: await numberOf('Bravo'), c: await numberOf('Charlie'), d: await numberOf('Delta') };
  // an incident of the end user's own, with a value in the staff-only field
  const mine = await mkInc('Mine', { [k('region')]: 'emea', [k('note')]: `printer jam ${tag}` }, maria);
  const N_mine = (await one('SELECT number FROM incidents WHERE short_description = ?', [`Mine ${tag}`])).number;
  await q('UPDATE incidents SET caller_id = ? WHERE number = ?', [mariaId, N_mine]);
  await q("INSERT INTO custom_field_values (entity_type, entity_id, field_id, value) SELECT 'incident', i.id, ?, ? FROM incidents i WHERE i.number = ?", [await fid('incident', 'secret'), `ticket-${tag}-mine`, N_mine]);

  // The incident numbers a list shows, for this run's incidents only.
  const listed = async (b, query, path = '/incidents') => {
    const r = await b.get(`${path}?${new URLSearchParams({ pageSize: '100', ...query }).toString()}`);
    return { r, nums: [...new Set((r.text.match(/INC\d+/g) || []))].filter((n) => Object.values(N).includes(n) || n === N_mine).sort() };
  };
  const same = (got, want) => JSON.stringify(got) === JSON.stringify([...want].sort());

  section = 'filters on incidents';
  check('a choice: only that choice', same((await listed(admin, { [k('region')]: 'emea' })).nums, [N.a, N_mine]));
  check('a text: contains, ignoring capitals', same((await listed(admin, { [k('note')]: 'PRINTER' })).nums, [N.a, N_mine]));
  check('a text with a % in it means a %, not "anything"', same((await listed(admin, { [k('note')]: '100%' })).nums, [N.b]));
  check('a number from', same((await listed(admin, { [`${k('cost')}_from`]: '100' })).nums, [N.a, N.c]));
  check('a number to', same((await listed(admin, { [`${k('cost')}_to`]: '100' })).nums, [N.b]));
  check('a number between, both ends included', same((await listed(admin, { [`${k('cost')}_from`]: '80.5', [`${k('cost')}_to`]: '120' })).nums, [N.a, N.b]));
  check('a date between', same((await listed(admin, { [`${k('ends')}_from`]: '2026-03-15', [`${k('ends')}_to`]: '2026-12-31' })).nums, [N.a, N.b]));
  check('yes: only those ticked', same((await listed(admin, { [k('vip')]: 'yes' })).nums, [N.a, N.c]));
  check('no: everything not ticked, records with no value too', same((await listed(admin, { [k('vip')]: 'no' })).nums, [N.b, N.d, N_mine]));
  const pr = (await one('SELECT priority FROM incidents WHERE number = ?', [N.a])).priority;
  const combo1 = (await listed(admin, { [k('region')]: 'emea', [k('vip')]: 'yes', q: 'Alpha' })).nums; const combo2 = (await listed(admin, { [k('vip')]: 'yes', priority: String(pr) })).nums;
  check('filters combine (and with the other filters and the search box)', same(combo1, [N.a]) && same(combo2, [N.a, N.c]), `${combo1} / ${combo2} (priority ${pr})`);
  const bad = await listed(admin, { [`${k('cost')}_from`]: 'lots', [k('region')]: 'mars', [k('vip')]: 'maybe', [`${k('ends')}_to`]: '31/12/2026' });
  check('a value that cannot be used is left out and said, not an error page', bad.r.status === 200 && same(bad.nums, [N.a, N.b, N.c, N.d, N_mine]) && /must be a number/.test(bad.r.text) && /not one of the choices/.test(bad.r.text) && /use yes or no/.test(bad.r.text) && /must be a date/.test(bad.r.text));
  const evil = await listed(admin, { [k('note')]: "'; DROP TABLE incidents; --", [k('region')]: "emea' OR '1'='1", [`${k('cost')}_from`]: '1 OR 1=1' });
  check('nothing typed can break the query', evil.r.status === 200 && Number((await one('SELECT count(*) AS c FROM incidents')).c) > 0);
  const arr = await admin.get(`/incidents?${k('region')}[]=emea&${k('region')}=emea&${k('region')}=apac`);
  check('a filter given twice or as a list is ignored, not an error', arr.status === 200);
  const form = (await admin.get('/incidents')).text;
  check('the list has the filter form, with each field in its own kind of input', /Custom fields/.test(form) && new RegExp(`name="${k('region')}"`).test(form) && new RegExp(`name="${k('cost')}_from"`).test(form) && new RegExp(`type="date"[^>]*name="${k('ends')}_from"`).test(form) && new RegExp(`name="${k('vip')}"`).test(form));
  const filtered = (await admin.get(`/incidents?${k('region')}=emea`)).text;
  check('the form keeps the values and says how many filters are in use', new RegExp(`<option value="emea" selected>`).test(filtered) && /1 in use/.test(filtered) && /Clear these filters/.test(filtered));
  const exp = await admin.get(`/incidents/export.csv?${k('region')}=emea`);
  const expRows = (exp.text.match(/INC\d+/g) || []).filter((n) => Object.values(N).includes(n) || n === N_mine);
  check('the CSV export follows the filter', exp.status === 200 && same([...new Set(expRows)].sort(), [N.a, N_mine]) && !expRows.includes(N.b), `${exp.status} ${[...new Set(expRows)]}`);
  section = 'who may filter on what';
  check('a staff-only field is offered to staff and not to an end user', new RegExp(`name="${k('secret')}"`).test(form) && !new RegExp(`name="${k('secret')}"`).test((await maria.get('/incidents')).text) && new RegExp(`name="${k('region')}"`).test((await maria.get('/incidents')).text));
  check('staff can filter on it', same((await listed(jane, { [k('secret')]: `ticket-${tag}-alpha` })).nums, [N.a]));
  const sneaky = await listed(maria, { [k('secret')]: `ticket-${tag}-mine` });
  check('an end user filtering on it gets their own list, unfiltered (it is ignored, not probed)', sneaky.r.status === 200 && same(sneaky.nums, [N_mine]));
  check('an end user filtering on a field they may see sees only their own incidents', same((await listed(maria, { [k('region')]: 'emea' })).nums, [N_mine]));

  section = 'the search box and the global search';
  check('the list search finds a word held in a custom field', same((await listed(admin, { q: `jam ${tag}` })).nums, [N.a, N_mine]));
  check('and a choice by its name', same((await listed(admin, { q: 'North America' })).nums, [N.c]));
  check('and a number', (await listed(admin, { q: '80.5' })).nums.includes(N.b));
  check('the search still finds by number and description', same((await listed(admin, { q: N.d })).nums, [N.d]) && same((await listed(admin, { q: `Charlie ${tag}` })).nums, [N.c]));
  check('a % typed in the search is just a character', same((await listed(admin, { q: `100% done ${tag}` })).nums, [N.b]));
  const global = async (b, term) => { const r = await b.get(`/search?q=${encodeURIComponent(term)}`); return [...new Set(r.text.match(/INC\d+/g) || [])].filter((n) => Object.values(N).includes(n) || n === N_mine).sort(); };
  check('the global search finds it too', same(await global(admin, `jam ${tag}`), [N.a, N_mine]) && same(await global(admin, 'North America'), [N.c]));
  check('a staff-only value is found by staff and never by an end user', same(await global(jane, `ticket-${tag}-alpha`), [N.a]) && (await global(maria, `ticket-${tag}-alpha`)).length === 0 && (await global(maria, `ticket-${tag}-mine`)).length === 0 && same(await global(jane, `ticket-${tag}-mine`), [N_mine]));
  check('an end user finds only their own records by a value they may see', same(await global(maria, `jam ${tag}`), [N_mine]));
  const regionId = await fid('incident', 'region');
  await admin.post(`/settings/fields/${regionId}`, { label: `Region ${tag}`, options: 'EMEA\nAPAC\nnorth-america|North America' });       // switched off: no "active"
  const offList = (await listed(admin, { [k('region')]: 'emea' })).nums; const offFound = await global(admin, 'North America');
  check('a field switched off cannot be filtered on or searched', same(offList, [N.a, N.b, N.c, N.d, N_mine]) && offFound.length === 0, `${offList} | ${offFound}`);
  await admin.post(`/settings/fields/${regionId}`, { active: 'on', label: `Region ${tag}`, options: 'EMEA\nAPAC\nnorth-america|North America' });
  check('and again when it is switched on', same((await listed(admin, { [k('region')]: 'emea' })).nums, [N.a, N_mine]));

  section = 'the other lists';
  // One change, one problem and one request, each with a word in its custom field "Tag"; each list finds it by that field and by the search box.
  const adminId = (await one("SELECT id FROM users WHERE username = 'admin'")).id;
  const item = (await one('SELECT id FROM catalog_items ORDER BY id LIMIT 1')).id;
  const seed = {
    change: { path: '/changes', table: 'changes', insert: ["INSERT INTO changes (number, short_description, requested_by) VALUES (?, ?, ?) RETURNING id", [`CHG-${tag}`, `Smoke change ${tag}`, adminId]], shows: `CHG-${tag}` },
    problem: { path: '/problems', table: 'problems', insert: ["INSERT INTO problems (number, short_description) VALUES (?, ?) RETURNING id", [`PRB-${tag}`, `Smoke problem ${tag}`]], shows: `PRB-${tag}` },
    request: { path: '/requests', table: 'service_requests', insert: ["INSERT INTO service_requests (number, catalog_item_id, requested_by) VALUES (?, ?, ?) RETURNING id", [`REQ-${tag}`, item, adminId]], shows: `REQ-${tag}` },
  };
  for (const [entity, sp] of Object.entries(seed)) {
    const rec = await one(...sp.insert);
    await q("INSERT INTO custom_field_values (entity_type, entity_id, field_id, value) VALUES (?, ?, ?, ?)", [entity, rec.id, await fid(entity, 'tag'), `needle-${tag}-${entity}`]);
    const byField = await admin.get(`${sp.path}?${k('tag')}=needle-${tag}-${entity}`);
    const byOther = await admin.get(`${sp.path}?${k('tag')}=nothing-${tag}`);
    const bySearch = await admin.get(`${sp.path}?q=needle-${tag}-${entity}`);
    const exp = await admin.get(`${sp.path}/export.csv?${k('tag')}=needle-${tag}-${entity}`);
    const expNone = await admin.get(`${sp.path}/export.csv?${k('tag')}=nothing-${tag}`);
    check(`${entity}s: filtered by the field, found by the search box, the export follows, and a filter that matches nothing shows nothing`,
      byField.status === 200 && byField.text.includes(sp.shows) && new RegExp(`name="${k('tag')}"`).test(byField.text) && !byOther.text.includes(sp.shows) && bySearch.text.includes(sp.shows) && exp.text.includes(sp.shows) && !expNone.text.includes(sp.shows),
      `${byField.status} ${byField.text.includes(sp.shows)} ${byOther.text.includes(sp.shows)} ${bySearch.text.includes(sp.shows)} ${exp.text.includes(sp.shows)} ${expNone.text.includes(sp.shows)}`);
    const g = await admin.get(`/search?q=needle-${tag}-${entity}`);
    check(`${entity}s: the global search finds it too`, g.text.includes(sp.shows), g.status);
  }

  // ---- configuration items
  section = 'filters on configuration items';
  const mkCi = (name, cf) => admin.post('/cmdb', { name: `${name} ${tag}`, ci_type: 'server', [k('team')]: 'ops', ...cf });
  const cis = [
    await mkCi('Host1', { [k('rack')]: `R${tag}-A1`, [k('tier')]: 'Gold', [k('crit')]: 'on', [k('bought')]: '2024-01-10', [k('budget')]: '500' }),
    await mkCi('Host2', { [k('rack')]: `R${tag}-B2`, [k('tier')]: 'Silver', [k('bought')]: '2025-06-01', [k('budget')]: '90' }),
    await mkCi('Host3', { [k('rack')]: `R${tag}-B3`, [k('tier')]: 'Gold', [k('budget')]: '1500' }),
  ];
  check('three items were made', cis.every((r) => r.status === 302), cis.map((r) => r.status).join());
  const ciNums = async (query) => { const r = await admin.get(`/cmdb?${new URLSearchParams(query).toString()}`); return { r, names: [...new Set(r.text.match(/Host\d [a-z0-9]+/g) || [])].filter((n) => n.endsWith(` ${tag}`)).map((n) => n.split(' ')[0]).sort() }; };
  check('text, choice, yes/no, date and number filters on items', same((await ciNums({ [k('rack')]: '-B' })).names, ['Host2', 'Host3']) && same((await ciNums({ [k('tier')]: 'gold' })).names, ['Host1', 'Host3']) && same((await ciNums({ [k('crit')]: 'yes' })).names, ['Host1']) && same((await ciNums({ [`${k('bought')}_from`]: '2025-01-01' })).names, ['Host2']) && same((await ciNums({ [`${k('budget')}_from`]: '100', [`${k('budget')}_to`]: '1000' })).names, ['Host1']));
  check('the search finds an item by its rack or tier', same((await ciNums({ q: `R${tag}-A1` })).names, ['Host1']) && same((await ciNums({ q: 'silver' })).names, ['Host2']));
  const gl = await admin.get(`/search?q=${encodeURIComponent(`R${tag}-B`)}`);
  check('the global search finds items by a custom field', /Host2/.test(gl.text) && /Host3/.test(gl.text) && !/Host1/.test(gl.text));

  // ---- CSV import of items with custom fields
  section = 'importing items with custom fields';
  const upload = async (b, kind, csv, mode = 'add') => {
    await b.ensureToken();
    const fd = new FormData(); fd.append('_csrf', b.csrf); fd.append('mode', mode); fd.append('file', new Blob([csv], { type: 'text/csv' }), 'cis.csv');
    const resp = new Response(fd);
    return b.raw('POST', `/import/${kind}`, { multipart: { buf: Buffer.from(await resp.arrayBuffer()), type: resp.headers.get('content-type') } });
  };
  const jobOf = (r) => (r.loc || '').match(/job\/(\d+)/);
  const preview = async (job) => JSON.parse((await one('SELECT preview FROM imports WHERE id = ?', [job])).preview);
  const kindPage = (await admin.get('/import/cmdb')).text;
  check('the import page lists the custom fields as columns', kindPage.includes(`Rack ${tag}`) && kindPage.includes(`Budget ${tag}`) && /Custom field/.test(kindPage));
  const tpl = await admin.get('/import/cmdb/template.csv');
  check('the example file has the custom field columns', tpl.status === 200 && tpl.text.split('\n')[0].includes(`Rack ${tag}`) && tpl.text.split('\n')[0].includes(`Team ${tag}`));
  const H = `Name,Type,Rack ${tag},${T('tier')},cf_${T('crit')},Bought ${tag},Budget ${tag},Team ${tag}`;
  const good = [H, `Imp1 ${tag},Server,R${tag}-I1,Gold,yes,2026-02-03,250.5,ops`, `Imp2 ${tag},Server,R${tag}-I2,silver,no,2026/03/04,10,ops`].join('\n');
  const up = await upload(admin, 'cmdb', good);
  const job = jobOf(up);
  check('the file is read, with the custom columns recognised by name, by key, and by cf_key', up.status === 302 && job, up.status);
  const pv = await preview(job[1]);
  check('the preview adds both and lists the custom columns as used', pv.add === 2 && pv.error === 0 && [`Rack ${tag}`, `Tier ${tag}`, `Critical ${tag}`, `Bought ${tag}`, `Budget ${tag}`, `Team ${tag}`].every((c) => pv.columns.used.includes(c)) && pv.columns.unknown.length === 0, JSON.stringify(pv).slice(0, 400));
  check('and saves nothing yet', Number((await one("SELECT count(*) AS c FROM cmdb_ci WHERE name LIKE ?", [`Imp_ ${tag}`])).c) === 0);
  const run1 = await admin.post(`/import/job/${job[1]}/run`);
  check('confirming makes them', run1.status === 302 && Number((await one("SELECT count(*) AS c FROM cmdb_ci WHERE name LIKE ?", [`Imp_ ${tag}`])).c) === 2);
  const val = async (name, key) => (await one("SELECT v.value FROM custom_field_values v JOIN cmdb_ci c ON c.id = v.entity_id AND v.entity_type = 'ci' JOIN custom_fields f ON f.id = v.field_id WHERE c.name = ? AND f.key = ?", [`${name} ${tag}`, T(key)])) || {};
  check('every value is stored in its own form', (await val('Imp1', 'rack')).value === `R${tag}-I1` && (await val('Imp1', 'tier')).value === 'gold' && (await val('Imp1', 'crit')).value === 'true' && (await val('Imp1', 'bought')).value === '2026-02-03' && (await val('Imp1', 'budget')).value === '250.5'
    && (await val('Imp2', 'tier')).value === 'silver' && (await val('Imp2', 'crit')).value === undefined && (await val('Imp2', 'bought')).value === '2026-03-04');
  const imported = async (query) => { const r = await admin.get(`/cmdb?${new URLSearchParams(query).toString()}`); return [...new Set(r.text.match(/Imp\d [a-z0-9]+/g) || [])].filter((n) => n.endsWith(` ${tag}`)).map((n) => n.split(' ')[0]).sort(); };
  check('the items can now be filtered on what was imported', same(await imported({ [k('crit')]: 'yes' }), ['Imp1']) && same(await imported({ [k('tier')]: 'silver' }), ['Imp2']) && same(await imported({ q: `R${tag}-I1` }), ['Imp1']) && same(await imported({ [`${k('budget')}_from`]: '200' }), ['Imp1']));

  const badFile = [H, `Bad1 ${tag},Server,r,Platinum,yes,2026-01-01,5,ops`, `Bad2 ${tag},Server,r,Gold,maybe,2026-01-01,5,ops`, `Bad3 ${tag},Server,r,Gold,yes,31/12/2026,5,ops`, `Bad4 ${tag},Server,r,Gold,yes,2026-01-01,lots,ops`, `Bad5 ${tag},Server,r,Gold,yes,2026-01-01,5,`].join('\n');
  const ub = await upload(admin, 'cmdb', badFile);
  const pb = await preview(jobOf(ub)[1]);
  const msgs = pb.problems.map((p) => p.message).join(' | ');
  check('every bad value is refused with the field and the value, and nothing would be added', pb.error === 5 && pb.add === 0 && /Tier[^|]*must be one of/.test(msgs) && /Critical[^|]*"maybe" is not yes or no/.test(msgs) && /Bought[^|]*"31\/12\/2026" is not a date/.test(msgs) && /Budget[^|]*must be a number/.test(msgs) && /Team[^|]* is required/.test(msgs), msgs.slice(0, 500));

  const upd = [H, `Imp1 ${tag},Server,R${tag}-I1,Silver,,,300,`, `Imp2 ${tag},Server,,,,,,`].join('\n');
  const uu = await upload(admin, 'cmdb', upd, 'update'); const ju = jobOf(uu)[1]; const pu = await preview(ju);
  check('an update changes only what the file gives: the first row changes tier and budget, the second has nothing to change', pu.update === 1 && pu.unchanged === 1 && pu.error === 0, JSON.stringify(pu).slice(0, 300));
  await admin.post(`/import/job/${ju}/run`);
  check('the changed values are stored and the rest left alone', (await val('Imp1', 'tier')).value === 'silver' && (await val('Imp1', 'budget')).value === '300' && (await val('Imp1', 'rack')).value === `R${tag}-I1` && (await val('Imp1', 'bought')).value === '2026-02-03' && (await val('Imp1', 'crit')).value === 'true' && (await val('Imp2', 'crit')).value === undefined);
  const hist = await one("SELECT count(*) AS c FROM activity_log a JOIN cmdb_ci c ON c.id = a.entity_id AND a.entity_type = 'ci' WHERE c.name = ? AND a.message LIKE ?", [`Imp1 ${tag}`, '%Tier%changed%']);
  check('the change is in the item\'s history, like any other edit', Number(hist.c) === 1);

  const ex = await admin.get(`/cmdb/export.csv?q=${tag}`);
  const again = await upload(admin, 'cmdb', ex.text, 'update'); const pa = await preview(jobOf(again)[1]);
  check('a file exported from the CMDB page imports again with nothing to change', ex.status === 200 && pa.error === 0 && pa.update === 0 && pa.unchanged >= 5, JSON.stringify(pa).slice(0, 300));
  const asJane = await upload(jane, 'cmdb', good.replace(/Imp(\d)/g, 'Jan$1'));
  check('an agent can import them too', asJane.status === 302 && jobOf(asJane));

  section = 'paging';
  // Paging: more matches than one page holds; the links to the other pages keep the filter, and page 2 is the rest of the matches.
  for (let i = 0; i < 22; i++) await mkInc(`Bulk${i}`, { [k('note')]: `bulk-${tag}` });
  const p1 = await admin.get(`/incidents?${k('note')}=bulk-${tag}`);
  const nextHref = ((p1.text.match(/href="([^"]*page=2[^"]*)"/) || [])[1] || '').replace(/&amp;/g, '&');
  const p2 = nextHref ? await admin.get(`/incidents${nextHref.startsWith('?') ? nextHref : ''}`) : null;
  const countBulk = (r) => (r.text.match(new RegExp(`Bulk\\d+ ${tag}`, 'g')) || []).length;
  check('a long result is paged, the page links keep the filter, and the second page has the rest', Boolean(nextHref) && nextHref.includes(`${k('note')}=bulk-${tag}`) && countBulk(p1) === 20 && p2 && countBulk(p2) === 2, `${nextHref} ${countBulk(p1)} ${p2 && countBulk(p2)}`);

  await dropMine();
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASS');
  process.exitCode = failed ? 1 : 0;
}

main().then(() => process.exit(process.exitCode || 0), (e) => { console.error(e); process.exit(1); });
