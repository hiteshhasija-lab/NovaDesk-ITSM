#!/usr/bin/env node
// "Download my data", end to end, against a copy of NovaDesk that this script starts itself (port 18410) on the database named by PGHOST, PGUSER,
// PGPASSWORD and PGDATABASE, with a local OpenID Connect provider (port 18411) and a mail sink (port 18412): the page, that a person gets only their own
// data and never a secret, that it asks again who is asking (password; the code too when two-step verification is on; for single sign-on a sign-in from the
// last minutes), that wrong passwords count towards the account lock, that it is limited per hour, forged requests are refused, every download and refusal is in the
// audit log, and the person is told by email. Needs the demonstration users.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const knexLib = require('knex');
const { dbConfig } = require('../src/settings');
const totp = require('../src/totp');
const { startSink } = require('./smtp-sink');

const ROOT = path.join(__dirname, '..');
let failed = 0; let section = '';
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  [${section}] ${name}${!ok && extra ? '  -- ' + String(extra).slice(0, 400) : ''}`); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Math.random().toString(36).slice(2, 7);
const PORT = 18410; const IDP = 'http://127.0.0.1:18411';

// A browser: its own cookies, talking to one server.
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
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SEED_DEMO: 'true', SLA_SWEEP_S: '3600', SESSION_SECRET: `data-${tag}`, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => log.push(String(d))); child.stderr.on('data', (d) => log.push(String(d)));
  return { child, text: () => log.join(''), exited: new Promise((r) => child.on('exit', r)) };
}
async function healthy(srv) { for (let i = 0; i < 60; i++) { try { if ((await new Browser(PORT, 'x.test').get('/health')).status === 200) return true; } catch { /* wait */ } if (srv.child.exitCode !== null) return false; await sleep(500); } return false; }

async function main() {
  const knex = knexLib({ client: 'pg', connection: dbConfig(process.env), pool: { min: 0, max: 3, afterCreate: (c, done) => c.query("SELECT set_config('app.tenant_id', '1', false)", (e) => done(e, c)) } });
  const mails = []; const sink = await startSink({ port: 18412, onMessage: (m) => mails.push(m) });
  const idp = spawn(process.execPath, ['scripts/mock-oidc.js', '18411'], { cwd: ROOT, stdio: 'ignore' });
  await sleep(800);
  const app = start({
    SMTP_HOST: '127.0.0.1', SMTP_PORT: '18412', SMTP_FROM: 'NovaDesk <helpdesk@example.test>',
    PUBLIC_URL: `http://127.0.0.1:${PORT}`, OIDC_ISSUER: IDP, OIDC_CLIENT_ID: 'novadesk-test', OIDC_CLIENT_SECRET: 'test-secret',
    OIDC_AUTO_CREATE: 'true', OIDC_ALLOWED_DOMAINS: 'newco.example', OIDC_JWKS_MIN_REFETCH_S: '1', OIDC_BUTTON_LABEL: 'Sign in with Contoso',
  });
  try {
    if (!(await healthy(app))) throw new Error(`NovaDesk did not start: ${app.text().slice(-400)}`);
    await run(knex, mails);
  } catch (e) { console.error(`server output (tail):\n${app.text().slice(-1500)}`); throw e;
  } finally { await tidy(knex).catch(() => {}); await knex.destroy(); app.child.kill(); idp.kill(); await app.exited; await sink.close(); }
}

// Two-step verification and locks on the demonstration people are removed again, so later scripts on the same database can sign in as them.
async function tidy(knex) {
  const names = "('jdoe','mchen','rpatel','admin')";
  await knex.raw(`DELETE FROM user_recovery_codes WHERE user_id IN (SELECT id FROM users WHERE username IN ${names})`);
  await knex.raw(`DELETE FROM user_mfa WHERE user_id IN (SELECT id FROM users WHERE username IN ${names})`);
  await knex.raw(`UPDATE users SET failed_logins = 0, locked_until = NULL WHERE username IN ${names}`);
}

