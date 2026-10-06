#!/usr/bin/env node
'use strict';
// Fault-injection harness for the decommission workflow. Runs on NOVAAPP01 against the isolated
// "fi-lab" pod only (see rig.sh). It plays the part of NovaConnect: it calls NovaDesk's
// /api/integrations/novaconnect/decommission-requests/* endpoints exactly as NovaConnect's
// relay does, while NovaDesk's callbacks go to the fault-injectable stub, whose card state is
// compared with NovaDesk's own records.
//
//   node harness.js check
//   node harness.js e1 [--n 5]                       baseline timing (no faults)
//   node harness.js e2 [--faults refuse,html404,...] [--windows approve,prechecks,all] [--reps 1] [--grace 30]
//   node harness.js e4                                scheduler / soak persistence and lost-card cases
//   node harness.js e5                                state-machine and idempotency probes
//   node harness.js all
//
// Safety: refuses to run unless the rig's NovaDesk has NO ESXi credentials, uses the rig database
// "fi", and calls only the stub. Fixture VMs are fictitious CIs pointing at 127.0.0.1.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ND = 'http://127.0.0.1:18080';
const CTL = 'http://127.0.0.1:18082';
const KEY = 'fi-test-key';
const CHANNEL = 6;
const MANUAL = ['Verify backup completed', 'Remove from monitoring', 'DNS / firewall cleanup'];

// ---------------------------------------------------------------- args / output
const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
function opt(name, def) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
}
const OUT = opt('out', path.join(__dirname, 'results', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)));
fs.mkdirSync(OUT, { recursive: true });
const summary = [];
function say(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }
function save(name, obj) { fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj, null, 2)); }
function md(line = '') { summary.push(line); }
function flushSummary(name) { fs.writeFileSync(path.join(OUT, name), summary.join('\n') + '\n'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- database (rig only)
function psql(sql, { firstLine = false } = {}) {
  const out = execFileSync('podman', ['exec', '-e', 'PGPASSWORD=fi_pw', 'fi-postgres', 'psql', '-U', 'fi', '-d', 'fi', '-v', 'ON_ERROR_STOP=1', '-tA', '-c', sql], { encoding: 'utf8' }).trim();
  return firstLine ? out.split('\n')[0] : out;
}
function q(sql) {
  const out = psql(`SELECT coalesce(json_agg(t),'[]'::json) FROM (${sql}) t`);
  return JSON.parse(out || '[]');
}
const esc = (s) => String(s).replace(/'/g, "''");
const utc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const podman = (...a) => execFileSync('podman', a, { encoding: 'utf8' }).trim();

// ---------------------------------------------------------------- http helpers
async function http(base, method, p, body, { timeoutMs = 300000, auth = KEY } = {}) {
  const t0 = Date.now();
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, error: e.name === 'AbortError' ? 'client-timeout' : e.message, ms: Date.now() - t0 };
  } finally { clearTimeout(to); }
}
const nd = (method, p, body, o) => http(ND, method, p, body, o);
const ctl = (method, p, body) => http(CTL, method, p, body, { auth: null, timeoutMs: 15000 });
const REQ = '/api/integrations/novaconnect/decommission-requests';

async function stubState() { return (await ctl('GET', '/state')).json; }
async function stubLog(since) { return (await ctl('GET', `/log?since=${since}`)).json.log; }
async function setFault(name, extra = {}) { await ctl('POST', '/ctl', { mode: name, ...extra }); }
async function resetStub() { await ctl('POST', '/reset'); await setFault('normal'); }

async function waitHealthy(timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await nd('GET', '/health', null, { auth: null, timeoutMs: 3000 });
    if (r.status === 200) return Date.now() - t0;
    await sleep(1000);
  }
  throw new Error('NovaDesk did not become healthy');
}

// ---------------------------------------------------------------- fixtures
let hostId = null;
function ensureHost() {
  if (hostId) return hostId;
  const r = q(`SELECT id FROM cmdb_ci WHERE ci_number='FI-ESXI'`);
  if (r.length) { hostId = r[0].id; return hostId; }
  hostId = Number(psql(`INSERT INTO cmdb_ci (ci_number,name,ci_type,environment,status,ip_address) VALUES ('FI-ESXI','FI-ESXI-HOST','server','development','in_use','127.0.0.1') RETURNING id`, { firstLine: true }));
  return hostId;
}
let seq = 0;
function makeVm(label, { linked = true } = {}) {
  seq += 1;
  const name = `FI-${label}-${Date.now().toString(36)}${seq}`.toUpperCase();
  const id = Number(psql(`INSERT INTO cmdb_ci (ci_number,name,ci_type,environment,status) VALUES ('${esc(name)}','${esc(name)}','server','development','in_use') RETURNING id`, { firstLine: true }));
  if (linked) psql(`INSERT INTO ci_relationships (parent_ci_id, child_ci_id, relationship_type) VALUES (${ensureHost()}, ${id}, 'runs_on')`);
  return { id, name };
}

