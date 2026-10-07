'use strict';
// Fault-injectable stand-in for NovaConnect's three NovaDesk-facing integration endpoints
// (decom-updates, decom-thinking, decom-updates/resolve). It models the receiver's card state
// the way src/decomCards.js's resolveDecomCards does, so the harness can compare "what NovaDesk
// believes" with "what the chat would show". It is ONLY used inside the isolated fault-injection
// pod; it is never wired to production NovaDesk or NovaConnect.
//
// Main port (STUB_PORT, default 18081): what NovaDesk calls.
// Control port (STUB_CTL_PORT, default 18082): what the harness uses to inject faults and read state.
const http = require('http');

const KEY = process.env.SYNC_API_KEY || 'fi-test-key';
const MAIN_PORT = Number(process.env.STUB_PORT || 18081);
const CTL_PORT = Number(process.env.STUB_CTL_PORT || 18082);

const RESOLVABLE = new Set(['decom_approval', 'decom_confirm_destroy', 'decom_skip_manual_tasks', 'decom_precheck_task']);
const HTML404 = '<!DOCTYPE html><html><head><title>Not Found · NovaDesk ITSM</title></head><body><h3>Not Found</h3></body></html>';

let mode = { name: 'normal' };
// Models NovaConnect 1.0.183+: a post carrying idempotency_key is stored once. POST /config
// {honourKeys:false} models an older NovaConnect that ignores the key.
let honourKeys = true;
const seenKeys = new Map();
let main = null;
const sockets = new Set();
const hung = new Set();
let log = [];
let cards = [];
let messages = 0;
let nextId = 1;

function record(entry) {
  log.push({ t: Date.now(), ...entry });
  if (log.length > 20000) log = log.slice(-10000);
}

function readJson(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({ __bad: true }); } });
  });
}

function send(res, status, payload, type = 'application/json; charset=utf-8') {
  if (res.writableEnded || res.destroyed) return;
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sameTaskId(a, b) {
  return (a === undefined || a === null ? null : Number(a)) === (b === undefined || b === null ? null : Number(b));
}

function handleReal(req, res, path, body, base) {
  // NovaConnect's real /health is public; the card ledger probes it to tell "NovaConnect is down"
  // from "one target keeps failing". Fault modes that disturb every request disturb it too.
  if (path === '/health') { record({ ...base, outcome: 'health' }); return send(res, 200, { status: 'healthy', database: 'connected' }); }
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!provided || provided !== KEY) {
    record({ ...base, outcome: '401' });
    return send(res, 401, { error: 'Missing or invalid service credentials.' });
  }

  if (path === '/api/integrations/novadesk/decom-updates') {
    const meta = body.metadata || null;
    const key = honourKeys && typeof body.idempotency_key === 'string' && body.idempotency_key ? body.idempotency_key : null;
    if (key && seenKeys.has(key)) {
      record({ ...base, outcome: 'duplicate-key', cardType: meta && meta.cardType, changeId: meta && meta.changeId, taskId: meta && meta.taskId });
      return send(res, 200, { ok: true, keyed: true, duplicate: true, messageId: seenKeys.get(key) });
    }
    messages += 1;
    if (key) seenKeys.set(key, messages);
    if (meta && meta.cardType) {
      cards.push({
        id: nextId++, changeId: meta.changeId, cardType: meta.cardType, taskId: meta.taskId ?? null,
        status: meta.status || 'pending', createdAt: Date.now(), updatedAt: Date.now(), target: body.channel_id || body.conversation_id || null,
        targetKind: body.channel_id ? 'channel' : 'dm', source: 'novadesk'
      });
    }
    record({ ...base, outcome: 'ok', cardType: meta && meta.cardType, changeId: meta && meta.changeId, taskId: meta && meta.taskId, bodyText: String(body.body || '').slice(0, 80) });
    return send(res, 201, { ok: true, messageId: messages, ...(key ? { keyed: true } : {}) });
  }

  if (path === '/api/integrations/novadesk/decom-thinking') {
    record({ ...base, outcome: 'ok', thinking: !!body.thinking });
    return send(res, 200, { ok: true });
  }

  if (path === '/api/integrations/novadesk/decom-updates/resolve') {
    const { changeId, cardType, taskId, status } = body;
    if (!changeId || !cardType || !status) {
      record({ ...base, outcome: '400' });
      return send(res, 400, { error: 'changeId, cardType, and status are required.' });
    }
    let n = 0;
    if (RESOLVABLE.has(cardType)) {
      for (const c of cards) {
        if (Number(c.changeId) === Number(changeId) && c.cardType === cardType && sameTaskId(c.taskId, taskId)) {
          c.status = status; c.updatedAt = Date.now(); n += 1;
        }
      }
    }
    record({ ...base, outcome: 'ok', cardType, changeId, taskId: taskId ?? null, resolvedStatus: status, matched: n });
    return send(res, 200, { ok: true });
  }

  record({ ...base, outcome: '404-json' });
  return send(res, 404, { error: 'not found' });
}

