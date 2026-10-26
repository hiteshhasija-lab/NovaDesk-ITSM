// CSV import without a database: reading the file, matching the columns, and deciding each row (src/csvImport/).
// What the import then writes is exercised against a real database by scripts/import-check.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const csv = require('../src/csvImport/csv');
const { buildPlan, readTable, ImportError, KINDS } = require('../src/csvImport');

const admin = { id: 1, username: 'admin', role: 'admin' };

// ---------------------------------------------------------------------------------------------------------------- reading
test('decode: UTF-8 with and without a BOM, UTF-16, and Windows-1252 from Excel', () => {
  assert.deepStrictEqual(csv.decode(Buffer.from('a,b\n')), { text: 'a,b\n', encoding: 'UTF-8' });
  assert.strictEqual(csv.decode(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('héllo')])).text, 'héllo');
  assert.strictEqual(csv.decode(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('ab', 'utf16le')])).text, 'ab');
  const latin = csv.decode(Buffer.from([0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72]));   // "Müller" in Windows-1252
  assert.strictEqual(latin.text, 'Müller');
  assert.strictEqual(latin.encoding, 'Windows-1252');
});

test('parse: quotes, doubled quotes, separators and line breaks inside values, CRLF, blank lines', () => {
  const { records, delimiter } = csv.parse('name,note\r\n"Smith, Jo","said ""hi""\nthen left"\r\n\r\nplain,\r\n');
  assert.strictEqual(delimiter, ',');
  assert.deepStrictEqual(records, [['name', 'note'], ['Smith, Jo', 'said "hi"\nthen left'], ['plain', '']]);
});

test('parse: a last line without a line break, a lone CR, and an empty quoted value', () => {
  assert.deepStrictEqual(csv.parse('a,b\r1,""\r2,x').records, [['a', 'b'], ['1', ''], ['2', 'x']]);
});

test('parse: semicolons and tabs are found from the first line, and quoted separators do not count', () => {
  assert.strictEqual(csv.parse('a;b;c\n1;2;3').delimiter, ';');
  assert.deepStrictEqual(csv.parse('a\tb\n1\t2').records, [['a', 'b'], ['1', '2']]);
  assert.strictEqual(csv.parse('"a,b,c";d\n1;2').delimiter, ';');
});

test('parse: a quote in the middle of a value is kept; an unclosed quote and too many rows or columns are refused', () => {
  assert.deepStrictEqual(csv.parse('a,b\n5" disk,x').records[1], ['5" disk', 'x']);
  assert.throws(() => csv.parse('a,b\n"open,x'), csv.CsvError);
  assert.throws(() => csv.parse('a\n1\n2\n3', { maxRecords: 3 }), /more than 2 rows/);
  assert.throws(() => csv.parse('a,b,c', { maxColumns: 2 }), /columns/);
});

test('cleanCell trims, and undoes the apostrophe NovaDesk puts in front of = + - @ when it exports', () => {
  assert.strictEqual(csv.cleanCell('  x  '), 'x');
  assert.strictEqual(csv.cleanCell("'=SUM(A1)"), '=SUM(A1)');
  assert.strictEqual(csv.cleanCell("'-5"), '-5');
  assert.strictEqual(csv.cleanCell("it's"), "it's");
  assert.strictEqual(csv.cleanCell("'quoted'"), "'quoted'", 'an apostrophe in front of anything else is the person\'s own');
  assert.strictEqual(csv.cleanCell(null), '');
});

test('headerKey makes IP Address, ip_address and IP-address the same', () => {
  assert.strictEqual(csv.headerKey('IP Address'), csv.headerKey('ip_address'));
  assert.strictEqual(csv.headerKey('IP-address '), 'ipaddress');
});

// ---------------------------------------------------------------------------------------------------------------- columns
test('readTable: spellings of the column names, ignored and unknown columns, missing required ones', () => {
  const t = readTable(KINDS.cmdb, 'CI Number,Name,Type,IP Address,Date (Added),Colour\nCI0000001,a,Server,1.1.1.1,2026-01-01,red', 'add');
  assert.deepStrictEqual(t.used, ['CI Number', 'Name', 'Type', 'IP Address']);
  assert.deepStrictEqual(t.ignored, ['Date (Added)']);
  assert.deepStrictEqual(t.unknown, ['Colour']);
  assert.throws(() => readTable(KINDS.cmdb, 'Name,Location\nx,y', 'add'), /"Type"/);
  assert.doesNotThrow(() => readTable(KINDS.cmdb, 'Name,Location\nx,y', 'update'), 'a type is only needed for an item that is new');
  assert.throws(() => readTable(KINDS.cmdb, 'Location,Notes\nx,y', 'update'), /CI Number" or a "Name/);
  assert.throws(() => readTable(KINDS.users, 'full name,email\nx,y', 'add'), /"Username"/);
  assert.throws(() => readTable(KINDS.users, 'foo,bar\n1,2', 'add'), /None of the column names/);
  assert.throws(() => readTable(KINDS.users, 'username,login\nx,y', 'add'), /Two columns/);
  assert.throws(() => readTable(KINDS.users, '', 'add'), ImportError);
});

