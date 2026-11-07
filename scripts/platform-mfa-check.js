#!/usr/bin/env node
// Two-step verification for the platform console's operators, end to end, against two copies of NovaDesk that this script starts itself
// (ports 18370 and 18371) on the database named by PGHOST, PGUSER, PGPASSWORD and PGDATABASE: that it is required by default (nothing else
// opens until it is set up), the setup, the code after the password (a half-signed-in cookie opens nothing and cannot be upgraded), wrong
// codes and the lock-out, a code that cannot be used twice, recovery codes, making new ones, switching it off where that is allowed, secrets
// kept encrypted and codes never in the audit log. Needs no demonstration data of its own.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const knexLib = require('knex');
const { dbConfig } = require('../src/settings');
const totp = require('../src/totp');

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
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SEED_DEMO: 'true', SLA_SWEEP_S: '3600', PLATFORM_HOST: 'ops.test', SESSION_SECRET: `pmfa-${tag}`, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => log.push(String(d))); child.stderr.on('data', (d) => log.push(String(d)));
  return { child, text: () => log.join(''), exited: new Promise((r) => child.on('exit', r)) };
}
async function healthy(port, srv) { for (let i = 0; i < 60; i++) { try { if ((await new Browser(port, 'x.test').get('/health')).status === 200) return true; } catch { /* wait */ } if (srv.child.exitCode !== null) return false; await sleep(500); } return false; }

const PW = 'Granite-Falcon-93k';
async function main() {
  const knex = knexLib({ client: 'pg', connection: dbConfig(process.env), pool: { min: 0, max: 3 } });
  const apps = [];
  try {
    await knex.raw('DELETE FROM platform_admins');   // this script makes its own operators
    for (const [port, env] of [[18370, {}], [18371, { PLATFORM_REQUIRE_MFA: 'false' }]]) {
      const a = start(port, env); apps.push(a);
      if (!(await healthy(port, a))) throw new Error(`NovaDesk on ${port} did not start: ${a.text().slice(-400)}`);
    }
    await run(knex, apps);
  } finally { await knex.destroy(); for (const a of apps) a.child.kill(); await Promise.all(apps.map((a) => a.exited)); }
}