// ---------------------------------------------------------------- flow primitives (play NovaConnect)
const tasksOf = (changeId) => q(`SELECT id, description, status, sequence FROM change_tasks WHERE change_id=${changeId} ORDER BY sequence`);
const changeRow = (changeId) => q(`SELECT id, number, status, approval_status, assigned_to, assignment_group, planned_start, planned_end FROM changes WHERE id=${changeId}`)[0];

async function newChange(label = 'RUN', { conversationId = null } = {}) {
  const vm = makeVm(label);
  const r = await nd('POST', REQ, { hostname: vm.name, novaconnect_channel_id: CHANNEL, ...(conversationId ? { novaconnect_conversation_id: conversationId } : {}), requested_by_username: 'admin' });
  if (r.status !== 201) throw new Error(`create failed: ${r.status} ${JSON.stringify(r.json || r.error)}`);
  const changeId = r.json.change.id;
  // NovaConnect itself posts the first (approval) card locally, so the harness seeds it directly.
  await ctl('POST', '/seed', { changeId, cardType: 'decom_approval', status: 'pending' });
  return { changeId, vm, create: r };
}
const approve = (id, o) => nd('POST', `${REQ}/${id}/approve`, { approved_by_username: 'admin' }, o);
const reject = (id, o) => nd('POST', `${REQ}/${id}/reject`, { rejected_by_username: 'admin' }, o);
const precheck = (id, taskId, action = 'complete', who = 'admin', o) => nd('POST', `${REQ}/${id}/precheck-task`, { action, task_id: taskId, actor_username: who }, o);

// What the chat should show, given NovaDesk's own records, versus what the receiver actually holds.
function divergence(changeId, st) {
  const c = changeRow(changeId);
  const tasks = tasksOf(changeId).filter((t) => MANUAL.includes(t.description));
  const expected = [{ cardType: 'decom_approval', taskId: null, expect: c.approval_status === 'pending' ? 'pending' : c.approval_status }];
  if (c.approval_status === 'approved') {
    for (const t of tasks) {
      expected.push({ cardType: 'decom_precheck_task', taskId: t.id, expect: t.status });
      if (t.status === 'pending') break; // cards are posted one at a time
    }
  }
  const mine = st.cards.filter((x) => Number(x.changeId) === Number(changeId));
  const rows = expected.map((e) => {
    const m = mine.filter((x) => x.cardType === e.cardType && (e.taskId === null ? x.taskId === null : Number(x.taskId) === Number(e.taskId)));
    const got = m.length ? m[m.length - 1].status : 'MISSING';
    return { ...e, receiver: got, copies: m.length, diverged: got !== e.expect };
  });
  return { rows, diverged: rows.filter((r) => r.diverged).length, duplicates: rows.filter((r) => r.copies > 1).length };
}

function stats(a) {
  if (!a.length) return { n: 0 };
  const s = [...a].sort((x, y) => x - y);
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  return { n: a.length, min: s[0], median: s[Math.floor(s.length / 2)], mean: Math.round(mean), max: s[s.length - 1] };
}
const sec = (ms) => (ms / 1000).toFixed(1);