// ---------------------------------------------------------------------------------------------------------------- users
const person = (o) => ({ id: 10, username: 'sam', full_name: 'Sam Lee', email: 'sam@c.test', role: 'user', department: null, active: 1, ...o });
const planUsers = (text, { mode = 'add', rows = [person(), { id: 1, username: 'admin', full_name: 'A', email: null, role: 'admin', department: null, active: 1 }], groups = {} } = {}) =>
  buildPlan(KINDS.users, text, { mode }, admin, { rows, groups }).then((p) => p.items);

test('users: new people, defaults, and what is wrong with a row', async () => {
  const items = await planUsers([
    'username,full_name,email,role,groups,active',
    'kim,Kim Ng,kim@c.test,agent,IRO-Windows;iro-unix,yes',   // 2 ok
    'x,Short Name,,,,',                                       // 3 username too short
    'pat,,,,,',                                               // 4 no full name
    'lee,Lee,lee@c.test,boss,,',                              // 5 bad role
    'ann,Ann,not-an-email,,,',                                // 6 bad email
    'bob,Bob,,,Cooks,',                                       // 7 bad group
    'kim,Kim Again,,,,',                                      // 8 same user twice
    'zed,Zed,sam@c.test,,,',                                  // 9 email belongs to sam
    'amy,Amy,,,,maybe',                                       // 10 bad active
    ',,,,,',                                                  // blank row: left out entirely
  ].join('\n'));
  const by = Object.fromEntries(items.map((i) => [i.row, i]));
  assert.strictEqual(by[2].action, 'add');
  assert.deepStrictEqual(by[2].data.groups, ['IRO-Windows', 'IRO-UNIX']);
  assert.strictEqual(by[2].data.role, 'agent');
  assert.match(by[3].message, /Username can only hold/);
  assert.match(by[4].message, /Full name is empty/);
  assert.match(by[5].message, /Role "boss"/);
  assert.match(by[6].message, /not an email/);
  assert.match(by[7].message, /Unknown assignment group: Cooks/);
  assert.match(by[8].message, /Same username as row 2/);
  assert.match(by[9].message, /already belongs to sam/);
  assert.match(by[10].message, /Active "maybe"/);
  assert.strictEqual(items.length, 9, 'the empty row is not a row');
  assert.ok(items.filter((i) => i.action === 'error').length === 8);
});

test('users: two new people cannot share an email, and a weak password is refused', async () => {
  const items = await planUsers('username,full_name,email,password\na1,A One,same@c.test,\na2,A Two,SAME@c.test,\na3,A Three,,short\na4,A Four,,Correct-Horse-9');
  assert.strictEqual(items[0].action, 'add');
  assert.match(items[1].message, /already belongs to a1/);
  assert.match(items[2].message, /at least \d+ characters/);
  assert.strictEqual(items[3].action, 'add');
  assert.strictEqual(items[3].data.password, 'Correct-Horse-9');
});

test('users: existing people are left alone, or updated only where the file has something to say', async () => {
  const text = 'username,full_name,email,department,groups\nSAM,,,Finance,IRO-ServiceDesk\nsam2,New,,,';
  const add = await planUsers(text);
  assert.strictEqual(add[0].action, 'skip', 'matched without regard to capitals');
  const upd = await planUsers(text, { mode: 'update' });
  assert.strictEqual(upd[0].action, 'update');
  assert.deepStrictEqual(upd[0].data.changes, { department: 'Finance' }, 'an empty cell changes nothing');
  assert.deepStrictEqual(upd[0].data.groups, ['IRO-ServiceDesk']);
  assert.strictEqual(upd[1].action, 'add');
  const same = await planUsers('username,full_name,department\nsam,Sam Lee,', { mode: 'update' });
  assert.strictEqual(same[0].action, 'unchanged');
  const pw = await planUsers('username,password\nsam,Correct-Horse-9', { mode: 'update' });
  assert.strictEqual(pw[0].action, 'error', 'passwords are not set through an import for people who exist');
});

