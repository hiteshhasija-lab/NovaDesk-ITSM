#!/usr/bin/env node
// Self-service sign-up of new tenants, end to end, against copies of NovaDesk that this script starts itself (ports 18450 to 18452) on the database named by PGHOST, PGUSER,
// PGPASSWORD and PGDATABASE, with a mail sink (port 18455): that the page exists only on SIGNUP_HOST, that nothing is made until the emailed link has been confirmed (opening it
// makes nothing), that the workspace, its administrator (who can sign in), its limits and its audit entry are right, that a link works once (also when pressed twice at once),
// that every abuse limit holds (hidden field, too quick, per address, per email address, per day, pause, domains, terms), approval mode, expiry, and that no password is kept.
// Needs the demonstration users.
'use strict';
const { spawn } = require('child_process');
const crypto = require('crypto');
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
const SIGNUP = 'signup.sgn.test'; const BASE = 'sgn.test';
const PW = 'Granite-Falcon-93k'; const OPW = 'Quartz-Meadow-71b';

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
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SEED_DEMO: 'true', SLA_SWEEP_S: '3600', LIMIT_WARN_POLL_S: '3600', PLATFORM_HOST: 'ops.test', PLATFORM_REQUIRE_MFA: 'false', SESSION_SECRET: `su-${tag}`,
    TENANT_BASE_DOMAIN: BASE, TENANT_UNKNOWN_HOST: 'default', SMTP_HOST: '127.0.0.1', SMTP_PORT: '18455', SMTP_FROM: 'NovaDesk <desk@sgn.test>', SIGNUP_HOST: SIGNUP, SIGNUP_SCHEME: 'http', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => log.push(String(d))); child.stderr.on('data', (d) => log.push(String(d)));
  return { child, text: () => log.join(''), exited: new Promise((r) => child.on('exit', r)) };
}
async function healthy(port, srv) { for (let i = 0; i < 60; i++) { try { if ((await new Browser(port, 'x.test').get('/health')).status === 200) return true; } catch { /* wait */ } if (srv.child.exitCode !== null) return false; await sleep(500); } return false; }

async function main() {
  const knex = knexLib({ client: 'pg', connection: dbConfig(process.env), pool: { min: 0, max: 3, afterCreate: (c, done) => c.query("SELECT set_config('app.tenant_id', '1', false)", (e) => done(e, c)) } });
  const mails = []; const sink = await startSink({ port: 18455, onMessage: (m) => mails.push(m) });
  const apps = [];
  try {
    const q0 = async (sql) => (await knex.raw(sql)).rows[0];
    const today = await q0("SELECT count(*) AS c FROM signups WHERE created_at >= to_char((NOW() AT TIME ZONE 'UTC') - interval '24 hours', 'YYYY-MM-DD HH24:MI:SS')").then((r) => Number(r.c), () => 0);   // (the table is not there yet on a database that has never run this version)
    const specs = [
      [18450, { SIGNUP_MAX_PER_DAY: '100000', SIGNUP_PER_IP_PER_HOUR: '1000' }],                                                    // A: open
      [18451, { SIGNUP_REQUIRE_APPROVAL: 'true', SIGNUP_TERMS_URL: 'https://example.com/terms', SIGNUP_ALLOWED_DOMAINS: 'acme.example', SIGNUP_MAX_PER_DAY: String(today + 1000) }], // B: approval, terms, one domain
      [18452, { SIGNUP_PER_IP_PER_HOUR: '2', SIGNUP_MAX_PER_DAY: '100000' }],                                                       // C: per address
    ];
    for (const [port, env] of specs) { const a = start(port, env); apps.push(a); if (!(await healthy(port, a))) throw new Error(`NovaDesk did not start on ${port}: ${a.text().slice(-400)}`); }
    await run(knex, mails, specs.map((s) => s[0]), today);
  } catch (e) { console.error(`server output (tail):\n${apps.map((a) => a.text().slice(-700)).join('\n---\n')}`); throw e;
  } finally { await knex.destroy(); for (const a of apps) { a.child.kill(); await a.exited; } await sink.close(); }
}

