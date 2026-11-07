// Two-step verification for the platform console's operators: a time-based code from an authenticator app (src/totp.js), the secret kept
// encrypted (src/mfaCrypto.js), and ten one-time recovery codes kept only as hashes. The same machinery as the tenants' people have
// (src/mfa.js), on tables of their own. Wrong codes count against the operator's account: five lock it for fifteen minutes.
'use strict';
const { db, nowStr } = require('./db');
const tenancy = require('./tenancy');
const totp = require('./totp');
const { encryptSecret, decryptSecret, generateRecoveryCodes, hashRecoveryCode } = require('./mfaCrypto');
const qr = require('./qr');

const P = (fn) => tenancy.runPlatform(fn);
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60 * 1000;

async function status(adminId) {
  const row = await P(() => db.prepare('SELECT enabled, enabled_at FROM platform_mfa WHERE admin_id = ?').get(adminId));
  const left = row && row.enabled ? Number((await P(() => db.prepare('SELECT COUNT(*) AS c FROM platform_recovery_codes WHERE admin_id = ? AND used_at IS NULL').get(adminId))).c) : 0;
  return { enabled: Boolean(row && row.enabled), pending: Boolean(row && !row.enabled), enabledAt: row ? row.enabled_at : null, recoveryCodesLeft: left };
}

// Starts (or restarts) setup: a fresh key for the authenticator app. Nothing is required until a code confirms it.
async function beginSetup(op, issuer) {
  if ((await status(op.id)).enabled) throw new Error('Two-step verification is already on for this operator.');
  const secret = totp.generateSecret();
  await P(() => db.prepare(`INSERT INTO platform_mfa (admin_id, secret_enc, enabled, last_counter) VALUES (?, ?, 0, 0)
    ON CONFLICT (admin_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, enabled = 0, last_counter = 0, created_at = ?, enabled_at = NULL WHERE platform_mfa.enabled = 0`)
    .run(op.id, encryptSecret(secret), nowStr()));
  return describe(op, secret, issuer);
}
async function pendingSetup(op, issuer) {
  const row = await P(() => db.prepare('SELECT secret_enc FROM platform_mfa WHERE admin_id = ? AND enabled = 0').get(op.id));
  if (!row) return null;
  try { return describe(op, decryptSecret(row.secret_enc), issuer); } catch { return null; }
}
function describe(op, secret, issuer) {
  const uri = totp.otpauthUri({ issuer, account: op.username, secret });
  return { secret, uri, qrSvg: qr.toSvg(uri, { label: 'QR code for the platform console setup key' }) };
}

async function replaceRecoveryCodes(adminId) {
  const codes = generateRecoveryCodes();
  await P(() => db.prepare('DELETE FROM platform_recovery_codes WHERE admin_id = ?').run(adminId));
  for (const c of codes) await P(() => db.prepare('INSERT INTO platform_recovery_codes (admin_id, code_hash) VALUES (?, ?)').run(adminId, hashRecoveryCode(c)));
  return codes;
}

// Confirms setup with the first code from the app. Resolves the recovery codes (shown once) or null.
async function finishSetup(adminId, code) {
  const row = await P(() => db.prepare('SELECT secret_enc FROM platform_mfa WHERE admin_id = ? AND enabled = 0').get(adminId));
  if (!row) return null;
  const counter = totp.verify(decryptSecret(row.secret_enc), code);
  if (!counter) return null;
  const done = await P(() => db.prepare('UPDATE platform_mfa SET enabled = 1, enabled_at = ?, last_counter = ? WHERE admin_id = ? AND enabled = 0').run(nowStr(), counter, adminId));
  return done.changes === 1 ? replaceRecoveryCodes(adminId) : null;
}

// A code at sign-in (or to confirm a change): six digits from the app, or a recovery code (each works once). { ok, usedRecoveryCode, recoveryCodesLeft }.
async function verify(adminId, input) {
  const row = await P(() => db.prepare('SELECT secret_enc, last_counter FROM platform_mfa WHERE admin_id = ? AND enabled = 1').get(adminId));
  if (!row) return { ok: false };
  const typed = String(input || '').trim();
  if (/^[\d\s]{6,8}$/.test(typed)) {
    let secret = null;
    try { secret = decryptSecret(row.secret_enc); } catch (err) { console.error(`[Platform] the two-step secret of operator ${adminId} cannot be read (did the encryption key change?): ${err.message}`); }
    if (secret) {
      const counter = totp.verify(secret, typed, { afterCounter: Number(row.last_counter) });
      if (counter) {
        const claim = await P(() => db.prepare('UPDATE platform_mfa SET last_counter = ? WHERE admin_id = ? AND last_counter < ?').run(counter, adminId, counter));   // the same code cannot pass twice at once
        if (claim.changes === 1) return { ok: true, usedRecoveryCode: false };
      }
    }
    return { ok: false };
  }
  const hash = hashRecoveryCode(typed);
  const used = await P(() => db.prepare('UPDATE platform_recovery_codes SET used_at = ? WHERE id = (SELECT id FROM platform_recovery_codes WHERE admin_id = ? AND code_hash = ? AND used_at IS NULL LIMIT 1) AND used_at IS NULL').run(nowStr(), adminId, hash));
  if (used.changes !== 1) return { ok: false };
  const left = Number((await P(() => db.prepare('SELECT COUNT(*) AS c FROM platform_recovery_codes WHERE admin_id = ? AND used_at IS NULL').get(adminId))).c);
  return { ok: true, usedRecoveryCode: true, recoveryCodesLeft: left };
}

const disable = async (adminId) => { await P(() => db.prepare('DELETE FROM platform_mfa WHERE admin_id = ?').run(adminId)); await P(() => db.prepare('DELETE FROM platform_recovery_codes WHERE admin_id = ?').run(adminId)); };

// Wrong codes count against the operator's account, with the password failures: five lock it.
async function isLocked(adminId) {
  const r = await P(() => db.prepare('SELECT locked_until FROM platform_admins WHERE id = ?').get(adminId));
  return Boolean(r && r.locked_until && new Date(r.locked_until.replace(' ', 'T') + 'Z').getTime() > Date.now());
}
async function recordFailure(adminId) {
  const f = await P(() => db.prepare('UPDATE platform_admins SET failed_logins = failed_logins + 1 WHERE id = ? RETURNING failed_logins').get(adminId));
  if (f && f.failed_logins >= LOCK_AFTER) await P(() => db.prepare('UPDATE platform_admins SET locked_until = ?, failed_logins = 0 WHERE id = ?').run(new Date(Date.now() + LOCK_MS).toISOString().slice(0, 19).replace('T', ' '), adminId));
}
const clearFailures = (adminId) => P(() => db.prepare('UPDATE platform_admins SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(adminId));

module.exports = { status, beginSetup, pendingSetup, finishSetup, verify, disable, replaceRecoveryCodes, isLocked, recordFailure, clearFailures };
