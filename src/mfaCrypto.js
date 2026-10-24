// The secrets behind two-step verification, kept encrypted in the database (AES-256-GCM), and the one-time
// recovery codes, kept only as hashes. Pure functions; mfa.js stores them.
//
// The key is MFA_ENCRYPTION_KEY if set, otherwise derived from SESSION_SECRET. If the key changes, stored
// secrets can no longer be read: those people sign in with a recovery code, or an administrator resets
// their two-step verification (Users page). Nobody is locked out for good.
'use strict';
const crypto = require('crypto');

const VERSION = 'v1';
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';   // no 0/o/1/i/l: easy to read aloud

function keyFrom(env) {
  const material = env.MFA_ENCRYPTION_KEY || env.SESSION_SECRET || 'itsm-dev-secret-change-me';
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(material), Buffer.from('novadesk-mfa'), Buffer.from('totp-secret'), 32));
}

function encryptSecret(plain, env = process.env) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(env), iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(':');
}

function decryptSecret(blob, env = process.env) {
  const [version, iv, tag, body] = String(blob).split(':');
  if (version !== VERSION || !iv || !tag || !body) throw new Error('unreadable two-step verification secret');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(env), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
}

// Ten codes like "k7m2-x9qd-4tbp" (12 characters of 31, about 59 bits each).
function generateRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const chars = Array.from(crypto.randomBytes(12), (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
  });
}
const normalizeRecoveryCode = (code) => String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const hashRecoveryCode = (code) => crypto.createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');

module.exports = { encryptSecret, decryptSecret, generateRecoveryCodes, hashRecoveryCode, normalizeRecoveryCode };
