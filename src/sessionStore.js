// Sign-in sessions kept in the database (table `sessions`, migration 0008) instead of files.
//
// Besides storing what express-session hands over, this is what makes "who is signed in where" possible:
// each row carries the person's id, address and browser, so a person can see their sessions and end them, and
// a changed password, a reset, a deactivation or an administrator can end every session of one person at once.
'use strict';
const session = require('express-session');
const crypto = require('crypto');
const { db } = require('./db');

const nowStr = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const TOUCH_EVERY_MS = 60 * 1000;               // a session's "last active" is written at most once a minute
const DEFAULT_LIFETIME_MS = 8 * 60 * 60 * 1000;

// What the person sees instead of the session id: a short fingerprint, so a page never shows the cookie's own value.
const publicId = (sid) => crypto.createHash('sha256').update(String(sid)).digest('hex').slice(0, 20);

class PgSessionStore extends session.Store {
  get(sid, cb) {
    db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?').get(sid).then((row) => {
      if (!row) return cb(null, null);
      if (row.expires_at <= nowStr()) return this.destroy(sid, () => cb(null, null));
      let data;
      try { data = JSON.parse(row.data); } catch { return cb(null, null); }
      cb(null, data);
    }, cb);
  }

  set(sid, sess, cb) {
    const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + DEFAULT_LIFETIME_MS;
    const userId = sess.user && Number.isInteger(Number(sess.user.id)) ? Number(sess.user.id) : null;
    const meta = sess.meta || {};
    const now = nowStr();
    db.prepare(`INSERT INTO sessions (sid, user_id, data, created_at, last_seen_at, expires_at, ip, user_agent)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (sid) DO UPDATE SET user_id = EXCLUDED.user_id, data = EXCLUDED.data, last_seen_at = EXCLUDED.last_seen_at,
                  expires_at = EXCLUDED.expires_at, ip = COALESCE(EXCLUDED.ip, sessions.ip), user_agent = COALESCE(EXCLUDED.user_agent, sessions.user_agent)`)
      .run(sid, userId, JSON.stringify(sess), now, now, nowStr(expires), meta.ip || null, meta.ua || null)
      .then(() => cb && cb(null), (err) => cb && cb(err));
  }

  touch(sid, sess, cb) {
    const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + DEFAULT_LIFETIME_MS;
    db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE sid = ? AND last_seen_at < ?')
      .run(nowStr(), nowStr(expires), sid, nowStr(Date.now() - TOUCH_EVERY_MS))
      .then(() => cb && cb(null), (err) => cb && cb(err));
  }

  destroy(sid, cb) {
    db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid).then(() => cb && cb(null), (err) => cb && cb(err));
  }
}

// ---- for the pages and routes ----

// A person's sessions, newest activity first. `current` is the sid of the request, to mark "this device".
async function listFor(userId, currentSid) {
  const rows = await db.prepare('SELECT sid, created_at, last_seen_at, expires_at, ip, user_agent FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC').all(userId, nowStr());
  return rows.map((r) => ({ id: publicId(r.sid), sid: r.sid, current: r.sid === currentSid, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at, ip: r.ip, device: describeAgent(r.user_agent) }));
}
async function countFor(userId) {
  return (await db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ? AND expires_at > ?').get(userId, nowStr())).c;
}
// Ends every session of one person, except (optionally) the one making this request. Resolves how many ended.
async function revokeAll(userId, exceptSid = null) {
  const result = exceptSid
    ? await db.prepare('DELETE FROM sessions WHERE user_id = ? AND sid <> ?').run(userId, exceptSid)
    : await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  return result.changes || 0;
}
// Ends one of a person's sessions, named by its public id (never by another person's).
async function revokeOne(userId, id) {
  const mine = await listFor(userId, null);
  const hit = mine.find((s) => s.id === String(id));
  if (!hit) return false;
  await db.prepare('DELETE FROM sessions WHERE sid = ? AND user_id = ?').run(hit.sid, userId);
  return true;
}
async function cleanup() {
  return (await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowStr())).changes || 0;
}
function startCleanup(everyMs = 10 * 60 * 1000) {
  const timer = setInterval(() => cleanup().catch((err) => console.error(`[Sessions] cleanup failed: ${err.message}`)), everyMs);
  timer.unref();
  return timer;
}

// "Chrome on macOS" from a User-Agent string: enough to recognise a device, nothing more.
function describeAgent(ua) {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl\//.test(ua) ? 'curl' : /node|undici/i.test(ua) ? 'a script' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

module.exports = { PgSessionStore, listFor, countFor, revokeAll, revokeOne, cleanup, startCleanup, describeAgent, publicId };
