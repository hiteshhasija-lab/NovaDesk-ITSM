#!/usr/bin/env node
// Privacy tools, end to end, against a copy of NovaDesk that this script starts itself (port 18260) on the database named by
// PGHOST, PGUSER, PGPASSWORD and PGDATABASE: who may use them, the file that hands over what is held about a person (what is
// in it and, as important, what is not), anonymising (what goes, what stays, nothing half-done when it fails, a refusal when
// it should refuse), and retention (limits, the daily sweep, "run now", batches, work in progress left alone).
// Needs the demonstration users. It adds its own people, tickets and log rows and does not remove them.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const knexLib = require('knex');
const { dbConfig } = require('../src/settings');
const { TEXT_PLACES } = require('../src/privacy/scrub');

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
    const text = await res.text();
    const meta = text.match(/<meta name="csrf-token" content="([^"]+)"/); if (meta) this.csrf = meta[1];
    return { status: res.status, loc: res.headers.get('location'), text, headers: res.headers };
  }
  get(p) { return this.raw('GET', p); }
  async ensureToken() { if (!this.csrf) { await this.get('/login'); if (!this.csrf) await this.get('/profile'); } return this.csrf; }
  async post(p, form = {}, { token = true } = {}) { await this.ensureToken(); const r = await this.raw('POST', p, { form: { ...(token ? { _csrf: this.csrf } : {}), ...form } }); if (r.headers.getSetCookie().length) this.csrf = null; return r; }
  login(u, pw) { return this.post('/login', { username: u, password: pw }); }
}

function start(port, env) {
  const log = [];
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SEED_DEMO: 'true', SLA_SWEEP_S: '3600', RETENTION_SWEEP_S: '2', SESSION_SECRET: `privacy-check-${tag}`, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => log.push(String(d))); child.stderr.on('data', (d) => log.push(String(d)));
  return { child, text: () => log.join(''), exited: new Promise((r) => child.on('exit', r)) };
}
async function healthy(port, srv) { for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true; } catch { /* wait */ } if (srv.child.exitCode !== null) return false; await sleep(500); } return false; }

async function main() {
  const port = 18260; const base = `http://127.0.0.1:${port}`;
  const app = start(port, {});
  const knex = knexLib({ client: 'pg', connection: dbConfig(process.env), pool: { min: 0, max: 3 } });
  try {
    if (!(await healthy(port, app))) throw new Error(`NovaDesk did not start: ${app.text().slice(-400)}`);
    await run(base, knex, app);
  } finally { await knex.destroy(); app.child.kill(); await app.exited; }
}

const PASSWORD = 'Subject-pass-1!';
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
const uploadRoot = path.join(ROOT, 'data', 'uploads');

