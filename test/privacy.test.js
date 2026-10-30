// The parts of the privacy tools that need no database: which words are searched for, how they are matched, and how a
// retention limit is read. What happens to real rows is checked by scripts/privacy-check.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { patternsFor, escapeRegex, regexFor, labelFor, MIN_LENGTH, EMAIL_LABEL, TEXT_PLACES } = require('../src/privacy/scrub');
const { parseDays, cutoffFor, TARGETS, MIN_DAYS, MAX_DAYS } = require('../src/privacy/retention');
const { SECTIONS } = require('../src/privacy/person');

// The database's expression read by JavaScript: the same except for the name of the "letter or digit" class.
const toJs = (find, flags = 'gi') => new RegExp(regexFor(find).replace(/\[:alnum:\]/g, 'A-Za-z0-9'), flags);

const jane = { id: 7, username: 'jdoe42', full_name: 'Jane Doe', email: 'Jane.Doe@Example.test' };

test('an email is searched for before the name and the username, and every one gets the right label', () => {
  const { patterns, skipped } = patternsFor(jane, ['jd@sso.example.test']);
  assert.deepStrictEqual(patterns.map((p) => p.kind), ['email', 'email', 'name', 'username']);
  assert.deepStrictEqual(patterns.filter((p) => p.kind === 'email').map((p) => p.replaceWith), [EMAIL_LABEL, EMAIL_LABEL]);
  assert.strictEqual(patterns[2].replaceWith, 'Anonymised user 7');
  assert.strictEqual(patterns[3].replaceWith, labelFor(7));
  assert.deepStrictEqual(skipped, []);
});

test('a value shorter than the minimum is not searched for, and is reported', () => {
  const { patterns, skipped } = patternsFor({ id: 3, username: 'ab', full_name: 'Al', email: null });
  assert.deepStrictEqual(patterns, []);
  assert.deepStrictEqual(skipped.map((s) => s.kind).sort(), ['name', 'username']);
  assert.ok(MIN_LENGTH >= 4);
  assert.strictEqual(patternsFor({ id: 3, username: 'abcd', full_name: '', email: '' }).patterns.length, 1, 'exactly the minimum is searched');
});

test('the same value twice (a username that is also the name, an identity email equal to the email) is searched once', () => {
  const { patterns } = patternsFor({ id: 1, username: 'Sam Rivera', full_name: 'sam rivera', email: 'sam@x.test' }, ['SAM@X.TEST']);
  assert.deepStrictEqual(patterns.map((p) => p.kind), ['email', 'name']);
});

test('characters that mean something in a regular expression are made literal, and letters are left alone', () => {
  assert.strictEqual(escapeRegex('a.b+c@d(e)[f]{g}|h^i$j?k*l\\m'), 'a\\.b\\+c@d\\(e\\)\\[f\\]\\{g\\}\\|h\\^i\\$j\\?k\\*l\\\\m');
  assert.strictEqual(escapeRegex('José Ñandú-O\'Brien'), 'José Ñandú-O\'Brien');
  const re = toJs('o.brien', 'i');
  assert.ok(re.test('ticket from O.Brien today'));
  assert.ok(!re.test('ticket from oxbrien today'), 'a dot in a name is a dot, not "any character"');
});

test('a value is matched on its own, not inside a longer word or address', () => {
  const js = (find) => toJs(find);
  assert.ok(js('jdoe42').test('assigned to jdoe42.'));
  assert.ok(js('jdoe42').test('jdoe42'));
  assert.ok(!js('jdoe42').test('assigned to jdoe420'));
  assert.ok(!js('jdoe42').test('xjdoe42'));
  assert.strictEqual('From Jane Doe, jane doe and JANE DOE'.replace(js('Jane Doe'), '$1X'), 'From X, X and X');
});

test('every place text is searched names a table and columns, with no duplicates and no ticket text', () => {
  const seen = new Set();
  for (const place of TEXT_PLACES) {
    assert.ok(/^[a-z_]+$/.test(place.table));
    for (const c of place.columns) { assert.ok(/^[a-z_]+$/.test(c)); assert.ok(!seen.has(`${place.table}.${c}`)); seen.add(`${place.table}.${c}`); }
  }
  for (const banned of ['incidents', 'incident_comments', 'change_comments', 'problem_comments', 'kb_articles', 'users']) assert.ok(!TEXT_PLACES.some((p) => p.table === banned), banned);
});

test('retention days: empty and "forever" mean no limit, the range is enforced, anything else is refused', () => {
  assert.deepStrictEqual(parseDays(''), { days: null });
  assert.deepStrictEqual(parseDays(undefined), { days: null });
  assert.deepStrictEqual(parseDays('  Forever '), { days: null });
  assert.deepStrictEqual(parseDays('365'), { days: 365 });
  assert.deepStrictEqual(parseDays(` ${MIN_DAYS} `), { days: MIN_DAYS });
  assert.deepStrictEqual(parseDays(String(MAX_DAYS)), { days: MAX_DAYS });
  for (const bad of [String(MIN_DAYS - 1), '0', String(MAX_DAYS + 1), '-5', '1.5', '30d', '1e3', 'abc', '0x40']) assert.ok(parseDays(bad).error, `${bad} is refused`);
});

test('the cutoff is that many days before now, in the stored text format', () => {
  const now = Date.UTC(2026, 9, 29, 12, 0, 0);
  assert.strictEqual(cutoffFor(30, now), '2026-09-29 12:00:00');
  assert.strictEqual(cutoffFor(365, now), '2025-10-29 12:00:00');
});

test('each retention target has an identifier, table, age column and a condition, and only logs and messages are in the list', () => {
  assert.deepStrictEqual(TARGETS.map((t) => t.id).sort(), ['audit_log', 'inbound_emails', 'notifications', 'webhook_deliveries']);
  for (const t of TARGETS) for (const k of ['id', 'label', 'table', 'age', 'where', 'help']) assert.ok(t[k], `${t.id}.${k}`);
  assert.ok(!TARGETS.some((t) => /incident|change|problem|comment|activity|kb_|cmdb/.test(t.table)), 'no ticket data is ever removed by retention');
});

test('the export sections are unique, and none of them ever selects a secret', () => {
  const ids = SECTIONS.map((s) => s.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  for (const s of SECTIONS) {
    assert.ok(!/password|secret|token_hash|code_hash|csv\b/i.test(s.select), `${s.id} selects a secret`);
    assert.strictEqual((s.from.match(/\?/g) || []).length, s.bind({ id: 1, email: 'a@b.test' }).length, `${s.id}: placeholders match bindings`);
  }
});