// One complete decommission up to (and including) the power-down attempt.
// opts: { fault, faultArgs, window: 'approve'|'prechecks'|'all'|'none', graceSec, hang }
async function runFlow(opts = {}) {
  const { fault = 'normal', faultArgs = {}, window = 'none', graceSec = 0, hang = false } = opts;
  await resetStub();
  const t0 = Date.now();
  const { changeId, vm } = await newChange('FLOW');
  const rec = { changeId, vm: vm.name, fault, window, hang, steps: {}, blocked: 0 };

  if (window === 'approve' || window === 'all') await setFault(fault, faultArgs);
  const ap = await approve(changeId, { timeoutMs: hang ? 60000 : 300000 });
  rec.steps.approve = { ms: ap.ms, status: ap.status, error: ap.error };
  if (hang) {
    // The approve request is stuck behind an unanswered callback. Release the stub and let the
    // server-side flow finish, then carry on.
    await setFault('normal');
    const w0 = Date.now();
    while (Date.now() - w0 < 120000) {
      const st = await stubState();
      if (st.cards.some((c) => Number(c.changeId) === changeId && c.cardType === 'decom_precheck_task')) break;
      await sleep(1000);
    }
    rec.steps.approve.recoveredAfterReleaseMs = Date.now() - w0;
  }
  if (window === 'approve') await setFault('normal');
  if (window === 'prechecks') await setFault(fault, faultArgs);

  const manual = tasksOf(changeId).filter((x) => MANUAL.includes(x.description));
  for (const [idx, t] of manual.entries()) {
    const st = await stubState();
    const visible = st.cards.some((c) => Number(c.changeId) === changeId && c.cardType === 'decom_precheck_task' && Number(c.taskId) === t.id);
    if (!visible) rec.blocked += 1; // an operator working only in chat would have had no card to click
    const r = await precheck(changeId, t.id, 'complete');
    rec.steps[`precheck${idx + 1}`] = { ms: r.ms, status: r.status, cardVisibleBeforeAction: visible };
  }
  await setFault('normal');
  rec.totalMs = Date.now() - t0;

  rec.nd = { ...changeRow(changeId), tasks: tasksOf(changeId).map((t) => `${t.sequence}:${t.status}`) };
  const st0 = await stubState();
  rec.divergenceAtEnd = divergence(changeId, st0);
  if (graceSec > 0) {
    await sleep(graceSec * 1000);
    const st1 = await stubState();
    rec.divergenceAfterGrace = divergence(changeId, st1);
    rec.graceSec = graceSec;
  }
  const log = await stubLog(t0);
  rec.callbackHits = log.filter((e) => e.path && e.path.startsWith('/api/')).length;
  rec.callbackOutcomes = log.reduce((m, e) => { if (e.path && e.path.startsWith('/api/')) m[e.outcome] = (m[e.outcome] || 0) + 1; return m; }, {});
  const resolveHit = log.find((e) => e.path === '/api/integrations/novadesk/decom-updates/resolve' && e.outcome === 'ok');
  rec.firstSuccessfulResolveMs = resolveHit ? resolveHit.t - t0 : null;
  return rec;
}

// ---------------------------------------------------------------- check
async function check() {
  const problems = [];
  const h = await nd('GET', '/health', null, { auth: null, timeoutMs: 5000 });
  if (h.status !== 200) problems.push('rig NovaDesk not healthy on 127.0.0.1:18080');
  const s = await ctl('GET', '/state');
  if (s.status !== 200) problems.push('stub control not reachable on 127.0.0.1:18082');
  let env = {};
  try {
    for (const k of ['ESXI_USER', 'ESXI_PASSWORD', 'PGDATABASE', 'NOVACONNECT_BASE_URL', 'NOVADESK_RELEASE_VERSION']) {
      env[k] = (() => { try { return podman('exec', 'fi-novadesk', 'printenv', k); } catch { return ''; } })();
    }
  } catch (e) { problems.push(`cannot inspect fi-novadesk: ${e.message}`); }
  if (env.ESXI_USER || env.ESXI_PASSWORD) problems.push('rig NovaDesk has ESXi credentials set; refusing to run');
  if (env.PGDATABASE !== 'fi') problems.push(`rig NovaDesk uses database "${env.PGDATABASE}", expected "fi"`);
  if (env.NOVACONNECT_BASE_URL !== 'http://127.0.0.1:18081') problems.push(`rig NovaDesk callback URL is ${env.NOVACONNECT_BASE_URL}, expected the stub`);
  const img = (() => { try { return podman('inspect', 'fi-novadesk', '--format', '{{.ImageName}}'); } catch { return '?'; } })();
  say('rig image:', img, '| release env:', env.NOVADESK_RELEASE_VERSION);
  if (problems.length) { problems.forEach((p) => say('PROBLEM:', p)); throw new Error('safety check failed'); }
  say('rig OK: isolated DB, stub receiver, no ESXi credentials');
  return env;
}

