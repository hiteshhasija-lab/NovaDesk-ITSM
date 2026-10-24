'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listMigrations, checksum, DEFAULT_DIR } = require('../src/migrate');

const tmp = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-migrations-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
};

test('the shipped migrations are named and numbered correctly, starting with the baseline', () => {
  const list = listMigrations(DEFAULT_DIR);
  assert.ok(list.length >= 1);
  assert.strictEqual(list[0].name, '0001_baseline');
  list.forEach((m, i) => { if (i) assert.ok(m.number > list[i - 1].number); });
});

test('the baseline is idempotent SQL: nothing in it can fail on a database that already has the tables', () => {
  const sql = listMigrations(DEFAULT_DIR)[0].sql;
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.ok(!/\bDROP\b/i.test(code), 'no DROP in the baseline');
  for (const stmt of code.split(';').map((s) => s.trim()).filter(Boolean)) {
    assert.ok(/^(CREATE TABLE IF NOT EXISTS|CREATE INDEX IF NOT EXISTS|CREATE UNIQUE INDEX IF NOT EXISTS|ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS)/i.test(stmt), `not idempotent: ${stmt.slice(0, 60)}`);
  }
});

test('files run in numeric order, not alphabetical (0010 after 0009, 10000 after 9999)', () => {
  const dir = tmp({ '0010_ten.sql': 'select 10', '0009_nine.sql': 'select 9', '0002_two.sql': 'select 2', '0001_one.sql': 'select 1' });
  assert.deepStrictEqual(listMigrations(dir).map((m) => m.number), [1, 2, 9, 10]);
});

test('a badly named file is refused with the naming rule', () => {
  for (const bad of ['2_short.sql', '0002-dash.sql', '0002_Upper.sql', 'add_things.sql', '0002_two.txt']) {
    assert.throws(() => listMigrations(tmp({ [bad]: 'select 1' })), /is not named like 0002_add_something\.sql/, bad);
  }
});

test('two files with the same number are refused and both are named', () => {
  assert.throws(() => listMigrations(tmp({ '0003_a.sql': 'select 1', '0003_b.sql': 'select 2' })), /share the number 3: 0003_a\.sql and 0003_b\.sql/);
});

test('a README in the folder is not a migration', () => {
  assert.deepStrictEqual(listMigrations(tmp({ 'README.md': 'x', '0001_one.sql': 'select 1' })).map((m) => m.name), ['0001_one']);
});

test('the checksum ignores line-ending differences (a Windows checkout does not break an install)', () => {
  assert.strictEqual(checksum('a\nb\n'), checksum('a\r\nb\r\n'));
  assert.notStrictEqual(checksum('a\nb\n'), checksum('a\nc\n'));
});
