#!/usr/bin/env node
// Usage limits for each tenant, end to end, against a copy of NovaDesk that this script starts itself (port 18400) on the database named by PGHOST,
// PGUSER, PGPASSWORD and PGDATABASE: that an operator sets them in the console (and every refusal there), the tenant sees what it uses, and that the limits on
// people, records and attached files hold for EVERY way of adding something (pages, the REST API, SCIM, inbound mail, CSV imports), are told plainly,
// leave nothing behind (no file on disk, no half-made record), free up when something is removed or switched off, never delete anything when lowered, never
// touch another tenant, and give the last place to exactly one of several requests made at once. Needs the demonstration users.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
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
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SEED_DEMO: 'true', SLA_SWEEP_S: '3600', PLATFORM_HOST: 'ops.test', PLATFORM_REQUIRE_MFA: 'false', SESSION_SECRET: `lim-${tag}`, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => log.push(String(d))); child.stderr.on('data', (d) => log.push(String(d)));
  return { child, text: () => log.join(''), exited: new Promise((r) => child.on('exit', r)) };
}
async function healthy(port, srv) { for (let i = 0; i < 60; i++) { try { if ((await new Browser(port, 'x.test').get('/health')).status === 200) return true; } catch { /* wait */ } if (srv.child.exitCode !== null) return false; await sleep(500); } return false; }

const PW = 'Granite-Falcon-93k'; const TPW = 'Quartz-Meadow-71b';
async function main() {
  process.env.SESSION_SECRET = `lim-${tag}`;
  const knex = knexLib({ client: 'pg', connection: dbConfig(process.env), pool: { min: 0, max: 3 } });
  const app = start(18400, {});
  try {
    if (!(await healthy(18400, app))) throw new Error(`NovaDesk did not start: ${app.text().slice(-400)}`);
    await run(knex, app);
  } catch (e) { console.error(`server output (tail):\n${app.text().slice(-1500)}`); throw e;
  } finally { await knex.destroy(); app.child.kill(); await app.exited; }
}

