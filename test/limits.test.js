// How a refusal from the database is read and worded, how usage becomes a percentage, and how an operator's limits are read.
// The triggers themselves are tested in test/migrate.db.test.js; scripts/tenant-limits-check.js checks it all through the application.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const limits = require('../src/limits');

const err = (kind, n, code = 'ND001') => Object.assign(new Error(`nd_limit:${kind}:${n}`), { code });

test('a refusal is recognised by its code and its message, and by nothing else', () => {
  assert.deepStrictEqual(limits.parse(err('users', 5)), { kind: 'users', limit: 5 });
  assert.deepStrictEqual(limits.parse(err('storage', 0)), { kind: 'storage', limit: 0 });
  assert.ok(limits.isLimitError(err('records', 100)));
  assert.ok(!limits.isLimitError(err('users', 5, '23505')), 'another database error with that text is not a limit');
  assert.ok(!limits.isLimitError(Object.assign(new Error('something else'), { code: 'ND001' })));
  assert.ok(!limits.isLimitError(err('widgets', 5)));
  for (const junk of [null, undefined, new Error('x'), {}, 'nd_limit:users:5']) assert.ok(!limits.isLimitError(junk), String(junk));
});

test('a person is told in a sentence what is full and what to do, singular and plural', () => {
  assert.match(limits.sentence(err('users', 5)), /limit of 5 active people\. Switch someone off first, or ask the people who run this service/);
  assert.match(limits.sentence(err('users', 1)), /1 active person\./);
  assert.match(limits.sentence(err('records', 100)), /100 records \(incidents, requests, changes, problems, configuration items and articles together\)\. Delete something/);
  assert.match(limits.sentence(err('records', 1)), /1 record \(/);
  assert.match(limits.sentence(err('storage', 50)), /50 MB of attached files\. Remove a file/);
  assert.strictEqual(limits.sentence(new Error('x')), null);
  assert.strictEqual(limits.reason(err('users', 3)), 'the workspace has reached its limit of 3 active people');
  assert.strictEqual(limits.reason(new Error('x')), null);
});

test('usage becomes a percentage, none without a limit, never above 100, and a limit of 0 is full', () => {
  assert.strictEqual(limits.percent(5, null), null);
  assert.strictEqual(limits.percent(5, undefined), null);
  assert.strictEqual(limits.percent(0, 10), 0);
  assert.strictEqual(limits.percent(9, 10), 90);
  assert.strictEqual(limits.percent(15, 10), 100);
  assert.strictEqual(limits.percent(0, 0), 100);
});

test('an operator\'s limits: empty means none, otherwise a whole number from 0 to 1 000 000', () => {
  assert.deepStrictEqual(limits.parseLimits({ limit_users: '', limit_records: ' ', limit_storage_mb: undefined }), { users: null, records: null, storageMb: null });
  assert.deepStrictEqual(limits.parseLimits({ limit_users: '25', limit_records: '0', limit_storage_mb: '1000000' }), { users: 25, records: 0, storageMb: 1000000 });
  assert.deepStrictEqual(limits.parseLimits({}), { users: null, records: null, storageMb: null });
  for (const bad of ['-1', '1.5', 'ten', '1e3', '1000001', '٣']) assert.throws(() => limits.parseLimits({ limit_users: bad }), /whole number from 0 to 1000000/, bad);
  assert.throws(() => limits.parseLimits({ limit_records: 'x' }), /limit for records/);
  assert.throws(() => limits.parseLimits({ limit_storage_mb: 'x' }), /limit for storage/);
});
