// How a tenant's mail settings are checked on the way in (no database, no network: hosts are IP literals).
// scripts/tenant-mail-check.js checks the whole thing against real SMTP servers.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const m = require('../src/mailSettings');

const ok = { enabled: 'on', host: '1.1.1.1', port: '587', username: ' bot ', password: 'pw', from_address: ' Acme Help <help@acme.example> ', reply_to: 'help@acme.example', tls_verify: 'on' };
const bad = (over, re, existing = null) => assert.rejects(() => m.validate({ ...ok, ...over }, existing), re);

test('a good form is tidied', async () => {
  const v = await m.validate(ok, null);
  assert.deepStrictEqual([v.enabled, v.host, v.port, v.user, v.pass, v.from, v.replyTo, v.secure, v.tlsVerify], [true, '1.1.1.1', 587, 'bot', 'pw', 'Acme Help <help@acme.example>', 'help@acme.example', false, true]);
});

test('a ticked box sends "on", an unticked one nothing: so an unticked certificate check is off, and says so', async () => {
  assert.strictEqual((await m.validate({ ...ok, tls_verify: undefined }, null)).tlsVerify, false);
  assert.strictEqual((await m.validate({ ...ok, secure: 'on' }, null)).secure, true);
});

test('every refusal says what to change', async () => {
  await bad({ host: '' }, /host name/);
  await bad({ host: 'not a host!' }, /host name/);
  await bad({ port: 'x' }, /port must be a number/);
  await bad({ port: '22' }, /one of 25, 465, 587, 2525/);
  await bad({ port: '6379' }, /one of 25/);
  for (const inside of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.169.254', '::1', '0.0.0.0']) await bad({ host: inside }, /private, local or reserved/);
  await bad({ username: '' }, /go together/);
  await bad({ password: '' }, /go together/);
  await bad({ from_address: 'nobody' }, /sender address/);
  await bad({ reply_to: 'nobody' }, /reply-to/);
  await bad({ from_address: 'x'.repeat(201) + '@a.example' }, /too long/);
});

test('a saved password may be left blank; no user name and no password is fine; switched off needs nothing', async () => {
  assert.strictEqual((await m.validate({ ...ok, password: '' }, { password_enc: 'v1:x' })).pass, null);
  const relay = await m.validate({ ...ok, username: '', password: '' }, null);
  assert.deepStrictEqual([relay.user, relay.pass, relay.clearPassword], [null, null, true]);
  const off = await m.validate({ host: '', from_address: '' }, null);
  assert.deepStrictEqual([off.enabled, off.host, off.from], [false, null, null]);
  await assert.rejects(() => m.validate({ host: '127.0.0.1' }, null), /private, local or reserved/, 'an address is checked even when it is switched off');
});

test('the sender address is found inside a display name, and header injection is cut', async () => {
  assert.strictEqual(m.address('Acme <a@b.example>'), 'a@b.example');
  assert.strictEqual(m.address('plain@b.example'), 'plain@b.example');
  assert.strictEqual(m.address('nobody'), null);
  const v = await m.validate({ ...ok, from_address: 'Evil <e@b.example>\r\nBcc: x@y.example' }, null);
  assert.ok(!/[\r\n]/.test(v.from), 'no line breaks in the sender');
});
