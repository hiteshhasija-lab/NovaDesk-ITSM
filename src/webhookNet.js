// The network side of webhooks, without the database: which addresses may be called, how a delivery is signed,
// how long to wait between tries, and one HTTP POST that connects only to an address that was checked.
'use strict';
const net = require('net');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const dns = require('dns').promises;

class WebhookUrlError extends Error {}

// ---------------------------------------------------------------- addresses
function ipv4ToInt(ip) { return ip.split('.').reduce((n, part) => (n * 256) + Number(part), 0); }
const V4_BLOCKS = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]
  .map(([base, bits]) => [ipv4ToInt(base), bits]);

function hextets(ip) {
  let [head, tail] = ip.toLowerCase().split('::');
  const embeddedV4 = (s) => (s && s.includes('.') ? (() => { const n = ipv4ToInt(s.slice(s.lastIndexOf(':') + 1)); return [s.slice(0, s.lastIndexOf(':')), [(n >>> 16).toString(16), (n & 0xffff).toString(16)]]; })() : [s, []]);
  let tailExtra = []; let headExtra = [];
  if (tail === undefined) { const [h, extra] = embeddedV4(head); head = h; headExtra = extra; } else { const [t, extra] = embeddedV4(tail); tail = t; tailExtra = extra; }
  const headParts = head ? head.split(':').filter(Boolean).concat(headExtra) : headExtra;
  const tailParts = tail ? tail.split(':').filter(Boolean).concat(tailExtra) : tailExtra;
  const zeros = tail === undefined ? [] : Array(8 - headParts.length - tailParts.length).fill('0');
  return [...headParts, ...zeros, ...tailParts].map((h) => parseInt(h || '0', 16));
}

// True for an address that is not an ordinary public one: this host, private networks, link-local (which includes
// the cloud metadata address 169.254.169.254), carrier-grade NAT, multicast and reserved ranges.
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKS.some(([base, bits]) => (n >>> (32 - bits)) === (base >>> (32 - bits)));
  }
  if (net.isIPv6(ip)) {
    const h = hextets(ip);
    if (h.every((x) => x === 0) || (h.slice(0, 7).every((x) => x === 0) && h[7] === 1)) return true;                  // :: and ::1
    if ((h[0] & 0xfe00) === 0xfc00 || (h[0] & 0xffc0) === 0xfe80 || (h[0] & 0xff00) === 0xff00) return true;          // fc00::/7, fe80::/10, ff00::/8
    const v4 = (a, b) => `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
    if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return isPrivateAddress(v4(h[6], h[7]));              // ::ffff:a.b.c.d
    if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return isPrivateAddress(v4(h[6], h[7])); // 64:ff9b::/96
    if (h[0] === 0x2002) return isPrivateAddress(v4(h[1], h[2]));                                                      // 6to4
    return false;
  }
  return true;                                                  // not an address at all: never call it
}

// Checks a webhook URL and resolves its host. Resolves { url, address, family } (the address to connect to), or throws
// WebhookUrlError with a sentence a person can act on. Without allowPrivate, only https and public addresses pass.
async function checkTarget(text, { allowPrivate = false, resolve = (host) => dns.lookup(host, { all: true }) } = {}) {
  let url;
  try { url = new URL(String(text)); } catch { throw new WebhookUrlError('That is not a web address. Use the full address, for example https://hooks.example.com/novadesk.'); }
  if (String(text).length > 2048) throw new WebhookUrlError('That address is too long.');
  if (url.username || url.password) throw new WebhookUrlError('The address must not contain a user name or password. Webhooks are signed instead.');
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) throw new WebhookUrlError('The address must start with https://.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const literal = net.isIP(host);
  let addresses;
  if (literal) addresses = [{ address: host, family: literal }];
  else {
    try { addresses = await resolve(host); } catch { throw new WebhookUrlError(`The name ${host} could not be looked up. Check the spelling, and that this server can reach DNS.`); }
    if (!addresses || !addresses.length) throw new WebhookUrlError(`The name ${host} has no address.`);
  }
  if (!allowPrivate && addresses.some((a) => isPrivateAddress(a.address))) {
    throw new WebhookUrlError(`${host} points at a private, local or reserved address. Webhooks may only call public addresses (an administrator can allow private ones with WEBHOOK_ALLOW_PRIVATE=true).`);
  }
  return { url, address: addresses[0].address, family: addresses[0].family };
}

// ---------------------------------------------------------------- signing
// X-NovaDesk-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" with the webhook's secret>
function sign(secret, body, timestampSeconds = Math.floor(Date.now() / 1000)) {
  return `t=${timestampSeconds},v1=${crypto.createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex')}`;
}
// What a receiver does (the README shows the same in two languages). Returns true or false.
function verifySignature(secret, header, body, { toleranceSeconds = 300, nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(header || ''));
  if (!m || Math.abs(nowSeconds - Number(m[1])) > toleranceSeconds) return false;
  const expected = Buffer.from(sign(secret, body, Number(m[1])).split('v1=')[1], 'hex');
  return crypto.timingSafeEqual(expected, Buffer.from(m[2], 'hex'));
}

// ---------------------------------------------------------------- retries
// Seconds to wait after the 1st, 2nd, ... failed try: 1 minute, 5, 30, 2 hours, 6 hours; then the delivery is given up
// (six tries in all). WEBHOOK_RETRY_DELAYS_S="1,1,1" replaces it (tests and CI).
function retryDelays(env = process.env) {
  const raw = (env.WEBHOOK_RETRY_DELAYS_S || '').trim();
  if (!raw) return [60, 300, 1800, 7200, 21600];
  const list = raw.split(',').map((s) => Number(s.trim()));
  if (!list.length || list.some((n) => !Number.isFinite(n) || n < 0)) throw new Error('WEBHOOK_RETRY_DELAYS_S must be seconds separated by commas, for example 60,300,1800.');
  return list;
}

// ---------------------------------------------------------------- one POST
// Connects to the address that was checked (so the name cannot be pointed somewhere else between the check and the
// call), verifies the certificate against the real host name, follows no redirect, and reads at most 2 KB back.
// Resolves { status, snippet } or rejects with an Error whose message says what went wrong.
function postJson({ url, address, family }, headers, body, { timeoutMs = 10000 } = {}) {
  const secure = url.protocol === 'https:';
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request({
      hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || (secure ? 443 : 80), path: `${url.pathname}${url.search}`, method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      lookup: (host, opts, cb) => (opts && opts.all ? cb(null, [{ address, family }]) : cb(null, address, family)),
      servername: net.isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (c) => { if (size < 2048) { chunks.push(c); size += c.length; } });
      res.on('end', () => resolve({ status: res.statusCode, snippet: Buffer.concat(chunks).toString('utf8').slice(0, 300) }));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error(`no answer within ${Math.round(timeoutMs / 1000)} seconds`)); });
    req.on('error', (err) => reject(new Error(err.code === 'ECONNREFUSED' ? 'connection refused' : (err.message || String(err)).slice(0, 200))));
    req.end(body);
  });
}

module.exports = { WebhookUrlError, isPrivateAddress, checkTarget, sign, verifySignature, retryDelays, postJson };
