'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseFields, ApiError } = require('../src/api/core');
const { SHAPES, RESPONSES, buildOpenApi } = require('../src/api/spec');
const apiKeys = require('../src/apiKeys');
const { createWindowCounter } = require('../src/rateLimit');
const { trustProxy, rateLimits } = require('../src/settings');

const fails = (fn, field, pattern) => assert.throws(fn, (e) => e instanceof ApiError && e.status === 400 && e.details.some((d) => d.field === field && pattern.test(d.message)), `${field} ${pattern}`);

test('input is checked field by field, and says which field is wrong', () => {
  const schema = {
    title: { type: 'string', max: 10, required: true }, n: { type: 'integer', min: 1, max: 3 }, kind: { type: 'enum', values: ['a', 'b'] },
    flag: { type: 'boolean' }, when: { type: 'date', nullable: true }, note: { type: 'string', nullable: true },
  };
  assert.deepStrictEqual(parseFields(schema, { title: 'hi', n: 2, kind: 'a', flag: true, when: '2026-12-31', note: null }), { title: 'hi', n: 2, kind: 'a', flag: true, when: '2026-12-31', note: null });
  fails(() => parseFields(schema, {}), 'title', /required/);
  fails(() => parseFields(schema, { title: 'x'.repeat(11) }), 'title', /at most 10/);
  fails(() => parseFields(schema, { title: 5 }), 'title', /must be a string/);
  fails(() => parseFields(schema, { title: '   ' }), 'title', /blank/);
  fails(() => parseFields(schema, { title: 'a', n: 4 }), 'n', /between/);
  fails(() => parseFields(schema, { title: 'a', n: 1.5 }), 'n', /whole number/);
  fails(() => parseFields(schema, { title: 'a', kind: 'c' }), 'kind', /one of: a, b/);
  fails(() => parseFields(schema, { title: 'a', flag: 'yes' }), 'flag', /true or false/);
  fails(() => parseFields(schema, { title: 'a', when: '2026-02-31' }), 'when', /date like/);
  fails(() => parseFields(schema, { title: 'a', typo: 1 }), 'typo', /not a known field/);
  fails(() => parseFields(schema, { title: null }), 'title', /required/);
  assert.strictEqual(parseFields(schema, { title: 'a', n: '2' }).n, 2, 'a numeric string is accepted for a number (query strings)');
  assert.throws(() => parseFields(schema, [1]), (e) => e.status === 400 && /JSON object/.test(e.message));
  assert.throws(() => parseFields(schema, 'text'), (e) => e.status === 400);
});

test('a change may be partial; every problem is reported at once; an empty query value is ignored', () => {
  const schema = { title: { type: 'string', required: true }, n: { type: 'integer' } };
  assert.deepStrictEqual(parseFields(schema, { n: 2 }, { partial: true }), { n: 2 });
  assert.throws(() => parseFields(schema, { n: 'x', other: 1 }), (e) => e.details.length === 3);
  assert.deepStrictEqual(parseFields({ q: { type: 'string', max: 5 }, n: { type: 'integer' } }, { q: '', n: '4' }, { partial: true, where: 'query' }), { n: 4 });
});

test('an API key looks like ndk_ plus 40 characters, is stored as a hash, and is recognised or refused by shape', () => {
  const t = apiKeys.newToken();
  assert.match(t, /^ndk_[A-Za-z0-9_-]{40}$/);
  assert.ok(apiKeys.looksLikeToken(t));
  assert.notStrictEqual(t, apiKeys.newToken());
  assert.match(apiKeys.hashToken(t), /^[0-9a-f]{64}$/);
  assert.ok(!apiKeys.hashToken(t).includes(t.slice(4, 12)));
  for (const bad of ['', 'ndk_short', `ndk_${'a'.repeat(41)}`, `xyz_${'a'.repeat(40)}`, null, undefined, `ndk_${'!'.repeat(40)}`]) assert.ok(!apiKeys.looksLikeToken(bad), String(bad));
  assert.strictEqual(apiKeys.expiryFrom(0), null);
  assert.strictEqual(apiKeys.expiryFrom(30, Date.UTC(2026, 0, 1)), '2026-01-31 00:00:00');
});

