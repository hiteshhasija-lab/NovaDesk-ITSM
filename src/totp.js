// One-time codes (TOTP, RFC 6238) with Node's own crypto: the six digits an authenticator app shows,
// changing every 30 seconds. SHA-1, 6 digits and 30 seconds are what Google Authenticator, Microsoft
// Authenticator, Authy and 1Password all assume.
'use strict';
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  const clean = String(text).replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  let bits = 0; let value = 0; const out = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('not a base32 key');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function hotp(secret, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secret).update(msg).digest();
  const offset = h[19] & 0xf;
  const bin = ((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(bin % (10 ** digits)).padStart(digits, '0');
}

const counterAt = (timeMs, step = 30) => Math.floor(timeMs / 1000 / step);
const codeAt = (secret, timeMs, { digits = 6, step = 30 } = {}) => hotp(secret, counterAt(timeMs, step), digits);

// Checks a code typed by a person against a base32 key. Accepts the current 30-second step and one either
// side (clock drift). `afterCounter` is the last step already accepted: a step is good once, so a code seen
// on the wire cannot be replayed. Returns the step that matched, or null.
function verify(secretBase32, input, { now = Date.now(), window = 1, afterCounter = 0 } = {}) {
  const code = String(input || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const current = counterAt(now);
  for (let offset = -window; offset <= window; offset++) {
    const counter = current + offset;
    if (counter <= afterCounter) continue;
    const expected = Buffer.from(hotp(secret, counter));
    if (crypto.timingSafeEqual(expected, Buffer.from(code))) return counter;
  }
  return null;
}

const generateSecret = () => base32Encode(crypto.randomBytes(20));   // 160 bits

function otpauthUri({ issuer, account, secret }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { base32Encode, base32Decode, hotp, codeAt, counterAt, verify, generateSecret, otpauthUri };
