'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { checkPassword, minLength, verifyPassword, hashPassword, verifyAgainstNobody, MAX_BYTES } = require('../src/passwords');
const { securitySettings, seedPlan } = require('../src/settings');
const csrf = require('../src/csrf');
const { isLocked } = require('../src/lockout');

test('passwords: length, no repeats, no common passwords, not the person\'s own name', () => {
  assert.strictEqual(checkPassword('correct horse battery staple'), null);
  assert.strictEqual(checkPassword('Orbit-Lantern-42x'), null);
  assert.match(checkPassword('short'), /at least 10 characters/);
  assert.match(checkPassword('aaaaaaaaaaaa'), /one character repeated/);
  for (const common of ['password123', 'Password1!', 'qwertyuiop', 'administrator', 'Welcome123!', 'novadesk123', '1234567890', 'iloveyou99', 'Letmein2026!!']) {
    assert.match(checkPassword(common) || '', /first ones attackers try/, common);
  }
  assert.match(checkPassword('jdoe-secret-pass-9', { username: 'jdoe-secret' }), /cannot contain your name/);
  assert.match(checkPassword('Maria-loves-tea-77', { fullName: 'Maria Chen' }), /cannot contain your name/);
  assert.match(checkPassword('xx-chen.lee-pass-1', { email: 'chen.lee@corp.local' }), /cannot contain your name/);
  assert.strictEqual(checkPassword('Bob-and-tea-77-xyz', { fullName: 'Bob Li' }), null, 'a short name part (under 4 letters) is not matched');
  assert.strictEqual(checkPassword(undefined), 'The password must be at least 10 characters long.');
});

test('passwords: the hashing method reads only 72 bytes, so a longer password is refused rather than silently cut', () => {
  assert.strictEqual(MAX_BYTES, 72);
  assert.strictEqual(checkPassword('Ab1-'.repeat(18)), null);                    // exactly 72
  assert.match(checkPassword('Ab1-'.repeat(18) + 'x'), /too long.*72/);
  assert.match(checkPassword('é'.repeat(40) + '-Kz9'), /too long/, 'bytes, not characters');
});

test('passwords: the minimum can be raised or lowered within 8 to 64, nothing else', () => {
  assert.strictEqual(minLength({}), 10);
  assert.strictEqual(minLength({ PASSWORD_MIN_LENGTH: '14' }), 14);
  assert.strictEqual(checkPassword('Orbit-Lantern-42x', {}, { PASSWORD_MIN_LENGTH: '20' }), 'The password must be at least 20 characters long.');
  for (const bad of ['7', '65', 'x', '9.5']) assert.throws(() => securitySettings({ PASSWORD_MIN_LENGTH: bad }), /PASSWORD_MIN_LENGTH must be a whole number from 8 to 64/);
});

test('lockout settings: 10 wrong passwords lock for 15 minutes by default; 0 turns it off; nonsense is refused', () => {
  assert.deepStrictEqual(securitySettings({}), { passwordMinLength: 10, lockoutAfter: 10, lockoutMinutes: 15 });
  assert.deepStrictEqual(securitySettings({ LOCKOUT_AFTER: '0', LOCKOUT_MINUTES: '60' }), { passwordMinLength: 10, lockoutAfter: 0, lockoutMinutes: 60 });
  assert.throws(() => securitySettings({ LOCKOUT_AFTER: '-1' }), /LOCKOUT_AFTER/);
  assert.throws(() => securitySettings({ LOCKOUT_MINUTES: '0' }), /LOCKOUT_MINUTES/);
});

test('the first administrator\'s password has to meet the minimum length too', () => {
  assert.deepStrictEqual(seedPlan({ ADMIN_USERNAME: 'a', ADMIN_PASSWORD: 'short-pw' }, 0), { action: 'none', problem: 'ADMIN_PASSWORD must be at least 10 characters.' });
  assert.strictEqual(seedPlan({ ADMIN_USERNAME: 'a', ADMIN_PASSWORD: 'Orbit-Lantern-42x' }, 0).action, 'admin');
});

test('a lock is in force until its time has passed', () => {
  assert.ok(!isLocked({ locked_until: null }));
  assert.ok(isLocked({ locked_until: '2030-01-01 00:00:00' }, Date.UTC(2029, 11, 31)));
  assert.ok(!isLocked({ locked_until: '2030-01-01 00:00:00' }, Date.UTC(2030, 0, 1, 0, 0, 1)));
});

