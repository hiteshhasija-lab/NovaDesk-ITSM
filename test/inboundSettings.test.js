// How a tenant's inbound mail settings are checked on the way in (no database, no network: hosts are IP literals), and how a token is read.
// scripts/tenant-inbound-check.js checks the whole thing.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const s = require('../src/inboundSettings');

const ok = { enabled: 'on', host: '1.1.1.1', port: '993', user: ' help@x.example ', password: 'pw', secure: 'on', tls_verify: 'on', poll_seconds: '30', address: 'Help@X.example', unknown_senders: 'ignore', allowed_domains: 'A.com, b.org', blocked_senders: 'spam.test, bad@x.test', max_per_sender_hour: '5', assignment_group: 'IRO-ServiceDesk', require_auth: 'on' };
const bad = (over, re, existing = null) => assert.rejects(() => s.validate({ ...ok, ...over }, existing), re);

test('a good form is tidied', async () => {
  const v = await s.validate(ok, null);
  assert.deepStrictEqual([v.enabled, v.host, v.port, v.user, v.pass, v.secure, v.tlsVerify, v.poll, v.address, v.unknown, v.domains, v.blocked, v.max, v.group, v.requireAuth],
    [true, '1.1.1.1', 993, 'help@x.example', 'pw', true, true, 30, 'help@x.example', 'ignore', 'a.com, b.org', 'spam.test, bad@x.test', 5, 'IRO-ServiceDesk', true]);
});

test('every refusal says what to change', async () => {
  await bad({ host: '' }, /host name/);
  await bad({ port: 'x' }, /port must be a number/);
  await bad({ port: '22' }, /must be 143 or 993/);
  await bad({ port: '25' }, /must be 143 or 993/);
  for (const inside of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.169.254', '::1']) await bad({ host: inside }, /private, local or reserved/);
  await bad({ user: '' }, /user name and password/);
  await bad({ password: '' }, /user name and password/);
  await bad({ poll_seconds: '5' }, /10 to 3600/);
  await bad({ poll_seconds: '99999' }, /10 to 3600/);
  await bad({ address: 'nobody' }, /email address/);
  await bad({ unknown_senders: 'maybe' }, /Choose what to do/);
  await bad({ allowed_domains: 'nope' }, /not an email domain/);
  await bad({ max_per_sender_hour: '-1' }, /from 0/);
  await bad({ max_per_sender_hour: '10001' }, /from 0/);
  await bad({ assignment_group: 'Everyone' }, /assignment groups/);
  await bad({ folder: 'x'.repeat(101) }, /too long/);
});

test('a saved password may be left blank; switched off needs nothing; defaults apply to an empty form', async () => {
  assert.strictEqual((await s.validate({ ...ok, password: '' }, { imap_password_enc: 'v1:x' })).pass, null);
  const off = await s.validate({}, null);
  assert.deepStrictEqual([off.enabled, off.host, off.poll, off.unknown, off.max, off.requireAuth, off.group], [false, null, 60, 'create', 10, false, null]);
  await assert.rejects(() => s.validate({ host: '127.0.0.1' }, null), /private, local or reserved/, 'an address is checked even when it is switched off');
});

test('a token is recognised by its shape, and only a hash of it is ever compared', async () => {
  assert.strictEqual(await s.tenantOfToken('nope'), null);
  assert.strictEqual(await s.tenantOfToken(`ndi_${'x'.repeat(39)}`), null, 'one character short');
  assert.strictEqual(await s.tenantOfToken(''), null);
  assert.match(s.hashToken('a'), /^[0-9a-f]{64}$/);
  assert.notStrictEqual(s.hashToken('a'), s.hashToken('b'));
});