test('users: nobody can lock themselves or the last administrator out through a file', async () => {
  const rows = [{ id: 1, username: 'admin', full_name: 'A', email: null, role: 'admin', department: null, active: 1 }, person({ id: 2, username: 'boss', role: 'admin' })];
  const self = await planUsers('username,role\nadmin,user', { mode: 'update', rows });
  assert.match(self[0].message, /Your own role/);
  const one = await planUsers('username,active\nboss,no', { mode: 'update', rows });
  assert.strictEqual(one[0].action, 'update', 'another administrator remains');
  const both = await planUsers('username,active\nboss,no\nadmin,no', { mode: 'update', rows });
  assert.match(both[1].message, /Your own role/);
  const alone = await planUsers('username,role\nboss,user', { mode: 'update', rows: [person({ id: 2, username: 'boss', role: 'admin' }), person({ id: 3, username: 'gone', role: 'admin', active: 0 })] });
  assert.match(alone[0].message, /without an active administrator/);
});

// ---------------------------------------------------------------------------------------------------------------- CIs
const ci = (o) => ({ id: 1, ci_number: 'CI0000001', name: 'WEB-01', ci_type: 'server', environment: 'production', status: 'in_use', ip_address: '10.0.0.5', os: null, owner_id: null, notes: null, ...o });
const people = [{ id: 7, username: 'sam', email: 'sam@c.test', full_name: 'Sam Lee' }, { id: 8, username: 'sam2', email: 'sam2@c.test', full_name: 'Sam Lee' }, { id: 9, username: 'kim', email: 'kim@c.test', full_name: 'Kim Ng' }];
const planCis = (text, { mode = 'add', cis = [ci()] } = {}) => buildPlan(KINDS.cmdb, text, { mode }, admin, { cis, people }).then((p) => p.items);

test('cmdb: types, environments and statuses by key or by label; dates; owners', async () => {
  const items = await planCis([
    'Name,Type,Environment,Status,Owner,Warranty Expiry,IP Address',
    'APP-01,Network Device,DR,in stock,kim,2027-02-30,1.1.1.1',      // 2 impossible date
    'APP-02,network_device,Disaster Recovery,In Stock,kim@c.test,2027-02-28,1.1.1.2',   // 3 ok
    'APP-03,Toaster,,,,,',                                           // 4 bad type
    'APP-04,Server,Moon,,,,',                                        // 5 bad environment
    'APP-05,Server,,Broken,,,',                                      // 6 bad status
    'APP-06,Server,,,Sam Lee,,',                                     // 7 two people with that name
    'APP-07,Server,,,nobody,,',                                      // 8 no such owner
    'APP-08,Server,prod,,,,',                                        // 9 ok, synonym
    ',Server,,,,,',                                                  // 10 no name, no number
  ].join('\n'));
  const by = Object.fromEntries(items.map((i) => [i.row, i]));
  assert.match(by[2].message, /not a date written YYYY-MM-DD/);
  assert.strictEqual(by[3].action, 'add');
  assert.deepStrictEqual([by[3].data.ci_type, by[3].data.environment, by[3].data.status, by[3].data.owner_id, by[3].data.warranty_expiry], ['network_device', 'dr', 'in_stock', 9, '2027-02-28']);
  assert.match(by[4].message, /Type "Toaster"/);
  assert.match(by[5].message, /Environment "Moon"/);
  assert.match(by[6].message, /Status "Broken"/);
  assert.match(by[7].message, /matches 2 people \(sam, sam2\)/);
  assert.match(by[8].message, /"nobody" is not an active user/);
  assert.strictEqual(by[9].data.environment, 'production');
  assert.match(by[10].message, /Neither a CI Number nor a Name/);
});