// ---------------------------------------------------------------- E1 baseline
async function e1() {
  const n = Number(opt('n', 5));
  say(`E1: ${n} baseline runs, no faults`);
  const runs = [];
  for (let i = 1; i <= n; i++) {
    const r = await runFlow({ window: 'none', graceSec: 0 });
    runs.push(r);
    say(`  run ${i}/${n}: approve ${sec(r.steps.approve.ms)}s, total ${sec(r.totalMs)}s, diverged ${r.divergenceAtEnd.diverged}`);
  }
  save('e1.json', runs);
  const col = (f) => runs.map(f).filter((x) => x != null);
  md('## E1. Baseline timing (no faults)'); md();
  md(`${n} runs against the rig, seconds. Each step contains the workflow's deliberate 10 s pacing pause, so these numbers measure that pacing floor, not processing speed.`); md();
  md('| Step | min | median | mean | max |'); md('|---|---|---|---|---|');
  const row = (label, a) => { const s = stats(a); md(`| ${label} | ${sec(s.min)} | ${sec(s.median)} | ${sec(s.mean)} | ${sec(s.max)} |`); };
  row('Approve call (resolve card, post message, 10 s pause, post 1st precheck card)', col((r) => r.steps.approve.ms));
  row('Precheck 1 complete', col((r) => r.steps.precheck1 && r.steps.precheck1.ms));
  row('Precheck 2 complete', col((r) => r.steps.precheck2 && r.steps.precheck2.ms));
  row('Precheck 3 complete (includes the power-down attempt)', col((r) => r.steps.precheck3 && r.steps.precheck3.ms));
  row('Whole flow', col((r) => r.totalMs));
  md();
  const bad = runs.filter((r) => r.divergenceAtEnd.diverged > 0).length;
  md(`Runs where the receiver's cards disagreed with NovaDesk at the end: **${bad} of ${n}**.`); md();
  return runs;
}

// ---------------------------------------------------------------- E2 callback loss
const FAULTS = {
  none: { mode: 'normal', args: {} },
  refuse: { mode: 'refuse', args: {} },
  html404: { mode: 'html404', args: {} },
  status500: { mode: 'status500', args: {} },
  slow: { mode: 'slow', args: { ms: 8000 } },
  flaky: { mode: 'flaky', args: { p: 0.5 } }
};
async function e2() {
  const faults = opt('faults', 'none,refuse,html404,status500,slow,flaky').split(',');
  const windows = opt('windows', 'approve,prechecks,all').split(',');
  const reps = Number(opt('reps', 1));
  const grace = Number(opt('grace', 30));
  const doHang = opt('hang', 'yes') === 'yes';
  say(`E2: faults=${faults} windows=${windows} reps=${reps} grace=${grace}s hang=${doHang}`);
  const runs = [];
  for (const f of faults) {
    const wins = f === 'none' ? ['none'] : windows;
    for (const w of wins) {
      for (let k = 1; k <= reps; k++) {
        const r = await runFlow({ fault: FAULTS[f].mode, faultArgs: FAULTS[f].args, window: w, graceSec: grace });
        r.faultLabel = f;
        runs.push(r);
        say(`  ${f}/${w} #${k}: approve=${r.steps.approve.status} diverged end=${r.divergenceAtEnd.diverged} after ${grace}s=${r.divergenceAfterGrace.diverged} blocked=${r.blocked} hits=${r.callbackHits}`);
        save('e2.json', runs);
      }
    }
  }
  if (doHang) {
    const r = await runFlow({ fault: 'hang', window: 'approve', graceSec: grace, hang: true });
    r.faultLabel = 'hang';
    runs.push(r);
    say(`  hang/approve: approve client wait ${sec(r.steps.approve.ms)}s (${r.steps.approve.error || r.steps.approve.status}), diverged after ${grace}s=${r.divergenceAfterGrace.diverged}`);
    save('e2.json', runs);
  }

  md('## E2. Callback loss and misrouting (NovaDesk to receiver)'); md();
  md(`Fault active during the named window. "Diverged" counts chat cards whose status differs from what NovaDesk's records say they should be (a card that never arrived counts). "After ${grace}s" is measured with the fault cleared and no operator action, to see whether anything repairs itself. "Blocked" is the number of precheck steps where the card an operator would need to click was not in the chat.`); md();
  md(`| Fault | Window | Approve HTTP (s) | Diverged at end | Diverged after ${grace}s | Blocked | Callback hits (attempts) |`);
  md('|---|---|---|---|---|---|---|');
  for (const r of runs) {
    md(`| ${r.faultLabel} | ${r.window} | ${r.steps.approve.status || r.steps.approve.error} (${sec(r.steps.approve.ms)}) | ${r.divergenceAtEnd.diverged} | ${r.divergenceAfterGrace ? r.divergenceAfterGrace.diverged : '-'} | ${r.blocked} | ${r.callbackHits} |`);
  }
  md();
  const damaged = runs.filter((r) => r.faultLabel !== 'none' && r.divergenceAfterGrace && r.divergenceAfterGrace.diverged > 0);
  const nd_ok = runs.filter((r) => r.nd && r.nd.approval_status === 'approved').length;
  md(`NovaDesk reached "approved" in **${nd_ok} of ${runs.length}** runs regardless of callback faults. Faulted runs still divergent after the grace period with no operator action: **${damaged.length} of ${runs.filter((r) => r.faultLabel !== 'none').length}**.`); md();
  return runs;
}

