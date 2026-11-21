// Warnings before a limit is reached: which level a use has reached, when a warning is due, and the exact percentages (src/limitWarnings.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const w = require('../src/limitWarnings');

test('a level is the highest of 80, 90 and 100 that the use has reached, and 89.9 is not yet 90', () => {
  assert.deepStrictEqual([0, 50, 79.99].map(w.levelFor), [0, 0, 0]);
  assert.deepStrictEqual([80, 89.9].map(w.levelFor), [80, 80]);
  assert.deepStrictEqual([90, 99.99].map(w.levelFor), [90, 90]);
  assert.deepStrictEqual([100].map(w.levelFor), [100]);
  assert.strictEqual(w.levelFor(null), 0, 'no limit, no level');
});

test('a warning is due when a higher level is reached, once, and not again while use hovers around a line', () => {
  assert.deepStrictEqual(w.decide(0, 85), { level: 80, send: true });
  assert.deepStrictEqual(w.decide(80, 85), { level: 80, send: false }, 'the same level is not told twice');
  assert.deepStrictEqual(w.decide(80, 92), { level: 90, send: true }, 'a higher one is');
  assert.deepStrictEqual(w.decide(0, 100), { level: 100, send: true }, 'a jump straight to full is one warning, the highest');
  assert.deepStrictEqual(w.decide(90, 87), { level: 90, send: false }, 'a small dip below the line keeps the level, so coming back up does not mail again');
  assert.deepStrictEqual(w.decide(90, 91), { level: 90, send: false });
  assert.deepStrictEqual(w.decide(90, 84), { level: 80, send: false }, 'fallen clearly below (more than 5 points): start afresh from where it is');
  assert.deepStrictEqual(w.decide(90, 84.999), { level: 80, send: false });
  assert.deepStrictEqual(w.decide(100, 40), { level: 0, send: false });
  assert.deepStrictEqual(w.decide(100, null), { level: 0, send: false }, 'a limit that was removed');
  assert.deepStrictEqual(w.decide(0, 79), { level: 0, send: false });
  // after starting afresh the line is told again
  assert.deepStrictEqual(w.decide(0, 81), { level: 80, send: true });
});

test('percentages are exact, a limit of 0 is full, no limit is null, a megabyte is 1048576 bytes', () => {
  assert.strictEqual(w.pctOf(9, 10), 90);
  assert.strictEqual(w.pctOf(1, 3) > 33.3 && w.pctOf(1, 3) < 33.4, true);
  assert.strictEqual(w.pctOf(0, 0), 100);
  assert.strictEqual(w.pctOf(5, null), null);
  assert.strictEqual(w.pctOf(12, 10), 100, 'over the limit (a limit lowered below the use) is full, not more');
  const u = { users: { used: 9, limit: 10 }, records: { used: 5, limit: null }, storage: { usedBytes: 943718, limit: 1 } };
  const p = w.pcts(u);
  assert.strictEqual(p.users, 90);
  assert.strictEqual(p.records, null);
  assert.ok(p.storage > 89.9 && p.storage < 90, `943718 of 1048576 bytes is 89.99...%, not 90 (${p.storage})`);
  assert.strictEqual(w.levelFor(p.storage), 80);
});

test('the console\'s rows give the same percentages, and the nearest limit is found', () => {
  const t = { active_users: 9, limit_users: 10, incidents: 1, requests: 0, changes: 0, problems: 0, cis: 1, articles: 0, limit_records: 4, storage_bytes: '0', limit_storage_mb: 5 };
  const p = w.pctsOfRow(t);
  assert.deepStrictEqual(p, { users: 90, records: 50, storage: 0 });
  assert.deepStrictEqual(w.nearest(p), ['users', 90]);
  assert.strictEqual(w.nearest({ users: null, records: null, storage: null }), null);
});

test('the words say what is used and what to do, in the singular when there is one', () => {
  const u = { users: { used: 9, limit: 10 }, records: { used: 1, limit: 1 }, storage: { usedBytes: 0, usedMb: 0, limit: null } };
  assert.match(w.words('users', 90, u).lead, /used 90% of its limit of 10 active people \(9 of 10\)/);
  assert.match(w.words('records', 100, u).lead, /reached its limit of 1 record: nothing new/);
  assert.match(w.words('users', 90, u).todo, /Switch off people/);
});
