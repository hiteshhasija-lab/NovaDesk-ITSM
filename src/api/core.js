// The machinery of the REST API (/api/v1): errors, input checking, authentication with a personal API key,
// rate limits, idempotent POSTs, and a registry of routes (the OpenAPI document and the docs page are built from
// the same registry, so what is documented is what exists).
'use strict';
const crypto = require('crypto');
const express = require('express');
const { db, nowStr } = require('../db');
const apiKeys = require('../apiKeys');
const { createWindowCounter } = require('../rateLimit');
const { rateLimits } = require('../settings');

class ApiError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}
// A handler returns its data (answered 200, or the route's `status`), or respond(data, { status, headers }) when it needs
// a different status or extra headers. Data is never inspected, so a record's own "status" field cannot be mistaken for it.
class Respond { constructor(body, { status, headers } = {}) { this.body = body; this.status = status; this.headers = headers || {}; } }
const respond = (body, options) => new Respond(body, options);
const badRequest = (message, details) => new ApiError(400, 'invalid_request', message, details);
const notFound = (what = 'Record') => new ApiError(404, 'not_found', `${what} not found.`);
const forbidden = (message = 'You do not have permission to do that.') => new ApiError(403, 'forbidden', message);
const unprocessable = (message, details) => new ApiError(422, 'invalid_reference', message, details);

// ---------------------------------------------------------------- input
// A field is { type: 'string'|'integer'|'enum'|'boolean'|'date', ... } plus optional: required, nullable, max, min, values, description.
// Unknown fields are refused, so a typo fails loudly instead of being ignored.
function parseFields(schema, input, { partial = false, where = 'body' } = {}) {
  const errors = [];
  const out = {};
  const data = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
  if (!data) throw badRequest(`The ${where} must be a JSON object.`);
  for (const key of Object.keys(data)) if (!schema[key]) errors.push({ field: key, message: 'is not a known field' });
  for (const [key, def] of Object.entries(schema)) {
    const present = Object.prototype.hasOwnProperty.call(data, key);
    let value = data[key];
    if (!present) { if (def.required && !partial) errors.push({ field: key, message: 'is required' }); continue; }
    if (where === 'query' && value === '') continue;                    // ?q= is the same as leaving it out
    if (value === null || value === '') {
      if (def.nullable) { out[key] = null; continue; }
      errors.push({ field: key, message: def.required ? 'is required' : 'cannot be empty' }); continue;
    }
    switch (def.type) {
      case 'string':
        if (typeof value !== 'string') { errors.push({ field: key, message: 'must be a string' }); break; }
        if (def.max && value.length > def.max) { errors.push({ field: key, message: `must be at most ${def.max} characters` }); break; }
        if (!value.trim()) { errors.push({ field: key, message: 'cannot be blank' }); break; }
        out[key] = value;
        break;
      case 'integer': {
        const n = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
        if (!Number.isInteger(n)) { errors.push({ field: key, message: 'must be a whole number' }); break; }
        if ((def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max)) { errors.push({ field: key, message: `must be between ${def.min ?? 'any'} and ${def.max ?? 'any'}` }); break; }
        out[key] = n;
        break;
      }
      case 'enum':
        if (!def.values.includes(value)) { errors.push({ field: key, message: `must be one of: ${def.values.join(', ')}` }); break; }
        out[key] = value;
        break;
      case 'boolean':
        if (typeof value !== 'boolean') { errors.push({ field: key, message: 'must be true or false' }); break; }
        out[key] = value;
        break;
      case 'date':
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) { errors.push({ field: key, message: 'must be a date like 2026-12-31' }); break; }
        out[key] = value;
        break;
      default: errors.push({ field: key, message: 'has an unsupported type' });
    }
  }
  if (errors.length) throw badRequest(`The ${where} is not valid.`, errors);
  return out;
}

// page and per_page, parsed like any other query field (include PAGING in a route's query schema).
const PAGING = { page: { type: 'integer', min: 1, max: 100000, description: 'Page number, from 1 (default 1).' }, per_page: { type: 'integer', min: 1, max: 200, description: 'Items per page, 1 to 200 (default 50).' } };
const paging = (query) => { const page = query.page || 1; const perPage = query.per_page || 50; return { page, perPage, offset: (page - 1) * perPage }; };

