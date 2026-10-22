'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { createLimiter } = require('../src/rateLimit');
const { requireFields } = require('../src/validate');

function fakeRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.render = (view, locals) => { res.rendered = { view, locals }; res.emit('finish'); return res; };
  return res;
}
const attempt = (limiter, ip, status) => {
  const res = fakeRes();
  let passed = false;
  limiter({ ip }, res, () => { passed = true; });
  if (passed) { res.statusCode = status; res.emit('finish'); }
  return { passed, res };
};

test('sign-in limiter counts refused attempts only, per address', () => {
  const limiter = createLimiter({ windowMs: 60000, max: 3 });
  for (let i = 0; i < 10; i++) assert.ok(attempt(limiter, '1.1.1.1', 302).passed, 'successes are never counted');
  for (let i = 0; i < 3; i++) assert.ok(attempt(limiter, '2.2.2.2', 401).passed);
  const blocked = attempt(limiter, '2.2.2.2', 401);
  assert.strictEqual(blocked.passed, false);
  assert.strictEqual(blocked.res.statusCode, 429);
  assert.ok(blocked.res.headers['Retry-After']);
  assert.ok(attempt(limiter, '3.3.3.3', 401).passed, 'another address is not affected');
});

test('sign-up limiter counts every request when asked to', () => {
  const limiter = createLimiter({ windowMs: 60000, max: 2, countSuccess: true });
  attempt(limiter, '4.4.4.4', 302); attempt(limiter, '4.4.4.4', 302);
  assert.strictEqual(attempt(limiter, '4.4.4.4', 302).passed, false);
});

test('requireFields answers 400 naming the missing fields, and lets complete forms through', () => {
  const res = fakeRes();
  assert.strictEqual(requireFields({ body: { name: '  ' } }, res, [['name', 'Name'], ['ci_type', 'Type']]), false);
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.rendered.locals.message, /Name, Type are required/);
  assert.strictEqual(requireFields({ body: { name: 'a', ci_type: 'server' } }, fakeRes(), [['name', 'Name'], ['ci_type', 'Type']]), true);
  assert.strictEqual(requireFields({ body: { name: ['a'] } }, fakeRes(), [['name', 'Name']]), false, 'an array is not text');
});