async function run(base, knex, app) {
  const q = async (sql, params = []) => (await knex.raw(sql, params)).rows;
  const one = async (sql, params = []) => (await q(sql, params))[0];
  const count = async (sql, params = []) => Number((await one(sql, params)).c);
  const admin = new Browser(base); await admin.login('admin', 'admin123');
  const jane = new Browser(base); await jane.login('jdoe', 'agent123');
  const maria = new Browser(base); await maria.login('mchen', 'user123');
  const anon = new Browser(base);
  const hash = await bcrypt.hash(PASSWORD, 10);
  const ADMIN_NAME = (await one("SELECT full_name FROM users WHERE username = 'admin'")).full_name;      // the audit log names people by their full name

  // ---------------------------------------------------------------------------------------------------------- seeding
  // Two people with a full footprint, and a bystander whose own words must never be touched.
  const mkUser = async (username, full, email, role = 'agent') => (await one(`INSERT INTO users (username, password_hash, full_name, email, role, department) VALUES (?, ?, ?, ?, ?, 'Facilities') RETURNING id`, [`${username}${tag}`, hash, full, email, role])).id;
  const email = (u) => `${u}${tag}@example.test`;
  const priya = { username: `priya.n${tag}`, name: `Priya Natarajan ${tag}`, email: email('priya.n') };
  const raj = { username: `raj.o${tag}`, name: `Rajesh Okonkwo ${tag}`, email: email('raj.o') };
  priya.id = await mkUser('priya.n', priya.name, priya.email);
  raj.id = await mkUser('raj.o', raj.name, raj.email);
  const tomas = await mkUser('tomas.b', `Tomas Berg ${tag}`, email('tomas.b'));
  const lookalike = `${priya.username}x@other.test`;       // the username as the start of a longer address: must survive

  const uniq = (p) => `${p}-${tag}-${Math.random().toString(36).slice(2, 6)}`;
  const seed = async (who, other) => {
    const n = who === priya ? 'P' : 'R';
    const inc1 = (await one(`INSERT INTO incidents (number, short_description, description, caller_id, assigned_to) VALUES (?, ?, ?, ?, ?) RETURNING id`, [uniq(`INC${n}1`), `Jam on floor 3 (${who.username})`, `Printer jam. Call ${who.name} on extension 5${tag}.`, who.id, other])).id;
    const inc2 = (await one(`INSERT INTO incidents (number, short_description, description, caller_id, assigned_to) VALUES (?, ?, ?, ?, ?) RETURNING id`, [uniq(`INC${n}2`), 'Badge not working', `Tomas's own words: ${who.name} did not report this.`, other, who.id])).id;
    await q(`INSERT INTO incident_comments (incident_id, user_id, comment) VALUES (?, ?, ?), (?, ?, ?)`, [inc1, who.id, `${n}-comment by the person`, inc1, other, `${n}-reply by the bystander`]);
    const ch1 = (await one(`INSERT INTO changes (number, short_description, description, requested_by, assigned_to, approved_by, approved_by_name) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, [uniq(`CHG${n}1`), 'Move switch', `Requested by ${who.name}`, who.id, other, other, null])).id;
    const ch2 = (await one(`INSERT INTO changes (number, short_description, requested_by, assigned_to, approved_by, approved_by_name, vm_destroy_confirmed_by_name) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, [uniq(`CHG${n}2`), 'Patch window', other, who.id, who.id, who.name, who.name.toUpperCase()])).id;
    await q(`INSERT INTO change_comments (change_id, user_id, comment) VALUES (?, ?, ?)`, [ch1, who.id, `${n}-change comment`]);
    await q(`INSERT INTO decom_card_sync (change_id, card_type, desired_status, next_attempt_at, post_payload, last_error) VALUES (?, 'decom_precheck', 'pending', ?, ?, ?)`, [ch2, ago(0), JSON.stringify({ body: `Approved by ${who.name} (${who.email})` }), `could not reach ${who.username}`]);
    const prob = (await one(`INSERT INTO problems (number, short_description, raised_by, assigned_to) VALUES (?, ?, ?, ?) RETURNING id`, [uniq(`PRB${n}`), 'Recurring jams', who.id, other])).id;
    await q(`INSERT INTO problem_comments (problem_id, user_id, comment) VALUES (?, ?, ?)`, [prob, who.id, `${n}-problem comment`]);
    await q(`INSERT INTO service_requests (number, requested_by, notes) VALUES (?, ?, ?)`, [uniq(`REQ${n}`), who.id, `${n}-request notes`]);
    await q(`INSERT INTO cmdb_ci (ci_number, name, ci_type, owner_id, created_by) VALUES (?, ?, 'server', ?, ?)`, [uniq(`CI${n}`), `Printer ${tag}`, who.id, who.id]);
    await q(`INSERT INTO kb_articles (number, title, body, author_id) VALUES (?, ?, ?, ?)`, [uniq(`KB${n}`), `How to clear a jam ${tag}`, `${n}-article body by the person`, who.id]);
    // files: one by the person, one by the bystander whose name contains the person's name
    const dir = path.join(uploadRoot, 'incident'); fs.mkdirSync(dir, { recursive: true });
    const mine = `priv-${tag}-${n}-mine.txt`; const theirs = `priv-${tag}-${n}-theirs.txt`;
    fs.writeFileSync(path.join(dir, mine), 'a file'); fs.writeFileSync(path.join(dir, theirs), 'another file');
    await q(`INSERT INTO attachments (entity_type, entity_id, filename, original_name, mime_type, size, uploaded_by) VALUES ('incident', ?, ?, ?, 'text/plain', 6, ?), ('incident', ?, ?, ?, 'text/plain', 12, ?)`, [inc1, mine, `scan-${n}.txt`, who.id, inc1, theirs, `note for ${who.name}.txt`, other]);
    await q(`INSERT INTO watchers (entity_type, entity_id, user_id) VALUES ('incident', ?, ?)`, [inc2, who.id]);
    await q(`INSERT INTO activity_log (entity_type, entity_id, actor_id, message, actor_name) VALUES ('incident', ?, ?, 'Set status to in_progress', NULL), ('incident', ?, ?, ?, NULL)`, [inc1, who.id, inc1, other, `Assigned to ${who.name} (${who.username})`]);
    const adminId = (await one(`SELECT id FROM users WHERE username = 'admin'`)).id;
    await q(`INSERT INTO audit_log (actor_id, actor_name, action, target_type, target_id, target_name, detail, ip) VALUES
      (?, ?, 'login.success', 'user', ?, ?, 'password', '203.0.113.9'),
      (?, 'Administrator', 'user.updated', 'user', ?, ?, ?, '198.51.100.7')`, [who.id, who.name, who.id, who.username, adminId, who.id, who.username, `email changed to ${who.email}`]);
    await q(`INSERT INTO notifications (recipient_email, recipient_name, subject, body, status) VALUES (?, ?, ?, ?, 'sent'), (?, 'Tomas', ?, ?, 'sent')`, [who.email, who.name, `Your incident ${n} ${tag}`, `Hello ${who.name}, your incident is open.`, email('tomas.b'), `${n} assigned ${tag}`, `${who.name.toLowerCase()} was assigned the incident; contact ${who.email.toUpperCase()}`]);
    await q(`INSERT INTO notifications (recipient_email, subject, body, status) VALUES ('cc@x.test', ?, ?, 'sent')`, [`${n} lookalikes ${tag}`, `cc: x${who.username}, ${who.username}s and ${who.name}s are other people`]);
    await q(`INSERT INTO inbound_emails (message_id, source, from_address, from_name, subject, outcome) VALUES (?, 'imap', ?, ?, ?, 'ticket'), (?, 'imap', ?, 'Somebody Else', 'Not them', 'ignored')`, [uniq(`<m-${n}@x>`), who.email, who.name, `Help from ${who.name}`, uniq(`<l-${n}@x>`), `${who.username}x@other.test`]);
    const wh = (await one(`INSERT INTO webhooks (name, url, secret_enc, events, created_by) VALUES (?, 'https://hooks.example.test/x', 'enc', '*', ?) RETURNING id`, [`Hook by ${n}`, who.id])).id;
    await q(`INSERT INTO webhook_deliveries (webhook_id, event_id, event_type, payload, status, next_attempt_at) VALUES (?, ?, 'incident.created', ?, 'delivered', ?)`, [wh, uniq('evt'), JSON.stringify({ caller: { name: who.name, email: who.email } }), ago(0)]);
    await q(`INSERT INTO imports (kind, filename, user_id, status, preview) VALUES ('users', 'people.csv', ?, 'done', ?)`, [who.id, JSON.stringify({ rows: [{ key: who.username, email: who.email }] })]);
    await q(`INSERT INTO user_identities (user_id, issuer, subject, email) VALUES (?, 'https://sso.example.test', ?, ?)`, [who.id, `sub-${who.username}`, who.email]);
    await q(`INSERT INTO user_mfa (user_id, secret_enc, enabled) VALUES (?, 'SECRET-ENC-MARKER', 1)`, [who.id]);
    await q(`INSERT INTO user_recovery_codes (user_id, code_hash) VALUES (?, 'RECOVERY-HASH-MARKER')`, [who.id]);
    await q(`INSERT INTO user_assignment_groups (user_id, group_name) VALUES (?, 'IRO-Build/Decom')`, [who.id]);
    const key = (await one(`INSERT INTO api_keys (user_id, name, prefix, token_hash) VALUES (?, 'my key', 'nd_abc', ?) RETURNING id`, [who.id, `KEY-HASH-MARKER-${who.username}`])).id;
    await q(`INSERT INTO api_idempotency (key_id, idem_key, request_hash, status, response) VALUES (?, 'k1', 'h', 201, ?)`, [key, JSON.stringify({ caller: who.name })]);
    return { inc1, inc2, ch1, ch2, prob, mine, theirs };
  };

  // Each person signs in for real, so there is a live session to end.
  const priyaBrowser = new Browser(base); await priyaBrowser.login(priya.username, PASSWORD);
  const rajBrowser = new Browser(base); await rajBrowser.login(raj.username, PASSWORD);
  const pr = await seed(priya, tomas);
  const rr = await seed(raj, tomas);
  check('seeding: both people really signed in', (await priyaBrowser.get('/profile')).status === 200 && (await rajBrowser.get('/profile')).status === 200);

  // ------------------------------------------------------------------------------------------------------------ who may
  section = 'who may';
  const P = `/privacy/person/${priya.id}`;
  check('signed out: sent to sign in', (await anon.get('/privacy')).status === 302 && (await anon.get(P)).status === 302);
  for (const [who, b] of [['an agent', jane], ['a plain user', maria]]) {
    check(`${who} cannot open the pages`, (await b.get('/privacy')).status === 403 && (await b.get(P)).status === 403);
    check(`${who} cannot export, anonymise, save limits or run a sweep`,
      (await b.post(`${P}/export`)).status === 403 && (await b.post(`${P}/anonymise`, { confirm: priya.username, understand: 'on' })).status === 403
      && (await b.post('/privacy/retention', { days_audit_log: '60' })).status === 403 && (await b.post('/privacy/retention/run')).status === 403);
  }
  check('nothing happened to the person or the limits meanwhile', (await one('SELECT anonymised_at FROM users WHERE id = ?', [priya.id])).anonymised_at === null && await count('SELECT count(*) AS c FROM retention_rules WHERE keep_days IS NOT NULL') === 0);
  const exportsBefore = await count("SELECT count(*) AS c FROM audit_log WHERE action = 'privacy.exported'");
  check('a forged post without the token is refused and records nothing', (await admin.post(`${P}/export`, {}, { token: false })).status === 403 && (await admin.post(`${P}/anonymise`, { confirm: priya.username, understand: 'on' }, { token: false })).status === 403
    && (await one('SELECT anonymised_at FROM users WHERE id = ?', [priya.id])).anonymised_at === null && await count("SELECT count(*) AS c FROM audit_log WHERE action = 'privacy.exported'") === exportsBefore);
  check('an administrator opens the pages, and the menu links to them', (await admin.get('/privacy')).status === 200 && /href="\/privacy"/.test((await admin.get('/users')).text));
  check('an unknown person is a 404 on every page', (await admin.get('/privacy/person/999999')).status === 404 && (await admin.post('/privacy/person/999999/export')).status === 404 && (await admin.post('/privacy/person/999999/anonymise', { confirm: 'x', understand: 'on' })).status === 404);
  check('a GET never downloads or anonymises', (await admin.get(`${P}/export`)).status === 404 && (await admin.get(`${P}/anonymise`)).status === 404);
  const editPage = await admin.get(`/users/${priya.id}/edit`);
  check('the user\'s own page links to the privacy tools', editPage.status === 200 && editPage.text.includes(`href="${P}"`));

  // ------------------------------------------------------------------------------------------------------------ finding
  section = 'finding';
  const firstWord = priya.name.split(' ')[0];
  const found = await admin.get(`/privacy?q=${encodeURIComponent(priya.username)}`);
  check('search finds a person by username', found.status === 200 && found.text.includes(P) && !found.text.includes(`/privacy/person/${raj.id}"`));
  check('search finds by email', (await admin.get(`/privacy?q=${encodeURIComponent(raj.email)}`)).text.includes(`/privacy/person/${raj.id}"`));
  check('search finds by part of a name, any case', (await admin.get(`/privacy?q=${encodeURIComponent(firstWord.toUpperCase())}`)).text.includes(P));
  check('no search lists nobody', !(await admin.get('/privacy')).text.includes('/privacy/person/'));
  check('a percent sign or underscore is just a character, not "everything"', !(await admin.get('/privacy?q=%25')).text.includes('/privacy/person/') && !(await admin.get('/privacy?q=_')).text.includes('/privacy/person/'));
  check('markup in a search comes out as text', !(await admin.get(`/privacy?q=${encodeURIComponent('<img src=x onerror=alert(1)>')}`)).text.includes('<img src=x'));

  // ------------------------------------------------------------------------------------------------------------- export
  section = 'export';
  const personPage = await admin.get(P);
  check('the person page counts what is held', personPage.status === 200 && /Incidents they reported \(caller\): <strong>1<\/strong>/.test(personPage.text) && /Files they uploaded: <strong>1<\/strong>/.test(personPage.text), personPage.text.slice(0, 200));
  const snapshot = async () => JSON.stringify([await count('SELECT count(*) AS c FROM incidents'), await count('SELECT count(*) AS c FROM notifications'), await count('SELECT count(*) AS c FROM audit_log WHERE action <> ?', ['privacy.exported']), await one('SELECT username, full_name, email, password_hash FROM users WHERE id = ?', [priya.id])]);
  const before = await snapshot();
  const res = await admin.post(`${P}/export`);
  check('the file downloads as JSON, named without the person\'s name, and is never cached', res.status === 200 && /application\/json/.test(res.headers.get('content-type')) && new RegExp(`attachment; filename="novadesk-person-${priya.id}-\\d{8}\\.json"`).test(res.headers.get('content-disposition')) && /no-store/.test(res.headers.get('cache-control')));
  let file = null; try { file = JSON.parse(res.text); } catch (e) { check('the file is valid JSON', false, e.message); }
  file = file || {};
  check('the file says who made it, when, and what it leaves out', file.about && file.about.generated_by === 'admin' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(file.about.generated_at) && file.about.not_included.length >= 3);
  check('the profile is there (and has no password)', file.profile && file.profile.username === priya.username && file.profile.email === priya.email && file.profile.department === 'Facilities' && !('password_hash' in file.profile));
  const t = res.text;
  for (const secret of ['SECRET-ENC-MARKER', 'RECOVERY-HASH-MARKER', `KEY-HASH-MARKER-${priya.username}`, hash]) check(`a secret is never in the file (${secret.slice(0, 14)}...)`, !t.includes(secret));
  check('two-step verification: on, with counts, no secret', file.two_step_verification && file.two_step_verification.enabled === true && file.two_step_verification.recovery_codes === 1 && file.two_step_verification.recovery_codes_used === 0);
  check('their own words are in it (incident they reported, comments, article, request notes)',
    file.incidents_raised.length === 1 && file.incidents_raised[0].description.includes('Printer jam')
    && file.incident_comments.some((c) => c.comment === 'P-comment by the person') && file.change_comments.some((c) => c.comment === 'P-change comment') && file.problem_comments.some((c) => c.comment === 'P-problem comment')
    && file.articles[0].body === 'P-article body by the person' && file.requests_made[0].notes === 'P-request notes');
  check('other people\'s words are not (a reply by someone else, the description of a ticket assigned to them)', !t.includes('P-reply by the bystander') && !t.includes("Tomas's own words"));
  check('tickets assigned to them list the facts only', file.incidents_assigned.length === 1 && !('description' in file.incidents_assigned[0]) && file.changes_assigned.length === 1 && file.problems_assigned.length === 0 && file.changes_approved.length === 1);
  check('records they own, created, follow and uploaded are listed', file.cis_owned.length === 1 && file.cis_created.length === 1 && file.watching.length === 1 && file.attachments.length === 1 && file.attachments[0].original_name === 'scan-P.txt');
  check('sign-in details: SSO link, API key (no hash), open session with address and browser, group', file.sign_in_methods.length === 1 && file.api_keys.length === 1 && file.api_keys[0].prefix === 'nd_abc' && !('token_hash' in file.api_keys[0]) && file.sessions.length >= 1 && file.assignment_groups[0].group_name === 'IRO-Build/Decom');
  check('the audit log both ways: what they did, what was done to the account (with addresses)', file.audit_as_actor.some((a) => a.ip === '203.0.113.9') && file.audit_as_target.some((a) => a.action === 'user.updated' && a.ip === '198.51.100.7'));
  check('activity entries made by them, but not the one someone else wrote about them', file.activity.length === 1 && file.activity[0].message === 'Set status to in_progress');
  check('notices to their address (not those to others), mail they sent (not a look-alike address)', file.notices.length === 1 && file.notices[0].subject === `Your incident P ${tag}` && file.inbound.length === 1 && file.inbound[0].from_address === priya.email && !t.includes(lookalike));
  check('imports and webhooks they made are listed without their contents', file.imports.length === 1 && file.imports[0].filename === 'people.csv' && !('preview' in file.imports[0]) && file.webhooks.length === 1);
  check('exporting changed nothing', await snapshot() === before);
  const exp = await one("SELECT * FROM audit_log WHERE action = 'privacy.exported' ORDER BY id DESC LIMIT 1");
  check('the export is in the audit log: who, about whom', exp && exp.actor_name === ADMIN_NAME && exp.target_id === priya.id && exp.target_name === priya.username && exp.ip);
  check('the file does not include the audit entry about itself being made (it is made before)', !(file.audit_as_target || []).some((a) => a.action === 'privacy.exported' && a.at > file.about.generated_at));

  // ------------------------------------------------------------------------------------------------ anonymise: refusals
  section = 'anonymise: refusals';
  const row = () => one('SELECT * FROM users WHERE id = ?', [priya.id]);
  const was = await row();
  let r = await admin.post(`${P}/anonymise`, { confirm: 'wrong', understand: 'on' });
  check('a wrong confirmation is refused, says why, changes nothing', r.status === 400 && /exactly as shown/.test(r.text) && (await row()).username === was.username);
  r = await admin.post(`${P}/anonymise`, { confirm: priya.username });
  check('without the tick it is refused', r.status === 400 && /cannot be undone/.test(r.text) && (await row()).username === was.username);
  r = await admin.post(`${P}/anonymise`, { confirm: ` ${priya.username} `, understand: 'on', delete_files: undefined });
  check('the typed name is compared as typed (surrounding spaces are forgiven, other characters are not)', r.status === 302);
  // that last one went through: stop here and prove it is Priya before moving on; the rest of the refusals use other people
  check('(that one was a real, accepted request: the person is anonymised now)', (await row()).anonymised_at !== null);
  const adminId = (await one(`SELECT id FROM users WHERE username = 'admin'`)).id;
  check('you cannot anonymise yourself', /own account/.test((await admin.post(`/privacy/person/${adminId}/anonymise`, { confirm: 'admin', understand: 'on' })).text) && (await one('SELECT anonymised_at FROM users WHERE id = ?', [adminId])).anonymised_at === null);
  check('the page does not even offer it for yourself', !/Anonymise<\/button>/.test((await admin.get(`/privacy/person/${adminId}`)).text));
  r = await admin.post(`${P}/anonymise`, { confirm: `anonymised-${priya.id}`, understand: 'on' });
  check('someone already anonymised cannot be anonymised again', r.status === 400 && /already been anonymised/.test(r.text));

  // ------------------------------------------------------------------------------------------------ anonymise: outcome
  section = 'anonymise: outcome';
  const label = `Anonymised user ${priya.id}`;
  const a = await row();
  check('the account is a stranger: name, username, no email, no department, no role, off', a.username === `anonymised-${priya.id}` && a.full_name === label && a.email === null && a.department === null && a.role === 'user' && a.active === 0 && a.email_notifications === 0 && /^\d{4}-/.test(a.anonymised_at));
  check('the password is not what it was', a.password_hash !== hash && !(await bcrypt.compare(PASSWORD, a.password_hash)));
  check('they cannot sign in (old username, new username, old password)', (await new Browser(base).login(priya.username, PASSWORD)).status === 401 && (await new Browser(base).login(`anonymised-${priya.id}`, PASSWORD)).status === 401);
  check('their open sign-in is gone', (await priyaBrowser.get('/profile')).status === 302 && await count('SELECT count(*) AS c FROM sessions WHERE user_id = ?', [priya.id]) === 0);
  check('every way in is removed (single sign-on, two-step, recovery codes, API keys and their stored replies, groups, follows)',
    await count('SELECT count(*) AS c FROM user_identities WHERE user_id = ?', [priya.id]) === 0 && await count('SELECT count(*) AS c FROM user_mfa WHERE user_id = ?', [priya.id]) === 0
    && await count('SELECT count(*) AS c FROM user_recovery_codes WHERE user_id = ?', [priya.id]) === 0 && await count('SELECT count(*) AS c FROM api_keys WHERE user_id = ?', [priya.id]) === 0
    && await count("SELECT count(*) AS c FROM api_idempotency WHERE response LIKE '%Priya%'") === 0
    && await count('SELECT count(*) AS c FROM user_assignment_groups WHERE user_id = ?', [priya.id]) === 0 && await count('SELECT count(*) AS c FROM watchers WHERE user_id = ?', [priya.id]) === 0);
  check('the history stays whole: tickets, comments, requests, articles, items, files still point at the account',
    await count('SELECT count(*) AS c FROM incidents WHERE caller_id = ? OR assigned_to = ?', [priya.id, priya.id]) === 2 && await count('SELECT count(*) AS c FROM incident_comments WHERE user_id = ?', [priya.id]) === 1
    && await count('SELECT count(*) AS c FROM changes WHERE requested_by = ? OR assigned_to = ? OR approved_by = ?', [priya.id, priya.id, priya.id]) === 2 && await count('SELECT count(*) AS c FROM kb_articles WHERE author_id = ?', [priya.id]) === 1
    && await count('SELECT count(*) AS c FROM cmdb_ci WHERE owner_id = ?', [priya.id]) === 1 && await count('SELECT count(*) AS c FROM attachments WHERE uploaded_by = ?', [priya.id]) === 1);
  check('by default their comments and files are kept as they were', (await one('SELECT comment FROM incident_comments WHERE user_id = ?', [priya.id])).comment === 'P-comment by the person' && fs.existsSync(path.join(uploadRoot, 'incident', pr.mine)));
  check('ticket text is not rewritten (it is the work record, and other people wrote some of it)', (await one('SELECT description FROM incidents WHERE id = ?', [pr.inc1])).description.includes(priya.name) && (await one('SELECT description FROM incidents WHERE id = ?', [pr.inc2])).description.includes(priya.name));
  const pages = await admin.get(`/incidents/${pr.inc1}`);
  check('on the ticket they now appear as the anonymous account', pages.status === 200 && pages.text.includes(label));
  // the free text kept around them: gone, in every place, whatever the capitals
  const idents = [[priya.name, 'name'], [priya.email, 'email'], [priya.username, 'username']];
  let leftovers = [];
  for (const place of TEXT_PLACES) for (const col of place.columns) for (const [v] of idents) {
    const c = await count(`SELECT count(*) AS c FROM ${place.table} WHERE ${col} ~* ?`, [`(^|[^[:alnum:]])${v.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&')}(?![[:alnum:]])`]);
    if (c) leftovers.push(`${place.table}.${col} still has ${v}`);
  }
  check('the name, email and username are in no log, notice, inbound record, webhook copy, import record, card or file name', leftovers.length === 0, leftovers.join('; '));
  const nb = (await one('SELECT body FROM notifications WHERE subject = ?', [`P assigned ${tag}`])).body;
  check('both capitals and an email in capitals were found, and the email says [email removed]', nb === `${label} was assigned the incident; contact [email removed]`, nb);
  const webhookPayload = (await one(`SELECT payload FROM webhook_deliveries WHERE payload LIKE '{"caller"%' AND payload LIKE ?`, [`%${label}%`])).payload;     // the one seeded above; the others are real events the seeding caused
  check('activity, approver name, card, inbound subject, file name, webhook, import', (await one("SELECT message FROM activity_log WHERE message LIKE 'Assigned to%' AND entity_id = ?", [pr.inc1])).message === `Assigned to ${label} (${label})`
    && (await one('SELECT approved_by_name, vm_destroy_confirmed_by_name FROM changes WHERE id = ?', [pr.ch2])).approved_by_name === label && (await one('SELECT vm_destroy_confirmed_by_name AS v FROM changes WHERE id = ?', [pr.ch2])).v === label
    && JSON.parse((await one('SELECT post_payload FROM decom_card_sync WHERE change_id = ?', [pr.ch2])).post_payload).body === `Approved by ${label} ([email removed])`
    && (await one("SELECT subject, from_address, from_name FROM inbound_emails WHERE subject LIKE 'Help from%' AND subject LIKE ?", [`%${label}%`])).from_address === '[email removed]'
    && (await one("SELECT original_name FROM attachments WHERE original_name LIKE 'note for%' AND entity_id = ?", [pr.inc1])).original_name === `note for ${label}.txt`
    && (() => { const w = JSON.parse(webhookPayload).caller; return w.name === label && w.email === '[email removed]'; })()
    && JSON.parse((await one("SELECT preview FROM imports WHERE filename = 'people.csv' AND preview LIKE ?", [`%${label}%`])).preview).rows[0].email === '[email removed]');
  check('look-alikes (the username inside a longer address or word, the name inside a longer one) are left alone', await count('SELECT count(*) AS c FROM inbound_emails WHERE from_address = ?', [lookalike]) === 1
    && (await one('SELECT body FROM notifications WHERE subject = ?', [`P lookalikes ${tag}`])).body === `cc: x${priya.username}, ${priya.username}s and ${priya.name}s are other people`);
  check('the address they came from is gone from the audit log, the entries stay', await count('SELECT count(*) AS c FROM audit_log WHERE (actor_id = ? OR (target_type = \'user\' AND target_id = ?)) AND action NOT LIKE \'privacy.%\' AND ip IS NOT NULL', [priya.id, priya.id]) === 0 && await count("SELECT count(*) AS c FROM audit_log WHERE actor_id = ? AND action = 'login.success'", [priya.id]) >= 1);
  const done = await one("SELECT * FROM audit_log WHERE action = 'privacy.anonymised' AND target_id = ?", [priya.id]);
  check('the anonymising is recorded: by whom, about the new name, with counts, and without the old name', done && done.actor_name === ADMIN_NAME && done.target_name === label && /cleaned/.test(done.detail) && !done.detail.includes(priya.name) && !JSON.stringify(done).includes(priya.username));
  check('nobody else was touched', (await one('SELECT full_name, email, username FROM users WHERE id = ?', [tomas])).email === email('tomas.b') && (await one('SELECT comment FROM incident_comments WHERE comment = ?', ['P-reply by the bystander'])).comment === 'P-reply by the bystander' && await count('SELECT count(*) AS c FROM users WHERE anonymised_at IS NOT NULL') === 1);
  const list = await admin.get('/users');
  check('the users list marks them, and Edit becomes Privacy', /anonymised<\/span>/.test(list.text) && list.text.includes(`href="${P}"`));
  check('their edit page goes to the privacy page; saving or changing them is refused', (await admin.get(`/users/${priya.id}/edit`)).loc === P && (await admin.post(`/users/${priya.id}/update`, { username: 'x', full_name: 'X', role: 'admin', active: 'on' })).status === 400 && (await row()).role === 'user');
  const after = await admin.get(P);
  check('the privacy page says so and offers no second anonymising', /was anonymised on/.test(after.text) && !/Anonymise<\/button>/.test(after.text));
  const csvUpload = await (async () => { const fd = new FormData(); await admin.ensureToken(); fd.append('_csrf', admin.csrf); fd.append('mode', 'update'); fd.append('file', new Blob([`username,full_name,role\nanonymised-${priya.id},Back Again,admin\n`], { type: 'text/csv' }), 'x.csv'); return admin.raw('POST', '/import/users', { multipart: fd }); })();
  const csvJob = csvUpload.status === 302 ? await admin.get(csvUpload.loc) : csvUpload;
  check('a CSV import cannot bring them back', csvUpload.status === 302 && /can no longer be changed/.test(csvJob.text) && (await row()).role === 'user', `${csvUpload.status} ${csvUpload.loc} ${csvJob.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300)}`);
  check('an export of an anonymised person still works and holds no identity', (await (async () => { const f = JSON.parse((await admin.post(`${P}/export`)).text); return f.profile.full_name === label && f.profile.email === null && f.profile.anonymised_at; })()));

  // -------------------------------------------------------------------- anonymise: nothing half-done, and the extras
  section = 'anonymise: all or nothing';
  const RJ = `/privacy/person/${raj.id}`;
  await q(`CREATE OR REPLACE FUNCTION priv_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'forced failure'; END $$ LANGUAGE plpgsql`);
  await q(`CREATE TRIGGER priv_fail BEFORE UPDATE ON webhook_deliveries FOR EACH ROW EXECUTE FUNCTION priv_fail()`);
  const rajBefore = JSON.stringify(await one('SELECT * FROM users WHERE id = ?', [raj.id]));
  const rajCounts = async () => JSON.stringify([await count('SELECT count(*) AS c FROM user_identities WHERE user_id = ?', [raj.id]), await count('SELECT count(*) AS c FROM user_mfa WHERE user_id = ?', [raj.id]), await count('SELECT count(*) AS c FROM api_keys WHERE user_id = ?', [raj.id]), await count('SELECT count(*) AS c FROM watchers WHERE user_id = ?', [raj.id]), await count('SELECT count(*) AS c FROM notifications WHERE body LIKE ?', [`%${raj.name}%`]), await count('SELECT count(*) AS c FROM attachments WHERE uploaded_by = ?', [raj.id]), await count("SELECT count(*) AS c FROM incident_comments WHERE comment = 'R-comment by the person'")]);
  const countsBefore = await rajCounts();
  const failing = await admin.post(`${RJ}/anonymise`, { confirm: raj.username, understand: 'on', blank_comments: 'on', delete_files: 'on' });
  check('a failure in the middle shows an error, not success', failing.status >= 500 || failing.status === 400, failing.status);
  check('and nothing at all was changed: the account, sign-in methods, text, comments and files are as they were', JSON.stringify(await one('SELECT * FROM users WHERE id = ?', [raj.id])) === rajBefore && await rajCounts() === countsBefore && fs.existsSync(path.join(uploadRoot, 'incident', rr.mine)));
  check('no "anonymised" entry was written for the failed try', await count("SELECT count(*) AS c FROM audit_log WHERE action = 'privacy.anonymised' AND target_id = ?", [raj.id]) === 0);
  await q('DROP TRIGGER priv_fail ON webhook_deliveries'); await q('DROP FUNCTION priv_fail()');

  section = 'anonymise: the extras';
  const bystanderComment = await count("SELECT count(*) AS c FROM incident_comments WHERE comment = 'R-reply by the bystander'");
  const ok = await admin.post(`${RJ}/anonymise`, { confirm: raj.username, understand: 'on', blank_comments: 'on', delete_files: 'on' });
  check('with the same request after the cause is gone, it goes through', ok.status === 302 && ok.loc === `${RJ}?done=1` && (await one('SELECT anonymised_at FROM users WHERE id = ?', [raj.id])).anonymised_at !== null);
  check('their comments say they were removed, on incidents, changes and problems', await count("SELECT count(*) AS c FROM incident_comments WHERE user_id = ? AND comment LIKE '[comment removed%'", [raj.id]) === 1 && await count("SELECT count(*) AS c FROM change_comments WHERE user_id = ? AND comment LIKE '[comment removed%'", [raj.id]) === 1 && await count("SELECT count(*) AS c FROM problem_comments WHERE user_id = ? AND comment LIKE '[comment removed%'", [raj.id]) === 1);
  check('other people\'s comments are untouched', await count("SELECT count(*) AS c FROM incident_comments WHERE comment = 'R-reply by the bystander'") === bystanderComment && bystanderComment === 1);
  check('the files they uploaded are gone from the database and the disk, with a note on the ticket that has no file name', await count('SELECT count(*) AS c FROM attachments WHERE uploaded_by = ?', [raj.id]) === 0 && !fs.existsSync(path.join(uploadRoot, 'incident', rr.mine)) && await count("SELECT count(*) AS c FROM activity_log WHERE entity_id = ? AND message = 'A file was removed (the account of the person who uploaded it was anonymised)'", [rr.inc1]) === 1);
  check('someone else\'s file on the same ticket stays', fs.existsSync(path.join(uploadRoot, 'incident', rr.theirs)) && await count('SELECT count(*) AS c FROM attachments WHERE filename = ?', [rr.theirs]) === 1);
  check('the record says what was done', /\d+ comments? blanked/.test((await one("SELECT detail FROM audit_log WHERE action = 'privacy.anonymised' AND target_id = ?", [raj.id])).detail) && /1 file deleted/.test((await one("SELECT detail FROM audit_log WHERE action = 'privacy.anonymised' AND target_id = ?", [raj.id])).detail));

  // ---------------------------------------------------------------------------------------------------------- short names
  section = 'short names';
  const shorty = await mkUser('sh', 'Bo', null, 'user');
  const shortyEmail = 'bo-' + tag + '@short.test';
  await q('UPDATE users SET email = ?, username = ? WHERE id = ?', [shortyEmail, `s${tag.slice(0, 1)}`, shorty]);
  const shortPage = await admin.get(`/privacy/person/${shorty}`);
  check('the page warns that a name this short cannot be searched for in text', /shorter than 4 characters/.test(shortPage.text));
  await q(`INSERT INTO notifications (recipient_email, subject, body, status) VALUES ('x@y.test', 'Bo asked', 'Bo and Bob and Bonnie', 'sent')`);
  const shortDone = await admin.post(`/privacy/person/${shorty}/anonymise`, { confirm: (await one('SELECT username FROM users WHERE id = ?', [shorty])).username, understand: 'on' });
  check('it still anonymises the account, and leaves "Bo" alone in the text (it is part of other words)', shortDone.status === 302 && (await one("SELECT body FROM notifications WHERE subject = 'Bo asked'")).body === 'Bo and Bob and Bonnie' && (await one('SELECT email FROM users WHERE id = ?', [shorty])).email === null);
  check('and the record says what was too short', /too short to search for/.test((await one("SELECT detail FROM audit_log WHERE action = 'privacy.anonymised' AND target_id = ?", [shorty])).detail));

  // ------------------------------------------------------------------------------------------------------------ retention
  section = 'retention';
  const lim = (v) => ({ days_audit_log: '', days_notifications: '', days_inbound_emails: '', days_webhook_deliveries: '', ...v });
  const page = await admin.get('/privacy');
  check('the page lists the four kinds, all kept for ever', ['Audit log', 'Email notices', 'Inbound email record', 'Webhook deliveries'].every((x) => page.text.includes(x)) && await count('SELECT count(*) AS c FROM retention_rules WHERE keep_days IS NOT NULL') === 0);
  for (const bad of ['7', '29', 'abc', '99999', '-30', '1.5', '1e3']) {
    const rb = await admin.post('/privacy/retention', lim({ days_notifications: bad }));
    check(`"${bad}" is refused with a message and saves nothing`, rb.status === 400 && /is-invalid|invalid-feedback/.test(rb.text) && await count('SELECT count(*) AS c FROM retention_rules WHERE keep_days IS NOT NULL') === 0);
  }
  check('one bad field saves none of the good ones either', (await admin.post('/privacy/retention', lim({ days_audit_log: '365', days_notifications: '5' }))).status === 400 && await count('SELECT count(*) AS c FROM retention_rules WHERE keep_days IS NOT NULL') === 0);
  check('nothing to run: says so and removes nothing', /No limit is set/.test((await admin.post('/privacy/retention/run')).text));
  const incidentsBefore = await count('SELECT count(*) AS c FROM incidents');
  // old and new rows of each kind
  const fillOld = async () => {
    await q(`INSERT INTO notifications (recipient_email, subject, status, created_at) VALUES ('old@x.test', ?, 'sent', ?), ('old@x.test', ?, 'sent', ?), ('new@x.test', ?, 'sent', ?)`, [`old-${tag}`, ago(120), `old-${tag}`, ago(91), `edge-${tag}`, ago(89)]);
    await q(`INSERT INTO inbound_emails (message_id, source, subject, outcome, received_at) VALUES (?, 'imap', ?, 'ticket', ?), (?, 'imap', ?, 'processing', ?), (?, 'imap', ?, 'ticket', ?)`, [uniq('<o1>'), `old-${tag}`, ago(100), uniq('<o2>'), `busy-${tag}`, ago(100), uniq('<o3>'), `fresh-${tag}`, ago(1)]);
    const wh = (await one(`SELECT id FROM webhooks LIMIT 1`)).id;
    for (const [s, d, n] of [['delivered', 100, 'old-delivered'], ['failed', 100, 'old-failed'], ['pending', 100, 'old-pending'], ['delivered', 1, 'fresh-delivered']]) {
      await q(`INSERT INTO webhook_deliveries (webhook_id, event_id, event_type, payload, status, next_attempt_at, created_at) VALUES (?, ?, 'x', ?, ?, ?, ?)`, [wh, uniq(n), `${n}-${tag}`, s, ago(0), ago(d)]);
    }
    await q(`INSERT INTO audit_log (at, action, detail) VALUES (?, 'test.old', ?), (?, 'test.fresh', ?)`, [ago(400), `old-${tag}`, ago(10), `fresh-${tag}`]);
  };
  await fillOld();
  const saved = await admin.post('/privacy/retention', lim({ days_audit_log: '365', days_notifications: '90', days_inbound_emails: '30', days_webhook_deliveries: '30' }));
  check('valid limits are saved and confirmed', saved.status === 200 && /Saved/.test(saved.text) && await count('SELECT count(*) AS c FROM retention_rules WHERE keep_days IS NOT NULL') === 4 && (await one("SELECT keep_days FROM retention_rules WHERE target = 'notifications'")).keep_days === 90);
  check('the page shows how many are past their limit', /<strong>\d+<\/strong> older than the limit/.test(saved.text));
  check('the change is in the audit log with before and after', /Email notices: kept for ever to 90 days/.test((await one("SELECT detail FROM audit_log WHERE action = 'retention.changed' ORDER BY id DESC LIMIT 1")).detail));
  check('saving the same again says nothing changed and writes no entry', (await (async () => { const n = await count("SELECT count(*) AS c FROM audit_log WHERE action = 'retention.changed'"); const rs = await admin.post('/privacy/retention', lim({ days_audit_log: '365', days_notifications: '90', days_inbound_emails: '30', days_webhook_deliveries: '30' })); return /Nothing changed/.test(rs.text) && n === await count("SELECT count(*) AS c FROM audit_log WHERE action = 'retention.changed'"); })()));

  // the daily sweep (the server looks every 2 seconds here)
  let swept = false; for (let i = 0; i < 20 && !swept; i++) { await sleep(1000); swept = await count('SELECT count(*) AS c FROM notifications WHERE subject = ?', [`old-${tag}`]) === 0; }
  check('the daily sweep removed what is past its limit without anyone asking', swept, app.text().slice(-300));
  check('and only that: notices inside the limit stay, and so do the unfinished (busy mail, pending deliveries) and the fresh',
    await count('SELECT count(*) AS c FROM notifications WHERE subject = ?', [`edge-${tag}`]) === 1
    && await count('SELECT count(*) AS c FROM inbound_emails WHERE subject = ?', [`old-${tag}`]) === 0 && await count('SELECT count(*) AS c FROM inbound_emails WHERE subject = ?', [`busy-${tag}`]) === 1 && await count('SELECT count(*) AS c FROM inbound_emails WHERE subject = ?', [`fresh-${tag}`]) === 1
    && await count("SELECT count(*) AS c FROM webhook_deliveries WHERE payload IN (?, ?)", [`old-delivered-${tag}`, `old-failed-${tag}`]) === 0 && await count('SELECT count(*) AS c FROM webhook_deliveries WHERE payload = ?', [`old-pending-${tag}`]) === 1 && await count('SELECT count(*) AS c FROM webhook_deliveries WHERE payload = ?', [`fresh-delivered-${tag}`]) === 1
    && await count("SELECT count(*) AS c FROM audit_log WHERE detail = ?", [`old-${tag}`]) === 0 && await count("SELECT count(*) AS c FROM audit_log WHERE detail = ?", [`fresh-${tag}`]) === 1);
  const sweepEntry = await one("SELECT * FROM audit_log WHERE action = 'retention.swept' ORDER BY id DESC LIMIT 1");
  check('the sweep recorded itself, and the audit log sweep did not remove that record', sweepEntry && /daily/.test(sweepEntry.detail) && /Audit log 1 removed/.test(sweepEntry.detail) && /Email notices 2 removed/.test(sweepEntry.detail), sweepEntry && sweepEntry.detail);
  const rule = await one("SELECT * FROM retention_rules WHERE target = 'notifications'");
  check('each kind remembers when it ran and how much it removed', rule.last_removed === 2 && /^\d{4}-/.test(rule.last_run_at));
  check('no ticket, comment or history was removed', await count('SELECT count(*) AS c FROM incidents') === incidentsBefore);
  // once a day
  await fillOld(); await sleep(6000);
  check('the daily sweep does not run again the same day (the server looked 3 more times)', await count('SELECT count(*) AS c FROM notifications WHERE subject = ?', [`old-${tag}`]) === 2);
  check('"Run now" does it straight away, and says how much', await (async () => { const rs = await admin.post('/privacy/retention/run'); return /Done: \d+ records? removed/.test(rs.text) && await count('SELECT count(*) AS c FROM notifications WHERE subject = ?', [`old-${tag}`]) === 0; })());
  check('"Run now" is recorded as run by an administrator', /run by an administrator/.test((await one("SELECT detail FROM audit_log WHERE action = 'retention.swept' ORDER BY id DESC LIMIT 1")).detail));
  // batches
  await q(`INSERT INTO notifications (recipient_email, subject, status, created_at) SELECT 'bulk@x.test', ?, 'sent', ? FROM generate_series(1, 12000)`, [`bulk-${tag}`, ago(500)]);
  const bulk = await admin.post('/privacy/retention/run');
  check('a large number is removed in one go (12,000 in batches)', /Done: 12\d{3} records? removed|Done: [1-9]\d* records? removed/.test(bulk.text) && await count('SELECT count(*) AS c FROM notifications WHERE subject = ?', [`bulk-${tag}`]) === 0);
  check('setting a kind back to "for ever" stops its removals', (await admin.post('/privacy/retention', lim({ days_audit_log: '365', days_notifications: '', days_inbound_emails: '30', days_webhook_deliveries: '30' }))).status === 200 && await (async () => { await q(`INSERT INTO notifications (recipient_email, subject, status, created_at) VALUES ('keep@x.test', ?, 'sent', ?)`, [`keep-${tag}`, ago(2000)]); await admin.post('/privacy/retention/run'); return await count('SELECT count(*) AS c FROM notifications WHERE subject = ?', [`keep-${tag}`]) === 1; })());
  const recent = await admin.get('/privacy');
  check('the privacy page lists the recent actions', /privacy\.anonymised/.test(recent.text) && /retention\.swept/.test(recent.text) && /retention\.changed/.test(recent.text));
  check('the server log has no errors from any of this', !/Retention sweep failed|\[Privacy\].*(failed|error)|Error:/i.test(app.text().replace(/forced failure/g, '')) || /forced failure/.test(app.text()), app.text().split('\n').filter((l) => /error|failed/i.test(l) && !/forced failure/.test(l)).slice(-3).join(' | '));

  // Leave the settings as found: other scripts run on this database after this one.
  await q('DELETE FROM retention_rules');
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASS');
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
