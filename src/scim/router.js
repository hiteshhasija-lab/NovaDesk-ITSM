// /scim/v2: SCIM 2.0 provisioning (RFC 7643 and 7644). Like the REST API it sits before the page machinery: its own body
// parsing, bearer-token authentication (never the browser session, so CSRF does not apply), rate limits, and SCIM-shaped
// errors. See src/scim/service.js for the rules it enforces.
'use strict';
const express = require('express');
const { createWindowCounter } = require('../rateLimit');
const { rateLimits } = require('../settings');
const tokens = require('./tokens');
const service = require('./service');
const discovery = require('./discovery');
const R = require('./resource');
const E = require('./errors');

const CONTENT_TYPE = 'application/scim+json; charset=utf-8';

function createScimRouter(env = process.env) {
  const limits = rateLimits(env);
  const perToken = createWindowCounter({ windowMs: 60 * 1000, max: limits.scimPerMinute });
  const failedAuth = createWindowCounter({ windowMs: 15 * 60 * 1000, max: 30 });
  const publicUrl = (env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  const baseOf = (req) => `${publicUrl || `${req.protocol}://${req.get('host')}`}/scim/v2`;

  const router = express.Router();
  const send = (res, status, body, headers = {}) => { res.set(headers); res.status(status).type(CONTENT_TYPE).send(JSON.stringify(body)); };
  const fail = (res, e) => send(res, e.status, E.errorBody(e));

  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('Vary', 'Authorization'); next(); });

  // ---- authentication
  router.use(async (req, res, next) => {
    try {
      const m = /^Bearer\s+(\S+)$/i.exec(req.get('Authorization') || '');
      const auth = m ? await tokens.authenticate(m[1]) : { error: 'missing' };
      if (auth.error) {
        const r = failedAuth.hit(req.ip);
        console.warn(`[SCIM] refused ${req.method} ${req.path} from ${req.ip}: ${auth.error} token`);
        res.set('WWW-Authenticate', 'Bearer realm="NovaDesk SCIM"');
        if (!r.allowed) { res.set('Retry-After', String(r.resetSeconds)); return fail(res, new E.ScimError(429, null, 'Too many failed attempts from this address. Try again later.')); }
        return fail(res, new E.ScimError(401, null, 'Send a SCIM token as "Authorization: Bearer nds_...". Make one under Settings > SCIM provisioning.'));
      }
      req.scimToken = auth.token;
      const w = perToken.hit(auth.token.id);
      if (!w.allowed) { res.set('Retry-After', String(w.resetSeconds)); return fail(res, new E.ScimError(429, null, `Too many requests for this token. Try again in ${w.resetSeconds} seconds.`)); }
      next();
    } catch (err) { next(err); }
  });

  // A JSON body, whatever its content type says (providers send application/scim+json, application/json or both).
  router.use(express.json({ type: (req) => /json/i.test(req.get('content-type') || ''), limit: '256kb' }));

  const handle = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) {
      if (err instanceof E.ScimError) return fail(res, err);
      console.error(`[SCIM] ${req.method} ${req.path} failed:`, err);
      return fail(res, new E.ScimError(500, null, 'The server could not do that. Try again, or ask an administrator.'));
    }
  };

  // ?startIndex=&count=&filter=&attributes=&excludedAttributes=
  const listQuery = (req) => {
    const whole = (name, fallback) => {
      if (req.query[name] === undefined || req.query[name] === '') return fallback;
      if (!/^-?\d+$/.test(String(req.query[name]))) throw E.invalidValue(`${name} must be a whole number.`);
      return Number(req.query[name]);
    };
    return { filter: typeof req.query.filter === 'string' && req.query.filter ? req.query.filter : undefined, startIndex: Math.max(1, whole('startIndex', 1)), count: Math.min(service.MAX_COUNT, Math.max(0, whole('count', service.MAX_COUNT))) };
  };
  const projection = (req) => ({ attributes: req.query.attributes, excludedAttributes: req.query.excludedAttributes });
  const listBody = (page, q, proj) => ({ schemas: [R.LIST_RESPONSE], totalResults: page.total, startIndex: q.startIndex, itemsPerPage: page.resources.length, Resources: page.resources.map((r) => R.project(r, proj)) });
  const body = (req) => {
    if (!/json/i.test(req.get('content-type') || '') || req.body === undefined || req.body === null || typeof req.body !== 'object') throw E.invalidSyntax('Send the request as JSON (Content-Type: application/scim+json).');
    return req.body;
  };

  // ---- discovery
  const maxResults = service.MAX_COUNT;
  router.get('/ServiceProviderConfig', handle((req, res) => send(res, 200, discovery.serviceProviderConfig(baseOf(req), { maxResults }))));
  router.get('/ResourceTypes', handle((req, res) => { const l = discovery.resourceTypes(baseOf(req)); send(res, 200, { schemas: [R.LIST_RESPONSE], totalResults: l.length, startIndex: 1, itemsPerPage: l.length, Resources: l }); }));
  router.get('/ResourceTypes/:id', handle((req, res) => { const t = discovery.resourceTypes(baseOf(req)).find((x) => x.id.toLowerCase() === req.params.id.toLowerCase()); if (!t) throw E.notFound('ResourceType'); send(res, 200, t); }));
  router.get('/Schemas', handle((req, res) => { const l = discovery.schemas(baseOf(req)); send(res, 200, { schemas: [R.LIST_RESPONSE], totalResults: l.length, startIndex: 1, itemsPerPage: l.length, Resources: l }); }));
  router.get('/Schemas/:id', handle((req, res) => { const s = discovery.schemas(baseOf(req)).find((x) => x.id.toLowerCase() === req.params.id.toLowerCase()); if (!s) throw E.notFound('Schema'); send(res, 200, s); }));

  // ---- people
  router.get('/Users', handle(async (req, res) => {
    const q = listQuery(req);
    send(res, 200, listBody(await service.listUsers(q, baseOf(req)), q, projection(req)));
  }));
  router.post('/Users', handle(async (req, res) => {
    const id = await service.createUser(R.parseUser(body(req)), req.scimToken, req);
    const user = await service.getUser(id, baseOf(req));
    send(res, 201, R.project(user, projection(req)), { Location: user.meta.location });
  }));
  router.get('/Users/:id', handle(async (req, res) => send(res, 200, R.project(await service.getUser(req.params.id, baseOf(req)), projection(req)))));
  router.put('/Users/:id', handle(async (req, res) => {
    await service.replaceUser(req.params.id, R.parseUser(body(req)), req.scimToken, req);
    send(res, 200, R.project(await service.getUser(req.params.id, baseOf(req)), projection(req)));
  }));
  router.patch('/Users/:id', handle(async (req, res) => {
    await service.patchUser(req.params.id, body(req), req.scimToken, req);
    send(res, 200, R.project(await service.getUser(req.params.id, baseOf(req)), projection(req)));
  }));
  router.delete('/Users/:id', handle(async (req, res) => { await service.deleteUser(req.params.id, req.scimToken, req); res.status(204).end(); }));

  // ---- groups (a fixed list: they cannot be made or deleted, only their members change)
  router.get('/Groups', handle(async (req, res) => {
    const q = listQuery(req);
    send(res, 200, listBody(await service.listGroups(q, baseOf(req)), q, projection(req)));
  }));
  router.get('/Groups/:id', handle(async (req, res) => send(res, 200, R.project(await service.getGroup(req.params.id, baseOf(req)), projection(req)))));
  router.put('/Groups/:id', handle(async (req, res) => {
    await service.replaceGroup(req.params.id, body(req), req.scimToken, req);
    send(res, 200, await service.getGroup(req.params.id, baseOf(req)));
  }));
  router.patch('/Groups/:id', handle(async (req, res) => {
    await service.patchGroup(req.params.id, body(req), req.scimToken, req);
    send(res, 200, await service.getGroup(req.params.id, baseOf(req)));
  }));
  const fixedGroups = handle(() => { throw E.forbidden("NovaDesk's groups are fixed: they cannot be created or deleted through SCIM. Add people to the existing ones instead."); });
  router.post('/Groups', fixedGroups);
  router.delete('/Groups/:id', fixedGroups);

  // ---- everything else, and body errors
  router.use((req, res) => fail(res, E.notFound('Endpoint')));
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return fail(res, E.invalidSyntax('The body is not valid JSON.'));
    if (err && err.type === 'entity.too.large') return fail(res, new E.ScimError(413, 'tooMany', 'The body is too large (256 KB at most).'));
    console.error('[SCIM] error:', err);
    return fail(res, new E.ScimError(500, null, 'The server could not do that.'));
  });

  return router;
}

// Built once, from the server's own environment, like the REST API's router.
const router = createScimRouter(process.env);
router.createScimRouter = createScimRouter;       // for tests that want their own settings
router.CONTENT_TYPE = CONTENT_TYPE;

module.exports = router;
