// NOT host.containers.internal here — confirmed live 2026-09-21 that it resolves to 10.0.0.101
// (NovaDesk's own IP, which carries this box's default gateway) regardless of which pod is
// asking. That's exactly why NovaConnect->NovaDesk calls using it work (different pod, correctly
// reaches NovaDesk) — but it means NovaDesk calling host.containers.internal loops back to
// itself. NovaConnect's IP (10.0.0.102) does NOT carry the gateway, so the asymmetric-NAT
// hairpin problem that host.containers.internal exists to route around (see
// novaapp01-infrastructure memory gotcha #5) doesn't apply in this direction — a direct peer IP
// is correct and simpler here. Plain HTTP because this call never leaves the VM.
const NOVACONNECT_BASE_URL = process.env.NOVACONNECT_BASE_URL || 'http://10.0.0.102';
const SYNC_API_KEY = process.env.SYNC_API_KEY || '';

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
      const res = await fetch(`${NOVACONNECT_BASE_URL}/api/integrations/novadesk/decom-updates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SYNC_API_KEY}` },
        body: JSON.stringify({ channel_id: target.channelId || null, conversation_id: target.conversationId || null, body, metadata: metadata || null })
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
async function resolveNovaConnectCard({ changeId, cardType, taskId }, status) {
  try {
    const res = await fetch(`${NOVACONNECT_BASE_URL}/api/integrations/novadesk/decom-updates/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SYNC_API_KEY}` },
      body: JSON.stringify({ changeId, cardType, taskId: taskId ?? null, status })
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

module.exports = { pushDecomUpdate, resolveNovaConnectCard, decomTargets };
