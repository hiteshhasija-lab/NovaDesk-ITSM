#!/usr/bin/env node
// Single sign-on for each tenant, end to end, against copies of NovaDesk that this script starts itself (ports 18350 to 18352) and a mock
// OpenID Connect provider (scripts/mock-oidc.js, port 18359), on the database named by PGHOST, PGUSER, PGPASSWORD and PGDATABASE:
// who may change the settings, each refusal (including the guard that stops a tenant pointing this server at internal addresses),
// the client secret kept encrypted and never shown, the connection test, a real sign-in through the provider for a tenant, that the
// tenant's redirect address is its own host name, that another tenant has none of it (or its own, separately), who may be made an
// account, switching it off, LOCAL_LOGIN=false only where SSO exists, and the audit log. Needs the demonstration users.
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
const IDP_PORT = 18359; const IDP = `http://127.0.0.1:${IDP_PORT}`;

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


function start(port, env, script = 'src/server.js', args = []) {
  const log = [];
  const child = spawn(process.execPath, [script, ...args], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SEED_DEMO: 'true', SLA_SWEEP_S: '3600', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => log.push(String(d))); child.stderr.on('data', (d) => log.push(String(d)));
  return { child, text: () => log.join(''), exited: new Promise((r) => child.on('exit', r)) };
}
async function healthy(port, srv) { for (let i = 0; i < 60; i++) { try { if ((await new Browser(port, 'x.test').get('/health')).status === 200) return true; } catch { /* wait */ } if (srv.child.exitCode !== null) return false; await sleep(500); } return false; }
const idpCall = (p, body) => fetch(IDP + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());

async function main() {
  const knex = knexLib({ client: 'pg', connection: dbConfig(process.env), pool: { min: 0, max: 3 } });
  const apps = [];
  const boot = async (port, env, script, args) => { const a = start(port, env, script, args); apps.push(a); if (script) { await sleep(500); return a; } if (!(await healthy(port, a))) throw new Error(`NovaDesk on ${port} did not start: ${a.text().slice(-400)}`); return a; };
  try {
    apps.push(start(IDP_PORT, {}, 'scripts/mock-oidc.js', [String(IDP_PORT)])); await sleep(800);
    await boot(18350, { SESSION_SECRET: `sso-s1-${tag}`, SSO_ALLOW_PRIVATE: 'true' });
    await boot(18351, { SESSION_SECRET: `sso-s1-${tag}` });                       // strict: private addresses are refused; same secret, same database
    await boot(18352, { SESSION_SECRET: `sso-s1-${tag}`, LOCAL_LOGIN: 'false', OIDC_ISSUER: IDP, OIDC_CLIENT_ID: 'novadesk-test', OIDC_CLIENT_SECRET: 'test-secret', PUBLIC_URL: 'https://help.corp.test', OIDC_AUTO_CREATE: 'true', OIDC_ALLOWED_DOMAINS: 'corp.local', OIDC_BUTTON_LABEL: 'Sign in with Server SSO' });
    await run(knex, apps);
  } finally { await knex.destroy(); for (const a of apps) a.child.kill(); await Promise.all(apps.map((a) => a.exited)); }
}