async function onRequest(req, res) {
  const body = await readJson(req);
  const path = req.url.split('?')[0];
  const m = mode;
  const base = { path, mode: m.name };

  if (m.name === 'hang') { hung.add({ req, res, path, body, base }); record({ ...base, outcome: 'hung' }); return; }
  if (m.name === 'html404') { record({ ...base, outcome: 'html404' }); return send(res, 404, HTML404, 'text/html; charset=utf-8'); }
  if (m.name === 'status500') { record({ ...base, outcome: '500' }); return send(res, 500, { error: 'injected' }); }
  if (m.name === 'failtarget' && path === '/api/integrations/novadesk/decom-updates') {
    const key = body.channel_id ? `channel:${body.channel_id}` : `dm:${body.conversation_id}`;
    if (key === m.target) { record({ ...base, outcome: '500-target', target: key }); return send(res, 500, { error: 'injected for ' + key }); }
  }
  // {mode:'blip', code, n, path?, cardType?, saveFirst?}: the next n matching requests answer `code` as JSON,
  // then everything is normal again. With saveFirst the request is processed (the card is stored)
  // and only then answered with the error, like NovaConnect failing after it saved the message.
  if (m.name === 'blip' && m.left > 0 && (!m.path || path.endsWith(m.path)) && (!m.cardType || (body.metadata && body.metadata.cardType === m.cardType))) {
    m.left -= 1;
    record({ ...base, outcome: `${m.code}-blip${m.saveFirst ? '-saved' : ''}` });
    if (m.saveFirst) handleReal(req, { writableEnded: true }, path, body, { ...base, savedBeforeError: true });
    return send(res, m.code || 500, { error: 'injected' });
  }
  if (m.name === 'flaky' && Math.random() < (m.p == null ? 0.5 : m.p)) { record({ ...base, outcome: '500-flaky' }); return send(res, 500, { error: 'injected' }); }
  if (m.name === 'slow') await new Promise((r) => setTimeout(r, m.ms || 5000));
  return handleReal(req, res, path, body, base);
}


// ---------------------------------------------------------------- govc model (src/esxi.js shells out to govc)
// A small ESXi inventory plus fault rules, answering the commands NovaDesk uses: about,
// vm.info -json, vm.power -off/-on, vm.destroy, find. bin/govc forwards here. Error texts follow
// what the real tool prints. Rules: {cmd, kind: fail|hang|slow, n (calls affected, default all),
// applied (the change HAPPENS on the host but the caller is told it failed / never hears back),
// stderr, ms}. cmd is the command ("about", "vm.info", "vm.power -off", "vm.power -on",
// "vm.destroy", "find") or "*".
const vms = new Map();
const vmsEverSeen = new Set(); // a VM that was destroyed must not reappear on the next lookup
let autoRegister = true;
let govcFaults = [];
let govcCalls = [];
const STATE_ERR = (state) => `govc: The attempted operation cannot be performed in the current state (${state}).\n`;