async function run(knex, apps) {
  const platform = require('../src/platform');
  const q = async (sql, params = []) => (await knex.raw(sql, params)).rows;
  const one = async (sql, params = []) => (await q(sql, params))[0];
  const count = async (sql, params = []) => Number((await one(sql, params)).c);
  const REQ = 18370; const OPT = 18371;
  const ROOT_U = `root${tag}`; const OPT_U = `opt${tag}`;
  await platform.createOperator({ username: ROOT_U, password: PW, fullName: 'Root Operator' });
  await platform.createOperator({ username: OPT_U, password: PW, fullName: 'Opt Operator' });
  const csrfOf = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  const pwLogin = async (port, user, password = PW) => { const b = new Browser(port, 'ops.test'); const l = await b.get('/login'); const r = await b.raw('POST', '/login', { form: { _csrf: csrfOf(l.text), username: user, password } }); return { b, r }; };
  const code = (secret, offsetMs = 0) => totp.codeAt(totp.base32Decode(secret), Date.now() + offsetMs);
  const post = async (b, p, form, from = '/mfa') => { const page = await b.get(from); return b.raw('POST', p, { form: { _csrf: csrfOf(page.text), ...form } }); };
  const submitCode = async (b, value) => { const page = await b.get('/login/mfa'); return b.raw('POST', '/login/mfa', { form: { _csrf: csrfOf(page.text), code: value } }); };
  const opId = async (u) => (await one('SELECT id FROM platform_admins WHERE username = ?', [u])).id;

  // ------------------------------------------------------------------------------------------------------ required: the first sign-in
  section = 'required';
  const first = await pwLogin(REQ, ROOT_U);
  check('the right password signs in, and goes straight to setting up two-step verification', first.r.status === 302 && first.r.loc === '/mfa');
  const closed = await Promise.all(['/', '/audit', '/tenants/1'].map((p) => first.b.get(p)));
  check('nothing else opens until it is on: every other page sends back to the setup', closed.every((r) => r.status === 302 && r.loc === '/mfa'));
  check('nor can anything be changed (making a tenant is sent back too)', (await first.b.raw('POST', '/tenants', { form: { _csrf: csrfOf((await first.b.get('/mfa')).text), slug: 'x', name: 'x' } })).status === 302 && await count("SELECT count(*) AS c FROM tenants WHERE slug = 'x'") === 0);
  const m0 = await first.b.get('/mfa');
  check('the setup page says it is required', m0.status === 200 && /requires two-step verification/.test(m0.text) && /Set it up/.test(m0.text));
  await post(first.b, '/mfa/setup', {});
  const m1 = await first.b.get('/mfa');
  const secret = (m1.text.match(/<code>([A-Z2-7]{32})<\/code>/) || [])[1];
  check('setting up shows the key and a QR code', Boolean(secret) && m1.text.includes('<svg') && /Confirm with the first code/.test(m1.text));
  const wrong = await post(first.b, '/mfa/confirm', { code: '000000' });
  check('a wrong code does not turn it on', wrong.status === 400 && (await one('SELECT enabled FROM platform_mfa WHERE admin_id = ?', [await opId(ROOT_U)])).enabled === 0);
  check('the key is stored encrypted, not as shown', !(await one('SELECT secret_enc FROM platform_mfa WHERE admin_id = ?', [await opId(ROOT_U)])).secret_enc.includes(secret) && /^v1:/.test((await one('SELECT secret_enc FROM platform_mfa WHERE admin_id = ?', [await opId(ROOT_U)])).secret_enc));
  const c0 = code(secret);
  const on = await post(first.b, '/mfa/confirm', { code: c0 });
  const codes = (on.text.match(/<pre[^>]*>([\s\S]*?)<\/pre>/) || [])[1].trim().split(/\s+/);
  check('the right code turns it on and shows ten recovery codes, once', on.status === 200 && codes.length === 10 && codes.every((c) => /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(c)) && !(await first.b.get('/mfa')).text.includes(codes[0]));
  check('only hashes of the recovery codes are kept', await count('SELECT count(*) AS c FROM platform_recovery_codes WHERE admin_id = ?', [await opId(ROOT_U)]) === 10 && !JSON.stringify(await q('SELECT * FROM platform_recovery_codes')).includes(codes[0]));
  check('the console opens in the same session', (await first.b.get('/')).status === 200 && (await first.b.get('/audit')).status === 200);
  check('signing out works', (await post(first.b, '/logout', {}, '/')).status === 302);

  // ------------------------------------------------------------------------------------------------------ the code after the password
  section = 'the code';
  const s1 = await pwLogin(REQ, ROOT_U);
  check('now the password leads to the code page, not into the console', s1.r.status === 302 && s1.r.loc === '/login/mfa' && (await s1.b.get('/login/mfa')).text.includes('Two-step verification'));
  check('the half-signed-in cookie opens nothing else', (await Promise.all(['/', '/audit', '/mfa', '/tenants/1'].map((p) => s1.b.get(p)))).every((r) => r.status === 302 && r.loc === '/login'));
  const pend = s1.b.cookie.match(/nd_platform=([^.;]+)\.([^;]+)/);
  const upgraded = new Browser(REQ, 'ops.test');
  const body = JSON.parse(Buffer.from(pend[1], 'base64url').toString()); body.s = 'ok'; body.e = Date.now() + 3600000;
  upgraded.cookie = `nd_platform=${Buffer.from(JSON.stringify(body)).toString('base64url')}.${pend[2]}`;
  check('it cannot be upgraded by editing it (the signature no longer fits)', (await upgraded.get('/')).status === 302);
  check('a code posted without the page token is refused', (await s1.b.raw('POST', '/login/mfa', { form: { code: code(secret, 30000) } })).status === 403);
  const bad = await submitCode(s1.b, '123456');
  check('a wrong code is refused, and is in the audit log', bad.status === 401 && /not right/.test(bad.text) && await count("SELECT count(*) AS c FROM platform_audit WHERE action = 'login.mfa_failed' AND operator = ?", [ROOT_U]) >= 1);
  const good = code(secret, 30000);   // the step after the one used to set it up (a step is good once)
  const ok1 = await submitCode(s1.b, good);
  check('the right code signs in', ok1.status === 302 && ok1.loc === '/' && (await s1.b.get('/')).status === 200);
  const s2 = await pwLogin(REQ, ROOT_U);
  const replay = await submitCode(s2.b, good);
  check('the same code cannot be used a second time', replay.status === 401);
  const rc = codes[0];
  const viaRecovery = await submitCode(s2.b, rc);
  check('a recovery code signs in, in place of the code', viaRecovery.status === 302 && (await s2.b.get('/')).status === 200);
  check('and the log says a recovery code was used, never which', (await one("SELECT detail FROM platform_audit WHERE action = 'login' AND detail LIKE '%recovery%' ORDER BY id DESC")).detail.includes('9 left') && !JSON.stringify(await q('SELECT * FROM platform_audit')).includes(rc));
  const s3 = await pwLogin(REQ, ROOT_U);
  check('each recovery code works once', (await submitCode(s3.b, rc)).status === 401);
  // lock-out
  for (let i = 0; i < 5; i++) await submitCode(s3.b, `00000${i}`);
  const lockedTry = await submitCode(s3.b, codes[1]);
  check('five wrong codes lock the account: even a right recovery code is refused', lockedTry.status === 401 && /locked/.test(lockedTry.text));
  check('and a fresh password sign-in is refused too while it is locked', (await pwLogin(REQ, ROOT_U)).r.status === 401);
  await q('UPDATE platform_admins SET locked_until = NULL, failed_logins = 0');
  check('after the lock ends a recovery code signs in again', (await submitCode(s3.b, codes[1])).status === 302);

  // ------------------------------------------------------------------------------------------------------ changing it
  section = 'changing it';
  const me = s3.b;
  check('new recovery codes need a current code: a wrong one is refused', (await post(me, '/mfa/recovery', { code: '111111' })).status === 400);
  const fresh = await post(me, '/mfa/recovery', { code: codes[2] });
  const newCodes = (fresh.text.match(/<pre[^>]*>([\s\S]*?)<\/pre>/) || [])[1].trim().split(/\s+/);
  check('a right one (here a recovery code) makes ten new ones', fresh.status === 200 && newCodes.length === 10 && !newCodes.includes(codes[3]));
  const s4 = await pwLogin(REQ, ROOT_U);
  check('the old recovery codes no longer work, the new ones do', (await submitCode(s4.b, codes[3])).status === 401 && (await submitCode(s4.b, newCodes[0])).status === 302);
  const dis = await post(me, '/mfa/disable', { code: newCodes[1] });
  check('and another operator has none of this operator\'s two-step verification', await count('SELECT count(*) AS c FROM platform_mfa WHERE admin_id = ?', [await opId(OPT_U)]) === 0);
  check('where it is required it cannot be switched off', dis.status === 400 && /requires two-step/.test(dis.text) && (await one('SELECT enabled FROM platform_mfa WHERE admin_id = ?', [await opId(ROOT_U)])).enabled === 1);

  // ------------------------------------------------------------------------------------------------------ optional
  section = 'optional';
  const o1 = await pwLogin(OPT, OPT_U);
  check('where it is not required, the password alone signs in, straight into the console', o1.r.status === 302 && o1.r.loc === '/' && (await o1.b.get('/')).status === 200);
  await post(o1.b, '/mfa/setup', {});
  const osecret = ((await o1.b.get('/mfa')).text.match(/<code>([A-Z2-7]{32})<\/code>/) || [])[1];
  const oc0 = code(osecret);
  const oon = await post(o1.b, '/mfa/confirm', { code: oc0 });
  const ocodes = (oon.text.match(/<pre[^>]*>([\s\S]*?)<\/pre>/) || [])[1].trim().split(/\s+/);
  check('an operator can switch it on', oon.status === 200 && ocodes.length === 10);
  const o2 = await pwLogin(OPT, OPT_U);
  check('and from then on the password leads to the code', o2.r.loc === '/login/mfa' && (await o2.b.get('/')).status === 302);
  check('switching it off needs a current code: a wrong one is refused', (await post(o1.b, '/mfa/disable', { code: '999999' })).status === 400);
  const offOk = await post(o1.b, '/mfa/disable', { code: code(osecret, 30000) });
  check('a right one switches it off', offOk.status === 200 && /is off/.test(offOk.text) && (await one('SELECT count(*) AS c FROM platform_mfa WHERE admin_id = ?', [await opId(OPT_U)])).c === 0 && await count('SELECT count(*) AS c FROM platform_recovery_codes WHERE admin_id = ?', [await opId(OPT_U)]) === 0);
  check('then the password alone signs in again', (await pwLogin(OPT, OPT_U)).r.loc === '/');

  // ------------------------------------------------------------------------------------------------------ the log
  section = 'the log';
  const audit = JSON.stringify(await q('SELECT * FROM platform_audit'));
  check('the platform audit log has the events', ['mfa.enabled', 'mfa.disabled', 'login.password_ok', 'login.mfa_failed', 'mfa.recovery_codes_replaced', 'mfa.change_refused'].every((a) => audit.includes(`"${a}"`)));
  check('and no code, key or recovery code anywhere in it', !audit.includes(secret) && !audit.includes(osecret) && !codes.some((c) => audit.includes(c)) && !newCodes.some((c) => audit.includes(c)) && !audit.includes(good));
  const errors = apps.flatMap((a) => a.text().split('\n')).filter((l) => /error|unhandled|exception|NO_TENANT/i.test(l));
  check('the servers\' logs show no errors', errors.length === 0, errors.slice(-4).join(' | '));
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASS');
  process.exitCode = failed ? 1 : 0;
}

main().then(() => process.exit(process.exitCode || 0), (e) => { console.error(e); process.exit(1); });
