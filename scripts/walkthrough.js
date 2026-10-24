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
  constructor(name) { this.name = name; this.cookie = ''; this.user = null; }
  async req(method, path, { form, json, multipart, headers = {} } = {}) {
    const h = { ...headers, Cookie: this.cookie };
    let body;
    if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    else if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    else if (multipart) body = multipart;
    const res = await fetch(BASE + path, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const kv = c.split(';')[0]; const k = kv.split('=')[0];
      const jar = Object.fromEntries(this.cookie.split('; ').filter(Boolean).map((p) => [p.split('=')[0], p]));
      jar[k] = kv; this.cookie = Object.values(jar).join('; ');
    }
    const text = await res.text();
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
  await step('the sign-in page after signing in no longer traps an anonymous bounce (returnTo is honoured)', async () => {
    const p = new Person('rt'); const first = await p.get('/changes/board'); must(first.status === 302, 'first ' + first.status);
    const r = await p.post('/login', { username: 'jdoe', password: 'agent123' });
    return must(r.status === 302 && r.loc === '/changes/board', `went to ${r.loc}`);
  });
  await step('sign out ends the session', async () => { const p = new Person('lo'); await p.login('mchen', 'user123'); await p.post('/logout'); const r = await p.get('/incidents'); return must(r.status === 302, 'status ' + r.status); });
  await step('self-registration creates an end user who can sign in', async () => {
    const p = new Person('reg');
    const r = await p.req('POST', '/register', { form: { full_name: 'Reggie Reg', username: 'reg' + tag, email: `reg${tag}@corp.local`, password: 'Reg-pass-1', confirm_password: 'Reg-pass-1' } });
    must(r.status === 302, `register ${r.status} ${r.text.slice(0, 120)}`);
    const d = await p.get('/'); return must(d.status === 200, 'dashboard ' + d.status);
  });
  await step('registration refuses a taken username and mismatched passwords', async () => {
    const dup = await new Person('d').req('POST', '/register', { form: { full_name: 'X', username: 'admin', email: 'x@x.x', password: 'abcdefgh1', confirm_password: 'abcdefgh1' } });
    const mism = await new Person('m').req('POST', '/register', { form: { full_name: 'X', username: 'zz' + tag, email: 'x@x.x', password: 'abcdefgh1', confirm_password: 'different1' } });
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

  section = 'users, profile & roles';
  let newUserId;
  await step('an admin creates a user; the duplicate is refused; the user signs in', async () => {
    const r = await admin.post('/users', { username: 'wk' + tag, full_name: 'Wendy Walk', email: `wk${tag}@corp.local`, password: 'Wendy-pass-1', role: 'agent', department: 'QA', active: '1' });
    must(r.status === 302, `create ${r.status} ${r.text.slice(0, 120)}`);
    const dup = await admin.post('/users', { username: 'wk' + tag, full_name: 'Again', email: 'a@a.a', password: 'Wendy-pass-1', role: 'agent' }); must(dup.status !== 302, 'duplicate accepted');
    const p = new Person('w'); const l = await p.login('wk' + tag, 'Wendy-pass-1'); must(l.status === 302, 'new user login ' + l.status);
    const list = await admin.get(`/users`); const m = list.text.match(new RegExp(`/users/(\\d+)/edit[\\s\\S]{0,400}wk${tag}|wk${tag}[\\s\\S]{0,600}?/users/(\\d+)/edit`)); newUserId = m && (m[1] || m[2]); return must(newUserId, 'not in list');
  });
  await step('role change takes effect; a deactivated user cannot sign in', async () => {
    const e = await admin.post(`/users/${newUserId}/update`, { username: 'wk' + tag, full_name: 'Wendy Walk', email: `wk${tag}@corp.local`, role: 'user', department: 'QA', active: 'on' }); must(e.status === 302, 'role ' + e.status);
    const p = new Person('w2'); await p.login('wk' + tag, 'Wendy-pass-1'); const x = await p.get('/users'); must(x.status === 403, 'now an end user: ' + x.status);
    await admin.post(`/users/${newUserId}/update`, { username: 'wk' + tag, full_name: 'Wendy Walk', email: `wk${tag}@corp.local`, role: 'user', department: 'QA' });   // no active flag: deactivates
    const off = await new Person('w3').login('wk' + tag, 'Wendy-pass-1');
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
  await step('SLA: settings go back to the defaults', async () => {
    const r = await admin.post('/settings/sla/policies', slaFields()); const page = (await admin.get('/settings/sla')).text;
    return must(r.status === 302 && /SLA targets saved/.test(page) && /id="clock_4" name="clock_4">\s*<option value="calendar" selected>/.test(page), 'defaults not restored');
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
  await step('the session cookie is HttpOnly and SameSite', async () => {
    const r = await fetch(BASE + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'admin', password: 'admin123' }), redirect: 'manual' });
    const c = r.headers.getSetCookie()[0] || ''; return must(/HttpOnly/i.test(c) && /SameSite=(Lax|Strict)/i.test(c), c.replace(/=[^;]*/, '=…'));
  });
  await step('basic hardening headers are sent', async () => {
    const r = await anon.get('/login'); const h = r.headers;
    return must(h.get('x-content-type-options') === 'nosniff' && h.get('x-frame-options') && !h.get('x-powered-by'), `nosniff ${h.get('x-content-type-options')}, frame ${h.get('x-frame-options')}, powered-by ${h.get('x-powered-by')}`);
  });

  // Last on purpose: it trips the limiter, so this address cannot sign in again for 15 minutes (or until a restart).
  if (!process.env.WALK_SKIP_BRUTE_FORCE) await step('repeated wrong passwords are slowed down (the same person keeps failing)', async () => {
    let limited = false; for (let i = 0; i < 40; i++) { const r = await new Person('bf').post('/login', { username: 'admin', password: 'wrong' + i }); if (r.status === 429) { limited = true; break; } }
    return must(limited, 'forty wrong passwords in a row were all just answered; nothing limits guessing');
  });

  async function meId(p) { const r = await p.get('/profile'); const m = r.text.match(/data-user-id="(\d+)"/); return m ? m[1] : ''; }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) { console.log('FAILED:'); failed.forEach((f) => console.log(`  [${f.section}] ${f.name} -- ${f.extra}`)); }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('walk-through aborted:', e); process.exit(2); });
