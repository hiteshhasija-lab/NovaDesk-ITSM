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
    messages += 1;
    if (meta && meta.cardType) {
      cards.push({
        id: nextId++, changeId: meta.changeId, cardType: meta.cardType, taskId: meta.taskId ?? null,
        status: meta.status || 'pending', createdAt: Date.now(), updatedAt: Date.now(), target: body.channel_id || body.conversation_id || null,
        targetKind: body.channel_id ? 'channel' : 'dm', source: 'novadesk'
      });
    }
    record({ ...base, outcome: 'ok', cardType: meta && meta.cardType, changeId: meta && meta.changeId, taskId: meta && meta.taskId, bodyText: String(body.body || '').slice(0, 80) });
    return send(res, 201, { ok: true, messageId: messages });
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
  if (m.name === 'flaky' && Math.random() < (m.p == null ? 0.5 : m.p)) { record({ ...base, outcome: '500-flaky' }); return send(res, 500, { error: 'injected' }); }
  if (m.name === 'slow') await new Promise((r) => setTimeout(r, m.ms || 5000));
  return handleReal(req, res, path, body, base);
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
    await setMode({ name: body.mode || 'normal', ms: body.ms, p: body.p, target: body.target });
    return send(res, 200, { ok: true, mode });
  }
  if (req.method === 'POST' && path === '/seed') {
    // Plays the part of NovaConnect itself posting the first (approval) card; deliberately not
    // subject to injected faults, because in the real system that card is created locally.
    cards.push({ id: nextId++, changeId: body.changeId, cardType: body.cardType, taskId: body.taskId ?? null, status: body.status || 'pending', createdAt: Date.now(), updatedAt: Date.now(), source: 'seed' });
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && path === '/reset') {
    cards = []; log = []; messages = 0;
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'not found' });
});

startMain().then(() => {
  ctl.listen(CTL_PORT, '0.0.0.0', () => console.log(`stub up: main ${MAIN_PORT}, control ${CTL_PORT}`));
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
