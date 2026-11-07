#!/usr/bin/env node
// Inbound email for each tenant, end to end, against copies of NovaDesk that this script starts itself (ports 18380 and 18381) on the
// database named by PGHOST, PGUSER, PGPASSWORD and PGDATABASE: who may change the settings, each refusal (including the guard against
// pointing the server at internal addresses and odd ports), the mailbox password kept encrypted, a tenant's own mailbox read into that tenant
// (the poller runs in this script against a fake IMAP mailbox, so no mail server is needed) with that tenant's own rules, the tenant's own token
// for the HTTP address (shown once, only a hash kept), that nothing crosses between tenants, a revoked or suspended tenant's token, and the audit log.
// Needs the demonstration users.
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
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SEED_DEMO: 'true', SLA_SWEEP_S: '3600', SESSION_SECRET: `inb-${tag}`, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => log.push(String(d))); child.stderr.on('data', (d) => log.push(String(d)));
  return { child, text: () => log.join(''), exited: new Promise((r) => child.on('exit', r)) };
}
async function healthy(port, srv) { for (let i = 0; i < 60; i++) { try { if ((await new Browser(port, 'x.test').get('/health')).status === 200) return true; } catch { /* wait */ } if (srv.child.exitCode !== null) return false; await sleep(500); } return false; }

async function main() {
  process.env.SESSION_SECRET = `inb-${tag}`;   // this script reads mailbox passwords with the servers' key (the poller runs in this process)
  const knex = knexLib({ client: 'pg', connection: dbConfig(process.env), pool: { min: 0, max: 3 } });
  const apps = [];
  try {
    for (const [port, env] of [[18380, { MAIL_ALLOW_PRIVATE: 'true' }], [18381, {}]]) {
      const a = start(port, env); apps.push(a);
      if (!(await healthy(port, a))) throw new Error(`NovaDesk on ${port} did not start: ${a.text().slice(-400)}`);
    }
    await run(knex, apps);
  } finally { await knex.destroy(); for (const a of apps) a.child.kill(); await Promise.all(apps.map((a) => a.exited)); }
}

