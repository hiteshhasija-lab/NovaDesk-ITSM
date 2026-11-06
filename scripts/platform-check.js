#!/usr/bin/env node
// The platform console, end to end, against copies of NovaDesk that this script starts itself (ports 18340 to 18342) on the database
// named by PGHOST, PGUSER, PGPASSWORD and PGDATABASE: that it exists only when PLATFORM_HOST is set and only on that host name, the
// operator sign-in (wrong passwords, lock-out, forged and expired cookies, forged requests), the address allow-list, making a tenant
// with its first administrator and host names (and every refusal, leaving nothing half-made), renaming, host names, suspending,
// a new administrator password, the counts it shows (never content), the audit log, and that the tenants then really work.
// Needs the demonstration users (the default tenant).
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
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SEED_DEMO: 'true', SLA_SWEEP_S: '3600', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => log.push(String(d))); child.stderr.on('data', (d) => log.push(String(d)));
  return { child, text: () => log.join(''), exited: new Promise((r) => child.on('exit', r)) };
}
async function healthy(port, srv) { for (let i = 0; i < 60; i++) { try { if ((await new Browser(port, 'x.test').get('/health')).status === 200) return true; } catch { /* wait */ } if (srv.child.exitCode !== null) return false; await sleep(500); } return false; }

const PW = 'Granite-Falcon-93k';
async function main() {
  const knex = knexLib({ client: 'pg', connection: dbConfig(process.env), pool: { min: 0, max: 3 } });
  const apps = [];
  const boot = async (port, env) => { const a = start(port, { SESSION_SECRET: `plat-${port}-${tag}`, ...env }); apps.push(a); if (!(await healthy(port, a))) throw new Error(`NovaDesk on ${port} did not start: ${a.text().slice(-400)}`); return a; };
  try {
    // one at a time: each makes the demonstration data on an empty database if it is the first
    await boot(18340, { PLATFORM_HOST: 'ops.test', PLATFORM_ADMIN_USERNAME: 'root', PLATFORM_ADMIN_PASSWORD: PW, TENANT_BASE_DOMAIN: 'desk.test' });
    await boot(18341, {});
    await boot(18342, { PLATFORM_HOST: 'ops.test', TRUST_PROXY: '1', PLATFORM_ALLOWED_IPS: '203.0.113.0/24' });
    await run(knex, apps);
  } finally { await knex.destroy(); for (const a of apps) a.child.kill(); await Promise.all(apps.map((a) => a.exited)); }
}

