#!/usr/bin/env node
// Sign-in policies that are decided at start-up, checked by starting NovaDesk itself with each setting:
//   MFA_REQUIRE=admins   an administrator without two-step verification can only reach its setup page and sign-out
//   LOCAL_LOGIN=false    the password form is gone, password sign-in and sign-up are refused, single sign-on is offered
//   settings that do not fit together stop the start with a message that names the problem
// Needs the database settings in the environment (PGHOST ...) and the demonstration users (SEED_DEMO=true data).
// It starts its own copies on ports 18201 to 18203 and stops them.
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const totp = require('../src/totp');

const ROOT = path.join(__dirname, '..');
let failed = 0;
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -- ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(port, env) {
  const log = [];
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SEED_DEMO: 'true', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => log.push(String(d))); child.stderr.on('data', (d) => log.push(String(d)));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, log, exited, text: () => log.join('') };
}
async function waitHealthy(port, srv) {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true; } catch { /* not yet */ }
    if (srv.child.exitCode !== null) return false;
    await sleep(500);
  }
  return false;
}

class Person {
  constructor(base) { this.base = base; this.cookie = ''; }
  async req(method, p, form) {
    const headers = { Cookie: this.cookie }; let body;
    if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = (() => { const sp = new URLSearchParams(); for (const [k, v] of Object.entries(form)) for (const x of (Array.isArray(v) ? v : [v])) sp.append(k, x); return sp.toString(); })(); }
    const res = await fetch(this.base + p, { method, headers, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]; const jar = Object.fromEntries(this.cookie.split('; ').filter(Boolean).map((x) => [x.split('=')[0], x])); jar[kv.split('=')[0]] = kv; this.cookie = Object.values(jar).join('; '); }
    return { status: res.status, loc: res.headers.get('location'), text: await res.text() };
  }
  get(p) { return this.req('GET', p); }
  post(p, f) { return this.req('POST', p, f || {}); }
}

async function mfaRequired() {
  const port = 18201; const base = `http://127.0.0.1:${port}`;
  const srv = start(port, { MFA_REQUIRE: 'admins' });
  try {
    const up = await waitHealthy(port, srv); check('MFA_REQUIRE=admins: the app starts', up, up ? '' : srv.text().slice(-300));
    const agent = new Person(base); await agent.post('/login', { username: 'jdoe', password: 'agent123' });
    check('an agent is not asked for two-step verification', (await agent.get('/incidents')).status === 200);
    const admin = new Person(base); const l = await admin.post('/login', { username: 'admin', password: 'admin123' });
    check('an administrator can sign in with the password', l.status === 302, l.status);
    const blocked = await admin.get('/incidents');
    check('...but is sent to set up two-step verification before anything else', blocked.status === 302 && /\/profile\/mfa\?required=1/.test(blocked.loc), `${blocked.status} ${blocked.loc}`);
    const page = await admin.get('/profile/mfa?required=1');
    check('the setup page opens and explains why', page.status === 200 && /requires two-step verification/.test(page.text));
    check('other pages stay closed (users, settings, notifications)', (await Promise.all(['/users', '/settings/sla', '/notifications', '/'].map((p) => admin.get(p)))).every((r) => r.status === 302 && /profile\/mfa/.test(r.loc)));
    await admin.post('/profile/mfa/setup');
    const key = ((await admin.get('/profile/mfa')).text.match(/id="mfaKey"[^>]*>([A-Z2-7 ]+)</) || [])[1];
    const ok = await admin.post('/profile/mfa/confirm', { code: totp.codeAt(totp.base32Decode(key.replace(/ /g, '')), Date.now()) });
    check('setting it up opens the rest of the app', ok.status === 200 && (await admin.get('/incidents')).status === 200, ok.status);
    const off = await admin.post('/profile/mfa/disable', { password: 'admin123', code: '123456' });
    check('and it cannot be turned off while it is required', off.status === 403 && /cannot be turned off/.test(off.text), off.status);
    const out = await admin.post('/logout'); check('sign-out always works', out.status === 302);
  } finally { srv.child.kill(); await srv.exited; }
}

async function passwordFormOff() {
  const port = 18202; const base = `http://127.0.0.1:${port}`;
  const srv = start(port, { LOCAL_LOGIN: 'false', OIDC_ISSUER: 'http://127.0.0.1:1', OIDC_CLIENT_ID: 'x', OIDC_CLIENT_SECRET: 'y', PUBLIC_URL: base, OIDC_BUTTON_LABEL: 'Sign in with Contoso' });
  try {
    const up = await waitHealthy(port, srv); check('LOCAL_LOGIN=false with single sign-on set up: the app starts', up, up ? '' : srv.text().slice(-300));
    const anon = new Person(base);
    const page = await anon.get('/login');
    check('the login page has the single sign-on button and no password form', page.status === 200 && /Sign in with Contoso/.test(page.text) && !/name="password"/.test(page.text) && !/Create account/.test(page.text));
    const pw = await anon.post('/login', { username: 'jdoe', password: 'agent123' });
    check('the right password no longer signs anyone in', pw.status === 403 && (await anon.get('/incidents')).status === 302, pw.status);
    check('sign-up is closed', (await anon.get('/register')).status === 302 && (await anon.post('/register', { full_name: 'x', username: 'zed', password: 'password1', confirm_password: 'password1' })).status === 403);
    const start = await anon.get('/auth/oidc/start');
    check('an unreachable provider gives a clear message, not a crash', start.status === 502 && /could not be reached/.test(start.text), start.status);
    check('the app is still healthy afterwards', (await fetch(`${base}/health`)).ok);
  } finally { srv.child.kill(); await srv.exited; }
}

async function badSettings() {
  const cases = [
    ['LOCAL_LOGIN=false without single sign-on', { LOCAL_LOGIN: 'false' }, /nobody could sign in/],
    ['single sign-on half set up', { OIDC_ISSUER: 'https://login.example.com', OIDC_CLIENT_ID: 'x' }, /needs OIDC_CLIENT_SECRET, PUBLIC_URL/],
    ['an unknown MFA_REQUIRE', { MFA_REQUIRE: 'sometimes' }, /none, admins or all/],
    ['a single sign-on issuer over plain http', { OIDC_ISSUER: 'http://login.example.com', OIDC_CLIENT_ID: 'x', OIDC_CLIENT_SECRET: 'y', PUBLIC_URL: 'https://help.example.com' }, /https/],
  ];
  for (const [name, env, pattern] of cases) {
    const srv = start(18203, env);
    const code = await Promise.race([srv.exited, sleep(15000).then(() => 'still running')]);
    if (code === 'still running') srv.child.kill();
    check(`${name}: the start is refused with a message`, code !== 'still running' && code !== 0 && pattern.test(srv.text()), `exit ${code}: ${srv.text().split('\n').find((l) => /Error/.test(l)) || ''}`);
  }
}

(async () => {
  await mfaRequired();
  await passwordFormOff();
  await badSettings();
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})();
