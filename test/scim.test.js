// The parts of SCIM that need no database: the filter language, PATCH in the shapes providers send, the mapping between a
// person and a SCIM User, tokens, and the discovery documents. What happens to real rows is checked by scripts/scim-check.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const F = require('../src/scim/filter');
const R = require('../src/scim/resource');
const { applyPatch, parsePath } = require('../src/scim/patch');
const { errorBody, ScimError } = require('../src/scim/errors');
const tokens = require('../src/scim/tokens');
const discovery = require('../src/scim/discovery');
const { slug, GROUPS } = require('../src/scim/service');

const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const ENT = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
const ATTRS = { username: { sql: 'username' }, externalid: { sql: 'scim_external_id', fold: false }, active: { sql: 'active', kind: 'bool' }, 'emails.value': { sql: 'email' } };
const throwsScim = (fn, type, pattern) => assert.throws(fn, (e) => e instanceof ScimError && (!type || e.scimType === type) && (!pattern || pattern.test(e.detail)), `${type} ${pattern}`);

// ---------------------------------------------------------------- filter
test('filter: the comparison operators, case-insensitive keywords, quoted values with escapes', () => {
  assert.deepStrictEqual(F.parse('userName EQ "a@b.test"'), { op: 'eq', attr: 'userName', value: 'a@b.test' });
  assert.deepStrictEqual(F.parse('x co "say \\"hi\\" \\\\ \\u00e9"'), { op: 'co', attr: 'x', value: 'say "hi" \\ é' });
  assert.deepStrictEqual(F.parse('title pr'), { op: 'pr', attr: 'title' });
  assert.deepStrictEqual(F.parse('active eq TRUE'), { op: 'eq', attr: 'active', value: true });
  assert.deepStrictEqual(F.parse('a eq null'), { op: 'eq', attr: 'a', value: null });
  assert.deepStrictEqual(F.parse('n eq 5'), { op: 'eq', attr: 'n', value: 5 });
  for (const op of ['ne', 'sw', 'ew']) assert.strictEqual(F.parse(`a ${op} "x"`).op, op);
});

test('filter: and binds tighter than or, brackets and not change that', () => {
  const t = F.parse('a eq "1" or b eq "2" and c eq "3"');
  assert.strictEqual(t.op, 'or'); assert.strictEqual(t.right.op, 'and');
  const u = F.parse('(a eq "1" or b eq "2") and not (c eq "3")');
  assert.strictEqual(u.op, 'and'); assert.strictEqual(u.left.op, 'or'); assert.strictEqual(u.right.op, 'not');
});

test('filter: a malformed filter is invalidFilter with a sentence that says what is wrong', () => {
  const bad = [['', /empty/], ['userName', /operator/], ['userName eq', /value/], ['userName eq jane', /double quotes/], ['userName xx "a"', /not a filter operator/],
    ['a gt "1"', /not supported/], ['a eq "1" and', /expected/], ['(a eq "1"', /never closed/], ['a eq "1")', /left over/], ['a eq "open', /never closed/], ['emails[type eq "work"] pr', /square brackets/],
    ['not a eq "1"', /in brackets/], ['a eq "1" b eq "2"', /left over/], ['a eq "\\q"', /invalid escape/]];
  for (const [text, re] of bad) throwsScim(() => F.parse(text), 'invalidFilter', re);
  throwsScim(() => F.parse('a eq "' + 'x'.repeat(1001) + '"'), 'invalidFilter', /longer than/);
  throwsScim(() => F.parse(Array(60).fill('a eq "1"').join(' and ')), 'invalidFilter', /too many/);
  throwsScim(() => F.parse('('.repeat(30) + 'a eq "1"' + ')'.repeat(30)), 'invalidFilter', /deeply/);
  throwsScim(() => F.parse(null), 'invalidFilter');
});

