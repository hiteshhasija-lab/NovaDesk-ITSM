#!/usr/bin/env node
// The security measures, tried the way an attacker (or a careless script) would try them, against copies of NovaDesk that
// this script starts itself (ports 18230 to 18233) on the database named by PGHOST, PGUSER, PGPASSWORD and PGDATABASE:
// forged form posts and uploads, the response headers and cookie flags, the password rules, response timing for unknown
// accounts, lockout and unlock, the audit log, and the last-administrator guard. Needs the demonstration users.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const knexLib = require('knex');
const { dbConfig } = require('../src/settings');

const ROOT = path.join(__dirname, '..');
let failed = 0; let section = '';
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  [${section}] ${name}${!ok && extra ? '  -- ' + extra : ''}`); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Math.random().toString(36).slice(2, 7);

class Browser {
  constructor(base) { this.base = base; this.cookie = ''; this.csrf = null; }
  jar(res) { for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]; const j = Object.fromEntries(this.cookie.split('; ').filter(Boolean).map((x) => [x.split('=')[0], x])); j[kv.split('=')[0]] = kv; this.cookie = Object.values(j).join('; '); } }
  // raw: send exactly what is given, with no token added
  async raw(method, p, { form, json, multipart, headers = {} } = {}) {
    const h = { Cookie: this.cookie, ...headers }; let body;
    if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    else if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    else if (multipart) body = multipart;
    const res = await fetch(this.base + p, { method, headers: h, body, redirect: 'manual' });
    this.jar(res);
    const text = await res.text();
    const meta = text.match(/<meta name="csrf-token" content="([^"]+)"/); if (meta) this.csrf = meta[1];
    return { status: res.status, loc: res.headers.get('location'), text, headers: res.headers };
  }
  async get(p) { return this.raw('GET', p); }
  async ensureToken() { if (!this.csrf) { await this.get('/login'); if (!this.csrf) await this.get('/profile'); } return this.csrf; }
  async post(p, form = {}) { await this.ensureToken(); const r = await this.raw('POST', p, { form: { _csrf: this.csrf, ...form } }); if (r.headers.getSetCookie().length) this.csrf = null; return r; }
  async login(u, pw) { const r = await this.post('/login', { username: u, password: pw }); return r; }
}

function start(port, env) {
  const log = [];
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SEED_DEMO: 'true', SLA_SWEEP_S: '3600', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => log.push(String(d))); child.stderr.on('data', (d) => log.push(String(d)));
  return { child, text: () => log.join(''), exited: new Promise((r) => child.on('exit', r)) };
}
async function healthy(port, srv) { for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true; } catch { /* wait */ } if (srv.child.exitCode !== null) return false; await sleep(500); } return false; }
const rowFor = (html, username) => (html.match(new RegExp(`<tr[^>]*>(?:(?!</tr>)[\\s\\S])*<td>${username}</td>[\\s\\S]*?</tr>`)) || [''])[0];
const idOf = (html, username) => (rowFor(html, username).match(/\/users\/(\d+)\/edit/) || [])[1];
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

async function main() {
  const port = 18230; const base = `http://127.0.0.1:${port}`;
  const env = { LOCKOUT_AFTER: '3', LOCKOUT_MINUTES: '1', RATE_LIMIT_LOGIN_FAILURES: '200', SESSION_SECRET: `security-check-${tag}` };
  const app = start(port, env);
  const knex = knexLib({ client: 'pg', connection: dbConfig(process.env), pool: { min: 0, max: 2 } });
  try {
    if (!(await healthy(port, app))) throw new Error(`NovaDesk did not start: ${app.text().slice(-400)}`);
    const persisting = await run(base, knex, app);
    // Sessions live in the database, so a restart does not sign anyone out.
    section = 'sessions';
    app.child.kill(); await app.exited;
    const again = start(port, env);
    try {
      if (!(await healthy(port, again))) throw new Error(`NovaDesk did not restart: ${again.text().slice(-300)}`);
      const afterRestart = new Browser(base); afterRestart.cookie = persisting.cookie;
      check('a restart of NovaDesk does not sign anyone out', (await afterRestart.get('/incidents')).status === 200);
    } finally { again.child.kill(); await again.exited; }
  } finally { await knex.destroy(); app.child.kill(); await app.exited; }
  await secureCookie();
}

