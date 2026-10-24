'use strict';
const test = require('node:test');
const assert = require('node:assert');
const totp = require('../src/totp');
const mfaCrypto = require('../src/mfaCrypto');

const RFC_SECRET = Buffer.from('12345678901234567890');   // the test key in RFC 6238 appendix B (SHA-1)

test('TOTP matches the RFC 6238 test vectors', () => {
  for (const [seconds, expected] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']]) {
    assert.strictEqual(totp.codeAt(RFC_SECRET, seconds * 1000, { digits: 8 }), expected, `T=${seconds}`);
  }
  assert.strictEqual(totp.codeAt(RFC_SECRET, 59 * 1000), '287082');   // the same moment, six digits as an app shows it
});

test('base32 round-trips and tolerates the spaces and dashes people type', () => {
  const key = totp.generateSecret();
  assert.match(key, /^[A-Z2-7]{32}$/);
  assert.deepStrictEqual(totp.base32Decode(totp.base32Encode(RFC_SECRET)), RFC_SECRET);
  assert.strictEqual(totp.base32Encode(RFC_SECRET), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepStrictEqual(totp.base32Decode('gezd gnbv-GY3T QOJQ GEZDGNBVGY3TQOJQ'), RFC_SECRET);
  assert.throws(() => totp.base32Decode('not*base32'), /not a base32 key/);
});

test('a code is accepted in its own step and one step either side, not further', () => {
  const key = totp.base32Encode(RFC_SECRET);
  const now = 1234567890 * 1000;
  const at = (offsetSteps) => totp.codeAt(RFC_SECRET, now + offsetSteps * 30000);
  for (const offset of [-1, 0, 1]) assert.ok(totp.verify(key, at(offset), { now }), `step ${offset}`);
  for (const offset of [-2, 2, 5]) assert.strictEqual(totp.verify(key, at(offset), { now }), null, `step ${offset}`);
});

test('a code works once: the step it matched cannot be used again', () => {
  const key = totp.base32Encode(RFC_SECRET);
  const now = 1234567890 * 1000;
  const code = totp.codeAt(RFC_SECRET, now);
  const counter = totp.verify(key, code, { now });
  assert.strictEqual(counter, totp.counterAt(now));
  assert.strictEqual(totp.verify(key, code, { now, afterCounter: counter }), null, 'replayed');
  // The next step's code is still good.
  assert.ok(totp.verify(key, totp.codeAt(RFC_SECRET, now + 30000), { now: now + 30000, afterCounter: counter }));
});

test('what is not six digits is refused without error', () => {
  const key = totp.base32Encode(RFC_SECRET);
  for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined, '12 34 5x']) assert.strictEqual(totp.verify(key, bad, { now: 0 }), null);
  assert.ok(totp.verify(key, totp.codeAt(RFC_SECRET, 59000).replace(/(\d{3})(\d{3})/, '$1 $2'), { now: 59000 }), 'spaces are ignored');
});

test('the setup link carries the key, the issuer and the account', () => {
  const uri = totp.otpauthUri({ issuer: 'NovaDesk', account: 'jane.doe@corp.local', secret: 'ABCDEFGH' });
  assert.strictEqual(uri, 'otpauth://totp/NovaDesk:jane.doe%40corp.local?secret=ABCDEFGH&issuer=NovaDesk&algorithm=SHA1&digits=6&period=30');
});

test('secrets are encrypted: round trip, a different value each time, and tampering or another key fails', () => {
  const env = { SESSION_SECRET: 'x'.repeat(40) };
  const a = mfaCrypto.encryptSecret('JBSWY3DPEHPK3PXP', env);
  const b = mfaCrypto.encryptSecret('JBSWY3DPEHPK3PXP', env);
  assert.notStrictEqual(a, b);
  assert.ok(!a.includes('JBSWY3DP'));
  assert.strictEqual(mfaCrypto.decryptSecret(a, env), 'JBSWY3DPEHPK3PXP');
  const parts = a.split(':'); parts[3] = Buffer.from('tampered').toString('base64');
  assert.throws(() => mfaCrypto.decryptSecret(parts.join(':'), env));
  assert.throws(() => mfaCrypto.decryptSecret(a, { SESSION_SECRET: 'y'.repeat(40) }), 'another key cannot read it');
  assert.strictEqual(mfaCrypto.decryptSecret(mfaCrypto.encryptSecret('K', { MFA_ENCRYPTION_KEY: 'own key', SESSION_SECRET: 'a' }), { MFA_ENCRYPTION_KEY: 'own key', SESSION_SECRET: 'b' }), 'K', 'MFA_ENCRYPTION_KEY wins over the session secret');
  assert.throws(() => mfaCrypto.decryptSecret('garbage', env), /unreadable/);
});

test('recovery codes: ten, readable, unique, matched however they are typed', () => {
  const codes = mfaCrypto.generateRecoveryCodes();
  assert.strictEqual(codes.length, 10);
  assert.strictEqual(new Set(codes).size, 10);
  for (const c of codes) assert.match(c, /^[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{4}$/);
  const code = codes[0];
  assert.strictEqual(mfaCrypto.hashRecoveryCode(code), mfaCrypto.hashRecoveryCode(code.toUpperCase().replace(/-/g, ' ')));
  assert.notStrictEqual(mfaCrypto.hashRecoveryCode(codes[0]), mfaCrypto.hashRecoveryCode(codes[1]));
  assert.match(mfaCrypto.hashRecoveryCode(code), /^[0-9a-f]{64}$/);
});

test('who must set up two-step verification, by MFA_REQUIRE', () => {
  // mfa.js needs the database module only for its rows; the policy function is pure.
  const { requiredFor } = require('../src/mfa');
  for (const [mode, admin, agent, user] of [['none', false, false, false], ['admins', true, false, false], ['all', true, true, true]]) {
    assert.deepStrictEqual(['admin', 'agent', 'user'].map((role) => requiredFor({ mfaRequire: mode }, role)), [admin, agent, user], mode);
  }
});

test('five wrong codes lock a person for ten minutes, per person, and a good sign-in clears the count', () => {
  const m = require('../src/mfa');
  const t0 = 1_000_000;
  for (let i = 1; i <= 4; i++) { assert.strictEqual(m.recordFailure(901, t0 + i), i); assert.strictEqual(m.lockedUntil(901, t0 + i), 0); }
  assert.strictEqual(m.recordFailure(901, t0 + 5), 5);
  assert.ok(m.lockedUntil(901, t0 + 6) > t0 + 6, 'locked');
  assert.strictEqual(m.lockedUntil(902, t0 + 6), 0, 'someone else is not');
  assert.strictEqual(m.lockedUntil(901, t0 + m.LOCK_MS + 10), 0, 'the lock ends');
  m.clearFailures(901);
  assert.strictEqual(m.lockedUntil(901, t0 + 6), 0);
});
