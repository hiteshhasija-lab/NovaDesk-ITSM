// Mirrors decomFlow.js's callNovaDesk() on the NovaConnect side, in reverse. Same reasoning
// applies here: host.containers.internal (not a peer pod's raw IP) because NovaConnect's own
// IP also carries a routing role on this host, and plain HTTP because this call never leaves
// the VM — see novaapp01-infrastructure memory gotcha #5.
const NOVACONNECT_BASE_URL = process.env.NOVACONNECT_BASE_URL || 'http://host.containers.internal';
const SYNC_API_KEY = process.env.SYNC_API_KEY || '';

// Never let this throw upstream — a NovaConnect hiccup must not block the ESXi/CMDB work
// that already happened. Mirrors mailer.js's sendNotification() shape (best-effort, always
// resolves) rather than the callNovaDesk() shape (which is allowed to throw, since NovaConnect
// callers there are already wrapped in their own try/catch at the call site).
async function pushDecomUpdate(channelId, body, metadata) {
  try {
    const res = await fetch(`${NOVACONNECT_BASE_URL}/api/integrations/novadesk/decom-updates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SYNC_API_KEY}` },
      body: JSON.stringify({ channel_id: channelId, body, metadata: metadata || null })
    });
    if (!res.ok) console.error(`NovaConnect decom-update push returned HTTP ${res.status}`);
  } catch (e) {
    console.error('NovaConnect decom-update push failed:', e.message);
  }
}

module.exports = { pushDecomUpdate };