function vmJson(name, v) {
  return { name, runtime: { powerState: v.powerState }, config: { hardware: { numCPU: v.cpu, memoryMB: v.memoryMB, device: [{ capacityInKB: v.diskKB }] } } };
}
function getVm(name, { create } = {}) {
  if (!vms.has(name) && create && autoRegister && !vmsEverSeen.has(name)) vms.set(name, { powerState: 'poweredOn', cpu: 2, memoryMB: 4096, diskKB: 20 * 1024 * 1024 });
  if (vms.has(name)) vmsEverSeen.add(name);
  return vms.get(name);
}
function govcCmd(args) {
  if (args[0] === 'vm.power') return `vm.power ${args.includes('-off') ? '-off' : '-on'}`;
  return args[0];
}
// What the command does on a healthy host. Returns { code, stdout, stderr }.
function govcApply(args) {
  const cmd = args[0];
  const name = args[args.length - 1];
  if (cmd === 'about') return { code: 0, stdout: 'Name:         VMware ESXi\nVersion:      7.0.3\n', stderr: '' };
  if (cmd === 'find') return { code: 0, stdout: [...vms.keys()].map((n) => `/ha-datacenter/vm/${n}\n`).join(''), stderr: '' };
  if (cmd === 'vm.info') {
    const v = getVm(name, { create: true });
    return { code: 0, stdout: JSON.stringify({ virtualMachines: v ? [vmJson(name, v)] : null }), stderr: '' };
  }
  if (cmd === 'vm.power' || cmd === 'vm.destroy') {
    const v = getVm(name, { create: true });
    if (!v) return { code: 1, stdout: '', stderr: `govc: vm '${name}' not found\n` };
    if (cmd === 'vm.destroy') {
      if (v.powerState !== 'poweredOff') return { code: 1, stdout: '', stderr: STATE_ERR('Powered on') };
      vms.delete(name);
      return { code: 0, stdout: `Destroying VirtualMachine:${name}... OK\n`, stderr: '' };
    }
    const off = args.includes('-off');
    if (off && v.powerState === 'poweredOff') return { code: 1, stdout: '', stderr: STATE_ERR('Powered off') };
    if (!off && v.powerState === 'poweredOn') return { code: 1, stdout: '', stderr: STATE_ERR('Powered on') };
    v.powerState = off ? 'poweredOff' : 'poweredOn';
    return { code: 0, stdout: `${off ? 'Powering off' : 'Powering on'} VirtualMachine:${name}... OK\n`, stderr: '' };
  }
  return { code: 1, stdout: '', stderr: `govc: unsupported command in the test model: ${cmd}\n` };
}
// Answers one forwarded call, applying the first matching fault rule. `closed` resolves when the
// caller gave up (govc killed by NovaDesk's 20 s timeout), which ends a hung call.
async function govcHandle(args, url, closed) {
  const cmd = govcCmd(args);
  const name = args[args.length - 1];
  const rule = govcFaults.find((r) => (r.cmd === '*' || r.cmd === cmd) && r.left !== 0);
  const call = { t: Date.now(), cmd, name, host: url, fault: rule ? `${rule.kind}${rule.applied ? '+applied' : ''}` : null };
  govcCalls.push(call);
  if (!rule) { const r = govcApply(args); call.outcome = r.code ? 'error' : 'ok'; return r; }
  if (rule.left > 0) rule.left -= 1;
  if (rule.kind === 'slow') {
    await new Promise((res) => setTimeout(res, rule.ms || 5000));
    const r = govcApply(args); call.outcome = r.code ? 'error' : 'ok'; return r;
  }
  if (rule.applied) govcApply(args); // the host really does it...
  if (rule.kind === 'hang') {
    call.outcome = 'hung';
    await closed; // ...but the caller never hears back until it gives up
    call.outcome = 'hung-caller-gave-up';
    return { code: 1, stdout: '', stderr: '' };
  }
  call.outcome = 'fault';
  return { code: 1, stdout: '', stderr: rule.stderr || 'govc: injected failure\n' };
}

function startMain() {
  return new Promise((resolve) => {
    main = http.createServer(onRequest);
    main.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    main.listen(MAIN_PORT, '0.0.0.0', resolve);
  });
}

function stopMain() {
  return new Promise((resolve) => {
    if (!main) return resolve();
    const srv = main; main = null;
    srv.close(() => resolve());
    for (const s of sockets) s.destroy();
    sockets.clear();
  });
}

