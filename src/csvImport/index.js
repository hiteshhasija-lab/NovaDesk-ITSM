// CSV import, start to finish: a file is read and every row judged (a preview that writes nothing), the person sees the
// result, and only then does a second request carry it out. The file is kept in the imports table in between, and the
// rows are judged again at that moment, so a preview that has gone stale cannot do more than the data allows now.
'use strict';
const { db, nowStr } = require('../db');
const { audit } = require('../audit');
const csv = require('./csv');
const { KINDS } = require('./kinds');

class ImportError extends Error {}

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PROBLEMS = 300;        // rows listed in a preview
const MAX_RESULT_PROBLEMS = 500; // rows kept in the record of a finished import
const MAX_WAITING = 10;         // previews one person can have waiting for a decision
const KEEP_FILE_HOURS = 24;
const KEEP_HISTORY_DAYS = 90;

// Reads the text and works out which column is which. Throws ImportError when the file cannot be imported at all.
function readTable(kind, text, mode) {
  let parsed;
  try { parsed = csv.parse(text, { maxRecords: kind.maxRows + 1 }); } catch (e) {
    if (e instanceof csv.CsvError) throw new ImportError(e.message);
    throw e;
  }
  const { records } = parsed;
  if (!records.length) throw new ImportError('The file is empty.');
  const header = records[0].map(csv.cleanCell);

  const byAlias = new Map();
  for (const col of kind.columns) { byAlias.set(csv.headerKey(col.field), col); for (const a of col.aliases) byAlias.set(csv.headerKey(a), col); }
  const index = {};              // field -> column position
  const used = []; const ignored = []; const unknown = [];
  header.forEach((h, i) => {
    if (!h) return;
    const k = csv.headerKey(h);
    const col = byAlias.get(k);
    if (col) {
      if (index[col.field] !== undefined) throw new ImportError(`Two columns are both "${col.label}" ("${header[index[col.field]]}" and "${h}"). Keep one.`);
      index[col.field] = i; used.push(col.label);
    } else if (kind.ignoredHeaders.includes(k)) ignored.push(h);
    else unknown.push(h);
  });
  if (!used.length) throw new ImportError(`None of the column names in the first row are ones NovaDesk knows (${kind.columns.map((c) => c.label).join(', ')}). The first row must be the column names.`);
  const missing = kind.columns.filter((c) => (c.required === 'always' || (c.required === 'new' && mode !== 'update')) && index[c.field] === undefined);
  if (missing.length) throw new ImportError(`The file needs ${missing.length === 1 ? 'a column' : 'columns'} named ${missing.map((c) => `"${c.label}"`).join(' and ')}. Columns found: ${used.join(', ') || 'none'}.`);
  if (kind.identity && !kind.identity.some((f) => index[f] !== undefined)) throw new ImportError(`The file needs a "${kind.columns.find((c) => c.field === kind.identity[0]).label}" or a "${kind.columns.find((c) => c.field === kind.identity[1]).label}" column to say which ${kind.noun} each row is.`);
  return { records, header, index, used, ignored, unknown, delimiter: parsed.delimiter };
}

// Judges every row against what exists now. Writes nothing.
async function buildPlan(kind, text, options, actor, lookups) {
  const mode = options.mode === 'update' ? 'update' : 'add';
  const table = readTable(kind, text, mode);
  const ctx = kind.context(lookups || await kind.load(), { actor });
  const items = [];
  let blank = 0;
  for (let i = 1; i < table.records.length; i++) {
    const rec = table.records[i];
    const row = i + 1;                       // the row number a spreadsheet shows
    const v = {};
    for (const col of kind.columns) v[col.field] = table.index[col.field] === undefined ? '' : csv.cleanCell(rec[table.index[col.field]]);
    if (!rec.some((c) => csv.cleanCell(c))) { blank++; continue; }
    if (rec.length > table.header.length && rec.slice(table.header.length).some((c) => csv.cleanCell(c))) {
      items.push({ row, key: v[kind.columns[0].field], action: 'error', message: `The row has ${rec.length} values but the first row names ${table.header.length} columns. A value with a comma in it needs quotes around it.` });
      continue;
    }
    const verdict = kind.plan(v, ctx, row, { mode, defaultStatus: options.defaultStatus });
    items.push({ row, ...verdict });
  }
  return { table, ctx, items, blank, mode };
}

const count = (items) => {
  const c = { add: 0, update: 0, unchanged: 0, skip: 0, error: 0 };
  for (const i of items) c[i.action]++;
  return c;
};
const problemOf = (i) => ({ row: i.row, key: i.key || '', action: i.action, message: i.message });

