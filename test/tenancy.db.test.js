// Row level security, checked at the database itself, as the restricted role the application uses (novadesk_app): what one
// tenant can and cannot see or write, whatever the SQL says. Skipped unless PGHOST is set, like test/migrate.db.test.js.
// scripts/tenancy-check.js checks the same through the whole application.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { migrate } = require('../src/migrate');

const skip = !process.env.PGHOST && 'PGHOST is not set (needs a Postgres)';
const connection = { host: process.env.PGHOST, port: process.env.PGPORT || 5432, user: process.env.PGUSER, password: process.env.PGPASSWORD, database: process.env.PGDATABASE };
// Shared on purpose: the list of tenants and the platform console's operators and record (they belong to no tenant).
const GLOBAL_TABLES = ['schema_migrations', 'tenants', 'tenant_hosts', 'platform_admins', 'platform_audit'];

// A scratch schema, migrated; `admin` is the login role (sees everything), `app(tenant)` runs one statement as the restricted role for a tenant.
async function withTenancy(fn) {
  const schema = `ten_${crypto.randomBytes(5).toString('hex')}`;
  const root = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 1 } });
  await root.raw(`CREATE SCHEMA ${schema}`);
  const admin = require('knex')({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 3 } });
  const restricted = require('knex')({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 3, afterCreate: (c, done) => c.query('SET ROLE novadesk_app', (e) => done(e, c)) } });
  const as = async (tenant, sql, bindings, { platform = false } = {}) => restricted.transaction(async (trx) => {
    await trx.raw("SELECT set_config('app.tenant_id', ?, true), set_config('app.platform', ?, true)", [tenant === null ? '' : String(tenant), platform ? 'on' : '']);
    return trx.raw(sql, bindings);
  });
  try {
    await migrate(admin);
    await admin.raw("INSERT INTO tenants (id, slug, name) VALUES (2, 'acme', 'Acme'), (3, 'globex', 'Globex')");
    await fn({ admin, as, restricted, schema });
  } finally { await admin.destroy(); await restricted.destroy(); await root.raw(`DROP SCHEMA ${schema} CASCADE`); await root.destroy(); }
}
const rows = (r) => r.rows;
const user = (name, tenant) => ({ sql: "INSERT INTO users (username, password_hash, full_name, role, tenant_id) VALUES (?, 'x', ?, 'user', ?) RETURNING id", args: [name, name, tenant] });

test('every table that holds an organisation\'s data has a tenant, a policy and row level security (the guard for future migrations)', { skip }, async () => {
  await withTenancy(async ({ admin }) => {
    const tables = rows(await admin.raw("SELECT c.relname, c.relrowsecurity FROM pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' ORDER BY 1")).map((r) => r);
    assert.ok(tables.length > 40, `${tables.length} tables`);
    for (const t of tables) {
      if (GLOBAL_TABLES.includes(t.relname)) { assert.strictEqual(t.relrowsecurity, false, `${t.relname} is shared on purpose`); continue; }
      const col = rows(await admin.raw("SELECT is_nullable, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? AND column_name = 'tenant_id'", [t.relname]))[0];
      assert.ok(col, `${t.relname} has no tenant_id: a new table for an organisation's data needs SELECT nd_tenant_scope('${t.relname}') in its migration (src/migrations/README.md)`);
      assert.strictEqual(col.is_nullable, 'NO', `${t.relname}.tenant_id may be empty`);
      assert.match(col.column_default, /nd_tenant\(\)/, `${t.relname}.tenant_id must default to the statement's tenant, not to a fixed one`);
      assert.strictEqual(t.relrowsecurity, true, `${t.relname} does not have row level security switched on`);
      const pol = rows(await admin.raw("SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = current_schema() AND tablename = ? AND policyname = 'tenant_isolation'", [t.relname]))[0];
      assert.strictEqual(pol.n, 1, `${t.relname} has no tenant_isolation policy`);
    }
  });
});

test('the restricted role is not a superuser and cannot switch row level security off', { skip }, async () => {
  await withTenancy(async ({ as }) => {
    const r = rows(await as(1, "SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin FROM pg_roles WHERE rolname = 'novadesk_app'"))[0];
    assert.deepStrictEqual(r, { rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolcanlogin: false });
    assert.strictEqual(rows(await as(1, 'SELECT current_user AS u'))[0].u, 'novadesk_app');
    await assert.rejects(() => as(1, 'ALTER TABLE users DISABLE ROW LEVEL SECURITY'), /must be owner/i, 'it does not own the tables');
    await assert.rejects(() => as(1, 'DROP POLICY tenant_isolation ON users'), /must be owner/i);
    await assert.rejects(() => as(1, 'CREATE TABLE sneaky (x int)'), /permission denied/i, 'it cannot create tables');
    await assert.rejects(() => as(1, 'ALTER ROLE novadesk_app BYPASSRLS'), /permission denied|must be superuser/i);
  });
});

