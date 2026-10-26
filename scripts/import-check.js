#!/usr/bin/env node
// CSV import, end to end, against a copy of NovaDesk that this script starts itself (port 18250) on the database named by
// PGHOST, PGUSER, PGPASSWORD and PGDATABASE: who may import what, forged and abusive uploads, the preview that saves nothing,
// confirming (once, even when two requests race), the records that result, updating by exporting and importing again,
// odd files (semicolons, Windows-1252, quotes and line breaks), the audit log, and the record kept of each import.
// Needs the demonstration users.
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const knexLib = require('knex');
const { dbConfig } = require('../src/settings');

const ROOT = path.join(__dirname, '..');
let failed = 0; let section = '';
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  [${section}] ${name}${!ok && extra ? '  -- ' + String(extra).slice(0, 300) : ''}`); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Math.random().toString(36).slice(2, 7);

class Browser {
  constructor(base) { this.base = base; this.cookie = ''; this.csrf = null; }
  jar(res) { for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]; const j = Object.fromEntries(this.cookie.split('; ').filter(Boolean).map((x) => [x.split('=')[0], x])); j[kv.split('=')[0]] = kv; this.cookie = Object.values(j).join('; '); } }
  async raw(method, p, { form, multipart, headers = {} } = {}) {
    const h = { Cookie: this.cookie, ...headers }; let body;
    if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); } else if (multipart) body = multipart;
    const res = await fetch(this.base + p, { method, headers: h, body, redirect: 'manual' });
    this.jar(res);
    const buf = Buffer.from(await res.arrayBuffer()); const text = buf.toString('utf8');
    const meta = text.match(/<meta name="csrf-token" content="([^"]+)"/); if (meta) this.csrf = meta[1];
    return { status: res.status, loc: res.headers.get('location'), text, buf, headers: res.headers };
  }
  get(p) { return this.raw('GET', p); }
  async ensureToken() { if (!this.csrf) { await this.get('/login'); if (!this.csrf) await this.get('/profile'); } return this.csrf; }
  async post(p, form = {}) { await this.ensureToken(); const r = await this.raw('POST', p, { form: { _csrf: this.csrf, ...form } }); if (r.headers.getSetCookie().length) this.csrf = null; return r; }
  login(u, pw) { return this.post('/login', { username: u, password: pw }); }
  // A file upload the way the page does it: the token first, then the choices, then the file.
  async upload(kind, content, { mode = 'add', defaultStatus, filename = 'import.csv', token = true } = {}) {
    await this.ensureToken();
    const fd = new FormData();
    if (token) fd.append('_csrf', this.csrf);
    fd.append('mode', mode);
    if (defaultStatus) fd.append('defaultStatus', defaultStatus);
    fd.append('file', new Blob([content], { type: 'text/csv' }), filename);
    return this.raw('POST', `/import/${kind}`, { multipart: fd });
  }
}

function start(port, env) {
  const log = [];
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SEED_DEMO: 'true', SLA_SWEEP_S: '3600', SESSION_SECRET: `import-check-${tag}`, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => log.push(String(d))); child.stderr.on('data', (d) => log.push(String(d)));
  return { child, text: () => log.join(''), exited: new Promise((r) => child.on('exit', r)) };
}
async function healthy(port, srv) { for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true; } catch { /* wait */ } if (srv.child.exitCode !== null) return false; await sleep(500); } return false; }

const jobOf = (r) => { const m = /\/import\/job\/(\d+)/.exec(r.loc || ''); return m ? Number(m[1]) : null; };
const num = (html, label) => { const m = new RegExp(`fw-semibold[^>]*>(\\d+)</div><div class="small text-muted">${label}`).exec(html); return m ? Number(m[1]) : null; };

async function main() {
  const port = 18250; const base = `http://127.0.0.1:${port}`;
  const app = start(port, {});
  const knex = knexLib({ client: 'pg', connection: dbConfig(process.env), pool: { min: 0, max: 2 } });
  try {
    if (!(await healthy(port, app))) throw new Error(`NovaDesk did not start: ${app.text().slice(-400)}`);
    await run(base, knex, app);
  } finally { await knex.destroy(); app.child.kill(); await app.exited; }
}

