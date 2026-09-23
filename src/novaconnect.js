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

// `target` is { channelId } for a decom request started in the server-decom channel, or
// { conversationId } for one started via a direct message to novadesk-bot — mirrors the
// changes table's own novaconnect_channel_id/novaconnect_conversation_id columns (exactly one
// set per Change). Every outbound decom message flows through this one function, so
// generalizing it here is what makes the whole pipeline target-agnostic everywhere else.
//
// Never let this throw upstream — a NovaConnect hiccup must not block the ESXi/CMDB work
// that already happened. Mirrors mailer.js's sendNotification() shape (best-effort, always
// resolves) rather than the callNovaDesk() shape (which is allowed to throw, since NovaConnect
// callers there are already wrapped in their own try/catch at the call site).
async function pushDecomUpdate(target, body, metadata) {
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

// Shared by integrations.js and scheduler.js so every pushDecomUpdate call site builds its
// target the same way, from whichever of the Change's two nullable NovaConnect columns is set.
function decomTarget(change) {
  return { channelId: change.novaconnect_channel_id, conversationId: change.novaconnect_conversation_id };
}

module.exports = { pushDecomUpdate, decomTarget };
