'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { verifyIdToken, TokenError } = require('../src/jwt');
const { oidcConfig, authPolicy } = require('../src/settings');

const ISS = 'https://login.example.com/tenant-1/v2.0';
const AUD = 'novadesk-client';
const NOW = 1_800_000_000_000;
const b64u = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwkOf = (pair, extra) => ({ ...pair.publicKey.export({ format: 'jwk' }), ...extra });
const jwks = { keys: [jwkOf(rsa, { kid: 'rsa-1', use: 'sig', alg: 'RS256' }), jwkOf(ec, { kid: 'ec-1', use: 'sig' })] };

function sign(claims, { alg = 'RS256', kid = 'rsa-1', key = rsa.privateKey } = {}) {
  const head = b64u({ alg, kid, typ: 'JWT' });
  const body = b64u(claims);
  const data = Buffer.from(`${head}.${body}`);
  const sig = alg === 'ES256' ? crypto.sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' }) : crypto.sign('sha256', data, key);
  return `${head}.${body}.${sig.toString('base64url')}`;
}
const good = (over = {}) => ({ iss: ISS, aud: AUD, sub: 'user-42', exp: NOW / 1000 + 600, iat: NOW / 1000 - 5, nonce: 'n-1', email: 'jane@corp.example', ...over });
const check = (token, over = {}) => verifyIdToken(token, { jwks, issuer: ISS, clientId: AUD, nonce: 'n-1', now: NOW, ...over });
const refused = (token, pattern, over) => assert.throws(() => check(token, over), (e) => e instanceof TokenError && pattern.test(e.message), `expected ${pattern}`);

test('a correctly signed token from the right provider for this application is accepted (RS256 and ES256)', () => {
  assert.strictEqual(check(sign(good())).sub, 'user-42');
  assert.strictEqual(check(sign(good(), { alg: 'ES256', kid: 'ec-1', key: ec.privateKey })).email, 'jane@corp.example');
});

test('a token without a kid works when the key set has exactly one fitting key', () => {
  const single = { keys: [jwkOf(rsa, { use: 'sig' })] };
  const head = b64u({ alg: 'RS256' }); const body = b64u(good());
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), rsa.privateKey).toString('base64url');
  assert.ok(verifyIdToken(`${head}.${body}.${sig}`, { jwks: single, issuer: ISS, clientId: AUD, nonce: 'n-1', now: NOW }));
  assert.throws(() => verifyIdToken(`${head}.${body}.${sig}`, { jwks: { keys: [jwkOf(rsa), jwkOf(rsa)] }, issuer: ISS, clientId: AUD, nonce: 'n-1', now: NOW }), (e) => e.code === 'unknown_kid');
});

test('tampering, the wrong key and unsigned tokens are refused', () => {
  const token = sign(good());
  const [h, , s] = token.split('.');
  refused(`${h}.${b64u(good({ sub: 'someone-else' }))}.${s}`, /signature is not valid/);
  refused(sign(good(), { key: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }), /signature is not valid/);
  refused(`${b64u({ alg: 'none' })}.${b64u(good())}.`, /signature type/);
  refused(`${b64u({ alg: 'RS256', kid: 'rsa-1' })}.${b64u(good())}.`, /signature is not valid/);
});

test('key confusion does not work: an HS256 token "signed" with the public key is refused', () => {
  const secret = JSON.stringify(jwks.keys[0]);
  const head = b64u({ alg: 'HS256', kid: 'rsa-1' }); const body = b64u(good());
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  refused(`${head}.${body}.${sig}`, /signature type/);
});

test('an unknown key id asks for a refetch of the key set', () => {
  assert.throws(() => check(sign(good(), { kid: 'rotated-2' })), (e) => e.code === 'unknown_kid');
});

test('the claims must tie the token to this provider, this application, this moment and this attempt', () => {
  refused(sign(good({ iss: 'https://evil.example.com' })), /different identity provider/);
  refused(sign(good({ iss: `${ISS}/` })), /different identity provider/);
  refused(sign(good({ aud: 'someone-elses-app' })), /different application/);
  refused(sign(good({ aud: ['other', AUD] })), /different application/);
  assert.ok(check(sign(good({ aud: ['other', AUD], azp: AUD }))));
  assert.ok(check(sign(good({ aud: [AUD] }))));
  refused(sign(good({ exp: NOW / 1000 - 120 })), /expired/);
  assert.ok(check(sign(good({ exp: NOW / 1000 - 30 }))), 'a little clock skew is forgiven');
  refused(sign(good({ exp: undefined })), /expired/);
  refused(sign(good({ iat: NOW / 1000 + 3600 })), /future/);
  refused(sign(good({ nbf: NOW / 1000 + 3600 })), /not valid yet/);
  refused(sign(good({ nonce: 'replayed' })), /does not belong to this sign-in/);
  refused(sign(good({ nonce: undefined })), /does not belong to this sign-in/);
  refused(sign(good({ sub: '' })), /no subject/);
  refused(sign(good({ sub: undefined })), /no subject/);
});

