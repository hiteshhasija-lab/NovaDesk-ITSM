// Where NovaDesk sends decommission updates (decom-updates, decom-thinking, card-resolve) in NovaConnect.
// It must be configured: NOVACONNECT_BASE_URL, e.g. http://10.0.0.102 on NOVAAPP01 (plain HTTP to
// NovaConnect's published port 80; the call never leaves the VM). There is deliberately no default.
//
// CORRECTED 2026-10-04 (pending-list #35): the previous default, http://host.containers.internal, is
// always wrong for this direction. From NovaDesk's own pod that name maps to the host address NovaDesk
// itself is published on, so every update landed on NovaDesk's login page ("misrouted response",
// cards stuck in NovaConnect until a refresh). On NOVAAPP01's three-card layout it reached NovaDesk
// 10 times out of 10, while http://10.0.0.102 reached NovaConnect 20 times out of 20. The
// "intermittent pasta hairpin" described here before was observed while NOVAAPP01 briefly had all
// three app addresses on one card (2026-09-29/30, since reverted), not on the normal layout.
// (host.containers.internal is fine the OTHER way round: NovaConnect's NOVADESK_BASE_URL.)
const NOVACONNECT_BASE_URL = (process.env.NOVACONNECT_BASE_URL || '').trim().replace(/\/+$/, '');
const SYNC_API_KEY = process.env.SYNC_API_KEY || '';
if (!NOVACONNECT_BASE_URL) {
  console.warn('NOVACONNECT_BASE_URL is not set: decommission updates will not be sent to NovaConnect.');
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Retries a short while when the request fails or the answer isn't JSON (NovaConnect's integration
// endpoints always answer JSON, so anything else means another app answered). ~24 s budget.
const MAX_ATTEMPTS = 24;
const RETRY_DELAY_MS = 1000;
async function postToNovaConnect(path, payload) {
  if (!NOVACONNECT_BASE_URL) throw new Error('NOVACONNECT_BASE_URL is not set, so nothing was sent');
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
      lastError = new Error(`misrouted response from ${NOVACONNECT_BASE_URL} (content-type "${contentType || 'none'}", attempt ${attempt}/${MAX_ATTEMPTS}): check NOVACONNECT_BASE_URL points at NovaConnect`);
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
