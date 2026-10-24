// Migration behaviour against a real Postgres. Skipped unless PGHOST is set (CI sets it; locally point
// PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE at any scratch database). Every test works in its own schema,
// dropped afterwards, so nothing else in that database is touched.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { migrate, status, listMigrations, DEFAULT_DIR } = require('../src/migrate');

const skip = !process.env.PGHOST && 'PGHOST is not set (needs a Postgres)';
const connection = { host: process.env.PGHOST, port: process.env.PGPORT || 5432, user: process.env.PGUSER, password: process.env.PGPASSWORD, database: process.env.PGDATABASE };

async function withSchema(fn) {
  const schema = `mig_${crypto.randomBytes(5).toString('hex')}`;
  const admin = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 1 } });
  await admin.raw(`CREATE SCHEMA ${schema}`);
  const knex = require('knex')({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 5 } });
  try { await fn(knex, schema); } finally { await knex.destroy(); await admin.raw(`DROP SCHEMA ${schema} CASCADE`); await admin.destroy(); }
}
const dirWith = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-migrations-'));
  for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), t);
  return dir;
};
const tables = async (knex) => (await knex.raw(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY 1`)).rows.map((r) => r.table_name);
const columns = async (knex, table) => (await knex.raw(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?`, [table])).rows.map((r) => r.column_name);

test('an empty database gets the whole schema, and a second run changes nothing', { skip }, async () => {
  await withSchema(async (knex) => {
    const first = await migrate(knex);
    assert.deepStrictEqual(first.applied, listMigrations(DEFAULT_DIR).map((m) => m.name));
    const t = await tables(knex);
    for (const name of ['users', 'incidents', 'changes', 'cmdb_ci', 'notifications', 'attachments', 'schema_migrations']) assert.ok(t.includes(name), `${name} exists`);
    const second = await migrate(knex);
    assert.deepStrictEqual(second.applied, []);
    assert.strictEqual(Number((await knex.raw('SELECT count(*) AS c FROM schema_migrations')).rows[0].c), listMigrations(DEFAULT_DIR).length);
  });
});

test('an install that predates migrations keeps its data and gains what it lacks', { skip }, async () => {
  await withSchema(async (knex) => {
    // What an old install looks like: the tables exist (made by the old start-up code), one column a
    // later release added is missing, and there is no schema_migrations table.
    const baseline = listMigrations(DEFAULT_DIR)[0].sql;
    await knex.raw(baseline);
    await knex.raw(`INSERT INTO users (username, password_hash, full_name, role) VALUES ('old', 'x', 'Old User', 'admin')`);
    await knex.raw(`ALTER TABLE notifications DROP COLUMN error`);
    await knex.raw(`DROP TABLE schema_migrations`).catch(() => {});
    assert.ok(!(await columns(knex, 'notifications')).includes('error'));
    const r = await migrate(knex);
    assert.ok(r.applied.includes('0001_baseline'));
    assert.ok((await columns(knex, 'notifications')).includes('error'), 'the missing column is back');
    assert.strictEqual((await knex.raw(`SELECT username FROM users`)).rows[0].username, 'old', 'the data is untouched');
  });
});

test('later migrations run once, in order, on top of the ones already applied', { skip }, async () => {
  await withSchema(async (knex) => {
    const dir = dirWith({ '0001_a.sql': 'CREATE TABLE a (id int)', '0002_b.sql': 'ALTER TABLE a ADD COLUMN note text' });
    assert.deepStrictEqual((await migrate(knex, { dir })).applied, ['0001_a', '0002_b']);
    fs.writeFileSync(path.join(dir, '0003_c.sql'), 'INSERT INTO a (id, note) VALUES (1, \'three\')');
    assert.deepStrictEqual((await migrate(knex, { dir })).applied, ['0003_c']);
    assert.deepStrictEqual((await migrate(knex, { dir })).applied, []);
    assert.strictEqual((await knex.raw('SELECT count(*) AS c FROM a')).rows[0].c, '1', 'the insert ran exactly once');
    const s = await status(knex, { dir });
    assert.deepStrictEqual([s.applied.map((a) => a.name), s.pending, s.unknown], [['0001_a', '0002_b', '0003_c'], [], []]);
  });
});

test('a failing migration leaves the database exactly as it was, even the ones before it in the same run', { skip }, async () => {
  await withSchema(async (knex) => {
    const dir = dirWith({ '0001_ok.sql': 'CREATE TABLE ok (id int)', '0002_bad.sql': 'CREATE TABLE half (id int); SELECT * FROM does_not_exist' });
    await assert.rejects(migrate(knex, { dir }), /Migration 0002_bad\.sql failed: .*does_not_exist/);
    const t = await tables(knex);
    assert.ok(!t.includes('ok') && !t.includes('half'), 'nothing was created');
    assert.strictEqual((await status(knex, { dir })).pending.length, 2);
    // After the file is fixed the same run succeeds.
    fs.writeFileSync(path.join(dir, '0002_bad.sql'), 'CREATE TABLE fixed (id int)');
    assert.deepStrictEqual((await migrate(knex, { dir })).applied, ['0001_ok', '0002_bad']);
  });
});

test('editing a migration after it was applied stops the start and names the file', { skip }, async () => {
  await withSchema(async (knex) => {
    const dir = dirWith({ '0001_a.sql': 'CREATE TABLE a (id int)' });
    await migrate(knex, { dir });
    fs.writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE a (id int, extra text)');
    await assert.rejects(migrate(knex, { dir }), /0001_a\.sql was edited after it was applied/);
    await assert.rejects(status(knex, { dir }), /0001_a\.sql was edited/);
  });
});