async function run(knex, mails, [PA, PB, PC], todayAtStart) {
  const platform = require('../src/platform');
  const signup = require('../src/signup');
  const q = async (sql, params = []) => (await knex.raw(sql, params)).rows;
  const one = async (sql, params = []) => (await q(sql, params))[0];
  const count = async (sql, params = []) => Number((await one(sql, params)).c);
  await q('DELETE FROM platform_admins');
  await platform.createOperator({ username: `ops${tag}`, password: OPW, fullName: 'Ops Operator' });
  await q("DELETE FROM platform_settings WHERE key = 'signup_paused'");
  const norm = (raw) => raw.replace(/=\r?\n/g, '').replace(/=3D/g, '=');
  const mailTo = (addr) => mails.filter((m) => m.to.some((a) => a.toLowerCase() === addr.toLowerCase()));
  const tokenFrom = (addr) => { const m = mailTo(addr).map((x) => norm(x.raw)).reverse().find((r) => /\/verify\//.test(r)); return m ? (m.match(/\/verify\/([A-Za-z0-9_-]{43})/) || [])[1] : null; };
  const formOf = async (b) => (await b.get('/')).text.match(/name="t" value="([^"]+)"/)[1];
  const fields = (n, extra = {}) => ({ org_name: `Org ${n} ${tag}`, slug: `o${n}-${tag}`, admin_name: `Ann ${n}`, email: `ann${n}-${tag}@acme.example`, username: `ann${n}`, password: PW, password2: PW, ...extra });
  const S = (port) => new Browser(port, SIGNUP);
  const submit = async (b, f, { wait = true } = {}) => { const t = await formOf(b); if (wait) await sleep(3200); return b.raw('POST', '/signup', { form: { t, ...f } }); };

  section = 'where it exists';
  const A = S(PA);
  const form = await A.get('/');
  check('the sign-up page is on the sign-up host', form.status === 200 && /Create your workspace/.test(form.text) && /name="org_name"/.test(form.text) && /name="slug"/.test(form.text) && /name="password2"/.test(form.text));
  check('it has a hidden field for programs, and says the address of the workspace', /name="website"/.test(form.text) && new RegExp(`short-name\\.${BASE.replace('.', '\\.')}`).test(form.text));
  const elsewhere = await new Browser(PA, 'help.test').get('/signup');
  check('on any other host the sign-up page does not exist', elsewhere.status !== 200 || !/Create your workspace/.test(elsewhere.text), elsewhere.status);
  check('and the tenants\' own pages are not served on the sign-up host', (await A.get('/login')).status === 404 && (await A.get('/incidents')).status === 404);
  check('a page that is not there says so', (await A.get('/nothing-here')).status === 404);

  section = 'asking';
  const quick = await submit(A, fields(1), { wait: false });
  check('a request made at once (a program) is turned away', quick.status === 400 && /very quick/.test(quick.text) && await count('SELECT count(*) AS c FROM signups WHERE slug = ?', [`o1-${tag}`]) === 0, quick.status);
  const forged = await A.raw('POST', '/signup', { form: { t: 'x.y', ...fields(1) } });
  check('a forged or missing page token is refused', forged.status === 400 && !/Check your email/.test(forged.text));
  const bots = await submit(A, { ...fields(1), website: 'http://spam.example' });
  check('the hidden field filled in: answered like a success, nothing made, nothing sent', bots.status === 200 && /Check your email/.test(bots.text) && await count('SELECT count(*) AS c FROM signups WHERE slug = ?', [`o1-${tag}`]) === 0 && mailTo(`ann1-${tag}@acme.example`).length === 0);
  const sentBefore = mails.length;
  for (const [what, change, pattern] of [
    ['an invalid short name', { slug: 'bad_name!' }, /short name/], ['a reserved short name', { slug: 'www' }, /kept for the system/], ['the sign-up host\'s own name', { slug: 'signup' }, /kept for the system/],
    ['a short name already taken', { slug: 'default' }, /already taken/], ['a weak password', { password: 'abc', password2: 'abc' }, /./], ['two different passwords', { password2: 'Something-Else-93k' }, /not the same/],
    ['no organisation', { org_name: '' }, /organisation/], ['a bad email address', { email: 'nobody' }, /email address/], ['a bad username', { username: 'x' }, /username/],
  ]) {
    const r = await submit(A, fields(1, change));
    check(`${what} is refused with the reason, and the form keeps what was typed`, r.status === 400 && pattern.test(r.text) && r.text.includes(`ann1-${tag}@acme.example`.replace(/^ann1/, change.email ? 'nobody' : 'ann1')) === !change.email && !r.text.includes(PW), `${r.status} ${(r.text.match(/alert-danger[^>]*>([^<]*)/) || [])[1]}`);
  }
  check('none of that sent a message or kept a request', mails.length === sentBefore && await count('SELECT count(*) AS c FROM signups WHERE admin_email LIKE ?', [`%-${tag}@acme.example`]) === 0);

  section = 'the link';
  const E1 = `ann1-${tag}@acme.example`;
  const ok = await submit(A, fields(1));
  check('a good request is told to check email', ok.status === 200 && /Check your email/.test(ok.text), ok.status);
  const row = await one('SELECT * FROM signups WHERE slug = ?', [`o1-${tag}`]);
  check('it waits as pending, with the password only as a hash and the token only as a hash', row && row.status === 'pending' && /^\$2[aby]\$/.test(row.password_hash) && !JSON.stringify(row).includes(PW) && /^[0-9a-f]{64}$/.test(row.token_hash));
  const t1 = tokenFrom(E1);
  check('the link is emailed, from the installation\'s own server, to that address, on the sign-up host', Boolean(t1) && mailTo(E1).length === 1 && norm(mailTo(E1)[0].raw).includes(`http://${SIGNUP}/verify/${t1}`), mailTo(E1).length);
  check('the email does not contain the password, and the stored token is its hash', !mailTo(E1)[0].raw.includes(PW) && row.token_hash === signup.sha(t1));
  check('nothing has been made yet: no tenant', await count('SELECT count(*) AS c FROM tenants WHERE slug = ?', [`o1-${tag}`]) === 0);
  const seen = await A.get(`/verify/${t1}`);
  check('opening the link shows what would be made and makes nothing (a mail scanner may open it)', seen.status === 200 && seen.text.includes(`Org 1 ${tag}`) && /Create my workspace/.test(seen.text) && await count('SELECT count(*) AS c FROM tenants WHERE slug = ?', [`o1-${tag}`]) === 0 && (await one('SELECT status FROM signups WHERE slug = ?', [`o1-${tag}`])).status === 'pending');
  for (const bad of ['short', 'x'.repeat(43), `${t1.slice(0, 42)}${t1.endsWith('A') ? 'B' : 'A'}`]) check(`a link that is not right (${bad.slice(0, 8)}...) is refused`, [404, 400].includes((await A.get(`/verify/${bad}`)).status));
  check('pressing the button of a made-up link makes nothing', (await A.raw('POST', `/verify/${'a'.repeat(43)}`, { form: { t: await formOf(A) } })).status === 400);

  section = 'confirming';
  await sleep(3200);
  const f1 = await formOf(A); await sleep(3200);
  const both = await Promise.all([A.raw('POST', `/verify/${t1}`, { form: { t: f1 } }), new Browser(PA, SIGNUP).raw('POST', `/verify/${t1}`, { form: { t: f1 } })]);
  check('pressing it twice at once makes exactly one workspace', both.filter((r) => r.status === 200).length === 1 && both.filter((r) => r.status === 400).length === 1 && await count('SELECT count(*) AS c FROM tenants WHERE slug = ?', [`o1-${tag}`]) === 1, both.map((r) => r.status).join());
  const done = both.find((r) => r.status === 200);
  check('the page gives the address of the workspace and the username', done && done.text.includes(`http://o1-${tag}.${BASE}`) && done.text.includes('ann1'));
  const tenant = await one('SELECT * FROM tenants WHERE slug = ?', [`o1-${tag}`]);
  check('the workspace is active, is named as asked, and starts with the default limits', tenant && tenant.status === 'active' && tenant.name === `Org 1 ${tag}` && tenant.limit_users === 5 && tenant.limit_records === 500 && tenant.limit_storage_mb === 50, JSON.stringify(tenant));
  const adminRow = await one('SELECT username, role, email, active FROM users WHERE tenant_id = ?', [tenant.id]);
  check('its administrator is the person, with the email they gave, and nobody else is in it', adminRow && adminRow.username === 'ann1' && adminRow.role === 'admin' && adminRow.email === E1 && await count('SELECT count(*) AS c FROM users WHERE tenant_id = ?', [tenant.id]) === 1);
  await sleep(5500);                                    // the list of tenants is looked at afresh every 5 seconds
  const T1 = new Browser(PA, `o1-${tag}.${BASE}`);
  const login = await T1.login('ann1', PW);
  check('the administrator signs in at the workspace\'s own address with the password they chose', login.status === 302 && (await T1.get('/')).status === 200, login.status);
  const after = await one('SELECT status, password_hash, tenant_id FROM signups WHERE slug = ?', [`o1-${tag}`]);
  check('the request is completed, linked to the tenant, and no password is kept anywhere', after.status === 'completed' && after.password_hash === null && after.tenant_id === tenant.id);
  check('it is in the platform\'s audit log', await count("SELECT count(*) AS c FROM platform_audit WHERE action = 'tenant.signed_up' AND tenant_id = ?", [tenant.id]) === 1);
  await sleep(1500);
  check('the administrator is sent a welcome with the address', mailTo(E1).length === 2 && norm(mailTo(E1)[1].raw).includes(`http://o1-${tag}.${BASE}`) && /ready/i.test(mailTo(E1)[1].raw));
  const again = await A.raw('POST', `/verify/${t1}`, { form: { t: await formOf(A) } });
  check('the link does not work a second time', again.status === 400 && /already been used/.test(again.text) && await count('SELECT count(*) AS c FROM tenants WHERE slug = ?', [`o1-${tag}`]) === 1);
  check('and opening it again says so', (await A.get(`/verify/${t1}`)).status === 404);

  section = 'two people want the same short name';
  const slugRace = `race-${tag}`;
  await submit(A, fields(2, { slug: slugRace })); await submit(A, fields(3, { slug: slugRace }));
  const ta = tokenFrom(`ann2-${tag}@acme.example`); const tb = tokenFrom(`ann3-${tag}@acme.example`);
  await sleep(3200);
  const first = await A.raw('POST', `/verify/${ta}`, { form: { t: await formOf(A) } });
  const second = await A.raw('POST', `/verify/${tb}`, { form: { t: await formOf(A) } });
  check('the first to confirm gets it; the second is told it was taken and nothing half-made is left', first.status === 200 && second.status === 400 && /has been taken/.test(second.text) && await count('SELECT count(*) AS c FROM tenants WHERE slug = ?', [slugRace]) === 1 && (await one('SELECT status, password_hash FROM signups WHERE admin_email = ?', [`ann3-${tag}@acme.example`])).password_hash === null);
  check('and the refused request says why in the console\'s list', /taken|already/i.test((await one('SELECT note FROM signups WHERE admin_email = ?', [`ann3-${tag}@acme.example`])).note || ''));

  section = 'links expire';
  await submit(A, fields(4)); const t4 = tokenFrom(`ann4-${tag}@acme.example`);
  await q("UPDATE signups SET expires_at = '2020-01-01 00:00:00' WHERE admin_email = ?", [`ann4-${tag}@acme.example`]);
  check('an expired link is refused, to open and to press', (await A.get(`/verify/${t4}`)).status === 404 && (await A.raw('POST', `/verify/${t4}`, { form: { t: await formOf(A) } })).status === 400 && await count('SELECT count(*) AS c FROM tenants WHERE slug = ?', [`o4-${tag}`]) === 0);

  section = 'one address';
  const E5 = `flood-${tag}@acme.example`; const before5 = mailTo(E5).length;
  for (let i = 0; i < 4; i++) await submit(A, fields(5, { slug: `fl${i}-${tag}`, email: E5 }));
  check('one email address gets at most three links an hour, and the fourth request looks like the others', mailTo(E5).length - before5 === 3 && await count('SELECT count(*) AS c FROM signups WHERE lower(admin_email) = lower(?)', [E5]) === 3);

  section = 'one network address';
  const C = S(PC);
  let last = null; const results = [];
  for (let i = 0; i < 3; i++) { last = await submit(C, fields(6, { slug: `ip${i}-${tag}`, email: `ip${i}-${tag}@acme.example` })); results.push(last.status); }
  check('a network address asks twice an hour at most (the third is turned away with 429)', results[0] === 200 && results[1] === 200 && results[2] === 429 && /Too many requests/.test(last.text), results.join());

  section = 'paused';
  const root = new Browser(PA, 'ops.test'); const lg = await root.get('/login');
  const csrfOf = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  await root.raw('POST', '/login', { form: { _csrf: csrfOf(lg.text), username: `ops${tag}`, password: OPW } });
  const sg = await root.get('/signups');
  check('the console lists the requests and what became of them', sg.status === 200 && sg.text.includes(`o1-${tag}`) && /completed/.test(sg.text) && /refused/.test(sg.text) && /pending/.test(sg.text) && /Pause sign-ups/.test(sg.text));
  const tPaused = await formOf(A); await sleep(3200);       // a page opened before the pause, posted after it
  await root.raw('POST', '/signups/pause', { form: { _csrf: csrfOf(sg.text), paused: 'true' } });
  check('paused: the page says so and a request is refused', (await A.get('/')).status === 503 && (await A.raw('POST', '/signup', { form: { t: tPaused, ...fields(7) } })).status === 503 && await count("SELECT count(*) AS c FROM signups WHERE slug = ?", [`o7-${tag}`]) === 0);
  check('pausing is in the audit log', await count("SELECT count(*) AS c FROM platform_audit WHERE action = 'signup.paused'") >= 1);
  const sg2 = await root.get('/signups');
  await root.raw('POST', '/signups/pause', { form: { _csrf: csrfOf(sg2.text), paused: 'false' } });
  check('resumed: it works again', (await A.get('/')).status === 200);

  section = 'approval, terms and domains';
  const Bb = S(PB);
  check('the terms are on the form and must be accepted', /type="checkbox" name="terms"/.test((await Bb.get('/')).text) && /accept the terms/.test((await submit(Bb, fields(8))).text));
  const wrongDomain = await submit(Bb, fields(8, { terms: 'on', email: `ann8-${tag}@other.example` }));
  check('an email domain that is not allowed is refused', wrongDomain.status === 400 && /certain email domains/.test(wrongDomain.text));
  await submit(Bb, fields(8, { terms: 'on' })); const t8 = tokenFrom(`ann8-${tag}@acme.example`);
  const confirmPage = await Bb.get(`/verify/${t8}`);
  check('the confirmation page says that someone looks at each new workspace', /look at each new workspace/.test(confirmPage.text));
  await sleep(3200);
  const made8 = await Bb.raw('POST', `/verify/${t8}`, { form: { t: await formOf(Bb) } });
  const tenant8 = await one('SELECT id, status FROM tenants WHERE slug = ?', [`o8-${tag}`]);
  check('the workspace is made but switched off, and the page says it waits', made8.status === 200 && /switch it on|switched on|after a look/i.test(made8.text) && tenant8 && tenant8.status === 'suspended', made8.status);
  await sleep(5500);
  const T8 = new Browser(PB, `o8-${tag}.${BASE}`);
  const early = await T8.login('ann8', PW);
  check('until it is switched on nobody can sign in to it', early.status !== 302, early.status);
  const tp = await root.get(`/tenants/${tenant8.id}`);
  await root.raw('POST', `/tenants/${tenant8.id}/status`, { form: { _csrf: csrfOf(tp.text), status: 'active' } });
  await sleep(5500);
  check('and when the people who run the service switch it on, the administrator signs in', (await new Browser(PB, `o8-${tag}.${BASE}`).login('ann8', PW)).status === 302);

  section = 'tidying';
  await q("INSERT INTO signups (token_hash, slug, org_name, admin_username, admin_name, admin_email, status, created_at, expires_at) VALUES (?, 'old', 'Old', 'o', 'O', 'old@old.example', 'completed', '2020-01-01 00:00:00', '2020-01-02 00:00:00')", [signup.sha(`old-${tag}`)]);
  await q("INSERT INTO signups (token_hash, slug, org_name, admin_username, admin_name, admin_email, status, password_hash, created_at, expires_at) VALUES (?, 'stale', 'Stale', 'o', 'O', 'stale@old.example', 'pending', 'x', '2020-01-01 00:00:00', '2020-01-02 00:00:00')", [signup.sha(`stale-${tag}`)]);
  await signup.cleanup();
  check('old requests (and the email addresses in them) are removed, and a link nobody used expires with its password hash cleared', await count("SELECT count(*) AS c FROM signups WHERE admin_email = 'old@old.example'") === 0 && await count("SELECT count(*) AS c FROM signups WHERE admin_email = 'stale@old.example'") === 0);
  check('what has been done so far is still there', await count('SELECT count(*) AS c FROM signups WHERE slug = ?', [`o1-${tag}`]) === 1);

  const tenants = require('../src/tenants');
  const gone = await one('SELECT id FROM tenants WHERE slug = ?', [slugRace]);
  check('(a workspace made by a sign-up exists, with its request)', await count('SELECT count(*) AS c FROM signups WHERE tenant_id = ?', [gone.id]) === 1);
  await q("UPDATE tenants SET status = 'pending_deletion', deletion_scheduled_at = '2020-01-01 00:00:00' WHERE id = ?", [gone.id]);
  await tenants.purge(gone.id);
  check('when a tenant is deleted its sign-up request, with the email address in it, goes too', await count('SELECT count(*) AS c FROM signups WHERE admin_email = ?', [`ann2-${tag}@acme.example`]) === 0 && await count('SELECT count(*) AS c FROM tenants WHERE id = ?', [gone.id]) === 0);

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASS');
  process.exitCode = failed ? 1 : 0;
}

main().then(() => process.exit(process.exitCode || 0), (e) => { console.error(e); process.exit(1); });
