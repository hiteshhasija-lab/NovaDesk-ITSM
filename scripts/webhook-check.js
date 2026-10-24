#!/usr/bin/env node
// Webhooks used the way a receiver sees them: a real HTTP receiver that can misbehave, started together with its own
// copy of NovaDesk (ports 18220 to 18223) on the database named by PGHOST, PGUSER, PGPASSWORD and PGDATABASE.
// Checks delivery, signatures (verified here with their own code), the event content against the documented record
// shapes, subscriptions, retries, redirects, switching off, secret rotation and the refusal of unsafe addresses.
'use strict';
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { verifySignature } = require('../src/webhookNet');
const { SHAPES } = require('../src/api/spec');

const ROOT = path.join(__dirname, '..');
const APP_PORT = 18220; const RECEIVER_PORT = 18221; let BASE = `http://127.0.0.1:${APP_PORT}`;
let failed = 0; let section = '';
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  [${section}] ${name}${!ok && extra ? '  -- ' + extra : ''}`); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Math.random().toString(36).slice(2, 8);

class Browser {
  constructor(base = BASE) { this.base = base; this.cookie = ''; }
  async req(method, p, form) {
    const headers = { Cookie: this.cookie }; let body;
    if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = (() => { const sp = new URLSearchParams(); for (const [k, v] of Object.entries(form)) for (const x of (Array.isArray(v) ? v : [v])) sp.append(k, x); return sp.toString(); })(); }
    const res = await fetch(this.base + p, { method, headers, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]; const jar = Object.fromEntries(this.cookie.split('; ').filter(Boolean).map((x) => [x.split('=')[0], x])); jar[kv.split('=')[0]] = kv; this.cookie = Object.values(jar).join('; '); }
    return { status: res.status, loc: res.headers.get('location'), text: await res.text() };
  }
  get(p) { return this.req('GET', p); }
  post(p, f) { return this.req('POST', p, f || {}); }
  async login(u, pw) { const r = await this.post('/login', { username: u, password: pw }); if (r.status !== 302) throw new Error(`sign-in as ${u} failed (${r.status})`); return this; }
}
const makeKey = async (browser, scope) => (await browser.post('/profile/api-keys', { name: `hooks ${tag}`, scope, expires: '30' })).text.match(/id="newApiKey"[^>]*>(ndk_[A-Za-z0-9_-]{40})</)[1];
async function api(token, method, p, body) {
  const res = await fetch(`${BASE}/api/v1${p}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}

// The receiver: records every call and answers as told.
const calls = []; let behavior = { mode: 'ok', failFirst: 0 };
const receiver = http.createServer((req, res) => {
  let body = ''; req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const call = { path: req.url, headers: req.headers, body, at: Date.now() };
    calls.push(call);
    const sameEvent = calls.filter((c) => c.headers['x-novadesk-event-id'] === call.headers['x-novadesk-event-id'] && c.path === call.path).length;
    if (behavior.mode === 'fail500' || (behavior.mode === 'failFirst' && sameEvent <= behavior.failFirst)) { res.writeHead(500); return res.end('boom'); }
    if (behavior.mode === 'redirect') { res.writeHead(302, { Location: `http://127.0.0.1:${RECEIVER_PORT}/elsewhere` }); return res.end(); }
    res.writeHead(200); res.end('ok');
  });
});
const callsOn = (p, type) => calls.filter((c) => c.path === p && (!type || c.headers['x-novadesk-event'] === type));
async function waitFor(fn, ms = 20000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(250); } return null; }

function shapeProblems(name, value, where = name) {
  const shape = SHAPES[name]; const out = [];
  if (!value || typeof value !== 'object') return [`${where} is not an object`];
  for (const k of Object.keys(value)) if (!(k in shape)) out.push(`${where}.${k} is not documented`);
  for (const [k, t] of Object.entries(shape)) { if (!(k in value)) out.push(`${where}.${k} is missing`); else if (SHAPES[t.replace(/\?$/, '')] && value[k]) out.push(...shapeProblems(t.replace(/\?$/, ''), value[k], `${where}.${k}`)); }
  return out;
}