test('a tenant sees and changes only its own rows, whatever the SQL says', { skip }, async () => {
  await withTenancy(async ({ admin, as }) => {
    const u1 = user('ann', 1); const u2 = user('bob', 2); const u3 = user('cy', 3);
    for (const u of [u1, u2, u3]) await admin.raw(u.sql, u.args);
    await admin.raw("INSERT INTO incidents (number, short_description, caller_id, tenant_id) SELECT 'INC1', 'one', id, tenant_id FROM users");
    assert.deepStrictEqual(rows(await as(1, 'SELECT username FROM users ORDER BY 1')).map((r) => r.username), ['ann']);
    assert.deepStrictEqual(rows(await as(2, 'SELECT username FROM users ORDER BY 1')).map((r) => r.username), ['bob']);
    assert.deepStrictEqual(rows(await as(2, "SELECT username FROM users WHERE username IN ('ann', 'cy') OR 1 = 1")).map((r) => r.username), ['bob'], 'a WHERE that asks for everything still gets only its own');
    assert.strictEqual(rows(await as(2, 'SELECT count(*)::int AS n FROM incidents'))[0].n, 1);
    assert.strictEqual(rows(await as(2, 'SELECT count(*)::int AS n FROM incidents i JOIN users u ON u.id = i.caller_id'))[0].n, 1, 'joins are limited on both sides');
    assert.strictEqual(rows(await as(2, "SELECT count(*)::int AS n FROM (SELECT username FROM users UNION ALL SELECT short_description FROM incidents) x"))[0].n, 2, 'also through UNION and subqueries');
    const annId = rows(await admin.raw("SELECT id FROM users WHERE username = 'ann'"))[0].id;
    assert.strictEqual(rows(await as(2, 'SELECT id FROM users WHERE id = ?', [annId])).length, 0, 'another tenant\'s row cannot be fetched by its id');
    // writes
    assert.strictEqual((await as(2, "UPDATE users SET full_name = 'hacked' WHERE id = ?", [annId])).rowCount, 0, 'cannot change it');
    assert.strictEqual((await as(2, 'DELETE FROM users WHERE id = ?', [annId])).rowCount, 0, 'cannot delete it');
    assert.strictEqual((await as(2, "UPDATE users SET full_name = 'hacked'")).rowCount, 1, 'an UPDATE with no WHERE touches only its own');
    assert.strictEqual(rows(await admin.raw("SELECT full_name FROM users WHERE username = 'ann'"))[0].full_name, 'ann', 'ann is untouched');
    await assert.rejects(() => as(2, "INSERT INTO users (username, password_hash, full_name, role, tenant_id) VALUES ('mallory', 'x', 'M', 'user', 1)"), /row-level security/i, 'cannot write into another tenant');
    await assert.rejects(() => as(2, "UPDATE users SET tenant_id = 1"), /row-level security/i, 'cannot hand its rows to another tenant');
    await assert.rejects(() => as(1, "UPDATE users SET tenant_id = 2"), /row-level security/i, 'cannot give rows away either');
    const made = rows(await as(2, "INSERT INTO users (username, password_hash, full_name, role) VALUES ('dee', 'x', 'D', 'user') RETURNING tenant_id"))[0];
    assert.strictEqual(made.tenant_id, 2, 'an insert with no tenant named lands in the statement\'s own tenant');
  });
});

test('no tenant means no rows and no writes; a tenant that does not exist sees nothing', { skip }, async () => {
  await withTenancy(async ({ admin, as, restricted }) => {
    await admin.raw(user('ann', 1).sql, user('ann', 1).args);
    assert.strictEqual(rows(await as(null, 'SELECT count(*)::int AS n FROM users'))[0].n, 0, 'no tenant set');
    assert.strictEqual(rows(await as(999, 'SELECT count(*)::int AS n FROM users'))[0].n, 0, 'a tenant id nobody has');
    await assert.rejects(() => as(null, "INSERT INTO users (username, password_hash, full_name, role) VALUES ('x', 'x', 'X', 'user')"), /null value|row-level security/i, 'an insert with no tenant fails loudly');
    // the setting is local to the transaction: the next user of the same connection starts with none
    await as(1, 'SELECT 1');
    const bare = await restricted.raw('SELECT count(*)::int AS n FROM users');
    assert.strictEqual(rows(bare)[0].n, 0, 'a connection that was used for tenant 1 carries nothing over');
    assert.strictEqual(rows(await restricted.raw("SELECT coalesce(current_setting('app.tenant_id', true), '') AS t"))[0].t, '', 'the tenant setting did not outlive its transaction');
  });
});

