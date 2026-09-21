const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const ESXI_USER = process.env.ESXI_USER || '';
const ESXI_PASSWORD = process.env.ESXI_PASSWORD || '';

// Adopted after hand-rolled REST calls (to both /api/session and the legacy
// /rest/com/vmware/cis/session) behaved inconsistently against the two real lab hosts —
// connection resets on ESXi 7, JSON-RPC-shaped errors on ESXi 8 — despite confirmed-correct,
// unlocked credentials (verified via each host's own web UI). govc is VMware's own well-tested
// CLI for exactly this. execFile (not exec) throughout: vmName is always a distinct argv entry,
// never interpolated into a shell string, so a VM name can never be used for command injection.
function govc(hostIp, args) {
  if (!ESXI_USER || !ESXI_PASSWORD) {
    return Promise.reject(new Error('ESXI_USER / ESXI_PASSWORD are not set in this environment.'));
  }
  const env = {
    ...process.env,
    GOVC_URL: `https://${hostIp}/sdk`,
    GOVC_USERNAME: ESXI_USER,
    GOVC_PASSWORD: ESXI_PASSWORD,
    // Both hosts are nested lab VMs presenting self-signed certs — see novaapp01-infrastructure
    // memory for the ARP/Wi-Fi-bridging context. Scoped to these govc calls only.
    GOVC_INSECURE: '1'
  };
  return execFileAsync('govc', args, { env, timeout: 20000 });
}

// No separate "login" step with govc — GOVC_URL/USERNAME/PASSWORD are supplied per-call and
// govc handles session negotiation internally. Kept as its own function (rather than folding
// into findVm) so callers get an explicit, early "wrong host or bad credentials" failure before
// going further, matching the shape the rest of this module's callers already expect.
async function login(hostIp) {
  await govc(hostIp, ['about']);
  return true;
}

async function findVm(hostIp, _sessionId, vmName) {
  try {
    const { stdout } = await govc(hostIp, ['vm.info', '-json', vmName]);
    const parsed = JSON.parse(stdout);
    const vm = (parsed.virtualMachines || parsed.VirtualMachines || [])[0];
    return vm ? { vm: vmName, name: vmName, raw: vm } : null;
  } catch (e) {
    if (/not found/i.test(e.stderr || e.message)) return null;
    throw new Error(`ESXi findVm on ${hostIp} failed: ${(e.stderr || e.message).trim()}`);
  }
}

async function listVms(hostIp) {
  const { stdout } = await govc(hostIp, ['find', '/', '-type', 'm']);
  return stdout.split('\n').filter(Boolean).map((path) => ({ path, name: path.split('/').pop() }));
}

async function powerOff(hostIp, _sessionId, vmName) {
  try {
    await govc(hostIp, ['vm.power', '-off', vmName]);
  } catch (e) {
    throw new Error(`ESXi power-off on ${hostIp} failed: ${(e.stderr || e.message).trim()}`);
  }
}

async function destroyVm(hostIp, _sessionId, vmName) {
  try {
    await govc(hostIp, ['vm.destroy', vmName]);
  } catch (e) {
    throw new Error(`ESXi destroy on ${hostIp} failed: ${(e.stderr || e.message).trim()}`);
  }
}

module.exports = { login, findVm, listVms, powerOff, destroyVm };
