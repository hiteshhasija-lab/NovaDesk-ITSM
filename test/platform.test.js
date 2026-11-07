// The parts of the platform console that need no database: its settings, who may reach it, and the signed cookie.
// scripts/platform-check.js checks the console itself.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const p = require('../src/platform');

const env = { SESSION_SECRET: 'a-test-secret-that-is-long-enough-for-the-rules-1234' };

test('settings: no PLATFORM_HOST means no console; the other settings need it and go together', () => {
  assert.deepStrictEqual(p.config({}), { enabled: false, host: '', allowedIps: [], bootstrap: null, requireMfa: true });
  const c = p.config({ PLATFORM_HOST: 'OPS.Helpdesk.Example.com.', PLATFORM_ALLOWED_IPS: '10.0.0.0/8, 203.0.113.7', PLATFORM_ADMIN_USERNAME: 'Root', PLATFORM_ADMIN_PASSWORD: 'x' });
  assert.deepStrictEqual([c.enabled, c.host, c.allowedIps, c.bootstrap], [true, 'ops.helpdesk.example.com', ['10.0.0.0/8', '203.0.113.7'], { username: 'root', password: 'x' }]);
  assert.strictEqual(p.config({ PLATFORM_HOST: 'ops.example.com' }).requireMfa, true, 'two-step verification is required unless said otherwise');
  assert.strictEqual(p.config({ PLATFORM_HOST: 'ops.example.com', PLATFORM_REQUIRE_MFA: 'FALSE' }).requireMfa, false);
  assert.throws(() => p.config({ PLATFORM_HOST: 'ops.example.com', PLATFORM_REQUIRE_MFA: 'maybe' }), /true or false/);
  assert.throws(() => p.config({ PLATFORM_HOST: 'not a host' }), /host name/);
  assert.throws(() => p.config({ PLATFORM_HOST: 'ops.example.com', PLATFORM_ADMIN_USERNAME: 'a' }), /go together/);
  assert.throws(() => p.config({ PLATFORM_ADMIN_USERNAME: 'a', PLATFORM_ADMIN_PASSWORD: 'b' }), /need PLATFORM_HOST/);
  assert.throws(() => p.config({ PLATFORM_ALLOWED_IPS: '10.0.0.0/8' }), /need PLATFORM_HOST/);
  for (const bad of ['10.0.0.0/33', '10.0.0.300', 'banana', '10.0.0.0/x']) assert.throws(() => p.config({ PLATFORM_HOST: 'ops.example.com', PLATFORM_ALLOWED_IPS: bad }), /PLATFORM_ALLOWED_IPS/, bad);
});

test('who may reach the console: no list means everyone, else exact addresses or IPv4 ranges (and v4-mapped v6 addresses)', () => {
  assert.ok(p.ipAllowed('198.51.100.9', []));
  const rules = ['10.0.0.0/8', '203.0.113.7', '192.168.1.128/25', '::1'];
  for (const ok of ['10.1.2.3', '10.255.255.255', '203.0.113.7', '192.168.1.200', '::ffff:10.9.9.9', '::1']) assert.ok(p.ipAllowed(ok, rules), ok);
  for (const no of ['11.0.0.1', '203.0.113.8', '192.168.1.5', '192.168.2.200', '', undefined, '::2']) assert.ok(!p.ipAllowed(no, rules), String(no));
  assert.ok(p.ipAllowed('1.2.3.4', ['0.0.0.0/0']), '/0 is everyone');
  assert.ok(!p.ipAllowed('1.2.3.5', ['1.2.3.4/32']) && p.ipAllowed('1.2.3.4', ['1.2.3.4/32']));
});

test('the cookie: signed, expiring, and nothing else is believed', () => {
  const t = p.sign({ o: 7, e: Date.now() + 60000, c: 'tok' }, env);
  assert.deepStrictEqual(p.verify(t, env), { o: 7, e: JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString()).e, c: 'tok' });
  assert.strictEqual(p.verify(p.sign({ o: 7, e: Date.now() - 1 }, env), env), null, 'expired');
  const [body, mac] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ o: 1, e: Date.now() + 60000, c: 'tok' })).toString('base64url');
  assert.strictEqual(p.verify(`${forged}.${mac}`, env), null, 'a changed body keeps the old signature');
  assert.strictEqual(p.verify(`${body}.${mac.slice(0, -2)}AA`, env), null, 'a changed signature');
  assert.strictEqual(p.verify(t, { SESSION_SECRET: 'another-secret-that-is-long-enough-for-the-rules-99' }), null, 'another installation\'s secret');
  for (const junk of ['', 'x', 'a.b', '.', null, undefined, 'a.b.c']) assert.strictEqual(p.verify(junk, env), null, String(junk));
  assert.ok(p.same('abc', 'abc') && !p.same('abc', 'abd') && !p.same('', '') && !p.same('abc', 'abcd') && !p.same(undefined, undefined));
});

test('cookies are read from the header', () => {
  const req = { get: () => 'a=1; nd_platform=xx.yy; b=c=d' };
  assert.deepStrictEqual(p.readCookies(req), { a: '1', nd_platform: 'xx.yy', b: 'c=d' });
  assert.deepStrictEqual(p.readCookies({ get: () => undefined }), {});
});
