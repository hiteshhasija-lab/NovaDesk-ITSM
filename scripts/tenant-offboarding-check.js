#!/usr/bin/env node
// Leaving the service, end to end, against copies of NovaDesk that this script starts itself (ports 18390 and 18391) on the database named by
// PGHOST, PGUSER, PGPASSWORD and PGDATABASE: a tenant with real data (records, attachments, a logo, an API key, a webhook, single sign-on and mail
// settings with secrets) is exported and the archive is checked (what is in it, what is not, nothing of any other tenant), then deleted through
// the console's whole road (suspend, a final export, the slug typed, re-authentication, a grace period, calling it off), and afterwards nothing of it
// is left (rows, hosts, files) while every other tenant is untouched. A second tenant is removed by the background job. Needs the demonstration users.
'use strict';
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
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
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SEED_DEMO: 'true', SLA_SWEEP_S: '3600', PLATFORM_HOST: 'ops.test', PLATFORM_REQUIRE_MFA: 'false', SESSION_SECRET: `off-${tag}`, WEBHOOK_ALLOW_PRIVATE: 'true', MAIL_ALLOW_PRIVATE: 'true', SSO_ALLOW_PRIVATE: 'true', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => log.push(String(d))); child.stderr.on('data', (d) => log.push(String(d)));
  return { child, text: () => log.join(''), exited: new Promise((r) => child.on('exit', r)) };
}
async function healthy(port, srv) { for (let i = 0; i < 60; i++) { try { if ((await new Browser(port, 'x.test').get('/health')).status === 200) return true; } catch { /* wait */ } if (srv.child.exitCode !== null) return false; await sleep(500); } return false; }

const PW = 'Granite-Falcon-93k'; const TPW = 'Quartz-Meadow-71b';
async function main() {
  process.env.SESSION_SECRET = `off-${tag}`;
  const knex = knexLib({ client: 'pg', connection: dbConfig(process.env), pool: { min: 0, max: 3 } });
  const apps = [];
  try {
    for (const [port, env] of [[18390, {}], [18391, { TENANT_DELETE_GRACE_DAYS: '0', TENANT_PURGE_POLL_S: '2' }]]) {
      const a = start(port, env); apps.push(a);
      if (!(await healthy(port, a))) throw new Error(`NovaDesk on ${port} did not start: ${a.text().slice(-400)}`);
    }
    await run(knex, apps);
  } finally { await knex.destroy(); for (const a of apps) a.child.kill(); await Promise.all(apps.map((a) => a.exited)); }
}

