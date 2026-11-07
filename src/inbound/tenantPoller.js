// Reads each tenant's own mailbox (Settings > Inbound email): every few seconds it looks at every active tenant, and a tenant whose mailbox
// is switched on and due is read, inside that tenant (so what it receives is that tenant's). One tenant's mailbox being slow or down never
// holds up another's. The server's own INBOUND_IMAP_* mailbox, for the default tenant, is read by imapPoller.js unless the default tenant
// has set up a mailbox of its own.
'use strict';
const tenancy = require('../tenancy');
const tenants = require('../tenants');
const inboundSettings = require('../inboundSettings');
const poller = require('./imapPoller');

const TICK_MS = 10 * 1000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
const boxes = new Map();   // tenant id -> { running, nextAtMs, tries, state }
const boxOf = (id) => {
  if (!boxes.has(id)) boxes.set(id, { running: false, nextAtMs: 0, tries: new Map(), state: { configured: false, mailbox: null, folder: null, running: false, lastStartedAt: null, lastFinishedAt: null, lastOk: null, lastError: null, lastHandled: 0, failures: 0, nextAt: null } });
  return boxes.get(id);
};
const stateFor = (id) => ({ ...boxOf(id).state });

// One look, if this tenant has a mailbox and it is due (or `force`). Must run inside the tenant. Resolves what was handled, or null if nothing was due.
async function pollTenant(id, { force = false } = {}) {
  const box = boxOf(id); const st = box.state;
  if (box.running) return null;
  const s = await inboundSettings.forTenant();
  if (!s || !s.mailbox) { st.configured = false; return null; }
  if (!force && Date.now() < box.nextAtMs) return null;
  st.configured = true; st.mailbox = `${s.cfg.imap.user} at ${s.cfg.imap.host}`; st.folder = s.cfg.imap.folder;
  box.running = true; st.running = true; st.lastStartedAt = new Date().toISOString();
  let timeout; let handled = null;
  try {
    handled = await Promise.race([poller.lookWith({ ...s.cfg, env: s.env }, box.tries), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('the mailbox did not answer in time')), POLL_TIMEOUT_MS); })]);
    Object.assign(st, { lastOk: new Date().toISOString(), lastError: null, lastHandled: handled, failures: 0 });
  } catch (err) {
    st.failures++;
    const text = String((err && (err.responseText || err.message)) || err).slice(0, 300);
    if (text !== st.lastError) console.warn(`[Inbound] could not read a tenant's mailbox ${s.cfg.imap.user}@${s.cfg.imap.host}: ${text}`);
    st.lastError = text;
  } finally {
    clearTimeout(timeout);
    box.running = false; st.running = false; st.lastFinishedAt = new Date().toISOString();
    const wait = Math.min(s.cfg.imap.pollSeconds * 2 ** Math.min(st.failures, 4), 900) * 1000;   // a mailbox that fails is asked less and less often
    box.nextAtMs = Date.now() + wait; st.nextAt = new Date(box.nextAtMs).toISOString();
  }
  return handled;
}

// Every active tenant; each look runs on its own (not waited for) so a slow mailbox does not hold the others up.
const tick = () => tenants.forEachTenant((t) => { pollTenant(t.id).catch((err) => console.error(`[Inbound] tenant ${t.slug}: ${err.message}`)); }, 'Inbound mailbox');
let timer = null;
function start() { if (timer) return; timer = setInterval(() => tick().catch(() => {}), TICK_MS); timer.unref(); setTimeout(() => tick().catch(() => {}), 5000).unref(); }
// "Check now" for the signed-in tenant: look at once and resolve when that look is over. false when no mailbox is set up.
async function checkNow() { const id = tenancy.currentId(); const r = await pollTenant(id, { force: true }); return r !== null || boxOf(id).state.configured; }

module.exports = { start, pollTenant, checkNow, stateFor, tick, _boxes: boxes };
