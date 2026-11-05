// The parts of custom fields that need no database: how a typed-in value is checked and stored, how a list of choices is
// read, how a key is made, how a value is shown to a person and to a program. What happens to real records is checked by
// scripts/custom-fields-check.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const cf = require('../src/customFields');

const def = (type, extra = {}) => ({ label: 'Thing', type, options: [{ value: 'red', label: 'Red' }, { value: 'dark-blue', label: 'Dark blue' }], required: false, ...extra });
const check = (type, raw, opts, extra) => cf.checkValue(def(type, extra), raw, opts);

test('keys are made from labels: lowercase, joined with _, starting with a letter, 40 characters at most', () => {
  assert.strictEqual(cf.keyFromLabel('Cost centre'), 'cost_centre');
  assert.strictEqual(cf.keyFromLabel('  Cost   centre (EU) '), 'cost_centre_eu');
  assert.strictEqual(cf.keyFromLabel('Café Ñandú'), 'cafe_nandu');
  assert.strictEqual(cf.keyFromLabel('123 go'), 'go');
  assert.strictEqual(cf.keyFromLabel('!!!'), '');
  assert.strictEqual(cf.keyFromLabel('a'.repeat(60)).length, 40);
  for (const ok of ['cost_centre', 'a', 'a1_b2']) assert.ok(cf.KEY_RE.test(ok), ok);
  for (const bad of ['Cost', '1a', '_a', 'a-b', 'a b', '', 'a'.repeat(41)]) assert.ok(!cf.KEY_RE.test(bad), bad);
});

test('choices: one per line, or value|Label; values made from labels; limits and duplicates refused', () => {
  assert.deepStrictEqual(cf.parseOptionLines('Red\nDark blue\n'), [{ value: 'red', label: 'Red' }, { value: 'dark-blue', label: 'Dark blue' }]);
  assert.deepStrictEqual(cf.parseOptionLines('r|Red\r\n  g | Green  '), [{ value: 'r', label: 'Red' }, { value: 'g', label: 'Green' }]);
  assert.deepStrictEqual(cf.parseOptionLines('Yes please'), [{ value: 'yes-please', label: 'Yes please' }]);
  const refused = (text, re) => assert.throws(() => cf.parseOptionLines(text), (e) => e instanceof cf.FieldError && re.test(e.message), String(text).slice(0, 30));
  refused('', /at least one/); refused('  \n \n', /at least one/);
  refused('Red\nred', /Two choices/); refused('a|Red\na|Blue', /Two choices/);
  refused('|Red', /needs a value/); refused('A B|Red', /needs a value/); refused('!!!', /needs a value/);
  refused('a|', /no label/); refused('x'.repeat(61), /longer than 60/);
  refused(Array.from({ length: 51 }, (_, i) => `Choice ${i}`).join('\n'), /at most 50/);
  assert.strictEqual(cf.parseOptionLines(Array.from({ length: 50 }, (_, i) => `Choice ${i}`).join('\n')).length, 50);
  const opts = [{ value: 'red', label: 'Red' }, { value: 'b', label: 'Dark blue' }];
  assert.deepStrictEqual(cf.parseOptionLines(cf.optionsToLines(opts)), opts, 'what is shown for editing reads back the same');
});

test('text: one line (line breaks become spaces), trimmed, 255 characters at most; textarea keeps lines up to 4000', () => {
  assert.deepStrictEqual(check('text', '  hello \r\n world  '), { value: 'hello world' });
  assert.deepStrictEqual(check('text', 'x'.repeat(255)), { value: 'x'.repeat(255) });
  assert.match(check('text', 'x'.repeat(256)).error, /longer than 255/);
  assert.deepStrictEqual(check('textarea', 'a\r\nb\n\nc '), { value: 'a\nb\n\nc' });
  assert.deepStrictEqual(check('textarea', 'x'.repeat(4000)), { value: 'x'.repeat(4000) });
  assert.match(check('textarea', 'x'.repeat(4001)).error, /longer than 4000/);
  assert.match(check('text', 5).error, /must be text/); assert.match(check('text', { a: 1 }).error, /must be text/); assert.match(check('textarea', ['x']).error, /must be text/);
});

test('empty is empty: nothing stored, for every kind but a yes/no', () => {
  for (const type of ['text', 'textarea', 'number', 'date', 'select']) for (const raw of ['', '   ', null, undefined]) assert.deepStrictEqual(check(type, raw), { value: null }, `${type} ${JSON.stringify(raw)}`);
});

test('numbers: plain decimals only, stored in their plain form, never more than 15 digits', () => {
  for (const [raw, want] of [['12', '12'], ['12.50', '12.5'], ['-0.5', '-0.5'], ['007', '7'], [' 3.14 ', '3.14'], [42, '42'], [-1.25, '-1.25'], ['0', '0'], ['-0', '0'], ['123456789012345', '123456789012345']]) {
    assert.deepStrictEqual(check('number', raw), { value: want }, String(raw));
  }
  for (const raw of ['abc', '1e3', '1,5', '.5', '5.', '--1', '+5', '0x10', 'Infinity', 'NaN', '1 2', '1234567890123456', '0.1234567890123456', NaN, Infinity, true, {}]) {
    assert.ok(check('number', raw).error, `${String(raw)} is refused`);
  }
});