test('filter to SQL: only known attributes, values only as parameters, wildcards escaped, case folded', () => {
  const c = F.toSql(F.parse('userName eq "Jane@X.test" and (active eq true or externalId sw "100%_") and emails.value pr'), ATTRS);
  assert.strictEqual(c.sql, "(((lower(username) = ?) AND ((active = 1) OR (scim_external_id LIKE ? ESCAPE '\\'))) AND (email IS NOT NULL AND email <> ''))");
  assert.deepStrictEqual(c.params, ['jane@x.test', '100\\%\\_%']);
  assert.deepStrictEqual(F.toSql(F.parse('userName co "a"'), ATTRS).params, ['%a%']);
  assert.deepStrictEqual(F.toSql(F.parse('userName ew "a"'), ATTRS).params, ['%a']);
  assert.strictEqual(F.toSql(F.parse('externalId eq "AbC"'), ATTRS).params[0], 'AbC', 'externalId is case-exact');
  assert.ok(/IS NULL/.test(F.toSql(F.parse('externalId eq null'), ATTRS).sql));
  assert.ok(/NOT NULL/.test(F.toSql(F.parse('externalId ne null'), ATTRS).sql));
  assert.ok(/IS NULL OR/.test(F.toSql(F.parse('userName ne "x"'), ATTRS).sql), 'ne includes people with no value');
});

test('filter to SQL: an injection attempt is only ever a value; an unknown attribute is refused', () => {
  const c = F.toSql(F.parse(`userName eq "x' OR 1=1 --"`), ATTRS);
  assert.ok(!/OR 1=1/.test(c.sql)); assert.deepStrictEqual(c.params, ["x' or 1=1 --"]);
  throwsScim(() => F.toSql(F.parse('password eq "x"'), ATTRS), 'invalidFilter', /cannot be filtered on/);
  throwsScim(() => F.toSql(F.parse('username; DROP TABLE users eq "x"'), ATTRS), 'invalidFilter');
  throwsScim(() => F.toSql(F.parse('active eq "yes"'), ATTRS), 'invalidFilter', /true or false/);
  throwsScim(() => F.toSql(F.parse('active co true'), ATTRS), 'invalidFilter');
  throwsScim(() => F.toSql(F.parse('userName co null'), ATTRS), 'invalidFilter', /null/);
});

test('filter: the full URN of an attribute is accepted, whatever its capitals', () => {
  const c = F.toSql(F.parse('urn:ietf:params:scim:schemas:core:2.0:User:USERNAME eq "a"'), ATTRS);
  assert.deepStrictEqual(c.params, ['a']);
});

test('filter evaluated on plain objects (groups): the same operators, any capitals', () => {
  const g = { id: 'iro-unix', name: 'IRO-UNIX' };
  const get = { id: (x) => x.id, displayname: (x) => x.name };
  const ev = (f) => F.evaluate(F.parse(f), g, get);
  assert.ok(ev('displayName eq "iro-unix"')); assert.ok(!ev('displayName eq "IRO"')); assert.ok(ev('displayName sw "iro"')); assert.ok(ev('displayName ew "UNIX"')); assert.ok(ev('displayName co "-u"'));
  assert.ok(ev('id eq "iro-unix" and not (displayName eq "x")')); assert.ok(ev('displayName eq "x" or id pr')); assert.ok(ev('displayName ne "x"'));
  throwsScim(() => F.evaluate(F.parse('members eq "1"'), g, get), 'invalidFilter');
});

// ---------------------------------------------------------------- resource
test('a SCIM User becomes the internal model: names, the right email, text booleans, roles, department', () => {
  const m = R.parseUser({
    schemas: [R.CORE_USER], userName: '  Jane@Corp.test ', externalId: 'ext-1', name: { givenName: 'Jane', familyName: 'Doe' },
    emails: [{ value: 'old@corp.test', type: 'home' }, { value: 'jane@corp.test', type: 'work', primary: true }], active: 'False',
    roles: [{ value: 'Agent', primary: true }], [ENT]: { department: ' Ops ' }, password: 'ignored', title: 'ignored',
  });
  assert.deepStrictEqual(m, { userName: 'Jane@Corp.test', externalId: 'ext-1', fullName: 'Jane Doe', email: 'jane@corp.test', active: false, role: 'agent', department: 'Ops' });
});