test('platform mode sees every tenant (for finding which tenant a key belongs to and for the sweeps), and only it does', { skip }, async () => {
  await withTenancy(async ({ admin, as }) => {
    for (const u of [user('ann', 1), user('bob', 2), user('cy', 3)]) await admin.raw(u.sql, u.args);
    assert.strictEqual(rows(await as(null, 'SELECT count(*)::int AS n FROM users', [], { platform: true }))[0].n, 3);
    assert.strictEqual(rows(await as(1, 'SELECT count(*)::int AS n FROM users', [], { platform: true }))[0].n, 3, 'platform wins over a tenant');
    await assert.rejects(() => as(null, "INSERT INTO users (username, password_hash, full_name, role) VALUES ('z', 'x', 'Z', 'user')", [], { platform: true }), /null value/i, 'even then an insert must name its tenant');
    await as(null, "INSERT INTO users (username, password_hash, full_name, role, tenant_id) VALUES ('z', 'x', 'Z', 'user', 3)", [], { platform: true });
    assert.strictEqual(rows(await admin.raw("SELECT tenant_id FROM users WHERE username = 'z'"))[0].tenant_id, 3);
    assert.strictEqual(rows(await as(2, 'SELECT count(*)::int AS n FROM users'))[0].n, 1, 'and the next statement without platform mode is limited again');
  });
});

test('names are unique within a tenant, not across them', { skip }, async () => {
  await withTenancy(async ({ admin, as }) => {
    for (const t of [1, 2]) {
      await as(t, "INSERT INTO users (username, password_hash, full_name, role) VALUES ('admin', 'x', 'Admin', 'admin')");
      await as(t, "INSERT INTO incidents (number, short_description, caller_id) SELECT 'INC0000001', 's', id FROM users");
      await as(t, "INSERT INTO counters (name, value) VALUES ('incident', 1)");
      await as(t, "INSERT INTO custom_fields (entity_type, key, label, field_type) VALUES ('incident', 'cost', 'Cost', 'text')");
      await as(t, "INSERT INTO inbound_emails (message_id, source, outcome) VALUES ('m@x', 'imap', 'ticket')");
    }
    assert.strictEqual(rows(await admin.raw("SELECT count(*)::int AS n FROM users WHERE username = 'admin'"))[0].n, 2, 'the same username in two tenants');
    await assert.rejects(() => as(1, "INSERT INTO users (username, password_hash, full_name, role) VALUES ('admin', 'x', 'Again', 'admin')"), /duplicate|unique/i, 'but not twice in one');
    await assert.rejects(() => as(2, "INSERT INTO incidents (number, short_description, caller_id) SELECT 'INC0000001', 's', id FROM users"), /duplicate|unique/i);
    await assert.rejects(() => as(2, "INSERT INTO counters (name, value) VALUES ('incident', 9)"), /duplicate|unique/i);
    assert.strictEqual(rows(await as(1, "UPDATE counters SET value = value + 1 WHERE name = 'incident' RETURNING value"))[0].value, 2);
    assert.strictEqual(rows(await as(2, "SELECT value FROM counters WHERE name = 'incident'"))[0].value, 1, 'each tenant counts its own tickets');
    // the same message arriving at two tenants, and ON CONFLICT per tenant
    const dup = await as(2, "INSERT INTO inbound_emails (message_id, source, outcome) VALUES ('m@x', 'imap', 'ticket') ON CONFLICT (tenant_id, message_id) DO NOTHING RETURNING id");
    assert.strictEqual(dup.rows.length, 0);
    // what must stay installation-wide: a key's hash identifies its tenant
    const owner = rows(await as(1, "SELECT id FROM users LIMIT 1"))[0].id;
    await as(1, "INSERT INTO api_keys (user_id, name, prefix, token_hash, scope) VALUES (?, 'k', 'ndk_ab', 'hash-1', 'read')", [owner]);
    const owner2 = rows(await as(2, "SELECT id FROM users LIMIT 1"))[0].id;
    await assert.rejects(() => as(2, "INSERT INTO api_keys (user_id, name, prefix, token_hash, scope) VALUES (?, 'k', 'ndk_ab', 'hash-1', 'read')", [owner2]), /duplicate|unique/i, 'a token hash is unique across tenants');
    const found = rows(await as(null, 'SELECT tenant_id FROM api_keys WHERE token_hash = ?', ['hash-1'], { platform: true }));
    assert.deepStrictEqual(found, [{ tenant_id: 1 }], 'platform mode finds the key and says whose it is');
  });
});

