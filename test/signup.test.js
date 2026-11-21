// Self-service sign-up without a database: what the settings must satisfy, the form's time-trap, and what a request must say (src/signup.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const signup = require('../src/signup');

const base = { SIGNUP_HOST: 'signup.helpdesk.example.com', TENANT_BASE_DOMAIN: 'helpdesk.example.com', SMTP_HOST: 'mail.example.com', SESSION_SECRET: 'a-test-secret-that-is-long-enough-1234567890' };

test('without SIGNUP_HOST there is no sign-up, and with it the settings must fit together', () => {
  assert.strictEqual(signup.config({}).enabled, false);
  const c = signup.config(base);
  assert.strictEqual(c.enabled, true); assert.strictEqual(c.scheme, 'https'); assert.strictEqual(c.approval, false);
  assert.deepStrictEqual(c.limits, { users: 5, records: 500, storageMb: 50 });
  assert.throws(() => signup.config({ ...base, TENANT_BASE_DOMAIN: '' }), /needs TENANT_BASE_DOMAIN/);
  assert.throws(() => signup.config({ ...base, SMTP_HOST: '' }), /needs SMTP_HOST/);
  assert.throws(() => signup.config({ ...base, PLATFORM_HOST: base.SIGNUP_HOST }), /different host names/);
  assert.throws(() => signup.config({ ...base, SIGNUP_HOST: 'helpdesk.example.com' }), /base domain itself/);
  assert.throws(() => signup.config({ ...base, SIGNUP_HOST: 'not a host' }), /host name/);
  assert.throws(() => signup.config({ ...base, SIGNUP_MAX_PER_DAY: 'many' }), /SIGNUP_MAX_PER_DAY/);
  assert.throws(() => signup.config({ ...base, SIGNUP_REQUIRE_APPROVAL: 'maybe' }), /true or false/);
  assert.throws(() => signup.config({ ...base, SIGNUP_BLOCKED_DOMAINS: 'localhost' }), /not a domain name/);
  assert.throws(() => signup.config({ ...base, SIGNUP_TERMS_URL: 'javascript:alert(1)' }), /https/);
  assert.throws(() => signup.config({ ...base, SIGNUP_SCHEME: 'ftp' }), /https or http/);
  assert.throws(() => signup.config({ ...base, SIGNUP_LIMIT_USERS: '-1' }), /SIGNUP_LIMIT_USERS/);
});

test('the limits a new workspace starts with: a number, "none" or empty for no limit, 0 allowed', () => {
  assert.deepStrictEqual(signup.config({ ...base, SIGNUP_LIMIT_USERS: 'none', SIGNUP_LIMIT_RECORDS: '', SIGNUP_LIMIT_STORAGE_MB: '0' }).limits, { users: null, records: null, storageMb: 0 });
  assert.deepStrictEqual(signup.config({ ...base, SIGNUP_ALLOWED_DOMAINS: '@Example.com, corp.example.org' }).allowed, ['example.com', 'corp.example.org']);
});

test('the form token: too quick, too old, forged and changed are all refused; a person who takes a minute is fine', () => {
  const env = base; const now = 1_800_000_000_000;
  const t = signup.formToken(env, now);
  assert.strictEqual(signup.checkFormToken(env, t, now + 20000), null);
  assert.strictEqual(signup.checkFormToken(env, t, now + 3 * 60 * 60 * 1000) !== null, true, 'older than two hours');
  assert.match(signup.checkFormToken(env, t, now + 500), /very quick/);
  assert.notStrictEqual(signup.checkFormToken(env, 'x.y', now + 20000), null);
  assert.notStrictEqual(signup.checkFormToken(env, '', now + 20000), null);
  assert.notStrictEqual(signup.checkFormToken(env, t.replace(/.$/, 'A'), now + 20000), null, 'a changed signature');
  assert.notStrictEqual(signup.checkFormToken(env, `${now - 100000}.${t.split('.')[1]}`, now + 20000), null, 'a time that was not the one signed');
  assert.notStrictEqual(signup.checkFormToken({ ...env, SESSION_SECRET: 'another-secret-another-secret-123456789' }, t, now + 20000), null, 'signed by another installation');
});

test('what a request must say: every field, with a sentence for each fault', () => {
  const cfg = signup.config({ ...base, SIGNUP_BLOCKED_DOMAINS: 'mailinator.com', SIGNUP_TERMS_URL: 'https://example.com/terms' });
  const good = { org_name: 'Acme  Corp', slug: 'Acme-Corp', admin_name: 'Ann  Admin', email: 'ann@acme.example', username: 'ann', password: 'Granite-Falcon-93k', password2: 'Granite-Falcon-93k', terms: 'on' };
  const ok = signup.checkRequest(cfg, good);
  assert.deepStrictEqual(ok.value && [ok.value.orgName, ok.value.slug, ok.value.adminName, ok.value.username], ['Acme Corp', 'acme-corp', 'Ann Admin', 'ann'], 'spaces tidied and the short name in lower case');
  const bad = (change, pattern) => { const r = signup.checkRequest(cfg, { ...good, ...change }); assert.ok(r.error, JSON.stringify(change)); assert.match(r.error, pattern, JSON.stringify(change)); };
  bad({ org_name: '' }, /name of your organisation/);
  bad({ org_name: 'x'.repeat(81) }, /name of your organisation/);
  bad({ slug: 'a_b' }, /short name/);
  bad({ slug: 'www' }, /kept for the system/);
  bad({ slug: 'signup' }, /kept for the system/);
  bad({ admin_name: '' }, /your name/i);
  bad({ email: 'not-an-email' }, /email address/);
  bad({ email: 'a b@c.example' }, /email address/);
  bad({ email: 'ann@mailinator.com' }, /cannot be used/);
  bad({ email: 'ann@sub.mailinator.com' }, /cannot be used/);
  bad({ username: 'a' }, /username/);
  bad({ username: 'has space' }, /username/);
  bad({ password: 'short', password2: 'short' }, /./);
  bad({ password2: 'Something-Else-93k' }, /not the same/);
  bad({ terms: undefined }, /accept the terms/);
  const closed = signup.config({ ...base, SIGNUP_ALLOWED_DOMAINS: 'acme.example' });
  assert.ok(signup.checkRequest(closed, good).value);
  assert.match(signup.checkRequest(closed, { ...good, email: 'ann@other.example' }).error, /certain email domains/);
  assert.ok(signup.checkRequest(closed, { ...good, email: 'ann@mail.acme.example' }).value, 'a sub-domain of an allowed domain');
});

test('tokens: long, random, only a hash is ever stored, and the shape is checked before the database is asked', () => {
  const a = signup.newToken(); const b = signup.newToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/); assert.notStrictEqual(a, b);
  assert.match(signup.sha(a), /^[0-9a-f]{64}$/); assert.notStrictEqual(signup.sha(a), a);
  assert.strictEqual(signup.urlFor({ scheme: 'https', base: 'helpdesk.example.com' }, 'acme'), 'https://acme.helpdesk.example.com');
});
