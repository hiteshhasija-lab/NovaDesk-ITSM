// The bearer tokens an identity provider sends to /scim/v2. A token looks like nds_ followed by 40 random characters
// (240 bits, so a plain SHA-256 hash is enough), is shown once when it is made, and is kept only as that hash. It is not a
// person's API key: it can only provision people, never read or change tickets.
'use strict';
const crypto = require('crypto');
const { db, nowStr } = require('../db');

const MAX_ACTIVE = 5;
const TOUCH_AFTER_MS = 60 * 1000;

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const newToken = () => `nds_${crypto.randomBytes(30).toString('base64url')}`;
const looksLikeToken = (s) => /^nds_[A-Za-z0-9_-]{40}$/.test(String(s || ''));
const expiryFrom = (days, now = Date.now()) => (days ? new Date(now + days * 86400000).toISOString().slice(0, 19).replace('T', ' ') : null);

async function createToken({ name, expiresInDays, createdBy }) {
  const active = Number((await db.prepare('SELECT COUNT(*) AS c FROM scim_tokens WHERE revoked_at IS NULL').get()).c);
  if (active >= MAX_ACTIVE) throw Object.assign(new Error(`There are already ${MAX_ACTIVE} active SCIM tokens. Revoke one first.`), { code: 'too_many_tokens' });
  const token = newToken();
  const row = await db.prepare('INSERT INTO scim_tokens (name, prefix, token_hash, expires_at, created_by) VALUES (?, ?, ?, ?, ?) RETURNING id')
    .run(name, token.slice(0, 8), hashToken(token), expiryFrom(expiresInDays), createdBy || null);
  return { id: row.lastInsertRowid, token };
}

const listTokens = () => db.prepare('SELECT id, name, prefix, expires_at, last_used_at, revoked_at, created_at FROM scim_tokens ORDER BY id DESC').all();
async function revokeToken(id) {
  return (await db.prepare('UPDATE scim_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(nowStr(), id)).changes === 1;
}

// Resolves { token: { id, name } } or { error } (a reason for the log; the caller only ever says "invalid").
async function authenticate(token, now = Date.now()) {
  if (!looksLikeToken(token)) return { error: 'malformed' };
  const row = await db.prepare('SELECT id, name, expires_at, revoked_at, last_used_at FROM scim_tokens WHERE token_hash = ?').get(hashToken(token));
  if (!row) return { error: 'unknown' };
  if (row.revoked_at) return { error: 'revoked' };
  if (row.expires_at && new Date(row.expires_at.replace(' ', 'T') + 'Z').getTime() <= now) return { error: 'expired' };
  const last = row.last_used_at ? new Date(row.last_used_at.replace(' ', 'T') + 'Z').getTime() : 0;
  if (now - last > TOUCH_AFTER_MS) await db.prepare('UPDATE scim_tokens SET last_used_at = ? WHERE id = ?').run(nowStr(), row.id).catch(() => {});
  return { token: { id: row.id, name: row.name } };
}

module.exports = { createToken, listTokens, revokeToken, authenticate, hashToken, newToken, looksLikeToken, expiryFrom, MAX_ACTIVE };
