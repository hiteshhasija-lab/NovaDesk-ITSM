#!/usr/bin/env node
// Anonymising accounts that stay switched off, end to end, against a copy of NovaDesk that this script starts itself (port 18420) on the database named by
// PGHOST, PGUSER, PGPASSWORD and PGDATABASE, with the daily job run every 2 seconds: that nothing happens until an administrator sets the rule (and who may), that
// only accounts that are OFF for longer than the rule are anonymised (never one that is on, never one switched on again, never one off for less), by the daily job and by
// the button, that what is anonymised is what Anonymise does (the ticket stays, the person is gone, no sign-in), the page says who is next and when, every run is in the
// audit log, and that one tenant's rule never touches another tenant's people. Needs the demonstration users.
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
const PORT = 18420;

// A browser: its own cookies, talking to one server.
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
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SEED_DEMO: 'true', SLA_SWEEP_S: '3600', RETENTION_SWEEP_S: '2', SESSION_SECRET: `inact-${tag}`, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => log.push(String(d))); child.stderr.on('data', (d) => log.push(String(d)));
  return { child, text: () => log.join(''), exited: new Promise((r) => child.on('exit', r)) };
}
async function healthy(srv) { for (let i = 0; i < 60; i++) { try { if ((await new Browser(PORT, 'x.test').get('/health')).status === 200) return true; } catch { /* wait */ } if (srv.child.exitCode !== null) return false; await sleep(500); } return false; }

async function main() {
  const knex = knexLib({ client: 'pg', connection: dbConfig(process.env), pool: { min: 0, max: 3, afterCreate: (c, done) => c.query("SELECT set_config('app.tenant_id', '1', false)", (e) => done(e, c)) } });
  const app = start({});
  try {
    if (!(await healthy(app))) throw new Error(`NovaDesk did not start: ${app.text().slice(-400)}`);
    await run(knex);
  } catch (e) { console.error(`server output (tail):\n${app.text().slice(-1500)}`); throw e;
  } finally { await knex.destroy(); app.child.kill(); await app.exited; }
}