function start(port, env) {
  const log = [];
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SEED_DEMO: 'true', SLA_SWEEP_S: '3600', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => log.push(String(d))); child.stderr.on('data', (d) => log.push(String(d)));
  return { child, text: () => log.join(''), exited: new Promise((r) => child.on('exit', r)) };
}
async function healthy(port, srv) { for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true; } catch { /* wait */ } if (srv.child.exitCode !== null) return false; await sleep(500); } return false; }
const secretOf = (html) => (html.match(/id="newWebhookSecret"[^>]*>(whsec_[A-Za-z0-9_-]+)</) || [])[1];

async function main() {
  await new Promise((r) => receiver.listen(RECEIVER_PORT, '127.0.0.1', r));
  const app = start(APP_PORT, { WEBHOOK_ALLOW_PRIVATE: 'true', WEBHOOK_POLL_S: '1', WEBHOOK_RETRY_DELAYS_S: '1,1,1', WEBHOOK_AUTO_DISABLE_AFTER: '2' });
  try {
    if (!(await healthy(APP_PORT, app))) throw new Error(`NovaDesk did not start: ${app.text().slice(-400)}`);
    await run(app);
  } finally { app.child.kill(); await app.exited; receiver.close(); }
  await refusals();
}

async function run(app) {
  const admin = await new Browser().login('admin', 'admin123');
  const jane = await new Browser().login('jdoe', 'agent123');
  const maria = await new Browser().login('mchen', 'user123');
  // Start clean whatever ran before on this database: no other webhooks, and room for this run's API keys.
  const usersPage = (await admin.get('/users')).text;
  for (const username of ['jdoe', 'mchen']) {
    const row = (usersPage.match(new RegExp(`<tr[^>]*>(?:(?!</tr>)[\\s\\S])*<td>${username}</td>[\\s\\S]*?</tr>`)) || [''])[0];
    const id = (row.match(/\/users\/(\d+)\/edit/) || [])[1];
    if (id) await admin.post(`/users/${id}/api-keys/revoke`);
  }
  for (const m of (await admin.get('/settings/webhooks')).text.matchAll(/\/settings\/webhooks\/(\d+)\/delete/g)) await admin.post(`/settings/webhooks/${m[1]}/delete`);
  const janeKey = await makeKey(jane, 'write'); const mariaKey = await makeKey(maria, 'write');

  section = 'setup';
  check('only administrators can open the webhook settings', (await jane.get('/settings/webhooks')).status === 403 && (await maria.post('/settings/webhooks', { name: 'x', url: 'https://a.test', events: '*' })).status === 403);
  const added = await admin.post('/settings/webhooks', { name: `check ${tag}`, url: `http://127.0.0.1:${RECEIVER_PORT}/hook`, events: ['incident.created', 'incident.status_changed', 'incident.commented', 'request.created'] });
  const secret = secretOf(added.text);
  check('adding one shows the signing secret once', added.status === 200 && secret && secret.length > 40);
  check('...and never again', !secretOf((await admin.get('/settings/webhooks')).text) && (await admin.get('/settings/webhooks')).text.includes(`check ${tag}`));
  check('a webhook needs a name, an address and at least one event', (await admin.post('/settings/webhooks', { name: 'n', url: `http://127.0.0.1:${RECEIVER_PORT}/x` })).status === 400 && (await admin.post('/settings/webhooks', { name: 'n', url: `http://127.0.0.1:${RECEIVER_PORT}/x`, events: ['nonsense.event'] })).status === 400);

  section = 'delivery';
  const hooksPage = (await admin.get('/settings/webhooks')).text;
  const hookId = [...hooksPage.matchAll(/\/settings\/webhooks\/(\d+)\/test/g)][0][1];
  const test = await admin.post(`/settings/webhooks/${hookId}/test`);
  const ping = callsOn('/hook', 'ping')[0];
  check('the test button delivers a signed ping', test.status === 200 && /Test delivered/.test(test.text) && ping && verifySignature(secret, ping.headers['x-novadesk-signature'], ping.body) && JSON.parse(ping.body).type === 'ping');

  const made = await api(janeKey, 'POST', '/incidents', { short_description: `Hook incident ${tag}`, impact: 2, urgency: 2 });
  const incId = made.json.id;
  const created = await waitFor(() => callsOn('/hook', 'incident.created').find((c) => JSON.parse(c.body).data.incident.id === incId));
  check('an incident created over the API reaches the receiver within seconds', Boolean(created));
  const evt = created ? JSON.parse(created.body) : {};
  check('...signed correctly, with the documented headers', created && verifySignature(secret, created.headers['x-novadesk-signature'], created.body) && created.headers['content-type'] === 'application/json' && created.headers['user-agent'] === 'NovaDesk-Webhooks/1' && evt.id === created.headers['x-novadesk-event-id'] && /^evt_[0-9a-f-]{36}$/.test(evt.id) && /^\d+$/.test(created.headers['x-novadesk-delivery']));
  check('...and the body is the documented record, exactly as the API shows it', evt.type === 'incident.created' && /^\d{4}-\d\d-\d\dT[\d:]+Z$/.test(evt.created_at) && shapeProblems('Incident', evt.data && evt.data.incident).length === 0 && evt.data.incident.short_description === `Hook incident ${tag}`, shapeProblems('Incident', evt.data && evt.data.incident).join('; '));
  check('a tampered body or a wrong secret does not verify', created && !verifySignature(secret, created.headers['x-novadesk-signature'], created.body.replace('Hook', 'Hack')) && !verifySignature('whsec_wrong', created.headers['x-novadesk-signature'], created.body));

  await api(janeKey, 'PATCH', `/incidents/${incId}`, { status: 'on_hold' });
  const changed = await waitFor(() => callsOn('/hook', 'incident.status_changed').find((c) => JSON.parse(c.body).data.incident.id === incId));
  const changedEvt = changed ? JSON.parse(changed.body) : {};
  check('a status change says what it was before', changed && changedEvt.data.incident.status === 'on_hold' && changedEvt.previous.status === 'new');
  const before = calls.length;
  await api(janeKey, 'PATCH', `/incidents/${incId}`, { description: 'changed, but not subscribed to' });
  await sleep(3500);
  check('an event the webhook did not ask for is not sent (incident.updated)', !callsOn('/hook', 'incident.updated').length && calls.length === before);

  await api(janeKey, 'POST', `/incidents/${incId}/comments`, { comment: `visible ${tag}` });
  const note = await api(janeKey, 'POST', `/incidents/${incId}/comments`, { comment: `internal ${tag}`, work_note: true });
  const commented = await waitFor(() => callsOn('/hook', 'incident.commented').find((c) => JSON.parse(c.body).comment.comment === `visible ${tag}`));
  await sleep(2500);
  check('a comment is sent with the comment; a work note never is', commented && note.status === 201 && JSON.parse(commented.body).comment.work_note === false && !calls.some((c) => c.body.includes(`internal ${tag}`)));

  const items = await api(mariaKey, 'GET', '/catalog-items');
  const req1 = await api(mariaKey, 'POST', '/requests', { catalog_item_id: items.json.data[0].id, notes: `hook request ${tag}` });
  check('requests: request.created arrives with the record', Boolean(await waitFor(() => callsOn('/hook', 'request.created').find((c) => JSON.parse(c.body).data.request.id === req1.json.id))) && shapeProblems('Request', JSON.parse(callsOn('/hook', 'request.created').slice(-1)[0].body).data.request).length === 0);
  await api(janeKey, 'POST', '/cis', { name: `HOOK-CI-${tag}`, ci_type: 'server' });
  await sleep(3000);
  check('configuration items were not subscribed to, so nothing arrives', !calls.some((c) => c.body.includes(`HOOK-CI-${tag}`)));

  section = 'log';
  const log = (await admin.get(`/settings/webhooks?webhook=${hookId}`)).text;
  check('the log shows the deliveries, with the event names and "Delivered"', log.includes('incident.created') && log.includes('incident.status_changed') && /Delivered/.test(log));
  const deliveryId = [...log.matchAll(/\/settings\/webhooks\/deliveries\/(\d+)/g)][0][1];
  const detail = (await admin.get(`/settings/webhooks/deliveries/${deliveryId}`)).text;
  check('a delivery can be opened to see exactly what was sent', detail.includes('&#34;type&#34;') || detail.includes('"type"'));

  section = 'retries';
  behavior = { mode: 'failFirst', failFirst: 2 };
  const flaky = await api(janeKey, 'POST', '/incidents', { short_description: `Flaky receiver ${tag}`, impact: 3, urgency: 3 });
  const settled = await waitFor(() => { const list = callsOn('/hook', 'incident.created').filter((c) => JSON.parse(c.body).data.incident.id === flaky.json.id); return list.length >= 3 ? list : null; }, 25000);
  check('a receiver that fails twice gets the same event three times, then it is delivered', settled && settled.length === 3 && new Set(settled.map((c) => c.headers['x-novadesk-event-id'])).size === 1 && new Set(settled.map((c) => c.body)).size === 1);
  await sleep(1500);
  check('...and stops once it answers 200', callsOn('/hook', 'incident.created').filter((c) => JSON.parse(c.body).data.incident.id === flaky.json.id).length === 3);
  check('each try has its own fresh timestamp but the same event id', settled && settled[0].headers['x-novadesk-signature'] !== settled[2].headers['x-novadesk-signature'] || settled.every((c) => verifySignature(secret, c.headers['x-novadesk-signature'], c.body)));
  behavior = { mode: 'ok' };

  behavior = { mode: 'redirect' };
  const redirected = await api(janeKey, 'POST', '/incidents', { short_description: `Redirecting receiver ${tag}`, impact: 3, urgency: 3 });
  const gaveUp = await waitFor(async () => { const p = (await admin.get(`/settings/webhooks?webhook=${hookId}`)).text; return /Failed<\/span>[^<]*<span class="text-muted">the receiver answered 302/.test(p) ? p : null; }, 25000);
  check('a redirect is never followed: it fails, with the reason, after the planned tries', Boolean(gaveUp) && !calls.some((c) => c.path === '/elsewhere'));
  check('...a failed delivery is tried 4 times (here: 1 + 3 retries)', callsOn('/hook', 'incident.created').filter((c) => JSON.parse(c.body).data.incident.id === redirected.json.id).length === 4);
  behavior = { mode: 'ok' };
  const failedPage = (await admin.get(`/settings/webhooks?webhook=${hookId}`)).text;
  const failedId = [...failedPage.matchAll(/deliveries\/(\d+)\/retry/g)][0][1];
  const retried = await admin.post(`/settings/webhooks/deliveries/${failedId}/retry`);
  const delivered = await waitFor(() => callsOn('/hook', 'incident.created').filter((c) => JSON.parse(c.body).data.incident.id === redirected.json.id).length >= 5);
  check('Retry on a failed delivery sends it again, and this time it arrives', retried.status === 200 && /queued again/.test(retried.text) && Boolean(delivered));

  section = 'switching off';
  behavior = { mode: 'fail500' };
  const a = await api(janeKey, 'POST', '/incidents', { short_description: `Dead receiver A ${tag}`, impact: 3, urgency: 3 });
  const b = await api(janeKey, 'POST', '/incidents', { short_description: `Dead receiver B ${tag}`, impact: 3, urgency: 3 });
  const off = await waitFor(async () => { const p = (await admin.get('/settings/webhooks')).text; return /Switched off after 2 failed deliveries in a row/.test(p) ? p : null; }, 40000);
  check('after 2 failed deliveries in a row (WEBHOOK_AUTO_DISABLE_AFTER) the webhook switches itself off and says why', Boolean(off) && a.status === 201 && b.status === 201);
  const callsNow = calls.length;
  await api(janeKey, 'POST', '/incidents', { short_description: `After switch-off ${tag}`, impact: 3, urgency: 3 });
  await sleep(3500);
  check('a switched-off webhook is not called and no events pile up for it', calls.length === callsNow && Number((await admin.get('/settings/webhooks')).text.match(/(\d+) waiting/)[1]) === 0);
  behavior = { mode: 'ok' };
  await admin.post(`/settings/webhooks/${hookId}/toggle`);
  const again = await api(janeKey, 'POST', '/incidents', { short_description: `Back on ${tag}`, impact: 3, urgency: 3 });
  check('switching it back on resumes deliveries', Boolean(await waitFor(() => callsOn('/hook', 'incident.created').find((c) => JSON.parse(c.body).data.incident.id === again.json.id))));

  section = 'secrets and several webhooks';
  const rotated = await admin.post(`/settings/webhooks/${hookId}/rotate`);
  const secret2 = secretOf(rotated.text);
  check('a new secret is shown once and is different', secret2 && secret2 !== secret);
  const afterRotate = await api(janeKey, 'POST', '/incidents', { short_description: `After rotation ${tag}`, impact: 3, urgency: 3 });
  const rc = await waitFor(() => callsOn('/hook', 'incident.created').find((c) => JSON.parse(c.body).data.incident.id === afterRotate.json.id));
  check('after rotating, calls are signed with the new secret only', rc && verifySignature(secret2, rc.headers['x-novadesk-signature'], rc.body) && !verifySignature(secret, rc.headers['x-novadesk-signature'], rc.body));

  const second = await admin.post('/settings/webhooks', { name: `all ${tag}`, url: `http://127.0.0.1:${RECEIVER_PORT}/everything`, events: ['*'] });
  const secretAll = secretOf(second.text);
  const multi = await api(janeKey, 'POST', '/incidents', { short_description: `Two receivers ${tag}`, impact: 3, urgency: 3 });
  const [one, two] = await Promise.all([waitFor(() => callsOn('/hook', 'incident.created').find((c) => JSON.parse(c.body).data.incident.id === multi.json.id)), waitFor(() => callsOn('/everything', 'incident.created').find((c) => JSON.parse(c.body).data.incident.id === multi.json.id))]);
  check('one event goes to every webhook that wants it, each signed with its own secret', one && two && one.headers['x-novadesk-event-id'] === two.headers['x-novadesk-event-id'] && verifySignature(secret2, one.headers['x-novadesk-signature'], one.body) && verifySignature(secretAll, two.headers['x-novadesk-signature'], two.body) && !verifySignature(secret2, two.headers['x-novadesk-signature'], two.body));

  section = 'every way of changing a record';
  const chg = await jane.post('/changes', { short_description: `Hook change ${tag}`, description: 'x', change_type: 'normal', risk: 'low', implementation_plan: 'x', backout_plan: 'y' });
  const chgId = (chg.loc || '').match(/\/changes\/(\d+)/)[1];
  await jane.post(`/changes/${chgId}/update`, { short_description: `Hook change ${tag}`, change_type: 'normal', risk: 'low', status: 'submitted', implementation_plan: 'x', backout_plan: 'y' });
  await admin.post(`/changes/${chgId}/approve`, { decision: 'approve' });
  const changeEvents = await waitFor(() => { const list = callsOn('/everything').filter((c) => c.body.includes(`Hook change ${tag}`)).map((c) => JSON.parse(c.body)); return list.some((e) => e.type === 'change.status_changed' && e.previous.status === 'submitted') ? list : null; });
  if (!changeEvents) console.log('  (change events seen:', callsOn('/everything').filter((c) => c.body.includes(`Hook change ${tag}`)).map((c) => { const e = JSON.parse(c.body); return `${e.type} ${e.previous ? e.previous.status + '->' : ''}${e.data.change.status}`; }).join(' | '), ')');
  if (changeEvents) console.log('  (change events:', changeEvents.map((e) => `${e.type} ${e.previous ? e.previous.status + '->' : ''}${e.data.change.status}`).join(' | '), '| shape:', shapeProblems('Change', changeEvents[0].data.change).join('; ') || 'ok', ')');
  check('a change made through the pages: created, submitted and approved all arrive, with the previous status', changeEvents && changeEvents.some((e) => e.type === 'change.created') && changeEvents.some((e) => e.type === 'change.status_changed' && e.previous.status === 'draft' && e.data.change.status === 'submitted') && changeEvents.some((e) => e.type === 'change.status_changed' && e.data.change.status === 'scheduled') && shapeProblems('Change', changeEvents[0].data.change).length === 0);
  await api(janeKey, 'POST', '/cis', { name: `ALL-CI-${tag}`, ci_type: 'server' });
  const ciEvt = await waitFor(() => callsOn('/everything', 'ci.created').find((c) => c.body.includes(`ALL-CI-${tag}`)));
  check('a configuration item made over the API reaches the webhook that asked for everything', Boolean(ciEvt) && shapeProblems('Ci', JSON.parse(ciEvt.body).data.ci).length === 0);
  const kb = await jane.post('/kb', { title: `Hook article ${tag}`, category: 'how-to', status: 'published', body: 'text' });
  check('a knowledge article made through the pages arrives too', Boolean(await waitFor(() => callsOn('/everything', 'article.created').find((c) => c.body.includes(`Hook article ${tag}`)))) && kb.status === 302);
  const prob = await jane.post('/problems', { short_description: `Hook problem ${tag}`, description: 'x', priority: '3' });
  check('and a problem', prob.status === 302 && Boolean(await waitFor(() => callsOn('/everything', 'problem.created').find((c) => c.body.includes(`Hook problem ${tag}`)))));

  section = 'deleting';
  const del = await admin.post(`/settings/webhooks/${hookId}/delete`);
  const countBefore = calls.length;
  await api(janeKey, 'POST', '/incidents', { short_description: `After delete ${tag}`, impact: 3, urgency: 3 });
  await sleep(3000);
  check('a deleted webhook is gone with its log, and is not called again', del.status === 200 && !(await admin.get('/settings/webhooks')).text.includes(`check ${tag}`) && !callsOn('/hook').some((c) => calls.indexOf(c) >= countBefore));
  check('the app logged nothing alarming while all this happened', !/unhandled|TypeError|is not defined|could not fan out|delivery \d+:/i.test(app.text()), (app.text().match(/.*(unhandled|TypeError|is not defined|could not fan out|delivery \d+:).*/i) || [''])[0]);
}

