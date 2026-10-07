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
//   node harness.js e6                                card ledger cases (restart, long outage, dead target)
//   node harness.js e7                                the Change page 'chat is catching up' indicator
//   node harness.js e8                                HTTP 5xx answers (inline retry rules)
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
// What the chat should show, given NovaDesk's own records, versus what the receiver holds.
// "strict" counts every card whose status differs or that never arrived. "actionable" counts what
// matters to an operator: a card that still offers buttons for finished work (stale), or a card
// that is still needed (pending) but never arrived. A card for work that already finished and
// never arrived is "missing historical": the design deliberately does not post those late.
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
    return {
      ...e, receiver: got, copies: m.length, diverged: got !== e.expect,
      stale: m.length > 0 && got !== e.expect,
      missingActionable: m.length === 0 && e.expect === 'pending',
      missingHistorical: m.length === 0 && e.expect !== 'pending'
    };
  });
  return {
    rows,
    diverged: rows.filter((r) => r.diverged).length,
    actionable: rows.filter((r) => r.stale || r.missingActionable).length,
    missingHistorical: rows.filter((r) => r.missingHistorical).length,
    duplicates: rows.filter((r) => r.copies > 1).length
  };
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
  const { fault = 'normal', faultArgs = {}, window = 'none', graceSec = 0, hang = false, holdSec = 0 } = opts;
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
  if (holdSec > 0) { await sleep(holdSec * 1000); rec.faultHeldExtraSec = holdSec; }
  const tClear = Date.now();
  await setFault('normal');
  rec.totalMs = Date.now() - t0;

  rec.nd = { ...changeRow(changeId), tasks: tasksOf(changeId).map((t) => `${t.sequence}:${t.status}`) };
  const st0 = await stubState();
  rec.divergenceAtEnd = divergence(changeId, st0);
  if (graceSec > 0) {
    // No operator action from here: measure how long the chat takes to catch up on its own, up to graceSec.
    rec.convergedAfterSec = null;
    let last = rec.divergenceAtEnd;
    while (true) {
      if (last.actionable === 0) { rec.convergedAfterSec = Number(((Date.now() - tClear) / 1000).toFixed(1)); break; }
      if (Date.now() - tClear >= graceSec * 1000) break;
      await sleep(3000);
      last = divergence(changeId, await stubState());
    }
    rec.divergenceAfterGrace = last;
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
  const grace = Number(opt('grace', 120));
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
        say(`  ${f}/${w} #${k}: approve=${r.steps.approve.status} actionable end=${r.divergenceAtEnd.actionable} converged=${r.convergedAfterSec === null ? 'NEVER (' + r.divergenceAfterGrace.actionable + ' left)' : r.convergedAfterSec + 's'} strict-after=${r.divergenceAfterGrace.diverged} dup=${r.divergenceAfterGrace.duplicates} blocked=${r.blocked}`);
        save('e2.json', runs);
      }
    }
  }
  if (doHang) {
    const r = await runFlow({ fault: 'hang', window: 'approve', graceSec: grace, hang: true });
    r.faultLabel = 'hang';
    runs.push(r);
    say(`  hang/approve: approve client wait ${sec(r.steps.approve.ms)}s (${r.steps.approve.error || r.steps.approve.status}), actionable after=${r.divergenceAfterGrace.actionable}`);
    save('e2.json', runs);
  }

  md('## E2. Callback faults (NovaDesk to receiver)'); md();
  md(`Fault active during the named window, then cleared with no operator action; the harness then waits up to ${grace} s for the chat to catch up. "Actionable" counts what matters to an operator: a card still offering buttons for finished work, or a card still needed that never arrived. "Strict" also counts cards for finished work that never arrived (the design deliberately does not post those late). "Blocked" is the number of pre-check steps where the card the operator needed was not in the chat when they acted.`); md();
  md('| Fault | Window | Approve HTTP (s) | Actionable at end | Converged in (s) | Actionable left | Strict left | Duplicate cards | Blocked |');
  md('|---|---|---|---|---|---|---|---|---|');
  for (const r of runs) {
    const d1 = r.divergenceAfterGrace;
    md(`| ${r.faultLabel} | ${r.window} | ${r.steps.approve.status || r.steps.approve.error} (${sec(r.steps.approve.ms)}) | ${r.divergenceAtEnd.actionable} | ${r.convergedAfterSec === null || r.convergedAfterSec === undefined ? 'never' : r.convergedAfterSec} | ${d1 ? d1.actionable : '-'} | ${d1 ? d1.diverged : '-'} | ${d1 ? d1.duplicates : '-'} | ${r.blocked} |`);
  }
  md();
  const faulted = runs.filter((r) => r.faultLabel !== 'none');
  const conv = faulted.filter((r) => r.convergedAfterSec !== null && r.convergedAfterSec !== undefined);
  const times = conv.map((r) => r.convergedAfterSec).sort((a, b) => a - b);
  md(`NovaDesk reached "approved" in **${runs.filter((r) => r.nd && r.nd.approval_status === 'approved').length} of ${runs.length}** runs. Faulted runs that converged on their own: **${conv.length} of ${faulted.length}**${times.length ? ` (median ${times[Math.floor(times.length / 2)]} s, max ${times[times.length - 1]} s after the fault cleared)` : ''}. Duplicate card copies seen after waiting: **${runs.reduce((n, r) => n + (r.divergenceAfterGrace ? r.divergenceAfterGrace.duplicates : 0), 0)}**.`); md();
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
const ledgerFor = (changeId, cardType, taskId = 0) => q(`SELECT done, attempts, delivered_status, posted_targets, dead_targets, fail_counts, last_error FROM decom_card_sync WHERE change_id=${changeId} AND card_type='${cardType}' AND task_id=${taskId}`)[0] || null;
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
    await sleep(45000); const down = ledgerFor(id, 'decom_confirm_destroy'); const timerWhileDown = schedRow(id).status;
    const restoredAt = Date.now(); await setFault('normal');
    const c = await waitForCard(id, 'decom_confirm_destroy', 150000);
    const after = ledgerFor(id, 'decom_confirm_destroy');
    const acts = q(`SELECT message FROM activity_log WHERE entity_type='change' AND entity_id=${id} AND (message LIKE '%Confirm Destroy card%') ORDER BY id`).map((x) => x.message);
    const soak = q(`SELECT count(*)::int AS n FROM scheduled_actions WHERE change_id=${id} AND status IN ('pending','executed') AND run_at <= '${utc(Date.now())}'`)[0].n;
    out.push({ case: '4d', title: 'Receiver unreachable at the moment the timer fires, restored 45 s later', timerWhileDown, ledgerWhileDown: down, ledgerAfter: after, cardArrived: !!c, secAfterRestore: c ? sec(c.createdAt - restoredAt) : null, cardCopies: (await stubState()).cards.filter((x) => Number(x.changeId) === id && x.cardType === 'decom_confirm_destroy').length, ndChangeStatus: changeRow(id).status, soakCheckStillPasses: soak > 0, activity: acts }); }

  say('  4e only one of two targets fails when the timer fires');
  { const id = await prepareApproved('S4E', { conversationId: 7 }); await setFault('failtarget', { target: 'dm:7' }); const due = Date.now() + 5000; insertDestroy(id, due);
    const chan = await waitForCard(id, 'decom_confirm_destroy', 90000);
    // The rig gives up on a target after 3 failures (CARD_SYNC_DEAD_AFTER=3, the production default is 30),
    // so restore the DM before the third failed attempt; abandoning a target is E6 case 6c's job.
    await sleep(7000);
    const mid = (await stubState()).cards.filter((x) => Number(x.changeId) === id && x.cardType === 'decom_confirm_destroy');
    const midLedger = ledgerFor(id, 'decom_confirm_destroy');
    await setFault('normal');
    const w0 = Date.now(); let dm = null;
    while (Date.now() - w0 < 120000 && !dm) { dm = (await stubState()).cards.find((x) => Number(x.changeId) === id && x.cardType === 'decom_confirm_destroy' && x.targetKind === 'dm'); if (!dm) await sleep(1000); }
    const fin = (await stubState()).cards.filter((x) => Number(x.changeId) === id && x.cardType === 'decom_confirm_destroy');
    out.push({ case: '4e', title: 'Card reaches the channel, fails for the DM, DM restored', channelCopyArrived: !!chan, copiesWhileDmFailing: mid.length, ledgerWhileDmFailing: midLedger, dmArrivedAfterRestore: !!dm, channelCopiesAtEnd: fin.filter((x) => x.targetKind === 'channel').length, dmCopiesAtEnd: fin.filter((x) => x.targetKind === 'dm').length, ledgerAtEnd: ledgerFor(id, 'decom_confirm_destroy') }); }

  save('e4.json', out);
  md('## E4. Soak-period scheduler'); md();
  md('| Case | Scenario | Result |'); md('|---|---|---|');
  for (const o of out) {
    let res = '';
    if (o.case === '4a') res = `card ${o.arrived ? 'arrived' : 'NEVER arrived'}${o.delaySec ? `, ${o.delaySec} s after due` : ''}; action status "${o.sched}"`;
    if (o.case === '4b') res = `restart took ${o.restartHealthySec} s to be healthy; card ${o.arrived ? 'arrived' : 'NEVER arrived'}${o.delaySec ? `, ${o.delaySec} s after due` : ''}; action status "${o.sched}"`;
    if (o.case === '4c') res = `boot took ${o.bootSec} s; card ${o.arrived ? `arrived ${o.secAfterHealthy} s after healthy` : 'NEVER arrived'}; action status "${o.sched}"`;
    const L = (x) => (x ? `done=${x.done}, ${x.attempts} failed attempt(s)` : 'no ledger row');
    if (o.case === '4d') res = `timer "${o.timerWhileDown}" (card handed to the ledger); while down: ${L(o.ledgerWhileDown)}; after restore: ${L(o.ledgerAfter)}; card ${o.cardArrived ? `arrived ${o.secAfterRestore} s after restore, ${o.cardCopies} copy` : '**NEVER arrived**'}; Change "${o.ndChangeStatus}"; NovaDesk-side soak check passes: ${o.soakCheckStillPasses}; activity log: ${o.activity.length ? o.activity.map((a) => `"${a}"`).join(' / ') : 'none'}`;
    if (o.case === '4e') res = `channel copy ${o.channelCopyArrived ? 'arrived' : 'missing'}; while the DM failed: ${o.copiesWhileDmFailing} copy in total, ledger ${L(o.ledgerWhileDmFailing)}; after restore the DM copy ${o.dmArrivedAfterRestore ? 'arrived' : '**never arrived**'}; final copies: channel ${o.channelCopiesAtEnd}, DM ${o.dmCopiesAtEnd}; ledger ${L(o.ledgerAtEnd)}`;
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

// ---------------------------------------------------------------- E6 card ledger
async function waitConverged(changeId, maxSec) {
  const t0 = Date.now();
  while (true) {
    const d = divergence(changeId, await stubState());
    if (d.actionable === 0 || Date.now() - t0 > maxSec * 1000) return { sec: Number(((Date.now() - t0) / 1000).toFixed(1)), d, converged: d.actionable === 0 };
    await sleep(3000);
  }
}
async function e6() {
  say('E6: card ledger cases');
  const out = [];

  say('  6a NovaDesk restarts while cards are undelivered');
  { await resetStub(); const { changeId } = await newChange('L6A'); await setFault('refuse'); const ap = await approve(changeId);
    const atFault = divergence(changeId, await stubState());
    const rowsBefore = q(`SELECT card_type, desired_status, done, attempts FROM decom_card_sync WHERE change_id=${changeId} ORDER BY id`);
    podman('restart', 'fi-novadesk'); await waitHealthy();
    await setFault('normal'); const c = await waitConverged(changeId, 180);
    out.push({ case: '6a', title: 'NovaDesk restarted while its cards were undelivered, receiver then restored', approveStatus: ap.status, actionableWhileDown: atFault.actionable, ledgerRowsBeforeRestart: rowsBefore, converged: c.converged, convergedAfterSec: c.sec, actionableLeft: c.d.actionable, duplicates: c.d.duplicates }); }

  say('  6b long outage across the whole flow');
  { const r = await runFlow({ fault: 'refuse', window: 'all', holdSec: 120, graceSec: 180 });
    out.push({ case: '6b', title: 'Receiver down for the whole flow plus 2 more minutes, then restored', outageSec: Math.round((r.totalMs / 1000) + 120), actionableAtEnd: r.divergenceAtEnd.actionable, converged: r.convergedAfterSec !== null, convergedAfterSec: r.convergedAfterSec, actionableLeft: r.divergenceAfterGrace.actionable, duplicates: r.divergenceAfterGrace.duplicates }); }

  say('  6c a target that keeps failing while NovaConnect is healthy');
  { await resetStub(); const { changeId } = await newChange('L6C', { conversationId: 7 }); await setFault('failtarget', { target: 'dm:7' }); await approve(changeId);
    const w0 = Date.now(); let ledger = null;
    while (Date.now() - w0 < 180000) { ledger = ledgerFor(changeId, 'decom_precheck_task', tasksOf(changeId).find((t) => t.description === MANUAL[0]).id); if (ledger && JSON.parse(ledger.dead_targets).includes('dm:7')) break; await sleep(3000); }
    const failHits1 = (await stubLog(0)).filter((e) => e.outcome === '500-target').length;
    await sleep(40000);
    const failHits2 = (await stubLog(0)).filter((e) => e.outcome === '500-target').length;
    const acts = q(`SELECT message FROM activity_log WHERE entity_type='change' AND entity_id=${changeId} AND message LIKE '%giving up on that target%'`).map((x) => x.message);
    const copies = (await stubState()).cards.filter((x) => Number(x.changeId) === changeId && x.cardType === 'decom_precheck_task');
    out.push({ case: '6c', title: 'DM target fails repeatedly while the channel and NovaConnect are healthy', markedDead: !!ledger && JSON.parse(ledger.dead_targets).includes('dm:7'), ledger, failedPostsAtGiveUp: failHits1, failedPostsAfterWaiting40s: failHits2, channelCopies: copies.filter((x) => x.targetKind === 'channel').length, dmCopies: copies.filter((x) => x.targetKind === 'dm').length, activity: acts }); }

  say('  6d outage with an operator finishing a step meanwhile');
  { await resetStub(); const { changeId } = await newChange('L6D'); await setFault('refuse'); await approve(changeId);
    const t1 = tasksOf(changeId).find((t) => t.description === MANUAL[0]);
    const pr = await precheck(changeId, t1.id, 'complete'); // done in NovaDesk while its card was never delivered
    await setFault('normal'); const c = await waitConverged(changeId, 180);
    const cards = (await stubState()).cards.filter((x) => Number(x.changeId) === changeId && x.cardType === 'decom_precheck_task');
    const t2 = tasksOf(changeId).find((t) => t.description === MANUAL[1]);
    out.push({ case: '6d', title: 'Pre-check 1 completed in NovaDesk while its card was never delivered; receiver restored', precheckStatus: pr.status, converged: c.converged, convergedAfterSec: c.sec, lateCardForFinishedTask: cards.filter((x) => Number(x.taskId) === t1.id).length, nextCardPendingPresent: cards.some((x) => Number(x.taskId) === t2.id && x.status === 'pending'), duplicates: c.d.duplicates }); }

  save('e6.json', out);
  md('## E6. Card ledger cases'); md();
  md('| Case | Scenario | Result |'); md('|---|---|---|');
  for (const o of out) {
    let res = '';
    if (o.case === '6a') res = `approve ${o.approveStatus}; ${o.actionableWhileDown} card(s) wrong while down; ledger rows before restart: ${o.ledgerRowsBeforeRestart.map((r) => `${r.card_type}->${r.desired_status} (done=${r.done})`).join(', ')}; after restart + restore: ${o.converged ? `converged in ${o.convergedAfterSec} s` : '**did not converge**'}, ${o.actionableLeft} wrong left, ${o.duplicates} duplicate card(s)`;
    if (o.case === '6b') res = `outage about ${o.outageSec} s; ${o.actionableAtEnd} card(s) wrong at the end of the outage; after restore: ${o.converged ? `converged in ${o.convergedAfterSec} s` : '**did not converge**'}, ${o.actionableLeft} wrong left, ${o.duplicates} duplicate card(s)`;
    if (o.case === '6c') res = `target ${o.markedDead ? 'marked dead' : '**never marked dead**'} (failed posts at give-up: ${o.failedPostsAtGiveUp}, 40 s later: ${o.failedPostsAfterWaiting40s}, so ${o.failedPostsAfterWaiting40s === o.failedPostsAtGiveUp ? 'no further attempts' : '**still retrying**'}); copies: channel ${o.channelCopies}, DM ${o.dmCopies}; activity log: ${o.activity.length ? o.activity.map((a) => `"${a}"`).join(' / ') : 'none'}`;
    if (o.case === '6d') res = `precheck ${o.precheckStatus}; after restore ${o.converged ? `converged in ${o.convergedAfterSec} s` : '**did not converge**'}; late card for the finished task: ${o.lateCardForFinishedTask} (expected 0); next pre-check card pending and present: ${o.nextCardPendingPresent}; duplicates ${o.duplicates}`;
    md(`| ${o.case} | ${o.title} | ${res} |`);
  }
  md();
  return out;
}

// ---------------------------------------------------------------- E7 Change page indicator
async function staffCookie() {
  const r = await fetch(ND + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=admin&password=admin123' });
  const set = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean);
  const cookie = set.map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error(`login failed (${r.status})`);
  return cookie;
}
async function changePage(cookie, id) {
  const r = await fetch(`${ND}/changes/${id}`, { headers: { Cookie: cookie } });
  const html = await r.text();
  return { status: r.status, html, catchingUp: /The NovaConnect chat is catching up/.test(html), notDelivered: /Some NovaConnect chat updates were not delivered/.test(html), text: (html.match(/<div class="alert alert-(?:warning|secondary) small"[\s\S]*?<\/ul>/) || [''])[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() };
}
async function e7() {
  say('E7: the "chat is catching up" indicator on the Change page');
  const cookie = await staffCookie();
  const out = [];

  { await resetStub(); const { changeId } = await newChange('I7A'); await approve(changeId); const p = await changePage(cookie, changeId);
    out.push({ case: '7a', title: 'Everything delivered', pageStatus: p.status, showsIndicator: p.catchingUp || p.notDelivered, text: p.text }); }

  { await resetStub(); const { changeId } = await newChange('I7B'); await setFault('refuse'); await approve(changeId);
    const during = await changePage(cookie, changeId);
    await setFault('normal'); const c = await waitConverged(changeId, 180);
    // the ledger finishes shortly after the chat does; give the page a moment to reflect it
    let after = await changePage(cookie, changeId); const w0 = Date.now();
    while ((after.catchingUp || after.notDelivered) && Date.now() - w0 < 60000) { await sleep(3000); after = await changePage(cookie, changeId); }
    out.push({ case: '7b', title: 'Receiver down during approval, then restored', pageStatusDuring: during.status, indicatorDuringOutage: during.catchingUp, textDuringOutage: during.text, converged: c.converged, indicatorAfterRecovery: after.catchingUp || after.notDelivered }); }

  { await resetStub(); const { changeId } = await newChange('I7C', { conversationId: 7 }); await setFault('failtarget', { target: 'dm:7' }); await approve(changeId);
    const w0 = Date.now(); let p = await changePage(cookie, changeId);
    while (!p.notDelivered && Date.now() - w0 < 120000) { await sleep(3000); p = await changePage(cookie, changeId); }
    out.push({ case: '7c', title: 'One target keeps failing until the ledger gives up on it', indicatorShowsGaveUp: p.notDelivered, stillSaysCatchingUp: p.catchingUp, text: p.text }); }

  save('e7.json', out);
  md('## E7. Change page indicator'); md();
  md('| Case | Scenario | Result |'); md('|---|---|---|');
  for (const o of out) {
    let res = '';
    if (o.case === '7a') res = `page ${o.pageStatus}; indicator shown: ${o.showsIndicator} (expected false)`;
    if (o.case === '7b') res = `during the outage the page ${o.indicatorDuringOutage ? 'showed' : '**did not show**'} "catching up"${o.textDuringOutage ? ` (${o.textDuringOutage.slice(0, 220)})` : ''}; chat converged: ${o.converged}; indicator after recovery: ${o.indicatorAfterRecovery} (expected false)`;
    if (o.case === '7c') res = `gave-up notice shown: ${o.indicatorShowsGaveUp}; text: ${o.text.slice(0, 260)}`;
    md(`| ${o.case} | ${o.title} | ${res} |`);
  }
  md();
  return out;
}

// ---------------------------------------------------------------- E8 HTTP 5xx handling
async function e8() {
  say('E8: HTTP 5xx answers from NovaConnect (an older NovaConnect that ignores idempotency keys; see E10 for the keyed behaviour)');
  const out = [];
  await ctl('POST', '/config', { honourKeys: false });
  const RES = '/api/integrations/novadesk/decom-updates/resolve';
  const POST = '/api/integrations/novadesk/decom-updates';
  const hits = (log, path, outcome) => log.filter((e) => e.path === path && (outcome ? e.outcome === outcome : true));

  say('  8a resolve answered 500 twice, then fine (safe to repeat: retried at once)');
  { await resetStub(); const { changeId } = await newChange('E8A'); await approve(changeId); await sleep(2500);
    const t1 = tasksOf(changeId).find((t) => t.description === MANUAL[0]);
    const t0 = Date.now(); await setFault('blip', { code: 500, n: 2, path: '/resolve' });
    const pr = await precheck(changeId, t1.id, 'complete'); await sleep(4000);
    const log = await stubLog(t0); const res = hits(log, RES);
    const ledger = ledgerFor(changeId, 'decom_precheck_task', t1.id); const c = await waitConverged(changeId, 120);
    out.push({ case: '8a', title: 'Resolve answered HTTP 500 twice, then fine', precheckStatus: pr.status, resolveRequests: res.length, failed: res.filter((e) => /blip/.test(e.outcome)).length, spanMs: res.length ? res[res.length - 1].t - res[0].t : 0, ledgerDone: ledger && ledger.done, ledgerAttempts: ledger && ledger.attempts, converged: c.converged, duplicates: c.d.duplicates }); }

  say('  8b resolve answered 503 three times (all inline attempts fail, ledger finishes the job)');
  { await resetStub(); const { changeId } = await newChange('E8B'); await approve(changeId); await sleep(2500);
    const t1 = tasksOf(changeId).find((t) => t.description === MANUAL[0]);
    const t0 = Date.now(); await setFault('blip', { code: 503, n: 3, path: '/resolve' });
    await precheck(changeId, t1.id, 'complete'); await sleep(1500);
    const c = await waitConverged(changeId, 120);
    const res = hits(await stubLog(t0), RES);
    out.push({ case: '8b', title: 'Resolve answered HTTP 503 three times', failed: res.filter((e) => /blip/.test(e.outcome)).length, requests: res.length, converged: c.converged, convergedAfterSec: c.sec, duplicates: c.d.duplicates }); }

  say('  8c card post answered 500 before it was saved (not repeated inline; ledger resends)');
  { await resetStub(); const { changeId } = await newChange('E8C'); const t0 = Date.now(); await setFault('blip', { code: 500, n: 1, path: '/decom-updates', cardType: 'decom_precheck_task' });
    await approve(changeId); const c = await waitConverged(changeId, 120);
    const posts = hits(await stubLog(t0), POST);     const cards = (await stubState()).cards.filter((x) => Number(x.changeId) === changeId && x.cardType === 'decom_precheck_task');
    out.push({ case: '8c', title: 'Card post answered HTTP 500 once (not saved)', failedPosts: posts.filter((e) => /blip/.test(e.outcome)).length, preCheckCardCopies: cards.length, converged: c.converged, convergedAfterSec: c.sec, duplicates: c.d.duplicates }); }

  say('  8d card post saved then answered 500 (the reason posts are not repeated inline)');
  { await resetStub(); const { changeId } = await newChange('E8D'); const t0 = Date.now(); await setFault('blip', { code: 500, n: 1, path: '/decom-updates', cardType: 'decom_precheck_task', saveFirst: true });
    await approve(changeId); await sleep(20000);
    const posts = hits(await stubLog(t0), POST);
    const cards = (await stubState()).cards.filter((x) => Number(x.changeId) === changeId && x.cardType === 'decom_precheck_task');
    out.push({ case: '8d', title: 'Card post saved, then answered HTTP 500 once', failedPosts: posts.filter((e) => /blip/.test(e.outcome)).length, preCheckCardCopies: cards.length }); }

  await ctl('POST', '/config', { honourKeys: true });
  save('e8.json', out);
  md('## E8. HTTP 5xx answers'); md();
  md('| Case | Scenario | Result |'); md('|---|---|---|');
  for (const o of out) {
    let res = '';
    if (o.case === '8a') res = `precheck ${o.precheckStatus}; resolve requests: ${o.resolveRequests} (${o.failed} failed) within ${o.spanMs} ms; ledger done=${o.ledgerDone}, failed attempts recorded=${o.ledgerAttempts} (expected done=1, 0); converged ${o.converged}; duplicates ${o.duplicates}`;
    if (o.case === '8b') res = `${o.requests} resolve requests in total, ${o.failed} of them failed (expected 4 and 3: three inline attempts, then one ledger retry); ${o.converged ? `converged in ${o.convergedAfterSec} s` : '**did not converge**'}; duplicates ${o.duplicates}`;
    if (o.case === '8c') res = `failed card posts: ${o.failedPosts} (not repeated inline); pre-check card copies: ${o.preCheckCardCopies} (expected 1); ${o.converged ? `converged in ${o.convergedAfterSec} s` : '**did not converge**'}; duplicates ${o.duplicates}`;
    if (o.case === '8d') res = `failed card posts: ${o.failedPosts}; pre-check card copies: ${o.preCheckCardCopies} (a second copy is the cost of resending a post whose first try was saved, when NovaConnect ignores idempotency keys; with NovaConnect 1.0.183 this is 1, see E10)`;
    md(`| ${o.case} | ${o.title} | ${res} |`);
  }
  md();
  return out;
}

// ---------------------------------------------------------------- E9 concurrent pre-check completion
async function e9() {
  say('E9: concurrent pre-check completion');
  const out = [];
  const count = (changeId, like) => Number(q(`SELECT count(*) AS n FROM activity_log WHERE entity_type='change' AND entity_id=${changeId} AND message LIKE '${like}'`)[0].n);

  say('  9a the same pre-check completed twice at the same moment');
  { await resetStub(); const { changeId } = await newChange('E9A'); await approve(changeId); await sleep(2000);
    const t1 = tasksOf(changeId).find((t) => t.description === MANUAL[0]); const t0 = Date.now();
    const [r1, r2] = await Promise.all([precheck(changeId, t1.id, 'complete'), precheck(changeId, t1.id, 'complete')]);
    await sleep(3000);
    const t2 = tasksOf(changeId).find((t) => t.description === MANUAL[1]);
    const nextCards = (await stubState()).cards.filter((x) => Number(x.changeId) === changeId && x.cardType === 'decom_precheck_task' && Number(x.taskId) === t2.id);
    const posts = (await stubLog(t0)).filter((e) => e.outcome === 'ok' && e.cardType === 'decom_precheck_task' && Number(e.taskId) === t2.id);
    out.push({ case: '9a', title: 'Same pre-check completed twice at once', statuses: [r1.status, r2.status].sort(), completedLogLines: count(changeId, '%Verify backup completed%marked completed%'), nextCardCopies: nextCards.length, nextCardPosts: posts.length }); }

  say('  9b the last two pre-checks completed at the same moment (two windows)');
  { await resetStub(); const { changeId } = await newChange('E9B'); await approve(changeId); await sleep(2000);
    const tasks = tasksOf(changeId); const t1 = tasks.find((t) => t.description === MANUAL[0]); const t2 = tasks.find((t) => t.description === MANUAL[1]); const t3 = tasks.find((t) => t.description === MANUAL[2]);
    await precheck(changeId, t1.id, 'complete'); const t0 = Date.now();
    const [r2, r3] = await Promise.all([precheck(changeId, t2.id, 'complete'), precheck(changeId, t3.id, 'complete')]);
    await sleep(15000);
    const powerDownMsgs = (await stubLog(t0)).filter((e) => e.outcome === 'ok' && /Proceeding with the Power Down/.test(e.bodyText || '')).length;
    out.push({ case: '9b', title: 'The last two pre-checks completed at once', statuses: [r2.status, r3.status], powerDownStarts: powerDownMsgs, powerOffAttempts: count(changeId, 'ESXi power-off failed%') + count(changeId, 'VM powered off%') }); }

  save('e9.json', out);
  md('## E9. Concurrent pre-check completion'); md();
  md('| Case | Scenario | Result |'); md('|---|---|---|');
  for (const o of out) {
    let res = '';
    if (o.case === '9a') res = `answers ${o.statuses.join(' + ')} (expected 200 + 409); "completed" log lines ${o.completedLogLines} (expected 1); next card copies ${o.nextCardCopies} (expected 1), next-card posts ${o.nextCardPosts} (expected 1)`;
    if (o.case === '9b') res = `answers ${o.statuses.join(' + ')}; power-down started ${o.powerDownStarts} time(s) (expected 1); power-off attempts recorded ${o.powerOffAttempts} (expected 1)`;
    md(`| ${o.case} | ${o.title} | ${res} |`);
  }
  md();
  return out;
}

// ---------------------------------------------------------------- E10 idempotency key on card posts
async function e10() {
  say('E10: idempotency key on card posts');
  const out = [];
  const POST = '/api/integrations/novadesk/decom-updates';
  const BLIP = { code: 500, n: 1, path: '/decom-updates', cardType: 'decom_precheck_task' };
  const cardPosts = async (t0) => (await stubLog(t0)).filter((e) => e.path === POST && (e.cardType === 'decom_precheck_task' || /blip/.test(e.outcome)));
  // The ledger's resend comes 5-10 s after a failure on the rig; wait for it to finish before counting.
  const waitLedgerDone = async (changeId, maxSec = 90) => {
    const t1 = tasksOf(changeId).find((t) => t.description === MANUAL[0]); const w0 = Date.now();
    while (Date.now() - w0 < maxSec * 1000) { const l = ledgerFor(changeId, 'decom_precheck_task', t1.id); if (l && l.done === 1) return true; await sleep(1000); }
    return false;
  };
  const copies = async (changeId) => (await stubState()).cards.filter((x) => Number(x.changeId) === changeId && x.cardType === 'decom_precheck_task').length;

  say('  10a saved, then answered 500 (the case that used to show the card twice)');
  { await resetStub(); podman('restart', 'fi-novadesk'); await waitHealthy();
    const { changeId } = await newChange('E10A'); const t0 = Date.now(); await setFault('blip', { ...BLIP, saveFirst: true });
    await approve(changeId); const c = await waitConverged(changeId, 120); await waitLedgerDone(changeId); await sleep(1500);
    const posts = await cardPosts(t0);
    out.push({ case: '10a', title: 'Card post saved, then answered HTTP 500', copies: await copies(changeId), failed: posts.filter((e) => /blip/.test(e.outcome)).length, duplicateKeyAnswers: posts.filter((e) => e.outcome === 'duplicate-key').length, converged: c.converged, duplicates: c.d.duplicates }); }

  say('  10b not saved, answered 500: before NovaDesk has seen a keyed answer, then after');
  { await resetStub(); podman('restart', 'fi-novadesk'); await waitHealthy();
    const first = await newChange('E10B1'); let t0 = Date.now(); await setFault('blip', BLIP);
    await approve(first.changeId); await waitConverged(first.changeId, 120);
    let posts = await cardPosts(t0); const bad1 = posts.find((e) => /blip/.test(e.outcome)); const next1 = bad1 && posts.find((e) => e.t > bad1.t);
    const gapBefore = bad1 && next1 ? next1.t - bad1.t : null;
    await resetStub(); // keeps NovaDesk's learned state (it is in NovaDesk's memory)
    const second = await newChange('E10B2'); t0 = Date.now(); await setFault('blip', BLIP);
    await approve(second.changeId); const c2 = await waitConverged(second.changeId, 120);
    posts = await cardPosts(t0); const bad2 = posts.find((e) => /blip/.test(e.outcome)); const next2 = bad2 && posts.find((e) => e.t > bad2.t);
    const gapAfter = bad2 && next2 ? next2.t - bad2.t : null;
    out.push({ case: '10b', title: 'Card post answered HTTP 500 (not saved)', gapBeforeLearningMs: gapBefore, gapAfterLearningMs: gapAfter, copies: await copies(second.changeId), converged: c2.converged, duplicates: c2.d.duplicates }); }

  say('  10c an older NovaConnect that ignores the key (self-protection)');
  { await resetStub(); await ctl('POST', '/config', { honourKeys: false }); podman('restart', 'fi-novadesk'); await waitHealthy();
    const { changeId } = await newChange('E10C'); const t0 = Date.now(); await setFault('blip', { ...BLIP, saveFirst: true });
    await approve(changeId); await waitConverged(changeId, 120); await waitLedgerDone(changeId); await sleep(1500);
    const posts = await cardPosts(t0); const bad = posts.find((e) => /blip/.test(e.outcome)); const next = bad && posts.find((e) => e.t > bad.t);
    await ctl('POST', '/config', { honourKeys: true });
    out.push({ case: '10c', title: 'Older NovaConnect that ignores the key, card saved then HTTP 500', copies: await copies(changeId), retryGapMs: bad && next ? next.t - bad.t : null }); }

  save('e10.json', out);
  md('## E10. Idempotency key on card posts'); md();
  md('| Case | Scenario | Result |'); md('|---|---|---|');
  for (const o of out) {
    let res = '';
    if (o.case === '10a') res = `card copies: ${o.copies} (expected 1; was 2 in case 8d); failed posts ${o.failed}; resends answered "duplicate" ${o.duplicateKeyAnswers}; converged ${o.converged}; duplicates ${o.duplicates}`;
    if (o.case === '10b') res = `time from the failed post to the next attempt: ${o.gapBeforeLearningMs} ms before NovaDesk had seen a keyed answer (ledger retry, expected a few seconds), ${o.gapAfterLearningMs} ms after (inline retry, expected under 2 s); card copies ${o.copies}; converged ${o.converged}; duplicates ${o.duplicates}`;
    if (o.case === '10c') res = `card copies: ${o.copies} (an older NovaConnect keeps the old duplicate; expected 2); next attempt ${o.retryGapMs} ms after the failure (ledger, not inline)`;
    md(`| ${o.case} | ${o.title} | ${res} |`);
  }
  md();
  return out;
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
    if (cmd === 'e6' || cmd === 'all') await e6();
    if (cmd === 'e7' || cmd === 'all') await e7();
    if (cmd === 'e8' || cmd === 'all') await e8();
    if (cmd === 'e9' || cmd === 'all') await e9();
    if (cmd === 'e10' || cmd === 'all') await e10();
    flushSummary('summary.md');
    say('results written to', OUT);
  } catch (e) {
    console.error('HARNESS ERROR:', e.stack || e.message);
    flushSummary('summary.partial.md');
    process.exitCode = 1;
  }
})();
