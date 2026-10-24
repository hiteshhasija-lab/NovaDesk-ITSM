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

    const upTo2 = dirWith(Object.fromEntries(real.filter((m) => m.number <= 2).map((m) => [m.file, m.sql])));
    assert.deepStrictEqual((await migrate(knex, { dir: upTo2 })).applied, ['0002_sla_engine']);

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

test('0003 adds request and change policies switched off, and the clock columns, without touching existing rows', { skip }, async () => {
  await withSchema(async (knex) => {
    const real = listMigrations(DEFAULT_DIR);
    const upTo2 = dirWith(Object.fromEntries(real.filter((m) => m.number <= 2).map((m) => [m.file, m.sql])));
    await migrate(knex, { dir: upTo2 });
    await knex.raw(`INSERT INTO users (username, password_hash, full_name, role) VALUES ('u', 'x', 'U', 'admin')`);
    await knex.raw(`INSERT INTO changes (number, short_description, status) VALUES ('CHG1', 'a change', 'submitted')`);
    await knex.raw(`INSERT INTO service_requests (number, status) VALUES ('REQ1', 'submitted')`);
    assert.deepStrictEqual((await migrate(knex)).applied, real.filter((m) => m.number > 2).map((m) => m.name));
    const policies = (await knex.raw(`SELECT applies_to, priority, target_minutes, clock, warn_percent, active, enabled_at FROM sla_policies ORDER BY applies_to, priority`)).rows;
    const byKind = Object.fromEntries(policies.filter((p) => p.priority === 0).map((p) => [p.applies_to, p]));
    assert.deepStrictEqual([byKind.request.active, byKind.change.active, byKind.request.enabled_at, byKind.change.enabled_at], [0, 0, null, null], 'both start off');
    assert.deepStrictEqual([byKind.request.target_minutes, byKind.change.target_minutes], [4320, 2880]);
    assert.ok(policies.filter((p) => p.applies_to === 'incident').every((p) => p.active === 1), 'incident policies stay on');
    const ch = (await knex.raw(`SELECT * FROM changes`)).rows[0];
    const rq = (await knex.raw(`SELECT * FROM service_requests`)).rows[0];
    for (const col of ['sla_started_at', 'sla_target_minutes', 'sla_clock', 'sla_warn_percent', 'sla_due_at', 'sla_warned_at', 'sla_breach_notified_at']) {
      assert.ok(col in ch && ch[col] === null, `changes.${col} exists and is empty`);
      assert.ok(col in rq && rq[col] === null, `service_requests.${col} exists and is empty`);
    }
    assert.ok('sla_stopped_at' in ch && ch.sla_stopped_at === null);
    assert.deepStrictEqual([ch.status, rq.status], ['submitted', 'submitted']);
  });
});

test('0004 adds sign-in links, two-step secrets and recovery codes that go away with the person, and one identity links once', { skip }, async () => {
  await withSchema(async (knex) => {
    await migrate(knex);
    const [{ id: a }] = (await knex.raw(`INSERT INTO users (username, password_hash, full_name, role) VALUES ('a', 'x', 'A', 'user') RETURNING id`)).rows;
    const [{ id: b }] = (await knex.raw(`INSERT INTO users (username, password_hash, full_name, role) VALUES ('b', 'x', 'B', 'user') RETURNING id`)).rows;
    await knex.raw(`INSERT INTO user_identities (user_id, issuer, subject) VALUES (?, 'https://idp.example', 'sub-1')`, [a]);
    await assert.rejects(knex.raw(`INSERT INTO user_identities (user_id, issuer, subject) VALUES (?, 'https://idp.example', 'sub-1')`, [b]), /duplicate key|unique/i, 'the same identity cannot be linked to two accounts');
    await knex.raw(`INSERT INTO user_identities (user_id, issuer, subject) VALUES (?, 'https://other.example', 'sub-1')`, [b]);   // same subject at another provider is a different identity
    await knex.raw(`INSERT INTO user_mfa (user_id, secret_enc) VALUES (?, 'v1:x:y:z')`, [a]);
    await assert.rejects(knex.raw(`INSERT INTO user_mfa (user_id, secret_enc) VALUES (?, 'v1:x:y:z')`, [a]), /duplicate key|unique/i, 'one two-step record per person');
    await knex.raw(`INSERT INTO user_recovery_codes (user_id, code_hash) VALUES (?, 'h1'), (?, 'h2')`, [a, a]);
    const mfa = (await knex.raw(`SELECT enabled, last_counter FROM user_mfa WHERE user_id = ?`, [a])).rows[0];
    assert.deepStrictEqual([mfa.enabled, Number(mfa.last_counter)], [0, 0], 'setup starts unfinished');
    await knex.raw(`DELETE FROM users WHERE id = ?`, [a]);
    for (const t of ['user_identities', 'user_mfa', 'user_recovery_codes']) {
      assert.strictEqual(Number((await knex.raw(`SELECT count(*) AS c FROM ${t} WHERE user_id = ?`, [a])).rows[0].c), 0, `${t} rows go with the person`);
    }
    assert.strictEqual(Number((await knex.raw(`SELECT count(*) AS c FROM user_identities WHERE user_id = ?`, [b])).rows[0].c), 1, 'the other person is untouched');
  });
});

