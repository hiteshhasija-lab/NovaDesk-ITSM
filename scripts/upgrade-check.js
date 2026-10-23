#!/usr/bin/env node
// Data survives an upgrade. Used by the "Upgrade" jobs in CI, which start an OLDER release (its demo
// workspace comes with it), then
//   node scripts/upgrade-check.js seed      (as the demo people: incidents, a comment and a work note, an
//                                            attachment, a change, a configuration item, an article)
// upgrade the same install in place to this version, then
//   node scripts/upgrade-check.js verify    (the same people sign in with the same passwords and find it
//                                            all; roles still apply; the new version can add to the old data)
// Only pages and forms that old releases have are used, so the script runs against both versions.
//   BASE_URL (default http://localhost:8080), STATE_FILE (default ./upgrade-state.json)
'use strict';
const crypto = require('crypto');
const fs = require('fs');

const BASE = (process.env.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const STATE = process.env.STATE_FILE || './upgrade-state.json';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

class Person {
  constructor(username, password) { this.username = username; this.password = password; this.cookie = ''; }
  async req(method, path, { form, multipart } = {}) {
    const headers = { Cookie: this.cookie };
    let body;
    if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    else if (multipart) body = multipart;
    const res = await fetch(BASE + path, { method, headers, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) this.cookie = c.split(';')[0];
    const buffer = Buffer.from(await res.arrayBuffer());
    return { status: res.status, loc: res.headers.get('location'), buffer, text: buffer.toString() };
  }
  get(p) { return this.req('GET', p); }
  post(p, form) { return this.req('POST', p, { form }); }
  async signIn() { return this.post('/login', { username: this.username, password: this.password }); }
}
const idFrom = (loc, base) => { const m = (loc || '').match(new RegExp('/' + base + '/(\\d+)')); return m ? Number(m[1]) : null; };
let failed = 0;
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -- ' + extra : ''}`); };
const demo = () => ({ admin: new Person('admin', 'admin123'), jane: new Person('jdoe', 'agent123'), maria: new Person('mchen', 'user123') });

async function seed() {
  const { jane, maria } = demo();
  check('the demo agent signs in', (await jane.signIn()).status === 302);
  check('the demo end user signs in', (await maria.signIn()).status === 302);
  const tag = crypto.randomBytes(3).toString('hex');
  const inc = await jane.post('/incidents', { short_description: `upgrade incident ${tag}`, description: 'seeded before the upgrade', category: 'hardware', impact: '2', urgency: '2' });
  const incident = idFrom(inc.loc, 'incidents');
  check('an incident is created', Boolean(incident), inc.loc);
  await jane.post(`/incidents/${incident}/comments`, { comment: `public reply ${tag}` });
  await jane.post(`/incidents/${incident}/comments`, { comment: `internal note ${tag}`, is_work_note: 'on' });
  const file = crypto.randomBytes(200 * 1024);
  const fd = new FormData(); fd.append('file', new Blob([file], { type: 'application/octet-stream' }), 'seed.bin');
  check('an attachment is saved', (await jane.req('POST', `/incidents/${incident}/attachments`, { multipart: fd })).status === 302);
  const page = await jane.get(`/incidents/${incident}`);
  const attachment = (page.text.match(/\/attachments\/(\d+)\/download/) || [])[1];
  check('the attachment is listed', Boolean(attachment));
  const mine = await maria.post('/incidents', { short_description: `maria incident ${tag}`, description: 'an end user ticket', category: 'software', impact: '3', urgency: '3' });
  const mariaIncident = idFrom(mine.loc, 'incidents');
  check('the end user creates their own incident', Boolean(mariaIncident));
  const chg = await jane.post('/changes', { short_description: `upgrade change ${tag}`, description: 'seeded', change_type: 'normal', risk: 'medium', implementation_plan: 'x', backout_plan: 'y' });
  const change = idFrom(chg.loc, 'changes');
  check('a change is created', Boolean(change), chg.loc);
  const ci = await jane.post('/cmdb', { name: `UPGRADE-CI-${tag}`, ci_type: 'server', environment: 'development', status: 'in_use', ip_address: '10.9.9.9' });
  const cmdb = idFrom(ci.loc, 'cmdb');
  check('a configuration item is created', Boolean(cmdb), ci.loc);
  const kbr = await jane.post('/kb', { title: `Upgrade article ${tag}`, category: 'how-to', status: 'published', body: `seeded article ${tag}` });
  const kb = idFrom(kbr.loc, 'kb');
  check('a knowledge article is published', Boolean(kb), kbr.loc);
  fs.writeFileSync(STATE, JSON.stringify({ tag, incident, attachment, attachmentHash: sha(file), mariaIncident, change, cmdb, kb }));
}

async function verify() {
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const { admin, jane, maria } = demo();
  for (const p of [admin, jane, maria]) check(`${p.username} signs in with the same password`, (await p.signIn()).status === 302);
  const inc = await jane.get(`/incidents/${st.incident}`);
  check('the incident, its comment and its work note are there for the agent', inc.status === 200 && inc.text.includes(`upgrade incident ${st.tag}`) && inc.text.includes(`public reply ${st.tag}`) && inc.text.includes(`internal note ${st.tag}`), inc.status);
  const own = await maria.get(`/incidents/${st.mariaIncident}`);
  check('the end user still sees their own incident, without work notes', own.status === 200 && own.text.includes(`maria incident ${st.tag}`) && !own.text.includes('internal note'), own.status);
  const others = await maria.get(`/incidents/${st.incident}`);
  check('the end user still cannot open someone else\'s incident', others.status === 403 || others.status === 404, others.status);
  const att = await jane.get(`/incidents/${st.incident}/attachments/${st.attachment}/download`);
  check('the attachment downloads byte-identical', att.status === 200 && sha(att.buffer) === st.attachmentHash, att.status);
  const chg = await jane.get(`/changes/${st.change}`);
  check('the change is there', chg.status === 200 && chg.text.includes(`upgrade change ${st.tag}`), chg.status);
  const ci = await jane.get(`/cmdb/${st.cmdb}`);
  check('the configuration item is there', ci.status === 200 && ci.text.includes(`UPGRADE-CI-${st.tag}`), ci.status);
  const kb = await maria.get(`/kb/${st.kb}`);
  check('the published article is readable by an end user', kb.status === 200 && kb.text.includes(`Upgrade article ${st.tag}`), kb.status);
  const found = await jane.get(`/search?q=${encodeURIComponent('upgrade incident ' + st.tag)}`);
  check('search finds the old incident', found.status === 200 && found.text.includes(`upgrade incident ${st.tag}`), found.status);
  const users = await admin.get('/users');
  check('the admin still manages users', users.status === 200 && users.text.includes('jdoe') && users.text.includes('mchen'), users.status);
  // The new version adds to the old data.
  const next = await jane.post('/incidents', { short_description: `after the upgrade ${st.tag}`, description: 'written by the new version', category: 'other', impact: '3', urgency: '3' });
  const nextId = idFrom(next.loc, 'incidents');
  check('a new incident can be created and numbering continues', Boolean(nextId) && nextId > st.mariaIncident, `${nextId} after ${st.mariaIncident}`);
  check('a comment can be added to the old incident', (await jane.post(`/incidents/${st.incident}/comments`, { comment: `after the upgrade ${st.tag}` })).status === 302);
}

const mode = process.argv[2];
(async () => {
  if (mode === 'seed') await seed(); else if (mode === 'verify') await verify(); else { console.error('usage: upgrade-check.js seed|verify'); process.exit(2); }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