const iso = (s) => (s ? `${String(s).replace(' ', 'T')}Z` : null);
const idParam = (req, name = 'id') => {
  const n = Number(req.params[name]);
  if (!Number.isInteger(n) || n < 1 || n > 2147483647) throw notFound();
  return n;
};

// ---------------------------------------------------------------- the router
function createApi() {
  const limits = rateLimits(process.env);
  const readCounter = createWindowCounter({ windowMs: 60 * 1000, max: limits.apiPerMinute });
  const writeCounter = createWindowCounter({ windowMs: 60 * 1000, max: limits.apiWritePerMinute });
  const failedAuth = createWindowCounter({ windowMs: 15 * 60 * 1000, max: 30 });

  const router = express.Router();
  const routes = [];

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Vary', 'Authorization');
    next();
  });

  // The OpenAPI document and the docs page need no key.
  const publicRoutes = [];
  const publicGet = (path, handler) => { publicRoutes.push(path); router.get(path, handler); };

  // ---- authentication (every route below this point needs a key)
  router.use(async (req, res, next) => {
    if (publicRoutes.includes(req.path)) return next();
    try {
      const header = req.get('Authorization') || '';
      const m = /^Bearer\s+(\S+)$/i.exec(header);
      if (!m) {
        res.set('WWW-Authenticate', 'Bearer realm="NovaDesk"');
        throw new ApiError(401, 'unauthorized', 'Send your API key as "Authorization: Bearer ndk_...".');
      }
      const auth = await apiKeys.authenticate(m[1]);
      if (auth.error) {
        const r = failedAuth.hit(req.ip);
        if (!r.allowed) { res.set('Retry-After', String(r.resetSeconds)); throw new ApiError(429, 'rate_limited', 'Too many failed attempts from this address. Try again later.'); }
        res.set('WWW-Authenticate', 'Bearer realm="NovaDesk", error="invalid_token"');
        throw new ApiError(401, 'invalid_token', 'The API key is not valid. It may be mistyped, revoked or expired.');
      }
      req.api = auth;
      next();
    } catch (err) { next(err); }
  });

  // ---- rate limit, per key: reads and writes have their own allowance
  router.use((req, res, next) => {
    if (!req.api) return next();
    const write = !['GET', 'HEAD'].includes(req.method);
    const r = (write ? writeCounter : readCounter).hit(`key:${req.api.key.id}`);
    if (r.limit) {
      res.set('X-RateLimit-Limit', String(r.limit));
      res.set('X-RateLimit-Remaining', String(r.remaining));
      res.set('X-RateLimit-Reset', String(r.resetSeconds));
    }
    if (r.allowed) return next();
    res.set('Retry-After', String(r.resetSeconds));
    next(new ApiError(429, 'rate_limited', `Too many ${write ? 'write ' : ''}requests for this key. Try again in ${r.resetSeconds} seconds.`));
  });

  router.use(express.json({ limit: '256kb', strict: true, type: ['application/json', 'application/*+json'] }));

  // ---- idempotent POST: the same Idempotency-Key replays the first answer
  router.use(async (req, res, next) => {
    if (req.method !== 'POST' || !req.api) return next();
    const raw = req.get('Idempotency-Key');
    if (!raw) return next();
    try {
      if (!/^[\x21-\x7e]{1,128}$/.test(raw)) throw badRequest('Idempotency-Key must be 1 to 128 printable characters, for example a UUID.');
      const hash = crypto.createHash('sha256').update(`${req.method} ${req.originalUrl} ${JSON.stringify(req.body || {})}`).digest('hex');
      const keyId = req.api.key.id;
      const claim = await db.prepare(`INSERT INTO api_idempotency (key_id, idem_key, request_hash) VALUES (?, ?, ?) ON CONFLICT (key_id, idem_key) DO NOTHING RETURNING id`).run(keyId, raw, hash);
      if (claim.changes === 1) { req.idempotencyRowId = claim.lastInsertRowid; return next(); }
      const prior = await db.prepare('SELECT request_hash, status, response FROM api_idempotency WHERE key_id = ? AND idem_key = ?').get(keyId, raw);
      if (!prior) return next();
      if (prior.request_hash !== hash) throw new ApiError(422, 'idempotency_key_reuse', 'This Idempotency-Key was already used for a different request.');
      if (prior.status === null) throw new ApiError(409, 'request_in_progress', 'The first request with this Idempotency-Key is still being processed. Retry shortly.');
      res.set('Idempotent-Replay', 'true');
      return res.status(prior.status).type('application/json').send(prior.response);
    } catch (err) { next(err); }
  });

  // ---- route registration
  // meta: { summary, description, tag, scope: 'read'|'write', roles: [...], query: {...}, body: {...}, partialBody, response: schema name, status }
  function route(method, path, meta, handler) {
    routes.push({ method: method.toUpperCase(), path, ...meta });
    router[method.toLowerCase()](path, async (req, res, next) => {
      try {
        if (meta.scope === 'write' && req.api.key.scope !== 'write') throw new ApiError(403, 'insufficient_scope', 'This API key is read-only. Make a key with write access to create or change records.');
        if (meta.roles && !meta.roles.includes(req.api.user.role)) throw forbidden();
        if (meta.body && !req.is('application/json')) throw new ApiError(415, 'unsupported_media_type', 'Send the body as JSON with "Content-Type: application/json".');
        const input = {
          query: meta.query ? parseFields(meta.query, Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])), { partial: true, where: 'query' }) : {},
          body: meta.body ? parseFields(meta.body, req.body, { partial: Boolean(meta.partialBody), where: 'body' }) : null,
        };
        if (meta.partialBody && input.body && !Object.keys(input.body).length) throw badRequest('The body has nothing to change.');
        const result = await handler(req, input);
        const wrapped = result instanceof Respond;
        const status = (wrapped && result.status) || meta.status || 200;
        const body = wrapped ? result.body : result;
        for (const [k, v] of Object.entries(wrapped ? result.headers : {})) res.set(k, v);
        const text = JSON.stringify(body);
        if (req.idempotencyRowId) await db.prepare('UPDATE api_idempotency SET status = ?, response = ? WHERE id = ?').run(status, text, req.idempotencyRowId);
        res.status(status).type('application/json').send(text);
      } catch (err) {
        if (req.idempotencyRowId) await db.prepare('DELETE FROM api_idempotency WHERE id = ? AND status IS NULL').run(req.idempotencyRowId).catch(() => {});
        next(err);
      }
    });
  }

  // ---- 404 and errors, always JSON
  const finish = () => {
    router.use((req, res, next) => next(new ApiError(404, 'not_found', 'There is no such API route. See /api/docs.')));
    router.use((err, req, res, next) => {          // eslint-disable-line no-unused-vars
      let e = err;
      if (!(e instanceof ApiError)) {
        if (e.type === 'entity.parse.failed') e = new ApiError(400, 'invalid_json', 'The body is not valid JSON.');
        else if (e.type === 'entity.too.large') e = new ApiError(413, 'payload_too_large', 'The body is too large (the limit is 256 KB).');
        else if (e.type === 'charset.unsupported' || e.type === 'encoding.unsupported') e = new ApiError(415, 'unsupported_media_type', 'Send the body as UTF-8 JSON.');
        else if (e.code === '22P02' || e.code === '22003') e = notFound();
        else { console.error('[API] unexpected failure:', err); e = new ApiError(500, 'server_error', 'Something went wrong on our side.'); }
      }
      const body = { error: { code: e.code, message: e.message } };
      if (e.details) body.error.details = e.details;
      res.status(e.status).json(body);
    });
  };

  return { router, route, publicGet, routes, finish, limits };
}

module.exports = { createApi, respond, ApiError, badRequest, notFound, forbidden, unprocessable, parseFields, PAGING, paging, iso, idParam };
