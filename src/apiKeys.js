// Personal API keys. A key looks like ndk_ followed by 40 random characters, acts as the person who made it,
// and is stored only as a SHA-256 hash (it carries 240 bits of randomness, so a plain hash is enough and the
// lookup is a single indexed read). The key itself is shown once, when it is made.
'use strict';
const crypto = require('crypto');
const { db, nowStr } = require('./db');

const MAX_KEYS_PER_USER = 10;
const TOUCH_AFTER_MS = 60 * 1000;      // last_used_at is written at most once a minute per key

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const newToken = () => `ndk_${crypto.randomBytes(30).toString('base64url')}`;
const looksLikeToken = (s) => /^ndk_[A-Za-z0-9_-]{40}$/.test(String(s || ''));

const expiryFrom = (days, now = Date.now()) => (days ? new Date(now + days * 86400000).toISOString().slice(0, 19).replace('T', ' ') : null);

// Resolves { token, id }: the token is returned here and never again.
async function createKey(userId, { name, scope, expiresInDays }) {
  const count = Number((await db.prepare('SELECT COUNT(*) AS c FROM api_keys WHERE user_id = ? AND revoked_at IS NULL').get(userId)).c);
  if (count >= MAX_KEYS_PER_USER) throw Object.assign(new Error(`You already have ${MAX_KEYS_PER_USER} active API keys. Revoke one first.`), { code: 'too_many_keys' });
  const token = newToken();
  const info = await db.prepare(`
    INSERT INTO api_keys (user_id, name, prefix, token_hash, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id
  `).run(userId, name, token.slice(0, 8), hashToken(token), scope === 'write' ? 'write' : 'read', expiryFrom(expiresInDays));
  return { id: info.lastInsertRowid, token };
}

const listKeys = (userId) => db.prepare('SELECT id, name, prefix, scope, expires_at, last_used_at, revoked_at, created_at FROM api_keys WHERE user_id = ? ORDER BY id DESC').all(userId);

async function revokeKey(userId, keyId) {
  const done = await db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(nowStr(), keyId, userId);
  return done.changes === 1;
}
async function revokeAllKeys(userId) {
  return (await db.prepare('UPDATE api_keys SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(nowStr(), userId)).changes;
}

// Resolves { key, user } for a token, or { error } with a reason for the log (the caller says only "invalid").
async function authenticate(token, now = Date.now()) {
  if (!looksLikeToken(token)) return { error: 'malformed' };
  const row = await db.prepare(`
    SELECT k.id AS key_id, k.user_id, k.name, k.scope, k.expires_at, k.revoked_at, k.last_used_at,
           u.username, u.full_name, u.email, u.role, u.active
    FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.token_hash = ?
  `).get(hashToken(token));
  if (!row) return { error: 'unknown' };
  if (row.revoked_at) return { error: 'revoked' };
  if (row.expires_at && new Date(row.expires_at.replace(' ', 'T') + 'Z').getTime() <= now) return { error: 'expired' };
  if (!row.active) return { error: 'user_inactive' };
  const last = row.last_used_at ? new Date(row.last_used_at.replace(' ', 'T') + 'Z').getTime() : 0;
  if (now - last > TOUCH_AFTER_MS) await db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(nowStr(), row.key_id).catch(() => {});
  return {
    key: { id: row.key_id, name: row.name, scope: row.scope },
    user: { id: row.user_id, username: row.username, full_name: row.full_name, email: row.email, role: row.role },
  };
}

module.exports = { createKey, listKeys, revokeKey, revokeAllKeys, authenticate, hashToken, newToken, looksLikeToken, expiryFrom, MAX_KEYS_PER_USER };