test('a database that is ahead of this version (after a rollback) only produces a warning list', { skip }, async () => {
  await withSchema(async (knex) => {
    const dir = dirWith({ '0001_a.sql': 'CREATE TABLE a (id int)' });
    await migrate(knex, { dir });
    await knex.raw(`INSERT INTO schema_migrations (name, checksum, applied_at) VALUES ('0002_from_the_future', 'abc', '2030-01-01 00:00:00')`);
    const r = await migrate(knex, { dir });
    assert.deepStrictEqual([r.applied, r.unknown], [[], ['0002_from_the_future']]);
  });
});

test('two copies starting at the same moment apply each migration once', { skip }, async () => {
  await withSchema(async (knex) => {
    const dir = dirWith({ '0001_a.sql': 'CREATE TABLE a (id int); SELECT pg_sleep(0.5)', '0002_b.sql': 'INSERT INTO a VALUES (1)' });
    const runs = await Promise.all([migrate(knex, { dir }), migrate(knex, { dir }), migrate(knex, { dir })]);
    assert.strictEqual(runs.reduce((n, r) => n + r.applied.length, 0), 2, 'two migrations applied in total, not six');
    assert.strictEqual((await knex.raw('SELECT count(*) AS c FROM a')).rows[0].c, '1');
  });
});

// 0002 adds the SLA engine to a database that already has incidents. Their due times must not move, nothing
// already late may trigger an email burst, and one badly formed value must not stop the upgrade.
test('0002 gives existing incidents their stored target without moving a due time, and marks old breaches as notified', { skip }, async () => {
  await withSchema(async (knex) => {
    const real = listMigrations(DEFAULT_DIR);
    const onlyBaseline = dirWith({ [real[0].file]: real[0].sql });
    await migrate(knex, { dir: onlyBaseline });
    const ts = (hoursFromNow) => new Date(Date.now() + hoursFromNow * 3600000).toISOString().slice(0, 19).replace('T', ' ');
    const add = (number, over) => knex.raw(
      `INSERT INTO incidents (number, short_description, priority, status, created_at, updated_at, sla_due_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [number, number, over.priority, over.status, over.created, over.updated || over.created, over.due, over.resolved || null]);
    await add('LATE', { priority: 3, status: 'in_progress', created: ts(-48), due: ts(-24) });                     // open, 24 h overdue
    await add('FRESH', { priority: 1, status: 'new', created: ts(-1), due: ts(3) });                               // open, 3 h of 4 left
    await add('WARN', { priority: 3, status: 'new', created: ts(-20), due: ts(4) });                               // open, inside the last 25%
    await add('HELD', { priority: 2, status: 'on_hold', created: ts(-5), updated: ts(-2), due: ts(3) });           // on hold since it was last touched
    await add('DONE', { priority: 4, status: 'resolved', created: ts(-100), due: ts(-28), resolved: ts(-30) });    // resolved
    await add('ODD', { priority: 4, status: 'new', created: ts(-1), due: 'tomorrow' });                            // not a timestamp
    await add('NONE', { priority: 4, status: 'new', created: ts(-1), due: null });                                 // never had an SLA
    const before = Object.fromEntries((await knex.raw('SELECT number, sla_due_at FROM incidents')).rows.map((r) => [r.number, r.sla_due_at]));

    assert.deepStrictEqual((await migrate(knex)).applied, ['0002_sla_engine']);

    const rows = Object.fromEntries((await knex.raw('SELECT * FROM incidents')).rows.map((r) => [r.number, r]));
    for (const n of Object.keys(before)) assert.strictEqual(rows[n].sla_due_at, before[n], `${n}: the due time did not move`);
    assert.deepStrictEqual([rows.LATE.sla_target_minutes, rows.LATE.sla_clock, rows.LATE.sla_warn_percent, rows.LATE.sla_started_at], [1440, 'calendar', 75, rows.LATE.created_at]);
    assert.strictEqual(rows.FRESH.sla_target_minutes, 240);
    assert.ok(rows.LATE.sla_breach_notified_at && rows.LATE.sla_warned_at, 'an old breach counts as notified');
    assert.ok(rows.WARN.sla_warned_at && !rows.WARN.sla_breach_notified_at, 'inside the warning window: warned, not breached');
    assert.ok(!rows.FRESH.sla_warned_at && !rows.FRESH.sla_breach_notified_at, 'a healthy incident is still to be watched');
    assert.strictEqual(rows.HELD.sla_paused_at, rows.HELD.updated_at, 'an On Hold incident counts as paused since it was last touched');
    assert.ok(!rows.DONE.sla_breach_notified_at, 'a resolved incident is not touched by the notification flags');
    assert.strictEqual(rows.DONE.sla_target_minutes, 72 * 60, 'a resolved incident keeps the target its due time implies');
    assert.strictEqual(rows.ODD.sla_target_minutes, null, 'a malformed due time is left alone');
    assert.strictEqual(rows.NONE.sla_target_minutes, null, 'an incident with no due time stays without a target');
    // The default policies are the targets NovaDesk always used.
    const policies = (await knex.raw(`SELECT priority, target_minutes, clock, warn_percent FROM sla_policies WHERE applies_to = 'incident' ORDER BY priority`)).rows;
    assert.deepStrictEqual(policies.map((p) => [p.priority, p.target_minutes, p.clock, p.warn_percent]), [[1, 240, 'calendar', 75], [2, 480, 'calendar', 75], [3, 1440, 'calendar', 75], [4, 4320, 'calendar', 75]]);
    assert.strictEqual((await knex.raw('SELECT count(*) AS c FROM business_calendars')).rows[0].c, '1');
  });
});
