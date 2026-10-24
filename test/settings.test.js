'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { dbConfig, sessionSecret, seedPlan, DEV_SESSION_SECRET } = require('../src/settings');

test('outside production the development defaults still apply (the lab and `npm run dev` behave as before)', () => {
  assert.deepStrictEqual(dbConfig({}), { host: 'localhost', port: 5432, user: 'novadesk', password: 'novadesk_dev_pw', database: 'novadesk' });
  assert.strictEqual(dbConfig({ PGHOST: '127.0.0.1', PGPORT: '5433' }).host, '127.0.0.1');
  assert.strictEqual(sessionSecret({}), DEV_SESSION_SECRET);
  assert.strictEqual(sessionSecret({ SESSION_SECRET: 'short' }), 'short');
});

test('the old lab host name is no longer a default', () => {
  assert.doesNotMatch(JSON.stringify(dbConfig({})), /RHEL10/);
});

test('in production a missing database setting stops the start and names what is missing', () => {
  assert.throws(() => dbConfig({ NODE_ENV: 'production' }), /PGHOST, PGUSER, PGPASSWORD, PGDATABASE/);
  assert.throws(() => dbConfig({ NODE_ENV: 'production', PGHOST: 'db', PGUSER: 'u', PGDATABASE: 'd' }), /PGPASSWORD/);
  assert.strictEqual(dbConfig({ NODE_ENV: 'production', PGHOST: 'db', PGUSER: 'u', PGPASSWORD: 'p', PGDATABASE: 'd' }).password, 'p');
});

test('in production the session secret must be set, not the built-in value, and at least 32 characters', () => {
  assert.throws(() => sessionSecret({ NODE_ENV: 'production' }), /SESSION_SECRET is required/);
  assert.throws(() => sessionSecret({ NODE_ENV: 'production', SESSION_SECRET: DEV_SESSION_SECRET }), /built-in/);
  assert.throws(() => sessionSecret({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(31) }), /at least 32/);
  assert.strictEqual(sessionSecret({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32) }), 'x'.repeat(32));
});

test('an existing database is never seeded', () => {
  assert.deepStrictEqual(seedPlan({ SEED_DEMO: 'true', ADMIN_USERNAME: 'a', ADMIN_PASSWORD: 'longenough' }, 3), { action: 'skip' });
});

test('an empty database: demo only on request, otherwise one admin from the settings, otherwise nothing and a reason', () => {
  assert.strictEqual(seedPlan({ SEED_DEMO: 'true' }, 0).action, 'demo');
  assert.strictEqual(seedPlan({ SEED_DEMO: 'yes' }, 0).action, 'none', 'only the exact value true turns demo data on');
  assert.deepStrictEqual(seedPlan({ ADMIN_USERNAME: ' hitesh ', ADMIN_PASSWORD: 'longenough', ADMIN_EMAIL: 'h@example.test' }, 0),
    { action: 'admin', username: 'hitesh', password: 'longenough', fullName: 'hitesh', email: 'h@example.test' });
  assert.strictEqual(seedPlan({ ADMIN_USERNAME: 'a', ADMIN_PASSWORD: 'longenough', ADMIN_FULL_NAME: 'Ada Admin' }, 0).fullName, 'Ada Admin');
  const short = seedPlan({ ADMIN_USERNAME: 'a', ADMIN_PASSWORD: 'short' }, 0);
  assert.strictEqual(short.action, 'none'); assert.match(short.problem, /at least 10/);
  const nothing = seedPlan({}, 0);
  assert.strictEqual(nothing.action, 'none'); assert.match(nothing.problem, /ADMIN_USERNAME and ADMIN_PASSWORD/);
});
