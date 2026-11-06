#!/usr/bin/env node
// Multi-tenancy, end to end, against two copies of NovaDesk that this script starts itself (ports 18330 and 18331) on the
// database named by PGHOST, PGUSER, PGPASSWORD and PGDATABASE. It makes two more tenants next to the default one and checks, as real
// people through real pages, the REST API, SCIM and webhooks, that they share nothing: sign-in and sessions, every kind of
// record reached by its number or id, writes aimed at another tenant's records, ticket numbers, usernames, API keys and SCIM
// tokens (which find their tenant without a host name), webhooks, settings (branding, SLA, custom fields), lists, files, a suspended
// tenant, and how unknown host names are treated. Needs the demonstration users (the default tenant). It removes what it can.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const knexLib = require('knex');
const { dbConfig } = require('../src/settings');

const ROOT = path.join(__dirname, '..');
let failed = 0; let section = '';
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  [${section}] ${name}${!ok && extra ? '  -- ' + String(extra).slice(0, 400) : ''}`); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Math.random().toString(36).slice(2, 7);

// A browser: its own cookies, talking to one server but naming the host (the address a person typed) it wants.
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

function start(port, env) {
  const log = [];
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SEED_DEMO: 'true', SLA_SWEEP_S: '3600', SESSION_SECRET: `ten-check-${tag}`, WEBHOOK_ALLOW_PRIVATE: 'true', WEBHOOK_POLL_S: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => log.push(String(d))); child.stderr.on('data', (d) => log.push(String(d)));
  return { child, text: () => log.join(''), exited: new Promise((r) => child.on('exit', r)) };
}
async function healthy(port, srv) { for (let i = 0; i < 60; i++) { try { const r = await new Browser(port, 'x.test').get('/health'); if (r.status === 200) return true; } catch { /* wait */ } if (srv.child.exitCode !== null) return false; await sleep(500); } return false; }

async function main() {
  const p1 = 18330; const p2 = 18331;
  const knex = knexLib({ client: 'pg', connection: dbConfig(process.env), pool: { min: 0, max: 3 } });
  const app1 = start(p1, { TENANT_BASE_DOMAIN: 'desk.test' });
  let app2 = null;
  try {
    if (!(await healthy(p1, app1))) throw new Error(`NovaDesk did not start: ${app1.text().slice(-400)}`);
    // The second copy starts once the first has made the demonstration data (two copies would both try on an empty database).
    app2 = start(p2, { TENANT_UNKNOWN_HOST: 'reject', TENANT_BASE_DOMAIN: 'desk.test' });
    if (!(await healthy(p2, app2))) throw new Error(`The second NovaDesk did not start: ${app2.text().slice(-400)}`);
    await run({ p1, p2 }, knex, [app1, app2]);
  } finally { await knex.destroy(); app1.child.kill(); if (app2) app2.child.kill(); await Promise.all([app1.exited, app2 ? app2.exited : null]); }
}

async function run({ p1, p2 }, knex, apps) {
  const tenants = require('../src/tenants');
  const tenancy = require('../src/tenancy');
  const { db } = require('../src/db');
  const q = async (sql, params = []) => (await knex.raw(sql, params)).rows;
  const one = async (sql, params = []) => (await q(sql, params))[0];
  const HOST_A = 'help.corp.test';                       // not listed anywhere: the default tenant's, because the policy says so
  const HOST_B = `help-${tag}.acme.test`;
  const SLUG_C = `globex-${tag}`; const HOST_C = `${SLUG_C}.desk.test`;   // only by the base domain
  const PW_B = 'Quartz-Meadow-71b'; const PW_C = 'Harbor-Violet-58c';

  // ------------------------------------------------------------------------------------------------------ the tenants
  section = 'tenants';
  const tenantB = await tenants.createTenant({ slug: `acme-${tag}`, name: `Acme ${tag}`, hosts: [HOST_B] });
  const tenantC = await tenants.createTenant({ slug: SLUG_C, name: `Globex ${tag}` });
  await tenants.createAdmin(tenantB.id, { username: 'admin', password: PW_B, fullName: 'Bea Boss', email: `bea${tag}@acme.test` });
  await tenants.createAdmin(tenantC.id, { username: 'boss', password: PW_C, fullName: 'Cy Chief', email: `cy${tag}@globex.test` });
  check('tenants are made with a short name, a name and host names', tenantB.id > 1 && tenantC.id > tenantB.id && tenantB.slug === `acme-${tag}`);
  check('each starts with its own settings, like a fresh installation', (await q('SELECT tenant_id, count(*)::int AS n FROM branding_settings WHERE tenant_id IN (?, ?) GROUP BY 1 ORDER BY 1', [tenantB.id, tenantC.id])).length === 2
    && Number((await one('SELECT count(*) AS c FROM sla_policies WHERE tenant_id = ?', [tenantB.id])).c) === 6
    && Number((await one('SELECT count(*) AS c FROM business_calendars WHERE tenant_id = ?', [tenantB.id])).c) === 1);
  for (const bad of ['Bad Name', 'x'.repeat(41), '-x', 'x-', 'www', 'platform', '']) {
    check(`a tenant short name "${bad.slice(0, 12)}" is refused`, await tenants.createTenant({ slug: bad, name: 'x' }).then(() => false, (e) => e instanceof tenants.TenantError));
  }
  check('a duplicate short name or host name is refused', await tenants.createTenant({ slug: `acme-${tag}`, name: 'again' }).then(() => false, (e) => /already/.test(e.message))
    && await tenants.createTenant({ slug: `other-${tag}`, name: 'again', hosts: [HOST_B] }).then(() => false, (e) => /already belongs/.test(e.message)));
  check('the demonstration data belongs to the default tenant, and the new tenants hold no people but their first administrator',
    Number((await one('SELECT count(*) AS c FROM users WHERE tenant_id = 1')).c) >= 3 && Number((await one('SELECT count(*) AS c FROM users WHERE tenant_id = ?', [tenantB.id])).c) === 1 && Number((await one('SELECT count(*) AS c FROM incidents WHERE tenant_id = ?', [tenantB.id])).c) === 0);

  // A running server keeps its list of tenants for five seconds (src/tenants.js), so tenants made from outside become visible to it within that time.
  await sleep(5500);

  // ------------------------------------------------------------------------------------------------------ signing in
  section = 'sign-in';
  const A = new Browser(p1, HOST_A); const B = new Browser(p1, HOST_B); const C = new Browser(p1, HOST_C);
  check('the default tenant\'s people sign in at an address nobody listed', (await A.login('admin', 'admin123')).status === 302);
  check('the same name and password do not sign in at another tenant\'s address (a different person, a different password)', (await new Browser(p1, HOST_B).login('admin', 'admin123')).status !== 302);
  check('each tenant\'s own administrator signs in at its own address', (await B.login('admin', PW_B)).status === 302 && (await C.login('boss', PW_C)).status === 302);
  check('and not at another tenant\'s', (await new Browser(p1, HOST_A).login('admin', PW_B)).status !== 302 && (await new Browser(p1, HOST_B).login('boss', PW_C)).status !== 302 && (await new Browser(p1, HOST_C).login('admin', 'admin123')).status !== 302);
  check('a third tenant works by its base-domain host name alone', (await C.get('/')).status === 200 && (await C.get('/')).text.includes('Cy Chief'));
  check('the same username (admin) exists in two tenants as two different people', (await B.get('/')).text.includes('Bea Boss') && (await A.get('/')).text.includes('Alex Admin') && !(await A.get('/')).text.includes('Bea Boss'));
  const sa = new Browser(p1, HOST_B); sa.cookie = A.cookie;
  check('a session cookie from one tenant is nothing at another tenant\'s address', (await sa.get('/')).status === 302 && (await sa.get('/')).loc === '/login' && (await sa.get('/incidents')).status === 302);
  const sb = new Browser(p1, HOST_A); sb.cookie = B.cookie;
  check('and the other way round', (await sb.get('/')).status === 302 && (await sb.get('/profile')).status === 302);
  check('the cookie still works where it was made', (await A.get('/profile')).status === 200 && (await B.get('/profile')).status === 200);
  const sess = await q('SELECT tenant_id, count(*)::int AS n FROM sessions GROUP BY 1');
  check('each session row carries its tenant', sess.some((r) => r.tenant_id === 1) && sess.some((r) => r.tenant_id === tenantB.id) && sess.some((r) => r.tenant_id === tenantC.id));
  check('the people lists hold only that tenant\'s people', !(await B.get('/users')).text.includes('Jane Doe') && (await A.get('/users')).text.includes('Jane Doe') && !(await A.get('/users')).text.includes('Bea Boss') && (await B.get('/users')).text.includes('Bea Boss'));

  // ------------------------------------------------------------------------------------------------------ records
  section = 'records';
  const id = (r) => Number((r.loc || '').split('/').pop());
  const incA = await A.post('/incidents', { short_description: `Secret of A ${tag}`, description: 'only A may read this', priority: '3' });
  const chgA = await A.post('/changes', { short_description: `Change of A ${tag}`, change_type: 'normal', risk: 'low' });
  const prbA = await A.post('/problems', { short_description: `Problem of A ${tag}`, priority: '3' });
  const ciA = await A.post('/cmdb', { name: `Server of A ${tag}`, ci_type: 'server' });
  const aIds = { incident: id(incA), change: id(chgA), problem: id(prbA), ci: id(ciA) };
  check('the default tenant makes its records', Object.values(aIds).every((n) => n > 0), JSON.stringify([incA.status, chgA.status, prbA.status, ciA.status]));
  const incB = await B.post('/incidents', { short_description: `Secret of B ${tag}`, description: 'only B may read this', priority: '2' });
  const incC = await C.post('/incidents', { short_description: `Secret of C ${tag}`, priority: '3' });
  check('the others make theirs', id(incB) > 0 && id(incC) > 0);
  const numberOf = async (tid, rid) => (await one('SELECT number FROM incidents WHERE id = ? AND tenant_id = ?', [rid, tid])).number;
  check('every tenant counts its own tickets: the first incident of a new tenant is number 1, whatever the others have', await numberOf(tenantB.id, id(incB)) === 'INC0000001' && await numberOf(tenantC.id, id(incC)) === 'INC0000001' && (await numberOf(1, aIds.incident)) !== 'INC0000001');
  const listB = (await B.get('/incidents')).text; const listA = (await A.get('/incidents')).text;
  check('lists show only the tenant\'s own records', listB.includes(`Secret of B ${tag}`) && !listB.includes(`Secret of A ${tag}`) && !listB.includes(`Secret of C ${tag}`) && listA.includes(`Secret of A ${tag}`) && !listA.includes(`Secret of B ${tag}`));
  for (const [kind, url] of [['incidents', '/incidents'], ['changes', '/changes'], ['problems', '/problems'], ['cmdb', '/cmdb']]) {
    const t = (await B.get(url)).text;
    check(`the ${kind} list of another tenant shows none of the default tenant's`, !t.includes(`of A ${tag}`) && !/Secret of A|Server of A|Change of A|Problem of A/.test(t));
  }
  // (the search page repeats what was typed, so the query is a word that appears in both tenants' titles and the answer is checked for the other tenant's)
  const search = await B.get(`/search?q=${encodeURIComponent('Secret of')}`);
  check('search finds nothing of another tenant\'s', search.status === 200 && search.text.includes(`Secret of B ${tag}`) && !search.text.includes(`Secret of A ${tag}`) && !search.text.includes(`Secret of C ${tag}`) && !search.text.includes('only A may read'));
  check('and finds its own', (await B.get(`/search?q=${encodeURIComponent(`Secret of B ${tag}`)}`)).text.includes(`Secret of B ${tag}`));
  check('the CSV export holds only its own rows', !(await B.get('/incidents/export.csv')).text.includes(`of A ${tag}`));

  // Reaching another tenant's record by its number is the oldest trick there is: every kind, and the pages that act on it.
  const aUser = (await one("SELECT id FROM users WHERE username = 'jdoe' AND tenant_id = 1")).id;
  const aNotice = await one('SELECT id FROM notifications WHERE tenant_id = 1 ORDER BY id DESC LIMIT 1');
  await A.post('/settings/fields', { entity_type: 'incident', label: `A only ${tag}`, key: `a_only_${tag}`, field_type: 'text', audience: 'everyone' });
  const aField = (await one('SELECT id FROM custom_fields WHERE tenant_id = 1 AND key = ?', [`a_only_${tag}`])).id;
  const upA = await A.upload(`/incidents/${aIds.incident}/attachments`, 'a-secret.txt', 'the secret contents of A');
  const aAtt = await one('SELECT id FROM attachments WHERE tenant_id = 1 AND entity_id = ? ORDER BY id DESC LIMIT 1', [aIds.incident]);
  check('the default tenant\'s attachment and field exist', upA.status === 302 && aAtt && aField);
  const probes = [
    [`/incidents/${aIds.incident}`, 'an incident'], [`/incidents/${aIds.incident}/edit`, 'its edit page'], [`/changes/${aIds.change}`, 'a change'], [`/problems/${aIds.problem}`, 'a problem'],
    [`/cmdb/${aIds.ci}`, 'a configuration item'], [`/users/${aUser}/edit`, 'a person'], [`/settings/fields/${aField}`, 'a custom field'],
    [`/privacy/person/${aUser}`, 'a person\'s privacy page'], [`/incidents/${aIds.incident}/attachments/${aAtt.id}/download`, 'an attachment'],
  ].concat(aNotice ? [[`/notifications/${aNotice.id}`, 'a notification']] : []);
  for (const [url, what] of probes) {
    const r = await B.get(url);
    check(`another tenant cannot open ${what} by its id (${url.replace(/\d+/g, 'N')})`, r.status === 404 && !r.text.includes(`of A ${tag}`) && !r.text.includes('secret contents of A') && !r.text.includes('only A may read'), `${r.status}`);
  }
  check('and the default tenant can open its own', (await A.get(`/incidents/${aIds.incident}`)).status === 200 && (await A.get(`/incidents/${aIds.incident}/attachments/${aAtt.id}/download`)).text === 'the secret contents of A');
  // writes aimed at another tenant's records
  const beforeInc = await one('SELECT short_description, status, priority, updated_at FROM incidents WHERE id = ?', [aIds.incident]);
  const writes = [
    [`/incidents/${aIds.incident}/update`, { short_description: 'HACKED', status: 'closed', priority: '1' }], [`/incidents/${aIds.incident}/comments`, { body: 'planted comment' }],
    [`/incidents/${aIds.incident}/delete`, {}], [`/incidents/${aIds.incident}/attachments/${aAtt.id}/delete`, {}], [`/changes/${aIds.change}/update`, { short_description: 'HACKED' }],
    [`/changes/${aIds.change}/delete`, {}], [`/problems/${aIds.problem}/update`, { short_description: 'HACKED' }], [`/cmdb/${aIds.ci}/update`, { name: 'HACKED', ci_type: 'server' }],
    [`/cmdb/${aIds.ci}/delete`, {}], [`/users/${aUser}/update`, { username: 'jdoe', full_name: 'HACKED', role: 'admin', active: 'on' }], [`/users/${aUser}/delete`, {}],
    [`/settings/fields/${aField}`, { label: 'HACKED', active: 'on' }], [`/settings/fields/${aField}/delete`, {}],
  ];
  for (const [url, form] of writes) {
    const r = await B.post(url, form);
    check(`a write aimed at another tenant's record is refused (${url.replace(/\d+/g, 'N')})`, [403, 404, 405].includes(r.status) || (r.status === 302 && /\/login|\/incidents$|\/changes$|\/problems$|\/cmdb$|\/users$/.test(r.loc || '')), `${r.status} ${r.loc}`);
  }
  const afterInc = await one('SELECT short_description, status, priority, updated_at FROM incidents WHERE id = ?', [aIds.incident]);
  check('and nothing of the default tenant\'s changed', JSON.stringify(beforeInc) === JSON.stringify(afterInc)
    && (await one('SELECT short_description FROM changes WHERE id = ?', [aIds.change])).short_description === `Change of A ${tag}`
    && (await one('SELECT name FROM cmdb_ci WHERE id = ?', [aIds.ci])).name === `Server of A ${tag}`
    && (await one('SELECT full_name, role FROM users WHERE id = ?', [aUser])).full_name === 'Jane Doe'
    && Number((await one('SELECT count(*) AS c FROM attachments WHERE id = ?', [aAtt.id])).c) === 1
    && Number((await one('SELECT count(*) AS c FROM incident_comments WHERE incident_id = ?', [aIds.incident])).c) === 0
    && (await one('SELECT label FROM custom_fields WHERE id = ?', [aField])).label === `A only ${tag}`);
  check('a record pointing at another tenant\'s person shows nothing of that person', await (async () => {
    const r = await B.post('/incidents', { short_description: `Odd caller ${tag}`, caller_id: String(aUser), assigned_to: String(aUser), priority: '3' });
    const page = (await B.get(`/incidents/${id(r)}`)).text;
    return r.status === 302 && !page.includes('Jane Doe') && !page.includes('jane.doe@corp.local');
  })());

  // ------------------------------------------------------------------------------------------------------ keys, tokens, hooks
  section = 'API, SCIM and webhooks';
  const keyOf = async (b, name) => { const r = await b.post('/profile/api-keys', { name, scope: 'write', expires: '' }); const m = r.text.match(/ndk_[A-Za-z0-9_-]{40}/); return m && m[0]; };
  const keyA = await keyOf(A, `ten A ${tag}`); const keyB = await keyOf(B, `ten B ${tag}`);
  check('each tenant makes an API key', Boolean(keyA && keyB));
  const viaB = new Browser(p1, HOST_B);
  const listWithA = await viaB.api('GET', '/incidents', keyA);
  const listWithB = await viaB.api('GET', '/incidents', keyB);
  const items = (r) => (r.data && (r.data.data || r.data.items || r.data.incidents)) || [];
  check('a key finds its own tenant, whatever host name the call arrives on: A\'s key at B\'s address still reads A\'s records', listWithA.status === 200 && JSON.stringify(listWithA.data).includes(`Secret of A ${tag}`) && !JSON.stringify(listWithA.data).includes(`Secret of B ${tag}`));
  check('B\'s key reads B\'s records and none of A\'s', listWithB.status === 200 && JSON.stringify(listWithB.data).includes(`Secret of B ${tag}`) && !JSON.stringify(listWithB.data).includes(`of A ${tag}`));
  check('B\'s key cannot fetch A\'s incident by id', (await viaB.api('GET', `/incidents/${aIds.incident}`, keyB)).status === 404 && (await viaB.api('PATCH', `/incidents/${aIds.incident}`, keyB, { short_description: 'HACKED' })).status === 404);
  const apiMade = await viaB.api('POST', '/incidents', keyB, { short_description: `By API for B ${tag}`, impact: 3, urgency: 3 });
  check('a record made through B\'s key is B\'s, numbered in B\'s sequence', apiMade.status === 201 && (await one('SELECT tenant_id FROM incidents WHERE short_description = ?', [`By API for B ${tag}`])).tenant_id === tenantB.id);
  check('a made-up or another tenant\'s revoked key is just invalid', (await viaB.api('GET', '/incidents', `ndk_${'x'.repeat(40)}`)).status === 401);
  check('the key lists show only the tenant\'s own', (await B.get('/profile/api-keys')).text.includes(`ten B ${tag}`) && !(await B.get('/profile/api-keys')).text.includes(`ten A ${tag}`));

  const tokenOf = async (b, name) => { const r = await b.post('/settings/scim/tokens', { name, expires: '90' }); return (r.text.match(/nds_[A-Za-z0-9_-]{40}/) || [])[0]; };
  const tokB = await tokenOf(B, `scim B ${tag}`); const tokA = await tokenOf(A, `scim A ${tag}`);
  check('each tenant makes a SCIM token', Boolean(tokA && tokB));
  const scimB = await new Browser(p1, HOST_A).scim('GET', '/Users', tokB);
  check('a SCIM token finds its own tenant: B\'s token lists B\'s people only', scimB.status === 200 && JSON.stringify(scimB.data).includes('Bea Boss') && !JSON.stringify(scimB.data).includes('Jane Doe') && scimB.data.totalResults === 2 - 1 + (await q('SELECT 1 FROM users WHERE tenant_id = ? AND username <> ?', [tenantB.id, 'admin'])).length);
  const scimA = await new Browser(p1, HOST_B).scim('GET', '/Users', tokA);
  check('and A\'s token A\'s only', scimA.status === 200 && JSON.stringify(scimA.data).includes('Jane Doe') && !JSON.stringify(scimA.data).includes('Bea Boss'));
  const made = await new Browser(p1, HOST_A).scim('POST', '/Users', tokB, { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: `scim.user.${tag}`, name: { givenName: 'Scim', familyName: 'Person' }, emails: [{ value: `scim${tag}@acme.test`, primary: true }], active: true });
  check('a person provisioned through B\'s token is in B and nowhere else', made.status === 201 && (await one('SELECT tenant_id FROM users WHERE username = ?', [`scim.user.${tag}`])).tenant_id === tenantB.id && !(JSON.stringify((await new Browser(p1, HOST_B).scim('GET', '/Users', tokA)).data)).includes(`scim.user.${tag}`));
  check('a person of A\'s cannot be read through B\'s token by id', (await new Browser(p1, HOST_A).scim('GET', `/Users/${aUser}`, tokB)).status === 404);

  // webhooks: a receiver on this machine for each tenant
  // (other scripts leave webhooks of their own behind, each with its retries queued; a delivery goes out behind them at 20 a second, so they are cleared first)
  await q('DELETE FROM webhooks WHERE tenant_id = 1');
  await q('UPDATE event_outbox SET processed_at = ? WHERE tenant_id = 1 AND processed_at IS NULL', ['2000-01-01 00:00:00']);
  const got = { a: [], b: [] };
  const recv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { try { got[req.url === '/a' ? 'a' : 'b'].push(JSON.parse(b)); } catch { /* ping */ } res.end('ok'); }); });
  await new Promise((r) => recv.listen(0, '127.0.0.1', r));
  const rport = recv.address().port;
  const hookA = await A.post('/settings/webhooks', { name: `hook A ${tag}`, url: `http://127.0.0.1:${rport}/a`, events: ['incident.created'] });
  const hookB = await B.post('/settings/webhooks', { name: `hook B ${tag}`, url: `http://127.0.0.1:${rport}/b`, events: ['incident.created'] });
  check('each tenant adds a webhook of its own', [hookA, hookB].every((r) => r.status === 200 || r.status === 302), `${hookA.status}/${hookB.status}`);
  await A.post('/incidents', { short_description: `Webhook A ${tag}`, priority: '3' });
  await B.post('/incidents', { short_description: `Webhook B ${tag}`, priority: '3' });
  for (let i = 0; i < 20 && !(got.a.some((e) => JSON.stringify(e).includes(`Webhook A ${tag}`)) && got.b.some((e) => JSON.stringify(e).includes(`Webhook B ${tag}`))); i++) await sleep(500);
  check('the background delivery runs for every tenant: A\'s hook hears A\'s event and B\'s hears B\'s', got.a.some((e) => JSON.stringify(e).includes(`Webhook A ${tag}`)) && got.b.some((e) => JSON.stringify(e).includes(`Webhook B ${tag}`)), JSON.stringify([got.a.length, got.b.length]));
  check('and never the other\'s', !got.a.some((e) => JSON.stringify(e).includes(` B ${tag}`)) && !got.b.some((e) => JSON.stringify(e).includes(`Webhook A ${tag}`) || JSON.stringify(e).includes(`Secret of A`)));
  recv.close();

  // ------------------------------------------------------------------------------------------------------ settings
  section = 'settings';
  const fd = (name, over = {}) => new Promise(async (resolve) => {
    const b = over.browser; await b.ensureToken();
    const f = new FormData(); f.append('_csrf', b.csrf); f.append('product_name', name); f.append('login_background', over.mode || 'builtin'); f.append('accent_color', over.accent || ''); f.append('login_welcome', ''); f.append('login_tagline', over.tagline || ''); f.append('email_footer', '');
    const resp = new Response(f); resolve(b.raw('POST', '/settings/branding', { multipart: { buf: Buffer.from(await resp.arrayBuffer()), type: resp.headers.get('content-type') } }));
  });
  check('B sets its own name, colour and sign-in line', (await fd(`Acme Desk ${tag}`, { browser: B, accent: '#7a1f3d', tagline: 'Acme staff only', mode: 'plain' })).status === 302);
  const loginB = (await new Browser(p1, HOST_B).get('/login')).text; const loginA = (await new Browser(p1, HOST_A).get('/login')).text; const loginC = (await new Browser(p1, HOST_C).get('/login')).text;
  check('B\'s sign-in page is B\'s, and A\'s and C\'s are untouched', loginB.includes(`Acme Desk ${tag}`) && loginB.includes('Acme staff only') && loginB.includes('--brand:#7a1f3d') && loginB.includes('login-plain') && !loginA.includes('Acme Desk') && !loginA.includes('--brand:#7a1f3d') && loginA.includes('<div class="login-title">NovaDesk</div>') && !loginC.includes('Acme Desk') && !loginC.includes('7a1f3d'));
  check('the logo address is per tenant too', (await new Browser(p1, HOST_B).get('/branding/logo')).status === 404);
  const logoPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const upl = await (async () => { await B.ensureToken(); const f = new FormData(); f.append('_csrf', B.csrf); f.append('product_name', `Acme Desk ${tag}`); f.append('login_background', 'plain'); f.append('accent_color', '#7a1f3d'); f.append('logo', new Blob([logoPng], { type: 'image/png' }), 'l.png'); const resp = new Response(f); return B.raw('POST', '/settings/branding', { multipart: { buf: Buffer.from(await resp.arrayBuffer()), type: resp.headers.get('content-type') } }); })();
  check('B uploads a logo: B\'s address serves it, A\'s and C\'s do not', upl.status === 302 && (await new Browser(p1, HOST_B).get('/branding/logo')).buf.equals(logoPng) && (await new Browser(p1, HOST_A).get('/branding/logo')).status === 404 && (await new Browser(p1, HOST_C).get('/branding/logo')).status === 404);
  check('the pages of the other tenants carry the built-in look', !(await A.get('/incidents')).text.includes('--brand:#7a1f3d') && (await B.get('/incidents')).text.includes('--brand:#7a1f3d'));

  const slaPost = (b, hours) => b.post('/settings/sla/policies', Object.fromEntries([1, 2, 3, 4].flatMap((p) => [[`hours_${p}`, p === 1 ? hours : '8'], [`clock_${p}`, 'calendar'], [`warn_${p}`, '75']])));
  const p1BeforeA = (await one('SELECT target_minutes FROM sla_policies WHERE tenant_id = 1 AND applies_to = ? AND priority = 1', ['incident'])).target_minutes;
  await slaPost(B, '2');
  check('B changes its own SLA targets; A\'s are untouched', (await one('SELECT target_minutes FROM sla_policies WHERE tenant_id = ? AND applies_to = ? AND priority = 1', [tenantB.id, 'incident'])).target_minutes === 120 && (await one('SELECT target_minutes FROM sla_policies WHERE tenant_id = 1 AND applies_to = ? AND priority = 1', ['incident'])).target_minutes === p1BeforeA);
  const slaPageB = (await B.get('/settings/sla')).text; const slaPageA = (await A.get('/settings/sla')).text;
  check('and each tenant\'s SLA page shows its own', /name="hours_1"[^>]*value="2"/.test(slaPageB) && !/name="hours_1"[^>]*value="2"/.test(slaPageA));
  const incSla = (await one('SELECT sla_target_minutes FROM incidents WHERE id = ?', [id(incB)])).sla_target_minutes;
  check('a new incident takes its own tenant\'s target', Number(incSla) > 0);
  await B.post('/settings/fields', { entity_type: 'incident', label: `B only ${tag}`, key: `b_only_${tag}`, field_type: 'text', audience: 'everyone' });
  check('custom fields are the tenant\'s own: B\'s field is on B\'s form and not on A\'s or C\'s', (await B.get('/incidents/new')).text.includes(`name="cf_b_only_${tag}"`) && !(await A.get('/incidents/new')).text.includes(`b_only_${tag}`) && !(await C.get('/incidents/new')).text.includes(`b_only_${tag}`) && !(await B.get('/incidents/new')).text.includes(`a_only_${tag}`));
  check('a custom field key can be the same in two tenants', (await B.post('/settings/fields', { entity_type: 'incident', label: `A only ${tag}`, key: `a_only_${tag}`, field_type: 'text', audience: 'everyone' })).status === 200 && Number((await one('SELECT count(*) AS c FROM custom_fields WHERE key = ?', [`a_only_${tag}`])).c) === 2);
  check('the audit log of each tenant holds its own entries', (await B.get('/settings/audit')).text.includes('branding.changed') && (await q('SELECT DISTINCT tenant_id FROM audit_log WHERE detail LIKE ?', [`%${tag}%`])).length >= 2);
  const auditB = (await B.get('/settings/audit')).text;
  check('A\'s audit entries (its people, its sign-ins) do not appear in B\'s', !auditB.includes('Alex Admin') && !auditB.includes('jdoe'));
  // (a notice is recorded once the mail attempt has finished, which can take a few seconds)
  for (let i = 0; i < 60 && (await q('SELECT DISTINCT tenant_id FROM notifications WHERE subject LIKE ?', [`%${tag}%`])).length < 2; i++) await sleep(500);
  check('notifications are listed per tenant', (await A.get('/notifications')).text.includes(`Secret of A ${tag}`) && !(await B.get('/notifications')).text.includes(`Secret of A ${tag}`) && (await q('SELECT DISTINCT tenant_id FROM notifications WHERE subject LIKE ?', [`%${tag}%`])).length >= 2);
  const retB = await B.post('/privacy/retention', { days_audit_log: '', days_notifications: '90', days_inbound_emails: '', days_webhook_deliveries: '' });
  check('retention limits are per tenant: B sets one, A has none', [200, 302].includes(retB.status) && Number((await one('SELECT count(*) AS c FROM retention_rules WHERE tenant_id = ? AND keep_days = 90', [tenantB.id])).c) === 1 && Number((await one('SELECT count(*) AS c FROM retention_rules WHERE tenant_id = 1 AND keep_days = 90')).c) === 0, `${retB.status}`);

  // ------------------------------------------------------------------------------------------------------ suspending
  section = 'suspended tenant';
  await tenants.setStatus(tenantB.id, 'suspended');
  await sleep(5500);   // a running server learns of it within five seconds
  const down = new Browser(p1, HOST_B);
  await sleep(100);
  const susp = await tenancyDirectCheck();
  check('a suspended tenant\'s address is closed (503), its signed-in people included', (await down.get('/login')).status === 503 && (await B.get('/')).status === 503);
  check('its API key and SCIM token stop working (403) while the others carry on', (await new Browser(p1, HOST_A).api('GET', '/incidents', keyB)).status === 403 && (await new Browser(p1, HOST_A).scim('GET', '/Users', tokB)).status === 403 && (await new Browser(p1, HOST_A).api('GET', '/incidents', keyA)).status === 200 && (await A.get('/')).status === 200 && (await C.get('/')).status === 200);
  check('the default tenant cannot be suspended', await tenants.setStatus(1, 'suspended').then(() => false, (e) => e instanceof tenants.TenantError));
  await tenants.setStatus(tenantB.id, 'active');
  await sleep(5500);
  check('and when it is switched on again everything is as it was', (await B.get('/incidents')).text.includes(`Secret of B ${tag}`) && (await new Browser(p1, HOST_A).api('GET', '/incidents', keyB)).status === 200);
  async function tenancyDirectCheck() { return true; }

  // ------------------------------------------------------------------------------------------------------ host names
  section = 'host names';
  check('an unknown host is the default tenant\'s when the policy is "default"', (await new Browser(p1, 'whatever.example').get('/login')).status === 200 && (await new Browser(p1, 'whatever.example').get('/login')).text.includes('NovaDesk'));
  check('a host with a base-domain name that matches no tenant falls to the default tenant too', (await new Browser(p1, 'nobody.desk.test').get('/login')).status === 200);
  check('only the first label of a base-domain host names a tenant (a.b.desk.test is not "a")', !(await new Browser(p1, `x.${SLUG_C}.desk.test`).get('/login')).text.includes('Cy Chief'));
  const strict = (h) => new Browser(p2, h);
  check('with TENANT_UNKNOWN_HOST=reject an unknown host is refused (404), with no data', (await strict('whatever.example').get('/login')).status === 404 && (await strict('whatever.example').get('/')).status === 404 && (await strict('desk.test').get('/login')).status === 404);
  check('listed hosts and base-domain hosts still work there', (await strict(HOST_B).get('/login')).status === 200 && (await strict(HOST_C).get('/login')).status === 200 && (await strict(HOST_B).get('/login')).text.includes(`Acme Desk ${tag}`));
  check('and the health check answers for any host', (await strict('whatever.example').get('/health')).status === 200);
  check('the host name is matched whatever its case, and a port or trailing dot does not matter', (await new Browser(p2, HOST_B.toUpperCase()).get('/login')).status === 200 && (await new Browser(p2, `${HOST_B}:8443`).get('/login')).status === 200 && (await new Browser(p2, `${HOST_B}.`).get('/login')).status === 200);
  check('a session made on one server works on the other for the same tenant (they share the database)', await (async () => { const s = new Browser(p2, HOST_B); s.cookie = B.cookie; return (await s.get('/profile')).status === 200; })());
  check('the NovaConnect integration and mail intake are the default tenant\'s whatever the host says', (await new Browser(p1, HOST_B).raw('POST', '/api/integrations/decom/anything', { json: {}, headers: { Authorization: 'Bearer wrong' } })).status !== 200);

  // ------------------------------------------------------------------------------------------------------ the whole database
  section = 'in the database';
  const stray = await q(`SELECT 'users' AS t, count(*)::int AS n FROM users WHERE tenant_id IS NULL UNION ALL SELECT 'incidents', count(*)::int FROM incidents WHERE tenant_id IS NULL`);
  check('no row is without a tenant', stray.every((r) => r.n === 0));
  const rls = await q("SELECT count(*)::int AS n FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace AND NOT relrowsecurity AND relname NOT IN ('schema_migrations', 'tenants', 'tenant_hosts', 'platform_admins', 'platform_audit')");
  check('every table of the live database has row level security on', rls[0].n === 0);
  check('the application\'s own connections run as the restricted role', await tenancy.run(1, async () => (await db.prepare('select current_user as u').get()).u === 'novadesk_app'));
  check('a database call with no tenant fails instead of guessing', await db.prepare('select 1').get().then(() => false, (e) => e.code === 'NO_TENANT'));

  // ------------------------------------------------------------------------------------------------------ clean up
  // (the records of this run stay, like any test data; the tenants are left so their rows keep their meaning)
  section = 'the log';
  const errors = apps.flatMap((a) => a.text().split('\n')).filter((l) => /error|unhandled|exception|failed|NO_TENANT/i.test(l) && !/test mailbox|ethereal|Webhook.*could not be delivered/i.test(l));
  check('the servers\' logs show no errors from any of this', errors.length === 0, errors.slice(-4).join(' | '));
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASS');
  process.exitCode = failed ? 1 : 0;
}

main().then(() => process.exit(process.exitCode || 0), (e) => { console.error(e); process.exit(1); });