test('garbage is a clear error, not a crash', () => {
  for (const bad of ['', 'abc', 'a.b', 'a.b.c.d', null, undefined, '!!!.###.$$$', `${b64u('not json')}.${b64u('x')}.${b64u('y')}`]) {
    assert.throws(() => check(bad), (e) => e instanceof TokenError);
  }
});

test('a key that is not for signing, or of another type, is not used', () => {
  const encOnly = { keys: [jwkOf(rsa, { kid: 'rsa-1', use: 'enc' })] };
  assert.throws(() => verifyIdToken(sign(good()), { jwks: encOnly, issuer: ISS, clientId: AUD, nonce: 'n-1', now: NOW }), (e) => e.code === 'unknown_kid');
  const wrongAlg = { keys: [jwkOf(rsa, { kid: 'rsa-1', use: 'sig', alg: 'RS512' })] };
  assert.throws(() => verifyIdToken(sign(good()), { jwks: wrongAlg, issuer: ISS, clientId: AUD, nonce: 'n-1', now: NOW }), (e) => e.code === 'unknown_kid');
});

// ---------------------------------------------------------------- settings
const base = { OIDC_ISSUER: 'https://login.example.com/t/v2.0/', OIDC_CLIENT_ID: 'id', OIDC_CLIENT_SECRET: 'secret', PUBLIC_URL: 'https://help.example.com/' };

test('single sign-on is off unless all of its settings are given', () => {
  assert.deepStrictEqual(oidcConfig({}), { enabled: false });
  for (const missing of ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'PUBLIC_URL']) {
    const env = { ...base }; delete env[missing];
    assert.throws(() => oidcConfig(env), new RegExp(`needs ${missing}`), missing);
  }
});

test('single sign-on settings: normalised, and the risky choices are refused', () => {
  const c = oidcConfig({ ...base, OIDC_ALLOWED_DOMAINS: 'Corp.Example, partner.example', OIDC_AUTO_CREATE: 'true', OIDC_BUTTON_LABEL: 'Sign in with Microsoft' });
  assert.deepStrictEqual([c.issuer, c.redirectUri, c.autoCreate, c.trustEmail, c.defaultRole, c.allowedDomains, c.scopes, c.buttonLabel],
    ['https://login.example.com/t/v2.0', 'https://help.example.com/auth/oidc/callback', true, false, 'user', ['corp.example', 'partner.example'], ['openid', 'email', 'profile'], 'Sign in with Microsoft']);
  assert.throws(() => oidcConfig({ ...base, OIDC_ISSUER: 'http://login.example.com' }), /https/);
  assert.throws(() => oidcConfig({ ...base, PUBLIC_URL: 'http://help.example.com' }), /https/);
  assert.ok(oidcConfig({ ...base, OIDC_ISSUER: 'http://127.0.0.1:9999', PUBLIC_URL: 'http://localhost:8080' }).enabled, 'plain http only for localhost');
  assert.throws(() => oidcConfig({ ...base, OIDC_ISSUER: 'not a url' }), /web address/);
  assert.throws(() => oidcConfig({ ...base, OIDC_DEFAULT_ROLE: 'admin' }), /never created/);
  assert.strictEqual(oidcConfig({ ...base, OIDC_DEFAULT_ROLE: 'agent' }).defaultRole, 'agent');
});

test('hiding the password form needs single sign-on; two-step requirement must be a known value', () => {
  assert.deepStrictEqual(authPolicy({}), { oidc: { enabled: false }, localLogin: true, mfaRequire: 'none' });
  assert.throws(() => authPolicy({ LOCAL_LOGIN: 'false' }), /nobody could sign in/);
  assert.strictEqual(authPolicy({ ...base, LOCAL_LOGIN: 'false' }).localLogin, false);
  assert.strictEqual(authPolicy({ MFA_REQUIRE: 'Admins' }).mfaRequire, 'admins');
  assert.throws(() => authPolicy({ MFA_REQUIRE: 'sometimes' }), /none, admins or all/);
});