test('the name: displayName wins, then formatted, then the parts; with none the field is left out', () => {
  assert.strictEqual(R.parseUser({ userName: 'ab', displayName: 'D', name: { formatted: 'F', givenName: 'G' } }).fullName, 'D');
  assert.strictEqual(R.parseUser({ userName: 'ab', name: { formatted: 'F', givenName: 'G' } }).fullName, 'F');
  assert.strictEqual(R.parseUser({ userName: 'ab', name: { givenName: 'G', familyName: 'H' } }).fullName, 'G H');
  assert.strictEqual(R.parseUser({ userName: 'ab' }).fullName, undefined);
  assert.deepStrictEqual(R.splitName('Jane van Doe'), { givenName: 'Jane', familyName: 'van Doe' });
  assert.deepStrictEqual(R.splitName('Cher'), { givenName: 'Cher', familyName: '' });
});

test('a SCIM User that is wrong is refused with invalidValue or invalidSyntax', () => {
  const ok = { userName: 'jane@x.test' };
  throwsScim(() => R.parseUser(null), 'invalidSyntax'); throwsScim(() => R.parseUser([]), 'invalidSyntax');
  throwsScim(() => R.parseUser({ schemas: ['urn:other'], userName: 'ab' }), 'invalidSyntax', /schemas/);
  throwsScim(() => R.parseUser({}), 'invalidValue', /userName is required/); throwsScim(() => R.parseUser({ userName: '  ' }), 'invalidValue'); throwsScim(() => R.parseUser({ userName: 5 }), 'invalidValue');
  throwsScim(() => R.parseUser({ userName: 'a' }), 'invalidValue', /2 to 64/); throwsScim(() => R.parseUser({ userName: 'has space' }), 'invalidValue'); throwsScim(() => R.parseUser({ userName: 'x'.repeat(65) }), 'invalidValue');
  throwsScim(() => R.parseUser({ ...ok, emails: [{ value: 'not-an-email' }] }), 'invalidValue', /not an email/); throwsScim(() => R.parseUser({ ...ok, emails: 'x' }), 'invalidValue');
  throwsScim(() => R.parseUser({ ...ok, active: 'maybe' }), 'invalidValue', /true or false/); throwsScim(() => R.parseUser({ ...ok, active: 1 }), 'invalidValue');
  throwsScim(() => R.parseUser({ ...ok, roles: [{ value: 'superuser' }] }), 'invalidValue', /not a role/);
  throwsScim(() => R.parseUser({ ...ok, displayName: 'x'.repeat(201) }), 'invalidValue', /longer than/); throwsScim(() => R.parseUser({ ...ok, name: 'x' }), 'invalidValue');
  throwsScim(() => R.parseUser({ ...ok, [ENT]: 'x' }), 'invalidValue'); throwsScim(() => R.parseUser({ ...ok, externalId: 5 }), 'invalidValue');
});

test('an email without a primary: a work one, else the first; an empty list means none; null clears', () => {
  assert.strictEqual(R.parseUser({ userName: 'ab', emails: [{ value: 'a@b.co' }, { value: 'w@b.co', type: 'work' }] }).email, 'w@b.co');
  assert.strictEqual(R.parseUser({ userName: 'ab', emails: [{ value: 'a@b.co' }, { value: 'c@b.co' }] }).email, 'a@b.co');
  assert.strictEqual(R.parseUser({ userName: 'ab', emails: [] }).email, null);
  assert.strictEqual(R.parseUser({ userName: 'ab', emails: null }).email, null);
  assert.strictEqual(R.parseUser({ userName: 'ab' }).email, undefined, 'not mentioned is not the same as cleared');
});

