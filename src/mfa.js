// Two-step verification for local accounts: setup, the check at sign-in, recovery codes, turning it off.
// The codes and the encryption are in totp.js and mfaCrypto.js; this keeps the rows.
'use strict';
const { db, nowStr } = require('./db');
const totp = require('./totp');
const { encryptSecret, decryptSecret, generateRecoveryCodes, hashRecoveryCode } = require('./mfaCrypto');

const ISSUER = 'NovaDesk';

async function status(userId) {
  const row = await db.prepare('SELECT user_id, enabled, enabled_at FROM user_mfa WHERE user_id = ?').get(userId);
  const left = row && row.enabled ? (await db.prepare('SELECT COUNT(*) AS c FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL').get(userId)).c : 0;
  return { enabled: Boolean(row && row.enabled), pending: Boolean(row && !row.enabled), enabledAt: row ? row.enabled_at : null, recoveryCodesLeft: Number(left) };
}
const isEnabled = async (userId) => (await status(userId)).enabled;

// Starts (or restarts) setup: a fresh key the person adds to their authenticator app. Nothing is
// required of them until they confirm with a code, so abandoning setup changes nothing.
async function beginSetup(user) {
  if (await isEnabled(user.id)) throw new Error('Two-step verification is already on for this account.');
  const secret = totp.generateSecret();
  await db.prepare(`
    INSERT INTO user_mfa (user_id, secret_enc, enabled, last_counter, created_at) VALUES (?, ?, 0, 0, ?)
    ON CONFLICT (user_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, enabled = 0, last_counter = 0, created_at = EXCLUDED.created_at, enabled_at = NULL
    WHERE user_mfa.enabled = 0
  `).run(user.id, encryptSecret(secret), nowStr());
  return { secret, uri: totp.otpauthUri({ issuer: ISSUER, account: user.email || user.username, secret }) };
}

// The key of a setup in progress (so the page can show it again after a wrong code).
async function pendingSetup(user) {
  const row = await db.prepare('SELECT secret_enc FROM user_mfa WHERE user_id = ? AND enabled = 0').get(user.id);
  if (!row) return null;
  const secret = decryptSecret(row.secret_enc);
  return { secret, uri: totp.otpauthUri({ issuer: ISSUER, account: user.email || user.username, secret }) };
}

async function replaceRecoveryCodes(userId) {
  const codes = generateRecoveryCodes();
  await db.prepare('DELETE FROM user_recovery_codes WHERE user_id = ?').run(userId);
  for (const code of codes) await db.prepare('INSERT INTO user_recovery_codes (user_id, code_hash) VALUES (?, ?)').run(userId, hashRecoveryCode(code));
  return codes;
}

// Confirms setup with the first code from the app. Resolves the recovery codes (shown once) or null.
async function finishSetup(userId, code) {
  const row = await db.prepare('SELECT secret_enc FROM user_mfa WHERE user_id = ? AND enabled = 0').get(userId);
  if (!row) return null;
  const counter = totp.verify(decryptSecret(row.secret_enc), code);
  if (!counter) return null;
  const done = await db.prepare('UPDATE user_mfa SET enabled = 1, enabled_at = ?, last_counter = ? WHERE user_id = ? AND enabled = 0').run(nowStr(), counter, userId);
  if (done.changes !== 1) return null;
  return replaceRecoveryCodes(userId);
}

// A code at sign-in: the six digits from the app, or a recovery code (each works once). Resolves
// { ok, usedRecoveryCode, recoveryCodesLeft } and never throws on a bad code. A secret that cannot be read
// (the encryption key changed) leaves only recovery codes.
async function verifyLogin(userId, input) {
  const row = await db.prepare('SELECT secret_enc, last_counter FROM user_mfa WHERE user_id = ? AND enabled = 1').get(userId);
  if (!row) return { ok: false };
  const typed = String(input || '').trim();
  if (/^[\d\s]{6,8}$/.test(typed)) {
    let secret = null;
    try { secret = decryptSecret(row.secret_enc); } catch (err) { console.error(`[MFA] the secret for user ${userId} cannot be read (did the encryption key change?): ${err.message}`); }
    if (secret) {
      const counter = totp.verify(secret, typed, { afterCounter: Number(row.last_counter) });
      if (counter) {
        // The step is claimed with a compare-and-set, so the same code cannot pass twice at once.
        const claim = await db.prepare('UPDATE user_mfa SET last_counter = ? WHERE user_id = ? AND last_counter < ?').run(counter, userId, counter);
        if (claim.changes === 1) return { ok: true, usedRecoveryCode: false };
      }
    }
    return { ok: false };
  }
  const hash = hashRecoveryCode(typed);
  const used = await db.prepare('UPDATE user_recovery_codes SET used_at = ? WHERE id = (SELECT id FROM user_recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL LIMIT 1) AND used_at IS NULL').run(nowStr(), userId, hash);
  if (used.changes !== 1) return { ok: false };
  const left = (await db.prepare('SELECT COUNT(*) AS c FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL').get(userId)).c;
  return { ok: true, usedRecoveryCode: true, recoveryCodesLeft: Number(left) };
}

async function disable(userId) {
  await db.prepare('DELETE FROM user_recovery_codes WHERE user_id = ?').run(userId);
  await db.prepare('DELETE FROM user_mfa WHERE user_id = ?').run(userId);
}

// Is this person required to have it? (MFA_REQUIRE: none, admins or all). Single-sign-on users answer to their
// provider's own policy, so they are not asked here.
const requiredFor = (policy, role) => policy.mfaRequire === 'all' || (policy.mfaRequire === 'admins' && role === 'admin');

// Sign-in attempts at the code step, counted per person, so guessing the six digits from many addresses
// still stops: 5 wrong codes lock the code step for 10 minutes.
const FAILURE_LIMIT = 5;
const LOCK_MS = 10 * 60 * 1000;
const failures = new Map();
function lockedUntil(userId, now = Date.now()) {
  const f = failures.get(userId);
  return f && f.count >= FAILURE_LIMIT && now < f.until ? f.until : 0;
}
function recordFailure(userId, now = Date.now()) {
  const f = failures.get(userId);
  const fresh = !f || now > f.until;
  const next = { count: fresh ? 1 : f.count + 1, until: fresh ? now + LOCK_MS : f.until };
  failures.set(userId, next);
  return next.count;
}
const clearFailures = (userId) => failures.delete(userId);

module.exports = { status, isEnabled, beginSetup, pendingSetup, finishSetup, verifyLogin, disable, replaceRecoveryCodes, requiredFor, lockedUntil, recordFailure, clearFailures, FAILURE_LIMIT, LOCK_MS };