async function run(knex, apps) {
  const tenants = require('../src/tenants');
  const { encryptSecret } = require('../src/mfaCrypto');
  const q = async (sql, params = []) => (await knex.raw(sql, params)).rows;
  const one = async (sql, params = []) => (await q(sql, params))[0];
  const count = async (sql, params = []) => Number((await one(sql, params)).c);
  const OPEN = 18350; const STRICT = 18351; const LOCKED = 18352;
  const HOST_B = `b-${tag}.sso.test`; const HOST_C = `c-${tag}.sso.test`; const HOST_A = 'help.corp.test';
  const PW = 'Quartz-Meadow-71b';
  const tb = await tenants.createTenant({ slug: `sso-b-${tag}`, name: `SSO B ${tag}`, hosts: [HOST_B] });
  const tc = await tenants.createTenant({ slug: `sso-c-${tag}`, name: `SSO C ${tag}`, hosts: [HOST_C] });
  await tenants.createAdmin(tb.id, { username: 'bossb', password: PW, fullName: 'Bea Boss', email: `bea${tag}@corp.local` });
  await tenants.createAdmin(tc.id, { username: 'bossc', password: PW, fullName: 'Cy Chief', email: `cy${tag}@corp.local` });
  await sleep(5500);   // a running server learns of new tenants within five seconds
  const A = new Browser(OPEN, HOST_A); const B = new Browser(OPEN, HOST_B); const C = new Browser(OPEN, HOST_C);
  await A.login('admin', 'admin123'); await B.login('bossb', PW); await C.login('bossc', PW);
  const form = (over = {}) => ({ enabled: 'on', issuer: IDP, client_id: 'novadesk-test', client_secret: 'test-secret', button_label: `Sign in with B ${tag}`, scopes: 'openid email profile', auto_create: 'on', default_role: 'user', allowed_domains: 'corp.local', ...over });
  const row = (tid) => one('SELECT * FROM sso_settings WHERE tenant_id = ?', [tid]);
  const saveAs = (b, over, drop = []) => { const f = form(over); for (const k of drop) delete f[k]; return b.post('/settings/sso', f); };
  const signIn = async (port, host, identity) => {
    await idpCall('/__next', identity);
    const person = new Browser(port, host);
    const start = await person.get('/auth/oidc/start');
    if (start.status !== 302 || !(start.loc || '').startsWith(IDP)) return { person, start };
    const auth = await fetch(start.loc, { redirect: 'manual' });
    const back = new URL(auth.headers.get('location'));
    const cb = await person.get(back.pathname + back.search);
    return { person, start, cb };
  };

  // ------------------------------------------------------------------------------------------------------ before anything is set
  section = 'before it is set';
  check('no tenant has single sign-on: the greyed-out button shows and the start address is 404', (await Promise.all([[OPEN, HOST_A], [OPEN, HOST_B], [OPEN, HOST_C]].map(async ([p, h]) => { const b = new Browser(p, h); return (await b.get('/login')).text.includes('id="ssoPlaceholder"') && (await b.get('/auth/oidc/start')).status === 404; }))).every(Boolean));
  check('every tenant has a settings row, switched off', (await q('SELECT enabled FROM sso_settings WHERE tenant_id IN (1, ?, ?)', [tb.id, tc.id])).length === 3 && (await q('SELECT enabled FROM sso_settings WHERE tenant_id IN (1, ?, ?)', [tb.id, tc.id])).every((r) => r.enabled === 0));
  const pageB = await B.get('/settings/sso');
  check('an administrator sees the page, with the redirect address of its own host name', pageB.status === 200 && pageB.text.includes(`http://${HOST_B}/auth/oidc/callback`) && !pageB.text.includes(HOST_A));
  check('and so does the default tenant\'s, with its own', (await A.get('/settings/sso')).text.includes(`http://${HOST_A}/auth/oidc/callback`));
  const agent = new Browser(OPEN, HOST_A); await agent.login('jdoe', 'agent123');
  const before = JSON.stringify(await row(tb.id));
  check('an agent cannot open or change it (403), nor can a signed-out visitor', (await agent.get('/settings/sso')).status === 403 && (await agent.post('/settings/sso', form())).status === 403 && (await new Browser(OPEN, HOST_B).get('/settings/sso')).status === 302 && JSON.stringify(await row(tb.id)) === before);
  check('a change without the page token is refused', (await B.raw('POST', '/settings/sso', { form: form() })).status === 403 && JSON.stringify(await row(tb.id)) === before);

  // ------------------------------------------------------------------------------------------------------ refusals
  section = 'refusals';
  const refuse = async (b, over, words, label, drop) => { const r = await saveAs(b, over, drop); return check(label, r.status === 400 && words.every((w) => r.text.includes(w)) && JSON.stringify(await row(tb.id)) === before, `${r.status}`); };
  await refuse(B, { issuer: '' }, ['issuer address'], 'switching it on without an issuer is refused');
  await refuse(B, { client_id: '' }, ['client ID'], 'without a client ID');
  await refuse(B, { client_secret: '' }, ['client secret'], 'without a client secret (none saved yet)');
  await refuse(B, { default_role: 'admin' }, ['never administrators'], 'a new person as administrator is refused');
  await refuse(B, { scopes: 'email profile' }, ['openid'], 'scopes without openid');
  await refuse(B, { allowed_domains: 'not a domain' }, ['not an email domain'], 'a bad email domain');
  await refuse(B, { issuer: 'https://user:pw@idp.example.com' }, ['user name or password'], 'an address with a password in it');
  const sr = new Browser(STRICT, HOST_B); await sr.login('bossb', PW);
  const refuseStrict = async (issuer, words, label) => { const r = await sr.post('/settings/sso', form({ issuer })); return check(label, r.status === 400 && words.some((w) => r.text.includes(w)) && JSON.stringify(await row(tb.id)) === before, `${r.status}`); };
  await refuseStrict(`http://${IDP.slice(7)}`, ['https://'], 'a plain http address is refused');
  await refuseStrict('https://127.0.0.1', ['private, local or reserved'], 'an address that is this machine (127.0.0.1) is refused');
  await refuseStrict('https://localhost', ['private, local or reserved'], 'localhost is refused');
  await refuseStrict('https://169.254.169.254', ['private, local or reserved'], 'the cloud metadata address is refused');
  await refuseStrict('https://10.0.0.5', ['private, local or reserved'], 'a private network address is refused');
  await refuseStrict('https://[::1]', ['private, local or reserved'], 'IPv6 loopback is refused');
  await refuseStrict('https://nonexistent-host-for-sso-check.invalid', ['could not be looked up', 'no address'], 'a name that does not exist is refused');
  // a row that is already in the database (put there by hand) is held to the same rule when it is used
  await q("UPDATE sso_settings SET enabled = 1, issuer = ?, client_id = 'x', client_secret_enc = ?, auto_create = 1 WHERE tenant_id = ?", [IDP, encryptSecret('test-secret', { SESSION_SECRET: `sso-s1-${tag}` }), tc.id]);
  await sleep(5500);
  const strictStart = await new Browser(STRICT, HOST_C).get('/auth/oidc/start');
  check('on a strict server, settings that point inside the network are refused when used, with a plain message and nothing contacted', strictStart.status === 401 || strictStart.status === 502, `${strictStart.status}`);
  check('(and the message does not say what the address was)', !strictStart.text.includes('127.0.0.1'));
  await q('UPDATE sso_settings SET enabled = 0, issuer = NULL, client_id = NULL, client_secret_enc = NULL WHERE tenant_id = ?', [tc.id]);

  // ------------------------------------------------------------------------------------------------------ saving
  section = 'saving';
  check('a tenant saves its provider', (await saveAs(B, {})).status === 302);
  const r1 = await row(tb.id);
  check('switched on, with the values it was given', r1.enabled === 1 && r1.issuer === IDP && r1.client_id === 'novadesk-test' && r1.allowed_domains === 'corp.local' && r1.auto_create === 1 && r1.button_label === `Sign in with B ${tag}`);
  check('the client secret is stored encrypted, and is nowhere in the clear', /^v1:/.test(r1.client_secret_enc) && !JSON.stringify(r1).includes('test-secret'));
  const shown = await B.get('/settings/sso');
  check('the page never shows the secret, only that one is saved', !shown.text.includes('test-secret') && shown.text.includes('saved; type a new one') && shown.text.includes(`value="${IDP}"`));
  const secretBefore = r1.client_secret_enc;
  await saveAs(B, { button_label: `B button ${tag}` }, ['client_secret']);
  check('saving again without a secret keeps the secret', (await row(tb.id)).client_secret_enc === secretBefore && (await row(tb.id)).button_label === `B button ${tag}`);
  await saveAs(B, { button_label: `B button ${tag}`, client_secret: 'another-secret' });
  check('typing a new one replaces it', (await row(tb.id)).client_secret_enc !== secretBefore);
  await saveAs(B, { button_label: `B button ${tag}`, client_secret: 'test-secret' });
  check('the default tenant\'s and the other tenant\'s settings were not touched', (await row(1)).enabled === 0 && (await row(tc.id)).enabled === 0 && !(await row(1)).issuer);
  const audit = await q("SELECT detail FROM audit_log WHERE tenant_id = ? AND action = 'sso.settings_changed' ORDER BY id", [tb.id]);
  check('every change is in the tenant\'s audit log, saying what changed and never the secret', audit.length >= 3 && audit.some((a) => /switched on/.test(a.detail)) && audit.some((a) => /client secret replaced/.test(a.detail)) && !audit.some((a) => /test-secret|another-secret/.test(a.detail)));
  check('and not in another tenant\'s', await count("SELECT count(*) AS c FROM audit_log WHERE tenant_id <> ? AND action = 'sso.settings_changed'", [tb.id]) === 0);

  // ------------------------------------------------------------------------------------------------------ the connection test
  section = 'connection test';
  const t1 = await B.post('/settings/sso/test', {});
  check('the test says the provider answered, with what it found', t1.status === 200 && t1.text.includes('The provider answered') && /1 signing key/.test(t1.text));
  await q('UPDATE sso_settings SET issuer = ? WHERE tenant_id = ?', [`http://127.0.0.1:1`, tb.id]); await sleep(5200);
  const t2 = await B.post('/settings/sso/test', {});
  check('and says so plainly when it did not', t2.status === 200 && /could not be reached/.test(t2.text));
  await q('UPDATE sso_settings SET issuer = ? WHERE tenant_id = ?', [IDP, tb.id]); await sleep(5200);
  const t3 = await sr.post('/settings/sso/test', {});
  check('on a strict server the test is held to the same rule: the saved address points inside the network, so it is not contacted', t3.status === 200 && /address is not allowed/.test(t3.text));

  // ------------------------------------------------------------------------------------------------------ signing in
  section = 'signing in';
  const loginB = (await new Browser(OPEN, HOST_B).get('/login')).text;
  check('the tenant\'s sign-in page has its button, and the others still have the greyed-out one', loginB.includes(`B button ${tag}`) && loginB.includes('href="/auth/oidc/start"') && !loginB.includes('ssoPlaceholder') && (await new Browser(OPEN, HOST_A).get('/login')).text.includes('ssoPlaceholder') && (await new Browser(OPEN, HOST_C).get('/login')).text.includes('ssoPlaceholder'));
  const who = `new.person.${tag}@corp.local`;
  const s1 = await signIn(OPEN, HOST_B, { sub: `sub-${tag}`, email: who, email_verified: true, name: 'Nina New' });
  const authUrl = new URL(s1.start.loc);
  check('the provider is sent this tenant\'s own redirect address and the right client', authUrl.searchParams.get('redirect_uri') === `http://${HOST_B}/auth/oidc/callback` && authUrl.searchParams.get('client_id') === 'novadesk-test' && authUrl.searchParams.get('code_challenge_method') === 'S256');
  check('the person is signed in, as a new person of that tenant', s1.cb.status === 302 && (await s1.person.get('/')).text.includes('Nina New'), `${s1.cb && s1.cb.status}`);
  const nina = await one('SELECT id, tenant_id, role FROM users WHERE email = ?', [who]);
  check('made in the tenant that has the setting, as a user, linked to the provider', nina && nina.tenant_id === tb.id && nina.role === 'user' && await count('SELECT count(*) AS c FROM user_identities WHERE tenant_id = ? AND subject = ?', [tb.id, `sub-${tag}`]) === 1);
  check('and nowhere else', await count('SELECT count(*) AS c FROM users WHERE email = ? AND tenant_id <> ?', [who, tb.id]) === 0);
  check('the next time the same person signs in to the same account', (await signIn(OPEN, HOST_B, { sub: `sub-${tag}`, email: who, email_verified: true })).cb.status === 302 && await count('SELECT count(*) AS c FROM users WHERE email = ?', [who]) === 1);
  const outsider = await signIn(OPEN, HOST_B, { sub: `sub-out-${tag}`, email: `x.${tag}@other.com`, email_verified: true });
  check('an email domain that is not allowed is refused', outsider.cb.status === 401 && outsider.cb.text.includes('not allowed') && await count('SELECT count(*) AS c FROM users WHERE email = ?', [`x.${tag}@other.com`]) === 0);
  const unverified = await signIn(OPEN, HOST_B, { sub: `sub-un-${tag}`, email: `un.${tag}@corp.local`, email_verified: false });
  check('an unverified email makes no account', unverified.cb.status === 401 && await count('SELECT count(*) AS c FROM users WHERE email = ?', [`un.${tag}@corp.local`]) === 0);
  const toA = await new Browser(OPEN, HOST_A).get('/auth/oidc/start');
  const toC = await new Browser(OPEN, HOST_C).get('/auth/oidc/start');
  check('another tenant without settings has no start address (404), so this tenant\'s provider cannot be used there', toA.status === 404 && toC.status === 404);
  check('a callback arriving at the wrong tenant does nothing', (await new Browser(OPEN, HOST_A).get('/auth/oidc/callback?code=x&state=y')).status === 404);
  // a second tenant with its own settings against the same provider: the same subject is another person there
  await saveAs(C, { button_label: `C button ${tag}` });
  const s2 = await signIn(OPEN, HOST_C, { sub: `sub-${tag}`, email: who, email_verified: true, name: 'Nina Elsewhere' });
  check('a second tenant uses the same provider with its own settings: the same person is a separate account there', s2.cb.status === 302 && (await one('SELECT tenant_id FROM users WHERE email = ? AND tenant_id = ?', [who, tc.id])) && await count('SELECT count(*) AS c FROM users WHERE email = ?', [who]) === 2 && await count('SELECT count(*) AS c FROM user_identities WHERE subject = ?', [`sub-${tag}`]) === 2);
  check('and each sees only its own people', (await B.get('/users')).text.includes('Nina New') && !(await B.get('/users')).text.includes('Nina Elsewhere') && (await C.get('/users')).text.includes('Nina Elsewhere'));

  // ------------------------------------------------------------------------------------------------------ switching off, LOCAL_LOGIN
  section = 'switching off';
  await saveAs(B, { button_label: `B button ${tag}`, enabled: undefined, client_secret: '' }, ['enabled', 'client_secret']);
  check('switched off: the button goes back to the greyed-out one and the start address is 404', (await new Browser(OPEN, HOST_B).get('/login')).text.includes('ssoPlaceholder') && (await new Browser(OPEN, HOST_B).get('/auth/oidc/start')).status === 404 && (await row(tb.id)).enabled === 0);
  check('what was saved is kept, and people already made still sign in with their password', (await row(tb.id)).issuer === IDP && /^v1:/.test((await row(tb.id)).client_secret_enc) && (await new Browser(OPEN, HOST_B).login('bossb', PW)).status === 302);
  const lockedA = (await new Browser(LOCKED, HOST_A).get('/login')).text; const lockedB = (await new Browser(LOCKED, HOST_B).get('/login')).text;
  check('with LOCAL_LOGIN=false the password form is hidden only where there is single sign-on (the default tenant has the server\'s)', lockedA.includes('Sign in with Server SSO') && !lockedA.includes('name="password"') && lockedB.includes('name="password"'));
  check('and a password sign-in is refused only there', (await new Browser(LOCKED, HOST_A).login('admin', 'admin123')).status === 403 && (await new Browser(LOCKED, HOST_B).login('bossb', PW)).status === 302);
  const sA = await signIn(LOCKED, HOST_A, { sub: `sub-env-${tag}`, email: `env.${tag}@corp.local`, email_verified: true, name: 'Env Person' });
  check('the server\'s own settings still serve the default tenant (redirect address from PUBLIC_URL)', new URL(sA.start.loc).searchParams.get('redirect_uri') === 'https://help.corp.test/auth/oidc/callback' && sA.cb.status === 302 && (await one('SELECT tenant_id FROM users WHERE email = ?', [`env.${tag}@corp.local`])).tenant_id === 1);
  check('and they do not reach another tenant', (await new Browser(LOCKED, HOST_B).get('/auth/oidc/start')).status === 404);
  const adminPageLocked = await (async () => { const a = new Browser(LOCKED, HOST_A); return a.get('/settings/sso'); })();
  check('the page of a signed-out visitor is a redirect', adminPageLocked.status === 302);

  section = 'the log';
  const errors = apps.flatMap((a) => a.text().split('\n')).filter((l) => /error|unhandled|exception|NO_TENANT/i.test(l) && !/test mailbox|ethereal|\[SSO\] (refused|could not|token refused|the provider)|sign-in refused|ECONNREFUSED/i.test(l));
  check('the servers\' logs show no unexpected errors', errors.length === 0, errors.slice(-4).join(' | '));
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASS');
  process.exitCode = failed ? 1 : 0;
}

main().then(() => process.exit(process.exitCode || 0), (e) => { console.error(e); process.exit(1); });