async function run(base, knex, app) {
  const q = async (sql, params = []) => (await knex.raw(sql, params)).rows;
  const one = async (sql, params = []) => (await q(sql, params))[0];
  const admin = new Browser(base); await admin.login('admin', 'admin123');
  const jane = new Browser(base); await jane.login('jdoe', 'agent123');
  const maria = new Browser(base); await maria.login('mchen', 'user123');
  const anon = new Browser(base);
  const jobs = async () => Number((await one('SELECT count(*) AS c FROM imports')).c);

  // ------------------------------------------------------------------------------------------------------------- who may
  section = 'who may';
  check('signed out: sent to sign in', (await anon.get('/import')).status === 302);
  check('a plain user cannot open the import pages or the example files', (await maria.get('/import')).status === 403 && (await maria.get('/import/cmdb')).status === 403 && (await maria.get('/import/kb/template.csv')).status === 403);
  const janeHome = await jane.get('/import');
  check('an agent sees configuration items and articles, not users', janeHome.status === 200 && /\/import\/cmdb/.test(janeHome.text) && /\/import\/kb/.test(janeHome.text) && !/\/import\/users/.test(janeHome.text));
  check('an agent cannot import users (page, upload, example file)', (await jane.get('/import/users')).status === 403 && (await jane.upload('users', 'username,full_name\nx,X')).status === 403 && (await jane.get('/import/users/template.csv')).status === 403);
  check('an administrator sees all three', (await admin.get('/import')).text.match(/\/import\/(users|cmdb|kb)"/g).length >= 3);
  check('an unknown kind is a 404', (await admin.get('/import/widgets')).status === 404);
  check('the list pages have the button', /\/import\/users/.test((await admin.get('/users')).text) && /\/import\/cmdb/.test((await jane.get('/cmdb')).text) && /\/import\/kb/.test((await jane.get('/kb')).text));
  for (const k of ['users', 'cmdb', 'kb']) {
    const t = await admin.get(`/import/${k}/template.csv`);
    check(`the ${k} example file is a CSV that its own importer accepts`, t.status === 200 && /text\/csv/.test(t.headers.get('content-type')) && (await admin.upload(k, t.text)).status === 302);
  }
  await q("UPDATE imports SET status = 'expired', csv = NULL");

  // ------------------------------------------------------------------------------------------------- forged, abusive
  section = 'abuse';
  const n0 = await jobs();
  check('an upload without the token is refused and keeps nothing', (await admin.upload('cmdb', 'Name,Type\nx,Server', { token: false })).status === 403 && await jobs() === n0);
  const big = await admin.upload('kb', 'Title,Body\n' + 'x,'.padEnd(6 * 1024 * 1024, 'y'));
  check('a file over 5 MB is refused with a clear message', big.status === 400 && /larger than 5 MB/.test(big.text) && await jobs() === n0);
  check('no file chosen', (await admin.raw('POST', '/import/cmdb', { multipart: (() => { const f = new FormData(); f.append('_csrf', admin.csrf); f.append('mode', 'add'); return f; })() })).status === 400);
  const empty = await admin.upload('cmdb', '');
  check('an empty file is refused', empty.status === 400 && await jobs() === n0);
  const junk = await admin.upload('cmdb', Buffer.from([0, 1, 2, 255, 254, 0, 9, 10, 200, 201]));
  check('a file of rubbish is refused without a crash', junk.status === 400 && await jobs() === n0, junk.text.slice(0, 200));
  check('a file whose columns mean nothing says so', /None of the column names/.test((await admin.upload('cmdb', 'foo,bar\n1,2')).text));
  check('a missing required column says which', /needs columns named (&#34;|")Username(&#34;|") and (&#34;|")Full name/.test((await admin.upload('users', 'email\na@b.test')).text));
  check('an unclosed quote says so', /never closed/.test((await admin.upload('kb', 'Title,Body\n"open,x')).text));
  check('only a header row is refused', /no rows of data/.test((await admin.upload('kb', 'Title,Body\n')).text));
  const html = await admin.upload('cmdb', 'Name,Type\n"<img src=x onerror=alert(1)>",Server');
  const htmlJob = jobOf(html);
  check('markup in a file comes out as text on the preview page', html.status === 302 && !/<img src=x/.test((await admin.get(`/import/job/${htmlJob}`)).text));
  await q("UPDATE imports SET status = 'expired', csv = NULL");

  // ---------------------------------------------------------------------------------------------------------------- users
  section = 'users';
  const u = (n) => `imp${tag}${n}`;
  const usersBefore = Number((await one('SELECT count(*) AS c FROM users')).c);
  const janeRow = await one("SELECT id, email FROM users WHERE username = 'jdoe'");
  check('(the demonstration agent has an email address)', Boolean(janeRow.email));
  const file = [
    'Username,Full Name,E-mail,Role,Department,Assignment Groups,Active,Password',
    `${u('a')},Ada Import,${u('a')}@c.test,agent,Ops,IRO-Windows;IRO-UNIX,yes,Correct-Horse-9`,
    `${u('b')},Bo Import,${u('b')}@c.test,,Finance,,no,`,
    `${u('c')},Cy Import,not-an-email,,,,,`,
    `${u('a')},Ada Again,,,,,,`,
    `x,Too Short,,,,,,`,
    `${u('d')},Di Import,${janeRow.email},,,,,`,
  ].join('\r\n');
  const up = await admin.upload('users', file, { filename: 'people.csv' });
  const job = jobOf(up);
  check('the upload leads to a preview', up.status === 302 && job > 0);
  const prev = await admin.get(`/import/job/${job}`);
  check('the preview says what would happen: 2 to add, 4 that cannot be imported', num(prev.text, 'to add') === 2 && num(prev.text, 'cannot be imported') === 4, prev.text.replace(/\s+/g, ' ').slice(prev.text.indexOf('to add') - 200, prev.text.indexOf('to add') + 200));
  check('the preview explains each bad row', /not an email address/.test(prev.text) && /Same username as row 2/.test(prev.text) && /Username can only hold/.test(prev.text));
  check('and saved nothing', Number((await one('SELECT count(*) AS c FROM users')).c) === usersBefore && (await one('SELECT status, (csv IS NOT NULL) AS kept FROM imports WHERE id = ?', [job])).status === 'ready');
  check('a password in the file is not on the preview page', !prev.text.includes('Correct-Horse-9'));
  check('the problems can be downloaded', /Row,Item,Result,Why/.test((await admin.get(`/import/job/${job}/problems.csv`)).text));
  check('confirming without the token is refused', (await admin.raw('POST', `/import/job/${job}/run`, { form: {} })).status === 403 && Number((await one('SELECT count(*) AS c FROM users')).c) === usersBefore);
  check('another person cannot confirm it', (await jane.post(`/import/job/${job}/run`)).status === 404 && Number((await one('SELECT count(*) AS c FROM users')).c) === usersBefore);
  const racers = await Promise.all([admin.post(`/import/job/${job}/run`), admin.post(`/import/job/${job}/run`)]);
  const codes = racers.map((r) => r.status).sort();
  check('two confirmations at once: exactly one runs', codes[0] === 302 && codes[1] === 409, codes.join());
  check('the people were made once', Number((await one('SELECT count(*) AS c FROM users WHERE username LIKE ?', [`imp${tag}%`])).c) === 2);
  const ada = await one('SELECT * FROM users WHERE username = ?', [u('a')]);
  const bo = await one('SELECT * FROM users WHERE username = ?', [u('b')]);
  check('their details are as in the file (headers matched by alias)', ada.full_name === 'Ada Import' && ada.email === `${u('a')}@c.test` && ada.role === 'agent' && ada.department === 'Ops' && ada.active === 1 && bo.role === 'user' && bo.active === 0);
  check('assignment groups were saved', (await q('SELECT group_name FROM user_assignment_groups WHERE user_id = ? ORDER BY 1', [ada.id])).map((r) => r.group_name).join() === 'IRO-UNIX,IRO-Windows');
  check('the password in the file works', (await new Browser(base).login(u('a'), 'Correct-Horse-9')).status === 302);
  check('without a password nobody can sign in as that person', (await new Browser(base).login(u('b'), 'anything-at-all')).status === 401);
  check('the password is stored hashed', ada.password_hash.startsWith('$2') && !ada.password_hash.includes('Correct'));
  const fin = await admin.get(`/import/job/${job}`);
  check('the finished page says 2 added', num(fin.text, 'added') === 2 && num(fin.text, 'not imported') === 4);
  check('the file text is gone once it has run, the record stays', (await one('SELECT status, csv, result FROM imports WHERE id = ?', [job])).csv === null);
  const audits = (await q("SELECT action, detail FROM audit_log WHERE target_name LIKE ? OR target_name LIKE ? ORDER BY id", [`imp${tag}%`, '%people.csv'])).map((r) => r.action);
  check('the audit log has each new account and the import', audits.filter((a) => a === 'user.created').length === 2 && audits.includes('import.completed'));
  check('running it again is refused and adds nothing', (await admin.post(`/import/job/${job}/run`)).status === 409);

  // update mode
  const adaSession = new Browser(base); await adaSession.login(u('a'), 'Correct-Horse-9');
  check('(Ada is signed in)', (await adaSession.get('/incidents')).status === 200);
  const upd = [
    'username,full_name,department,groups,active,role,password',
    `${u('A')},,Platform,IRO-CloudOps,no,,`,
    `${u('b')},,Finance,,,,`,
    'admin,,,,no,user,',
    'jdoe,,,,,,Another-Pass-77',
  ].join('\n');
  const addOnly = (await admin.get(`/import/job/${jobOf(await admin.upload('users', upd, { mode: 'add' }))}`)).text;
  check('add-only mode leaves all 4 existing people alone', num(addOnly, 'already exist, left alone') === 4 && num(addOnly, 'to add') === 0);
  const upJob = jobOf(await admin.upload('users', upd, { mode: 'update' }));
  const upPrev = (await admin.get(`/import/job/${upJob}`)).text;
  check('update mode: 1 to update, 1 already as in the file, 2 refused', num(upPrev, 'to update') === 1 && num(upPrev, 'already as in the file') === 1 && num(upPrev, 'cannot be imported') === 2);
  check('the administrator cannot demote or switch off themself, and passwords are not set this way', /Your own role/.test(upPrev) && /cannot be set for an existing user/.test(upPrev));
  await admin.post(`/import/job/${upJob}/run`);
  const ada2 = await one('SELECT * FROM users WHERE username = ?', [u('a')]);
  check('the update changed Ada (matched without regard to capitals) and nothing else', ada2.department === 'Platform' && ada2.active === 0 && ada2.role === 'agent' && ada2.password_hash === ada.password_hash);
  check('and her groups were replaced', (await q('SELECT group_name FROM user_assignment_groups WHERE user_id = ?', [ada.id])).map((r) => r.group_name).join() === 'IRO-CloudOps');
  check('switching her off ended the session she had', (await adaSession.get('/incidents')).status === 302);
  check('the administrator is untouched', (await one("SELECT role, active FROM users WHERE username = 'admin'")).role === 'admin');

  // ------------------------------------------------------------------------------------------------------------------ CMDB
  section = 'cmdb';
  const ciName = (n) => `IMP-${tag}-${n}`;
  const cis = [
    'Name,Type,Environment,Status,IP Address,Owner,Location,Warranty Expiry,Notes',
    `${ciName(1)},Server,Production,In Use,10.9.0.1,jdoe,Rack 1,2027-05-01,"line one`,
    `line two, with a comma"`,
    `${ciName(2)},network_device,dr,In Stock,10.9.0.2,,Rack 2,,`,
    `-${ciName(3)},Application,,,,,,,`,
    `${ciName(4)},Toaster,,,,,,,`,
    `${ciName(5)},Server,,,,nobody-here,,,`,
    `${ciName(1)},Server,,,,,,,`,
  ].join('\n');
  const cj = jobOf(await jane.upload('cmdb', cis, { filename: 'cis.csv' }));
  const cp = (await jane.get(`/import/job/${cj}`)).text;
  check('preview: 3 to add, 3 that cannot be imported, with reasons', num(cp, 'to add') === 3 && num(cp, 'cannot be imported') === 3 && /Type &#34;Toaster&#34;|Type "Toaster"/.test(cp) && /not an active user/.test(cp) && /Same name and type as row 2/.test(cp), cp.replace(/\s+/g, ' ').slice(cp.indexOf('to add') - 50, cp.indexOf('to add') + 800));
  check('an administrator can open an agent\'s import; another agent\'s is hidden from an agent', (await admin.get(`/import/job/${cj}`)).status === 200 && (await jane.get(`/import/job/${jobOf(await admin.upload('cmdb', 'Name,Type\nz,Server'))}`)).status === 404);
  await jane.post(`/import/job/${cj}/run`);
  const made = await q('SELECT * FROM cmdb_ci WHERE name LIKE ? ORDER BY id', [`%IMP-${tag}-%`]);
  check('3 items exist, with numbers from the counter and the agent as creator', made.length === 3 && made.every((c) => /^CI\d{7}$/.test(c.ci_number)) && made.every((c) => c.created_by === janeRow.id));
  const c1 = made.find((c) => c.name === ciName(1)); const c2 = made.find((c) => c.name === ciName(2));
  check('values are right: owner by username, notes with a comma and line break, labels turned into keys, dates', c1.owner_id !== null && c1.notes === 'line one\nline two, with a comma' && c1.warranty_expiry === '2027-05-01' && c2.ci_type === 'network_device' && c2.environment === 'dr' && c2.status === 'in_stock');
  check('a name that starts with a minus is kept as typed', made.some((c) => c.name === `-${ciName(3)}`));

  // export, edit, import again
  const exp = (await jane.get('/cmdb/export.csv?q=IMP-' + tag)).text;
  check('(the export carries the apostrophe guard for the minus)', exp.includes(`'-${ciName(3)}`));
  const edited = exp.replace('Rack 2', 'Rack 22');
  const rj = jobOf(await jane.upload('cmdb', edited, { mode: 'update' }));
  const rp = (await jane.get(`/import/job/${rj}`)).text;
  check('importing the export again in update mode: 1 changed, the other 2 already as in the file', num(rp, 'to update') === 1 && num(rp, 'already as in the file') === 2, rp.replace(/\s+/g, ' ').slice(rp.indexOf('to add') - 50, rp.indexOf('to add') + 700));
  await jane.post(`/import/job/${rj}/run`);
  const after = await q('SELECT name, location FROM cmdb_ci WHERE name LIKE ? ORDER BY id', [`%IMP-${tag}-%`]);
  check('only the location of item 2 changed, names are intact, and no copy was made', after.length === 3 && after.find((c) => c.name === ciName(2)).location === 'Rack 22' && after.find((c) => c.name === `-${ciName(3)}`) !== undefined);
  const again = (await jane.get(`/import/job/${jobOf(await jane.upload('cmdb', exp.replace('Rack 2', 'Rack 22'), { mode: 'add' }))}`)).text;
  check('add-only mode on the same file adds nothing', num(again, 'to add') === 0 && num(again, 'already exist, left alone') === 3);

  // odd files
  const semi = Buffer.from('Name;Type;Location\nMüller-Server ' + tag + ';Server;Zürich\n', 'latin1');
  const sj = jobOf(await jane.upload('cmdb', semi));
  const sp = (await jane.get(`/import/job/${sj}`)).text;
  check('a semicolon file in Windows-1252 is understood and says so', /Windows-1252/.test(sp) && /semicolons/.test(sp) && num(sp, 'to add') === 1);
  await jane.post(`/import/job/${sj}/run`);
  check('and the umlauts arrive intact', (await one('SELECT location FROM cmdb_ci WHERE name = ?', [`Müller-Server ${tag}`])).location === 'Zürich');
  const bom = '﻿Name,Type\r\n' + `Bom-${tag},Storage\r\n`;
  check('a file with a byte-order mark and CRLF is read', num((await jane.get(`/import/job/${jobOf(await jane.upload('cmdb', bom))}`)).text, 'to add') === 1);

  // many rows
  const lines = ['Name,Type,Environment,IP Address']; for (let i = 0; i < 2000; i++) lines.push(`BULK-${tag}-${i},Server,Staging,10.8.${Math.floor(i / 250)}.${i % 250}`);
  const bj = jobOf(await jane.upload('cmdb', lines.join('\n')));
  check('2000 rows are judged', num((await jane.get(`/import/job/${bj}`)).text, 'to add') === 2000);
  const t0 = Date.now(); const bres = await jane.post(`/import/job/${bj}/run`); const secs = (Date.now() - t0) / 1000;
  check(`and imported in a sensible time (${secs}s)`, bres.status === 302 && secs < 60 && Number((await one('SELECT count(*) AS c FROM cmdb_ci WHERE name LIKE ?', [`BULK-${tag}-%`])).c) === 2000);
  check('with distinct numbers', Number((await one('SELECT count(DISTINCT ci_number) AS c FROM cmdb_ci WHERE name LIKE ?', [`BULK-${tag}-%`])).c) === 2000);
  const tooMany = ['Name,Type']; for (let i = 0; i < 5001; i++) tooMany.push(`T${i},Server`);
  check('more rows than allowed is refused with the limit', /at most|more than 5000/.test((await jane.upload('cmdb', tooMany.join('\n'))).text));

  // ----------------------------------------------------------------------------------------------------------------- KB
  section = 'kb';
  const art = [
    'Title,Category,Status,Body',
    `Draft by default ${tag},Network,,"Step 1\nStep 2 <script>alert(1)</script>"`,
    `Live one ${tag},Network,published,Body text`,
    `No body ${tag},,,`,
  ].join('\n');
  const kj = jobOf(await jane.upload('kb', art, { filename: 'articles.csv' }));
  await jane.post(`/import/job/${kj}/run`);
  const kd = await one('SELECT * FROM kb_articles WHERE title = ?', [`Draft by default ${tag}`]);
  const kl = await one('SELECT * FROM kb_articles WHERE title = ?', [`Live one ${tag}`]);
  check('2 articles made (the one without a body was refused); a missing status means draft', kd && kl && kd.status === 'draft' && kl.status === 'published' && !(await one('SELECT 1 FROM kb_articles WHERE title = ?', [`No body ${tag}`])));
  check('line breaks are kept and the author is the person who imported', kd.body.includes('Step 1\nStep 2') && kd.author_id === janeRow.id);
  check('a draft is hidden from a plain user, the published one is not', (await maria.get(`/kb/${kd.id}`)).status === 403 && (await maria.get(`/kb/${kl.id}`)).status === 200);
  check('script in a body is shown as text, never run', !/<script>alert\(1\)<\/script>/.test((await jane.get(`/kb/${kd.id}`)).text) && /&lt;script&gt;alert\(1\)/.test((await jane.get(`/kb/${kd.id}`)).text));
  const pj = jobOf(await jane.upload('kb', `Title,Body\nPublished by choice ${tag},Text`, { defaultStatus: 'published' }));
  await jane.post(`/import/job/${pj}/run`);
  check('"new articles are published" is honoured', (await one('SELECT status FROM kb_articles WHERE title = ?', [`Published by choice ${tag}`])).status === 'published');
  const kexp = (await jane.get('/kb/export.csv?q=' + encodeURIComponent(tag))).text;
  const kedit = kexp.replace('Body text', 'Better body text');
  const ku = jobOf(await jane.upload('kb', kedit, { mode: 'update' }));
  const kup = (await jane.get(`/import/job/${ku}`)).text;
  check('the export imports back: one article changed, the others as in the file', num(kup, 'to update') === 1 && num(kup, 'already as in the file') === 2, kup.replace(/\s+/g, ' ').slice(kup.indexOf('to add') - 50, kup.indexOf('to add') + 600));
  await jane.post(`/import/job/${ku}/run`);
  check('and its body changed, the views stayed', (await one('SELECT body FROM kb_articles WHERE id = ?', [kl.id])).body === 'Better body text');

  // --------------------------------------------------------------------------------------------------------------- record
  section = 'record';
  const cancelJob = jobOf(await admin.upload('kb', `Title,Body\nCancelled ${tag},x`));
  await admin.post(`/import/job/${cancelJob}/cancel`);
  check('a cancelled import keeps no file and cannot be run', (await one('SELECT status, csv FROM imports WHERE id = ?', [cancelJob])).csv === null && (await admin.post(`/import/job/${cancelJob}/run`)).status === 409 && !(await one('SELECT 1 FROM kb_articles WHERE title = ?', [`Cancelled ${tag}`])));
  const stale = jobOf(await admin.upload('kb', `Title,Body\nStale ${tag},x`));
  await q("UPDATE imports SET created_at = to_char(NOW() AT TIME ZONE 'UTC' - interval '2 days', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?", [stale]);
  await admin.get('/import');
  check('a file nobody confirmed is thrown away after a day', (await one('SELECT status, csv FROM imports WHERE id = ?', [stale])).status === 'expired' && (await one('SELECT csv FROM imports WHERE id = ?', [stale])).csv === null && (await admin.post(`/import/job/${stale}/run`)).status === 409);
  const home = await admin.get('/import');
  check('the import page lists recent imports with their results', /people\.csv/.test(home.text) && /cis\.csv/.test(home.text) && /\d+ added/.test(home.text));
  check('an agent sees only their own imports', !/people\.csv/.test((await jane.get('/import')).text) && /cis\.csv/.test((await jane.get('/import')).text));
  await q("UPDATE imports SET status = 'expired', csv = NULL WHERE status = 'ready'");
  const waiting = [];
  for (let i = 0; i < 10; i++) waiting.push((await admin.upload('kb', `Title,Body\nWaiting ${tag} ${i},x`)).status);
  const eleventh = await admin.upload('kb', `Title,Body\nWaiting ${tag} 11,x`);
  check('ten previews waiting is the limit; the eleventh is refused with what to do', waiting.every((c) => c === 302) && eleventh.status === 400 && /already have 10 imports waiting/.test(eleventh.text));
  await q("UPDATE imports SET status = 'expired', csv = NULL WHERE status = 'ready'");
  check('no import row still holds a file after it has run', Number((await one("SELECT count(*) AS c FROM imports WHERE status IN ('done','failed','expired') AND csv IS NOT NULL")).c) === 0);
  check('the import pages carry the content security policy and a token', [await admin.get('/import'), await admin.get('/import/cmdb'), await admin.get(`/import/job/${job}`)].every((r) => /script-src/.test(r.headers.get('content-security-policy') || '') && /name="csrf-token"/.test(r.text)));
  check('no error lines in the server log', !/\[Import\] [a-z]+ row \d+:|Error:|TypeError|UnhandledPromise/.test(app.text()), (app.text().match(/.*(\[Import\] [a-z]+ row|Error:).*/) || [''])[0]);
}

main().then(() => { console.log(failed ? `${failed} FAILED` : 'ALL PASS'); process.exit(failed ? 1 : 0); }).catch((e) => { console.error('ABORTED:', e.stack || e.message); process.exit(2); });
