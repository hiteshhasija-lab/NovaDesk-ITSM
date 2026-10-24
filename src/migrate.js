// Database migrations: numbered SQL files in src/migrations/, each applied once, in order.
//
//   node src/migrate.js status    what is applied and what is waiting (run it inside the container:
//                                 docker compose exec novadesk node src/migrate.js status)
//   node src/migrate.js up        apply what is waiting (NovaDesk does this itself at start-up)
//
// Rules the runner enforces:
//   - files are named NNNN_what_it_does.sql (a number of four or more digits, then a name); numbers are unique
//   - everything waiting is applied in ONE transaction under a database lock, so two copies starting at
//     once cannot both migrate, and a failing file leaves the database exactly as it was
//   - a file that was applied and has since been edited stops the start and names the file (the database
//     would no longer match the code that is supposed to have built it): add a new file instead
//   - a database that has migrations this version does not know (a rollback to an older release) only
//     gets a warning: older code keeps working because every migration is additive
//   - each file may not use CREATE INDEX CONCURRENTLY and other statements Postgres refuses inside a
//     transaction; none is needed at this size
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, 'migrations');
const TABLE = 'schema_migrations';
const LOCK_KEY = 7240111;             // arbitrary, fixed: "the NovaDesk migration lock"
const NAME_RE = /^(\d{4,})_([a-z0-9][a-z0-9_]*)\.sql$/;

const checksum = (text) => crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');

// The migration files in order. Throws on a badly named file or a repeated number.
function listMigrations(dir = DEFAULT_DIR) {
  const found = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (file.toLowerCase() === 'readme.md') continue;
    const m = NAME_RE.exec(file);
    if (!m) throw new Error(`Migration file "${file}" is not named like 0002_add_something.sql (four or more digits, an underscore, lower-case words, .sql).`);
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    found.push({ number: Number(m[1]), name: file.replace(/\.sql$/, ''), file, sql, checksum: checksum(sql) });
  }
  found.sort((a, b) => a.number - b.number);
  for (let i = 1; i < found.length; i++) {
    if (found[i].number === found[i - 1].number) throw new Error(`Two migrations share the number ${found[i].number}: ${found[i - 1].file} and ${found[i].file}. Renumber the newer one.`);
  }
  return found;
}

const nowStr = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

async function ensureTable(trx) {
  await trx.raw(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    name TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
}

// Compares the files with what the database says is applied. Throws when an applied file has changed.
function plan(files, appliedRows) {
  const applied = new Map(appliedRows.map((r) => [r.name, r]));
  for (const f of files) {
    const row = applied.get(f.name);
    if (row && row.checksum !== f.checksum) {
      throw new Error(`Migration ${f.file} was edited after it was applied to this database. Restore the file as released and put the change in a new numbered migration.`);
    }
  }
  const known = new Set(files.map((f) => f.name));
  return {
    pending: files.filter((f) => !applied.has(f.name)),
    done: files.filter((f) => applied.has(f.name)),
    unknown: appliedRows.filter((r) => !known.has(r.name)).map((r) => r.name),
  };
}

// Applies everything waiting. Resolves { applied: [names], upToDate: [names], unknown: [names] }.
async function migrate(knex, { dir = DEFAULT_DIR, log = () => {} } = {}) {
  const files = listMigrations(dir);
  return knex.transaction(async (trx) => {
    // Held until this transaction ends: a second NovaDesk starting now waits here, then finds nothing to do.
    await trx.raw('SELECT pg_advisory_xact_lock(?)', [LOCK_KEY]);
    await ensureTable(trx);
    const rows = (await trx.raw(`SELECT name, checksum FROM ${TABLE}`)).rows;
    const p = plan(files, rows);
    const applied = [];
    for (const f of p.pending) {
      try {
        await trx.raw(f.sql);
      } catch (err) {
        err.message = `Migration ${f.file} failed: ${err.message}`;
        throw err;
      }
      await trx.raw(`INSERT INTO ${TABLE} (name, checksum, applied_at) VALUES (?, ?, ?)`, [f.name, f.checksum, nowStr()]);
      applied.push(f.name);
      log(`applied ${f.name}`);
    }
    return { applied, upToDate: p.done.map((f) => f.name), unknown: p.unknown };
  });
}

// What is applied and what waits, without changing anything.
async function status(knex, { dir = DEFAULT_DIR } = {}) {
  const files = listMigrations(dir);
  const exists = (await knex.raw(`SELECT to_regclass(?) AS t`, [TABLE])).rows[0].t;
  const rows = exists ? (await knex.raw(`SELECT name, checksum, applied_at FROM ${TABLE} ORDER BY name`)).rows : [];
  const p = plan(files, rows);
  const when = new Map(rows.map((r) => [r.name, r.applied_at]));
  return {
    applied: p.done.map((f) => ({ name: f.name, appliedAt: when.get(f.name) })),
    pending: p.pending.map((f) => f.name),
    unknown: p.unknown,
  };
}

module.exports = { migrate, status, listMigrations, checksum, DEFAULT_DIR, TABLE };

if (require.main === module) {
  const { dbConfig } = require('./settings');
  const knex = require('knex')({ client: 'pg', connection: dbConfig(process.env), pool: { min: 0, max: 2 } });
  const command = process.argv[2] || 'status';
  const run = command === 'up'
    ? migrate(knex, { log: (m) => console.log(m) }).then((r) => console.log(r.applied.length ? `${r.applied.length} applied.` : 'Nothing to apply: the database is up to date.'))
    : command === 'status'
      ? status(knex).then((s) => {
        for (const a of s.applied) console.log(`applied  ${a.name}  (${a.appliedAt})`);
        for (const n of s.pending) console.log(`waiting  ${n}`);
        for (const n of s.unknown) console.log(`unknown  ${n}  (applied by a newer version)`);
        if (!s.applied.length && !s.pending.length) console.log('No migrations.');
      })
      : Promise.reject(new Error('Usage: node src/migrate.js status|up'));
  run.catch((err) => { console.error(err.message); process.exitCode = 1; }).finally(() => knex.destroy());
}