// ---------------------------------------------------------------- E4 scheduler / soak
async function prepareApproved(label, opts) {
  await resetStub();
  const { changeId } = await newChange(label, opts);
  const ap = await approve(changeId);
  if (ap.status !== 200) throw new Error(`approve failed in prepare: ${ap.status}`);
  return changeId;
}
const insertDestroy = (changeId, runAtMs) => psql(`INSERT INTO scheduled_actions (change_id, action_type, run_at) VALUES (${changeId}, 'destroy_vm', '${utc(runAtMs)}') RETURNING id`, { firstLine: true });
const schedRow = (changeId) => q(`SELECT id, status, run_at, executed_at, attempts, delivered_targets FROM scheduled_actions WHERE change_id=${changeId} ORDER BY id DESC LIMIT 1`)[0];
async function waitForCard(changeId, cardType, timeoutMs) {
  const w0 = Date.now();
  while (Date.now() - w0 < timeoutMs) {
    const st = await stubState();
    const c = st.cards.find((x) => Number(x.changeId) === Number(changeId) && x.cardType === cardType);
    if (c) return c;
    await sleep(1000);
  }
  return null;
}

async function e4() {
  say('E4: scheduler and soak-period cases (scheduler polls every 30 s)');
  const out = [];

  say('  4a normal delivery');
  { const id = await prepareApproved('S4A'); const due = Date.now() + 5000; insertDestroy(id, due);
    const c = await waitForCard(id, 'decom_confirm_destroy', 90000);
    out.push({ case: '4a', title: 'Destroy-confirm card delivered when the soak timer is due', arrived: !!c, delaySec: c ? sec(c.createdAt - due) : null, sched: schedRow(id).status }); }

  say('  4b restart before due');
  { const id = await prepareApproved('S4B'); const due = Date.now() + 50000; insertDestroy(id, due);
    await sleep(5000); podman('restart', 'fi-novadesk'); const up = await waitHealthy();
    const c = await waitForCard(id, 'decom_confirm_destroy', 150000);
    out.push({ case: '4b', title: 'NovaDesk restarted while the timer was pending', restartHealthySec: sec(up), arrived: !!c, delaySec: c ? sec(c.createdAt - due) : null, sched: schedRow(id).status }); }

  say('  4c overdue at boot');
  { const id = await prepareApproved('S4C'); podman('stop', 'fi-novadesk'); insertDestroy(id, Date.now() - 600000);
    podman('start', 'fi-novadesk'); const t0 = Date.now(); await waitHealthy(); const healthyAt = Date.now();
    const c = await waitForCard(id, 'decom_confirm_destroy', 120000);
    out.push({ case: '4c', title: 'Timer already overdue when NovaDesk boots', arrived: !!c, secAfterHealthy: c ? sec(c.createdAt - healthyAt) : null, bootSec: sec(healthyAt - t0), sched: schedRow(id).status }); }

  say('  4d receiver down when the timer fires, then restored');
  { const id = await prepareApproved('S4D'); await setFault('refuse'); const due = Date.now() + 5000; insertDestroy(id, due);
    await sleep(45000); const duringSched = schedRow(id);
    const restoredAt = Date.now(); await setFault('normal');
    const c = await waitForCard(id, 'decom_confirm_destroy', 120000);
    const after = schedRow(id);
    const acts = q(`SELECT message FROM activity_log WHERE entity_type='change' AND entity_id=${id} AND (message LIKE '%Confirm Destroy card%') ORDER BY id`).map((x) => x.message);
    const soak = q(`SELECT count(*)::int AS n FROM scheduled_actions WHERE change_id=${id} AND status IN ('pending','executed') AND run_at <= '${utc(Date.now())}'`)[0].n;
    out.push({ case: '4d', title: 'Receiver unreachable at the moment the timer fires, restored 45 s later', statusWhileDown: duringSched.status, attemptsWhileDown: duringSched.attempts, statusAfterRestore: after.status, attemptsAfterRestore: after.attempts, cardArrived: !!c, secAfterRestore: c ? sec(c.createdAt - restoredAt) : null, cardCopies: (await stubState()).cards.filter((x) => Number(x.changeId) === id && x.cardType === 'decom_confirm_destroy').length, ndChangeStatus: changeRow(id).status, soakCheckStillPasses: soak > 0, activity: acts }); }

  say('  4e only one of two targets fails when the timer fires');
  { const id = await prepareApproved('S4E', { conversationId: 7 }); await setFault('failtarget', { target: 'dm:7' }); const due = Date.now() + 5000; insertDestroy(id, due);
    // wait until the channel copy has landed while the DM copy is still failing
    const chan = await waitForCard(id, 'decom_confirm_destroy', 90000);
    await sleep(35000); // at least one more poll with the DM still failing
    const mid = (await stubState()).cards.filter((x) => Number(x.changeId) === id && x.cardType === 'decom_confirm_destroy');
    const midSched = schedRow(id);
    await setFault('normal');
    const w0 = Date.now(); let dm = null;
    while (Date.now() - w0 < 120000 && !dm) { dm = (await stubState()).cards.find((x) => Number(x.changeId) === id && x.cardType === 'decom_confirm_destroy' && x.targetKind === 'dm'); if (!dm) await sleep(1000); }
    const fin = (await stubState()).cards.filter((x) => Number(x.changeId) === id && x.cardType === 'decom_confirm_destroy');
    const after = schedRow(id);
    out.push({ case: '4e', title: 'Card reaches the channel, fails for the DM, DM restored', channelCopyArrived: !!chan, copiesWhileDmFailing: mid.length, statusWhileDmFailing: midSched.status, dmArrivedAfterRestore: !!dm, channelCopiesAtEnd: fin.filter((x) => x.targetKind === 'channel').length, dmCopiesAtEnd: fin.filter((x) => x.targetKind === 'dm').length, statusAtEnd: after.status, attemptsAtEnd: after.attempts }); }

  save('e4.json', out);
  md('## E4. Soak-period scheduler'); md();
  md('| Case | Scenario | Result |'); md('|---|---|---|');
  for (const o of out) {
    let res = '';
    if (o.case === '4a') res = `card ${o.arrived ? 'arrived' : 'NEVER arrived'}${o.delaySec ? `, ${o.delaySec} s after due` : ''}; action status "${o.sched}"`;
    if (o.case === '4b') res = `restart took ${o.restartHealthySec} s to be healthy; card ${o.arrived ? 'arrived' : 'NEVER arrived'}${o.delaySec ? `, ${o.delaySec} s after due` : ''}; action status "${o.sched}"`;
    if (o.case === '4c') res = `boot took ${o.bootSec} s; card ${o.arrived ? `arrived ${o.secAfterHealthy} s after healthy` : 'NEVER arrived'}; action status "${o.sched}"`;
    if (o.case === '4d') res = `action "${o.statusWhileDown}" (${o.attemptsWhileDown} attempts) while down, "${o.statusAfterRestore}" (${o.attemptsAfterRestore} attempts) after restore; card ${o.cardArrived ? `arrived ${o.secAfterRestore} s after restore, ${o.cardCopies} copy` : '**NEVER arrived**'}; Change "${o.ndChangeStatus}"; NovaDesk-side soak check passes: ${o.soakCheckStillPasses}; activity log: ${o.activity.length ? o.activity.map((a) => `"${a}"`).join(' / ') : 'none'}`;
    if (o.case === '4e') res = `channel copy ${o.channelCopyArrived ? 'arrived' : 'missing'}; while the DM failed: ${o.copiesWhileDmFailing} copy in total, action "${o.statusWhileDmFailing}"; after restore the DM copy ${o.dmArrivedAfterRestore ? 'arrived' : '**never arrived**'}; final copies: channel ${o.channelCopiesAtEnd}, DM ${o.dmCopiesAtEnd}; action "${o.statusAtEnd}" after ${o.attemptsAtEnd} attempts`;
    md(`| ${o.case} | ${o.title} | ${res} |`);
  }
  md();
  return out;
}