test('one row of settings for each tenant, and a new table can be put under the same rules with nd_tenant_scope', { skip }, async () => {
  await withTenancy(async ({ admin, as }) => {
    assert.deepStrictEqual(rows(await as(1, 'SELECT tenant_id FROM branding_settings')), [{ tenant_id: 1 }]);
    assert.strictEqual(rows(await as(2, 'SELECT count(*)::int AS n FROM branding_settings'))[0].n, 0, 'a new tenant has none until it is set up');
    await as(2, 'INSERT INTO branding_settings DEFAULT VALUES');
    await assert.rejects(() => as(2, 'INSERT INTO branding_settings DEFAULT VALUES'), /duplicate|unique/i);
    assert.strictEqual(rows(await as(2, "UPDATE branding_settings SET product_name = 'Acme Desk' RETURNING tenant_id"))[0].tenant_id, 2);
    assert.strictEqual(rows(await as(1, 'SELECT product_name FROM branding_settings'))[0].product_name, 'NovaDesk', 'tenant 1 is unchanged');
    // a table a future migration adds
    await admin.raw('CREATE TABLE gadgets (id SERIAL PRIMARY KEY, label TEXT)');
    await admin.raw("SELECT nd_tenant_scope('gadgets')");
    await admin.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON gadgets TO novadesk_app');
    await admin.raw('GRANT USAGE ON SEQUENCE gadgets_id_seq TO novadesk_app');
    await as(1, "INSERT INTO gadgets (label) VALUES ('one')");
    await as(2, "INSERT INTO gadgets (label) VALUES ('two')");
    assert.deepStrictEqual(rows(await as(2, 'SELECT label FROM gadgets')), [{ label: 'two' }]);
    assert.strictEqual(rows(await as(null, 'SELECT count(*)::int AS n FROM gadgets'))[0].n, 0);
  });
});

test('deleting a record deletes its custom values through the trigger, as the restricted role, within the tenant', { skip }, async () => {
  await withTenancy(async ({ admin, as }) => {
    for (const t of [1, 2]) {
      await as(t, "INSERT INTO users (username, password_hash, full_name, role) VALUES ('u', 'x', 'U', 'admin')");
      const uid = rows(await as(t, 'SELECT id FROM users'))[0].id;
      const inc = rows(await as(t, "INSERT INTO incidents (number, short_description, caller_id) VALUES ('INC1', 's', ?) RETURNING id", [uid]))[0].id;
      const f = rows(await as(t, "INSERT INTO custom_fields (entity_type, key, label, field_type) VALUES ('incident', 'k', 'K', 'text') RETURNING id"))[0].id;
      await as(t, "INSERT INTO custom_field_values (entity_type, entity_id, field_id, value) VALUES ('incident', ?, ?, 'v')", [inc, f]);
    }
    const one = rows(await as(1, 'SELECT id FROM incidents'))[0].id;
    await as(1, 'DELETE FROM incidents WHERE id = ?', [one]);
    assert.strictEqual(rows(await admin.raw("SELECT count(*)::int AS n FROM custom_field_values"))[0].n, 1, 'tenant 1\'s value went, tenant 2\'s stayed');
    // the event trigger records events with the tenant of the change
    await as(2, "INSERT INTO webhooks (name, url, secret_enc, events) VALUES ('w', 'https://w.test', 'x', '*')");
    const uid2 = rows(await as(2, 'SELECT id FROM users'))[0].id;
    await as(2, "INSERT INTO incidents (number, short_description, caller_id) VALUES ('INC2', 's', ?)", [uid2]);
    const ev = rows(await admin.raw("SELECT DISTINCT tenant_id FROM event_outbox"));
    assert.deepStrictEqual(ev, [{ tenant_id: 2 }], 'the event belongs to the tenant whose change it was');
  });
});