test('0005 adds API keys (hash only, unique, read or write) and idempotency records that go away with the key or the person', { skip }, async () => {
  await withSchema(async (knex) => {
    await migrate(knex);
    const [{ id: u }] = (await knex.raw(`INSERT INTO users (username, password_hash, full_name, role) VALUES ('k', 'x', 'K', 'agent') RETURNING id`)).rows;
    const [{ id: k }] = (await knex.raw(`INSERT INTO api_keys (user_id, name, prefix, token_hash, scope) VALUES (?, 'ci', 'ndk_abcd', 'hash-1', 'write') RETURNING id`, [u])).rows;
    await assert.rejects(knex.raw(`INSERT INTO api_keys (user_id, name, prefix, token_hash) VALUES (?, 'dup', 'ndk_abcd', 'hash-1')`, [u]), /duplicate key|unique/i, 'two keys cannot share a hash');
    await assert.rejects(knex.raw(`INSERT INTO api_keys (user_id, name, prefix, token_hash, scope) VALUES (?, 'bad', 'ndk_efgh', 'hash-2', 'admin')`, [u]), /check constraint|violates/i, 'scope is read or write');
    assert.strictEqual((await knex.raw(`SELECT scope FROM api_keys WHERE user_id = ? AND name = 'ci'`, [u])).rows[0].scope, 'write');
    await knex.raw(`INSERT INTO api_idempotency (key_id, idem_key, request_hash) VALUES (?, 'abc', 'h')`, [k]);
    await assert.rejects(knex.raw(`INSERT INTO api_idempotency (key_id, idem_key, request_hash) VALUES (?, 'abc', 'h2')`, [k]), /duplicate key|unique/i, 'one record per key and Idempotency-Key');
    const [{ id: k2 }] = (await knex.raw(`INSERT INTO api_keys (user_id, name, prefix, token_hash) VALUES (?, 'other', 'ndk_zzzz', 'hash-3') RETURNING id`, [u])).rows;
    await knex.raw(`INSERT INTO api_idempotency (key_id, idem_key, request_hash) VALUES (?, 'abc', 'h')`, [k2]);   // the same string under another key is a different request
    await knex.raw(`DELETE FROM users WHERE id = ?`, [u]);
    assert.strictEqual(Number((await knex.raw(`SELECT count(*) AS c FROM api_keys`)).rows[0].c), 0, 'keys go with the person');
    assert.strictEqual(Number((await knex.raw(`SELECT count(*) AS c FROM api_idempotency`)).rows[0].c), 0, 'so do their idempotency records');
  });
});