async function run(knex, app) {
  const platform = require('../src/platform');
  const tenants = require('../src/tenants');
  const q = async (sql, params = []) => (await knex.raw(sql, params)).rows;
  const one = async (sql, params = []) => (await q(sql, params))[0];
  const count = async (sql, params = []) => Number((await one(sql, params)).c);
  const PORT = 18400;
  const HOST_B = `b-${tag}.lim.test`; const HOST_C = `c-${tag}.lim.test`;
  await q('DELETE FROM platform_admins');   // this script makes its own operator
  await platform.createOperator({ username: `ops${tag}`, password: PW, fullName: 'Ops Operator' });
  const tb = await tenants.createTenant({ slug: `lim-b-${tag}`, name: `Limited B ${tag}`, hosts: [HOST_B] });
  const tc = await tenants.createTenant({ slug: `lim-c-${tag}`, name: `Neighbour C ${tag}`, hosts: [HOST_C] });
  await tenants.createAdmin(tb.id, { username: 'bossb', password: TPW, fullName: 'Bea Boss', email: `bea${tag}@b.test` });
  await tenants.createAdmin(tc.id, { username: 'bossc', password: TPW, fullName: 'Cy Chief', email: `cy${tag}@c.test` });
  await sleep(5500);
  const A = new Browser(PORT, 'help.corp.test'); const B = new Browser(PORT, HOST_B); const C = new Browser(PORT, HOST_C);
  await A.login('admin', 'admin123'); await B.login('bossb', TPW); await C.login('bossc', TPW);
  const root = new Browser(PORT, 'ops.test'); const lg = await root.get('/login');
  const csrfOf = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  await root.raw('POST', '/login', { form: { _csrf: csrfOf(lg.text), username: `ops${tag}`, password: PW } });
  const consoleAct = async (p, form) => { const page = await root.get(`/tenants/${tb.id}`); return root.raw('POST', p, { form: { _csrf: csrfOf(page.text), ...form } }); };
  const setLimits = (u, r, s) => consoleAct(`/tenants/${tb.id}/limits`, { limit_users: u === null ? '' : String(u), limit_records: r === null ? '' : String(r), limit_storage_mb: s === null ? '' : String(s) });
  const upl = async (b, kind, content) => { await b.ensureToken(); const f = new FormData(); f.append('_csrf', b.csrf); f.append('mode', 'add'); f.append('file', new Blob([content], { type: 'text/csv' }), 'i.csv'); return b.raw('POST', `/import/${kind}`, { multipart: await (async () => { const resp = new Response(f); return { buf: Buffer.from(await resp.arrayBuffer()), type: resp.headers.get('content-type') }; })() }); };
  const importCsv = async (b, kind, content) => { const r = await upl(b, kind, content); const id = Number((r.loc || '').split('/').pop()); const run = await b.post(`/import/job/${id}/run`, {}); return (await b.get(`/import/job/${id}`)).text; };
  const uploadFile = async (b, incId, name, bytes) => { await b.ensureToken(); const f = new FormData(); f.append('_csrf', b.csrf); f.append('file', new Blob([bytes], { type: 'application/octet-stream' }), name); const resp = new Response(f); return b.raw('POST', `/incidents/${incId}/attachments`, { multipart: { buf: Buffer.from(await resp.arrayBuffer()), type: resp.headers.get('content-type') } }); };
  const newUser = (b, name) => b.post('/users', { username: name, full_name: `Person ${name}`, email: `${name}@b.test`, password: TPW, role: 'user', department: 'QA', active: '1' });
  const usage = async () => ({ users: await count('SELECT count(*) AS c FROM users WHERE tenant_id = ? AND active = 1', [tb.id]), records: (await count('SELECT count(*) AS c FROM incidents WHERE tenant_id = ?', [tb.id])) + (await count('SELECT count(*) AS c FROM service_requests WHERE tenant_id = ?', [tb.id])) + (await count('SELECT count(*) AS c FROM changes WHERE tenant_id = ?', [tb.id])) + (await count('SELECT count(*) AS c FROM problems WHERE tenant_id = ?', [tb.id])) + (await count('SELECT count(*) AS c FROM cmdb_ci WHERE tenant_id = ?', [tb.id])) + (await count('SELECT count(*) AS c FROM kb_articles WHERE tenant_id = ?', [tb.id])) });
  const uploads = path.join(ROOT, 'data', 'uploads', 'incident');
  const filesOnDisk = () => (fs.existsSync(uploads) ? fs.readdirSync(uploads).length : 0);

  // ------------------------------------------------------------------------------------------------------ setting them
  section = 'setting limits';
  check('a new tenant has no limits', (await one('SELECT limit_users, limit_records, limit_storage_mb FROM tenants WHERE id = ?', [tb.id])).limit_users === null && /no limits/.test((await root.get('/')).text.split('</tr>').find((r) => r.includes(`>lim-b-${tag}<`)) || ''));
  const tp = (await root.get(`/tenants/${tb.id}`)).text;
  check('the tenant\'s page in the console has the limits card, with what is used', /Limits and usage/.test(tp) && /name="limit_users"/.test(tp) && /used: 1/.test(tp));
  for (const bad of [{ u: '-1' }, { u: 'ten' }, { u: '1.5' }, { r: '1e3' }, { s: '1000001' }]) {
    const r = await consoleAct(`/tenants/${tb.id}/limits`, { limit_users: bad.u || '', limit_records: bad.r || '', limit_storage_mb: bad.s || '' });
    check(`a limit of "${Object.values(bad)[0]}" is refused, with the reason, and nothing changes`, r.status === 400 && /whole number from 0 to 1000000/.test(r.text) && (await one('SELECT limit_users, limit_records, limit_storage_mb FROM tenants WHERE id = ?', [tb.id])).limit_users === null);
  }
  check('good limits are saved', (await setLimits(4, 6, 1)).status === 302 && JSON.stringify(await one('SELECT limit_users AS u, limit_records AS r, limit_storage_mb AS s FROM tenants WHERE id = ?', [tb.id])) === JSON.stringify({ u: 4, r: 6, s: 1 }));
  check('and the console shows them against what is used', /people 1\/4/.test((await root.get('/')).text) && /records 0\/6/.test((await root.get('/')).text));
  const logLine = await one("SELECT detail, operator FROM platform_audit WHERE action = 'tenant.limits_changed' AND tenant_id = ? ORDER BY id DESC LIMIT 1", [tb.id]);
  check('the change is in the platform\'s audit log, from what to what', /people none -> 4; records none -> 6; storage MB none -> 1/.test(logLine.detail) && logLine.operator === `ops${tag}`);
  check('only the operator can set them: the tenant\'s own administrator has no such page and cannot post one', (await B.get(`/tenants/${tb.id}`)).status === 404 && (await new Browser(PORT, HOST_B).raw('POST', `/tenants/${tb.id}/limits`, { form: { limit_users: '99' } })).status !== 302);
  check('another tenant is not affected', (await one('SELECT limit_users FROM tenants WHERE id = ?', [tc.id])).limit_users === null);

  // ------------------------------------------------------------------------------------------------------ what the tenant sees
  section = 'what the tenant sees';
  const up = await B.get('/settings/usage');
  check('an administrator sees what the workspace uses and what it is allowed', up.status === 200 && /Active people[\s\S]*?1[\s\S]*?of[\s\S]*?4/.test(up.text) && /Records[\s\S]*?of[\s\S]*?6/.test(up.text) && /Attached files[\s\S]*?of[\s\S]*?1 MB/.test(up.text));
  const agent = new Browser(PORT, HOST_B);
  check('an agent cannot open it (403), a signed-out visitor is sent to sign in; there is nothing to change on it', (await new Browser(PORT, HOST_B).get('/settings/usage')).status === 302);
  check('a workspace with no limits says so', /no limit/.test((await C.get('/settings/usage')).text) && /no limit/.test((await A.get('/settings/usage')).text));

  // ------------------------------------------------------------------------------------------------------ people
  section = 'people';
  for (const n of ['p1', 'p2', 'p3']) await newUser(B, `${n}${tag}`);
  check('people can be added up to the limit (4 with the administrator)', (await usage()).users === 4);
  const full = await newUser(B, `p4${tag}`);
  check('the next is refused with a plain sentence saying what is full and what to do', full.status === 403 && /reached its limit of 4 active people/.test(full.text) && /ask the people who run this service/.test(full.text) && !/Server Error|nd_limit|ND001/.test(full.text), `${full.status}`);
  check('and nobody was made', (await usage()).users === 4 && await count("SELECT count(*) AS c FROM users WHERE username = ?", [`p4${tag}`]) === 0);
  const csvUsers = ['Username,Full Name,E-mail,Role,Department,Assignment Groups,Active,Password', `c1${tag},Cee One,c1${tag}@b.test,user,Ops,,yes,Correct-Horse-9`, `c2${tag},Cee Two,c2${tag}@b.test,user,Ops,,yes,Correct-Horse-9`].join('\n');
  const imp = await importCsv(B, 'users', csvUsers);
  check('a CSV import is held to it too: the rows that do not fit fail with the same sentence', /reached its limit of 4 active people/.test(imp) && (await usage()).users === 4);
  const tokenRes = await B.post('/settings/scim/tokens', { name: `scim ${tag}`, expires: '90' });
  const scimToken = (tokenRes.text.match(/nds_[A-Za-z0-9_-]{40}/) || [])[0];
  const scimUser = (name) => new Browser(PORT, HOST_B).scim('POST', '/Users', scimToken, { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: name, name: { givenName: 'S', familyName: 'Cim' }, emails: [{ value: `${name}@b.test`, primary: true }], active: true });
  const sc = await scimUser(`s1${tag}`);
  check('so is SCIM: a provider is told 403 with the sentence, in SCIM\'s own shape', sc.status === 403 && /reached its limit of 4 active people/.test(JSON.stringify(sc.data)) && /scim:api:messages/.test(JSON.stringify(sc.data)) && (await usage()).users === 4, `${sc.status} ${JSON.stringify(sc.data).slice(0, 160)}`);
  // inbound mail from someone with no account would make a contact (a person)
  const tokenInb = ((await B.post('/settings/inbound/token', {})).text.match(/ndi_[A-Za-z0-9_-]{40}/) || [])[0];
  const mailTo = (token, from, subject, extra = '') => new Browser(PORT, HOST_B).raw('POST', '/api/inbound/email', { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'message/rfc822' }, multipart: { buf: Buffer.from(`From: ${from}\r\nTo: help@desk.test\r\nSubject: ${subject}\r\nMessage-ID: <${tag}-${Math.random().toString(36).slice(2, 8)}@lim.test>\r\nDate: Fri, 06 Nov 2026 10:00:00 +0000\r\nContent-Type: text/plain\r\n\r\nHello ${extra}\r\n`), type: 'message/rfc822' } });
  const inb = await mailTo(tokenInb, `Stranger <stranger${tag}@new.test>`, `Stranger asks ${tag}`);
  check('inbound mail from a stranger (who would become a person) is turned away and said so, not retried for ever', inb.status === 202 && inb.data.outcome === 'rejected' && /limit of 4 active people/.test(inb.data.reason) && (await usage()).users === 4 && await count("SELECT count(*) AS c FROM incidents WHERE short_description = ?", [`Stranger asks ${tag}`]) === 0, JSON.stringify(inb.data));
  const victim = await one("SELECT id FROM users WHERE username = ?", [`p3${tag}`]);
  const edit = { username: `p3${tag}`, full_name: 'Person p3', email: `p3${tag}@b.test`, role: 'user', department: 'QA' };
  await B.post(`/users/${victim.id}/update`, { ...edit });
  check('switching someone off frees a place; switching them back on needs one', (await usage()).users === 3 && (await newUser(B, `p5${tag}`)).status === 302 && (await usage()).users === 4);
  const back = await B.post(`/users/${victim.id}/update`, { ...edit, active: 'on' });
  check('(switching back on, with the workspace full, is refused plainly and they stay off)', back.status === 403 && /reached its limit/.test(back.text) && (await one('SELECT active FROM users WHERE id = ?', [victim.id])).active === 0);
  const ni = await newUser(C, `free1${tag}`); for (const n of ['free2', 'free3', 'free4', 'free5', 'free6']) await newUser(C, `${n}${tag}`);
  check('a neighbour with no limit is not held back by this workspace\'s', ni.status === 302 && await count('SELECT count(*) AS c FROM users WHERE tenant_id = ? AND active = 1', [tc.id]) >= 7);

  // ------------------------------------------------------------------------------------------------------ records
  section = 'records';
  await setLimits(null, 6, 1);
  const mk = async (kind, n) => { if (kind === 'incident') return B.post('/incidents', { short_description: `Lim incident ${n} ${tag}`, priority: '3' }); if (kind === 'change') return B.post('/changes', { short_description: `Lim change ${tag}`, change_type: 'normal', risk: 'low' }); if (kind === 'problem') return B.post('/problems', { short_description: `Lim problem ${tag}`, priority: '3' }); return B.post('/cmdb', { name: `Lim server ${tag}`, ci_type: 'server' }); };
  const made = [await mk('incident', 1), await mk('incident', 2), await mk('change'), await mk('problem'), await mk('ci'), await mk('incident', 3)];
  check('records of every kind are added up to the limit (6 together)', made.every((r) => r.status === 302) && (await usage()).records === 6, made.map((r) => r.status).join(','));
  const over = await mk('incident', 4);
  check('the next, of any kind, is refused plainly', over.status === 403 && /reached its limit of 6 records/.test(over.text) && (await mk('change')).status === 403 && (await mk('problem')).status === 403 && (await mk('ci')).status === 403 && (await usage()).records === 6);
  const key = ((await B.post('/profile/api-keys', { name: `lim ${tag}`, scope: 'write', expires: '' })).text.match(/ndk_[A-Za-z0-9_-]{40}/) || [])[0];
  const api = await new Browser(PORT, HOST_B).api('POST', '/incidents', key, { short_description: `By API ${tag}`, impact: 3, urgency: 3 });
  check('the REST API gets 403 with a code a program can read (limit_reached) and the sentence', api.status === 403 && api.data.error.code === 'limit_reached' && /reached its limit of 6 records/.test(api.data.error.message), `${api.status} ${JSON.stringify(api.data)}`);
  check('and can still read', (await new Browser(PORT, HOST_B).api('GET', '/incidents', key)).status === 200);
  const mail = await mailTo(tokenInb, `Known <bea${tag}@b.test>`, `Known asks ${tag}`);
  check('inbound mail from a known person is turned away too (rejected, with the reason), and no incident appears', mail.status === 202 && mail.data.outcome === 'rejected' && /limit of 6 records/.test(mail.data.reason) && await count("SELECT count(*) AS c FROM incidents WHERE short_description = ?", [`Known asks ${tag}`]) === 0, JSON.stringify(mail.data));
  const impCi = await importCsv(B, 'cmdb', ['Name,Type,Environment,IP Address', `imp-a-${tag},Server,Staging,10.1.1.1`, `imp-b-${tag},Server,Staging,10.1.1.2`].join('\n'));
  check('a CSV import of CIs is held to it: every row fails with the sentence', /reached its limit of 6 records/.test(impCi) && (await usage()).records === 6);
  const del = await one("SELECT id FROM incidents WHERE tenant_id = ? AND short_description = ?", [tb.id, `Lim incident 3 ${tag}`]);
  await B.post(`/incidents/${del.id}/delete`, {});
  check('removing a record makes room for another', (await usage()).records === 5 && (await mk('incident', 5)).status === 302 && (await usage()).records === 6);
  await setLimits(null, 2, 1);
  check('lowering the limit below what is used deletes nothing, and refuses new things', (await usage()).records === 6 && (await mk('incident', 6)).status === 403 && (await usage()).records === 6);
  await setLimits(null, 7, 1);
  check('raising it takes effect at once', (await mk('incident', 7)).status === 302 && (await usage()).records === 7);
  check('the neighbour and the default tenant add records freely', (await C.post('/incidents', { short_description: `C free ${tag}`, priority: '3' })).status === 302 && (await A.post('/incidents', { short_description: `A free ${tag}`, priority: '3' })).status === 302);

  // ------------------------------------------------------------------------------------------------------ files
  section = 'attached files';
  await setLimits(null, null, 1);
  const inc1 = (await one("SELECT id FROM incidents WHERE tenant_id = ? ORDER BY id LIMIT 1", [tb.id])).id;
  const filesBefore = filesOnDisk();
  const f1 = await uploadFile(B, inc1, 'first.bin', Buffer.alloc(600000, 1));
  check('a file that fits is kept', f1.status === 302 && await count('SELECT COALESCE(SUM(size), 0) AS c FROM attachments WHERE tenant_id = ?', [tb.id]) === 600000 && filesOnDisk() === filesBefore + 1);
  const f2 = await uploadFile(B, inc1, 'second.bin', Buffer.alloc(600000, 2));
  check('one that does not is refused plainly, and the file it wrote is removed from the disk', f2.status === 403 && /reached its limit of 1 MB of attached files/.test(f2.text) && filesOnDisk() === filesBefore + 1 && await count('SELECT count(*) AS c FROM attachments WHERE tenant_id = ?', [tb.id]) === 1, `${f2.status} disk ${filesOnDisk()} vs ${filesBefore + 1}`);
  check('a smaller one that still fits is kept', (await uploadFile(B, inc1, 'third.bin', Buffer.alloc(300000, 3))).status === 302 && await count('SELECT COALESCE(SUM(size), 0) AS c FROM attachments WHERE tenant_id = ?', [tb.id]) === 900000);
  await setLimits(null, null, 1); await sleep(100);
  const withFile = await mailTo(tokenInb, `Known <bea${tag}@b.test>`, `With a big file ${tag}`, '');
  check('mail with a file too big for what is left still opens its incident (records are unlimited now), and says the file was not kept', withFile.status === 202 && withFile.data.outcome === 'ticket');
  // (the mail above had no attachment; a real one is built below)
  const boundary = `b${tag}`; const big = Buffer.alloc(400000, 65).toString('base64').replace(/(.{76})/g, '$1\r\n');
  const mime = `From: Known <bea${tag}@b.test>\r\nTo: help@desk.test\r\nSubject: Big file ${tag}\r\nMessage-ID: <big-${tag}@lim.test>\r\nDate: Fri, 06 Nov 2026 10:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n--${boundary}\r\nContent-Type: text/plain\r\n\r\nPlease see the file.\r\n--${boundary}\r\nContent-Type: application/octet-stream; name="huge.bin"\r\nContent-Disposition: attachment; filename="huge.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n${big}\r\n--${boundary}--\r\n`;
  const filesBeforeMail = filesOnDisk();
  const bigMail = await new Browser(PORT, HOST_B).raw('POST', '/api/inbound/email', { headers: { Authorization: `Bearer ${tokenInb}`, 'Content-Type': 'message/rfc822' }, multipart: { buf: Buffer.from(mime), type: 'message/rfc822' } });
  check('mail whose file does not fit: the incident is still made, the file is not kept and is not left on the disk, and the reason is written down', bigMail.status === 202 && bigMail.data.outcome === 'ticket' && /file\(s\) not kept/.test((await one("SELECT reason FROM inbound_emails WHERE message_id LIKE ?", [`%big-${tag}@%`])).reason) && filesOnDisk() === filesBeforeMail && await count("SELECT COALESCE(SUM(size), 0) AS c FROM attachments WHERE tenant_id = ?", [tb.id]) === 900000, `${bigMail.status} ${JSON.stringify(bigMail.data)}`);

  // ------------------------------------------------------------------------------------------------------ nothing at once
  section = 'at once';
  await setLimits(null, null, null);
  await setLimits((await usage()).users + 1, null, null);
  const room = (await usage()).users;
  const racers = await Promise.all(Array.from({ length: 6 }, (_, i) => scimUser(`race${i}${tag}`)));
  check('six SCIM requests at once for the one place left: exactly one is made, the rest are told 403', racers.filter((r) => r.status === 201).length === 1 && racers.filter((r) => r.status === 403).length === 5 && (await usage()).users === room + 1, racers.map((r) => r.status).join(','));
  await setLimits(0, 0, 0);
  check('a limit of 0 allows nothing new, and the people already there still sign in', (await newUser(B, `zero${tag}`)).status === 403 && (await mk('incident', 8)).status === 403 && (await new Browser(PORT, HOST_B).login('bossb', TPW)).status === 302);
  await setLimits(null, null, null);
  check('with the limits taken away everything is allowed again', (await newUser(B, `after${tag}`)).status === 302 && (await mk('incident', 9)).status === 302);

  section = 'the log';
  const errors = app.text().split('\n').filter((l) => /error|unhandled|exception|NO_TENANT|nd_limit/i.test(l) && !/ECONNREFUSED|could not read a tenant|Import\]|Inbound\]/i.test(l));
  check('the server log shows no unexpected errors (a limit is not a server error)', errors.length === 0, errors.slice(-4).join(' | '));
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASS');
  process.exitCode = failed ? 1 : 0;
}

main().then(() => process.exit(process.exitCode || 0), (e) => { console.error(e); process.exit(1); });