async function run(knex, mails) {
  const q = async (sql, params = []) => (await knex.raw(sql, params)).rows;
  const one = async (sql, params = []) => (await q(sql, params))[0];
  const audits = async (action, name) => Number((await one("SELECT COUNT(*) AS c FROM audit_log WHERE action = ? AND target_name = ?", [action, name])).c);
  const download = (b, form = {}) => b.post('/profile/data', form);
  const isFile = (r) => r.status === 200 && /application\/json/.test(r.headers['content-type'] || '') && /attachment; filename="my-data-\d{8}\.json"/.test(r.headers['content-disposition'] || '');
  const mailTo = (addr, subject) => mails.filter((m) => m.to.includes(addr) && new RegExp(subject).test(m.raw)).length;

  // Leave nothing from an earlier run on a reused database: two-step verification, locks, failed passwords.
  await q("DELETE FROM user_recovery_codes WHERE user_id IN (SELECT id FROM users WHERE username IN ('jdoe','mchen','rpatel','admin'))");
  await q("DELETE FROM user_mfa WHERE user_id IN (SELECT id FROM users WHERE username IN ('jdoe','mchen','rpatel','admin'))");
  await q("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE username IN ('jdoe','mchen','rpatel','admin')");
  section = 'the page';
  const anon = new Browser(PORT, 'help.test');
  check('a signed-out visitor is sent to sign in, for the page and for the download', (await anon.get('/profile/data')).status === 302 && (await anon.post('/profile/data', {})).status === 302);
  const maria = new Browser(PORT, 'help.test'); await maria.login('mchen', 'user123');
  const page = await maria.get('/profile/data');
  check('a signed-in person sees what is held about them and the form', page.status === 200 && /Download my data/.test(page.text) && /Incidents they reported|Service requests they made|Assignment groups|Single sign-on|Notices|Email notices/.test(page.text) && /name="password"/.test(page.text) && !/name="code"/.test(page.text), page.status);
  check('the menu has the link', /href="\/profile\/data"/.test((await maria.get('/profile')).text));
  check('the page is never kept by the browser', /no-store/.test(page.headers['cache-control'] || ''));

  section = 'who is asking';
  const before = await audits('privacy.self_export_refused', 'mchen');
  const none = await download(maria, {});
  check('nothing typed: refused, no file', none.status === 400 && !isFile(none) && /Type your password/.test(none.text));
  const wrong = await download(maria, { password: 'not-the-password' });
  check('a wrong password: refused, no file, and counted towards the account lock', wrong.status === 400 && !isFile(wrong) && /not right/.test(wrong.text) && Number((await one("SELECT failed_logins FROM users WHERE username = 'mchen'")).failed_logins) >= 1);
  check('both refusals are in the audit log', await audits('privacy.self_export_refused', 'mchen') === before + 2);
  const noToken = await maria.raw('POST', '/profile/data', { form: { password: 'user123' } });
  check('a forged request (no token) is refused', noToken.status === 403 && !isFile(noToken), noToken.status);

  section = 'the download';
  const ok = await download(maria, { password: 'user123' });
  check('the right password: the file', isFile(ok), ok.status);
  const file = ok.data || {};
  check('it is about this person, with the sections', file.profile && file.profile.username === 'mchen' && file.about && /Maria Chen/.test(file.about.what) && Array.isArray(file.incidents_raised) && Array.isArray(file.audit_as_actor));
  const mariaRow = await one("SELECT id FROM users WHERE username = 'mchen'");
  const text = ok.text;
  check('no secret in it: no password hash, no secret, no token', !/\$2[aby]\$\d\d\$/.test(text) && !/password_hash|secret_enc|key_hash|token_hash/i.test(text));
  check('a correct password clears the failed-password count', Number((await one("SELECT failed_logins FROM users WHERE username = 'mchen'")).failed_logins) === 0);
  const other = await one("SELECT id, username FROM users WHERE username = 'jdoe'");
  const aimed = await download(maria, { password: 'user123', user_id: String(other.id), id: String(other.id), username: 'jdoe' });
  check('naming somebody else in the request changes nothing: still their own file', isFile(aimed) && aimed.data.profile.id === mariaRow.id && aimed.data.profile.username === 'mchen');
  check('the download is in the audit log', await audits('privacy.self_exported', 'mchen') >= 2);
  await sleep(800);
  check('the person is told by email, with the time and what to do if it was not them', mailTo('maria.chen@corp.local', 'Your data was downloaded') >= 1 && mails.some((m) => /If this was you/.test(m.raw) || /If it was not/.test(m.raw)));
  check('the mail is also in the notifications record', Number((await one("SELECT COUNT(*) AS c FROM notifications WHERE recipient_email = 'maria.chen@corp.local' AND subject = 'Your data was downloaded'")).c) >= 1);

  section = 'two-step verification';
  const jane = new Browser(PORT, 'help.test'); await jane.login('jdoe', 'agent123');
  await jane.post('/profile/mfa/setup');
  const key = ((await jane.get('/profile/mfa')).text.match(/id="mfaKey"[^>]*>([A-Z2-7 ]+)</) || [])[1];
  const secret = totp.base32Decode(key.replace(/ /g, ''));
  await jane.post('/profile/mfa/confirm', { code: totp.codeAt(secret, Date.now()) });
  check('(two-step verification is on for her)', (await jane.get('/profile/data')).text.includes('name="code"'));
  const noCode = await download(jane, { password: 'agent123' });
  check('the password alone is not enough: refused, no file', noCode.status === 400 && !isFile(noCode) && /code is not right/.test(noCode.text));
  const badCode = await download(jane, { password: 'agent123', code: '000000' });
  check('a wrong code is refused too', badCode.status === 400 && !isFile(badCode));
  const goodCode = await download(jane, { password: 'agent123', code: totp.codeAt(secret, Date.now() + 30000) });
  check('password and code: the file, and it says there is two-step verification without any secret', isFile(goodCode) && goodCode.data.two_step_verification && goodCode.data.two_step_verification.enabled === true && !JSON.stringify(goodCode.data).includes(key.replace(/ /g, '')));
  check('a code cannot be used twice', (await download(jane, { password: 'agent123', code: totp.codeAt(secret, Date.now() + 30000) })).status === 400);

  section = 'single sign-on';
  const idpPost = (p, b) => fetch(IDP + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then((r) => r.json());
  const email = `sso${tag}@newco.example`;
  await idpPost('/__next', { sub: `sub-data-${tag}`, email, email_verified: true, name: 'Sso Person' });
  const sso = new Browser(PORT, 'help.test');
  const st = await sso.get('/auth/oidc/start');
  const auth = await fetch(st.loc, { redirect: 'manual' }); const back = new URL(auth.headers.get('location'));
  const cb = await sso.get(back.pathname + back.search);
  check('(signed in through single sign-on)', cb.status === 302, cb.status);
  const ssoPage = await sso.get('/profile/data');
  check('a sign-in just made: the password may stay empty, and the page says why', ssoPage.status === 200 && /stay empty/.test(ssoPage.text));
  const guess = await download(sso, { password: 'a-guess' });
  check('a guessed password is still refused', guess.status === 400 && !isFile(guess));
  const viaSso = await download(sso, {});
  check('and the file comes with no password', isFile(viaSso) && viaSso.data.profile.email === email, viaSso.status);
  await q("UPDATE sessions SET data = (data::jsonb || '{\"signedInAt\": 1000}'::jsonb)::text WHERE user_id = (SELECT id FROM users WHERE email = ?)", [email]);
  const stale = await download(sso, {});
  check('a sign-in made long ago is not enough: refused with what to do, no file', stale.status === 400 && !isFile(stale) && /Sign out, sign in again/.test(stale.text));
  check('the person was told by email, too', mailTo(email, 'Your data was downloaded') >= 1);

  section = 'account lock';
  const raj = new Browser(PORT, 'help.test'); await raj.login('rpatel', 'user123');
  let lastWrong = null;
  for (let i = 0; i < 10; i++) lastWrong = await download(raj, { password: `wrong-${i}` });
  check('ten wrong passwords lock the account, like at sign-in', Boolean((await one("SELECT locked_until FROM users WHERE username = 'rpatel'")).locked_until));
  const locked = await download(raj, { password: 'user123' });
  check('while it is locked even the right password gets no file, and the answer says so', locked.status === 403 && !isFile(locked) && /locked/.test(locked.text));
  check('the lock is in the audit log', await audits('privacy.self_export_refused', 'rpatel') >= 11);

  section = 'limits';
  const bob = new Browser(PORT, 'help.test'); await bob.login('admin', 'admin123');
  let got = 0; let last = null;
  for (let i = 0; i < 8; i++) { last = await download(bob, { password: 'admin123' }); if (isFile(last)) got++; else break; }
  check('at most 5 downloads an hour: the sixth is refused (429) and says when to try again', got === 5 && last.status === 429 && /5 times in the last hour/.test(last.text) && Boolean(last.headers['retry-after']), `${got} ${last && last.status}`);
  check('the limit is one person\'s: others are not held up', isFile(await download(maria, { password: 'user123' })));

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASS');
  process.exitCode = failed ? 1 : 0;
}

main().then(() => process.exit(process.exitCode || 0), (e) => { console.error(e); process.exit(1); });
