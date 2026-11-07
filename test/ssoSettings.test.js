// How a tenant's single sign-on settings are checked on the way in (no database, no network: addresses are IP literals).
// scripts/tenant-sso-check.js checks the whole thing against a provider.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const s = require('../src/ssoSettings');

const ok = { enabled: 'on', issuer: 'https://1.1.1.1/', client_id: ' abc ', client_secret: 'sec', button_label: '  Sign   in  ', scopes: 'OpenID  email', default_role: 'agent', allowed_domains: 'Example.com, corp.example.org', auto_create: 'on' };
const bad = (over, re) => assert.rejects(() => s.validate({ ...ok, ...over }, null), re);

test('a good form is tidied: issuer without a trailing slash, lower-case lists, a label with single spaces', async () => {
  const v = await s.validate(ok, null);
  assert.deepStrictEqual([v.enabled, v.issuer, v.clientId, v.secret, v.label, v.scopes, v.role, v.domains, v.autoCreate, v.trustEmail],
    [true, 'https://1.1.1.1', 'abc', 'sec', 'Sign in', 'openid email', 'agent', 'example.com, corp.example.org', true, false]);
});

test('every refusal says what to change', async () => {
  await bad({ issuer: '' }, /issuer address/);
  await bad({ client_id: '  ' }, /client ID/);
  await bad({ client_secret: '' }, /client secret/);
  await bad({ default_role: 'admin' }, /never administrators/);
  await bad({ scopes: 'email' }, /openid/);
  await bad({ allowed_domains: 'nope' }, /not an email domain/);
  await bad({ issuer: 'http://1.1.1.1' }, /https/);
  await bad({ issuer: 'https://u:p@1.1.1.1' }, /user name or password/);
  for (const inside of ['https://127.0.0.1', 'https://10.1.2.3', 'https://192.168.0.9', 'https://169.254.169.254', 'https://[::1]', 'https://0.0.0.0']) await bad({ issuer: inside }, /private, local or reserved/);
  await bad({ client_id: 'x'.repeat(201) }, /too long/);
});

test('a saved secret may be left blank, and a form that is switched off needs nothing but is still checked when it names an address', async () => {
  const v = await s.validate({ ...ok, client_secret: '' }, { client_secret_enc: 'v1:x:y:z' });
  assert.strictEqual(v.secret, null, 'blank keeps the saved one');
  const off = await s.validate({ enabled: undefined, issuer: '', client_id: '', client_secret: '' }, null);
  assert.deepStrictEqual([off.enabled, off.issuer, off.clientId, off.scopes, off.role], [false, null, null, 'openid email profile', 'user']);
  await assert.rejects(() => s.validate({ issuer: 'https://127.0.0.1' }, null), /private, local or reserved/);
});

test('lists are read the way people write them', () => {
  assert.deepStrictEqual(s.parseList('A.com, b.org\nc.net  ;d'.replace(';', ' ')), ['a.com', 'b.org', 'c.net', 'd']);
  assert.deepStrictEqual(s.parseList(''), []);
  assert.deepStrictEqual(s.parseList(undefined), []);
});