test('dates: a real calendar date as YYYY-MM-DD', () => {
  assert.deepStrictEqual(check('date', '2026-12-31'), { value: '2026-12-31' });
  assert.deepStrictEqual(check('date', ' 2024-02-29 '), { value: '2024-02-29' });
  for (const raw of ['2025-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '2026-1-5', '31/12/2026', 'tomorrow', '2026-12-31T10:00', 20261231, true]) assert.ok(check('date', raw).error, String(raw));
  assert.match(check('date', '2025-02-29').error, /not a real date/); assert.match(check('date', 'x').error, /like 2026-12-31/);
});

test('choices: by value, or by label in any capitals; anything else says what the choices are', () => {
  assert.deepStrictEqual(check('select', 'red'), { value: 'red' });
  assert.deepStrictEqual(check('select', 'Dark Blue'), { value: 'dark-blue' });
  assert.deepStrictEqual(check('select', ' DARK-BLUE '), { value: 'dark-blue' });
  const r = check('select', 'green'); assert.match(r.error, /must be one of: Red, Dark blue/);
  assert.match(check('select', 5).error, /one of the choices/);
  assert.match(check('select', 'rEd ').value ? '' : 'x', /^$/);
});

test('yes/no on a form: ticked is true, not ticked is false (a form sends nothing for an empty box)', () => {
  for (const raw of ['on', 'true', '1', true]) assert.deepStrictEqual(check('checkbox', raw, { form: true }), { value: 'true' }, String(raw));
  for (const raw of [undefined, '', 'off', 'no', null, false]) assert.deepStrictEqual(check('checkbox', raw, { form: true }), { value: 'false' }, String(raw));
});

test('yes/no from a program: true, false or their text; null or empty clears; anything else is refused', () => {
  assert.deepStrictEqual(check('checkbox', true), { value: 'true' }); assert.deepStrictEqual(check('checkbox', false), { value: 'false' });
  assert.deepStrictEqual(check('checkbox', 'true'), { value: 'true' }); assert.deepStrictEqual(check('checkbox', 'false'), { value: 'false' });
  assert.deepStrictEqual(check('checkbox', null), { value: null }); assert.deepStrictEqual(check('checkbox', ''), { value: null });
  for (const raw of ['yes', 'on', 1, 0, {}]) assert.match(check('checkbox', raw).error, /true or false/, String(raw));
});

test('shown to a person: Yes/No, the choice\'s label (or the stored value if the choice is gone), numbers and dates as they are', () => {
  assert.strictEqual(cf.display(def('checkbox'), 'true'), 'Yes'); assert.strictEqual(cf.display(def('checkbox'), 'false'), 'No');
  assert.strictEqual(cf.display(def('select'), 'dark-blue'), 'Dark blue'); assert.strictEqual(cf.display(def('select'), 'retired'), 'retired');
  assert.strictEqual(cf.display(def('number'), '12.5'), '12.5'); assert.strictEqual(cf.display(def('date'), '2026-12-31'), '2026-12-31');
  for (const v of [undefined, null, '']) assert.strictEqual(cf.display(def('text'), v), '');
});

test('shown to a program: numbers as numbers, yes/no as booleans, the rest as stored, nothing as null', () => {
  assert.strictEqual(cf.typed(def('number'), '12.5'), 12.5); assert.strictEqual(cf.typed(def('number'), '-3'), -3);
  assert.strictEqual(cf.typed(def('checkbox'), 'true'), true); assert.strictEqual(cf.typed(def('checkbox'), 'false'), false);
  assert.strictEqual(cf.typed(def('select'), 'red'), 'red'); assert.strictEqual(cf.typed(def('date'), '2026-01-02'), '2026-01-02'); assert.strictEqual(cf.typed(def('text'), 'hi'), 'hi');
  assert.strictEqual(cf.typed(def('text'), undefined), null); assert.strictEqual(cf.typed(def('number'), null), null);
});

test('the kinds of record and of value are as documented, and every kind of record names its table', () => {
  assert.deepStrictEqual(Object.keys(cf.ENTITIES), ['incident', 'request', 'change', 'problem', 'ci']);
  assert.deepStrictEqual(Object.values(cf.ENTITIES).map((e) => e.table), ['incidents', 'service_requests', 'changes', 'problems', 'cmdb_ci']);
  assert.deepStrictEqual(Object.keys(cf.TYPES), ['text', 'textarea', 'number', 'date', 'select', 'checkbox']);
  assert.ok(cf.isStaff('admin') && cf.isStaff('agent') && !cf.isStaff('user') && !cf.isStaff(undefined));
});
