#!/usr/bin/env node
// Warnings before a limit is reached, end to end, against a copy of NovaDesk that this script starts itself (port 18440, the warning job every 2 seconds) on the database named
// by PGHOST, PGUSER, PGPASSWORD and PGDATABASE, with a mail sink (port 18442) that a tenant's own mail settings point to: that the administrators of a tenant are told by email at 80, 90
// and 100 per cent of a limit, once each, never again while use hovers around a line, again after use has fallen clearly below it or the limit was raised, that only the tenant's own
// administrators are told (through the tenant's own mail server), that an administrator (and nobody else) sees a notice on every page from 90 per cent, and that the operator's console
// marks the tenant. Needs the demonstration users.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const knexLib = require('knex');
const { dbConfig } = require('../src/settings');
const { startSink } = require('./smtp-sink');

const ROOT = path.join(__dirname, '..');
let failed = 0; let section = '';
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  [${section}] ${name}${!ok && extra ? '  -- ' + String(extra).slice(0, 500) : ''}`); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Math.random().toString(36).slice(2, 7);
const PORT = 18440;

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

function start(env) {
  const log = [];
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SEED_DEMO: 'true', SLA_SWEEP_S: '3600', PLATFORM_HOST: 'ops.test', PLATFORM_REQUIRE_MFA: 'false', LIMIT_WARN_POLL_S: '2', LIMIT_BANNER_CACHE_S: '0', MAIL_ALLOW_PRIVATE: 'true', SESSION_SECRET: `lw-${tag}`, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => log.push(String(d))); child.stderr.on('data', (d) => log.push(String(d)));
  return { child, text: () => log.join(''), exited: new Promise((r) => child.on('exit', r)) };
}
async function healthy(srv) { for (let i = 0; i < 60; i++) { try { if ((await new Browser(PORT, 'x.test').get('/health')).status === 200) return true; } catch { /* wait */ } if (srv.child.exitCode !== null) return false; await sleep(500); } return false; }

const PW = 'Granite-Falcon-93k'; const TPW = 'Quartz-Meadow-71b';
async function main() {
  const knex = knexLib({ client: 'pg', connection: dbConfig(process.env), pool: { min: 0, max: 3, afterCreate: (c, done) => c.query("SELECT set_config('app.tenant_id', '1', false)", (e) => done(e, c)) } });
  const mails = []; const sink = await startSink({ port: 18442, onMessage: (m) => mails.push(m) });
  const app = start({});
  try {
    if (!(await healthy(app))) throw new Error(`NovaDesk did not start: ${app.text().slice(-400)}`);
    await run(knex, mails);
  } catch (e) { console.error(`server output (tail):\n${app.text().slice(-1500)}`); throw e;
  } finally { await knex.destroy(); app.child.kill(); await app.exited; await sink.close(); }
}

async function run(knex, mails) {
  const platform = require('../src/platform');
  const tenants = require('../src/tenants');
  const q = async (sql, params = []) => (await knex.raw(sql, params)).rows;
  const one = async (sql, params = []) => (await q(sql, params))[0];
  const count = async (sql, params = []) => Number((await one(sql, params)).c);
  const HOST_B = `b-${tag}.warn.test`; const HOST_C = `c-${tag}.warn.test`;
  await q('DELETE FROM platform_admins');
  await platform.createOperator({ username: `ops${tag}`, password: PW, fullName: 'Ops Operator' });
  const tb = await tenants.createTenant({ slug: `warn-b-${tag}`, name: `Warned B ${tag}`, hosts: [HOST_B] });
  const tc = await tenants.createTenant({ slug: `warn-c-${tag}`, name: `Neighbour C ${tag}`, hosts: [HOST_C] });
  const ADMIN_MAIL = `bea${tag}@b.test`;
  await tenants.createAdmin(tb.id, { username: 'bossb', password: TPW, fullName: 'Bea Boss', email: ADMIN_MAIL });
  await tenants.createAdmin(tc.id, { username: 'bossc', password: TPW, fullName: 'Cy Chief', email: `cy${tag}@c.test` });
  await sleep(5500);                         // the list of tenants is looked at afresh every 5 seconds
  const B = new Browser(PORT, HOST_B); const C = new Browser(PORT, HOST_C);
  await B.login('bossb', TPW); await C.login('bossc', TPW);
  const root = new Browser(PORT, 'ops.test'); const lg = await root.get('/login');
  const csrfOf = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  await root.raw('POST', '/login', { form: { _csrf: csrfOf(lg.text), username: `ops${tag}`, password: PW } });
  const consoleAct = async (p, form, id = tb.id) => { const page = await root.get(`/tenants/${id}`); return root.raw('POST', p, { form: { _csrf: csrfOf(page.text), ...form } }); };
  const setUsers = (n, id = tb.id) => consoleAct(`/tenants/${id}/limits`, { limit_users: n === null ? '' : String(n), limit_records: '', limit_storage_mb: '' }, id);
  // tenant B uses its own mail server: the sink
  await B.post('/settings/mail', { enabled: 'on', host: '127.0.0.1', port: '18442', from_address: `B Desk <desk-${tag}@b.test>` });
  check('(tenant B sends through its own mail server)', Number((await one('SELECT count(*) AS c FROM mail_settings WHERE tenant_id = ? AND enabled = 1', [tb.id])).c) === 1);

  const active = () => count('SELECT count(*) AS c FROM users WHERE tenant_id = ? AND active = 1', [tb.id]);
  let n = 0;
  const addUsers = async (upTo) => { while ((await active()) < upTo) { n += 1; const r = await B.post('/users', { username: `w${n}${tag}`, full_name: `Person w${n}`, email: `w${n}${tag}@b.test`, password: TPW, role: 'user', department: 'QA', active: '1' }); if (r.status !== 302) throw new Error(`could not add a person: ${r.status}`); } };
  const mailsToBea = () => mails.filter((m) => m.to.some((a) => a.toLowerCase() === ADMIN_MAIL));
  const subjects = () => mailsToBea().map((m) => (m.raw.match(/^Subject: (.*)$/m) || [])[1] || '');
  const waitMails = async (k, ms = 25000) => { const t = Date.now(); while (Date.now() - t < ms) { if (mailsToBea().length >= k) return true; await sleep(500); } return false; };
  const levelOf = async () => (await one("SELECT level FROM limit_warnings WHERE tenant_id = ? AND kind = 'users'", [tb.id])) || { level: null };

  section = 'nothing without a limit';
  await addUsers(8);
  await sleep(5000);
  check('with no limit, nobody is warned however much is used', mailsToBea().length === 0 && (await levelOf()).level === 0);

  section = 'at 80 per cent';
  await setUsers(20); await addUsers(16);
  check('at 16 of 20 the administrator is told, by tenant B\'s own mail server', await waitMails(1), `${mails.length} mails`);
  const m1 = mailsToBea()[0] || { raw: '' };
  check('the email says what is used, what is allowed and what to do', /80%/.test(subjects()[0] || '') && /active people/.test(m1.raw) && /16 of 20/.test(m1.raw.replace(/=\r?\n/g, '')) && /Switch off people/.test(m1.raw.replace(/=\r?\n/g, '')) && m1.raw.includes('Bea Boss'), m1.raw.slice(0, 400));
  check('it came from the tenant\'s own sender address', new RegExp(`desk-${tag}@b.test`).test(m1.raw));
  check('it is in the tenant\'s record of notices', await count("SELECT count(*) AS c FROM notifications WHERE tenant_id = ? AND recipient_email = ? AND subject LIKE '%80%'", [tb.id, ADMIN_MAIL]) === 1);
  await sleep(7000);
  check('it is told once: the job has run several times since and nothing more was sent', mailsToBea().length === 1 && (await levelOf()).level === 80);
  check('no other tenant\'s people were mailed', mails.every((m) => m.to.every((a) => !a.includes('@c.test'))));

  section = 'at 90 per cent, and the notice on every page';
  await addUsers(18);
  check('at 18 of 20 they are told again, at the new level', await waitMails(2) && /90%/.test(subjects()[1] || ''), subjects().join(' | '));
  const adminPage = await B.get('/incidents');
  check('an administrator sees a notice on every page, with what is used and a link', adminPage.status === 200 && /role="status"/.test(adminPage.text) && /used 90% of its limit of 20 active people/.test(adminPage.text) && /href="\/settings\/usage"/.test(adminPage.text) && /alert-warning/.test(adminPage.text));
  check('not on the Plan and usage page itself, which says it fully', !/role="status"/.test((await B.get('/settings/usage')).text));
  const plain = new Browser(PORT, HOST_B); await plain.login(`w1${tag}`, TPW);
  check('a person who is not an administrator sees nothing of it', !/role="status"/.test((await plain.get('/incidents')).text) && !/used 90%/.test((await plain.get('/')).text));
  check('another tenant\'s administrator sees nothing', !/role="status"/.test((await C.get('/incidents')).text));

  section = 'hovering around a line';
  const dip = (await q('SELECT id FROM users WHERE tenant_id = ? AND username = ?', [tb.id, `w2${tag}`]))[0];
  await q('UPDATE users SET active = 0 WHERE id = ?', [dip.id]);      // 17 of 20 = 85 per cent: below 90, not clearly below
  await sleep(6000);
  await q('UPDATE users SET active = 1 WHERE id = ?', [dip.id]);      // back to 18
  await sleep(7000);
  check('a dip to 85% and back up to 90% sends nothing again', mailsToBea().length === 2 && (await levelOf()).level === 90, subjects().join(' | '));

  section = 'at 100 per cent, and the console';
  await addUsers(20);
  check('when the limit is reached they are told that nothing new can be added', await waitMails(3) && /reached its limit/.test(subjects()[2] || '') && /nothing new of this kind can be added/.test(mailsToBea()[2].raw.replace(/=\r?\n/g, '')), subjects().join(' | '));
  const full = await B.get('/incidents');
  check('the notice is now red and says the limit is reached', /alert-danger/.test(full.text) && /reached its limit of 20 active people/.test(full.text));
  const idx = await root.get('/');
  check('the console says the tenant is close to a limit, and marks it full', /id="nearLimits"/.test(idx.text) && idx.text.includes(`Warned B ${tag}`) && />full</.test(idx.text), (idx.text.match(/id="nearLimits"[^<]*/) || [])[0]);
  check('the tenant\'s page says which warnings were told and when', /Administrators of this tenant were told by email: people full/.test((await root.get(`/tenants/${tb.id}`)).text.replace(/\s+/g, ' ')));
  check('the neighbour, with no limit, is not marked', !(idx.text.match(/id="nearLimits"[\s\S]*?<\/div>/) || [''])[0].includes(`Neighbour C ${tag}`));

  section = 'a raised limit starts afresh';
  await setUsers(40);
  check('raising the limit takes the notice away at once', !/role="status"/.test((await B.get('/incidents')).text));
  await sleep(6000);
  check('and the level goes back to nothing (20 of 40 is 50%) without an email', mailsToBea().length === 3 && (await levelOf()).level === 0);
  await setUsers(22);                                                  // 20 of 22 = 90.9%
  check('lowering it again to where they are close is told again, once', await waitMails(4) && /90%/.test(subjects()[3] || '') && (await levelOf()).level === 90, subjects().join(' | '));
  await sleep(5000);
  check('(and only once)', mailsToBea().length === 4);
  await setUsers(null);
  await sleep(5000);
  check('removing the limit clears it: no notice, level back to nothing, no email', mailsToBea().length === 4 && (await levelOf()).level === 0 && !/role="status"/.test((await B.get('/incidents')).text));

  section = 'another tenant, with no mail server of its own';
  await setUsers(1, tc.id);                                            // 1 of 1: full
  const gotNotice = async () => count("SELECT count(*) AS c FROM notifications WHERE tenant_id = ? AND subject LIKE '%reached its limit%'", [tc.id]);
  let seen = 0; for (let i = 0; i < 40 && !seen; i++) { seen = await gotNotice(); if (!seen) await sleep(500); }
  const cRow = await one("SELECT recipient_email, status FROM notifications WHERE tenant_id = ? AND subject LIKE '%reached its limit%' ORDER BY id LIMIT 1", [tc.id]) || {};
  // Without a mail server of its own a tenant uses the installation's (here none is set, so the built-in test mailbox, which records "sent" with a preview link, or "not configured" where mail is off).
  check('its administrator\'s warning is recorded (told once, to its own administrator, not through tenant B\'s mail server)', seen === 1 && cRow.recipient_email === `cy${tag}@c.test` && ['sent', 'not_configured'].includes(cRow.status), JSON.stringify(cRow));
  check('and nothing went to the sink for it', mails.every((m) => m.to.every((a) => !a.includes('@c.test'))));
  check('nor to tenant B\'s record', await count("SELECT count(*) AS c FROM notifications WHERE tenant_id = ? AND recipient_email LIKE '%@c.test'", [tb.id]) === 0);
  await setUsers(null, tc.id);

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASS');
  process.exitCode = failed ? 1 : 0;
}

main().then(() => process.exit(process.exitCode || 0), (e) => { console.error(e); process.exit(1); });