test('a person as SCIM: schemas, id as text, name in parts, email, role, groups and meta in ISO time', () => {
  const row = { id: 12, username: 'jane@x.test', full_name: 'Jane van Doe', email: 'jane@x.test', active: 1, role: 'agent', department: 'Ops', scim_external_id: 'e1', created_at: '2026-10-30 01:02:03', scim_updated_at: '2026-10-31 04:05:06' };
  const u = R.toScim(row, { baseUrl: 'https://h/scim/v2', groups: [{ id: 'iro-unix', name: 'IRO-UNIX' }] });
  assert.deepStrictEqual(u.schemas, [R.CORE_USER, R.ENTERPRISE_USER]); assert.strictEqual(u.id, '12'); assert.strictEqual(u.externalId, 'e1');
  assert.deepStrictEqual(u.name, { formatted: 'Jane van Doe', givenName: 'Jane', familyName: 'van Doe' }); assert.strictEqual(u.active, true);
  assert.deepStrictEqual(u.emails, [{ value: 'jane@x.test', type: 'work', primary: true }]); assert.deepStrictEqual(u.roles, [{ value: 'agent', primary: true }]);
  assert.deepStrictEqual(u.groups, [{ value: 'iro-unix', display: 'IRO-UNIX', $ref: 'https://h/scim/v2/Groups/iro-unix' }]);
  assert.deepStrictEqual(u[ENT], { department: 'Ops' });
  assert.deepStrictEqual(u.meta, { resourceType: 'User', created: '2026-10-30T01:02:03Z', lastModified: '2026-10-31T04:05:06Z', location: 'https://h/scim/v2/Users/12' });
  const bare = R.toScim({ id: 1, username: 'x', full_name: 'X', email: null, active: 0, role: 'user', department: null, scim_external_id: null, created_at: '2026-01-01 00:00:00' });
  assert.ok(!('emails' in bare) && !('externalId' in bare) && bare.active === false && bare.meta.lastModified === '2026-01-01T00:00:00Z' && !('password' in bare));
});

test('attributes and excludedAttributes trim the answer but keep schemas and id', () => {
  const u = { schemas: ['s'], id: '1', userName: 'a', name: { givenName: 'G', familyName: 'F' }, emails: [1], meta: { x: 1 } };
  assert.deepStrictEqual(Object.keys(R.project(u, { attributes: 'userName' })).sort(), ['id', 'schemas', 'userName']);
  assert.deepStrictEqual(R.project(u, { attributes: 'name.givenName' }).name, { givenName: 'G' });
  assert.ok(!('emails' in R.project(u, { excludedAttributes: 'emails,meta' })) && 'name' in R.project(u, { excludedAttributes: 'emails' }));
  assert.strictEqual(R.project(u, {}), u);
});

// ---------------------------------------------------------------- patch
const cur = () => ({ userName: 'jane@x.test', externalId: null, fullName: 'Jane Doe', email: 'jane@x.test', active: true, role: 'user', department: 'Sales' });
const patch = (ops, current = cur()) => applyPatch({ schemas: [PATCH], Operations: ops }, current);

test('patch: Microsoft Entra ID style (capitalised op, "False" as text, filtered email path, enterprise department path)', () => {
  const m = patch([{ op: 'Replace', path: 'active', value: 'False' }, { op: 'Replace', path: 'emails[type eq "work"].value', value: 'new@x.test' }, { op: 'Replace', path: `${ENT}:department`, value: 'Ops' }, { op: 'Add', path: 'externalId', value: 'e9' }]);
  assert.deepStrictEqual(m, { userName: 'jane@x.test', externalId: 'e9', fullName: 'Jane Doe', email: 'new@x.test', active: false, role: 'user', department: 'Ops' });
});

test('patch: Okta style (no path, an object whose keys are paths, dotted names, ignored attributes)', () => {
  const m = patch([{ op: 'replace', value: { active: true, 'name.givenName': 'Janet', 'name.familyName': 'Roe', title: 'Boss', phoneNumbers: [{ value: '1' }], [ENT]: { department: 'IT' } } }], { ...cur(), active: false });
  assert.deepStrictEqual([m.active, m.fullName, m.department], [true, 'Janet Roe', 'IT']);
  const n = patch([{ op: 'replace', path: 'name', value: { givenName: 'A', familyName: 'B' } }, { op: 'replace', path: 'userName', value: 'new@x.test' }]);
  assert.deepStrictEqual([n.fullName, n.userName], ['A B', 'new@x.test']);
  assert.strictEqual(patch([{ op: 'replace', path: 'displayName', value: 'Dee' }]).fullName, 'Dee');
});