async function run(knex, apps) {
  const platform = require('../src/platform');
  const tenants = require('../src/tenants');
  const tenancy = require('../src/tenancy');
  const q = async (sql, params = []) => (await knex.raw(sql, params)).rows;
  const one = async (sql, params = []) => (await q(sql, params))[0];
  const count = async (sql, params = []) => Number((await one(sql, params)).c);
  const P1 = 18390; const P2 = 18391;
  const HOST_X = `x-${tag}.off.test`; const HOST_Y = `y-${tag}.off.test`; const HOST_C = `c-${tag}.off.test`;
  const SLUG_X = `off-x-${tag}`; const SLUG_Y = `off-y-${tag}`;
  await q('DELETE FROM platform_admins');   // this script makes its own operator
  await platform.createOperator({ username: `ops${tag}`, password: PW, fullName: 'Ops Operator' });
  const tenantTables = (await q("SELECT relname AS t FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relrowsecurity")).map((r) => r.t);
  const rowsOf = async (tid) => { const o = {}; for (const t of tenantTables) o[t] = Number((await one(`SELECT COUNT(*) AS c FROM "${t}" WHERE tenant_id = ?`, [tid])).c); return o; };
  // Sessions, logs and notices grow whatever the script does; what must not change is the data the tenants own.
  const DATA = ['incidents', 'changes', 'problems', 'cmdb_ci', 'users', 'kb_articles', 'service_requests', 'attachments', 'custom_fields', 'custom_field_values', 'webhooks', 'branding_settings', 'mail_settings', 'sso_settings', 'inbound_settings', 'sla_policies', 'business_calendars', 'user_assignment_groups', 'counters', 'catalog_items', 'incident_comments', 'change_comments', 'problem_comments', 'watchers', 'tenant_hosts_placeholder'].filter((t) => tenantTables.includes(t));
  const dataOf = async (tid) => { const o = {}; for (const t of DATA) o[t] = Number((await one(`SELECT COUNT(*) AS c FROM "${t}" WHERE tenant_id = ?`, [tid])).c); return o; };

  // the tenants: X (to be exported and deleted), C (a neighbour that must not be touched), Y (removed by the background job)
  const tx = await tenants.createTenant({ slug: SLUG_X, name: `Leaving X ${tag}`, hosts: [HOST_X] });
  const tc = await tenants.createTenant({ slug: `off-c-${tag}`, name: `Staying C ${tag}`, hosts: [HOST_C] });
  const ty = await tenants.createTenant({ slug: SLUG_Y, name: `Leaving Y ${tag}`, hosts: [HOST_Y] });
  await tenants.createAdmin(tx.id, { username: 'bossx', password: TPW, fullName: 'Xena Boss', email: `xena${tag}@x.test` });
  await tenants.createAdmin(tc.id, { username: 'bossc', password: TPW, fullName: 'Cy Chief', email: `cy${tag}@c.test` });
  await tenants.createAdmin(ty.id, { username: 'bossy', password: TPW, fullName: 'Yuri Boss', email: `yuri${tag}@y.test` });
  await sleep(5500);
  const A = new Browser(P1, 'help.corp.test'); const X = new Browser(P1, HOST_X); const C = new Browser(P1, HOST_C);
  await A.login('admin', 'admin123'); await X.login('bossx', TPW); await C.login('bossc', TPW);
  const id = (r) => Number((r.loc || '').split('/').pop());

  // ------------------------------------------------------------------------------------------------------ a tenant with real data
  section = 'the tenant has data';
  const incX = id(await X.post('/incidents', { short_description: `X secret incident ${tag}`, description: 'only X may read this', priority: '3' }));
  await X.post('/incidents', { short_description: `X second incident ${tag}`, priority: '2' });
  await X.post('/changes', { short_description: `X change ${tag}`, change_type: 'normal', risk: 'low' });
  await X.post('/problems', { short_description: `X problem ${tag}`, priority: '3' });
  await X.post('/cmdb', { name: `X server ${tag}`, ci_type: 'server' });
  await X.post('/settings/fields', { entity_type: 'incident', label: `X only ${tag}`, key: `x_only_${tag}`, field_type: 'text', audience: 'everyone' });
  const attachmentText = `the contents of X's attachment ${tag}`;
  await X.upload(`/incidents/${incX}/attachments`, 'x-notes.txt', attachmentText);
  const att = await one('SELECT filename, entity_type FROM attachments WHERE tenant_id = ?', [tx.id]);
  const attPath = path.join(ROOT, 'data', 'uploads', att.entity_type, att.filename);
  const logoPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await (async () => { await X.ensureToken(); const f = new FormData(); f.append('_csrf', X.csrf); f.append('product_name', `X Desk ${tag}`); f.append('login_background', 'builtin'); f.append('logo', new Blob([logoPng], { type: 'image/png' }), 'l.png'); const resp = new Response(f); return X.raw('POST', '/settings/branding', { multipart: { buf: Buffer.from(await resp.arrayBuffer()), type: resp.headers.get('content-type') } }); })();
  const keyRes = await X.post('/profile/api-keys', { name: `x key ${tag}`, scope: 'write', expires: '' });
  const apiKey = (keyRes.text.match(/ndk_[A-Za-z0-9_-]{40}/) || [])[0];
  const hookRes = await X.post('/settings/webhooks', { name: `x hook ${tag}`, url: 'http://127.0.0.1:9/x', events: ['incident.created'] });
  const hookSecret = (hookRes.text.match(/whsec_[A-Za-z0-9_-]+|[A-Za-z0-9_-]{32,}(?=<\/code>)/) || [])[0];
  const MAIL_PW = `mailpw-${tag}-secret`; const SSO_SECRET = `ssosecret-${tag}-value`; const BOX_PW = `boxpw-${tag}-secret`;
  await X.post('/settings/mail', { enabled: 'on', host: '127.0.0.1', port: '1', username: 'mailer', password: MAIL_PW, secure: 'on', from_address: `X Desk <x-${tag}@x.test>` });
  await X.post('/settings/sso', { enabled: 'on', issuer: 'http://127.0.0.1:9', client_id: 'cid', client_secret: SSO_SECRET, scopes: 'openid email profile', default_role: 'user' });
  await X.post('/settings/inbound/mailbox', { enabled: 'on', host: '127.0.0.1', port: '1', user: 'box', password: BOX_PW, poll_seconds: '30', unknown_senders: 'create', max_per_sender_hour: '10', secure: 'on', tls_verify: 'on' });
  await X.post('/settings/inbound/token', {});
  await X.post('/users', { username: `xuser${tag}`, full_name: 'Xavier User', email: `xavier${tag}@x.test`, password: TPW, role: 'agent', department: 'QA', active: '1' });
  await A.post('/incidents', { short_description: `DEFAULT secret incident ${tag}`, priority: '3' });
  await C.post('/incidents', { short_description: `C secret incident ${tag}`, priority: '3' });
  const before = { x: await dataOf(tx.id), c: await dataOf(tc.id), d: await dataOf(1) };
  check('the tenant owns records, a file, a logo, a key, a webhook, settings with secrets and people', Boolean(apiKey && att) && before.x.incidents === 2 && before.x.attachments === 1 && before.x.users >= 2 && before.x.webhooks === 1 && before.x.custom_fields === 1 && fs.existsSync(attPath), JSON.stringify([before.x.incidents, before.x.attachments, before.x.users, before.x.webhooks, before.x.custom_fields]));
  check('and its settings rows hold encrypted secrets', /^v1:/.test((await one('SELECT password_enc FROM mail_settings WHERE tenant_id = ?', [tx.id])).password_enc) && /^v1:/.test((await one('SELECT client_secret_enc FROM sso_settings WHERE tenant_id = ?', [tx.id])).client_secret_enc));

  // ------------------------------------------------------------------------------------------------------ the console, and what stands in the way
  section = 'the way to deletion';
  const root = new Browser(P1, 'ops.test'); const lg = await root.get('/login');
  await root.raw('POST', '/login', { form: { _csrf: (lg.text.match(/name="_csrf" value="([^"]+)"/) || [])[1], username: `ops${tag}`, password: PW } });
  const csrf = async (b) => ((await b.get(`/tenants/${tx.id}`)).text.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  const act = async (b, p, form) => b.raw('POST', p, { form: { _csrf: await csrf(b), ...form } });
  const tpage = async () => (await root.get(`/tenants/${tx.id}`)).text;
  check('the console shows the export and deletion cards for the tenant, and says what stands in the way', /Export everything this tenant owns/.test(await tpage()) && /Suspend the tenant first/.test(await tpage()));
  const early = await act(root, `/tenants/${tx.id}/delete`, { slug: SLUG_X, confirm: PW });
  check('deletion cannot be scheduled while the tenant is active', early.status === 400 && /Suspend the tenant first/.test(early.text) && (await one('SELECT status FROM tenants WHERE id = ?', [tx.id])).status === 'active');
  check('the default tenant has neither card, and refuses both by hand', !/Delete this tenant/.test((await root.get('/tenants/1')).text) && (await act(root, '/tenants/1/export', { confirm: PW })).status === 400 && (await act(root, '/tenants/1/delete', { slug: 'default', confirm: PW })).status === 400);
  const wrongPw = await act(root, `/tenants/${tx.id}/export`, { confirm: 'not-the-password' });
  check('an export needs the operator to confirm who they are: a wrong confirmation is refused, recorded, and makes no export', wrongPw.status === 400 && /your password/.test(wrongPw.text) && !(await one('SELECT export_at FROM tenants WHERE id = ?', [tx.id])).export_at && await count("SELECT count(*) AS c FROM platform_audit WHERE action = 'tenant.export_refused' AND tenant_id = ?", [tx.id]) === 1);

  // ------------------------------------------------------------------------------------------------------ the export
  section = 'the export';
  const download = async () => { const r = await act(root, `/tenants/${tx.id}/export`, { confirm: PW }); return r; };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-offboard-'));
  const first = await download();
  check('with the right confirmation the export downloads as a tar.gz', first.status === 200 && /gzip/.test(first.headers['content-type']) && /attachment; filename="off-x-.*\.tar\.gz"/.test(first.headers['content-disposition']) && first.buf[0] === 0x1f && first.buf[1] === 0x8b);
  for (let i = 0; i < 20 && !(await one('SELECT export_at FROM tenants WHERE id = ?', [tx.id])).export_at; i++) await sleep(250);   // recorded just after the download ends
  const rec = await one('SELECT export_at, export_sha256, export_bytes, export_by FROM tenants WHERE id = ?', [tx.id]);
  check('it is recorded with its size and its SHA-256, which is that of the bytes that were sent', rec.export_sha256 === crypto.createHash('sha256').update(first.buf).digest('hex') && Number(rec.export_bytes) === first.buf.length && rec.export_by === `ops${tag}`);
  check('but it was made while the tenant was still active, so it is not final', /not final/.test(await tpage()));
  const late = await act(root, `/tenants/${tx.id}/status`, { status: 'suspended' });
  check('the tenant is suspended', late.status === 302 && (await one('SELECT status FROM tenants WHERE id = ?', [tx.id])).status === 'suspended');
  const stale = await act(root, `/tenants/${tx.id}/delete`, { slug: SLUG_X, confirm: PW });
  check('an export from before the suspension does not count: deletion still cannot be scheduled', stale.status === 400 && /final export first/.test(stale.text));
  await sleep(1100);
  const finalExp = await download();
  for (let i = 0; i < 20 && (await one('SELECT export_at FROM tenants WHERE id = ?', [tx.id])).export_at === rec.export_at; i++) await sleep(250);
  check('an export made after the suspension is final', finalExp.status === 200 && /final: made after it was suspended/.test(await tpage()));
  const archive = path.join(dir, 'x.tar.gz'); fs.writeFileSync(archive, finalExp.buf);
  const list = execFileSync('tar', ['-tzf', archive]).toString().trim().split('\n');
  execFileSync('tar', ['-xzf', archive, '-C', dir]);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  check('the system tar reads the archive: a rows file for every table, the manifest, the files', list.includes('manifest.json') && list.includes('tables/incidents.jsonl') && list.includes('tables/users.jsonl') && list.some((n) => n.startsWith('files/')) && manifest.format === 'novadesk-tenant-export/1' && manifest.tenant.slug === SLUG_X && manifest.exported_by === `ops${tag}`);
  const mismatched = [];
  for (const [t, n] of Object.entries(manifest.tables)) { const have = Number((await one(`SELECT COUNT(*) AS c FROM "${t}" WHERE tenant_id = ?`, [tx.id])).c); const text = fs.readFileSync(path.join(dir, 'tables', `${t}.jsonl`), 'utf8'); const lines = text ? text.trim().split('\n').filter(Boolean).length : 0; if (have !== n || lines !== n) mismatched.push(`${t}: db ${have}, manifest ${n}, file ${lines}`); }
  check('every table has as many rows in its file as the tenant has in the database', mismatched.length === 0 && Object.keys(manifest.tables).length === tenantTables.length - 6, mismatched.join(' | ') || `${Object.keys(manifest.tables).length} of ${tenantTables.length}`);
  const incidents = fs.readFileSync(path.join(dir, 'tables/incidents.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('the rows are the tenant\'s own, whole (text, status, numbers), and only its own', incidents.length === 2 && incidents.some((r) => r.short_description === `X secret incident ${tag}` && r.number === 'INC0000001' && r.tenant_id === tx.id) && incidents.every((r) => r.tenant_id === tx.id));
  check('the attached file is in the archive, byte for byte', fs.readFileSync(path.join(dir, 'files', att.entity_type, att.filename), 'utf8') === attachmentText);
  check('and the logo', fs.readdirSync(path.join(dir, 'files/branding')).some((f) => f.startsWith('logo.')) && fs.readFileSync(path.join(dir, 'files/branding', fs.readdirSync(path.join(dir, 'files/branding')).find((f) => f.startsWith('logo.')))).equals(logoPng));
  const everything = list.filter((n) => n.startsWith('tables/')).map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).join('\n');
  const leaked = ['$2a$', '$2b$', MAIL_PW, SSO_SECRET, BOX_PW, apiKey, crypto.createHash('sha256').update(apiKey).digest('hex'), '"v1:', 'password_hash', 'token_hash', 'client_secret_enc', 'password_enc', 'secret_enc'].filter((s) => everything.includes(s));
  check('no credential or secret is in it: no password hash, no key or token hash, no stored provider, mail or mailbox password, no encrypted blob', leaked.length === 0, leaked.join(' | '));
  check('nor sessions, two-step secrets, idempotency records or the event outbox', ['sessions', 'user_mfa', 'user_recovery_codes', 'api_idempotency', 'event_outbox', 'webhook_deliveries'].every((t) => !list.includes(`tables/${t}.jsonl`)) && manifest.left_out.tables.includes('sessions'));
  check('nothing of any other tenant is in it', !everything.includes(`DEFAULT secret incident ${tag}`) && !everything.includes(`C secret incident ${tag}`) && !everything.includes(`cy${tag}@c.test`));
  check('the people are in it without their credentials', everything.includes(`xena${tag}@x.test`) && everything.includes('Xavier User') && !/"password/.test(fs.readFileSync(path.join(dir, 'tables/users.jsonl'), 'utf8')));
  check('the platform log has the exports with their checksums, and no secret', (await q("SELECT detail FROM platform_audit WHERE action = 'tenant.exported' AND tenant_id = ?", [tx.id])).length === 2 && !JSON.stringify(await q('SELECT * FROM platform_audit')).includes(MAIL_PW));

  // ------------------------------------------------------------------------------------------------------ scheduling, and calling it off
  section = 'scheduling';
  const noSlug = await act(root, `/tenants/${tx.id}/delete`, { slug: 'wrong-name', confirm: PW });
  check('the short name has to be typed exactly', noSlug.status === 400 && /Type the tenant/.test(noSlug.text) && (await one('SELECT status FROM tenants WHERE id = ?', [tx.id])).status === 'suspended');
  const noAuth = await act(root, `/tenants/${tx.id}/delete`, { slug: SLUG_X, confirm: 'nope' });
  check('and the operator confirms who they are again', noAuth.status === 400 && /your password/.test(noAuth.text) && (await one('SELECT status FROM tenants WHERE id = ?', [tx.id])).status === 'suspended' && await count("SELECT count(*) AS c FROM platform_audit WHERE action = 'tenant.delete_refused' AND tenant_id = ?", [tx.id]) === 1);
  const sched = await act(root, `/tenants/${tx.id}/delete`, { slug: SLUG_X, confirm: PW });
  const trow = await one('SELECT status, deletion_scheduled_at, deletion_requested_by FROM tenants WHERE id = ?', [tx.id]);
  const due = new Date(trow.deletion_scheduled_at.replace(' ', 'T') + 'Z').getTime();
  check('then deletion is scheduled, seven days away (the grace period), by that operator', sched.status === 302 && trow.status === 'pending_deletion' && Math.abs(due - (Date.now() + 7 * 86400000)) < 120000 && trow.deletion_requested_by === `ops${tag}`);
  check('the audit log names the export it rests on', (await one("SELECT detail FROM platform_audit WHERE action = 'tenant.deletion_scheduled' AND tenant_id = ?", [tx.id])).detail.includes(rec.export_sha256) === false && /sha256 [0-9a-f]{64}/.test((await one("SELECT detail FROM platform_audit WHERE action = 'tenant.deletion_scheduled' AND tenant_id = ?", [tx.id])).detail));
  await sleep(5500);
  check('meanwhile the tenant is closed: its pages (503) and its API key (403)', (await new Browser(P1, HOST_X).get('/login')).status === 503 && (await new Browser(P1, 'help.corp.test').api('GET', '/incidents', apiKey)).status === 403);
  check('its status cannot be changed while deletion is scheduled', (await act(root, `/tenants/${tx.id}/status`, { status: 'active' })).status === 400 && (await one('SELECT status FROM tenants WHERE id = ?', [tx.id])).status === 'pending_deletion');
  check('nothing is deleted before its time: the job and a direct call both refuse', await tenants.purgeDue() === 0 && await tenants.purge(tx.id).then(() => false, (e) => /scheduled for/.test(e.message)) && JSON.stringify(await dataOf(tx.id)) === JSON.stringify(before.x));
  const cancel = await act(root, `/tenants/${tx.id}/delete/cancel`, {});
  check('deletion can be called off: back to suspended, nothing lost, and the export still counts', cancel.status === 302 && (await one('SELECT status, deletion_scheduled_at FROM tenants WHERE id = ?', [tx.id])).status === 'suspended' && (await one('SELECT deletion_scheduled_at AS d FROM tenants WHERE id = ?', [tx.id])).d === null && JSON.stringify(await dataOf(tx.id)) === JSON.stringify(before.x) && /final: made after it was suspended/.test(await tpage()));
  check('and it can be scheduled again without another export', (await act(root, `/tenants/${tx.id}/delete`, { slug: SLUG_X, confirm: PW })).status === 302 && (await one('SELECT status FROM tenants WHERE id = ?', [tx.id])).status === 'pending_deletion');

  // ------------------------------------------------------------------------------------------------------ deleting
  section = 'deleting';
  const gone = await tenants.purge(tx.id, { due: false });
  check('the purge reports what it removed', gone.rows > 20 && gone.tables >= 40 && gone.files === 1 && gone.slug === SLUG_X, JSON.stringify(gone));
  const left = await rowsOf(tx.id);
  check('no row of the tenant is left in any of its tables', Object.values(left).every((n) => n === 0), JSON.stringify(Object.entries(left).filter(([, n]) => n)));
  check('its record, its host names and its attached file are gone', await count('SELECT count(*) AS c FROM tenants WHERE id = ?', [tx.id]) === 0 && await count('SELECT count(*) AS c FROM tenant_hosts WHERE tenant_id = ?', [tx.id]) === 0 && !fs.existsSync(attPath));
  const after = { c: await dataOf(tc.id), d: await dataOf(1) };
  check('every other tenant is exactly as it was (the neighbour and the default tenant, table by table)', JSON.stringify(after.c) === JSON.stringify(before.c) && JSON.stringify(after.d) === JSON.stringify(before.d));
  check('the neighbour still works and still has its data', (await C.get('/incidents')).text.includes(`C secret incident ${tag}`) && (await A.get('/incidents')).text.includes(`DEFAULT secret incident ${tag}`));
  tenants.invalidate(); await sleep(5500);
  check('the deleted tenant\'s address is nobody\'s now (the default tenant\'s, where it has no people) and its key is just invalid', (await new Browser(P1, HOST_X).login('bossx', TPW)).status !== 302 && (await new Browser(P1, 'help.corp.test').api('GET', '/incidents', apiKey)).status === 401);
  check('the console no longer lists it', !(await root.get('/')).text.includes(SLUG_X) && (await root.get(`/tenants/${tx.id}`)).status === 404);
  check('its short name can be used again', (await tenants.createTenant({ slug: SLUG_X, name: 'Again', hosts: [] })).id > tx.id);
  check('the platform log kept its history', await count('SELECT count(*) AS c FROM platform_audit WHERE tenant_slug = ?', [SLUG_X]) >= 6);
  check('an export of a tenant that is gone is a 404', (await act(root, `/tenants/${tx.id}/export`, { confirm: PW })).status === 404);

  // ------------------------------------------------------------------------------------------------------ the background job
  section = 'the background job';
  const Y = new Browser(P2, HOST_Y); await Y.login('bossy', TPW);
  await Y.post('/incidents', { short_description: `Y incident ${tag}`, priority: '3' });
  check('a second tenant has data', (await rowsOf(ty.id)).incidents === 1);
  const root2 = new Browser(P2, 'ops.test'); const lg2 = await root2.get('/login');
  await root2.raw('POST', '/login', { form: { _csrf: (lg2.text.match(/name="_csrf" value="([^"]+)"/) || [])[1], username: `ops${tag}`, password: PW } });
  const act2 = async (p, form) => { const page = await root2.get(`/tenants/${ty.id}`); return root2.raw('POST', p, { form: { _csrf: (page.text.match(/name="_csrf" value="([^"]+)"/) || [])[1], ...form } }); };
  await sleep(5500);
  await act2(`/tenants/${ty.id}/status`, { status: 'suspended' }); await sleep(1100);
  await act2(`/tenants/${ty.id}/export`, { confirm: PW });
  const s2 = await act2(`/tenants/${ty.id}/delete`, { slug: SLUG_Y, confirm: PW });
  check('on a server with no grace period, scheduling sets the time to now', s2.status === 302);
  let gone2 = false; for (let i = 0; i < 40 && !gone2; i++) { await sleep(500); gone2 = await count('SELECT count(*) AS c FROM tenants WHERE id = ?', [ty.id]) === 0; }
  check('the background job deletes it by itself, within seconds', gone2);
  check('with nothing left', Object.values(await rowsOf(ty.id)).every((n) => n === 0) && await count('SELECT count(*) AS c FROM tenant_hosts WHERE tenant_id = ?', [ty.id]) === 0);
  check('and the platform log says the scheduler did it', Boolean(await one("SELECT 1 AS x FROM platform_audit WHERE action = 'tenant.deleted' AND operator = 'scheduler' AND tenant_slug = ?", [SLUG_Y])));
  check('the neighbour was not touched by that either', JSON.stringify(await dataOf(tc.id)) === JSON.stringify(before.c));

  section = 'the log';
  const errors = apps.flatMap((a) => a.text().split('\n')).filter((l) => /error|unhandled|exception|NO_TENANT/i.test(l) && !/ECONNREFUSED|could not read a tenant|Inbound\] could not|Webhook/i.test(l));
  check('the servers\' logs show no unexpected errors', errors.length === 0, errors.slice(-4).join(' | '));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASS');
  process.exitCode = failed ? 1 : 0;
}

main().then(() => process.exit(process.exitCode || 0), (e) => { console.error(e); process.exit(1); });