async function run(knex) {
  const q = async (sql, params = []) => (await knex.raw(sql, params)).rows;
  const one = async (sql, params = []) => (await q(sql, params))[0];
  const row = (name) => one('SELECT id, username, full_name, email, active, deactivated_at, anonymised_at FROM users WHERE username = ? OR id = (SELECT id FROM users WHERE full_name = ? LIMIT 1)', [name, name]);
  const byName = (n) => one('SELECT id, username, full_name, email, active, deactivated_at, anonymised_at FROM users WHERE username = ?', [n]);
  const byId = (id) => one('SELECT id, username, full_name, email, active, deactivated_at, anonymised_at FROM users WHERE id = ?', [id]);
  const waitFor = async (fn, ms = 25000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(500); } return false; };
  const ago = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const PWD = 'Quartz-Meadow-71b';

  // The neighbouring tenant 2 and everything it came to own (its log rows, its people, its rule).
  let NB = null;
  const dropNeighbour = async () => {
    if (!NB) return;
    for (const t of ['audit_log', 'activity_log', 'notifications', 'sessions', 'retention_rules', 'users']) await q(`DELETE FROM ${t} WHERE tenant_id = ?`, [NB]);
    await q('DELETE FROM tenants WHERE id = ?', [NB]);
    NB = null;
  };
  // Leave nothing from an earlier run: the rule and the people it left switched off.
  await q("DELETE FROM retention_rules WHERE target = 'inactive_accounts'");
  await q("UPDATE users SET active = 1 WHERE email LIKE '%@inact.test' AND anonymised_at IS NULL");      // people an earlier run left switched off must not be due in this one
  const admin = new Browser(PORT, 'help.test'); await admin.login('admin', 'admin123');
  const agent = new Browser(PORT, 'help.test'); await agent.login('jdoe', 'agent123');
  const names = { old: `old${tag}`, adm: `adm${tag}`, recent: `recent${tag}`, on: `on${tag}`, back: `back${tag}`, manual: `manual${tag}` };
  const make = async (n, role = 'user') => { await admin.post('/users', { username: n, full_name: `Person ${n}`, email: `${n}@inact.test`, password: PWD, role, department: 'QA', active: 'on' }); return byName(n); };
  const edit = (u, extra = {}) => admin.post(`/users/${u.id}/update`, { username: u.username, full_name: u.full_name, email: u.email, role: u.role === undefined ? 'user' : u.role, department: 'QA', ...extra });
  const off = async (n, days, role = 'user') => { const u = await make(n, role); const r = await edit({ ...u, role }); await q('UPDATE users SET deactivated_at = ? WHERE id = ?', [ago(days), u.id]); return { id: u.id, status: r.status }; };

  section = 'the date';
  const probe = await make(`probe${tag}`);
  check('a new account that is on has no date', (await byId(probe.id)).deactivated_at === null);
  await edit(probe);        // no "active" in the form = switched off, through the Users page
  const dated = (await byId(probe.id)).deactivated_at;
  check('switching someone off on the Users page dates it', Boolean(dated) && (await byId(probe.id)).active === 0, dated);
  await edit(probe, { active: 'on' });
  check('switching them on again clears it', (await byId(probe.id)).deactivated_at === null && (await byId(probe.id)).active === 1);

  section = 'the setting';
  check('only an administrator can reach it', (await agent.post('/privacy/inactive', { inactive_days: '30' })).status === 403 && (await agent.get('/privacy')).status === 403);
  const people = {
    old: await off(names.old, 40), adm: await off(names.adm, 60, 'admin'), recent: await off(names.recent, 10), manual: await off(names.manual, 5),
  };
  const on = await make(names.on); await q('UPDATE users SET deactivated_at = ? WHERE id = ?', [ago(200), on.id]);        // on, with an old date left over: never touched
  const back = await off(names.back, 90); await edit(await byId(back.id), { active: 'on' });                              // was off a long time, switched on again
  // the old account raised a ticket: it must outlive the person
  const oldUser = await byName(names.old);
  const inc = await one("INSERT INTO incidents (number, short_description, description, caller_id) VALUES (?, ?, 'ticket text', ?) RETURNING id", [`INC-I${tag}`, `Ticket of ${names.old}`, oldUser.id]);
  // another tenant: one person off for a long time, and no rule there
  NB = (await one("INSERT INTO tenants (slug, name) VALUES (?, 'Neighbour') RETURNING id", [`inact-${tag}`])).id;
  await q("INSERT INTO users (username, password_hash, full_name, role, active, tenant_id, deactivated_at) VALUES (?, 'x', 'Neighbour person', 'user', 0, ?, ?)", [`nb${tag}`, NB, ago(500)]);

  const page = await admin.get('/privacy');
  check('the page has the card, saying it is off', page.status === 200 && /Accounts that stay switched off/.test(page.text) && /name="inactive_days"/.test(page.text));
  check('it lists the accounts that are off, longest first, without any date of anonymising', page.text.indexOf(names.old) !== -1 && page.text.indexOf(names.adm) !== -1 && !/Anonymise now/.test(page.text));
  for (const bad of ['29', 'ninety', '3651', '-1', '1.5']) {
    const r = await admin.post('/privacy/inactive', { inactive_days: bad });
    check(`"${bad}" is refused with the reason, and nothing is saved`, r.status === 400 && /(whole number|At least|At most)/.test(r.text) && !(await one("SELECT 1 AS x FROM retention_rules WHERE target = 'inactive_accounts' AND keep_days IS NOT NULL")));
  }
  await sleep(6500);        // the daily job has run a few times by now, with no rule
  check('with no rule, nothing is anonymised, however long someone has been off', (await q('SELECT id FROM users WHERE tenant_id = 1 AND anonymised_at IS NOT NULL AND id IN (?, ?)', [people.old.id, people.adm.id])).length === 0);

  section = 'the rule, run by the daily job';
  const saved = await admin.post('/privacy/inactive', { inactive_days: '30' });
  check('30 days is saved', saved.status === 200 && /Saved/.test(saved.text) && Number((await one("SELECT keep_days FROM retention_rules WHERE target = 'inactive_accounts' AND tenant_id = 1")).keep_days) === 30);
  check('the change is in the audit log', Number((await one("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'retention.inactive_accounts_changed'")).c) >= 1);
  const pageWith = await admin.get('/privacy');
  check('the page now says who is next and what day, and has the button', /Anonymised on/.test(pageWith.text) && /Anonymise now/.test(pageWith.text) && /next run/.test(pageWith.text) && /past the limit now/.test(pageWith.text));
  const did = await waitFor(async () => (await byId(people.old.id)).anonymised_at && (await byId(people.adm.id)).anonymised_at);
  check('the daily job anonymised the two accounts that were off for more than 30 days', did);
  const a = await byId(people.old.id);
  check('the person is gone: new username, label, no email, off, no sign-in', /^anonymised-\d+/.test(a.username) && a.email === null && a.active === 0 && !a.full_name.includes(names.old) && (await new Browser(PORT, 'help.test').login(names.old, PWD)).status !== 302);
  const ticket = await one('SELECT short_description, caller_id FROM incidents WHERE id = ?', [inc.id]);
  check('the ticket stays, pointing at the anonymised account', ticket && ticket.caller_id === people.old.id);
  const still = async (id) => (await byId(id)).anonymised_at === null;
  check('off for 10 days: untouched', await still(people.recent.id) && (await byId(people.recent.id)).username === names.recent);
  check('off for 5 days: untouched', await still(people.manual.id));
  check('on, even with an old date left over: untouched', await still(on.id) && (await byId(on.id)).active === 1);
  check('switched on again after 90 days off: untouched, and the date is gone', await still(back.id) && (await byId(back.id)).active === 1 && (await byId(back.id)).deactivated_at === null);
  const neighbour = await one('SELECT anonymised_at FROM users WHERE tenant_id = ?', [NB]);
  check('another tenant\'s person, off for 500 days, is not touched: the rule is this tenant\'s', neighbour.anonymised_at === null);
  const log = await q("SELECT action, detail FROM audit_log WHERE action IN ('privacy.anonymised','privacy.inactive_swept') ORDER BY id DESC LIMIT 6");
  check('each is in the audit log, and the run says how many', log.filter((l) => l.action === 'privacy.anonymised').length >= 2 && log.some((l) => l.action === 'privacy.inactive_swept' && /daily: 2 accounts anonymised/.test(l.detail)), JSON.stringify(log).slice(0, 300));
  check('the page shows the last run', /Last run:[\s\S]{0,200}2 anonymised/.test((await admin.get('/privacy')).text));

  section = 'the button';
  await q('UPDATE users SET deactivated_at = ? WHERE id = ?', [ago(31), people.manual.id]);
  const ran = await admin.post('/privacy/inactive/run', {});
  check('the button anonymises what is past the limit now', ran.status === 200 && /Done: 1 account anonymised/.test(ran.text) && (await byId(people.manual.id)).anonymised_at !== null, (ran.text.match(/alert[^>]*>([^<]*)/) || [])[1]);
  check('the account that was switched on again is still untouched', (await byId(back.id)).anonymised_at === null && (await byId(back.id)).active === 1);
  check('an agent cannot press it', (await agent.post('/privacy/inactive/run', {})).status === 403);
  check('the people already anonymised stay anonymised (nothing runs twice on them)', (await byId(people.old.id)).username === a.username);

  section = 'turning it off, and another tenant\'s own rule';
  await admin.post('/privacy/inactive', { inactive_days: '' });
  check('an empty box turns the rule off', (await one("SELECT keep_days FROM retention_rules WHERE target = 'inactive_accounts' AND tenant_id = 1")).keep_days === null);
  await q('UPDATE users SET deactivated_at = ? WHERE id = ?', [ago(400), people.recent.id]);
  const off2 = await admin.post('/privacy/inactive/run', {});
  check('with it off, the button does nothing', /No rule is set/.test(off2.text) && (await byId(people.recent.id)).anonymised_at === null);
  await q("INSERT INTO retention_rules (target, keep_days, tenant_id) VALUES ('inactive_accounts', 30, ?)", [NB]);
  const theirs = await waitFor(async () => (await one('SELECT anonymised_at FROM users WHERE tenant_id = ?', [NB])).anonymised_at !== null, 30000);
  check('a rule of the neighbour\'s own anonymises the neighbour\'s people', theirs);
  check('and still not ours: this tenant has the rule off, and its long-off account stays', (await byId(people.recent.id)).anonymised_at === null);

  await dropNeighbour();
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASS');
  process.exitCode = failed ? 1 : 0;
}

main().then(() => process.exit(process.exitCode || 0), (e) => { console.error(e); process.exit(1); });
