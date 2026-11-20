// Everything a tenant owns, as one downloadable archive (tar.gz): a JSON-lines file for each table, the files attached to records, the logo and the
// sign-in picture, and a manifest. Made for the people who run the installation (the platform console), for a customer who is leaving.
//
// What is NOT in it, on purpose: credentials and secrets of any kind (password hashes, API key and SCIM token hashes, two-step secrets and recovery
// codes, the stored single sign-on / mail / mailbox passwords, webhook signing secrets), sign-in sessions, and the machinery that only exists to
// run the service (the event outbox, idempotency records, webhook delivery logs). The manifest says so. Tables are read inside the tenant, so
// another tenant's rows cannot get in.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Transform } = require('stream');
const { db, nowStr } = require('./db');
const tenancy = require('./tenancy');
const { TarWriter } = require('./tarWriter');
const version = require('./version');

const UPLOAD_ROOT = path.join(__dirname, '..', 'data', 'uploads');
const SKIP_TABLES = ['sessions', 'user_mfa', 'user_recovery_codes', 'api_idempotency', 'event_outbox', 'webhook_deliveries'];
const SECRET_COLUMN = /password|secret|token_hash|_enc$/i;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const safeName = (s) => String(s || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);

// The tables that hold a tenant's data (those under row level security: platform_audit has a tenant_id too, but it is the platform's own record and stays), with the columns to leave out (secrets, and binary columns, which become files).
async function plan() {
  const cols = await tenancy.runPlatform(() => db.prepare(`SELECT c.table_name, c.column_name, c.udt_name FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = current_schema() AND c.table_name IN (SELECT relname FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relkind = 'r' AND relrowsecurity)
      ORDER BY c.table_name, c.ordinal_position`).all());
  const byTable = new Map();
  for (const c of cols) {
    if (!byTable.has(c.table_name)) byTable.set(c.table_name, { name: c.table_name, drop: [] });
    if (SECRET_COLUMN.test(c.column_name) || c.udt_name === 'bytea') byTable.get(c.table_name).drop.push(c.column_name);
  }
  return [...byTable.values()].filter((t) => !SKIP_TABLES.includes(t.name));
}

// Streams the archive to `res` (any writable). Resolves { rows, files, bytes, sha256 }; rejects if anything fails (the download is then cut short
// and the caller must not treat the export as made).
async function exportTenant(tenant, res, { operator }) {
  const tables = await plan();
  const gz = zlib.createGzip({ level: 6 });
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const counter = new Transform({ transform(chunk, enc, cb) { hash.update(chunk); bytes += chunk.length; cb(null, chunk); } });
  gz.pipe(counter).pipe(res);
  const failed = new Promise((_, reject) => { gz.on('error', reject); counter.on('error', reject); });
  const done = new Promise((resolve) => res.on('finish', resolve));
  const tar = new TarWriter(gz);
  const counts = {}; const missing = []; let files = 0; let rows = 0;
  const work = tenancy.run(tenant.id, async () => {
    for (const t of tables) {
      const keep = t.drop.length ? ` - ARRAY[${t.drop.map((c) => `'${c.replace(/'/g, "''")}'`).join(',')}]::text[]` : '';
      const data = await db.prepare(`SELECT to_jsonb(x)${keep} AS j FROM "${t.name}" x WHERE x.tenant_id = nd_tenant() ORDER BY (to_jsonb(x)->>'id')::bigint NULLS LAST`).all();
      counts[t.name] = data.length; rows += data.length;
      await tar.addBuffer(`tables/${t.name}.jsonl`, data.map((r) => JSON.stringify(r.j)).join('\n') + (data.length ? '\n' : ''));
    }
    // files attached to records, where they are kept on disk
    for (const a of await db.prepare('SELECT entity_type, filename, original_name FROM attachments').all()) {
      const file = path.join(UPLOAD_ROOT, String(a.entity_type), path.basename(String(a.filename)));
      let st = null; try { st = fs.statSync(file); } catch { /* gone from disk */ }
      if (!st || !st.isFile()) { missing.push(`${a.entity_type}/${a.filename}`); continue; }
      await tar.addStream(`files/${safeName(a.entity_type)}/${path.basename(a.filename)}`, st.size, fs.createReadStream(file));
      files++;
    }
    // the logo and the sign-in picture, which are kept in the database
    const b = await db.prepare('SELECT logo, logo_mime, background, background_mime FROM branding_settings WHERE tenant_id = nd_tenant()').get();
    for (const [key, mime] of [['logo', b && b.logo_mime], ['background', b && b.background_mime]]) {
      if (b && b[key]) { await tar.addBuffer(`files/branding/${key}.${EXT[mime] || 'bin'}`, b[key]); files++; }
    }
  });
  try { await Promise.race([work, failed]); } catch (err) { res.destroy(err); throw err; }
  await tar.addBuffer('manifest.json', JSON.stringify({
    format: 'novadesk-tenant-export/1', tenant: { slug: tenant.slug, name: tenant.name, created_at: tenant.created_at }, exported_at: nowStr(), exported_by: operator.username, novadesk_version: version,
    tables: counts, rows, files, files_missing_on_disk: missing,
    left_out: { tables: SKIP_TABLES, columns: 'every column whose name contains password, secret or token_hash or ends in _enc, and binary columns (the logo and sign-in picture are in files/branding)', why: 'credentials and secrets are never exported; sessions and service machinery are not data of the customer' },
  }, null, 2) + '\n');
  tar.finish();
  await Promise.race([done, failed]);
  return { rows, files, bytes, sha256: hash.digest('hex'), tables: Object.keys(counts).length, missing: missing.length };
}

module.exports = { exportTenant, plan, SKIP_TABLES, UPLOAD_ROOT };