async function setMode(next) {
  const prev = mode.name;
  if (prev === 'hang' && next.name !== 'hang') {
    // Process each held request exactly as if it had merely been slow, so releasing a hang
    // models a late answer, not a dropped one.
    const held = [...hung]; hung.clear();
    for (const h of held) handleReal(h.req, h.res, h.path, h.body, { ...h.base, released: true });
  }
  if (next.name === 'refuse') {
    if (main) await stopMain();
  } else if (!main) {
    await startMain();
  }
  mode = next;
  record({ path: '(ctl)', mode: next.name, outcome: 'mode-change', from: prev, ms: next.ms, p: next.p });
}

const ctl = http.createServer(async (req, res) => {
  const body = await readJson(req);
  const path = req.url.split('?')[0];
  if (req.method === 'GET' && path === '/state') {
    return send(res, 200, { mode, hung: hung.size, listening: !!main, cards, messages, now: Date.now() });
  }
  if (req.method === 'GET' && path === '/log') {
    const since = Number((req.url.split('since=')[1] || '0'));
    return send(res, 200, { now: Date.now(), log: log.filter((e) => e.t >= since) });
  }
  if (req.method === 'POST' && path === '/ctl') {
    await setMode({ name: body.mode || 'normal', ms: body.ms, p: body.p, target: body.target, code: body.code, left: body.n, path: body.path, saveFirst: !!body.saveFirst, cardType: body.cardType });
    return send(res, 200, { ok: true, mode });
  }
  if (req.method === 'POST' && path === '/seed') {
    // Plays the part of NovaConnect itself posting the first (approval) card; deliberately not
    // subject to injected faults, because in the real system that card is created locally.
    cards.push({ id: nextId++, changeId: body.changeId, cardType: body.cardType, taskId: body.taskId ?? null, status: body.status || 'pending', createdAt: Date.now(), updatedAt: Date.now(), source: 'seed' });
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && path === '/govc') {
    let gone; const closed = new Promise((r) => { gone = r; });
    res.on('close', gone);
    const r = await govcHandle(body.args || [], body.url || '', closed);
    return send(res, 200, r);
  }
  if (req.method === 'POST' && path === '/govc-fault') {
    if (body.clear) { govcFaults = []; return send(res, 200, { ok: true, faults: 0 }); }
    govcFaults.push({ cmd: body.cmd || '*', kind: body.kind || 'fail', left: body.n == null ? -1 : body.n, applied: !!body.applied, stderr: body.stderr, ms: body.ms });
    return send(res, 200, { ok: true, faults: govcFaults.length });
  }
  if (req.method === 'POST' && path === '/govc-vm') {
    if (body.remove) vms.delete(body.name);
    else vms.set(body.name, { powerState: body.powerState || 'poweredOn', cpu: body.cpu || 2, memoryMB: body.memoryMB || 4096, diskKB: body.diskKB || 20 * 1024 * 1024 });
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && path === '/govc-config') {
    if (typeof body.autoRegister === 'boolean') autoRegister = body.autoRegister;
    return send(res, 200, { ok: true, autoRegister });
  }
  if (req.method === 'GET' && path === '/govc-state') {
    const since = Number((req.url.split('since=')[1] || '0'));
    return send(res, 200, { vms: Object.fromEntries(vms), faults: govcFaults, calls: govcCalls.filter((c) => c.t >= since) });
  }
  if (req.method === 'POST' && path === '/reset') {
    cards = []; log = []; messages = 0; seenKeys.clear(); vms.clear(); vmsEverSeen.clear(); govcFaults = []; govcCalls = []; autoRegister = true;
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && path === '/config') {
    if (typeof body.honourKeys === 'boolean') honourKeys = body.honourKeys;
    return send(res, 200, { ok: true, honourKeys });
  }
  return send(res, 404, { error: 'not found' });
});

startMain().then(() => {
  ctl.listen(CTL_PORT, '0.0.0.0', () => console.log(`stub up: main ${MAIN_PORT}, control ${CTL_PORT}`));
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