// Step one: judge the file, keep it, and say what would happen.
async function preview({ kindId, options, filename, buffer, actor }) {
  const kind = KINDS[kindId];
  if (!kind) throw new ImportError('Unknown kind of import.');
  if (!buffer || !buffer.length) throw new ImportError('Choose a CSV file to import.');
  if (buffer.length > MAX_BYTES) throw new ImportError(`The file is larger than ${MAX_BYTES / 1048576} MB.`);
  const waiting = await db.prepare("SELECT COUNT(*) AS c FROM imports WHERE user_id = ? AND status = 'ready'").get(actor.id);
  if (waiting.c >= MAX_WAITING) throw new ImportError(`You already have ${MAX_WAITING} imports waiting for a decision. Open them from the Import data page and confirm or cancel some first.`);
  const { text, encoding } = csv.decode(buffer);
  const opts = { mode: options.mode === 'update' ? 'update' : 'add', defaultStatus: options.defaultStatus === 'published' ? 'published' : 'draft' };
  const { table, items, blank } = await buildPlan(kind, text, opts, actor);
  if (!items.length) throw new ImportError('The file has a first row but no rows of data.');
  const counts = count(items);
  const summary = {
    total: items.length, ...counts, blank, encoding,
    delimiter: table.delimiter === '\t' ? 'tab' : table.delimiter,
    columns: { used: table.used, ignored: table.ignored, unknown: table.unknown },
    problems: items.filter((i) => i.action === 'error' || i.action === 'skip').slice(0, MAX_PROBLEMS).map(problemOf),
    sample: items.filter((i) => i.action === 'add' || i.action === 'update').slice(0, 15).map(problemOf),
  };
  const made = await db.prepare(`INSERT INTO imports (kind, mode, options, filename, user_id, status, csv, preview)
    VALUES (?, ?, ?, ?, ?, 'ready', ?, ?) RETURNING id`).get(kindId, opts.mode, JSON.stringify(opts), String(filename || 'file.csv').slice(0, 200), actor.id, text, JSON.stringify(summary));
  return made.id;
}

// Step two: judge the rows again against the data as it is now, then do them one by one. A row that fails is reported and
// the rest go on; running a file again later only adds what is still missing.
async function run(jobId, { req, actor }) {
  const claimed = await db.prepare("UPDATE imports SET status = 'running' WHERE id = ? AND status = 'ready' RETURNING id, kind, options, csv, filename").get(jobId);
  if (!claimed) throw new ImportError('This import has already been run, or is running, or its file is no longer kept. Upload the file again.');
  const kind = KINDS[claimed.kind];
  const started = Date.now();
  try {
    const opts = JSON.parse(claimed.options);
    const { items, ctx } = await buildPlan(kind, claimed.csv, opts, actor);
    const result = { added: 0, updated: 0, unchanged: 0, skipped: 0, rejected: 0, failed: 0, problems: [] };
    const note = (i) => { if (result.problems.length < MAX_RESULT_PROBLEMS) result.problems.push(problemOf(i)); };
    for (const item of items) {
      if (item.action === 'unchanged') { result.unchanged++; continue; }
      if (item.action === 'skip') { result.skipped++; note(item); continue; }
      if (item.action === 'error') { result.rejected++; note(item); continue; }
      try {
        await kind.apply(item, ctx, { req, actor });
        if (item.action === 'add') result.added++; else result.updated++;
      } catch (err) {
        result.failed++;
        note({ ...item, action: 'failed', message: `Could not be saved: ${err.message}` });
        console.error(`[Import] ${kind.id} row ${item.row}: ${err.message}`);
      }
    }
    result.seconds = Math.round((Date.now() - started) / 100) / 10;
    await db.prepare("UPDATE imports SET status = 'done', csv = NULL, result = ?, finished_at = ? WHERE id = ?").run(JSON.stringify(result), nowStr(), jobId);
    await audit(req, actor, 'import.completed', {
      targetType: 'import', targetId: jobId, targetName: `${kind.label}: ${claimed.filename}`,
      detail: `${result.added} added, ${result.updated} updated, ${result.skipped + result.unchanged} left as they were, ${result.rejected + result.failed} not imported`,
    });
    console.log(`[Import] ${actor.username} imported ${kind.id} from ${claimed.filename}: ${result.added} added, ${result.updated} updated, ${result.rejected + result.failed} not imported`);
    return result;
  } catch (err) {
    await db.prepare("UPDATE imports SET status = 'failed', csv = NULL, result = ?, finished_at = ? WHERE id = ?").run(JSON.stringify({ error: err.message }), nowStr(), jobId);
    throw err;
  }
}

// Files nobody confirmed are not kept for long; the record of finished imports goes after a quarter.
async function cleanup() {
  const old = (hours) => new Date(Date.now() - hours * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  await db.prepare("UPDATE imports SET status = 'expired', csv = NULL WHERE status = 'ready' AND created_at < ?").run(old(KEEP_FILE_HOURS));
  await db.prepare("UPDATE imports SET status = 'failed', csv = NULL, result = ? WHERE status = 'running' AND created_at < ?").run(JSON.stringify({ error: 'The import was interrupted (the server restarted).' }), old(2));
  await db.prepare('DELETE FROM imports WHERE created_at < ?').run(old(KEEP_HISTORY_DAYS * 24));
}

module.exports = { preview, run, cleanup, buildPlan, readTable, ImportError, MAX_BYTES, KINDS };