test('cmdb: an item is found by CI number, else by name (and type); copies in the file and ambiguity are refused', async () => {
  const cis = [ci(), ci({ id: 2, ci_number: 'CI0000002', name: 'DB-01', ci_type: 'database' }), ci({ id: 3, ci_number: 'CI0000003', name: 'DUP', ci_type: 'server' }), ci({ id: 4, ci_number: 'CI0000004', name: 'DUP', ci_type: 'database' })];
  const text = ['CI Number,Name,Type,Location', ',web-01,Server,Rack 1', 'CI0000002,,,Rack 2', 'CI0000009,Brand New,Server,Rack 3', ',DUP,,Rack 4', ',DUP,Database,Rack 5', ',web-01,Server,Rack 6', ',New One,Server,', ',new one,Server,'].join('\n');
  const add = await planCis(text, { cis });
  assert.deepStrictEqual(add.map((i) => i.action), ['skip', 'skip', 'add', 'error', 'skip', 'error', 'add', 'error']);
  assert.match(add[2].message, /CI0000009 is not in NovaDesk, so a new number is given/);
  assert.match(add[3].message, /More than one item is called "DUP" \(CI0000003, CI0000004\)/);
  assert.match(add[5].message, /already dealt with in row 2/);
  assert.match(add[7].message, /Same name and type as row 8/);
  const upd = await planCis(text, { mode: 'update', cis });
  assert.strictEqual(upd[0].action, 'update');
  assert.deepStrictEqual(upd[0].data.changes, { location: 'Rack 1' });
  assert.deepStrictEqual(upd[1].data.changes, { location: 'Rack 2' });
});

test('cmdb: updating changes only what the file says, and says so when nothing differs', async () => {
  const upd = await planCis('CI Number,IP Address,OS,Owner,Status\nCI0000001,10.0.0.5,RHEL 9,sam,\nCI0000001,,,,', { mode: 'update' });
  assert.deepStrictEqual(upd[0].data.changes, { os: 'RHEL 9', owner_id: 7 });
  assert.strictEqual(upd[1].action, 'error', 'the same item twice');
  const same = await planCis('CI Number,IP Address,Status\nCI0000001,10.0.0.5,In Use', { mode: 'update' });
  assert.strictEqual(same[0].action, 'unchanged');
});

test('cmdb: a file exported by NovaDesk (apostrophe-guarded values, Date (Added), full-name owners) reads back', async () => {
  const text = "CI Number,Name,Type,Environment,Status,IP Address,OS,Location,Date (Added),Owner,Serial Number,Warranty Expiry\nCI0000001,WEB-01,Server,Production,In Use,10.0.0.5,'-weird os,Rack 1,2026-01-01 10:00:00,Kim Ng,'=SN1,2027-01-01";
  const [item] = await planCis(text, { mode: 'update' });
  assert.strictEqual(item.action, 'update');
  assert.deepStrictEqual(item.data.changes, { os: '-weird os', location: 'Rack 1', owner_id: 9, serial_number: '=SN1', warranty_expiry: '2027-01-01' });
});

// ---------------------------------------------------------------------------------------------------------------- KB
const article = (o) => ({ id: 1, number: 'KB0000001', title: 'Reset VPN', category: 'network', body: 'Do this', status: 'published', ...o });
const planKb = (text, { mode = 'add', defaultStatus = 'draft', articles = [article()] } = {}) => buildPlan(KINDS.kb, text, { mode, defaultStatus }, admin, { articles }).then((p) => p.items);

test('kb: new articles default to draft (or published when asked), existing ones are matched by number or title', async () => {
  const text = 'Title,Category,Body\nNew one,,Text\nreset vpn,x,y\n,,';
  const d = await planKb(text);
  assert.deepStrictEqual([d[0].action, d[0].data.status, d[0].data.category], ['add', 'draft', 'general']);
  assert.strictEqual(d[1].action, 'skip');
  assert.strictEqual(d.length, 2);
  const p = await planKb(text, { defaultStatus: 'published' });
  assert.strictEqual(p[0].data.status, 'published');
  const u = await planKb('Number,Body,Status\nKB0000001,New text,draft\nKB0000001,again,', { mode: 'update' });
  assert.deepStrictEqual(u[0].data.changes, { body: 'New text', status: 'draft' });
  assert.match(u[1].message, /already dealt with in row 2/);
});

test('kb: what a new article needs, and the export format round trips (Author, Views, Created and Updated are left out)', async () => {
  const items = await planKb('Title,Body\nNo body,\n,Text only\nTwo,x\nTWO,y');
  assert.match(items[0].message, /Body is empty/);
  assert.match(items[1].message, /Neither a Number nor a Title/);
  assert.match(items[3].message, /Same title as row 4/);
  const renamed = await planKb('Number,Title\nKB0000001,Reset the VPN', { mode: 'update' });
  assert.deepStrictEqual(renamed[0].data.changes, { title: 'Reset the VPN' }, 'by number, the title can be changed');
  const t = readTable(KINDS.kb, 'Number,Title,Category,Status,Author,Views,Body,Created,Updated\nKB0000001,T,c,published,Al,3,B,x,y', 'add');
  assert.deepStrictEqual(t.ignored, ['Author', 'Views', 'Created', 'Updated']);
});