test('0006: events are recorded by triggers, only while a webhook is on, never block a change, and say what happened', { skip }, async () => {
  await withSchema(async (knex) => {
    await migrate(knex);
    const outbox = async () => (await knex.raw(`SELECT entity, entity_id, op, previous_status, child_id FROM event_outbox ORDER BY id`)).rows;
    const clear = () => knex.raw('DELETE FROM event_outbox');
    const [{ id: u }] = (await knex.raw(`INSERT INTO users (username, password_hash, full_name, role) VALUES ('w', 'x', 'W', 'agent') RETURNING id`)).rows;

    // Nothing is recorded while no webhook is switched on.
    const [{ id: early }] = (await knex.raw(`INSERT INTO incidents (number, short_description) VALUES ('INC-EARLY', 'before any webhook') RETURNING id`)).rows;
    assert.deepStrictEqual(await outbox(), []);

    await knex.raw(`INSERT INTO webhooks (name, url, secret_enc, events) VALUES ('hook', 'https://example.test', 'x', '*')`);
    const [{ id }] = (await knex.raw(`INSERT INTO incidents (number, short_description) VALUES ('INC-1', 'one') RETURNING id`)).rows;
    assert.deepStrictEqual(await outbox(), [{ entity: 'incident', entity_id: id, op: 'created', previous_status: null, child_id: null }]);

    await clear();
    // Two quick changes: each event keeps the record as it was right after its own change.
    await knex.raw(`UPDATE incidents SET status = 'in_progress', description = 'first', updated_at = '2030-01-01 00:00:00' WHERE id = ?`, [id]);
    await knex.raw(`UPDATE incidents SET status = 'on_hold', description = 'second', updated_at = '2030-01-01 00:00:01' WHERE id = ?`, [id]);
    const shots = (await knex.raw(`SELECT op, previous_status, snapshot FROM event_outbox ORDER BY id`)).rows;
    assert.deepStrictEqual(shots.map((e) => [e.op, e.previous_status, e.snapshot.status, e.snapshot.description]), [['status_changed', 'new', 'in_progress', 'first'], ['status_changed', 'in_progress', 'on_hold', 'second']]);
    assert.strictEqual(shots[0].snapshot.number, 'INC-1');
    await knex.raw(`UPDATE incidents SET status = 'in_progress', updated_at = '2030-01-01 00:00:02' WHERE id = ?`, [id]);   // back, so the next steps start as before
    await clear();
    await knex.raw(`UPDATE incidents SET status = 'new', updated_at = '2030-01-01 00:00:03' WHERE id = ?`, [id]);
    await clear();
    await knex.raw(`UPDATE incidents SET status = 'in_progress', updated_at = '2030-01-01 00:00:04' WHERE id = ?`, [id]);
    assert.deepStrictEqual(await outbox(), [{ entity: 'incident', entity_id: id, op: 'status_changed', previous_status: 'new', child_id: null }], 'a status change is one event, not two');

    await clear();
    await knex.raw(`UPDATE incidents SET description = 'more', updated_at = '2030-01-02 00:00:00' WHERE id = ?`, [id]);
    assert.deepStrictEqual((await outbox()).map((e) => e.op), ['updated']);

    await clear();
    await knex.raw(`UPDATE incidents SET sla_warned_at = '2030-01-03 00:00:00', sla_breach_notified_at = '2030-01-03 00:00:00', sla_due_at = '2030-01-09 00:00:00' WHERE id = ?`, [id]);
    assert.deepStrictEqual(await outbox(), [], 'the SLA bookkeeping the sweep writes is not a change');
    await knex.raw(`UPDATE incidents SET updated_at = '2030-01-04 00:00:00' WHERE id = ?`, [id]);
    assert.deepStrictEqual(await outbox(), [], 'touching updated_at alone is not a change');

    // Two edits inside the same second (updated_at cannot tell them apart) are still two events.
    await knex.raw(`UPDATE incidents SET description = 'edit one', updated_at = '2030-01-05 00:00:00' WHERE id = ?`, [id]);
    await knex.raw(`UPDATE incidents SET description = 'edit two', updated_at = '2030-01-05 00:00:00' WHERE id = ?`, [id]);
    const edits = (await knex.raw(`SELECT op, snapshot FROM event_outbox ORDER BY id`)).rows;
    assert.deepStrictEqual(edits.map((e) => [e.op, e.snapshot.description]), [['updated', 'edit one'], ['updated', 'edit two']]);

    await clear();
    await knex.raw(`INSERT INTO incident_comments (incident_id, user_id, comment, is_work_note) VALUES (?, ?, 'hello', 0)`, [id, u]);
    await knex.raw(`INSERT INTO incident_comments (incident_id, user_id, comment, is_work_note) VALUES (?, ?, 'internal', 1)`, [id, u]);
    const comments = await outbox();
    assert.strictEqual(comments.length, 1, 'a work note is never announced');
    assert.deepStrictEqual([comments[0].entity, comments[0].entity_id, comments[0].op], ['incident', id, 'commented']);
    assert.ok(comments[0].child_id > 0);

    // The other kinds of record.
    await clear();
    const [{ id: ch }] = (await knex.raw(`INSERT INTO changes (number, short_description) VALUES ('CHG-1', 'c') RETURNING id`)).rows;
    const [{ id: pr }] = (await knex.raw(`INSERT INTO problems (number, short_description) VALUES ('PRB-1', 'p') RETURNING id`)).rows;
    const [{ id: rq }] = (await knex.raw(`INSERT INTO service_requests (number) VALUES ('REQ-1') RETURNING id`)).rows;
    const [{ id: ci }] = (await knex.raw(`INSERT INTO cmdb_ci (ci_number, name, ci_type) VALUES ('CI-1', 'srv', 'server') RETURNING id`)).rows;
    const [{ id: ar }] = (await knex.raw(`INSERT INTO kb_articles (number, title, body) VALUES ('KB-1', 't', 'b') RETURNING id`)).rows;
    await knex.raw(`INSERT INTO change_comments (change_id, user_id, comment) VALUES (?, ?, 'c')`, [ch, u]);
    await knex.raw(`INSERT INTO problem_comments (problem_id, user_id, comment) VALUES (?, ?, 'c')`, [pr, u]);
    assert.deepStrictEqual((await outbox()).map((e) => `${e.entity}.${e.op}`), ['change.created', 'problem.created', 'request.created', 'ci.created', 'article.created', 'change.commented', 'problem.commented']);

    // Reading an article bumps its view count: not a change.
    await clear();
    await knex.raw(`UPDATE kb_articles SET view_count = view_count + 1 WHERE id = ?`, [ar]);
    assert.deepStrictEqual(await outbox(), [], 'a view count is not an edit');
    await knex.raw(`UPDATE kb_articles SET title = 'renamed', updated_at = '2030-01-06 00:00:00' WHERE id = ?`, [ar]);
    assert.deepStrictEqual((await outbox()).map((e) => `${e.entity}.${e.op}`), ['article.updated']);

    // A switched-off webhook records nothing.
    await clear();
    await knex.raw(`UPDATE webhooks SET active = 0`);
    await knex.raw(`UPDATE incidents SET status = 'resolved', updated_at = '2030-02-01 00:00:00' WHERE id = ?`, [id]);
    assert.deepStrictEqual(await outbox(), []);
    await knex.raw(`UPDATE webhooks SET active = 1`);

    // A trigger that cannot record its event must not stop the change.
    await knex.raw(`ALTER TABLE event_outbox RENAME TO event_outbox_away`);
    try {
      await knex.raw(`INSERT INTO incidents (number, short_description) VALUES ('INC-SURVIVES', 'the change still happens')`);
      await knex.raw(`UPDATE incidents SET short_description = 'edited', updated_at = '2030-03-01 00:00:00' WHERE id = ?`, [early]);
    } finally { await knex.raw(`ALTER TABLE event_outbox_away RENAME TO event_outbox`); }
    assert.strictEqual((await knex.raw(`SELECT count(*) AS c FROM incidents WHERE number = 'INC-SURVIVES'`)).rows[0].c, '1');
    assert.strictEqual((await knex.raw(`SELECT short_description FROM incidents WHERE id = ?`, [early])).rows[0].short_description, 'edited');
  });
});