test('the rate counter counts per key, resets with the window, reports what is left, and 0 means no limit', () => {
  const c = createWindowCounter({ windowMs: 60000, max: 3 });
  const t0 = 1_000_000;
  assert.deepStrictEqual([1, 2, 3].map((i) => c.hit('a', t0 + i).remaining), [2, 1, 0]);
  const over = c.hit('a', t0 + 10);
  assert.deepStrictEqual([over.allowed, over.limit, over.remaining], [false, 3, 0]);
  assert.ok(over.resetSeconds >= 1 && over.resetSeconds <= 60);
  assert.ok(c.hit('b', t0 + 10).allowed, 'another key has its own allowance');
  assert.ok(c.hit('a', t0 + 60001).allowed, 'a new window starts');
  assert.ok(createWindowCounter({ windowMs: 1000, max: 0 }).hit('x').allowed);
});

test('proxy and limit settings', () => {
  assert.strictEqual(trustProxy({}), false);
  assert.strictEqual(trustProxy({ TRUST_PROXY: '2' }), 2);
  assert.strictEqual(trustProxy({ TRUST_PROXY: 'loopback' }), 'loopback');
  assert.throws(() => trustProxy({ TRUST_PROXY: 'true' }), /believe any address/);
  assert.deepStrictEqual(rateLimits({}), { ipPerMinute: 1200, apiPerMinute: 300, apiWritePerMinute: 60 });
  assert.deepStrictEqual(rateLimits({ RATE_LIMIT_IP_PER_MIN: '0', RATE_LIMIT_API_PER_MIN: '10', RATE_LIMIT_API_WRITE_PER_MIN: '5' }), { ipPerMinute: 0, apiPerMinute: 10, apiWritePerMinute: 5 });
  assert.throws(() => rateLimits({ RATE_LIMIT_API_PER_MIN: 'many' }), /RATE_LIMIT_API_PER_MIN/);
  assert.throws(() => rateLimits({ RATE_LIMIT_IP_PER_MIN: '-1' }), /RATE_LIMIT_IP_PER_MIN/);
});

// ---------------------------------------------------------------- the documentation matches the code
const { routes } = require('../src/api');
const spec = buildOpenApi(routes);

test('every API route is documented with a summary, a tag, a scope and a known response', () => {
  const seen = new Set();
  for (const r of routes) {
    const id = `${r.method} ${r.path}`;
    assert.ok(!seen.has(id), `${id} is registered twice`); seen.add(id);
    assert.ok(r.summary && r.tag, `${id} has a summary and a tag`);
    assert.ok(['read', 'write'].includes(r.scope), `${id} has a scope`);
    assert.ok(RESPONSES[r.response], `${id} names a response shape that exists (${r.response})`);
    assert.strictEqual(r.method === 'GET', r.scope === 'read', `${id}: reads use GET, writes do not`);
    if (r.method === 'POST') assert.strictEqual(r.status, 201, `${id} answers 201`);
    if (['POST', 'PATCH'].includes(r.method)) assert.ok(r.body, `${id} documents its body`);
  }
  assert.ok(routes.length >= 20);
});

test('the OpenAPI document is complete: every $ref resolves, every route is in it, every path parameter is declared', () => {
  const text = JSON.stringify(spec);
  for (const m of text.matchAll(/"\$ref":"#\/components\/schemas\/(\w+)"/g)) assert.ok(spec.components.schemas[m[1]], `missing schema ${m[1]}`);
  for (const r of routes) {
    const path = r.path.replace(/:(\w+)/g, '{$1}');
    const op = spec.paths[path] && spec.paths[path][r.method.toLowerCase()];
    assert.ok(op, `${r.method} ${path} is in the document`);
    for (const p of r.path.match(/:(\w+)/g) || []) assert.ok(op.parameters.some((x) => x.name === p.slice(1) && x.in === 'path'), `${path} declares ${p}`);
  }
  assert.strictEqual(spec.openapi, '3.0.3');
  assert.ok(spec.components.securitySchemes.bearerKey);
  for (const [name, shape] of Object.entries(SHAPES)) assert.deepStrictEqual(spec.components.schemas[name].required, Object.keys(shape), name);
});

test('writes that create something say so, and nothing in the API can delete', () => {
  assert.ok(!routes.some((r) => r.method === 'DELETE'), 'no DELETE routes in v1');
  assert.deepStrictEqual(routes.filter((r) => r.scope === 'write').map((r) => `${r.method} ${r.path}`).sort(),
    ['PATCH /cis/:id', 'PATCH /incidents/:id', 'PATCH /requests/:id', 'POST /cis', 'POST /incidents', 'POST /incidents/:id/comments', 'POST /requests']);
});