test('patch: removing, adding, the roles and the emails list forms', () => {
  assert.strictEqual(patch([{ op: 'remove', path: 'emails' }]).email, null);
  assert.strictEqual(patch([{ op: 'remove', path: 'externalId' }], { ...cur(), externalId: 'x' }).externalId, null);
  assert.strictEqual(patch([{ op: 'remove', path: `${ENT}:department` }]).department, null);
  assert.strictEqual(patch([{ op: 'remove', path: 'title' }]).fullName, 'Jane Doe');
  assert.strictEqual(patch([{ op: 'add', path: 'emails', value: [{ value: 'a@x.test', primary: true }] }]).email, 'a@x.test');
  assert.strictEqual(patch([{ op: 'replace', path: 'emails', value: [{ value: 'b@x.test' }] }]).email, 'b@x.test');
  assert.strictEqual(patch([{ op: 'replace', path: 'roles', value: [{ value: 'agent' }] }]).role, 'agent');
  assert.strictEqual(patch([{ op: 'replace', path: 'roles', value: 'agent' }]).role, 'agent');
  assert.strictEqual(patch([{ op: 'replace', path: 'roles', value: [] }]).role, 'user', 'an empty list changes nothing');
  assert.strictEqual(patch([{ op: 'replace', path: 'name.givenName', value: 'Zed' }]).fullName, 'Zed Doe');
  assert.strictEqual(patch([{ op: 'replace', path: 'name.middleName', value: 'M' }]).fullName, 'Jane Doe');
});

test('patch: operations apply in order, and the input is never modified', () => {
  const before = cur();
  const m = patch([{ op: 'replace', path: 'active', value: false }, { op: 'replace', path: 'active', value: true }, { op: 'replace', path: 'userName', value: 'final@x.test' }], before);
  assert.strictEqual(m.active, true); assert.strictEqual(m.userName, 'final@x.test'); assert.deepStrictEqual(before, cur());
});

test('patch: a bad request is refused with the right scimType', () => {
  throwsScim(() => applyPatch(null, cur()), 'invalidSyntax'); throwsScim(() => applyPatch({ schemas: ['x'], Operations: [{}] }, cur()), 'invalidSyntax', /schemas/);
  throwsScim(() => applyPatch({ schemas: [PATCH] }, cur()), 'invalidSyntax', /Operations/); throwsScim(() => patch([]), 'invalidSyntax');
  throwsScim(() => patch(Array(101).fill({ op: 'replace', path: 'active', value: true })), 'invalidSyntax', /100/);
  throwsScim(() => patch([{ op: 'move', path: 'active' }]), 'invalidSyntax', /not an operation/); throwsScim(() => patch([5]), 'invalidSyntax');
  throwsScim(() => patch([{ op: 'remove' }]), 'noTarget', /needs a path/); throwsScim(() => patch([{ op: 'remove', path: 'userName' }]), 'noTarget'); throwsScim(() => patch([{ op: 'remove', path: 'active' }]), 'noTarget');
  throwsScim(() => patch([{ op: 'replace', path: 'active' }]), 'invalidValue', /needs a value/); throwsScim(() => patch([{ op: 'replace', value: 'x' }]), 'invalidValue', /object/);
  throwsScim(() => patch([{ op: 'replace', path: 'active', value: 'perhaps' }]), 'invalidValue'); throwsScim(() => patch([{ op: 'replace', path: 'userName', value: 'a b' }]), 'invalidValue');
  throwsScim(() => patch([{ op: 'replace', path: 'emails.value', value: 'nope' }]), 'invalidValue'); throwsScim(() => patch([{ op: 'replace', path: 'roles', value: [{ value: 'root' }] }]), 'invalidValue');
  throwsScim(() => patch([{ op: 'replace', path: 'bogusAttribute', value: 1 }]), 'invalidPath', /not an attribute/); throwsScim(() => patch([{ op: 'replace', path: 'a b c', value: 1 }]), 'invalidPath');
  throwsScim(() => patch([{ op: 'replace', path: `${ENT}:nonsense`, value: 1 }]), 'invalidPath');
});