async function run(knex, apps) {
  const q = async (sql, params = []) => (await knex.raw(sql, params)).rows;
  const one = async (sql, params = []) => (await q(sql, params))[0];
  const count = async (sql, params = []) => Number((await one(sql, params)).c);
  const P = 18340; const NOCONSOLE = 18341; const FENCED = 18342;
  const HOST_T = `help-${tag}.plat.test`; const SLUG = `plat-${tag}`;
  const csrfOf = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  const console_ = async (port = P, host = 'ops.test') => { const b = new Browser(port, host); const l = await b.get('/login'); const r = await b.raw('POST', '/login', { form: { _csrf: csrfOf(l.text), username: 'root', password: PW } }); b.status = r.status; return b; };
  const post = async (b, p, form) => { const page = await b.get('/'); return b.raw('POST', p, { form: { _csrf: csrfOf(page.text), ...form } }); };

  // ------------------------------------------------------------------------------------------------------ where it exists
  section = 'where it exists';
  const anon = new Browser(P, 'ops.test');
  check('on its own host name the console asks for a sign-in', (await anon.get('/')).status === 302 && (await anon.get('/')).loc === '/login' && (await anon.get('/login')).text.includes('Platform console'));
  const tenantHost = new Browser(P, 'help.corp.test');
  check('on a tenant\'s host name it does not exist: the pages are the tenant\'s and the console\'s paths are 404', (await tenantHost.get('/login')).text.includes('Log In') && !(await tenantHost.get('/login')).text.includes('Platform console') && (await tenantHost.get('/tenants')).status === 404 && (await tenantHost.get('/audit')).status === 404);
  const off = new Browser(NOCONSOLE, 'ops.test');
  check('without PLATFORM_HOST there is no console at all, even at that name', (await off.get('/login')).text.includes('Log In') && !(await off.get('/login')).text.includes('Platform console') && (await off.get('/tenants')).status === 404 && (await off.get('/audit')).status === 404);
  check('exactly one operator exists (made by the first server from its settings)', await count('SELECT count(*) AS c FROM platform_admins') === 1);
  check('the first operator was made from the settings, with a hashed password', (await one('SELECT username, password_hash FROM platform_admins')).username === 'root' && /^\$2[aby]\$/.test((await one('SELECT password_hash FROM platform_admins')).password_hash));

  // ------------------------------------------------------------------------------------------------------ signing in
  section = 'sign-in';
  const bad = new Browser(P, 'ops.test'); const lg = await bad.get('/login');
  check('the sign-in page sets a one-time token cookie and a matching hidden field', /nd_platform_login=/.test(lg.headers['set-cookie'].join(';')) && Boolean(csrfOf(lg.text)));
  check('a sign-in without the token is refused (403)', (await new Browser(P, 'ops.test').raw('POST', '/login', { form: { username: 'root', password: PW } })).status === 403);
  const wrong = await bad.raw('POST', '/login', { form: { _csrf: csrfOf(lg.text), username: 'root', password: 'not-the-password' } });
  const unknown = await bad.raw('POST', '/login', { form: { _csrf: csrfOf((await bad.get('/login')).text), username: 'nobody', password: PW } });
  check('a wrong password and an unknown operator get the same answer', wrong.status === 401 && unknown.status === 401 && wrong.text.includes('do not match') && unknown.text.includes('do not match'));
  check('and nothing is signed in', (await bad.get('/')).status === 302);
  check('failed sign-ins are in the audit log', await count("SELECT count(*) AS c FROM platform_audit WHERE action = 'login.failed'") >= 2);
  const root = await console_();
  check('the right password signs in (302)', root.status === 302 && /nd_platform=/.test(root.cookie));
  const signed = (await (async () => { const b = new Browser(P, 'ops.test'); const l = await b.get('/login'); const r = await b.raw('POST', '/login', { form: { _csrf: csrfOf(l.text), username: 'root', password: PW } }); return r.headers['set-cookie'].join('; '); })());
  check('the cookie is HttpOnly and SameSite=Strict', /nd_platform=[^;]+; Path=\/; HttpOnly; SameSite=Strict/.test(signed));
  const home = await root.get('/');
  check('the overview lists the tenants, with counts', home.status === 200 && home.text.includes('default') && /People|Incidents/.test(home.text) && home.text.includes('Make a tenant'));
  check('it shows no content of any tenant', !/Production web servers responding slowly|Alex Admin|jane\.doe@corp\.local/.test(home.text));
  const forged = new Browser(P, 'ops.test'); forged.cookie = root.cookie.replace(/nd_platform=([^.]+)\.[^;]+/, (m, b) => `nd_platform=${b}.${'A'.repeat(43)}`);
  check('a cookie with a changed signature is nothing', (await forged.get('/')).status === 302);
  const body = Buffer.from(JSON.stringify({ o: 1, e: Date.now() + 3600000, c: 'x' })).toString('base64url');
  const forged2 = new Browser(P, 'ops.test'); forged2.cookie = `nd_platform=${body}.${(root.cookie.match(/nd_platform=[^.]+\.([^;]+)/) || [])[1]}`;
  check('a made-up cookie with a borrowed signature is nothing', (await forged2.get('/')).status === 302);
  const crossServer = new Browser(FENCED, 'ops.test'); crossServer.cookie = root.cookie;
  const cross = await crossServer.raw('GET', '/', { headers: { 'X-Forwarded-For': '203.0.113.9' } });
  check('a cookie from another installation (another secret) is nothing, even from an allowed address', cross.status === 302 && cross.loc === '/login');
  const tenantAdmin = new Browser(P, 'help.corp.test'); await tenantAdmin.post('/login', { username: 'admin', password: 'admin123' });
  const mix = new Browser(P, 'ops.test'); mix.cookie = tenantAdmin.cookie;
  check('a tenant administrator\'s session is nothing to the console', (await mix.get('/')).status === 302);
  check('and the console\'s cookie is nothing to a tenant', await (async () => { const t = new Browser(P, 'help.corp.test'); t.cookie = root.cookie; return (await t.get('/incidents')).status === 302; })());
  check('requests that change something need the page token (403 without or with a wrong one)', (await root.raw('POST', '/tenants', { form: { slug: 'x', name: 'x' } })).status === 403 && (await root.raw('POST', '/tenants', { form: { _csrf: 'wrong', slug: 'x', name: 'x' } })).status === 403 && (await root.raw('POST', '/logout', { form: {} })).status === 403);

  // lock-out last: it needs the right password refused
  const lockee = new Browser(P, 'ops.test');
  for (let i = 0; i < 5; i++) await lockee.raw('POST', '/login', { form: { _csrf: csrfOf((await lockee.get('/login')).text), username: 'root', password: `wrong-${i}` } });
  const locked = await lockee.raw('POST', '/login', { form: { _csrf: csrfOf((await lockee.get('/login')).text), username: 'root', password: PW } });
  check('five wrong passwords lock the operator for a while: even the right one is refused', locked.status === 401 && locked.text.includes('locked'));
  check('the lock is in the audit log', await count("SELECT count(*) AS c FROM platform_audit WHERE action = 'login.locked'") >= 1);
  check('someone already signed in carries on', (await root.get('/')).status === 200);
  await q("UPDATE platform_admins SET locked_until = NULL, failed_logins = 0");

  // ------------------------------------------------------------------------------------------------------ making a tenant
  section = 'making a tenant';
  const tenantsBefore = await count('SELECT count(*) AS c FROM tenants');
  const refuse = async (over, words, label) => {
    const before = [await count('SELECT count(*) AS c FROM tenants'), await count('SELECT count(*) AS c FROM tenant_hosts'), await count('SELECT count(*) AS c FROM users')];
    const r = await post(root, '/tenants', { slug: SLUG, name: `Plat ${tag}`, host: HOST_T, admin_username: 'boss', admin_name: 'Pat Boss', admin_email: `pat${tag}@plat.test`, admin_password: 'Quartz-Meadow-71b', ...over });
    const after = [await count('SELECT count(*) AS c FROM tenants'), await count('SELECT count(*) AS c FROM tenant_hosts'), await count('SELECT count(*) AS c FROM users')];
    return check(label, r.status === 400 && words.every((w) => r.text.includes(w)) && JSON.stringify(before) === JSON.stringify(after), `${r.status} ${JSON.stringify([before, after])}`);
  };
  await refuse({ slug: 'Bad Name' }, ['short name'], 'a bad short name is refused, and nothing is made');
  await refuse({ slug: 'platform' }, ['kept for the system'], 'a reserved short name is refused');
  await refuse({ slug: 'default' }, ['already'], 'a short name that exists is refused');
  await refuse({ name: '   ' }, ['name must be'], 'an empty name is refused');
  await refuse({ host: 'ops.test' }, ['console'], 'the console\'s own host name is refused');
  await refuse({ host: 'not a host!' }, ['not a host name'], 'a bad host name is refused');
  await refuse({ admin_password: 'short' }, ['password'], 'a weak first password is refused, before anything is made');
  await refuse({ admin_password: 'password1234' }, ['attackers try'], 'a common one too');
  await refuse({ admin_username: 'b' }, ['username'], 'a bad administrator username is refused');
  const made = await post(root, '/tenants', { slug: SLUG, name: `Plat ${tag}`, host: HOST_T, admin_username: 'boss', admin_name: 'Pat Boss', admin_email: `pat${tag}@plat.test`, admin_password: 'Quartz-Meadow-71b' });
  const t = await one('SELECT * FROM tenants WHERE slug = ?', [SLUG]);
  check('a tenant is made and the console shows its page', made.status === 302 && made.loc === `/tenants/${t.id}` && t.status === 'active' && t.name === `Plat ${tag}`);
  check('with its host name, its settings and its first administrator (hashed password, in that tenant)', await count('SELECT count(*) AS c FROM tenant_hosts WHERE tenant_id = ? AND host = ?', [t.id, HOST_T]) === 1
    && await count('SELECT count(*) AS c FROM sla_policies WHERE tenant_id = ?', [t.id]) === 6 && await count('SELECT count(*) AS c FROM branding_settings WHERE tenant_id = ?', [t.id]) === 1
    && (await one("SELECT role, password_hash FROM users WHERE tenant_id = ? AND username = 'boss'", [t.id])).role === 'admin' && /^\$2/.test((await one("SELECT password_hash FROM users WHERE tenant_id = ? AND username = 'boss'", [t.id])).password_hash));
  check('and it is in the audit log, naming the operator, with no password in it', (await one("SELECT operator, detail FROM platform_audit WHERE action = 'tenant.created' AND tenant_slug = ?", [SLUG])).operator === 'root' && !JSON.stringify(await q('SELECT * FROM platform_audit')).includes('Quartz-Meadow'));
  const detail = await root.get(`/tenants/${t.id}`);
  check('the tenant\'s page lists its administrator and host name', detail.text.includes('boss') && detail.text.includes(HOST_T) && detail.text.includes('Pat Boss'));
  await sleep(5500);   // a running server learns of a new tenant within five seconds
  const T = new Browser(P, HOST_T);
  check('the tenant works at its host name: its administrator signs in', (await T.login('boss', 'Quartz-Meadow-71b')).status === 302 && (await T.get('/')).text.includes('Pat Boss'));
  check('and not at the default tenant\'s address, nor with the default tenant\'s people', (await new Browser(P, 'help.corp.test').login('boss', 'Quartz-Meadow-71b')).status !== 302 && (await new Browser(P, HOST_T).login('admin', 'admin123')).status !== 302);
  check('and by its short name under the base domain too', (await new Browser(P, `${SLUG}.desk.test`).get('/login')).text.includes('Log In'));
  await T.post('/incidents', { short_description: `Plat secret ${tag}`, priority: '3' });
  const home2 = await root.get('/');
  const row = home2.text.split('</tr>').find((r) => r.includes(`>${SLUG}<`)) || '';
  check('the overview counts what the tenant holds, and shows none of it', /<td class="text-end">1<\/td>/.test(row) && !home2.text.includes(`Plat secret ${tag}`) && !(await root.get(`/tenants/${t.id}`)).text.includes(`Plat secret ${tag}`), row.replace(/\s+/g, ' ').slice(0, 300));
  check('the tenant list grew by one', await count('SELECT count(*) AS c FROM tenants') === tenantsBefore + 1);

  // ------------------------------------------------------------------------------------------------------ changing a tenant
  section = 'changing a tenant';
  check('renaming works and is audited', (await post(root, `/tenants/${t.id}/rename`, { name: `Plat ${tag} Renamed` })).status === 302 && (await one('SELECT name FROM tenants WHERE id = ?', [t.id])).name === `Plat ${tag} Renamed` && (await one("SELECT detail FROM platform_audit WHERE action = 'tenant.renamed' ORDER BY id DESC")).detail.includes('Renamed'));
  check('an empty name is refused', (await post(root, `/tenants/${t.id}/rename`, { name: ' ' })).status === 400);
  const HOST2 = `second-${tag}.plat.test`;
  check('a host name is added', (await post(root, `/tenants/${t.id}/hosts`, { host: HOST2.toUpperCase() })).status === 302 && await count('SELECT count(*) AS c FROM tenant_hosts WHERE host = ?', [HOST2]) === 1);
  check('a host name that belongs to a tenant, a bad one and the console\'s are refused', (await post(root, `/tenants/${t.id}/hosts`, { host: HOST2 })).status === 400 && (await post(root, `/tenants/${t.id}/hosts`, { host: 'a b' })).status === 400 && (await post(root, `/tenants/${t.id}/hosts`, { host: 'ops.test' })).status === 400 && (await post(root, '/tenants/1/hosts', { host: HOST_T })).status === 400);
  await sleep(5500);
  check('the added host name reaches the tenant', (await new Browser(P, HOST2).get('/login')).status === 200 && (await (async () => { const b = new Browser(P, HOST2); return (await b.login('boss', 'Quartz-Meadow-71b')).status === 302; })()));
  check('removing a host name works, and another tenant\'s cannot be removed through this one', (await post(root, `/tenants/${t.id}/hosts/remove`, { host: HOST2 })).status === 302 && await count('SELECT count(*) AS c FROM tenant_hosts WHERE host = ?', [HOST2]) === 0 && (await post(root, `/tenants/${t.id}/hosts/remove`, { host: 'help.corp.test' })).status === 400);
  check('a tenant that does not exist is a 404', (await root.get('/tenants/99999')).status === 404 && (await root.get('/tenants/abc')).status === 404 && (await post(root, '/tenants/99999/rename', { name: 'x' })).status === 404);

  // ------------------------------------------------------------------------------------------------------ suspending
  section = 'suspending';
  check('a tenant is suspended', (await post(root, `/tenants/${t.id}/status`, { status: 'suspended' })).status === 302 && (await one('SELECT status FROM tenants WHERE id = ?', [t.id])).status === 'suspended');
  await sleep(5500);
  check('its address answers 503 and its signed-in people are shut out; the others carry on', (await new Browser(P, HOST_T).get('/login')).status === 503 && (await T.get('/')).status === 503 && (await tenantAdmin.get('/')).status === 200);
  check('the default tenant cannot be suspended (and the page does not offer it)', (await post(root, '/tenants/1/status', { status: 'suspended' })).status === 400 && (await one('SELECT status FROM tenants WHERE id = 1')).status === 'active' && !(await root.get('/tenants/1')).text.includes('Suspend this tenant'));
  check('it is reactivated and everything is as it was', (await post(root, `/tenants/${t.id}/status`, { status: 'active' })).status === 302);
  await sleep(5500);
  check('the tenant works again, with its data', (await T.get('/incidents')).text.includes(`Plat secret ${tag}`));

  // ------------------------------------------------------------------------------------------------------ a new administrator password
  section = 'new administrator password';
  const T2 = new Browser(P, HOST_T); await T2.login('boss', 'Quartz-Meadow-71b');
  const reset = async (username, password) => post(root, `/tenants/${t.id}/reset-admin`, { username, password });
  check('an unknown administrator and a weak password are refused', (await reset('nobody', 'Violet-Harbor-58c')).status === 400 && (await reset('boss', 'short')).status === 400 && (await reset('boss', 'boss-password-1')).status === 400);
  check('a person who is not an administrator of that tenant cannot be reached through it', await (async () => { const r = await reset('jdoe', 'Violet-Harbor-58c'); return r.status === 400; })());
  check('the new password is set', (await reset('boss', 'Violet-Harbor-58c')).status === 302);
  check('the old one stops working, the new one works', (await new Browser(P, HOST_T).login('boss', 'Quartz-Meadow-71b')).status !== 302 && (await new Browser(P, HOST_T).login('boss', 'Violet-Harbor-58c')).status === 302);
  check('their open session was ended', (await T2.get('/')).status === 302);
  const tAudit = await one("SELECT actor_name, detail FROM audit_log WHERE tenant_id = ? AND action = 'platform.password_reset'", [t.id]);
  check('the tenant\'s own audit log says the platform did it', tAudit && /Platform operator root/.test(tAudit.actor_name) && /session/.test(tAudit.detail));
  check('and the platform\'s log has it, without the password', (await one("SELECT detail FROM platform_audit WHERE action = 'tenant.admin_password_reset'")).detail === 'administrator boss' && !JSON.stringify(await q('SELECT * FROM platform_audit')).includes('Violet-Harbor'));
  check('the default tenant\'s people were not touched', (await new Browser(P, 'help.corp.test').login('admin', 'admin123')).status === 302);

  // ------------------------------------------------------------------------------------------------------ the log, signing out
  section = 'audit log and sign-out';
  const log = await root.get('/audit');
  check('the audit log page lists the actions, the operator and the tenant', log.status === 200 && ['tenant.created', 'tenant.renamed', 'tenant.status', 'tenant.admin_password_reset', 'login'].every((a) => log.text.includes(a)) && log.text.includes('root') && log.text.includes(SLUG));
  check('the tenant\'s page shows only its own history', (await root.get(`/tenants/${t.id}`)).text.includes('tenant.renamed') && !(await root.get('/tenants/1')).text.includes('tenant.renamed'));
  check('signing out ends it (the cookie is cleared)', (await post(root, '/logout', {})).status === 302 && (await root.get('/')).status === 302);

  // ------------------------------------------------------------------------------------------------------ the address allow-list
  section = 'allowed addresses';
  const viaIp = (ip) => new Browser(FENCED, 'ops.test').raw('GET', '/login', { headers: { 'X-Forwarded-For': ip } });
  check('an address in the range reaches the console', (await viaIp('203.0.113.9')).status === 200 && (await viaIp('203.0.113.9')).text.includes('Platform console'));
  check('any other address, and one with no forwarding header, gets a plain 404', (await viaIp('198.51.100.1')).status === 404 && (await new Browser(FENCED, 'ops.test').get('/login')).status === 404 && (await viaIp('203.0.114.1')).status === 404 && !(await viaIp('198.51.100.1')).text.includes('Platform'));
  check('the tenants are not affected by the allow-list', (await new Browser(FENCED, 'help.corp.test').get('/login')).status === 200);

  section = 'the log';
  const errors = apps.flatMap((a) => a.text().split('\n')).filter((l) => /error|unhandled|exception|failed|NO_TENANT/i.test(l) && !/test mailbox|ethereal|login.failed/i.test(l));
  check('the servers\' logs show no errors from any of this', errors.length === 0, errors.slice(-4).join(' | '));
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASS');
  process.exitCode = failed ? 1 : 0;
}

main().then(() => process.exit(process.exitCode || 0), (e) => { console.error(e); process.exit(1); });
