// CORRECTED 2026-09-30: the comment that used to be here claimed a direct peer IP
// (http://10.0.0.102:8080) was correct and simpler for this direction, since NovaConnect's IP
// supposedly doesn't carry the gateway. That was wrong on two counts, found while debugging a
// live incident where every NovaDesk->NovaConnect decom callback failed ("fetch failed"): (1)
// NovaConnect's pod publishes its app on host port 80 (10.0.0.102:80), not 8080 — 8080 is only
// the container-internal port; (2) even hitting :80 on the raw peer IP was genuinely flaky, not
// just wrong — repeated calls intermittently hairpinned back to NovaDesk's own app instead of
// reaching NovaConnect. host.containers.internal (port 80, matching NovaConnect's real published
// port) was verified reliable across 20 consecutive calls with zero misroutes and is now used in
// both directions, mirroring NovaConnect's own NOVADESK_BASE_URL in decomFlow.js. Plain HTTP
// because this call never leaves the VM.
const NOVACONNECT_BASE_URL = process.env.NOVACONNECT_BASE_URL || 'http://host.containers.internal';
const SYNC_API_KEY = process.env.SYNC_API_KEY || '';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// INCIDENT, 2026-09-30 (part 2): fixing the host/port above (see the comment that used to be
// here, now above the constant) did NOT fully fix the callback — this host's rootless-podman
// pasta networking has a genuine, non-deterministic hairpin bug where a call to
// host.containers.internal intermittently loops back to THIS pod's own app instead of reaching
// NovaConnect. This is NOT simple per-call flakiness — it's streaky and can get stuck for
// extended windows: the exact same request (same body, same headers) failed 40/40 in a row
// spanning roughly 15-20 seconds, then succeeded 5/5 moments later with zero code change in
// between. Ruled out payload shape, Connection:close, and keep-alive reuse as causes — all
// tested, none explain it. There's no shared podman network between the novadesk-lab and
// novaconnect-lab pods to route around this (confirmed via `podman inspect` — each pod is an
// isolated pasta netns, only reachable via the host's published ports), so a proper fix means
// changing the pods' network topology — real risk to the already-tuned meeting/mediasoup UDP
// and TLS setup, not something to change without the user's explicit sign-off. Retrying here is
// a pragmatic mitigation, not a real fix: MAX_ATTEMPTS/RETRY_DELAY_MS gives ~24s of retry budget,
// enough to ride out every broken window observed so far, but a long enough or repeated bad
// window could still exceed it. Detected by Content-Type rather than string-matching the
// misrouted page's HTML: NovaConnect's integration endpoints always answer JSON, so a non-JSON
// response means we hit NovaDesk's own app instead.
const MAX_ATTEMPTS = 24;
const RETRY_DELAY_MS = 1000;
async function postToNovaConnect(path, payload) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${NOVACONNECT_BASE_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SYNC_API_KEY}` },
        body: JSON.stringify(payload)
      });
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) return res;
      lastError = new Error(`misrouted response, content-type "${contentType || 'none'}" (attempt ${attempt}/${MAX_ATTEMPTS})`);
    } catch (e) {
      lastError = e;
    }
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }
  throw lastError;
}

// `targets` is an array of { channelId } | { conversationId } — one entry for the DM the
// request started from (if any) and one for the server-decom channel, so every message
// broadcasts to both surfaces in parallel and channel members see live status regardless of
// where the request originated. Every outbound decom message flows through this one function.
//
// Never let this throw upstream — a NovaConnect hiccup must not block the ESXi/CMDB work
// that already happened. Mirrors mailer.js's sendNotification() shape (best-effort, always
// resolves) rather than the callNovaDesk() shape (which is allowed to throw, since NovaConnect
// callers there are already wrapped in their own try/catch at the call site).
async function pushDecomUpdate(targets, body, metadata) {
  const list = Array.isArray(targets) ? targets : [targets];
  for (const target of list) {
    try {
      const res = await postToNovaConnect('/api/integrations/novadesk/decom-updates', {
        channel_id: target.channelId || null, conversation_id: target.conversationId || null, body, metadata: metadata || null
      });
      if (!res.ok) console.error(`NovaConnect decom-update push returned HTTP ${res.status}`);
    } catch (e) {
      console.error('NovaConnect decom-update push failed:', e.message);
    }
  }
}

// Lets a status change made directly in NovaDesk (the Change Tasks toggle button, or any future
// NovaDesk-side action) resolve the matching card in NovaConnect — every copy of it, DM and
// channel alike, not just one. Identifies the card by (changeId, cardType, taskId) rather than
// a specific message id, since NovaConnect can look up every sibling copy of a card from that
// key alone (see decom.js's resolveCardMessage on the NovaConnect side) — NovaDesk never needs
// to track NovaConnect message ids at all.
// Live-only "thinking" indicator (three animated dots) for the 5-7s gaps where real work is
// happening (CI lookup, ESXi power-off, ESXi destroy) but nothing has been posted as a message
// yet. Never persisted — just a transient socket event NovaConnect relays to whoever has that
// channel/DM open, so it never lingers in chat history after the wait ends.
async function pushDecomThinking(targets, thinking) {
  const list = Array.isArray(targets) ? targets : [targets];
  for (const target of list) {
    try {
      const res = await postToNovaConnect('/api/integrations/novadesk/decom-thinking', {
        channel_id: target.channelId || null, conversation_id: target.conversationId || null, thinking: !!thinking
      });
      if (!res.ok) console.error(`NovaConnect decom-thinking push returned HTTP ${res.status}`);
    } catch (e) {
      console.error('NovaConnect decom-thinking push failed:', e.message);
    }
  }
}

async function resolveNovaConnectCard({ changeId, cardType, taskId }, status) {
  try {
    const res = await postToNovaConnect('/api/integrations/novadesk/decom-updates/resolve', {
      changeId, cardType, taskId: taskId ?? null, status
    });
    if (!res.ok) console.error(`NovaConnect card-resolve returned HTTP ${res.status}`);
  } catch (e) {
    console.error('NovaConnect card-resolve failed:', e.message);
  }
}

// Shared by integrations.js and scheduler.js so every pushDecomUpdate call site builds its
// target list the same way. A Change can have both columns set (DM-originated requests also
// get novaconnect_channel_id populated with the server-decom channel, see decomFlow.js on the
// NovaConnect side) or just one (a request started directly in the channel has no DM to add).
function decomTargets(change) {
  const targets = [];
  if (change.novaconnect_conversation_id) targets.push({ conversationId: change.novaconnect_conversation_id });
  if (change.novaconnect_channel_id) targets.push({ channelId: change.novaconnect_channel_id });
  return targets;
}

module.exports = { pushDecomUpdate, pushDecomThinking, resolveNovaConnectCard, decomTargets };