test('checking a password: right, wrong, empty, and the same effort when nobody has that name', async () => {
  const hash = await hashPassword('Orbit-Lantern-42x');
  assert.ok(await verifyPassword('Orbit-Lantern-42x', hash));
  assert.ok(!(await verifyPassword('orbit-lantern-42x', hash)));
  assert.ok(!(await verifyPassword('', hash)) && !(await verifyPassword(undefined, hash)));
  assert.strictEqual(await verifyAgainstNobody('anything'), false);
});

// ---------------------------------------------------------------- forged-request protection
const fakeReq = (over = {}) => ({ method: 'POST', path: '/incidents', body: {}, session: { csrf: 'tok-123' }, ip: '10.0.0.1', query: {}, get: () => undefined, ...over });
const fakeRes = () => { const r = { code: null, rendered: null, json: null, status(c) { r.code = c; return r; }, render(v, o) { r.rendered = { v, o }; }, json(b) { r.jsonBody = b; } }; return r; };
const run = (req) => { const res = fakeRes(); let nexted = false; csrf.middleware(req, res, () => { nexted = true; }); return { res, nexted }; };

test('a change without the right token is refused; with it, or on a read, it passes', () => {
  assert.ok(run(fakeReq({ body: { _csrf: 'tok-123' } })).nexted, 'right token in the body');
  assert.ok(run(fakeReq({ get: (h) => (h === 'x-csrf-token' ? 'tok-123' : undefined) })).nexted, 'right token in the header');
  for (const bad of [fakeReq(), fakeReq({ body: { _csrf: 'wrong' } }), fakeReq({ body: { _csrf: 'tok-12' } }), fakeReq({ body: { _csrf: '' } }), fakeReq({ session: {} , body: { _csrf: 'tok-123' } }), fakeReq({ session: undefined, body: { _csrf: 'x' } })]) {
    const r = run(bad); assert.ok(!r.nexted && r.res.code === 403, JSON.stringify(bad.body));
  }
  assert.ok(!run(fakeReq({ query: { _csrf: 'tok-123' } })).nexted, 'a token in the address is not accepted');
  for (const method of ['GET', 'HEAD', 'OPTIONS']) assert.ok(run(fakeReq({ method })).nexted, method);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.ok(!run(fakeReq({ method })).nexted, method);
});

test('API routes (bearer keys) and uploads (checked after the file is read) are not stopped by the general check', () => {
  assert.ok(run(fakeReq({ path: '/api/v1/incidents' })).nexted);
  assert.ok(run(fakeReq({ path: '/api/integrations/decom' })).nexted);
  assert.ok(run(fakeReq({ get: (h) => (h === 'content-type' ? 'multipart/form-data; boundary=x' : undefined) })).nexted);
  assert.ok(!csrf.checkRequest(fakeReq({ body: {} })) && csrf.checkRequest(fakeReq({ body: { _csrf: 'tok-123' } })), 'checkRequest is the check the upload route makes');
});

test('a refusal says what to do, as a page for a browser and as JSON for a script', () => {
  const page = run(fakeReq()); assert.deepStrictEqual([page.res.code, page.res.rendered.v], [403, 'error']); assert.match(page.res.rendered.o.message, /Reload the page/);
  const json = fakeRes(); csrf.refuse(fakeReq({ get: (h) => (h === 'x-csrf-token' ? 'bad' : undefined) }), json); assert.strictEqual(json.code, 403); assert.match(json.jsonBody.error, /Reload the page/);
});

test('every form that posts gets the token, forms that only read and forms for other sites do not, and the page gets the meta tag and script', () => {
  const html = '<html><head><title>x</title></head><body>'
    + '<form method="POST" action="/a"><input name="q"></form>'
    + '<form action="/b" method=post class="x"></form>'
    + '<form method="get" action="/c"></form>'
    + '<form method="POST" action="https://other.example/d"></form>'
    + '<form class="y"\n method="post"\n action="/e"></form></body></html>';
  const out = csrf.inject(html, 'TKN');
  assert.strictEqual((out.match(/name="_csrf" value="TKN"/g) || []).length, 3);
  assert.ok(out.includes('<form method="get" action="/c"></form>'));
  assert.ok(out.includes('<form method="POST" action="https://other.example/d"></form>'));
  assert.ok(out.includes('<meta name="csrf-token" content="TKN"><script src="/js/csrf.js"></script></head>'));
  assert.strictEqual(csrf.inject('plain text', 'T'), 'plain text');
  assert.strictEqual(csrf.inject(undefined, 'T'), undefined);
});