// A mailbox that is only in memory, the shape of the IMAP client the poller uses.
function fakeMailbox(raws) {
  const seen = new Set();
  const messages = new Map(raws.map((raw, i) => [i + 1, Buffer.from(raw)]));
  const client = {
    mailbox: { uidValidity: 9 }, on() {}, async connect() {}, async logout() {}, close() {},
    async getMailboxLock() { return { release() {} }; },
    async search() { return [...messages.keys()].filter((u) => !seen.has(u)); },
    async fetchOne(uid, q) { const m = messages.get(uid); return q.size ? { size: m.length } : { source: m }; },
    async messageFlagsAdd(uid) { seen.add(uid); }, async messageMove(uid) { seen.add(uid); },
  };
  return { client, seen };
}
const mail = (from, subject, body, id) => `From: ${from}\r\nTo: help@desk.test\r\nSubject: ${subject}\r\nMessage-ID: <${id}@inb.test>\r\nDate: Fri, 06 Nov 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;

async function run(knex, apps) {
  const tenants = require('../src/tenants');
  const tenancy = require('../src/tenancy');
  const poller = require('../src/inbound/imapPoller');
  const tenantPoller = require('../src/inbound/tenantPoller');
  const inboundSettings = require('../src/inboundSettings');
  const q = async (sql, params = []) => (await knex.raw(sql, params)).rows;
  const one = async (sql, params = []) => (await q(sql, params))[0];
  const count = async (sql, params = []) => Number((await one(sql, params)).c);
  const OPEN = 18380; const STRICT = 18381;
  const HOST_A = 'help.corp.test'; const HOST_B = `b-${tag}.inb.test`; const HOST_C = `c-${tag}.inb.test`;
  const PW = 'Quartz-Meadow-71b';
  const tb = await tenants.createTenant({ slug: `inb-b-${tag}`, name: `Inb B ${tag}`, hosts: [HOST_B] });
  const tc = await tenants.createTenant({ slug: `inb-c-${tag}`, name: `Inb C ${tag}`, hosts: [HOST_C] });
  await tenants.createAdmin(tb.id, { username: 'bossb', password: PW, fullName: 'Bea Boss', email: `bea${tag}@acme.test` });
  await tenants.createAdmin(tc.id, { username: 'bossc', password: PW, fullName: 'Cy Chief', email: `cy${tag}@globex.test` });
  await sleep(5500);
  const A = new Browser(OPEN, HOST_A); const B = new Browser(OPEN, HOST_B); const C = new Browser(OPEN, HOST_C);
  await A.login('admin', 'admin123'); await B.login('bossb', PW); await C.login('bossc', PW);
  await q('UPDATE inbound_settings SET intake_token_hash = NULL, intake_token_prefix = NULL');   // other runs may have left tokens behind
  const row = (tid) => one('SELECT * FROM inbound_settings WHERE tenant_id = ?', [tid]);
  const form = (over = {}) => ({ enabled: 'on', host: '127.0.0.1', port: '1', user: 'help@desk.test', password: 'mailbox-secret-pw', secure: 'on', tls_verify: 'on', poll_seconds: '30', folder: 'INBOX', address: 'help@desk.test', unknown_senders: 'create', allowed_domains: '', blocked_senders: 'spam.test', max_per_sender_hour: '10', assignment_group: 'IRO-ServiceDesk', ...over });
  const saveAs = (b, over, drop = []) => { const f = form(over); for (const k of drop) delete f[k]; for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k]; return b.post('/settings/inbound/mailbox', f); };
  const before = JSON.stringify(await row(tb.id));
  const inTenant = (tid, fn) => tenancy.run(tid, async () => { inboundSettings.invalidate(); return fn(); });
  const raw = (b, token, text) => b.raw('POST', '/api/inbound/email', { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'message/rfc822' }, multipart: { buf: Buffer.from(text), type: 'message/rfc822' } });

  // ------------------------------------------------------------------------------------------------------ before it is set
  section = 'before it is set';
  check('every tenant has a settings row, switched off, with no token', (await q('SELECT enabled, intake_token_hash AS t FROM inbound_settings WHERE tenant_id IN (1, ?, ?)', [tb.id, tc.id])).length === 3 && (await q('SELECT enabled, intake_token_hash AS t FROM inbound_settings WHERE tenant_id IN (1, ?, ?)', [tb.id, tc.id])).every((r) => r.enabled === 0 && r.t === null));
  const page = await B.get('/settings/inbound');
  check('an administrator sees the page with the settings form and the HTTP address', page.status === 200 && page.text.includes('name="host"') && /Make a token/.test(page.text) && /Not set up/.test(page.text));
  const agent = new Browser(OPEN, HOST_A); await agent.login('jdoe', 'agent123');
  check('an agent cannot open or change it (403), a signed-out visitor is sent to sign in, a change without the page token is refused', (await agent.get('/settings/inbound')).status === 403 && (await agent.post('/settings/inbound/mailbox', form())).status === 403 && (await agent.post('/settings/inbound/token', {})).status === 403 && (await new Browser(OPEN, HOST_B).get('/settings/inbound')).status === 302 && (await B.raw('POST', '/settings/inbound/mailbox', { form: form() })).status === 403 && JSON.stringify(await row(tb.id)) === before);
  check('with no token or secret anywhere the HTTP address does not exist (404, nothing to probe)', (await new Browser(OPEN, HOST_B).raw('POST', '/api/inbound/email', { headers: { Authorization: 'Bearer x', 'Content-Type': 'message/rfc822' }, multipart: { buf: Buffer.from('x'), type: 'message/rfc822' } })).status === 404);

  // ------------------------------------------------------------------------------------------------------ refusals
  section = 'refusals';
  const refuse = async (b, over, words, label, drop) => { const r = await saveAs(b, over, drop); return check(label, r.status === 400 && words.some((w) => r.text.includes(w)) && JSON.stringify(await row(tb.id)) === before, `${r.status}`); };
  await refuse(B, { host: '' }, ['host name'], 'switching the mailbox on without a server');
  await refuse(B, { user: '' }, ['user name and password'], 'without a user name');
  await refuse(B, { password: undefined }, ['user name and password'], 'without a password (none saved yet)', ['password']);
  await refuse(B, { poll_seconds: '5' }, ['10 to 3600'], 'looking every 5 seconds');
  await refuse(B, { address: 'nobody' }, ['email address'], 'a help desk address that is not an address');
  await refuse(B, { allowed_domains: 'nope' }, ['not an email domain'], 'a bad sender domain');
  await refuse(B, { assignment_group: 'Everyone' }, ['assignment groups'], 'a group that does not exist');
  await refuse(B, { max_per_sender_hour: '-3' }, ['from 0'], 'a negative limit');
  await refuse(B, { unknown_senders: 'delete' }, ['Choose what to do'], 'an unknown sender rule that does not exist');
  const sr = new Browser(STRICT, HOST_B); await sr.login('bossb', PW);
  const refuseStrict = async (over, words, label) => { const r = await sr.post('/settings/inbound/mailbox', form(over)); return check(label, r.status === 400 && words.some((w) => r.text.includes(w)) && JSON.stringify(await row(tb.id)) === before, `${r.status}`); };
  await refuseStrict({ port: '993' }, ['private, local or reserved'], 'on a strict server, this machine is refused');
  await refuseStrict({ host: '10.0.0.5', port: '993' }, ['private, local or reserved'], 'a private network address is refused');
  await refuseStrict({ host: '169.254.169.254', port: '143' }, ['private, local or reserved'], 'the cloud metadata address is refused');
  await refuseStrict({ host: '1.1.1.1', port: '22' }, ['must be 143 or 993'], 'a port that is not an IMAP port is refused (no port scanning)');
  await refuseStrict({ host: '1.1.1.1', port: '6379' }, ['must be 143 or 993'], 'another one');

  // ------------------------------------------------------------------------------------------------------ saving
  section = 'saving';
  check('a tenant saves its mailbox and rules', (await saveAs(B, {})).status === 302);
  const r1 = await row(tb.id);
  check('switched on, with the values it was given', r1.enabled === 1 && r1.imap_host === '127.0.0.1' && r1.imap_user === 'help@desk.test' && r1.assignment_group === 'IRO-ServiceDesk' && r1.blocked_senders === 'spam.test' && r1.poll_seconds === 30);
  check('the mailbox password is stored encrypted, and nowhere in the clear', /^v1:/.test(r1.imap_password_enc) && !JSON.stringify(r1).includes('mailbox-secret-pw'));
  const shown = await B.get('/settings/inbound');
  check('the page never shows it, only that one is saved', !shown.text.includes('mailbox-secret-pw') && shown.text.includes('(saved)'));
  await saveAs(B, {}, ['password']);
  check('saving again without a password keeps it', (await row(tb.id)).imap_password_enc === r1.imap_password_enc);
  check('the others\' settings were not touched', (await row(1)).enabled === 0 && (await row(tc.id)).enabled === 0 && !(await row(1)).imap_host);
  const audit = await q("SELECT detail FROM audit_log WHERE tenant_id = ? AND action = 'inbound.settings_changed' ORDER BY id", [tb.id]);
  check('every change is in the tenant\'s audit log, saying what changed and never the password', audit.some((a) => /mailbox switched on/.test(a.detail)) && audit.some((a) => /password replaced/.test(a.detail)) && !audit.some((a) => /mailbox-secret-pw/.test(a.detail)));

  // ------------------------------------------------------------------------------------------------------ the mailbox is read into the tenant
  section = 'the mailbox';
  const box = fakeMailbox([
    mail(`Alice Archer <alice.${tag}@corp.test>`, `Printer on floor 3 ${tag} is broken`, 'It jams on every page.', `p1-${tag}`),
    mail('Bad Actor <bad@spam.test>', 'Cheap pills', 'Buy now.', `p2-${tag}`),
  ]);
  poller._test.deps.createClient = () => box.client;
  const handled = await inTenant(tb.id, () => tenantPoller.pollTenant(tb.id, { force: true }));
  check('a look at the tenant\'s mailbox handles both messages and marks them read', handled === 2 && box.seen.size === 2, `${handled}`);
  const inc = await one(`SELECT * FROM incidents WHERE tenant_id = ? AND short_description LIKE 'Printer on floor 3 ${tag}%'`, [tb.id]);
  check('the message became an incident of that tenant, the first of its own numbering', Boolean(inc) && inc.number === 'INC0000001' && inc.assignment_group === 'IRO-ServiceDesk', JSON.stringify(inc && [inc.number, inc.assignment_group]));
  check('with its sender made a contact in that tenant', (await one(`SELECT tenant_id, role FROM users WHERE email = 'alice.${tag}@corp.test'`)).tenant_id === tb.id);
  const rows = await q("SELECT outcome, reason, tenant_id FROM inbound_emails WHERE message_id LIKE ?", [`%-${tag}@inb.test%`]);
  check('the blocked sender was ignored, by that tenant\'s own rule', rows.some((r) => r.outcome === 'ticket') && rows.some((r) => r.outcome === 'ignored' && /block list/.test(r.reason)) && rows.every((r) => r.tenant_id === tb.id), JSON.stringify(rows));
  check('nothing reached any other tenant', await count(`SELECT count(*) AS c FROM incidents WHERE short_description LIKE 'Printer on floor 3 ${tag}%' AND tenant_id <> ?`, [tb.id]) === 0 && await count(`SELECT count(*) AS c FROM users WHERE email = 'alice.${tag}@corp.test' AND tenant_id <> ?`, [tb.id]) === 0);
  check('a tenant with no mailbox of its own is not read', (await inTenant(tc.id, () => tenantPoller.pollTenant(tc.id, { force: true }))) === null && (await inTenant(1, () => tenantPoller.pollTenant(1, { force: true }))) === null);
  const again = fakeMailbox([mail(`Alice Archer <alice.${tag}@corp.test>`, `Printer on floor 3 ${tag} is broken`, 'It jams on every page.', `p1-${tag}`)]);
  poller._test.deps.createClient = () => again.client;
  await inTenant(tb.id, () => tenantPoller.pollTenant(tb.id, { force: true }));
  check('the same message seen again makes nothing new', await count(`SELECT count(*) AS c FROM incidents WHERE tenant_id = ? AND short_description LIKE 'Printer on floor 3 ${tag}%'`, [tb.id]) === 1);
  const stB = tenantPoller.stateFor(tb.id);
  check('the tenant\'s mailbox has its own state: working, with what was handled', stB.configured && stB.lastOk && !stB.lastError, JSON.stringify(stB));
  // a rule change applies to the tenant at once
  await saveAs(B, { unknown_senders: 'ignore' });
  const box2 = fakeMailbox([mail(`Stranger <stranger.${tag}@new.test>`, 'Hello from a stranger', 'Hi', `p3-${tag}`)]);
  poller._test.deps.createClient = () => box2.client;
  await inTenant(tb.id, () => tenantPoller.pollTenant(tb.id, { force: true }));
  check('"ignore a sender with no account" is that tenant\'s own rule', await count(`SELECT count(*) AS c FROM users WHERE email = 'stranger.${tag}@new.test'`) === 0 && (await one("SELECT outcome FROM inbound_emails WHERE message_id LIKE ?", [`%p3-${tag}@%`])).outcome === 'ignored');
  const pageB = await B.get('/settings/inbound');
  check('the tenant\'s page lists its own messages and none of another\'s', pageB.text.includes(`Printer on floor 3 ${tag}`) && !(await A.get('/settings/inbound')).text.includes(`Printer on floor 3 ${tag}`) && !(await C.get('/settings/inbound')).text.includes(`Printer on floor 3 ${tag}`));

  // ------------------------------------------------------------------------------------------------------ the HTTP address
  section = 'the HTTP address';
  await saveAs(B, {});   // new senders become contacts again
  const mk = await B.post('/settings/inbound/token', {});
  const tokenB = (mk.text.match(/ndi_[A-Za-z0-9_-]{40}/) || [])[0];
  check('a tenant makes its token, shown once', mk.status === 200 && Boolean(tokenB) && !(await B.get('/settings/inbound')).text.includes(tokenB));
  const rb = await row(tb.id);
  check('only a hash of it is kept, and its first characters to recognise it by', rb.intake_token_hash === inboundSettings.hashToken(tokenB) && rb.intake_token_prefix === tokenB.slice(0, 8) && !JSON.stringify(rb).includes(tokenB));
  await C.post('/settings/inbound/token', {}); 
  const tokenC = (await C.post('/settings/inbound/token', {})).text.match(/ndi_[A-Za-z0-9_-]{40}/)[0];
  const sent = await raw(new Browser(OPEN, HOST_A), tokenB, mail(`Dana Dee <dana.${tag}@corp.test>`, `Network down in building 2 ${tag}`, 'No wifi.', `h1-${tag}`));
  check('mail handed over with the tenant\'s token (at any host name) becomes an incident of that tenant', sent.status === 202 && ((await one(`SELECT tenant_id FROM incidents WHERE short_description = 'Network down in building 2 ${tag}'`)) || {}).tenant_id === tb.id, `${sent.status} ${sent.text.slice(0, 120)}`);
  check('using that tenant\'s rules (the blocked sender is ignored, as for its mailbox)', (await raw(new Browser(OPEN, HOST_A), tokenB, mail('Bad <x@spam.test>', 'More pills', 'x', `h2-${tag}`))).data.outcome === 'ignored');
  check('the same message twice is a duplicate', (await raw(new Browser(OPEN, HOST_A), tokenB, mail(`Dana Dee <dana.${tag}@corp.test>`, `Network down in building 2 ${tag}`, 'No wifi.', `h1-${tag}`))).data.outcome === 'duplicate');
  await saveAs(C, { enabled: undefined, host: undefined, user: undefined, password: undefined, allowed_domains: 'globex.test', assignment_group: '' }, ['enabled', 'host', 'user', 'password']);
  const toC = await raw(new Browser(OPEN, HOST_A), tokenC, mail(`Dana Dee <dana.${tag}@corp.test>`, `Network down in building 2 ${tag}`, 'No wifi.', `h1-${tag}`));
  check('another tenant\'s token delivers into that tenant, under its own rules (here only one sender domain is allowed)', toC.status === 202 && toC.data.outcome === 'ignored' && await count(`SELECT count(*) AS c FROM incidents WHERE short_description = 'Network down in building 2 ${tag}' AND tenant_id = ?`, [tc.id]) === 0, JSON.stringify(toC.data));
  check('the same text is allowed in the tenant whose rules allow it, and that was the only incident', await count(`SELECT count(*) AS c FROM incidents WHERE short_description = 'Network down in building 2 ${tag}'`) === 1);
  check('a made-up token, no token, and another installation\'s secret are all 401', (await raw(new Browser(OPEN, HOST_A), `ndi_${'x'.repeat(40)}`, 'x')).status === 401 && (await new Browser(OPEN, HOST_A).raw('POST', '/api/inbound/email', { headers: { 'Content-Type': 'message/rfc822' }, multipart: { buf: Buffer.from('x'), type: 'message/rfc822' } })).status === 401 && (await raw(new Browser(OPEN, HOST_A), 'a-long-shared-secret-that-is-not-set-anywhere', 'x')).status === 401);
  check('the token of a tenant with no token of its own does not exist for the default tenant', await count('SELECT count(*) AS c FROM inbound_settings WHERE tenant_id = 1 AND intake_token_hash IS NOT NULL') === 0);
  await tenants.setStatus(tc.id, 'suspended'); await sleep(5500);
  check('a suspended tenant\'s token stops working (401)', (await raw(new Browser(OPEN, HOST_A), tokenC, mail('a@globex.test', 'Hi', 'x', `h3-${tag}`))).status === 401);
  await tenants.setStatus(tc.id, 'active'); await sleep(5500);
  const mk2 = await B.post('/settings/inbound/token', {});
  const tokenB2 = (mk2.text.match(/ndi_[A-Za-z0-9_-]{40}/) || [])[0];
  check('making a new token replaces the old one at once', tokenB2 !== tokenB && (await raw(new Browser(OPEN, HOST_A), tokenB, mail('a@corp.test', 'Old token', 'x', `h4-${tag}`))).status === 401 && (await raw(new Browser(OPEN, HOST_A), tokenB2, mail('a@corp.test', 'New token', 'x', `h5-${tag}`))).status === 202);
  const rev = await B.post('/settings/inbound/token/revoke', {});
  check('revoking it stops the address for that tenant (401), and is in the audit log', rev.status === 302 && (await raw(new Browser(OPEN, HOST_A), tokenB2, mail('a@corp.test', 'Revoked', 'x', `h6-${tag}`))).status === 401 && await count("SELECT count(*) AS c FROM audit_log WHERE tenant_id = ? AND action = 'inbound.token_revoked'", [tb.id]) === 1);
  await C.post('/settings/inbound/token/revoke', {});
  check('with every token gone the address does not exist again (404)', (await raw(new Browser(OPEN, HOST_A), tokenC, 'x')).status === 404);
  check('no token is in any audit log', !JSON.stringify(await q("SELECT detail FROM audit_log WHERE action LIKE 'inbound.%'")).includes(tokenB) && !JSON.stringify(await q("SELECT detail FROM audit_log WHERE action LIKE 'inbound.%'")).includes(tokenC));

  // ------------------------------------------------------------------------------------------------------ check now, switching off
  section = 'check now and switching off';
  const checkNow = await B.post('/settings/inbound/check', {});
  check('"Check now" answers (the mailbox here is not reachable, and that is shown, not hidden)', checkNow.status === 200 && /Problem|The mailbox was read|Working/.test(checkNow.text));
  await saveAs(B, { enabled: undefined }, ['enabled']);
  check('switched off: the settings are kept and the mailbox is no longer read', (await row(tb.id)).enabled === 0 && (await row(tb.id)).imap_host === '127.0.0.1' && (await inTenant(tb.id, () => tenantPoller.pollTenant(tb.id, { force: true }))) === null);

  section = 'the log';
  const errors = apps.flatMap((a) => a.text().split('\n')).filter((l) => /error|unhandled|exception|NO_TENANT/i.test(l) && !/ECONNREFUSED|could not read a tenant|Inbound\] could not/i.test(l));
  check('the servers\' logs show no unexpected errors', errors.length === 0, errors.slice(-4).join(' | '));
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASS');
  process.exitCode = failed ? 1 : 0;
}

main().then(() => process.exit(process.exitCode || 0), (e) => { console.error(e); process.exit(1); });