async function run(base, knex, app) {
  const admin = new Browser(base); await admin.login('admin', 'admin123');
  const jane = new Browser(base); await jane.login('jdoe', 'agent123');
  const maria = new Browser(base); await maria.login('mchen', 'user123');

  section = 'forged requests';
  const before = (await jane.get('/incidents')).text.match(/INC\d{7}/g) || [];
  const noToken = await jane.raw('POST', '/incidents', { form: { short_description: `Forged ${tag}`, category: 'other', impact: '3', urgency: '3' } });
  check('a form post without the token is refused (403, and a readable page) and creates nothing', noToken.status === 403 && /reload the page/i.test(noToken.text) && Number((await knex.raw(`SELECT count(*) AS c FROM incidents WHERE short_description LIKE ?`, [`Forged%${tag}`])).rows[0].c) === 0);
  await jane.ensureToken();
  check('with a wrong token: refused', (await jane.raw('POST', '/incidents', { form: { _csrf: 'not-the-token', short_description: `Forged2 ${tag}`, category: 'other', impact: '3', urgency: '3' } })).status === 403);
  await maria.ensureToken();
  check("with someone else's token: refused", (await jane.raw('POST', '/incidents', { form: { _csrf: maria.csrf, short_description: `Forged3 ${tag}`, category: 'other', impact: '3', urgency: '3' } })).status === 403);
  check('with the token in the address instead of the body: refused', (await jane.raw('POST', `/incidents?_csrf=${jane.csrf}`, { form: { short_description: `Forged4 ${tag}`, category: 'other', impact: '3', urgency: '3' } })).status === 403);
  const good = await jane.raw('POST', '/incidents', { form: { _csrf: jane.csrf, short_description: `Real ${tag}`, category: 'other', impact: '3', urgency: '3' } });
  check('with the right token: accepted', good.status === 302 && /\/incidents\/\d+/.test(good.loc));
  check('a fetch-style JSON change needs the header: refused without, accepted with', (await jane.raw('POST', `/profile/theme`, { json: { theme: 'light' } })).status === 403 && (await jane.raw('POST', '/profile/theme', { json: { theme: 'light' }, headers: { 'X-CSRF-Token': jane.csrf } })).status === 200);
  check('the refusal to a script is JSON', ((await jane.raw('POST', '/profile/theme', { json: { theme: 'light' } })).headers.get('content-type') || '').includes('json'));
  check('reading is never blocked', (await jane.raw('GET', '/incidents')).status === 200);
  check('signing in needs a token too (a forged sign-in is refused)', (await new Browser(base).raw('POST', '/login', { form: { username: 'jdoe', password: 'agent123' } })).status === 403);
  check('so does signing out', (await jane.raw('POST', '/logout', { form: {} })).status === 403 && (await jane.get('/incidents')).status === 200);
  const token = (await jane.get('/incidents')).text.match(/name="_csrf" value="([^"]+)"/);
  check('every page with a form carries a token', Boolean(token) && token[1] === jane.csrf);
  check('every signed-in page carries the meta tag and the script', /<meta name="csrf-token" content="[^"]+"><script src="\/js\/csrf\.js"><\/script><\/head>/.test((await jane.get('/incidents')).text));
  check('the script that adds the header is served', (await fetch(`${base}/js/csrf.js`)).status === 200);
  const key = await (async () => { const r = await jane.post('/profile/api-keys', { name: `sec ${tag}`, scope: 'write', expires: '30' }); return r.text.match(/id="newApiKey"[^>]*>(ndk_[A-Za-z0-9_-]{40})</)[1]; })();
  const viaApi = await fetch(`${base}/api/v1/incidents`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ short_description: `Via API ${tag}` }) });
  check('the API (bearer keys) does not need the browser token', viaApi.status === 201);
  const adminKeyCheck = await fetch(`${base}/api/v1/incidents`, { method: 'POST', headers: { Cookie: jane.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ short_description: 'cookie only' }) });
  check('...and a browser session is still not an API credential', adminKeyCheck.status === 401);

  section = 'uploads';
  const incId = (good.loc.match(/\/incidents\/(\d+)/) || [])[1];
  const dir = path.join(ROOT, 'data', 'uploads', 'incident'); const countFiles = () => (fs.existsSync(dir) ? fs.readdirSync(dir).length : 0);
  const filesBefore = countFiles();
  const fd = new FormData(); fd.append('file', new Blob(['forged upload'], { type: 'text/plain' }), 'forged.txt');
  const forged = await jane.raw('POST', `/incidents/${incId}/attachments`, { multipart: fd });
  await sleep(300);
  check('an upload without the token is refused and leaves nothing on disk', forged.status === 403 && countFiles() === filesBefore && !(await jane.get(`/incidents/${incId}`)).text.includes('forged.txt'));
  const fd2 = new FormData(); fd2.append('_csrf', jane.csrf); fd2.append('file', new Blob(['real upload'], { type: 'text/plain' }), 'real.txt');
  const realUp = await jane.raw('POST', `/incidents/${incId}/attachments`, { multipart: fd2 });
  check('with the token (the first field) it is accepted', realUp.status === 302 && (await jane.get(`/incidents/${incId}`)).text.includes('real.txt'));
  const fd3 = new FormData(); fd3.append('_csrf', maria.csrf); fd3.append('file', new Blob(['x'], { type: 'text/plain' }), 'otherscookie.txt');
  check("with someone else's token: refused", (await jane.raw('POST', `/incidents/${incId}/attachments`, { multipart: fd3 })).status === 403);
  const before2 = countFiles();
  const fd5 = new FormData(); fd5.append('_csrf', maria.csrf); fd5.append('file', new Blob(['not allowed'], { type: 'text/plain' }), 'denied.txt');
  const denied = await maria.raw('POST', `/incidents/${incId}/attachments`, { multipart: fd5 });
  await sleep(300);
  check("an upload to someone else's record is refused and its file is removed (it used to be left behind)", [403, 404].includes(denied.status) && countFiles() === before2, `${denied.status} files ${before2}->${countFiles()}`);

  section = 'headers';
  const h = (await jane.get('/incidents')).headers;
  check('browser hardening headers', h.get('x-content-type-options') === 'nosniff' && h.get('x-frame-options') === 'SAMEORIGIN' && h.get('referrer-policy') === 'strict-origin-when-cross-origin' && !h.get('x-powered-by'));
  check('Permissions-Policy, Cross-Origin-Opener-Policy and X-Permitted-Cross-Domain-Policies', /camera=\(\)/.test(h.get('permissions-policy') || '') && h.get('cross-origin-opener-policy') === 'same-origin' && h.get('x-permitted-cross-domain-policies') === 'none');
  const loginCookie = (await new Browser(base).raw('GET', '/login')).headers.getSetCookie()[0] || '';
  check('the session cookie is HttpOnly and SameSite=Lax', /HttpOnly/i.test(loginCookie) && /SameSite=Lax/i.test(loginCookie), loginCookie.replace(/=[^;]*/, '=…'));
  const sess = new Browser(base); await sess.get('/login'); const first = sess.cookie; await sess.login('mchen', 'user123');
  check('signing in starts a fresh session (the session id changes)', first && sess.cookie && first !== sess.cookie);

  section = 'password rules';
  const reg = async (over) => new Browser(base).post('/register', { full_name: 'Pat Example', username: `pat${tag}${Math.random().toString(36).slice(2, 4)}`, email: `pat.${tag}@corp.local`, password: 'Orbit-Lantern-42x', confirm_password: 'Orbit-Lantern-42x', ...over });
  for (const [pw, pattern] of [['short1', /at least 10/], ['password1234', /first ones attackers try/], ['aaaaaaaaaaaa', /repeated/], ['Pat-Example-Rocks-1', /cannot contain your name/], ['x'.repeat(5) + 'Aa1-'.repeat(18), /too long/]]) {
    const r = await reg({ password: pw, confirm_password: pw }); check(`sign-up refuses "${pw.slice(0, 20)}${pw.length > 20 ? '...' : ''}"`, r.status === 200 && pattern.test(r.text), `${r.status}`);
  }
  const okReg = await reg({}); check('sign-up accepts a good password and signs the person in', okReg.status === 302 && okReg.loc === '/');
  const noPassword = await admin.post('/users', { username: `nopw${tag}`, full_name: 'No Password', email: 'np@corp.local', role: 'user', password: '' });
  check('an administrator cannot create an account without a password (there is no default one any more)', noPassword.status === 200 && /at least 10/.test(noPassword.text) && !/changeme123/.test(noPassword.text));
  const weakAdmin = await admin.post('/users', { username: `weak${tag}`, full_name: 'Weak One', email: 'w@corp.local', role: 'user', password: 'letmein123' });
  check('...nor with a weak one', weakAdmin.status === 200 && /first ones attackers try/.test(weakAdmin.text));
  const lockUser = `lock${tag}`;
  const made = await admin.post('/users', { username: lockUser, full_name: 'Lock Test', email: `lock.${tag}@corp.local`, role: 'agent', password: 'Cobalt-Meadow-Drift-8' });
  check('a strong password is accepted for a new account', made.status === 302);
  const lockId = idOf((await admin.get('/users')).text, lockUser);
  const reset = await admin.post(`/users/${lockId}/update`, { username: lockUser, full_name: 'Lock Test', email: `lock.${tag}@corp.local`, role: 'agent', active: 'on', password: 'qwertyuiop' });
  check('an administrator resetting a password must meet the rules too', reset.status === 200 && /first ones attackers try/.test(reset.text));
  const pw1 = await maria.post('/profile', { full_name: 'Maria Chen', email: 'maria.chen@corp.local', department: 'Finance', current_password: 'user123', new_password: 'maria-chen-1', confirm_password: 'maria-chen-1' });
  check('changing your own password to a weak or personal one is refused, and the old one still works', /too|cannot contain|at least|first ones/.test(pw1.text) && (await new Browser(base).login('mchen', 'user123')).status === 302);

  section = 'timing';
  const time = async (u) => { const t0 = process.hrtime.bigint(); await new Browser(base).login(u, 'definitely-wrong-password'); return Number(process.hrtime.bigint() - t0) / 1e6; };
  const unknown = []; const known = [];
  for (let i = 0; i < 4; i++) { unknown.push(await time(`nobody-${tag}-${i}`)); known.push(await time(i % 2 ? 'rpatel' : 'bsmith')); }   // two wrong passwords per real account: under the lock limit
  check(`an unknown account takes about as long to refuse as a wrong password (median ${Math.round(median(unknown))} ms against ${Math.round(median(known))} ms)`, median(unknown) > median(known) * 0.5, `${median(unknown)} vs ${median(known)}`);

  section = 'lockout';
  const victim = new Browser(base);
  const r1 = await victim.login(lockUser, 'wrong-password-1'); const r2 = await victim.login(lockUser, 'wrong-password-2');
  check('wrong passwords are refused with the same message as always', r1.status === 401 && r2.status === 401 && /Invalid username or password/.test(r1.text));
  const r3 = await victim.login(lockUser, 'wrong-password-3');
  const rightButLocked = await new Browser(base).login(lockUser, 'Cobalt-Meadow-Drift-8');
  check('after 3 wrong passwords the account is locked: even the right password is refused, with the same message', r3.status === 401 && rightButLocked.status === 401 && /Invalid username or password/.test(rightButLocked.text) && !/locked/i.test(rightButLocked.text));
  check('other accounts are not affected', (await new Browser(base).login('rpatel', 'user123')).status === 302);
  const editPage = (await admin.get(`/users/${lockId}/edit`)).text;
  check('an administrator sees the lock and can lift it', /Locked after repeated wrong passwords/.test(editPage) && /users\/\d+\/unlock/.test(editPage));
  check('lifting it works at once', (await admin.post(`/users/${lockId}/unlock`)).status === 302 && (await new Browser(base).login(lockUser, 'Cobalt-Meadow-Drift-8')).status === 302);
  await new Browser(base).login(lockUser, 'wrong-password-a'); await new Browser(base).login(lockUser, 'wrong-password-b');
  check('a good sign-in resets the count (two more wrong ones do not lock)', (await new Browser(base).login(lockUser, 'Cobalt-Meadow-Drift-8')).status === 302 && (await new Browser(base).login(lockUser, 'wrong-password-c')).status === 401 && (await new Browser(base).login(lockUser, 'Cobalt-Meadow-Drift-8')).status === 302);
  for (let i = 0; i < 3; i++) await new Browser(base).login(lockUser, `wrong-again-${i}`);
  await knex.raw(`UPDATE users SET locked_until = '2000-01-01 00:00:00' WHERE username = ?`, [lockUser]);
  check('a lock ends by itself once its time has passed', (await new Browser(base).login(lockUser, 'Cobalt-Meadow-Drift-8')).status === 302);

  section = 'administrators';
  const adminRow = (await admin.get('/users')).text; const adminId = idOf(adminRow, 'admin');
  const demote = await admin.post(`/users/${adminId}/update`, { username: 'admin', full_name: 'Alex Admin', email: 'admin@corp.local', role: 'agent', active: 'on' });
  const deactivate = await admin.post(`/users/${adminId}/update`, { username: 'admin', full_name: 'Alex Admin', email: 'admin@corp.local', role: 'admin' });
  check('the only active administrator cannot be demoted or switched off (nobody could manage NovaDesk afterwards)', demote.status === 200 && /only active administrator/.test(demote.text) && deactivate.status === 200 && /only active administrator/.test(deactivate.text) && (await admin.get('/users')).status === 200);

  section = 'audit log';
  await new Browser(base).login(`secret-typed-in-username-${tag}`, 'x');
  const audit = (await admin.get('/settings/audit?page=1')).text;
  check('only administrators can read it (and export it)', (await jane.get('/settings/audit')).status === 403 && (await maria.get('/settings/audit/export.csv')).status === 403);
  for (const action of ['login.success', 'login.failed', 'login.locked', 'login.refused', 'user.created', 'user.unlocked', 'user.registered']) check(`${action} is recorded`, audit.includes(`>${action}<`) || (await admin.get(`/settings/audit?action=${action}`)).text.includes(`>${action}<`));
  check('the log says who and what, not just that something happened', /Lock Test|lock\w+/.test(audit) && /account is locked|wrong password|repeated wrong passwords/.test(audit));
  check('what someone typed into the username box for an account that does not exist is never stored', !audit.includes(`secret-typed-in-username-${tag}`) && !(await admin.get(`/settings/audit?who=secret-typed`)).text.includes('secret-typed-in-username'));
  const rows = await knex.raw(`SELECT count(*) AS c FROM audit_log WHERE detail LIKE '%Cobalt%' OR detail LIKE '%wrong-password%' OR detail LIKE '%Orbit-Lantern%'`);
  check('no password ever appears in the log', Number(rows.rows[0].c) === 0);
  const csv = await admin.get('/settings/audit/export.csv');
  check('the log can be exported as CSV', csv.status === 200 && /Time \(UTC\),Action,By/.test(csv.text) && csv.text.includes('login.locked') && (csv.headers.get('content-type') || '').includes('csv'));
  check('and filtered by action and by person', (await admin.get('/settings/audit?action=locked')).text.includes('login.locked') && !(await admin.get('/settings/audit?action=locked')).text.includes('>login.success<'));
  const k2 = await jane.post('/profile/api-keys', { name: `audit ${tag}`, scope: 'read', expires: '30' });
  const hook = await admin.post('/settings/sla/policies', { hours_1: '4', clock_1: 'calendar', warn_1: '75', hours_2: '8', clock_2: 'calendar', warn_2: '75', hours_3: '24', clock_3: 'calendar', warn_3: '75', hours_4: '72', clock_4: 'calendar', warn_4: '75' });
  const audit2 = (await admin.get('/settings/audit')).text;
  check('API keys and SLA settings changes are recorded as well', k2.status === 200 && hook.status === 302 && audit2.includes('>apikey.created<') && audit2.includes('>sla.settings_changed<'));

  section = 'sessions';
  {
  const GOOD = 'Cobalt-Meadow-Drift-8', NEXT = 'Violet-Anchor-Pine-91';
  const who = `sess${tag}`;
  const created = await admin.post('/users', { username: who, full_name: 'Sess Test', email: `sess.${tag}@corp.local`, role: 'agent', password: GOOD });
  const sid = idOf((await admin.get('/users')).text, who);
  const signIn = async (pw = GOOD, ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15') => { const b = new Browser(base); b.ua = ua; const orig = b.raw.bind(b); b.raw = (m, p, o = {}) => orig(m, p, { ...o, headers: { 'User-Agent': b.ua, ...(o.headers || {}) } }); const r = await b.login(who, pw); return { b, r }; };
  const up = async (b) => (await b.get('/incidents')).status === 200;
  check('the person for these checks exists', created.status === 302 && sid, `${created.status} ${sid}`);

  const a = (await signIn()).b, bb = (await signIn(GOOD, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36')).b;
  const listing = (await a.get('/profile/sessions')).text;
  check('the sessions page lists both devices, with what and where', (listing.match(/<tr/g) || []).length === 3 && /Safari on macOS/.test(listing) && /Chrome on Windows/.test(listing) && /127\.0\.0\.1|::1/.test(listing));
  check('and marks the one being used', /This device/.test(listing) && (listing.match(/This device/g) || []).length === 1);
  check('the page never shows a session id or cookie value', !listing.includes(decodeURIComponent(a.cookie.split('=')[1] || '').slice(2, 20)));
  const row = (listing.match(/action="\/profile\/sessions\/([0-9a-f]{20})\/revoke"/) || [])[1];
  check('ending the other device signs it out at once and leaves this one', row && (await a.post(`/profile/sessions/${row}/revoke`)).status === 302 && /Signed out of that device/.test((await a.get('/profile/sessions?done=one')).text) && !(await up(bb)) && await up(a));
  check('an ended session cannot be used again, even by sending its cookie back', (await bb.get('/incidents')).status === 302);

  // Nobody can end someone else's session by guessing or replaying an id.
  const mariaRow = (((await maria.get('/profile/sessions')).text).match(/\/profile\/sessions\/([0-9a-f]{20})\/revoke/) || [])[1];
  const other = await signIn(); const otherListing = (await other.b.get('/profile/sessions')).text;
  const otherId = (otherListing.match(/\/profile\/sessions\/([0-9a-f]{20})\/revoke/) || [])[1];
  const sneaky = await jane.post(`/profile/sessions/${otherId || 'ffffffffffffffffffff'}/revoke`);
  check("one person cannot end another person's session", sneaky.status === 302 && /done=missing/.test(sneaky.loc || '') && /not found/i.test((await jane.get(sneaky.loc)).text) && await up(other.b) && await up(maria), `${sneaky.status} ${mariaRow}`);

  const c = (await signIn()).b, d = (await signIn()).b;
  const sign = await a.post('/profile/sessions/revoke-others');
  check('"Sign out of all other devices" ends every other session and keeps this one', sign.status === 302 && /Signed out of \d+ other device/.test((await a.get(sign.loc)).text) && !(await up(c)) && !(await up(d)) && await up(a));

  const e = (await signIn()).b;
  const change = await a.post('/profile', { full_name: 'Sess Test', email: `sess.${tag}@corp.local`, department: '', current_password: GOOD, new_password: NEXT, confirm_password: NEXT });
  check('changing your own password signs you out everywhere else (and not on this device)', change.status === 200 && /Profile updated/.test(change.text) && !(await up(e)) && await up(a));
  const afterChange = (await admin.get('/settings/audit?action=password.changed')).text;
  check('and the audit log says how many sessions that ended', /other session/.test(afterChange));

  const f = (await signIn(NEXT)).b, g = (await signIn(NEXT)).b;
  const adminEdit = (await admin.get(`/users/${sid}/edit`)).text;
  check('an administrator sees how many sessions the person has, and a Sign out everywhere button', /3 sessions/.test(adminEdit) && /sign-out-everywhere/.test(adminEdit), (adminEdit.match(/\d+ sessions?/) || [])[0]);
  const out = await admin.post(`/users/${sid}/sign-out-everywhere`);
  check('Sign out everywhere ends all of them', out.status === 302 && !(await up(a)) && !(await up(f)) && !(await up(g)));

  const s1 = (await signIn(NEXT)).b, s2 = (await signIn(NEXT)).b;
  const reset = await admin.post(`/users/${sid}/update`, { username: who, full_name: 'Sess Test', email: `sess.${tag}@corp.local`, role: 'agent', active: 'on', password: GOOD });
  check('an administrator setting a new password ends the sessions that were open', reset.status === 302 && !(await up(s1)) && !(await up(s2)));

  const j = (await signIn()).b;
  const off = await admin.post(`/users/${sid}/update`, { username: who, full_name: 'Sess Test', email: `sess.${tag}@corp.local`, role: 'agent', department: '' });
  const left = Number((await knex.raw('SELECT count(*) AS c FROM sessions WHERE user_id = ?', [sid])).rows[0].c);
  check('switching an account off ends its sessions (they are gone, not just refused)', off.status === 302 && !(await up(j)) && left === 0, `left ${left}`);
  check('and the audit log records the sign-outs', /session\.revoked_all/.test((await admin.get('/settings/audit?action=session')).text));

  check('expired sessions are not kept: the clean-up removes them', await (async () => {
    await knex.raw(`INSERT INTO sessions (sid, user_id, data, created_at, last_seen_at, expires_at) VALUES (?, NULL, '{}', '2020-01-01 00:00:00', '2020-01-01 00:00:00', '2020-01-02 00:00:00')`, [`old-${tag}`]);
    const sessions = require('../src/sessionStore'); const gone = await sessions.cleanup();
    return gone >= 1 && Number((await knex.raw('SELECT count(*) AS c FROM sessions WHERE sid = ?', [`old-${tag}`])).rows[0].c) === 0;
  })());

  }

  section = 'content security policy';
  {
    const pages = ['/login', '/', '/incidents', '/incidents/board', '/changes', '/changes/board', '/problems', '/cmdb', '/reports', '/kb', '/requests', '/profile/mfa', '/profile/sessions'];
    const bad = []; const nonces = new Set(); let inlineSeen = 0; let policyOk = true;
    for (const pth of pages) {
      const r = pth === '/login' ? await new Browser(base).get(pth) : await admin.get(pth);
      if (r.status !== 200) { bad.push(`${pth} ${r.status}`); continue; }
      const header = r.headers.get('content-security-policy') || '';
      const nonce = (header.match(/'nonce-([^']+)'/) || [])[1];
      if (!nonce) { bad.push(`${pth} has no nonce in its policy`); continue; }
      nonces.add(nonce);
      const scriptSrc = (header.match(/script-src ([^;]*)/) || [])[1] || '';
      if (/unsafe-inline|unsafe-eval|\*/.test(scriptSrc) || !/script-src-attr 'none'/.test(header)) policyOk = false;
      for (const m of r.text.matchAll(/<script\b([^>]*)>/g)) {
        if (/\bsrc=/.test(m[1])) { if (!/src="(https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)\/|\/js\/)/.test(m[1])) bad.push(`${pth} loads ${m[1]}`); continue; }
        inlineSeen++;
        if (!m[1].includes(`nonce="${nonce}"`)) bad.push(`${pth} has an inline script without this page's nonce`);
      }
      if (/\son(click|submit|change|load|error)\s*=/i.test(r.text)) bad.push(`${pth} has an inline handler`);
    }
    check('every page sends a policy, and each of its inline scripts carries that page\'s own nonce', bad.length === 0 && inlineSeen >= 8, bad.join('; ') + ` (${inlineSeen} inline scripts)`);
    check('the nonce is different on every page load', nonces.size === pages.length, `${nonces.size} of ${pages.length}`);
    check('scripts may not be inline, eval\'d or from anywhere else; inline handlers are off', policyOk);
    const injected = await jane.post('/incidents', { short_description: `<script>alert(1)</script> csp ${tag}`, description: '<img src=x onerror=alert(1)>', category: 'other', impact: '3', urgency: '3' });
    const page = (await jane.get(injected.loc || '/incidents')).text;
    check('text with a <script> or onerror in a ticket is shown as text, never as markup', injected.status === 302 && !/<script>alert\(1\)/.test(page) && !/<img src=x onerror/.test(page) && /&lt;script&gt;alert\(1\)/.test(page));
    const noToken = await fetch(`${base}/csp-report`, { method: 'POST', headers: { 'Content-Type': 'application/csp-report' }, body: JSON.stringify({ 'csp-report': { 'violated-directive': 'script-src-elem', 'blocked-uri': 'inline', 'document-uri': `${base}/x-${tag}` } }) });
    await sleep(200);
    check('a browser can report a blocked script (no sign-in or token needed), and it reaches the server log', noToken.status === 204 && app.text().includes(`[CSP] script-src-elem blocked inline on ${base}/x-${tag}`));
    check('a report cannot be used to forge log lines', await (async () => {
      await fetch(`${base}/csp-report`, { method: 'POST', headers: { 'Content-Type': 'application/csp-report' }, body: JSON.stringify({ 'csp-report': { 'blocked-uri': `a\n[CSP] forged-${tag}` } }) });
      await sleep(200);
      return !app.text().split('\n').some((l) => l.startsWith(`[CSP] forged-${tag}`));
    })());
    const err = await fetch(`${base}/csp-report`, { method: 'POST', headers: { 'Content-Type': 'application/csp-report' }, body: '{not json' });
    check('a malformed report is refused politely, not with a crash', err.status >= 400 && err.status < 500);
  }

  // The browser kept for the restart check.
  const keep = new Browser(base); await keep.login('jdoe', 'agent123');
  return keep;
}

// The Secure flag: a copy behind a proxy that says the request came in over https.
async function secureCookie() {
  section = 'secure cookie';
  const port = 18233; const base = `http://127.0.0.1:${port}`;
  const app = start(port, { TRUST_PROXY: '1' });
  try {
    if (!(await healthy(port, app))) throw new Error(`NovaDesk did not start: ${app.text().slice(-300)}`);
    const viaHttps = await fetch(`${base}/login`, { headers: { 'X-Forwarded-Proto': 'https' } });
    const viaHttp = await fetch(`${base}/login`);
    const c1 = viaHttps.headers.getSetCookie()[0] || ''; const c2 = viaHttp.headers.getSetCookie()[0] || '';
    check('behind a proxy that reports https, the session cookie is Secure', /;\s*Secure/i.test(c1), c1.replace(/=[^;]*/, '=…'));
    check('over plain http it is not (so sign-in keeps working there)', !/;\s*Secure/i.test(c2), c2.replace(/=[^;]*/, '=…'));
  } finally { app.child.kill(); await app.exited; }
}

main().then(() => { console.log(failed ? `${failed} FAILED` : 'ALL PASS'); process.exit(failed ? 1 : 0); }).catch((e) => { console.error('ABORTED:', e.message); process.exit(2); });
