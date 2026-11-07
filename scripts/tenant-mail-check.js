#!/usr/bin/env node
// Outgoing mail for each tenant, end to end, against copies of NovaDesk that this script starts itself (ports 18360 and 18361) and two
// SMTP servers that keep what they receive (scripts/smtp-sink.js; one of them requires a sign-in), on the database named by PGHOST,
// PGUSER, PGPASSWORD and PGDATABASE: who may change the settings, every refusal (including the guard against pointing the server at
// internal addresses or odd ports), the password kept encrypted and never shown, the connection test, that a tenant's mail really goes
// through its own server with its own sender while the others keep using the installation's, a refused sign-in recorded without the
// password, switching off, and the audit log. Needs the demonstration users.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const knexLib = require('knex');
const { dbConfig } = require('../src/settings');
const { startSink } = require('./smtp-sink');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');

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

async function main() {
  const knex = knexLib({ client: 'pg', connection: dbConfig(process.env), pool: { min: 0, max: 3 } });
  const sinkA = await startSink({ port: 0 });                                              // the installation's mail server
  // a tenant's own, over TLS from the first byte with a sign-in (credentials never cross the network unencrypted); a throwaway certificate
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-mailcheck-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-subj', '/CN=localhost', '-days', '1'], { stdio: 'ignore' });
  const sinkB = await startSink({ port: 0, tls: { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, auth: { user: 'bmail', pass: 'b-secret-pw' } });
  const apps = [];
  try {
    await sleep(300);
    const env = { SESSION_SECRET: `mail-${tag}`, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(sinkA.port), SMTP_FROM: 'Server Desk <server@example.test>', SMTP_TLS_VERIFY: 'false' };
    for (const [port, extra] of [[18360, { MAIL_ALLOW_PRIVATE: 'true' }], [18361, {}]]) {
      const a = start(port, { ...env, ...extra }); apps.push(a);
      if (!(await healthy(port, a))) throw new Error(`NovaDesk on ${port} did not start: ${a.text().slice(-400)}`);
    }
    await run(knex, apps, sinkA, sinkB);
  } finally { await knex.destroy(); for (const a of apps) a.child.kill(); await Promise.all(apps.map((a) => a.exited)); await sinkA.close(); await sinkB.close(); }
}

async function run(knex, apps, sinkA, sinkB) {
  const tenants = require('../src/tenants');
  const q = async (sql, params = []) => (await knex.raw(sql, params)).rows;
  const one = async (sql, params = []) => (await q(sql, params))[0];
  const count = async (sql, params = []) => Number((await one(sql, params)).c);
  const OPEN = 18360; const STRICT = 18361;
  const HOST_A = 'help.corp.test'; const HOST_B = `b-${tag}.mail.test`; const HOST_C = `c-${tag}.mail.test`;
  const PW = 'Quartz-Meadow-71b';
  const tb = await tenants.createTenant({ slug: `mail-b-${tag}`, name: `Mail B ${tag}`, hosts: [HOST_B] });
  const tc = await tenants.createTenant({ slug: `mail-c-${tag}`, name: `Mail C ${tag}`, hosts: [HOST_C] });
  await tenants.createAdmin(tb.id, { username: 'bossb', password: PW, fullName: 'Bea Boss', email: `bea${tag}@acme.test` });
  await tenants.createAdmin(tc.id, { username: 'bossc', password: PW, fullName: 'Cy Chief', email: `cy${tag}@globex.test` });
  await sleep(5500);
  const A = new Browser(OPEN, HOST_A); const B = new Browser(OPEN, HOST_B); const C = new Browser(OPEN, HOST_C);
  await A.login('admin', 'admin123'); await B.login('bossb', PW); await C.login('bossc', PW);
  const row = (tid) => one('SELECT * FROM mail_settings WHERE tenant_id = ?', [tid]);
  const form = (over = {}) => ({ enabled: 'on', host: '127.0.0.1', port: String(sinkB.port), username: 'bmail', password: 'b-secret-pw', secure: 'on', tls_verify: undefined, from_address: `Acme B Desk <b-${tag}@acme.test>`, reply_to: `replies-${tag}@acme.test`, ...over });
  const saveAs = (b, over, drop = []) => { const f = form(over); for (const k of [...drop, 'secure', 'tls_verify']) if (f[k] === undefined) delete f[k]; for (const k of drop) delete f[k]; return b.post('/settings/mail', f); };
  const waitFor = async (fn, ms = 15000) => { for (let i = 0; i < ms / 250; i++) { const r = await fn(); if (r) return r; await sleep(250); } return null; };
  const raise = async (b, what) => { const r = await b.post('/incidents', { short_description: `${what} ${tag}`, priority: '3' }); return Number((r.loc || '').split('/').pop()); };
  const noticeOf = (tid, id) => waitFor(() => one("SELECT * FROM notifications WHERE tenant_id = ? AND related_type = 'incident' AND related_id = ? ORDER BY id DESC LIMIT 1", [tid, id]));
  const inSink = (sink, text) => waitFor(() => sink.messages.find((m) => m.raw.includes(text)));

  // ------------------------------------------------------------------------------------------------------ before it is set
  section = 'before it is set';
  check('every tenant has a settings row, switched off', (await q('SELECT enabled FROM mail_settings WHERE tenant_id IN (1, ?, ?)', [tb.id, tc.id])).length === 3 && (await q('SELECT enabled FROM mail_settings WHERE tenant_id IN (1, ?, ?)', [tb.id, tc.id])).every((r) => r.enabled === 0));
  const idB0 = await raise(B, 'Before B');
  const mB0 = await inSink(sinkA, `Before B ${tag}`);
  check('a tenant with no settings of its own sends through the installation\'s server, from its sender', Boolean(mB0) && /server@example\.test/.test(mB0.from + mB0.raw.slice(0, 600)), mB0 && mB0.from);
  check('and the notice is recorded for that tenant as sent', (await noticeOf(tb.id, idB0)).status === 'sent');
  const page = await B.get('/settings/mail');
  check('the page says which server is in use now', page.status === 200 && page.text.includes('127.0.0.1') && /the installation(&#39;|')s settings/.test(page.text));
  const agent = new Browser(OPEN, HOST_A); await agent.login('jdoe', 'agent123');
  const before = JSON.stringify(await row(tb.id));
  check('an agent cannot open or change it (403), a signed-out visitor is sent to sign in, a change without the page token is refused', (await agent.get('/settings/mail')).status === 403 && (await agent.post('/settings/mail', form())).status === 403 && (await new Browser(OPEN, HOST_B).get('/settings/mail')).status === 302 && (await B.raw('POST', '/settings/mail', { form: form() })).status === 403 && JSON.stringify(await row(tb.id)) === before);

  // ------------------------------------------------------------------------------------------------------ refusals
  section = 'refusals';
  const refuse = async (b, over, words, label) => { const r = await saveAs(b, over); return check(label, r.status === 400 && words.some((w) => r.text.includes(w)) && JSON.stringify(await row(tb.id)) === before, `${r.status}`); };
  await refuse(B, { host: '' }, ['host name'], 'switching it on without a server is refused');
  await refuse(B, { port: 'x' }, ['port must be a number'], 'a port that is not a number');
  await refuse(B, { username: '' }, ['go together'], 'a password without a user name, or the other way round');
  await refuse(B, { from_address: 'nobody' }, ['sender address'], 'a sender that is not an address');
  await refuse(B, { reply_to: 'nobody' }, ['reply-to'], 'a reply-to that is not an address');
  const sr = new Browser(STRICT, HOST_B); await sr.login('bossb', PW);
  const refuseStrict = async (over, words, label) => { const r = await sr.post('/settings/mail', form(over)); return check(label, r.status === 400 && words.some((w) => r.text.includes(w)) && JSON.stringify(await row(tb.id)) === before, `${r.status}`); };
  await refuseStrict({ port: '587' }, ['private, local or reserved'], 'on a strict server, this machine (127.0.0.1) is refused');
  await refuseStrict({ host: '10.0.0.5', port: '587' }, ['private, local or reserved'], 'a private network address is refused');
  await refuseStrict({ host: '169.254.169.254', port: '25' }, ['private, local or reserved'], 'the cloud metadata address is refused');
  await refuseStrict({ host: 'localhost', port: '587' }, ['private, local or reserved'], 'localhost is refused');
  await refuseStrict({ host: '1.1.1.1', port: '22' }, ['one of 25, 465, 587, 2525'], 'a port that is not a mail port is refused (no port scanning)');
  await refuseStrict({ host: '1.1.1.1', port: '6379' }, ['one of 25, 465, 587, 2525'], 'another one');
  await refuseStrict({ host: 'nonexistent-host-for-mail-check.invalid', port: '587' }, ['could not be looked up', 'no address'], 'a name that does not exist is refused');
  // a row put in the database by hand is held to nothing special at send time except that it must work: a closed port fails plainly
  check('on the open server any port is allowed (a lab)', (await saveAs(B, { port: String(sinkB.port) })).status === 302);

  // ------------------------------------------------------------------------------------------------------ saving
  section = 'saving';
  const r1 = await row(tb.id);
  check('switched on, with the values it was given', r1.enabled === 1 && r1.host === '127.0.0.1' && r1.port === sinkB.port && r1.username === 'bmail' && r1.from_address === `Acme B Desk <b-${tag}@acme.test>` && r1.reply_to === `replies-${tag}@acme.test` && r1.tls_verify === 0);
  check('the password is stored encrypted, and is nowhere in the clear', /^v1:/.test(r1.password_enc) && !JSON.stringify(r1).includes('b-secret-pw'));
  const shown = await B.get('/settings/mail');
  check('the page never shows it, only that one is saved', !shown.text.includes('b-secret-pw') && shown.text.includes('saved; type a new one'));
  await saveAs(B, { from_address: `Acme B Desk <b-${tag}@acme.test>` }, ['password']);
  check('saving again without a password keeps it', (await row(tb.id)).password_enc === r1.password_enc);
  await saveAs(B, {}, []);
  check('the others\' settings were not touched', (await row(1)).enabled === 0 && (await row(tc.id)).enabled === 0 && !(await row(1)).host);
  const audit = await q("SELECT detail FROM audit_log WHERE tenant_id = ? AND action = 'mail.settings_changed' ORDER BY id", [tb.id]);
  check('every change is in the tenant\'s audit log, saying what changed and never the password', audit.length >= 1 && audit.some((a) => /switched on/.test(a.detail)) && audit.some((a) => /password replaced/.test(a.detail)) && !audit.some((a) => /b-secret-pw/.test(a.detail)) && await count("SELECT count(*) AS c FROM audit_log WHERE tenant_id <> ? AND action = 'mail.settings_changed'", [tb.id]) === 0);

  // ------------------------------------------------------------------------------------------------------ the connection test
  section = 'connection test';
  const t1 = await B.post('/settings/mail/test', {});
  check('the test says the server answered and accepted the sign-in', t1.status === 200 && /answered and accepted the sign-in/.test(t1.text), t1.text.slice(t1.text.indexOf('alert-') , t1.text.indexOf('alert-') + 200));
  await saveAs(B, { password: 'the-wrong-password' });
  await sleep(5200);
  const t2 = await B.post('/settings/mail/test', {});
  check('with a wrong password it says so, and the password is not in the answer', /did not accept the connection/.test(t2.text) && !t2.text.includes('the-wrong-password'));

  // ------------------------------------------------------------------------------------------------------ a wrong password at send time
  section = 'a refused sign-in';
  const idBad = await raise(B, 'Refused B');
  const nBad = await noticeOf(tb.id, idBad);
  check('a notice the mail server refuses is recorded as failed, with a plain reason and no password', nBad && nBad.status === 'failed' && !JSON.stringify(nBad).includes('the-wrong-password') && !JSON.stringify(nBad).includes('b-secret-pw'), JSON.stringify(nBad && nBad.error));
  check('and nothing reached either server', !sinkA.messages.some((m) => m.raw.includes(`Refused B ${tag}`)) && !sinkB.messages.some((m) => m.raw.includes(`Refused B ${tag}`)));
  await saveAs(B, { password: 'b-secret-pw' });
  await sleep(5200);

  // ------------------------------------------------------------------------------------------------------ the mail goes where it should
  section = 'where the mail goes';
  const idB = await raise(B, 'After B');
  const mB = await inSink(sinkB, `After B ${tag}`);
  check('a tenant\'s mail goes through its own server, signed in', Boolean(mB), `sinkB has ${sinkB.messages.length}`);
  check('from its own sender, with its own reply-to', mB && /Acme B Desk/.test(mB.raw.slice(0, 1500)) && mB.from === `b-${tag}@acme.test` && new RegExp(`Reply-To:.*replies-${tag}@acme.test`, 'i').test(mB.raw), mB && mB.raw.slice(0, 600));
  check('the notice is recorded as sent, for that tenant', (await noticeOf(tb.id, idB)).status === 'sent');
  check('and not through the installation\'s server', !sinkA.messages.some((m) => m.raw.includes(`After B ${tag}`)));
  const idA = await raise(A, 'After A');
  const mA = await inSink(sinkA, `After A ${tag}`);
  check('the default tenant (no settings of its own) still uses the installation\'s server and sender', Boolean(mA) && mA.from === 'server@example.test' && !sinkB.messages.some((m) => m.raw.includes(`After A ${tag}`)), mA && mA.from);
  const idC = await raise(C, 'After C');
  const mC = await inSink(sinkA, `After C ${tag}`);
  check('so does another tenant with none', Boolean(mC) && mC.from === 'server@example.test' && !sinkB.messages.some((m) => m.raw.includes(`After C ${tag}`)));
  check('nothing a tenant sent is in another tenant\'s notifications', !(await B.get('/notifications')).text.includes(`After A ${tag}`) && !(await A.get('/notifications')).text.includes(`After B ${tag}`));
  check('the notifications page says which server it went through', (await B.get('/notifications')).text.includes('127.0.0.1:' + sinkB.port) && (await A.get('/notifications')).text.includes('127.0.0.1:' + sinkA.port));

  // ------------------------------------------------------------------------------------------------------ switching off
  section = 'switching off';
  await saveAs(B, {}, ['enabled']);
  await sleep(5200);
  check('switched off: the settings are kept', (await row(tb.id)).enabled === 0 && (await row(tb.id)).host === '127.0.0.1' && /^v1:/.test((await row(tb.id)).password_enc));
  const idB2 = await raise(B, 'Off B');
  const mB2 = await inSink(sinkA, `Off B ${tag}`);
  check('and the tenant\'s mail goes back through the installation\'s server', Boolean(mB2) && mB2.from === 'server@example.test');
  const sc = await C.post('/settings/mail/test', {});
  check('testing with nothing switched on says what to do', /Switch the settings on and save them first/.test(sc.text));

  section = 'the log';
  const errors = apps.flatMap((a) => a.text().split('\n')).filter((l) => /error|unhandled|exception|NO_TENANT/i.test(l) && !/test mailbox|ethereal|Notifications: failed to send|Invalid login|535|authentication/i.test(l));
  check('the servers\' logs show no unexpected errors', errors.length === 0, errors.slice(-4).join(' | '));
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASS');
  process.exitCode = failed ? 1 : 0;
}

main().then(() => process.exit(process.exitCode || 0), (e) => { console.error(e); process.exit(1); });