test('0006: a delivery is unique per webhook and event, deliveries go with their webhook, and the status is one of three', { skip }, async () => {
  await withSchema(async (knex) => {
    await migrate(knex);
    const [{ id: w1 }] = (await knex.raw(`INSERT INTO webhooks (name, url, secret_enc, events) VALUES ('a', 'https://a.test', 'x', '*') RETURNING id`)).rows;
    const [{ id: w2 }] = (await knex.raw(`INSERT INTO webhooks (name, url, secret_enc, events) VALUES ('b', 'https://b.test', 'x', '*') RETURNING id`)).rows;
    const add = (w, e) => knex.raw(`INSERT INTO webhook_deliveries (webhook_id, event_id, event_type, payload, next_attempt_at) VALUES (?, ?, 'x', '{}', '2030-01-01 00:00:00')`, [w, e]);
    await add(w1, 'evt_1'); await add(w2, 'evt_1');
    await assert.rejects(add(w1, 'evt_1'), /duplicate key|unique/i, 'one delivery per webhook and event');
    await assert.rejects(knex.raw(`INSERT INTO webhook_deliveries (webhook_id, event_id, event_type, payload, status, next_attempt_at) VALUES (?, 'evt_9', 'x', '{}', 'sent', 'x')`, [w1]), /check constraint|violates/i);
    await knex.raw(`DELETE FROM webhooks WHERE id = ?`, [w1]);
    assert.strictEqual(Number((await knex.raw(`SELECT count(*) AS c FROM webhook_deliveries`)).rows[0].c), 1, 'the other webhook keeps its delivery');
  });
});

test('0007: accounts get a failed-sign-in counter and a lock time, and the audit log keeps its rows when the person goes', { skip }, async () => {
  await withSchema(async (knex) => {
    await migrate(knex);
    const [{ id }] = (await knex.raw(`INSERT INTO users (username, password_hash, full_name, role) VALUES ('s', 'x', 'S', 'agent') RETURNING id`)).rows;
    const u = (await knex.raw(`SELECT failed_logins, locked_until FROM users WHERE id = ?`, [id])).rows[0];
    assert.deepStrictEqual([u.failed_logins, u.locked_until], [0, null]);
    await knex.raw(`INSERT INTO audit_log (actor_id, actor_name, action, target_type, target_id, target_name, detail, ip) VALUES (?, 'S', 'user.updated', 'user', ?, 's', 'role agent to admin', '10.0.0.1')`, [id, id]);
    const row = (await knex.raw(`SELECT * FROM audit_log`)).rows[0];
    assert.ok(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(row.at) && row.action === 'user.updated' && row.ip === '10.0.0.1');
    await knex.raw(`DELETE FROM users WHERE id = ?`, [id]);
    assert.strictEqual(Number((await knex.raw(`SELECT count(*) AS c FROM audit_log`)).rows[0].c), 1, 'the record outlives the person');
  });
});