test('patch paths: core and enterprise URNs, filters, sub-attributes', () => {
  assert.deepStrictEqual(parsePath('urn:ietf:params:scim:schemas:core:2.0:User:userName'), { ext: false, attr: 'username', sub: null, filter: null });
  assert.deepStrictEqual(parsePath('emails[type eq "work"].value'), { ext: false, attr: 'emails', sub: 'value', filter: 'type eq "work"' });
  assert.deepStrictEqual(parsePath(`${ENT}:department`), { ext: true, attr: 'department', sub: null, filter: null });
  assert.deepStrictEqual(parsePath(ENT), { ext: true, attr: '', sub: null, filter: null });
  assert.deepStrictEqual(parsePath('name.givenName'), { ext: false, attr: 'name', sub: 'givenname', filter: null });
});

// ---------------------------------------------------------------- errors, tokens, groups, discovery
test('an error is the SCIM Error schema with the status as text, and scimType only when there is one', () => {
  assert.deepStrictEqual(errorBody(new ScimError(409, 'uniqueness', 'taken')), { schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '409', scimType: 'uniqueness', detail: 'taken' });
  assert.deepStrictEqual(errorBody(new ScimError(404, null, 'gone')), { schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '404', detail: 'gone' });
});

test('tokens: 40 random characters after nds_, only a hash is derived, malformed ones are never looked up', () => {
  const t = tokens.newToken();
  assert.ok(tokens.looksLikeToken(t) && /^nds_[A-Za-z0-9_-]{40}$/.test(t));
  assert.notStrictEqual(t, tokens.newToken());
  assert.strictEqual(tokens.hashToken(t).length, 64); assert.notStrictEqual(tokens.hashToken(t), t);
  for (const bad of ['', null, undefined, 'nds_short', `ndk_${'a'.repeat(40)}`, `nds_${'a'.repeat(41)}`, `nds_${'a'.repeat(39)}!`]) assert.ok(!tokens.looksLikeToken(bad), String(bad));
  const now = Date.UTC(2026, 9, 30, 12);
  assert.strictEqual(tokens.expiryFrom(90, now), '2027-01-28 12:00:00'); assert.strictEqual(tokens.expiryFrom(null, now), null);
});

test('groups: a stable id from the name, one for each assignment group, no two alike', () => {
  assert.strictEqual(slug('IRO-Build/Decom'), 'iro-build-decom'); assert.strictEqual(slug('IRO-Network/Security'), 'iro-network-security');
  assert.strictEqual(GROUPS.length, 8); assert.strictEqual(new Set(GROUPS.map((g) => g.id)).size, 8);
  assert.ok(GROUPS.every((g) => /^[a-z0-9-]+$/.test(g.id)));
});

test('discovery: says what is really supported (patch and filters yes; bulk, sort, etag and passwords no)', () => {
  const c = discovery.serviceProviderConfig('https://h/scim/v2', { maxResults: 100 });
  assert.strictEqual(c.patch.supported, true); assert.deepStrictEqual(c.filter, { supported: true, maxResults: 100 });
  for (const k of ['bulk', 'changePassword', 'sort', 'etag']) assert.strictEqual(c[k].supported, false, k);
  assert.strictEqual(c.authenticationSchemes[0].type, 'oauthbearertoken');
  const types = discovery.resourceTypes('https://h/scim/v2');
  assert.deepStrictEqual(types.map((t) => t.endpoint), ['/Users', '/Groups']); assert.strictEqual(types[0].schemaExtensions[0].schema, R.ENTERPRISE_USER);
  const s = discovery.schemas('https://h/scim/v2');
  assert.deepStrictEqual(s.map((x) => x.id), [R.CORE_USER, R.ENTERPRISE_USER, R.CORE_GROUP]);
  assert.ok(s[0].attributes.find((a) => a.name === 'userName').required && s[0].attributes.find((a) => a.name === 'groups').mutability === 'readOnly');
});