async function refusals() {
  section = 'unsafe addresses';
  const app = start(APP_PORT + 3, {});          // WEBHOOK_ALLOW_PRIVATE not set: the safe default
  try {
    if (!(await healthy(APP_PORT + 3, app))) throw new Error(`NovaDesk did not start: ${app.text().slice(-400)}`);
    BASE = `http://127.0.0.1:${APP_PORT + 3}`;
    const admin = await new Browser(BASE).login('admin', 'admin123');
    const try1 = async (url) => admin.post('/settings/webhooks', { name: 'bad', url, events: '*' });
    for (const [url, pattern] of [
      [`http://127.0.0.1:${RECEIVER_PORT}/hook`, /must start with https/], ['https://127.0.0.1/hook', /private, local or reserved/], ['https://localhost/hook', /private, local or reserved/],
      ['https://169.254.169.254/latest/meta-data/', /private, local or reserved/], ['https://[::1]/hook', /private, local or reserved/], ['https://10.0.0.5/hook', /private, local or reserved/],
      ['https://user:secret@203.0.113.10/hook', /user name or password/], ['ftp://203.0.113.10/hook', /must start with https/], ['not a url', /not a web address/],
    ]) { const r = await try1(url); check(`${url}: refused with a reason`, r.status === 400 && pattern.test(r.text), `${r.status}`); }
    const ok = await try1('https://203.0.113.10/hook');
    check('a public https address is accepted (the form says it must be public)', ok.status === 200 && /Webhook &#34;bad&#34; added|added/.test(ok.text) && /Must start with https:\/\/ and point at a public address/.test(ok.text));
  } finally { app.child.kill(); await app.exited; }
}

main().then(() => { console.log(failed ? `${failed} FAILED` : 'ALL PASS'); process.exit(failed ? 1 : 0); }).catch((e) => { console.error('ABORTED:', e.message); process.exit(2); });
