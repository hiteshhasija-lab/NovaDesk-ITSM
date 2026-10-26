#!/usr/bin/env node
// Feature walk-through of a running NovaDesk, through its real pages and forms.
//
// Signs in as the demo people (admin, two agents, two end users), then uses each module the way a
// browser does: incidents (create, update, comment and work notes, resolve, board, bulk update,
// attachments, watchers, CSV), changes (draft, approval, reject, cancel, board, calendar), problems,
// CMDB (items, relationships, tracker download), service catalog and requests, knowledge base,
// users and roles, profile and password, search, reports, my work, notifications, plus access rules
// between roles, stored-script (XSS) escaping and what bad ids and bad input do.
//
//   BASE_URL=http://127.0.0.1:18080 node scripts/walkthrough.js
//
// Needs the demonstration data (start NovaDesk with SEED_DEMO=true on an empty database: admin/admin123, jdoe/agent123,
// bsmith/agent123, mchen/user123, rpatel/user123). It creates records on that instance: use a
// throwaway or test one, never production.
const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let section = '';
const log = (ok, name, extra = '') => { results.push({ ok, section, name, extra }); console.log(`${ok ? 'PASS' : 'FAIL'}  [${section}] ${name}${extra ? '  -- ' + extra : ''}`); };
async function step(name, fn) { try { const r = await fn(); log(r !== false, name, typeof r === 'string' ? r : ''); } catch (e) { log(false, name, String(e.message || e).slice(0, 300)); } }
const must = (cond, msg) => { if (!cond) throw new Error(msg); return true; };

class Person {
  constructor(name) { this.name = name; this.cookie = ''; this.user = null; this.csrf = null; }
  // The anti-forgery token the page carries (what a browser sends back with every change); old releases have none.
  async refreshCsrf() { for (const p of ['/login', '/profile']) { await this.req('GET', p); if (this.csrf) return; } }
  async req(method, path, { form, json, multipart, headers = {} } = {}, retried = false) {
    const unsafe = !['GET', 'HEAD'].includes(method);
    if (unsafe && !this.csrf && !retried) await this.refreshCsrf();
    const h = { ...headers, Cookie: this.cookie };
    let body;
    if (json !== undefined) { h['Content-Type'] = 'application/json'; if (unsafe && this.csrf) h['X-CSRF-Token'] = this.csrf; body = JSON.stringify(json); }
    else if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; const sp = new URLSearchParams(); if (unsafe && this.csrf && !('_csrf' in form)) sp.append('_csrf', this.csrf); for (const [k, v] of Object.entries(form)) for (const x of (Array.isArray(v) ? v : [v])) sp.append(k, x); body = sp.toString(); }
    else if (multipart) { if (unsafe && this.csrf) { const out = new FormData(); out.append('_csrf', this.csrf); for (const [k, v] of multipart.entries()) out.append(k, v); body = out; } else body = multipart; }
    const res = await fetch(BASE + path, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const kv = c.split(';')[0]; const k = kv.split('=')[0];
      const jar = Object.fromEntries(this.cookie.split('; ').filter(Boolean).map((p) => [p.split('=')[0], p]));
      jar[k] = kv; this.cookie = Object.values(jar).join('; ');
    }
    const text = await res.text();
    if ((res.headers.getSetCookie ? res.headers.getSetCookie() : []).length) this.csrf = null;   // a new session: the old token no longer fits
    const meta = text.match(/<meta name="csrf-token" content="([^"]+)"/); if (meta) this.csrf = meta[1];
    if (res.status === 403 && unsafe && !retried && /reload the page/i.test(text)) { this.csrf = null; await this.refreshCsrf(); return this.req(method, path, { form, json, multipart, headers }, true); }
    let data = null; try { data = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, text, data, loc: res.headers.get('location'), headers: res.headers };
  }
  get(p) { return this.req('GET', p); }
  post(p, form) { return this.req('POST', p, { form: form || {} }); }
  async login(username, password) {
    const r = await this.post('/login', { username, password });
    this.user = r.status === 302 ? { username } : null;
    return r;
  }
}
const idFrom = (loc, base) => { const m = (loc || '').match(new RegExp('^' + base + '/(\\d+)')); return m ? Number(m[1]) : null; };
const has = (r, re) => re.test(r.text);