// ---------------------------------------------------------------- E5 probes
async function cardCounts(changeId) {
  const st = await stubState();
  const mine = st.cards.filter((c) => Number(c.changeId) === Number(changeId));
  const by = (t) => mine.filter((c) => c.cardType === t).length;
  return { approval: by('decom_approval'), precheck: by('decom_precheck_task'), status: by('decom_status'), messages: st.messages };
}
async function e5() {
  say('E5: state-machine and idempotency probes');
  const P = [];
  const add = (id, title, expected, observed, ok, note = '') => { P.push({ id, title, expected, observed, ok, note }); say(`  ${id} ${ok ? 'ok  ' : 'FIND'} ${title}: ${observed}`); };

  // Today's defaults on a fresh request.
  { await resetStub(); const { changeId } = await newChange('P0'); const c = changeRow(changeId);
    const days = (Date.parse(c.planned_end.replace(' ', 'T') + 'Z') - Date.parse(c.planned_start.replace(' ', 'T') + 'Z')) / 86400000;
    add('P0', 'New request defaults', 'group IRO-Build/Decom, assignee admin, planned end = start + 1 day', `group=${c.assignment_group}, assigned_to=${c.assigned_to}, span=${days} day(s)`, c.assignment_group === 'IRO-Build/Decom' && c.assigned_to && days === 1); }

  // Input validation and authorisation.
  { const r = await nd('POST', REQ, { hostname: 'FI-NO-SUCH-HOST', novaconnect_channel_id: CHANNEL, requested_by_username: 'admin' }); add('P1', 'Unknown hostname', '404', String(r.status), r.status === 404); }
  { const vm = makeVm('ORPHAN', { linked: false }); const r = await nd('POST', REQ, { hostname: vm.name, novaconnect_channel_id: CHANNEL, requested_by_username: 'admin' }); add('P2', 'CI with no runs_on host', '422', String(r.status), r.status === 422); }
  { const vm = makeVm('NOCHAN'); const r = await nd('POST', REQ, { hostname: vm.name, requested_by_username: 'admin' }); add('P3', 'Missing channel/conversation id', '400', String(r.status), r.status === 400); }
  { const r = await nd('POST', REQ, { hostname: 'x', novaconnect_channel_id: CHANNEL }, { auth: 'wrong-key' }); add('P4', 'Wrong service key', '401', String(r.status), r.status === 401); }
  { await resetStub(); const { changeId } = await newChange('P5'); const r = await nd('POST', `${REQ}/${changeId}/approve`, { approved_by_username: 'jdoe' }); const c = changeRow(changeId);
    add('P5', 'Approve as a non-admin (agent)', '403 and approval stays pending', `${r.status}, approval_status=${c.approval_status}`, r.status === 403 && c.approval_status === 'pending'); }

  // Duplicate and out-of-order actions.
  { await resetStub(); const { changeId } = await newChange('P6'); await approve(changeId); const before = await cardCounts(changeId);
    const r2 = await approve(changeId); const after = await cardCounts(changeId);
    add('P6', 'Approve the same Change twice', 'second call refused (4xx), no extra cards or messages', `second status=${r2.status}; precheck cards ${before.precheck}->${after.precheck}; status messages ${before.status}->${after.status}`, r2.status >= 400 && after.precheck === before.precheck && after.status === before.status); }
  { await resetStub(); const { changeId } = await newChange('P7'); await reject(changeId); const r = await approve(changeId); const c = changeRow(changeId);
    add('P7', 'Approve after reject', 'refused (4xx), stays rejected', `status=${r.status}; now status=${c.status}, approval=${c.approval_status}`, r.status >= 400 && c.approval_status === 'rejected'); }
  { await resetStub(); const { changeId } = await newChange('P8'); await approve(changeId); const r = await reject(changeId); const c = changeRow(changeId); const t = tasksOf(changeId).map((x) => x.status).join(',');
    add('P8', 'Reject after approve (work already started)', 'refused (4xx), stays approved/in progress', `status=${r.status}; now status=${c.status}, approval=${c.approval_status}`, r.status >= 400 && c.approval_status === 'approved', `tasks: ${t}`); }
  { await resetStub(); const { changeId } = await newChange('P9'); psql(`UPDATE changes SET status='closed' WHERE id=${changeId}`); const r = await approve(changeId); const c = changeRow(changeId);
    add('P9', 'Approve a closed Change', 'refused (4xx), stays closed', `status=${r.status}; now status=${c.status}, approval=${c.approval_status}`, r.status >= 400 && c.status === 'closed'); }
  { await resetStub(); const { changeId } = await newChange('P10'); await approve(changeId); const t1 = tasksOf(changeId).find((x) => x.description === MANUAL[0]);
    await precheck(changeId, t1.id); const before = await cardCounts(changeId); const r2 = await precheck(changeId, t1.id); const after = await cardCounts(changeId);
    add('P10', 'Complete the same precheck twice', 'second call refused or no-op: no extra cards', `second status=${r2.status}; precheck cards ${before.precheck}->${after.precheck}`, after.precheck === before.precheck); }
  { await resetStub(); const { changeId } = await newChange('P11'); const t1 = tasksOf(changeId).find((x) => x.description === MANUAL[0]); const r = await precheck(changeId, t1.id); const c = changeRow(changeId); const t = tasksOf(changeId).find((x) => x.id === t1.id);
    add('P11', 'Complete a precheck before the Change is approved', 'refused (4xx), task stays pending', `status=${r.status}; task now ${t.status}; approval=${c.approval_status}`, r.status >= 400 && t.status === 'pending'); }
  // Confirm-destroy guard: approved + VM powered off by this workflow + soak period over. In the
  // rig there are no ESXi credentials, so a request that passes the guard fails later, at the ESXi
  // step (HTTP 500); a request the guard refuses is a 409 and never reaches ESXi.
  const confirmDestroy = (id) => nd('POST', `${REQ}/${id}/confirm-destroy`, { confirmed_by_username: 'admin' }, { timeoutMs: 60000 });
  const markPoweredOff = (id) => psql(`UPDATE change_tasks SET status='done', completed_at='${utc(Date.now())}' WHERE change_id=${id} AND description='Power off — soak period'`);
  const msg = (r) => (r.json && r.json.error) ? r.json.error : (r.error || '');
  { await resetStub(); const { changeId } = await newChange('P12'); await approve(changeId); const r = await confirmDestroy(changeId); const c = changeRow(changeId);
    add('P12', 'Confirm destroy right after approval (no power-off, no soak)', '409 from the guard, Change not closed', `status=${r.status}; Change ${c.status}; "${msg(r).slice(0, 70)}"`, r.status === 409 && c.status !== 'closed'); }
  { await resetStub(); const { changeId } = await newChange('P12B'); await approve(changeId); markPoweredOff(changeId); insertDestroy(changeId, Date.now() + 3600000); const r = await confirmDestroy(changeId); const c = changeRow(changeId);
    add('P12b', 'Confirm destroy after power-off but while the soak period is still running', '409 naming when the soak ends', `status=${r.status}; Change ${c.status}; "${msg(r).slice(0, 90)}"`, r.status === 409 && /soak period is not over/.test(msg(r)) && c.status !== 'closed'); }
  { await resetStub(); const { changeId } = await newChange('P12C'); await approve(changeId); insertDestroy(changeId, Date.now() - 60000); const r = await confirmDestroy(changeId); const c = changeRow(changeId);
    add('P12c', 'Confirm destroy with a due timer but the VM never recorded as powered off', '409 from the guard', `status=${r.status}; Change ${c.status}; "${msg(r).slice(0, 70)}"`, r.status === 409 && c.status !== 'closed'); }
  { await resetStub(); const { changeId } = await newChange('P12D'); await approve(changeId); markPoweredOff(changeId); insertDestroy(changeId, Date.now() - 60000); const r = await confirmDestroy(changeId); const c = changeRow(changeId);
    add('P12d', 'Confirm destroy with everything satisfied (approved, powered off, soak over)', 'passes the guard; rig then fails at the ESXi step (HTTP 500, no credentials), Change not closed', `status=${r.status}; Change ${c.status}; "${msg(r).slice(0, 70)}"`, r.status !== 409 && c.status !== 'closed'); }
  { await resetStub(); const { changeId } = await newChange('P13'); await reject(changeId); const r = await nd('POST', `${REQ}/${changeId}/cancel-destroy`, { cancelled_by_username: 'admin' }, { timeoutMs: 60000 });
    add('P13', 'Cancel-destroy on a rejected Change', '409', String(r.status), r.status === 409); }

  save('e5.json', P);
  md('## E5. State machine and idempotency probes'); md();
  md('"Expected" is the safe behaviour for an operation that gates an irreversible action. A row marked FINDING means the observed behaviour differs.'); md();
  md('| # | Probe | Expected | Observed | Result |'); md('|---|---|---|---|---|');
  for (const p of P) md(`| ${p.id} | ${p.title} | ${p.expected} | ${p.observed}${p.note ? ` (${p.note})` : ''} | ${p.ok ? 'ok' : '**FINDING**'} |`);
  md();
  const f = P.filter((p) => !p.ok).length;
  md(`${P.length - f} of ${P.length} probes behaved as expected; **${f} findings**.`); md();
  return P;
}

// ---------------------------------------------------------------- main
(async () => {
  try {
    if (cmd === 'help') { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 14).join('\n')); return; }
    const env = await check();
    md('# Fault-injection results'); md();
    md(`Rig: image \`${env.NOVADESK_RELEASE_VERSION}\` build against an isolated database, receiver stubbed, no ESXi credentials. Run started ${new Date().toISOString()}.`); md();
    if (cmd === 'check') return;
    if (cmd === 'e1' || cmd === 'all') await e1();
    if (cmd === 'e5' || cmd === 'all') await e5();
    if (cmd === 'e4' || cmd === 'all') await e4();
    if (cmd === 'e2' || cmd === 'all') await e2();
    flushSummary('summary.md');
    say('results written to', OUT);
  } catch (e) {
    console.error('HARNESS ERROR:', e.stack || e.message);
    flushSummary('summary.partial.md');
    process.exitCode = 1;
  }
})();