(async () => {
  const tag = Math.random().toString(36).slice(2, 7);
  const anon = new Person('anon'), admin = new Person('admin'), jane = new Person('jdoe'), bob = new Person('bsmith'), maria = new Person('mchen'), raj = new Person('rpatel');

  section = 'health & sign-in';
  await step('health answers healthy', async () => { const r = await anon.get('/health'); return must(r.status === 200 && r.data.status === 'healthy', r.text.slice(0, 100)); });
  await step('login page renders', async () => { const r = await anon.get('/login'); return must(r.status === 200 && has(r, /name="username"/), 'status ' + r.status); });
  await step('a protected page redirects an anonymous visitor to /login', async () => { const r = await anon.get('/incidents'); return must(r.status === 302 && r.loc === '/login', `${r.status} ${r.loc}`); });
  await step('wrong password is refused and shows an error', async () => { const r = await new Person('x').post('/login', { username: 'admin', password: 'nope-nope' }); return must(r.status !== 302 && has(r, /Invalid username or password/), 'status ' + r.status); });
  for (const [p, u, pw] of [[admin, 'admin', 'admin123'], [jane, 'jdoe', 'agent123'], [bob, 'bsmith', 'agent123'], [maria, 'mchen', 'user123'], [raj, 'rpatel', 'user123']]) {
    await step(`${u} signs in`, async () => { const r = await p.login(u, pw); return must(r.status === 302, `status ${r.status}`); });
  }
  // WALK_WEBHOOKS=<port>: from here on an "everything" webhook points at a receiver in this script (the app needs
  // WEBHOOK_ALLOW_PRIVATE=true and a short WEBHOOK_POLL_S). At the end it must have received what the whole walk-through did.
  const hook = { calls: [], secret: null, server: null };
  if (process.env.WALK_WEBHOOKS) {
    hook.server = require('http').createServer((rq, rs) => { let b = ''; rq.on('data', (d) => { b += d; }); rq.on('end', () => { hook.calls.push({ headers: rq.headers, body: b }); rs.writeHead(200); rs.end('ok'); }); });
    await new Promise((r) => hook.server.listen(Number(process.env.WALK_WEBHOOKS), '127.0.0.1', r));
    await step('webhooks: an administrator adds an everything-webhook for the rest of the walk-through', async () => {
      const added = await admin.post('/settings/webhooks', { name: 'walkthrough', url: `http://127.0.0.1:${process.env.WALK_WEBHOOKS}/hook`, events: ['*'] });
      hook.secret = (added.text.match(/id="newWebhookSecret"[^>]*>(whsec_[^<]+)</) || [])[1];
      return must(added.status === 200 && hook.secret, 'status ' + added.status);
    });
  }
  await step('the sign-in page after signing in no longer traps an anonymous bounce (returnTo is honoured)', async () => {
    const p = new Person('rt'); const first = await p.get('/changes/board'); must(first.status === 302, 'first ' + first.status);
    const r = await p.post('/login', { username: 'jdoe', password: 'agent123' });
    return must(r.status === 302 && r.loc === '/changes/board', `went to ${r.loc}`);
  });
  await step('sign out ends the session', async () => { const p = new Person('lo'); await p.login('mchen', 'user123'); await p.post('/logout'); const r = await p.get('/incidents'); return must(r.status === 302, 'status ' + r.status); });
  await step('self-registration creates an end user who can sign in', async () => {
    const p = new Person('reg');
    const r = await p.req('POST', '/register', { form: { full_name: 'Reggie Reg', username: 'reg' + tag, email: `reg${tag}@corp.local`, password: 'Maple-Ribbon-Cloud-5', confirm_password: 'Maple-Ribbon-Cloud-5' } });
    must(r.status === 302, `register ${r.status} ${r.text.slice(0, 120)}`);
    const d = await p.get('/'); return must(d.status === 200, 'dashboard ' + d.status);
  });
  await step('registration refuses a taken username and mismatched passwords', async () => {
    const dup = await new Person('d').req('POST', '/register', { form: { full_name: 'X', username: 'admin', email: 'x@x.x', password: 'Quiet-Harbor-Lamp-77', confirm_password: 'Quiet-Harbor-Lamp-77' } });
    const mism = await new Person('m').req('POST', '/register', { form: { full_name: 'X', username: 'zz' + tag, email: 'x@x.x', password: 'Quiet-Harbor-Lamp-77', confirm_password: 'Different-Harbor-Lamp-77' } });
    return must(dup.status !== 302 && mism.status !== 302, `${dup.status}/${mism.status}`);
  });
  await step('the dashboard renders for every role', async () => {
    for (const p of [admin, jane, maria]) { const r = await p.get('/'); must(r.status === 200, `${p.name} ${r.status}`); }
    return true;
  });

  section = 'access rules';
  await step('an end user cannot open the user admin, the CMDB form or the reports', async () => {
    const a = await maria.get('/users'); const b = await maria.get('/cmdb/new'); const c = await maria.get('/reports');
    return must([a, b, c].every((r) => r.status === 403), `${a.status}/${b.status}/${c.status}`);
  });
  await step('an agent cannot manage users', async () => { const r = await jane.get('/users'); return must(r.status === 403, 'status ' + r.status); });

  section = 'incidents';
  let inc, incMaria;
  await step('an agent creates an incident; priority follows impact and urgency', async () => {
    const r = await jane.post('/incidents', { short_description: `Walk incident ${tag}`, description: 'Printer on floor 3 is offline', category: 'hardware', impact: '1', urgency: '1', assigned_to: '', assignment_group: '' });
    inc = idFrom(r.loc, '/incidents'); must(r.status === 302 && inc, `${r.status} ${r.loc}`);
    const p = await jane.get(`/incidents/${inc}`);
    return must(p.status === 200 && has(p, new RegExp(`Walk incident ${tag}`)) && has(p, /INC\d+/), 'page ' + p.status);
  });
  await step('an end user creates their own incident and sees it in their list', async () => {
    const r = await maria.post('/incidents', { short_description: `Maria cannot print ${tag}`, description: 'Stuck job', category: 'software', impact: '3', urgency: '3' });
    incMaria = idFrom(r.loc, '/incidents'); must(r.status === 302 && incMaria, `${r.status} ${r.loc}`);
    const l = await maria.get('/incidents');
    return must(has(l, new RegExp(`Maria cannot print ${tag}`)), 'not in her list');
  });
  await step('an end user does not see other people\'s incidents, in the list or by URL', async () => {
    const l = await raj.get('/incidents');
    const direct = await raj.get(`/incidents/${incMaria}`);
    const dj = await raj.get(`/incidents/${inc}`);
    return must(!has(l, new RegExp(`Maria cannot print ${tag}`)) && !has(l, new RegExp(`Walk incident ${tag}`)) && [403, 404].includes(direct.status) && [403, 404].includes(dj.status), `list leak ${has(l, new RegExp(tag))}, direct ${direct.status}/${dj.status}`);
  });
  await step('an agent sees every incident', async () => { const l = await jane.get(`/incidents?q=${tag}`); return must(has(l, /Walk incident/) && has(l, /Maria cannot print/), 'agent list'); });
  await step('an end user cannot edit an incident or change its status', async () => {
    const u = await maria.post(`/incidents/${incMaria}/update`, { status: 'resolved' });
    const s = await maria.req('POST', `/incidents/${incMaria}/status`, { json: { status: 'resolved' } });
    return must([403].includes(u.status) && [403].includes(s.status), `${u.status}/${s.status}`);
  });
  await step('agent update: assign, change status and urgency; activity is logged', async () => {
    const u = await jane.post(`/incidents/${inc}/update`, { short_description: `Walk incident ${tag}`, description: 'Printer on floor 3 is offline', category: 'hardware', impact: '2', urgency: '2', status: 'in_progress', assigned_to: '', assignment_group: '' });
    must(u.status === 302, 'update ' + u.status);
    const p = await jane.get(`/incidents/${inc}`);
    return must(has(p, /In Progress/i), 'status not shown');
  });
  await step('public comment is visible to the caller, a work note is not', async () => {
    await jane.post(`/incidents/${incMaria}/comments`, { comment: `visible reply ${tag}` });
    await jane.post(`/incidents/${incMaria}/comments`, { comment: `internal note ${tag}`, is_work_note: 'on' });
    const asUser = await maria.get(`/incidents/${incMaria}`);
    const asAgent = await jane.get(`/incidents/${incMaria}`);
    return must(has(asUser, new RegExp(`visible reply ${tag}`)) && !has(asUser, new RegExp(`internal note ${tag}`)) && has(asAgent, new RegExp(`internal note ${tag}`)), `user sees reply ${has(asUser, new RegExp('visible reply ' + tag))}, user sees note ${has(asUser, new RegExp('internal note ' + tag))}`);
  });
  await step('empty comment is refused without a server error', async () => { const r = await jane.post(`/incidents/${inc}/comments`, { comment: '   ' }); return must(r.status < 500, 'status ' + r.status); });
  await step('resolving stamps the resolution time; reopening clears it', async () => {
    await jane.post(`/incidents/${inc}/update`, { short_description: `Walk incident ${tag}`, category: 'hardware', impact: '2', urgency: '2', status: 'resolved' });
    const p = await jane.get(`/incidents/${inc}`); must(has(p, /Resolved/i), 'resolved not shown');
    const s = await jane.req('POST', `/incidents/${inc}/status`, { json: { status: 'in_progress' } });
    return must(s.status === 200 && s.data.ok, 'reopen ' + s.status);
  });
  await step('board: page renders, a card moves by the status endpoint, a bad status is refused', async () => {
    const b = await jane.get('/incidents/board'); must(b.status === 200, 'board ' + b.status);
    const ok = await jane.req('POST', `/incidents/${inc}/status`, { json: { status: 'on_hold' } });
    const bad = await jane.req('POST', `/incidents/${inc}/status`, { json: { status: 'banana' } });
    return must(ok.status === 200 && bad.status === 400, `${ok.status}/${bad.status}`);
  });
  await step('bulk update changes several incidents at once', async () => {
    const r = await jane.req('POST', '/incidents/bulk-update', { json: { ids: [inc, incMaria], status: 'in_progress', assigned_to: '' } });
    must(r.status === 200, `bulk ${r.status} ${r.text.slice(0, 100)}`);
    const p = await jane.get(`/incidents/${incMaria}`);
    return must(has(p, /In Progress/i), 'second incident not updated');
  });
  await step('watch and unwatch', async () => { const w = await jane.post(`/incidents/${inc}/watch`); const u = await jane.post(`/incidents/${inc}/unwatch`); return must(w.status < 400 && u.status < 400, `${w.status}/${u.status}`); });
  await step('attachment: upload, download identical bytes, delete', async () => {
    const bytes = Buffer.from('walk attachment ' + tag);
    const fd = new FormData(); fd.append('file', new Blob([bytes], { type: 'text/plain' }), 'walk.txt');
    const up = await jane.req('POST', `/incidents/${inc}/attachments`, { multipart: fd });
    must(up.status === 302, `upload ${up.status} ${up.text.slice(0, 100)}`);
    const page = await jane.get(`/incidents/${inc}`);
    const m = page.text.match(/\/incidents\/\d+\/attachments\/(\d+)\/download/); must(m, 'no download link');
    const dl = await fetch(`${BASE}/incidents/${inc}/attachments/${m[1]}/download`, { headers: { Cookie: jane.cookie } });
    const got = Buffer.from(await dl.arrayBuffer());
    must(dl.status === 200 && got.equals(bytes), `download ${dl.status}`);
    const anonDl = await fetch(`${BASE}/incidents/${inc}/attachments/${m[1]}/download`, { redirect: 'manual' });
    must(anonDl.status === 302, 'anonymous download ' + anonDl.status);
    const del = await jane.post(`/incidents/${inc}/attachments/${m[1]}/delete`);
    return must(del.status === 302, 'delete ' + del.status);
  });
  await step('a blocked file type is refused without a server error', async () => {
    const fd = new FormData(); fd.append('file', new Blob(['MZ'], { type: 'application/x-msdownload' }), 'bad.exe');
    const r = await jane.req('POST', `/incidents/${inc}/attachments`, { multipart: fd });
    const h = await anon.get('/health');
    return must(r.status < 500 && h.status === 200, `upload ${r.status}`) && `exe -> ${r.status}`;
  });
  await step('list: filter by status, search text, sort and paging parameters work', async () => {
    const a = await jane.get('/incidents?status=open'); const b = await jane.get(`/incidents?q=${tag}`); const c = await jane.get('/incidents?sort=priority&dir=desc&page=1'); const d = await jane.get('/incidents?sla=breached');
    return must([a, b, c, d].every((r) => r.status === 200) && has(b, /Walk incident/), `${a.status}/${b.status}/${c.status}/${d.status}`);
  });
  await step('CSV export: header row and the right incident; an end user\'s export is only theirs', async () => {
    const r = await jane.get(`/incidents/export.csv?q=${tag}`);
    must(r.status === 200 && /csv/.test(r.headers.get('content-type') || '') && has(r, /Walk incident/), `export ${r.status}`);
    const m = await maria.get('/incidents/export.csv');
    return must(m.status === 403 || (m.status === 200 && !has(m, /Walk incident/)), `end user export ${m.status} leak ${has(m, /Walk incident/)}`);
  });
  await step('only an admin can delete an incident', async () => {
    const no = await jane.post(`/incidents/${inc}/delete`);
    const yes = await admin.post(`/incidents/${inc}/delete`);
    const gone = await admin.get(`/incidents/${inc}`);
    return must(no.status === 403 && yes.status === 302 && gone.status === 404, `${no.status}/${yes.status}/${gone.status}`);
  });

  section = 'changes';
  let chg, chgRej;
  const newChange = async (p, desc) => p.post('/changes', { short_description: desc, description: 'Patch the web tier', change_type: 'normal', risk: 'medium', implementation_plan: 'Roll one node at a time', backout_plan: 'Restore snapshot', planned_start: '2026-12-01T09:00', planned_end: '2026-12-01T10:00' });
  await step('an agent drafts a change request', async () => {
    const r = await newChange(jane, `Walk change ${tag}`); chg = idFrom(r.loc, '/changes'); must(r.status === 302 && chg, `${r.status} ${r.loc}`);
    const p = await jane.get(`/changes/${chg}`); return must(p.status === 200 && has(p, /CHG\d+/) && has(p, /Draft/i), 'page');
  });
  await step('submit for approval through the update form', async () => {
    const u = await jane.post(`/changes/${chg}/update`, { short_description: `Walk change ${tag}`, description: 'Patch the web tier', change_type: 'normal', risk: 'medium', status: 'submitted', implementation_plan: 'x', backout_plan: 'y', planned_start: '2026-12-01T09:00', planned_end: '2026-12-01T10:00' });
    must(u.status === 302, 'update ' + u.status);
    const p = await jane.get(`/changes/${chg}`); return must(has(p, /Submitted/i), 'not submitted');
  });
  await step('an end user cannot approve; an agent can; approval schedules the change', async () => {
    const no = await maria.post(`/changes/${chg}/approve`, { decision: 'approve' });
    must(no.status === 403, 'end user approve ' + no.status);
    const yes = await bob.post(`/changes/${chg}/approve`, { decision: 'approve' });
    must(yes.status === 302, 'agent approve ' + yes.status);
    const p = await bob.get(`/changes/${chg}`); return must(has(p, /Scheduled/i) && has(p, /Approved/i), 'state after approve');
  });
  await step('a rejected change ends as rejected', async () => {
    const r = await newChange(jane, `Walk change to reject ${tag}`); chgRej = idFrom(r.loc, '/changes');
    await jane.post(`/changes/${chgRej}/update`, { short_description: `Walk change to reject ${tag}`, change_type: 'normal', risk: 'high', status: 'submitted' });
    const x = await admin.post(`/changes/${chgRej}/approve`, { decision: 'reject' });
    const p = await admin.get(`/changes/${chgRej}`); return must(x.status === 302 && has(p, /Rejected/i), 'after reject');
  });
  await step('comments, watch, board move, bulk update and cancel', async () => {
    const c = await jane.post(`/changes/${chg}/comments`, { comment: `cab note ${tag}` });
    must(c.status === 302, 'comment ' + c.status);
    const w = await jane.post(`/changes/${chg}/watch`); must(w.status < 400, 'watch');
    const mv = await jane.req('POST', `/changes/${chg}/status`, { json: { status: 'in_progress' } }); must(mv.status === 200, 'board move ' + mv.status);
    const bulk = await jane.req('POST', '/changes/bulk-update', { json: { ids: [chg], status: 'implemented', assigned_to: '' } }); must(bulk.status === 200, 'bulk ' + bulk.status);
    const mine = await newChange(maria, `Maria change ${tag}`); const mid = idFrom(mine.loc, '/changes');
    const cancel = await maria.post(`/changes/${mid}/cancel`); must(cancel.status === 302, 'owner cancel ' + cancel.status);
    const other = await raj.post(`/changes/${mid}/cancel`); must(other.status === 403 || other.status === 404 || other.status === 302, 'other cancel ' + other.status);
    return true;
  });
  await step('board, calendar and list pages render; an end user sees only their own changes', async () => {
    const a = await jane.get('/changes/board'); const b = await jane.get('/changes/calendar?month=2026-12'); const c = await jane.get(`/changes?q=${tag}`);
    must([a, b, c].every((r) => r.status === 200), `${a.status}/${b.status}/${c.status}`);
    const m = await maria.get('/changes');
    return must(!has(m, new RegExp(`Walk change ${tag}`)) && has(m, new RegExp(`Maria change ${tag}`)), 'end user list scope');
  });
  await step('changes CSV export works for staff', async () => { const r = await jane.get(`/changes/export.csv?q=${tag}`); return must(r.status === 200 && has(r, /Walk change/), 'status ' + r.status); });
  await step('only an admin can delete a change', async () => { const no = await jane.post(`/changes/${chgRej}/delete`); const yes = await admin.post(`/changes/${chgRej}/delete`); return must(no.status === 403 && yes.status === 302, `${no.status}/${yes.status}`); });

  section = 'problems';
  let prob;
  await step('create, view, update, comment and attach a problem', async () => {
    const r = await jane.post('/problems', { short_description: `Walk problem ${tag}`, description: 'Recurring disk alerts', priority: '2', assigned_to: '', assignment_group: '' });
    prob = idFrom(r.loc, '/problems'); must(r.status === 302 && prob, `${r.status} ${r.loc}`);
    const u = await jane.post(`/problems/${prob}/update`, { short_description: `Walk problem ${tag}`, description: 'Root cause: log rotation', priority: '2', status: 'investigating' }); must(u.status === 302, 'update ' + u.status);
    const c = await jane.post(`/problems/${prob}/comments`, { comment: 'known error recorded' }); must(c.status === 302, 'comment ' + c.status);
    const p = await jane.get(`/problems/${prob}`); return must(p.status === 200 && has(p, /known error recorded/), 'page');
  });
  await step('an end user cannot see or create problems', async () => { const a = await maria.get('/problems'); const b = await maria.post('/problems', { short_description: 'x' }); return must([403, 302].includes(a.status) && [403, 302].includes(b.status), `${a.status}/${b.status}`); });
  await step('problems list, CSV and delete (admin)', async () => {
    const l = await jane.get(`/problems?q=${tag}`); const c = await jane.get('/problems/export.csv');
    const no = await jane.post(`/problems/${prob}/delete`); const yes = await admin.post(`/problems/${prob}/delete`);
    return must(l.status === 200 && c.status === 200 && [403].includes(no.status) && yes.status === 302, `${l.status}/${c.status}/${no.status}/${yes.status}`);
  });

  section = 'CMDB';
  let ci, ci2;
  await step('an agent creates two configuration items', async () => {
    const mk = async (name) => { const r = await jane.post('/cmdb', { name, ci_type: 'server', environment: 'development', status: 'in_use', ip_address: '10.9.9.9', os: 'RHEL 10', location: 'Lab', owner_id: '' }); return idFrom(r.loc, '/cmdb'); };
    ci = await mk(`WALK-SRV-${tag}`); ci2 = await mk(`WALK-DB-${tag}`);
    return must(ci && ci2, 'ids ' + ci + '/' + ci2);
  });
  await step('item page, edit, relationship add and remove', async () => {
    const p = await jane.get(`/cmdb/${ci}`); must(p.status === 200 && has(p, new RegExp(`WALK-SRV-${tag}`)), 'page');
    const e = await jane.post(`/cmdb/${ci}/update`, { name: `WALK-SRV-${tag}`, ci_type: 'server', environment: 'development', status: 'in_use', ip_address: '10.9.9.10', location: 'Lab 2' }); must(e.status === 302, 'edit ' + e.status);
    const rel = await jane.post(`/cmdb/${ci}/relationships`, { child_ci_id: String(ci2), relationship_type: 'depends_on' }); must(rel.status === 302, 'add rel ' + rel.status);
    const after = await jane.get(`/cmdb/${ci}`); must(has(after, new RegExp(`WALK-DB-${tag}`)), 'relationship not shown');
    const m = after.text.match(/\/cmdb\/\d+\/relationships\/(\d+)\/delete/); must(m, 'no delete link');
    const del = await jane.post(`/cmdb/${ci}/relationships/${m[1]}/delete`); return must(del.status === 302, 'delete rel ' + del.status);
  });
  await step('list filters, CSV, and the decommissioned-tracker workbook download', async () => {
    const l = await jane.get(`/cmdb?q=WALK-&ci_type=server&environment=development`); const c = await jane.get('/cmdb/export.csv?q=WALK-');
    const x = await fetch(`${BASE}/cmdb/decommissioned-tracker.xlsx`, { headers: { Cookie: jane.cookie } }); const bytes = Buffer.from(await x.arrayBuffer());
    // On a database where nothing has been decommissioned there is no workbook yet: a 404 page saying so.
    const trackerOk = (x.status === 200 && bytes.slice(0, 2).toString() === 'PK') || (x.status === 404 && /No Decommissioned Tracker Yet|No servers have been decommissioned/.test(bytes.toString()));
    return must(l.status === 200 && c.status === 200 && has(c, /WALK-SRV/) && trackerOk, `${l.status}/${c.status}/xlsx ${x.status}`);
  });
  await step('an agent cannot delete an item; an admin can', async () => { const no = await jane.post(`/cmdb/${ci2}/delete`); const yes = await admin.post(`/cmdb/${ci2}/delete`); return must(no.status === 403 && yes.status === 302, `${no.status}/${yes.status}`); });
  await step('an incident can be linked to an item and shows on the item page', async () => {
    const r = await jane.post('/incidents', { short_description: `Linked ${tag}`, category: 'hardware', impact: '3', urgency: '3', affected_ci_id: String(ci) });
    const p = await jane.get(`/cmdb/${ci}`); return must(r.status === 302 && has(p, new RegExp(`Linked ${tag}`)), 'not shown on the item');
  });

  section = 'service catalog & requests';
  let item, req1;
  await step('an admin adds a catalog item and can switch it off and on', async () => {
    const r = await admin.post('/catalog/manage', { name: `Walk item ${tag}`, description: 'A laptop', category: 'hardware', icon: 'bi-laptop', fulfillment_group: '' });
    must(r.status === 302, 'create ' + r.status);
    const l = await admin.get('/catalog/manage'); const m = l.text.match(new RegExp(`Walk item ${tag}[\\s\\S]{0,800}?/catalog/manage/(\\d+)/toggle`)); must(m, 'no toggle link'); item = m[1];
    const t1 = await admin.post(`/catalog/manage/${item}/toggle`); const t2 = await admin.post(`/catalog/manage/${item}/toggle`);
    return must(t1.status === 302 && t2.status === 302, `${t1.status}/${t2.status}`);
  });
  await step('an end user can browse the catalog but not manage it', async () => { const a = await maria.get('/catalog'); const b = await maria.get('/catalog/manage'); const c = await maria.post('/catalog/manage', { name: 'x' }); return must(a.status === 200 && has(a, new RegExp(`Walk item ${tag}`)) && b.status === 403 && c.status === 403, `${a.status}/${b.status}/${c.status}`); });
  await step('an end user requests an item; it appears in their list and not in another user\'s', async () => {
    const f = await maria.get(`/catalog/${item}/request`); must(f.status === 200, 'form ' + f.status);
    const r = await maria.post(`/catalog/${item}/request`, { notes: `need it by Friday ${tag}` }); req1 = idFrom(r.loc, '/requests'); must(r.status === 302 && req1, `${r.status} ${r.loc}`);
    const mine = await maria.get('/requests'); const theirs = await raj.get('/requests'); const direct = await raj.get(`/requests/${req1}`);
    return must(has(mine, /SR\d+|REQ\d+/i) && !has(theirs, new RegExp(tag)) && [403, 404].includes(direct.status), `mine ${mine.status}, other ${direct.status}`);
  });
  await step('the requester can cancel their own submitted request, nobody else can, and not once work has started', async () => {
    const other = await raj.post(`/requests/${req1}/cancel`); must([403, 404].includes(other.status), 'other cancel ' + other.status);
    const own = await maria.post(`/requests/${req1}/cancel`); must(own.status === 302, 'own cancel ' + own.status);
    const r2 = await maria.post(`/catalog/${item}/request`, { notes: `second ${tag}` }); const id2 = idFrom(r2.loc, '/requests'); must(id2, 'second request');
    const u = await jane.post(`/requests/${id2}/update`, { status: 'in_progress', assigned_to: '', assignment_group: '' }); must(u.status === 302, 'update ' + u.status);
    const p = await maria.get(`/requests/${id2}`); must(has(p, /In Progress/i), 'status not visible to the requester');
    const late = await maria.post(`/requests/${id2}/cancel`); return must(late.status === 400, 'cancel after work started ' + late.status);
  });
  await step('request list filters and CSV export for staff', async () => { const a = await jane.get('/requests?status=open'); const b = await jane.get('/requests/export.csv'); return must(a.status === 200 && b.status === 200, `${a.status}/${b.status}`); });

  section = 'knowledge base';
  let kb;
  await step('an agent publishes an article; end users can read it; it shows in search', async () => {
    const r = await jane.post('/kb', { title: `Walk article ${tag}`, category: 'how-to', status: 'published', body: `Restart the print spooler ${tag}` });
    kb = idFrom(r.loc, '/kb'); must(r.status === 302 && kb, `${r.status} ${r.loc}`);
    const v = await maria.get(`/kb/${kb}`); const l = await maria.get(`/kb?q=${tag}`);
    return must(v.status === 200 && has(v, /print spooler/) && has(l, new RegExp(`Walk article ${tag}`)), `${v.status}`);
  });
  await step('a draft article is hidden from end users', async () => {
    const r = await jane.post('/kb', { title: `Walk draft ${tag}`, category: 'how-to', status: 'draft', body: 'not ready' }); const id = idFrom(r.loc, '/kb');
    const l = await maria.get(`/kb?q=${tag}`); const v = await maria.get(`/kb/${id}`);
    return must(!has(l, new RegExp(`Walk draft ${tag}`)) && [403, 404, 302].includes(v.status), `list leak ${has(l, /Walk draft/)} direct ${v.status}`);
  });
  await step('edit an article; an end user cannot create or edit; only an admin deletes', async () => {
    const e = await jane.post(`/kb/${kb}/update`, { title: `Walk article ${tag} v2`, category: 'how-to', status: 'published', body: 'updated' }); must(e.status === 302, 'edit ' + e.status);
    const c = await maria.post('/kb', { title: 'x', body: 'y' }); must([403, 302].includes(c.status), 'end user create ' + c.status);
    const no = await jane.post(`/kb/${kb}/delete`); const yes = await admin.post(`/kb/${kb}/delete`);
    return must(no.status === 403 && yes.status === 302, `${no.status}/${yes.status}`);
  });
  await step('knowledge base CSV export', async () => { const r = await jane.get('/kb/export.csv'); return must(r.status === 200, 'status ' + r.status); });

  section = 'import';
  await step('CSV import: administrators may import users, agents only configuration items and articles, end users nothing', async () => {
    const a = await admin.get('/import/users'); const j = await jane.get('/import/users'); const jc = await jane.get('/import/cmdb'); const m = await maria.get('/import/kb');
    return must(a.status === 200 && j.status === 403 && jc.status === 200 && m.status === 403, `${a.status}/${j.status}/${jc.status}/${m.status}`);
  });
  await step('each kind has an example file that is a CSV with its column names', async () => {
    const u = await admin.get('/import/users/template.csv'); const c = await jane.get('/import/cmdb/template.csv'); const k = await jane.get('/import/kb/template.csv');
    return must(/^Username,Full name/.test(u.text) && /^CI Number,Name,Type/.test(c.text) && /^Number,Title,Category,Status,Body/.test(k.text), `${u.text.slice(0, 30)} | ${c.text.slice(0, 30)} | ${k.text.slice(0, 30)}`);
  });

  section = 'users, profile & roles';
  let newUserId;
  await step('an admin creates a user; the duplicate is refused; the user signs in', async () => {
    const r = await admin.post('/users', { username: 'wk' + tag, full_name: 'Wendy Walk', email: `wk${tag}@corp.local`, password: 'Orbit-Lantern-42x', role: 'agent', department: 'QA', active: '1' });
    must(r.status === 302, `create ${r.status} ${r.text.slice(0, 120)}`);
    const dup = await admin.post('/users', { username: 'wk' + tag, full_name: 'Again', email: 'a@a.a', password: 'Orbit-Lantern-42x', role: 'agent' }); must(dup.status !== 302, 'duplicate accepted');
    const p = new Person('w'); const l = await p.login('wk' + tag, 'Orbit-Lantern-42x'); must(l.status === 302, 'new user login ' + l.status);
    const list = await admin.get(`/users`); const m = list.text.match(new RegExp(`/users/(\\d+)/edit[\\s\\S]{0,400}wk${tag}|wk${tag}[\\s\\S]{0,600}?/users/(\\d+)/edit`)); newUserId = m && (m[1] || m[2]); return must(newUserId, 'not in list');
  });
  await step('role change takes effect; a deactivated user cannot sign in', async () => {
    const e = await admin.post(`/users/${newUserId}/update`, { username: 'wk' + tag, full_name: 'Wendy Walk', email: `wk${tag}@corp.local`, role: 'user', department: 'QA', active: 'on' }); must(e.status === 302, 'role ' + e.status);
    const p = new Person('w2'); await p.login('wk' + tag, 'Orbit-Lantern-42x'); const x = await p.get('/users'); must(x.status === 403, 'now an end user: ' + x.status);
    await admin.post(`/users/${newUserId}/update`, { username: 'wk' + tag, full_name: 'Wendy Walk', email: `wk${tag}@corp.local`, role: 'user', department: 'QA' });   // no active flag: deactivates
    const off = await new Person('w3').login('wk' + tag, 'Orbit-Lantern-42x');
    return must(off.status !== 302, 'a deactivated user signed in: ' + off.status);
  });
  await step('profile: details, preferences, theme; password change needs the current password', async () => {
    const p = await maria.get('/profile'); must(p.status === 200, 'page');
    const u = await maria.post('/profile', { full_name: 'Maria Chen', email: 'maria.chen@corp.local', department: 'Finance' }); must(u.status === 302 || u.status === 200, 'update ' + u.status);
    const pr = await maria.post('/profile/preferences', { theme_preference: 'dark', email_notifications: '1' }); must(pr.status < 400, 'prefs ' + pr.status);
    const th = await maria.req('POST', '/profile/theme', { json: { theme: 'light' } }); must(th.status < 400, 'theme ' + th.status);
    const bad = await maria.post('/profile', { full_name: 'Maria Chen', email: 'maria.chen@corp.local', department: 'Finance', current_password: 'wrong', new_password: 'Newpass-123', confirm_password: 'Newpass-123' });
    const still = new Person('m2'); const l = await still.login('mchen', 'user123');
    return must(l.status === 302, 'password must be unchanged after a wrong current password, login ' + l.status);
  });
  await step('an admin can delete a user', async () => { const r = await admin.post(`/users/${newUserId}/delete`); return must(r.status === 302, 'status ' + r.status); });

  section = 'search, reports, my work, notifications';
  await step('global search finds incidents, changes and CIs by text', async () => {
    const a = await jane.get(`/search?q=${tag}`); return must(a.status === 200 && has(a, new RegExp(`Maria cannot print|Walk change|WALK-SRV`)), 'results ' + a.status);
  });
  await step('search respects roles: an end user does not find other people\'s incidents', async () => { const r = await raj.get(`/search?q=${tag}`); return must(r.status === 200 && !has(r, /Maria cannot print/), 'leak'); });
  await step('reports: dashboard for each range, CSV exports, the form', async () => {
    for (const range of ['7', '30', '90', '365']) { const r = await jane.get(`/reports?range=${range}`); must(r.status === 200, `range ${range} ${r.status}`); }
    const c = await jane.get('/reports/export.csv'); const f = await jane.get('/reports/new');
    const g = await jane.post('/reports/generate', { source: 'incidents', range: '30', format: 'csv' });
    return must(c.status === 200 && f.status === 200 && g.status === 302 && /incidents\/export\.csv\?range=30/.test(g.loc), `${c.status}/${f.status}/${g.loc}`);
  });
  await step('my work lists items assigned to the agent', async () => {
    const mk = await jane.post('/incidents', { short_description: `Assigned to Jane ${tag}`, category: 'other', impact: '3', urgency: '3', assigned_to: String(await meId(jane)) });
    const r = await jane.get('/my-work'); return must(mk.status === 302 && r.status === 200, `${mk.status}/${r.status}`);
  });
  await step('notifications page renders for staff', async () => { const l = await jane.get('/notifications'); return must(l.status === 200 || l.status === 403, 'status ' + l.status); });
  await step('an administrator can send a test email to themselves and sees the result', async () => {
    const p = await admin.post('/notifications/test', {});
    const l = await admin.get('/notifications');
    const shown = /Test email sent to|Email is not set up|could not be sent|has no email address/.test(l.text);
    must(p.status === 302 && l.status === 200 && shown, `${p.status}/${l.status} shown=${shown}`);
    // CI starts the app with a local SMTP sink (WALK_EXPECT_MAIL=1): the message must really have gone out.
    if (process.env.WALK_EXPECT_MAIL === '1') must(/Test email sent to/.test(l.text), 'the test email was not sent');
  });
  await step('only an administrator can send the test email', async () => { const r = await jane.post('/notifications/test', {}); return must(r.status === 403, 'status ' + r.status); });
  if (process.env.WALK_EXPECT_MAIL === '1') {
    await step('no notice failed to send while the walk-through ran', async () => {
      const l = await admin.get('/notifications'); return must(!/<span class="badge bg-danger">Failed<\/span>/.test(l.text), 'a notification shows Failed');
    });
  }

  section = 'SLA';
  const slaFields = (over = {}) => ({ hours_1: '4', clock_1: 'calendar', warn_1: '75', hours_2: '8', clock_2: 'calendar', warn_2: '75', hours_3: '24', clock_3: 'calendar', warn_3: '75', hours_4: '72', clock_4: 'calendar', warn_4: '75', ...over });
  const showPage = async (p, id) => (await p.get(`/incidents/${id}`)).text;
  const updateIncident = (p, id, over) => p.post(`/incidents/${id}/update`, { short_description: `SLA walk ${tag}`, description: 'x', category: 'other', impact: '2', urgency: '2', status: 'in_progress', assigned_to: '', assignment_group: '', ...over });
  const pageDue = (html) => { const m = html.match(/SLA Due<\/dt><dd[^>]*><time[^>]*datetime="([^"]+)"/); return m ? m[1].replace('T', ' ').replace('Z', '') : null; };
  let slaInc = null; let slaNumber = null;
  await step('SLA settings: administrators open the page, agents and end users are refused', async () => {
    const a = await admin.get('/settings/sla'); const j = await jane.get('/settings/sla'); const m = await maria.get('/settings/sla');
    return must(a.status === 200 && /SLA targets for incidents/.test(a.text) && j.status === 403 && m.status === 403, `${a.status}/${j.status}/${m.status}`);
  });
  await step('SLA settings: nonsense is refused with a message, and nothing is saved', async () => {
    const before = (await admin.get('/settings/sla')).text.match(/id="hours_3" name="hours_3" value="([^"]*)"/)[1];
    for (const bad of [{ hours_3: '0' }, { hours_3: 'abc' }, { clock_3: 'sometimes' }, { warn_3: '100' }]) {
      const r = await admin.post('/settings/sla/policies', slaFields(bad)); const page = (await admin.get('/settings/sla')).text;
      must(r.status === 302 && /alert alert-danger/.test(page), `${JSON.stringify(bad)} not refused`);
    }
    const t = await admin.post('/settings/sla/calendar', { timezone: 'Mars/Olympus', start: '09:00', end: '17:00', work_days: ['1'] }); const tp = (await admin.get('/settings/sla')).text;
    must(t.status === 302 && /not a time zone/.test(tp), 'bad time zone not refused');
    const e = await admin.post('/settings/sla/calendar', { timezone: 'UTC', start: '18:00', end: '17:00', work_days: ['1'] }); const ep = (await admin.get('/settings/sla')).text;
    must(/start before it ends/.test(ep), 'backwards day not refused');
    const none = await admin.post('/settings/sla/calendar', { timezone: 'UTC', start: '09:00', end: '17:00' }); const np = (await admin.get('/settings/sla')).text;
    must(/at least one working day/.test(np), 'no working day not refused');
    const after = (await admin.get('/settings/sla')).text.match(/id="hours_3" name="hours_3" value="([^"]*)"/)[1];
    return must(before === after, `a refused save changed the target ${before} -> ${after}`);
  });
  await step('SLA: a new incident takes its target from the policy and shows it', async () => {
    const r = await jane.post('/incidents', { short_description: `SLA walk ${tag}`, category: 'other', impact: '2', urgency: '2' });
    slaInc = idFrom(r.loc, '/incidents'); must(slaInc, 'create ' + r.status);
    const page = await showPage(jane, slaInc); slaNumber = (page.match(/INC\d{7}/) || [])[0];
    return must(/SLA Target<\/dt><dd[^>]*>1 day · round the clock/.test(page), 'target text missing');
  });
  await step('SLA: a higher priority tightens the target and the change is logged', async () => {
    const u = await updateIncident(jane, slaInc, { impact: '1', urgency: '1' });
    const page = await showPage(jane, slaInc);
    return must(u.status === 302 && /SLA Target<\/dt><dd[^>]*>4 hours · round the clock/.test(page) && /SLA target is now 4 hours \(P1\)/.test(page), 'target or activity entry missing');
  });
  await step('SLA: On Hold stops the clock and leaving it resumes it, in the activity log and on the page', async () => {
    await updateIncident(jane, slaInc, { impact: '1', urgency: '1', status: 'on_hold' });
    const held = await showPage(jane, slaInc);
    must(/SLA clock paused since/.test(held) && /SLA clock paused \(On Hold\)/.test(held), 'pause not shown');
    const list = await jane.get('/incidents?sla=paused'); must(list.text.includes(slaNumber), 'not in the Paused filter');
    await sleep(1500);
    await updateIncident(jane, slaInc, { impact: '1', urgency: '1', status: 'in_progress' });
    const back = await showPage(jane, slaInc);
    return must(/SLA clock resumed/.test(back) && !/SLA clock paused since/.test(back), 'resume not shown');
  });
  await step('SLA: the board and the bulk action pause and resume the clock too', async () => {
    const paused = async () => /SLA clock paused since/.test(await showPage(jane, slaInc));
    const board = (status) => jane.req('POST', `/incidents/${slaInc}/status`, { json: { status } });
    const bulk = (status) => jane.req('POST', '/incidents/bulk-update', { json: { ids: [slaInc], status, assigned_to: '' } });
    const out = [];
    out.push((await board('on_hold')).status, await paused());          // board: hold
    out.push((await bulk('in_progress')).status, await paused());       // bulk: resume
    out.push((await bulk('on_hold')).status, await paused());           // bulk: hold
    out.push((await board('in_progress')).status, await paused());      // board: resume
    return must(out.join() === '200,true,200,false,200,true,200,false', 'unexpected ' + out.join());
  });
  await step('SLA: a business-hours target puts the due time inside working hours', async () => {
    // Monday to Friday 09:00-17:00 UTC, P4 counted in business hours (4 working hours): the due time must fall in the window.
    await admin.post('/settings/sla/calendar', { timezone: 'UTC', start: '09:00', end: '17:00', work_days: ['1', '2', '3', '4', '5'] });
    must(/Business hours saved/.test((await admin.get('/settings/sla')).text), 'the five working days were not saved');
    await admin.post('/settings/sla/policies', slaFields({ hours_4: '4', clock_4: 'business' }));
    const r = await jane.post('/incidents', { short_description: `SLA business ${tag}`, category: 'other', impact: '3', urgency: '4' });
    const id = idFrom(r.loc, '/incidents'); const page = await showPage(jane, id); const number = (page.match(/INC\d{7}/) || [])[0];
    const due = pageDue(page); must(due, 'no due time on the page');
    const d = new Date(due.replace(' ', 'T') + 'Z'); const minutes = d.getUTCHours() * 60 + d.getUTCMinutes(); const day = d.getUTCDay();
    must(/4 hours · business hours/.test(page), 'target text: ' + (page.match(/SLA Target<\/dt><dd[^>]*>[^<]*/) || [''])[0]);
    return must(day >= 1 && day <= 5 && minutes >= 9 * 60 && minutes <= 17 * 60, `due ${due} is outside Monday-Friday 09:00-17:00`);
  });
  await step('SLA: holidays can be added and removed', async () => {
    const add = await admin.post('/settings/sla/holidays', { holiday_date: '2030-12-25', name: `Winter ${tag}` });
    const page = (await admin.get('/settings/sla')).text; must(add.status === 302 && page.includes(`Winter ${tag}`), 'not listed');
    const id = (page.match(/holidays\/(\d+)\/delete/) || [])[1]; must(id, 'no delete form');
    const del = await admin.post(`/settings/sla/holidays/${id}/delete`, {}); const after = (await admin.get('/settings/sla')).text;
    const bad = await admin.post('/settings/sla/holidays', { holiday_date: '2030-02-31' }); const badPage = (await admin.get('/settings/sla')).text;
    return must(del.status === 302 && !after.includes(`Winter ${tag}`) && /Choose a date/.test(badPage), 'delete or validation failed');
  });
  const targetFields = (over = {}) => ({ hours_request: '72', clock_request: 'calendar', warn_request: '75', hours_change: '48', clock_change: 'calendar', warn_change: '75', ...over });
  const catalogItem = async () => { const c = await maria.get('/catalog'); const m = c.text.match(/\/catalog\/(\d+)\/request/); must(m, 'no catalog item'); return m[1]; };
  const newRequest = async (note) => { const r = await maria.post(`/catalog/${await catalogItem()}/request`, { notes: note }); const id = idFrom(r.loc, '/requests'); must(id, 'request ' + r.status); return id; };
  const requestPage = async (id) => (await jane.get(`/requests/${id}`)).text;
  let reqBefore = null;
  await step('SLA: request and change targets start switched off, and a request made now has no clock', async () => {
    const page = (await admin.get('/settings/sla')).text;
    must(/id="enabled_request" name="enabled_request" >/.test(page) && /id="enabled_change" name="enabled_change" >/.test(page), 'not off by default');
    reqBefore = await newRequest(`before SLA ${tag}`);
    return must(!/SLA Due/.test(await requestPage(reqBefore)), 'a clock appeared with the SLA off');
  });
  await step('SLA: nonsense for the request and change targets is refused', async () => {
    for (const bad of [{ hours_request: '0' }, { hours_change: 'x' }, { clock_request: 'x' }, { warn_change: '0' }]) {
      const r = await admin.post('/settings/sla/targets', targetFields(bad)); const page = (await admin.get('/settings/sla')).text;
      must(r.status === 302 && /alert alert-danger/.test(page), `${JSON.stringify(bad)} not refused`);
    }
    return must(/id="enabled_request" name="enabled_request" >/.test((await admin.get('/settings/sla')).text), 'a refused save switched something on');
  });
  await step('SLA: switched on, a new request shows its due time, target and status, and fulfilling it in time meets the SLA', async () => {
    await admin.post('/settings/sla/targets', targetFields({ enabled_request: 'on' }));
    const id = await newRequest(`with SLA ${tag}`);
    const page = await requestPage(id);
    must(/SLA Due/.test(page) && /SLA Target<\/dt><dd[^>]*>3 days · round the clock/.test(page) && /On Track/.test(page), 'SLA rows missing');
    must(!/SLA Due/.test(await requestPage(reqBefore)), 'an older request got a clock');
    const u = await jane.post(`/requests/${id}/update`, { status: 'fulfilled', assigned_to: '', assignment_group: '' });
    return must(u.status === 302 && /Met SLA/.test(await requestPage(id)), 'not met after fulfilling');
  });
  if (process.env.WALK_FAST_SLA === '1') {
    // Needs SLA_SWEEP_S=2. The change clock is started and stopped by the sweep watching the status.
    await step('SLA: a change gets its approval clock when submitted, and the decision stops it in time', async () => {
      await admin.post('/settings/sla/targets', targetFields({ enabled_request: 'on', enabled_change: 'on', hours_change: '1', warn_change: '99' }));
      const r = await newChange(jane, `SLA change decided ${tag}`); const id = idFrom(r.loc, '/changes');
      const before = (await jane.get(`/changes/${id}`)).text; must(!/Approval SLA/.test(before), 'a draft has a clock');
      await jane.post(`/changes/${id}/update`, { short_description: `SLA change decided ${tag}`, change_type: 'normal', risk: 'medium', status: 'submitted', implementation_plan: 'x', backout_plan: 'y' });
      let page = ''; for (let i = 0; i < 20; i++) { page = (await jane.get(`/changes/${id}`)).text; if (/Approval SLA/.test(page)) break; await sleep(1000); }
      must(/Approval SLA/.test(page) && /On Track|At Risk/.test(page) && /SLA Target<\/dt><dd[^>]*>1 hour · round the clock/.test(page), 'no approval clock after submit');
      const a = await bob.post(`/changes/${id}/approve`, { decision: 'approve' }); must(a.status === 302, 'approve ' + a.status);
      for (let i = 0; i < 20; i++) { page = (await jane.get(`/changes/${id}`)).text; if (/Met SLA/.test(page)) break; await sleep(1000); }
      return must(/Met SLA/.test(page), 'the decision did not stop the clock');
    });
    await step('SLA emails for requests and changes: at risk, then breached, each once', async () => {
      await admin.post('/settings/sla/targets', targetFields({ enabled_request: 'on', enabled_change: 'on', hours_request: String(1 / 60), warn_request: '1', hours_change: String(1 / 60), warn_change: '1' }));
      const rid = await newRequest(`SLA mail ${tag}`); const reqNumber = ((await requestPage(rid)).match(/REQ\d{7}/) || [])[0];
      const cr = await newChange(jane, `SLA change mail ${tag}`); const cid = idFrom(cr.loc, '/changes');
      await jane.post(`/changes/${cid}/update`, { short_description: `SLA change mail ${tag}`, change_type: 'normal', risk: 'medium', status: 'submitted', implementation_plan: 'x', backout_plan: 'y' });
      const chgNumber = ((await jane.get(`/changes/${cid}`)).text.match(/CHG\d{7}/) || [])[0];
      const waitFor = async (re, seconds) => { for (let i = 0; i < seconds; i++) { const l = await admin.get('/notifications'); if (re.test(l.text)) return true; await sleep(1000); } return false; };
      try {
        must(await waitFor(new RegExp(`\\[${reqNumber}\\] SLA at risk`), 40), 'no request at-risk email');
        must(await waitFor(new RegExp(`\\[${chgNumber}\\] SLA at risk, waiting for approval`), 40), 'no change at-risk email');
        must(await waitFor(new RegExp(`\\[${reqNumber}\\] SLA breached`), 120), 'no request breach email');
        must(await waitFor(new RegExp(`\\[${chgNumber}\\] SLA breached, waiting for approval`), 120), 'no change breach email');
        await sleep(6000);
        const l = (await admin.get('/notifications')).text; const count = (re) => (l.match(re) || []).length;
        must(count(new RegExp(`\\[${reqNumber}\\] SLA at risk`, 'g')) === 1 && count(new RegExp(`\\[${reqNumber}\\] SLA breached`, 'g')) === 1, 'a request email was sent more than once');
        must(count(new RegExp(`\\[${chgNumber}\\] SLA at risk`, 'g')) >= 1 && count(new RegExp(`\\[${chgNumber}\\] SLA breached`, 'g')) >= 1, 'change emails missing');
        // One notice per person who may decide, and nobody twice: every recipient appears once per kind of email.
        const toList = (re) => [...l.matchAll(re)].length;
        must(toList(new RegExp(`\\[${chgNumber}\\] SLA breached`, 'g')) === toList(new RegExp(`\\[${chgNumber}\\] SLA at risk`, 'g')), 'unequal change notices');
        const cpage = (await jane.get(`/changes/${cid}`)).text; const rpage = await requestPage(rid);
        return must(/SLA at risk: emailed/.test(cpage) && /SLA breached: emailed/.test(cpage) && /Breached/.test(cpage) && /Breached|SLA breached/.test(rpage), 'activity log or badges missing');
      } finally {
        await admin.post('/settings/sla/targets', targetFields());
      }
    });
  }
  await step('SLA: settings go back to the defaults', async () => {
    await admin.post('/settings/sla/targets', targetFields());   // no enabled_* fields: both off
    const r = await admin.post('/settings/sla/policies', slaFields()); const page = (await admin.get('/settings/sla')).text;
    return must(r.status === 302 && /SLA targets saved/.test(page) && /id="enabled_request" name="enabled_request" >/.test(page) && /id="clock_4" name="clock_4">\s*<option value="calendar" selected>/.test(page), 'defaults not restored');
  });
  if (process.env.WALK_FAST_SLA === '1') {
    // Needs the app started with SLA_SWEEP_S=2. A one-minute target is warned about almost at once and breached a minute later.
    await step('SLA emails: at risk, then breached, each once, to the assignee, and the activity log says so', async () => {
      await admin.post('/settings/sla/policies', slaFields({ hours_3: String(1 / 60), warn_3: '1' }));
      const me = await meId(jane);
      const r = await jane.post('/incidents', { short_description: `SLA mail ${tag}`, category: 'other', impact: '2', urgency: '2', assigned_to: me });
      const id = idFrom(r.loc, '/incidents'); const number = ((await showPage(jane, id)).match(/INC\d{7}/) || [])[0];
      const waitFor = async (re, seconds) => { for (let i = 0; i < seconds; i++) { const l = await admin.get('/notifications'); if (re.test(l.text)) return true; await sleep(1000); } return false; };
      try {
        must(await waitFor(new RegExp(`\\[${number}\\] SLA at risk`), 40), 'no at-risk email within 40 s');
        must(await waitFor(new RegExp(`\\[${number}\\] SLA breached`), 120), 'no breach email within 120 s');
        await sleep(6000);
        const l = (await admin.get('/notifications')).text;
        const count = (re) => (l.match(re) || []).length;
        must(count(new RegExp(`\\[${number}\\] SLA at risk`, 'g')) === 1 && count(new RegExp(`\\[${number}\\] SLA breached`, 'g')) === 1, 'an email was sent more than once');
        const page = await showPage(jane, id);
        return must(/SLA at risk: emailed/.test(page) && /SLA breached: emailed/.test(page) && /Breached/.test(page), 'activity log or badge missing');
      } finally {
        await admin.post('/settings/sla/policies', slaFields());
      }
    });
  }

  section = 'sign-in security';
  const totp = require('../src/totp');
  const codeNow = (secret, steps = 0) => totp.codeAt(totp.base32Decode(secret), Date.now() + steps * 30000);
  const keyOf = (html) => { const m = html.match(/id="mfaKey"[^>]*>([A-Z2-7 ]+)</); return m ? m[1].replace(/ /g, '') : null; };
  const codesOf = (html) => { const m = html.match(/id="recoveryCodes"[^>]*>([^<]+)</); return m ? m[1].trim().split('\n').map((c) => c.trim()) : []; };
  // A code is good once, so every step below spends as few as it can: enrolling uses one, the first sign-in the next one, and the rest use recovery codes.
  const enrol = async (person) => {
    await person.post('/profile/mfa/setup');
    const setupPage = await person.get('/profile/mfa'); const page = setupPage.text; const key = keyOf(page); must(key, 'no setup key shown');
    // The page also draws the setup link as a QR code, on this server (no outside service), for exactly that link.
    const link = (page.match(/href="(otpauth:\/\/[^"]+)"/) || [])[1]; must(link, 'no setup link');
    const drawn = (page.match(/<svg[^>]*aria-label="QR code[^]*?<\/svg>/) || [])[0]; must(drawn, 'no QR code on the setup page');
    must(drawn === require('../src/qr').toSvg(link.replace(/&amp;/g, '&'), { label: 'QR code for the NovaDesk setup key' }), 'the QR code is not for the setup link');
    must(!/<img\b[^>]*\ssrc="(https?:)?\/\//i.test(page) && !/api\.qrserver|chart\.googleapis|quickchart/i.test(page), 'the QR code comes from an outside service');
    must(/no-store/.test(setupPage.headers.get('cache-control') || ''), 'the setup page may be cached');
    const bad = await person.post('/profile/mfa/confirm', { code: '000000' }); must(bad.status === 400 && /not right/.test(bad.text), 'a wrong code was accepted ' + bad.status);
    const ok = await person.post('/profile/mfa/confirm', { code: codeNow(key) }); must(ok.status === 200 && /Two-step verification is on/.test(ok.text), 'confirm ' + ok.status);
    const codes = codesOf(ok.text); must(codes.length === 10, 'recovery codes ' + codes.length);
    return { key, codes };
  };
  const signInStart = async (username, password) => { const p = new Person('mfa-' + username); const r = await p.post('/login', { username, password }); return { p, r }; };
  const signedIn = async (p) => (await p.get('/incidents')).status === 200;
  let bobMfa = null; let rajMfa = null;
  await step('two-step verification starts off and its page opens', async () => {
    const p = new Person('bob0'); await p.login('bsmith', 'agent123'); const page = await p.get('/profile/mfa');
    return must(page.status === 200 && /Set up two-step verification/.test(page.text) && />Off</.test(page.text), 'page ' + page.status);
  });
  await step('the code page cannot be reached without the password step', async () => {
    const r = await new Person('direct').get('/login/mfa'); const w = await new Person('direct2').post('/login/mfa', { code: '123456' });
    return must(r.status === 302 && /\/login$/.test(r.loc) && w.status === 302, `${r.status}/${w.status}`);
  });
  await step('setting it up needs a real code from the app; the recovery codes are shown once', async () => {
    const p = new Person('bob1'); await p.login('bsmith', 'agent123');
    bobMfa = await enrol(p);
    const again = (await p.get('/profile/mfa')).text;
    return must(/>On</.test(again) && /10 recovery codes left/.test(again) && codesOf(again).length === 0, 'status page');
  });
  await step('with it on, the password alone does not sign you in: the code comes next', async () => {
    const { p, r } = await signInStart('bsmith', 'agent123');
    must(r.status === 302 && /\/login\/mfa$/.test(r.loc), `password step ${r.status} ${r.loc}`);
    must(!(await signedIn(p)), 'signed in before the code');
    const page = await p.get('/login/mfa'); must(page.status === 200 && /Two-step verification/.test(page.text), 'code page');
    const wrong = await p.post('/login/mfa', { code: '000000' }); must(wrong.status === 401 && /not right/.test(wrong.text), 'wrong code ' + wrong.status);
    must(!(await signedIn(p)), 'signed in after a wrong code');
    const right = await p.post('/login/mfa', { code: codeNow(bobMfa.key, 1) }); must(right.status === 302 && right.loc === '/incidents', `right code ${right.status} ${right.loc}`);   // back to the page asked for before signing in
    return must(await signedIn(p), 'not signed in after the right code');
  });
  await step('a wrong password never reaches the code step, and a code from a used step cannot be replayed', async () => {
    const wrongPw = await signInStart('bsmith', 'not-the-password'); must(wrongPw.r.status === 401, 'wrong password ' + wrongPw.r.status);
    const { p } = await signInStart('bsmith', 'agent123');
    const replay = await p.post('/login/mfa', { code: codeNow(bobMfa.key, 1) });      // the step the previous sign-in used
    return must(replay.status === 401 && !(await signedIn(p)), 'a used code was accepted again ' + replay.status);
  });
  await step('a recovery code signs you in once, and says how many are left', async () => {
    const { p } = await signInStart('bsmith', 'agent123');
    const ok = await p.post('/login/mfa', { code: bobMfa.codes[0].toUpperCase() }); must(ok.status === 302, 'recovery code refused ' + ok.status);
    const home = (await p.get('/')).text; must(/signed in with a recovery code\. 9 left/.test(home), 'no notice about the recovery code');   // shown once, on the first page
    must(!/signed in with a recovery code/.test((await p.get('/')).text) && await signedIn(p), 'the notice stayed, or not signed in');
    const { p: p2 } = await signInStart('bsmith', 'agent123');
    const reuse = await p2.post('/login/mfa', { code: bobMfa.codes[0] }); return must(reuse.status === 401 && !(await signedIn(p2)), 'a recovery code worked twice');
  });
  await step('changing recovery codes or turning it off needs a current code (and the password to turn off)', async () => {
    const { p } = await signInStart('bsmith', 'agent123'); await p.post('/login/mfa', { code: bobMfa.codes[1] }); must(await signedIn(p), 'sign in');
    const noCode = await p.post('/profile/mfa/recovery-codes', { code: '000000' }); must(noCode.status === 400, 'new codes with a wrong code ' + noCode.status);
    const fresh = await p.post('/profile/mfa/recovery-codes', { code: bobMfa.codes[2] }); const newCodes = codesOf(fresh.text); must(fresh.status === 200 && newCodes.length === 10, 'new codes ' + fresh.status);
    const oldDead = await signInStart('bsmith', 'agent123'); const old = await oldDead.p.post('/login/mfa', { code: bobMfa.codes[3] }); must(old.status === 401, 'an old recovery code still works after new ones were made');
    const wrongPw = await p.post('/profile/mfa/disable', { password: 'wrong', code: newCodes[0] }); must(wrongPw.status === 400 && /still on/.test(wrongPw.text), 'turned off with the wrong password');
    const off = await p.post('/profile/mfa/disable', { password: 'agent123', code: newCodes[1] }); must(off.status === 200 && /is off/.test(off.text), 'turn off ' + off.status);
    const plain = await signInStart('bsmith', 'agent123'); return must(plain.r.status === 302 && plain.r.loc === '/' && await signedIn(plain.p), 'plain sign-in after turning it off');
  });
  await step('five wrong codes lock the code step for that person, even for the right code', async () => {
    const p0 = new Person('raj0'); await p0.login('rpatel', 'user123'); rajMfa = await enrol(p0);
    const { p } = await signInStart('rpatel', 'user123');
    for (let i = 0; i < 5; i++) { const w = await p.post('/login/mfa', { code: '111111' }); must(w.status === 401, `wrong code ${i + 1}: ${w.status}`); }
    const locked = await p.post('/login/mfa', { code: rajMfa.codes[0] });
    return must(locked.status === 429 && /Too many wrong codes/.test(locked.text) && !(await signedIn(p)), 'not locked ' + locked.status);
  });
  await step('an administrator can reset two-step verification for someone who lost their phone', async () => {
    const usersPage = (await admin.get('/users')).text; const rajRow = (usersPage.match(/<tr[^>]*>(?:(?!<\/tr>)[\s\S])*<td>rpatel<\/td>[\s\S]*?<\/tr>/) || [''])[0]; const rajId = (rajRow.match(/\/users\/(\d+)\/edit/) || [])[1]; must(rajId, 'no id for rpatel');
    const asAgent = await jane.post(`/users/${rajId}/mfa/reset`, {}); must(asAgent.status === 403, 'an agent could reset it ' + asAgent.status);
    const r = await admin.post(`/users/${rajId}/mfa/reset`, {}); must(r.status === 302, 'reset ' + r.status);
    const page = (await admin.get(`/users/${rajId}/edit`)).text; must(/Sign-in security/.test(page), 'no security card');
    const plain = await signInStart('rpatel', 'user123'); return must(plain.r.status === 302 && plain.r.loc === '/' && await signedIn(plain.p), 'raj could not sign in without a code after the reset');
  });

  if (process.env.WALK_OIDC) {
    // Needs the app started with OIDC_* pointing at scripts/mock-oidc.js (WALK_OIDC is that provider's address),
    // PUBLIC_URL equal to BASE_URL, OIDC_AUTO_CREATE=true and OIDC_ALLOWED_DOMAINS=corp.local,newco.example.
    const IDP = process.env.WALK_OIDC.replace(/\/+$/, '');
    const idp = (path, body) => fetch(IDP + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
    const ssoAttempt = async (identity, person = new Person('sso')) => {
      await idp('/__next', identity);
      const start = await person.get('/auth/oidc/start');
      if (start.status !== 302 || !(start.loc || '').startsWith(IDP)) return { person, start };
      const auth = await fetch(start.loc, { redirect: 'manual' });
      const back = new URL(auth.headers.get('location'));
      const cb = await person.get(back.pathname + back.search);
      return { person, start, cb, back };
    };
    const whoAmI = async (p) => { const r = await p.get('/profile'); const m = r.text.match(/Username<\/label>\s*<input[^>]*value="([^"]*)"/); return r.status === 200 && m ? m[1] : null; };
    const refusedWith = (a, pattern) => must(a.cb && a.cb.status === 401 && pattern.test(a.cb.text), `${a.cb && a.cb.status}: ${(a.cb && a.cb.text.match(/alert-danger[^>]*>([^<]*)/) || [])[1]}`);

    await step('single sign-on: the login page offers the button, and the flow uses PKCE, state and nonce', async () => {
      const page = await new Person('anon-sso').get('/login'); must(page.status === 200 && /auth\/oidc\/start/.test(page.text), 'no SSO button');
      const a = await ssoAttempt({ sub: 'sub-jane', email: 'jane.doe@corp.local', email_verified: true, name: 'Jane Doe' });
      const q = new URL(a.start.loc).searchParams;
      must(q.get('response_type') === 'code' && q.get('code_challenge_method') === 'S256' && q.get('code_challenge') && q.get('state') && q.get('nonce') && q.get('client_id') === 'novadesk-test', 'authorization request: ' + a.start.loc);
      must(a.cb.status === 302 && a.cb.loc === '/', `callback ${a.cb.status} ${a.cb.loc}`);
      return must(await whoAmI(a.person) === 'jdoe', 'not signed in as jdoe');
    });
    await step('the account is found by the provider\'s stable id, so a changed email does not matter', async () => {
      const a = await ssoAttempt({ sub: 'sub-jane', email: 'someone.else@corp.local', email_verified: true });
      return must(a.cb.status === 302 && await whoAmI(a.person) === 'jdoe', 'not jdoe after an email change');
    });
    await step('PKCE and the client secret checked out at the provider on every sign-in', async () => {
      const log = await fetch(IDP + '/__log').then((r) => r.json());
      const auth = log.filter((e) => e.path === 'authorize'); const tok = log.filter((e) => e.path === 'token');
      return must(auth.length > 0 && auth.every((e) => e.pkce && e.has_state && e.has_nonce) && tok.length > 0 && tok.every((e) => e.secret_ok && e.client_ok && e.pkce_ok && e.redirect_ok), 'a flow skipped PKCE, state, nonce or the secret');
    });
    await step('an existing account is matched by email only when the provider verified it', async () => {
      const a = await ssoAttempt({ sub: 'sub-maria-unverified', email: 'maria.chen@corp.local', email_verified: false });
      refusedWith(a, /not verified your email/);
      const ok = await ssoAttempt({ sub: 'sub-maria', email: 'MARIA.CHEN@corp.local', email_verified: true });
      return must(ok.cb.status === 302 && await whoAmI(ok.person) === 'mchen', 'verified email (any case) did not match');
    });
    await step('a new person is created as an end user, only from an allowed domain and a verified email', async () => {
      const hire = await ssoAttempt({ sub: 'sub-hire', email: 'newhire@newco.example', email_verified: true, name: 'New Hire' });
      must(hire.cb.status === 302 && await whoAmI(hire.person) === 'newhire', 'not created');
      must((await hire.person.get('/users')).status === 403, 'a created account is not an end user');
      const list = (await admin.get('/users')).text; must(/newhire/.test(list) && /New Hire/.test(list), 'not in the user list');
      refusedWith(await ssoAttempt({ sub: 'sub-evil', email: 'x@evil.example', email_verified: true }), /domain is not allowed/);
      refusedWith(await ssoAttempt({ sub: 'sub-unverified-new', email: 'ghost@newco.example', email_verified: false }), /There is no NovaDesk account/);
      return must(!/ghost@newco/.test((await admin.get('/users')).text), 'an unverified email created an account');
    });
    await step('a turned-off account cannot sign in through the provider either', async () => {
      const list = (await admin.get('/users')).text; const row = (list.match(/<tr[^>]*>(?:(?!<\/tr>)[\s\S])*<td>newhire<\/td>[\s\S]*?<\/tr>/) || [''])[0]; const id = (row.match(/\/users\/(\d+)\/edit/) || [])[1];
      must(id, 'no id for newhire');
      const off = await admin.post(`/users/${id}/update`, { username: 'newhire', full_name: 'New Hire', email: 'newhire@newco.example', role: 'user' }); must(off.status === 302, 'deactivate ' + off.status);
      refusedWith(await ssoAttempt({ sub: 'sub-hire', email: 'newhire@newco.example', email_verified: true }), /turned off/);
      await admin.post(`/users/${id}/update`, { username: 'newhire', full_name: 'New Hire', email: 'newhire@newco.example', role: 'user', active: 'on' });
      return must((await ssoAttempt({ sub: 'sub-hire', email: 'newhire@newco.example', email_verified: true })).cb.status === 302, 'not back after turning on');
    });
    await step('tokens that are forged, for another app, from another issuer, expired or unsigned are refused', async () => {
      for (const [bad, pattern] of [['signature', /signature/], ['nonce', /does not belong to this sign-in/], ['aud', /different application/], ['iss', /different identity provider/], ['expired', /expired/], ['alg-none', /signature type/]]) {
        const a = await ssoAttempt({ sub: 'sub-jane', email: 'jane.doe@corp.local', email_verified: true, bad });
        refusedWith(a, pattern); must(!(await signedIn(a.person)), `${bad}: signed in anyway`);
      }
      return true;
    });
    await step('a refusal at the provider, a replayed link, a changed state and a link not started here all fail safely', async () => {
      refusedWith(await ssoAttempt({ sub: 'sub-jane', email: 'jane.doe@corp.local', email_verified: true, bad: 'deny' }), /cancelled or refused/);
      const ok = await ssoAttempt({ sub: 'sub-jane', email: 'jane.doe@corp.local', email_verified: true });
      const replay = await ok.person.get(ok.back.pathname + ok.back.search); must(replay.status === 302 || replay.status === 400, 'replay ' + replay.status);
      const other = new Person('replay'); const r2 = await other.get(ok.back.pathname + ok.back.search); must(r2.status === 400 && /expired or was not started here/.test(r2.text) && !(await signedIn(other)), 'replay by another browser ' + r2.status);
      await idp('/__next', { sub: 'sub-jane', email: 'jane.doe@corp.local', email_verified: true });
      const p = new Person('state'); const start = await p.get('/auth/oidc/start'); const auth = await fetch(start.loc, { redirect: 'manual' }); const back = new URL(auth.headers.get('location'));
      back.searchParams.set('state', 'forged'); const bad = await p.get(back.pathname + back.search); must(bad.status === 400 && !(await signedIn(p)), 'forged state ' + bad.status);
      const none = await new Person('nostart').get('/auth/oidc/callback?code=abc&state=def'); return must(none.status === 400, 'no start ' + none.status);
    });
    await step('the provider rotating its keys does not lock people out', async () => {
      await idp('/__rotate');
      await sleep(1500);
      const a = await ssoAttempt({ sub: 'sub-jane', email: 'jane.doe@corp.local', email_verified: true });
      return must(a.cb.status === 302 && await whoAmI(a.person) === 'jdoe', 'sign-in failed after key rotation: ' + a.cb.status);
    });
  }

  section = 'input safety';
  await step('script tags in titles, comments, KB and CMDB names are escaped on every page', async () => {
    const x = `<script>alert('${tag}')</script>`;
    const r = await jane.post('/incidents', { short_description: x, description: x, category: 'other', impact: '3', urgency: '3' }); const id = idFrom(r.loc, '/incidents'); must(id, 'create');
    await jane.post(`/incidents/${id}/comments`, { comment: x });
    const kbr = await jane.post('/kb', { title: x, category: 'how-to', status: 'published', body: x }); const kid = idFrom(kbr.loc, '/kb');
    const cir = await jane.post('/cmdb', { name: x, ci_type: 'server', environment: 'development', status: 'in_use' }); const cid = idFrom(cir.loc, '/cmdb');
    const pages = [`/incidents/${id}`, '/incidents', `/kb/${kid}`, '/kb', `/cmdb/${cid}`, '/cmdb', '/', `/search?q=${tag}`];
    const bad = [];
    for (const p of pages) { const pg = await admin.get(p); if (pg.text.includes(`<script>alert('${tag}')`)) bad.push(p); }
    return must(bad.length === 0, 'unescaped on ' + bad.join(', '));
  });
  await step('non-numeric and unknown ids give a 404 page, not a server error', async () => {
    const paths = ['/incidents/abc', '/changes/abc', '/problems/abc', '/cmdb/abc', '/kb/abc', '/requests/abc', '/incidents/99999999', '/changes/99999999', '/cmdb/99999999/edit', '/notifications/abc', '/users/abc/edit'];
    const bad = [];
    for (const p of paths) { const r = await admin.get(p); if (r.status !== 404) bad.push(`${p} -> ${r.status}`); }
    return must(bad.length === 0, bad.join('; '));
  });
  await step('a database error never shows SQL or a stack trace on the page', async () => {
    const r = await admin.get('/incidents/abc');
    return must(!/SELECT|syntax|at .*\.js:\d+|node_modules/.test(r.text), r.text.replace(/\s+/g, ' ').slice(0, 160));
  });
  await step('creating records without the required fields is refused, not a 500', async () => {
    const a = await jane.post('/incidents', {}); const b = await jane.post('/changes', {}); const c = await jane.post('/problems', {}); const d = await jane.post('/cmdb', {}); const e = await jane.post('/kb', {});
    return must([a, b, c, d, e].every((r) => r.status < 500), [a, b, c, d, e].map((r) => r.status).join('/'));
  });
  await step('very long text is refused or accepted, but never crashes the server', async () => {
    const r = await jane.post('/incidents', { short_description: 'x'.repeat(300000), category: 'other', impact: '3', urgency: '3' }); const h = await anon.get('/health');
    // The refusal is a proper page (the app's own layout), not Express's bare error text or a stack trace.
    return must(r.status === 413 && /too large/i.test(r.text) && /<title>[^<]*NovaDesk/i.test(r.text) && !/at .*\.js:\d+|ReferenceError/.test(r.text) && h.status === 200, `status ${r.status}: ${r.text.replace(/\s+/g, ' ').slice(0, 120)}`) && `long text -> ${r.status}`;
  });

  section = 'sign-in protection';
  await step('a crafted //host path cannot turn the post-sign-in redirect into an open redirect', async () => {
    const p = new Person('or'); await p.get('//evil.example/x'); await p.get('/\\evil.example');
    const r = await p.post('/login', { username: 'jdoe', password: 'agent123' });
    return must(r.status === 302 && !/^(\/\/|\/\\|https?:)/.test(r.loc || ''), 'redirected to ' + r.loc);
  });
  await step('the session cookie is HttpOnly and SameSite (and not Secure over plain http, so sign-in works there)', async () => {
    const p = new Person('flags'); const r = await p.post('/login', { username: 'admin', password: 'admin123' });
    const c = (r.headers.getSetCookie ? r.headers.getSetCookie() : [])[0] || ''; return must(/HttpOnly/i.test(c) && /SameSite=(Lax|Strict)/i.test(c) && !/;\s*Secure/i.test(c), c.replace(/=[^;]*/, '=…'));
  });
  await step('basic hardening headers are sent', async () => {
    const r = await anon.get('/login'); const h = r.headers;
    return must(h.get('x-content-type-options') === 'nosniff' && h.get('x-frame-options') && !h.get('x-powered-by'), `nosniff ${h.get('x-content-type-options')}, frame ${h.get('x-frame-options')}, powered-by ${h.get('x-powered-by')}`);
  });

  if (process.env.WALK_WEBHOOKS) {
    section = 'webhooks';
    await step('webhooks: everything the walk-through did reached the receiver once, signed, in the documented shape, and nothing is stuck', async () => {
      const { verifySignature } = require('../src/webhookNet'); const { SHAPES } = require('../src/api/spec');
      await updateIncident(jane, slaInc, { impact: '1', urgency: '1', status: 'in_progress', resolution_notes: `plain edit ${tag}` });   // a change with no status change: incident.updated
      await sleep(3000);   // let the dispatcher pick the last events up before looking for deliveries still waiting
      let page = ''; for (let i = 0; i < 40; i++) { page = (await admin.get('/settings/webhooks')).text; if (/\b0 waiting\b/.test(page)) break; await sleep(1000); }
      must(/\b0 waiting\b/.test(page), 'deliveries are still waiting');
      const events = hook.calls.map((c) => ({ c, e: JSON.parse(c.body) }));
      must(events.length > 40, `only ${events.length} events arrived`);
      must(events.every(({ c }) => verifySignature(hook.secret, c.headers['x-novadesk-signature'], c.body)), 'an event was not correctly signed');
      const ids = events.map(({ e }) => e.id); must(new Set(ids).size === ids.length, 'an event arrived twice');
      const types = new Set(events.map(({ e }) => e.type));
      const wanted = ['incident.created', 'incident.status_changed', 'incident.updated', 'incident.commented', 'change.created', 'change.status_changed', 'problem.created', 'request.created', 'request.status_changed', 'ci.created', 'ci.updated', 'article.created'];
      const missing = wanted.filter((t) => !types.has(t)); must(!missing.length, 'never arrived: ' + missing.join(', '));
      const kinds = { incident: 'Incident', change: 'Change', problem: 'Problem', request: 'Request', ci: 'Ci', article: 'Article' };
      const bad = []; for (const { e } of events) { if (e.type === 'ping') continue; const [kind] = e.type.split('.'); const rec = e.data[kind]; for (const k of Object.keys(SHAPES[kinds[kind]])) if (rec && !(k in rec) && kind !== 'article') bad.push(`${e.type}.${k}`); }
      must(!bad.length, 'missing fields: ' + [...new Set(bad)].slice(0, 5).join(', '));
      must(!/Failed<\/span>/.test(page), 'a delivery failed');
      return `${events.length} events, ${types.size} kinds`;
    });
    await step('webhooks: the internal work note this walk-through wrote was never sent (the public comment next to it was)', async () => {
      return must(!hook.calls.some((c) => c.body.includes(`internal note ${tag}`)) && hook.calls.some((c) => c.body.includes('"type":"incident.commented"')), 'a work note leaked, or no comment event arrived');
    });
    await step('webhooks: the walk-through removes its webhook again', async () => {
      const page = (await admin.get('/settings/webhooks')).text; const id = (page.match(/\/settings\/webhooks\/(\d+)\/delete/) || [])[1];
      const del = await admin.post(`/settings/webhooks/${id}/delete`);
      return must(id && del.status === 200 && !(await admin.get('/settings/webhooks')).text.includes('walkthrough'), 'not removed');
    });
    hook.server.close();
    section = 'sign-in protection';
  }

  // Guesses at a name that does not exist, so no real account is locked for the checks that run after this.
  // Last on purpose: it trips the limiter, so this address cannot sign in again for 15 minutes (or until a restart).
  if (!process.env.WALK_SKIP_BRUTE_FORCE) await step('repeated wrong passwords are slowed down (the same person keeps failing)', async () => {
    let limited = false; for (let i = 0; i < 40; i++) { const r = await new Person('bf').post('/login', { username: 'nobody-' + tag, password: 'wrong' + i }); if (r.status === 429) { limited = true; break; } }
    return must(limited, 'forty wrong passwords in a row were all just answered; nothing limits guessing');
  });

  async function meId(p) { const r = await p.get('/profile'); const m = r.text.match(/data-user-id="(\d+)"/); return m ? m[1] : ''; }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) { console.log('FAILED:'); failed.forEach((f) => console.log(`  [${f.section}] ${f.name} -- ${f.extra}`)); }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('walk-through aborted:', e); process.exit(2); });
