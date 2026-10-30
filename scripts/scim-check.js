#!/usr/bin/env node
// SCIM provisioning, end to end, against copies of NovaDesk that this script starts itself (ports 18270-18272) on the
// database named by PGHOST, PGUSER, PGPASSWORD and PGDATABASE, with scripts/mock-oidc.js as the identity provider: tokens
// (who may make them, what they cannot do, expiry, revocation), the protocol the way Okta and Microsoft Entra ID speak it
// (discovery, create, find by filter, replace, patch, switch off, delete, paging, errors), the rules that protect an install
// (administrators, uniqueness, anonymised people, groups), single sign-on of a provisioned person, the audit log, rate limits.
// Needs the demonstration users. It adds its own people and leaves the settings as it found them.
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const knexLib = require('knex');
const { dbConfig } = require('../src/settings');
const tokens = require('../src/scim/tokens');

const ROOT = path.join(__dirname, '..');
let failed = 0; let section = '';
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  [${section}] ${name}${!ok && extra ? '  -- ' + String(extra).slice(0, 400) : ''}`); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Math.random().toString(36).slice(2, 7);

class Browser {
  constructor(base) { this.base = base; this.cookie = ''; this.csrf = null; }
  jar(res) { for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]; const j = Object.fromEntries(this.cookie.split('; ').filter(Boolean).map((x) => [x.split('=')[0], x])); j[kv.split('=')[0]] = kv; this.cookie = Object.values(j).join('; '); } }
  async raw(method, p, { form, headers = {} } = {}) {
    const h = { Cookie: this.cookie, ...headers }; let body;
    if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const res = await fetch(this.base + p, { method, headers: h, body, redirect: 'manual' });
    this.jar(res);
    const text = await res.text();
    const meta = text.match(/<meta name="csrf-token" content="([^"]+)"/); if (meta) this.csrf = meta[1];
    return { status: res.status, loc: res.headers.get('location'), text, headers: res.headers };
  }
  get(p) { return this.raw('GET', p); }
  async ensureToken() { if (!this.csrf) { await this.get('/login'); if (!this.csrf) await this.get('/profile'); } return this.csrf; }
  async post(p, form = {}, { token = true } = {}) { await this.ensureToken(); const r = await this.raw('POST', p, { form: { ...(token ? { _csrf: this.csrf } : {}), ...form } }); if (r.headers.getSetCookie().length) this.csrf = null; return r; }
  login(u, pw) { return this.post('/login', { username: u, password: pw }); }
}

function start(port, env) {
  const log = [];
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SEED_DEMO: 'true', SLA_SWEEP_S: '3600', SESSION_SECRET: `scim-check-${tag}`, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => log.push(String(d))); child.stderr.on('data', (d) => log.push(String(d)));
  return { child, text: () => log.join(''), exited: new Promise((r) => child.on('exit', r)) };
}
async function healthy(port, srv) { for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true; } catch { /* wait */ } if (srv.child.exitCode !== null) return false; await sleep(500); } return false; }

async function main() {
  const idpPort = 18271; const port = 18270;
  const idp = spawn(process.execPath, ['scripts/mock-oidc.js', String(idpPort)], { cwd: ROOT, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const app = start(port, { PUBLIC_URL: base, OIDC_ISSUER: `http://127.0.0.1:${idpPort}`, OIDC_CLIENT_ID: 'novadesk-test', OIDC_CLIENT_SECRET: 'test-secret', OIDC_JWKS_MIN_REFETCH_S: '1', WEBHOOK_ALLOW_PRIVATE: 'true' });
  const knex = knexLib({ client: 'pg', connection: dbConfig(process.env), pool: { min: 0, max: 3 } });
  try {
    await sleep(500);
    if (!(await healthy(port, app))) throw new Error(`NovaDesk did not start: ${app.text().slice(-400)}`);
    await run(base, `http://127.0.0.1:${idpPort}`, knex, app);
  } finally { await knex.destroy(); app.child.kill(); idp.kill(); await app.exited; }
}

const SCHEMA_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCHEMA_ENT = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
const SCHEMA_PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const SCHEMA_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';

async function run(base, IDP, knex, app) {
  const q = async (sql, params = []) => (await knex.raw(sql, params)).rows;
  const one = async (sql, params = []) => (await q(sql, params))[0];
  const count = async (sql, params = []) => Number((await one(sql, params)).c);
  const admin = new Browser(base); await admin.login('admin', 'admin123');
  const jane = new Browser(base); await jane.login('jdoe', 'agent123');
  const maria = new Browser(base); await maria.login('mchen', 'user123');
  const anon = new Browser(base);
  const auditCount = (action) => count('SELECT count(*) AS c FROM audit_log WHERE action = ?', [action]);
  const settingsBefore = await one('SELECT * FROM scim_settings');
  // The tokens are this script's to start from: another script (the walk-through) may have left some on a shared database.
  await q('DELETE FROM scim_tokens');
  const revokedBefore = await auditCount('scim.token.revoked');

  // A SCIM client: JSON in, JSON out, the token as a bearer header.
  let TOKEN = null;
  const scim = async (method, p, body, { token = TOKEN, headers = {}, raw } = {}) => {
    const h = { Accept: 'application/scim+json', ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    let payload;
    if (raw !== undefined) payload = raw; else if (body !== undefined) { h['Content-Type'] = h['Content-Type'] || 'application/scim+json'; payload = JSON.stringify(body); }
    const res = await fetch(`${base}/scim/v2${p}`, { method, headers: h, body: payload, redirect: 'manual' });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  const isError = (r, status, type, pattern) => r.status === status && r.json && r.json.schemas && r.json.schemas[0] === SCHEMA_ERROR && r.json.status === String(status) && (type === undefined || r.json.scimType === type || (type === null && !r.json.scimType)) && (!pattern || pattern.test(r.json.detail)) && /^application\/scim\+json/.test(r.headers.get('content-type'));
  const patchOps = (ops) => ({ schemas: [SCHEMA_PATCH], Operations: ops });
  const userBody = (name, extra = {}) => ({ schemas: [SCHEMA_USER], userName: `${name}${tag}@corp.local`, name: { givenName: name, familyName: 'Tester' }, emails: [{ value: `${name}${tag}@corp.local`, type: 'work', primary: true }], active: true, ...extra });
  const dbUser = (id) => one('SELECT * FROM users WHERE id = ?', [id]);
  const lastAudit = (action) => one('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1', [action]);
  const adminSettings = (s) => admin.post('/settings/scim/settings', { default_role: s.defaultRole || 'user', ...(s.allowAdmin ? { allow_admin: 'on' } : {}), ...(s.allowGroups ? { allow_groups: 'on' } : {}) });

  // -------------------------------------------------------------------------------------------- the admin page and tokens
  section = 'tokens';
  check('signed out: sent to sign in', (await anon.get('/settings/scim')).status === 302);
  check('an agent and a plain user cannot open the page or change anything', (await jane.get('/settings/scim')).status === 403 && (await maria.get('/settings/scim')).status === 403
    && (await jane.post('/settings/scim/tokens', { name: 'x', expires: '90' })).status === 403 && (await maria.post('/settings/scim/settings', { default_role: 'agent' })).status === 403);
  const page = await admin.get('/settings/scim');
  check('the administrator sees the base URL, the choices and "no token yet"', page.status === 200 && page.text.includes(`${base}/scim/v2`) && /No token yet/.test(page.text) && /May make someone an administrator/.test(page.text));
  check('nothing works before a token exists', isError(await scim('GET', '/Users', undefined, { token: null }), 401, null) && isError(await scim('GET', '/Users', undefined, { token: `nds_${'a'.repeat(40)}` }), 401, null));
  check('a forged post without the page token is refused and makes nothing', (await admin.post('/settings/scim/tokens', { name: 'forged', expires: '90' }, { token: false })).status === 403 && await count('SELECT count(*) AS c FROM scim_tokens') === 0);
  check('a token needs a name and a real expiry', (await admin.post('/settings/scim/tokens', { name: '  ', expires: '90' })).status === 400 && (await admin.post('/settings/scim/tokens', { name: 'x', expires: '7' })).status === 400 && await count('SELECT count(*) AS c FROM scim_tokens') === 0);
  const made = await admin.post('/settings/scim/tokens', { name: `Okta ${tag}`, expires: '365' });
  const shown = (made.text.match(/id="scimNewToken">(nds_[A-Za-z0-9_-]{40})</) || [])[1];
  check('making a token shows it once, with the warning', made.status === 200 && Boolean(shown) && /not shown again/.test(made.text));
  TOKEN = shown;
  const row = await one('SELECT * FROM scim_tokens ORDER BY id DESC LIMIT 1');
  check('only a hash is stored, never the token', row.token_hash === tokens.hashToken(TOKEN) && row.prefix === TOKEN.slice(0, 8) && !JSON.stringify(row).includes(TOKEN) && /^\d{4}-/.test(row.expires_at));
  const again = await admin.get('/settings/scim');
  check('the page lists it by its first characters only, and never again shows it', again.text.includes(row.prefix) && !again.text.includes(TOKEN) && again.text.includes(`Okta ${tag}`));
  const created = await lastAudit('scim.token.created');
  check('it is in the audit log, without the token', created && created.target_name === `Okta ${tag}` && !JSON.stringify(created).includes(TOKEN));
  const ok = await scim('GET', '/ServiceProviderConfig');
  check('the token works, and last-used is recorded', ok.status === 200 && (await one('SELECT last_used_at FROM scim_tokens WHERE id = ?', [row.id])).last_used_at !== null);
  const personalKey = await admin.post('/profile/api-keys', { name: 'k', scope: 'write', expires: '' });
  const apiKey = (personalKey.text.match(/ndk_[A-Za-z0-9_-]{40}/) || [])[0];
  check('a personal API key is not a SCIM token, and a SCIM token is not an API key', (apiKey ? isError(await scim('GET', '/Users', undefined, { token: apiKey }), 401, null) : true) && (await fetch(`${base}/api/v1/incidents`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status === 401);
  check('a browser session alone opens nothing', isError(await scim('GET', '/Users', undefined, { token: null, headers: { Cookie: admin.cookie } }), 401, null));
  check('a wrong scheme or extra words in the header are refused', isError(await scim('GET', '/Users', undefined, { token: null, headers: { Authorization: `Basic ${TOKEN}` } }), 401, null) && isError(await scim('GET', '/Users', undefined, { token: null, headers: { Authorization: `Bearer ${TOKEN} extra` } }), 401, null));
  check('the 401 says how to authenticate', (await scim('GET', '/Users', undefined, { token: null })).headers.get('www-authenticate') === 'Bearer realm="NovaDesk SCIM"');
  await q('UPDATE scim_tokens SET expires_at = ? WHERE id = ?', ['2020-01-01 00:00:00', row.id]);
  check('an expired token stops working', isError(await scim('GET', '/Users'), 401, null));
  await q('UPDATE scim_tokens SET expires_at = ? WHERE id = ?', ['2099-01-01 00:00:00', row.id]);
  check('and works again when the date is in the future', (await scim('GET', '/Users')).status === 200);
  const second = await admin.post('/settings/scim/tokens', { name: `Second ${tag}`, expires: 'never' });
  const secondToken = (second.text.match(/id="scimNewToken">(nds_[A-Za-z0-9_-]{40})</) || [])[1];
  check('a second token that never expires', Boolean(secondToken) && (await one('SELECT expires_at FROM scim_tokens WHERE name = ?', [`Second ${tag}`])).expires_at === null);
  const secondRow = await one('SELECT id FROM scim_tokens WHERE name = ?', [`Second ${tag}`]);
  const revoked = await admin.post(`/settings/scim/tokens/${secondRow.id}/revoke`);
  check('revoking one token stops that token at once and no other', revoked.status === 200 && isError(await scim('GET', '/Users', undefined, { token: secondToken }), 401, null) && (await scim('GET', '/Users')).status === 200 && await auditCount('scim.token.revoked') === revokedBefore + 1);
  check('revoking an unknown token is a 404', (await admin.post('/settings/scim/tokens/999999/revoke')).status === 404);
  for (let i = 0; i < 4; i++) await admin.post('/settings/scim/tokens', { name: `Filler ${i} ${tag}`, expires: '90' });
  const tooMany = await admin.post('/settings/scim/tokens', { name: 'One too many', expires: '90' });
  check('at most five active tokens', tooMany.status === 400 && /already 5 active/.test(tooMany.text));
  await q("UPDATE scim_tokens SET revoked_at = '2026-01-01 00:00:00' WHERE name LIKE 'Filler %'");

  // ---------------------------------------------------------------------------------------------------------- discovery
  section = 'discovery';
  const spc = await scim('GET', '/ServiceProviderConfig');
  check('ServiceProviderConfig says what is supported', spc.json.patch.supported === true && spc.json.filter.supported === true && spc.json.filter.maxResults === 100 && ['bulk', 'changePassword', 'sort', 'etag'].every((k) => spc.json[k].supported === false) && spc.json.authenticationSchemes[0].type === 'oauthbearertoken');
  check('answers are application/scim+json and are never cached', /^application\/scim\+json/.test(spc.headers.get('content-type')) && /no-store/.test(spc.headers.get('cache-control')));
  const rt = await scim('GET', '/ResourceTypes');
  check('ResourceTypes: User (with the enterprise extension) and Group', rt.json.totalResults === 2 && rt.json.Resources[0].endpoint === '/Users' && rt.json.Resources[0].schemaExtensions[0].schema === SCHEMA_ENT && rt.json.Resources[1].endpoint === '/Groups');
  const schemas = await scim('GET', '/Schemas');
  check('Schemas: User, EnterpriseUser, Group; one by id', schemas.json.totalResults === 3 && (await scim('GET', `/Schemas/${SCHEMA_USER}`)).json.name === 'User' && isError(await scim('GET', '/Schemas/urn:nope'), 404, null) && isError(await scim('GET', '/ResourceTypes/Nope'), 404, null));
  check('every locator in the documents is an absolute URL on this server', rt.json.Resources.every((r) => r.meta.location.startsWith(`${base}/scim/v2/`)));
  check('discovery needs the token as well', isError(await scim('GET', '/Schemas', undefined, { token: null }), 401, null));
  check('an unknown endpoint is a SCIM 404, and so is a method that does not exist', isError(await scim('GET', '/Nothing'), 404, null) && isError(await scim('PUT', '/Users', {}), 404, null) && isError(await scim('DELETE', '/ServiceProviderConfig'), 404, null));

  // ---------------------------------------------------------------------------------------- the Okta lifecycle: users
  section = 'users: create and read';
  const none = await scim('GET', `/Users?filter=${encodeURIComponent(`userName eq "ann${tag}@corp.local"`)}`);
  check('the provider first asks whether the person exists: an empty list', none.status === 200 && none.json.totalResults === 0 && none.json.itemsPerPage === 0 && none.json.startIndex === 1 && none.json.Resources.length === 0 && none.json.schemas[0] === 'urn:ietf:params:scim:api:messages:2.0:ListResponse');
  const ann = await scim('POST', '/Users', userBody('ann', { externalId: `ext-ann-${tag}`, [SCHEMA_ENT]: { department: 'Finance' }, password: 'Provider-pushed-1!', title: 'Controller' }));
  check('creating answers 201 with Location and the person', ann.status === 201 && ann.headers.get('location') === ann.json.meta.location && ann.json.meta.location === `${base}/scim/v2/Users/${ann.json.id}` && ann.json.userName === `ann${tag}@corp.local` && ann.json.active === true);
  const annId = Number(ann.json.id);
  check('the person is as sent: name, email, department, external id; default role user; not yet in any group', ann.json.displayName === 'ann Tester' && ann.json.emails[0].value === `ann${tag}@corp.local` && ann.json[SCHEMA_ENT].department === 'Finance' && ann.json.externalId === `ext-ann-${tag}` && ann.json.roles[0].value === 'user' && ann.json.groups.length === 0);
  const annRow = await dbUser(annId);
  check('stored as SCIM-managed, with its own time', annRow.scim_managed === 1 && annRow.scim_external_id === `ext-ann-${tag}` && /^\d{4}-/.test(annRow.scim_updated_at) && annRow.role === 'user' && annRow.department === 'Finance');
  check('the pushed password was ignored: nobody can sign in with it, or with any other', (await new Browser(base).login(`ann${tag}@corp.local`, 'Provider-pushed-1!')).status === 401 && !/Provider-pushed/.test(JSON.stringify(ann.json)));
  const createdAudit = await lastAudit('scim.user.created');
  check('the audit log names the token, not a person, and the new account', createdAudit.actor_name === `SCIM: Okta ${tag}` && createdAudit.actor_id === null && createdAudit.target_id === annId && /role user/.test(createdAudit.detail));
  const byId = await scim('GET', `/Users/${annId}`);
  check('reading one person by id', byId.status === 200 && byId.json.id === String(annId) && byId.json.meta.resourceType === 'User' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(byId.json.meta.created));
  check('the list view of the page marks the person as SCIM-managed', /SCIM<\/span>/.test((await admin.get('/users')).text));
  check('and their edit page says it may be overwritten', /managed by your identity provider/.test((await admin.get(`/users/${annId}/edit`)).text));

  section = 'users: uniqueness';
  check('the same userName in other capitals is a 409', isError(await scim('POST', '/Users', userBody('ann', { userName: `ANN${tag}@CORP.local`, emails: [{ value: `other${tag}@corp.local` }] })), 409, 'uniqueness', /already taken/));
  check('the same email on another account is a 409', isError(await scim('POST', '/Users', userBody('bob', { emails: [{ value: `ANN${tag}@corp.local`, primary: true }] })), 409, 'uniqueness', /already belongs/));
  check('a username that exists locally (jdoe) is a 409, even in capitals', isError(await scim('POST', '/Users', { schemas: [SCHEMA_USER], userName: 'JDOE' }), 409, 'uniqueness'));
  check('an email held by a local account (maria) is a 409', isError(await scim('POST', '/Users', { schemas: [SCHEMA_USER], userName: `m${tag}`, emails: [{ value: 'MARIA.CHEN@corp.local' }] }), 409, 'uniqueness'));
  check('nothing extra was created by the refusals', await count("SELECT count(*) AS c FROM users WHERE username ILIKE ? OR username = 'm' || ?", [`bob${tag}%`, tag]) === 0);
  const race = await Promise.all([1, 2, 3].map(() => scim('POST', '/Users', userBody('race'))));
  check('three identical creates racing: one 201 and two 409', race.filter((r) => r.status === 201).length === 1 && race.filter((r) => r.status === 409).length === 2 && await count('SELECT count(*) AS c FROM users WHERE username = ?', [`race${tag}@corp.local`]) === 1, race.map((r) => r.status).join());

  section = 'users: bad input';
  check('a body that is not JSON is invalidSyntax', isError(await scim('POST', '/Users', undefined, { raw: '{"userName": ', headers: { 'Content-Type': 'application/scim+json' } }), 400, 'invalidSyntax'));
  check('a request with no JSON content type has no usable body', isError(await scim('POST', '/Users', undefined, { raw: 'userName=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }), 400, 'invalidSyntax'));
  check('application/json is accepted too', (await scim('POST', '/Users', userBody('jsonct'), { headers: { 'Content-Type': 'application/json' } })).status === 201);
  check('a body over 256 KB is refused', (await scim('POST', '/Users', undefined, { raw: JSON.stringify({ userName: 'big', pad: 'x'.repeat(300 * 1024) }), headers: { 'Content-Type': 'application/scim+json' } })).status === 413);
  for (const [name, body, re] of [['no userName', { schemas: [SCHEMA_USER] }, /required/], ['a bad userName', { userName: 'has space' }, /2 to 64/], ['a bad email', { userName: `bad${tag}`, emails: [{ value: 'nope' }] }, /not an email/], ['a bad role', { userName: `bad${tag}`, roles: [{ value: 'root' }] }, /not a role/], ['a bad active', { userName: `bad${tag}`, active: 'perhaps' }, /true or false/], ['the wrong schema', { schemas: ['urn:x'], userName: `bad${tag}` }, /schemas/]]) {
    const r = await scim('POST', '/Users', body);
    check(`${name} is refused with 400 and a reason`, r.status === 400 && r.json.schemas[0] === SCHEMA_ERROR && re.test(r.json.detail), r.text);
  }
  check('an array as the body is refused', isError(await scim('POST', '/Users', [1]), 400, 'invalidSyntax'));
  check('nothing was made by those refusals', await count("SELECT count(*) AS c FROM users WHERE username LIKE ?", [`bad${tag}%`]) === 0);
  for (const id of ['abc', '0', '-1', '99999999999', '1;DROP TABLE users', '1.5']) check(`/Users/${id} is a 404`, isError(await scim('GET', `/Users/${encodeURIComponent(id)}`), 404, null));
  check('a person who does not exist is a 404 for every verb', isError(await scim('GET', '/Users/999999'), 404, null) && isError(await scim('PUT', '/Users/999999', userBody('x')), 404, null) && isError(await scim('PATCH', '/Users/999999', patchOps([{ op: 'replace', path: 'active', value: false }])), 404, null) && isError(await scim('DELETE', '/Users/999999'), 404, null));

  section = 'users: find and page';
  const names = ['carl', 'dina', 'evan', 'fran', 'gus'];
  const made2 = {};
  for (const n of names) made2[n] = (await scim('POST', '/Users', userBody(n, { externalId: `ext-${n}-${tag}`, active: n !== 'gus' }))).json;
  const find = async (filter, extra = '') => (await scim('GET', `/Users?filter=${encodeURIComponent(filter)}${extra}`));
  const ids = (r) => (r.json.Resources || []).map((u) => u.userName);
  check('userName eq, in any capitals', ids(await find(`userName eq "CARL${tag}@Corp.Local"`)).join() === `carl${tag}@corp.local`);
  check('externalId eq is exact', ids(await find(`externalId eq "ext-dina-${tag}"`)).length === 1 && ids(await find(`externalId eq "EXT-DINA-${tag}"`)).length === 0);
  check('emails.value eq', ids(await find(`emails.value eq "evan${tag}@corp.local"`)).length === 1);
  check('id eq', ids(await find(`id eq "${made2.fran.id}"`)).join() === `fran${tag}@corp.local`);
  check('active eq false finds only the switched-off person', ids(await find(`active eq false and userName sw "gus"`)).length === 1 && ids(await find(`userName co "${tag}" and active eq false`)).every((n) => n.startsWith('gus')));
  check('co, sw, ew, pr, or, and, not', (await find(`userName sw "carl${tag}"`)).json.totalResults === 1 && (await find(`userName ew "${tag}@corp.local" and externalId pr and active eq true`)).json.totalResults >= 4
    && (await find(`userName eq "carl${tag}@corp.local" or userName eq "dina${tag}@corp.local"`)).json.totalResults === 2 && (await find(`externalId pr and not (userName co "carl")`)).json.totalResults >= 5 && (await find(`userName co "${tag}@corp"`)).json.totalResults >= 6);
  check('a % or _ in a filter is a character, not a wildcard', (await find('userName co "%"')).json.totalResults === 0 && (await find('userName co "_"')).json.totalResults === 0);
  check('an injection attempt finds nobody and breaks nothing', (await find(`userName eq "x' OR '1'='1"`)).json.totalResults === 0 && (await find(`userName eq "x\\"; DROP TABLE users; --"`)).status === 200 && await count('SELECT count(*) AS c FROM users') > 5);
  for (const [bad, re] of [['userName', /operator/], ['userName eq jane', /double quotes/], ['password eq "x"', /cannot be filtered on/], ['userName gt "a"', /not supported/], ['(userName eq "a"', /never closed/], ['emails[type eq "work"] pr', /square brackets/]]) {
    const r = await find(bad); check(`the filter  ${bad}  is invalidFilter: ${re}`, isError(r, 400, 'invalidFilter', re), r.text);
  }
  const everyone = await scim('GET', `/Users?filter=${encodeURIComponent(`userName ew "${tag}@corp.local"`)}&count=2&startIndex=2`);
  check('paging: startIndex and count, with the true total', everyone.json.startIndex === 2 && everyone.json.itemsPerPage === 2 && everyone.json.Resources.length === 2 && everyone.json.totalResults >= 7);
  const pageA = await scim('GET', `/Users?filter=${encodeURIComponent(`userName ew "${tag}@corp.local"`)}&count=2&startIndex=1`);
  const pageB = await scim('GET', `/Users?filter=${encodeURIComponent(`userName ew "${tag}@corp.local"`)}&count=2&startIndex=3`);
  check('pages do not overlap, and follow each other in order of id', pageA.json.Resources.length === 2 && pageB.json.Resources.length === 2 && !pageA.json.Resources.some((u) => pageB.json.Resources.some((v) => v.id === u.id)) && Number(pageA.json.Resources[1].id) < Number(pageB.json.Resources[0].id));
  check('count=0 gives the total and no people', (await scim('GET', '/Users?count=0')).json.Resources.length === 0 && (await scim('GET', '/Users?count=0')).json.totalResults > 5);
  check('a huge count is held to 100; a negative one to 0; a startIndex below 1 to 1', (await scim('GET', '/Users?count=100000')).json.itemsPerPage <= 100 && (await scim('GET', '/Users?count=-5')).json.itemsPerPage === 0 && (await scim('GET', '/Users?startIndex=-3')).json.startIndex === 1);
  check('a count or startIndex that is not a number is refused', isError(await scim('GET', '/Users?count=abc'), 400, 'invalidValue') && isError(await scim('GET', '/Users?startIndex=1.5'), 400, 'invalidValue'));
  check('attributes and excludedAttributes', (() => { return true; })() && Object.keys((await scim('GET', `/Users/${annId}?attributes=userName`)).json).sort().join() === 'id,schemas,userName' && !('emails' in (await scim('GET', `/Users/${annId}?excludedAttributes=emails`)).json));
  check('every person the list returns carries the SCIM shape', (await scim('GET', '/Users?count=50')).json.Resources.every((u) => u.schemas.includes(SCHEMA_USER) && /^\d+$/.test(u.id) && u.userName && u.meta.location.startsWith(`${base}/scim/v2/Users/`) && !('password' in u)));
  check('the list contains the local demonstration users too (SCIM can find and take over existing people)', ids(await find('userName eq "jdoe"')).join() === 'jdoe');

  section = 'users: replace (PUT)';
  const put = await scim('PUT', `/Users/${annId}`, { schemas: [SCHEMA_USER], userName: `ann${tag}@corp.local`, name: { givenName: 'Annabel', familyName: 'Tester-Reed' }, emails: [{ value: `ann.reed${tag}@corp.local`, primary: true }], [SCHEMA_ENT]: { department: 'Audit' } });
  check('PUT answers 200 with the changed person', put.status === 200 && put.json.displayName === 'Annabel Tester-Reed' && put.json.emails[0].value === `ann.reed${tag}@corp.local` && put.json[SCHEMA_ENT].department === 'Audit');
  const afterPut = await dbUser(annId);
  check('what the request left out is cleared (external id); the role and active are not reset', afterPut.scim_external_id === null && afterPut.role === 'user' && afterPut.active === 1);
  const putAudit = await lastAudit('scim.user.updated');
  check('the audit says which fields, not their values', putAudit.target_id === annId && /name/.test(putAudit.detail) && /email/.test(putAudit.detail) && /external id/.test(putAudit.detail) && !/reed/.test(putAudit.detail));
  const auditBefore = await auditCount('scim.user.updated');
  const before = await dbUser(annId);
  await sleep(1100);
  const noop = await scim('PUT', `/Users/${annId}`, { schemas: [SCHEMA_USER], userName: `ann${tag}@corp.local`, name: { formatted: 'Annabel Tester-Reed' }, emails: [{ value: `ann.reed${tag}@corp.local` }], [SCHEMA_ENT]: { department: 'Audit' } });
  check('putting the same thing again changes nothing: no write, no audit entry, same time', noop.status === 200 && await auditCount('scim.user.updated') === auditBefore && (await dbUser(annId)).scim_updated_at === before.scim_updated_at);
  check('PUT cannot take a username or email that belongs to another account', isError(await scim('PUT', `/Users/${annId}`, userBody('x', { userName: 'JDOE' })), 409, 'uniqueness') && isError(await scim('PUT', `/Users/${annId}`, { schemas: [SCHEMA_USER], userName: `ann${tag}@corp.local`, emails: [{ value: 'jane.doe@corp.local' }] }), 409, 'uniqueness'));
  check('PUT can rename the person (the provider\'s userName changed)', (await scim('PUT', `/Users/${annId}`, { schemas: [SCHEMA_USER], userName: `ann.new${tag}@corp.local`, name: { formatted: 'Annabel Tester-Reed' }, emails: [{ value: `ann.reed${tag}@corp.local` }], [SCHEMA_ENT]: { department: 'Audit' } })).json.userName === `ann.new${tag}@corp.local`);
  check('PUT without a userName is refused', isError(await scim('PUT', `/Users/${annId}`, { schemas: [SCHEMA_USER], name: { formatted: 'x' } }), 400, 'invalidValue'));
  check('PUT cannot be told to make an administrator while that is not allowed', isError(await scim('PUT', `/Users/${annId}`, userBody('ann', { userName: `ann.new${tag}@corp.local`, roles: [{ value: 'admin' }] })), 400, 'mutability', /Administrator roles/) && (await dbUser(annId)).role === 'user');

  section = 'users: patch';
  const p1 = await scim('PATCH', `/Users/${annId}`, patchOps([{ op: 'Replace', path: 'emails[type eq "work"].value', value: `ann.patched${tag}@corp.local` }, { op: 'Replace', path: `${SCHEMA_ENT}:department`, value: 'Treasury' }, { op: 'Add', path: 'externalId', value: `ext-ann2-${tag}` }]));
  check('Entra style: capitalised ops, a filtered email path, the department by URN path', p1.status === 200 && p1.json.emails[0].value === `ann.patched${tag}@corp.local` && p1.json[SCHEMA_ENT].department === 'Treasury' && p1.json.externalId === `ext-ann2-${tag}`);
  const p2 = await scim('PATCH', `/Users/${annId}`, patchOps([{ op: 'replace', value: { 'name.givenName': 'Anna', 'name.familyName': 'Reed', title: 'ignored', phoneNumbers: [{ value: '1' }] } }]));
  check('Okta style: no path, an object of paths, unknown-but-valid attributes ignored', p2.status === 200 && p2.json.displayName === 'Anna Reed');
  check('PATCH can clear (remove) an email and a department', (await scim('PATCH', `/Users/${annId}`, patchOps([{ op: 'remove', path: 'emails' }, { op: 'remove', path: `${SCHEMA_ENT}:department` }]))).json.emails === undefined && (await dbUser(annId)).email === null && (await dbUser(annId)).department === null);
  check('a patch with several operations is all or nothing: a bad second operation changes nothing', isError(await scim('PATCH', `/Users/${annId}`, patchOps([{ op: 'replace', path: `${SCHEMA_ENT}:department`, value: 'Never' }, { op: 'replace', path: 'bogus', value: 1 }])), 400, 'invalidPath') && (await dbUser(annId)).department === null);
  for (const [name, ops, type] of [['an unknown operation', [{ op: 'move', path: 'active' }], 'invalidSyntax'], ['remove without a path', [{ op: 'remove' }], 'noTarget'], ['removing userName', [{ op: 'remove', path: 'userName' }], 'noTarget'], ['a bad value', [{ op: 'replace', path: 'active', value: 'perhaps' }], 'invalidValue'], ['a bad path', [{ op: 'replace', path: 'a b c', value: 1 }], 'invalidPath'], ['an email taken by someone else', [{ op: 'replace', path: 'emails.value', value: 'jane.doe@corp.local' }], 'uniqueness'], ['a bad email', [{ op: 'replace', path: 'emails.value', value: 'nope' }], 'invalidValue']]) {
    const r = await scim('PATCH', `/Users/${annId}`, patchOps(ops)); check(`PATCH with ${name} is ${type}`, isError(r, type === 'uniqueness' ? 409 : 400, type), r.text);
  }
  check('PATCH with no operations is refused', isError(await scim('PATCH', `/Users/${annId}`, { schemas: [SCHEMA_PATCH], Operations: [] }), 400, 'invalidSyntax') && isError(await scim('PATCH', `/Users/${annId}`, { schemas: ['urn:x'], Operations: [{}] }), 400, 'invalidSyntax'));
  await scim('PATCH', `/Users/${annId}`, patchOps([{ op: 'replace', path: 'emails', value: [{ value: `ann${tag}@corp.local`, primary: true }] }, { op: 'replace', path: 'userName', value: `ann${tag}@corp.local` }]));

  // ------------------------------------------------------------------------------------------- switching off, and taking over
  section = 'switching off';
  const mariaRow = await one("SELECT id FROM users WHERE username = 'mchen'");
  const mariaKey = (await maria.post('/profile/api-keys', { name: 'maria key', scope: 'read', expires: '' })).text.match(/ndk_[A-Za-z0-9_-]{40}/);
  const keyHeaders = mariaKey ? { Authorization: `Bearer ${mariaKey[0]}` } : null;
  check('before: maria is signed in and her API key works', (await maria.get('/profile')).status === 200 && (!keyHeaders || (await fetch(`${base}/api/v1/me`, { headers: keyHeaders })).status === 200));
  const off = await scim('PATCH', `/Users/${mariaRow.id}`, patchOps([{ op: 'Replace', path: 'active', value: 'False' }]));
  check('the provider switches an existing local person off with active "False" (text, as Entra sends it)', off.status === 200 && off.json.active === false && (await dbUser(mariaRow.id)).active === 0 && (await dbUser(mariaRow.id)).scim_managed === 1);
  check('her open sign-in ended at once (the session row is gone before she asks for anything)', await count('SELECT count(*) AS c FROM sessions WHERE user_id = ?', [mariaRow.id]) === 0 && (await maria.get('/profile')).status === 302);
  check('her API key was revoked (marked so in the database, and refused)', await count('SELECT count(*) AS c FROM api_keys WHERE user_id = ? AND revoked_at IS NULL', [mariaRow.id]) === 0 && (!keyHeaders || (await fetch(`${base}/api/v1/me`, { headers: keyHeaders })).status === 401));
  check('she cannot sign in again with her password', (await new Browser(base).login('mchen', 'user123')).status === 401);
  const deactivatedBefore = await auditCount('scim.user.deactivated');
  const offAudit = await lastAudit('scim.user.deactivated');
  check('the audit says who, how many sessions and keys', offAudit.target_id === mariaRow.id && offAudit.actor_name === `SCIM: Okta ${tag}` && /session/.test(offAudit.detail) && /API key/.test(offAudit.detail));
  check('switching off again changes nothing and writes nothing more', (await scim('PATCH', `/Users/${mariaRow.id}`, patchOps([{ op: 'replace', path: 'active', value: false }]))).status === 200 && await auditCount('scim.user.deactivated') === deactivatedBefore);
  const on = await scim('PATCH', `/Users/${mariaRow.id}`, patchOps([{ op: 'replace', path: 'active', value: true }]));
  check('switching on again: she signs in with her own password, nothing else about her changed', on.json.active === true && (await new Browser(base).login('mchen', 'user123')).status === 302 && (await lastAudit('scim.user.reactivated')).target_id === mariaRow.id);
  check('her email, name and role are exactly as before', (await dbUser(mariaRow.id)).email === 'maria.chen@corp.local' && (await dbUser(mariaRow.id)).role === 'user');

  section = 'administrators';
  const adminRow = await one("SELECT id FROM users WHERE username = 'admin'");
  const admins = await count("SELECT count(*) AS c FROM users WHERE role = 'admin' AND active = 1");
  check('the demonstration has exactly one active administrator (the rest of this section depends on it)', admins === 1, admins);
  check('SCIM may not switch off the only active administrator', isError(await scim('PATCH', `/Users/${adminRow.id}`, patchOps([{ op: 'replace', path: 'active', value: false }])), 400, 'mutability', /only active administrator/) && (await dbUser(adminRow.id)).active === 1);
  check('nor delete them', isError(await scim('DELETE', `/Users/${adminRow.id}`), 400, 'mutability', /only active administrator/) && (await dbUser(adminRow.id)) !== undefined);
  check('nor change their role while SCIM may not touch administrator roles', isError(await scim('PATCH', `/Users/${adminRow.id}`, patchOps([{ op: 'replace', path: 'roles', value: [{ value: 'agent' }] }])), 400, 'mutability', /Administrator roles/) && (await dbUser(adminRow.id)).role === 'admin');
  check('nor create an administrator', isError(await scim('POST', '/Users', userBody('boss', { roles: [{ value: 'admin' }] })), 400, 'mutability', /may not create an administrator/) && await count('SELECT count(*) AS c FROM users WHERE username = ?', [`boss${tag}@corp.local`]) === 0);
  check('nor promote an ordinary person', isError(await scim('PATCH', `/Users/${annId}`, patchOps([{ op: 'replace', path: 'roles', value: [{ value: 'admin' }] }])), 400, 'mutability') && (await dbUser(annId)).role === 'user');
  check('it may make someone an agent', (await scim('PATCH', `/Users/${annId}`, patchOps([{ op: 'replace', path: 'roles', value: [{ value: 'agent' }] }]))).json.roles[0].value === 'agent');
  await adminSettings({ allowAdmin: true });
  check('the administrator allows it: the change is saved and in the audit log', (await one('SELECT allow_admin FROM scim_settings')).allow_admin === 1 && /administrators: on/.test((await lastAudit('scim.settings.changed')).detail));
  const boss = await scim('POST', '/Users', userBody('boss', { roles: [{ value: 'admin' }] }));
  check('now it may create an administrator', boss.status === 201 && boss.json.roles[0].value === 'admin');
  check('and may change an administrator who is not the last one', (await scim('PATCH', `/Users/${boss.json.id}`, patchOps([{ op: 'replace', path: 'roles', value: [{ value: 'agent' }] }]))).json.roles[0].value === 'agent');
  await scim('PATCH', `/Users/${boss.json.id}`, patchOps([{ op: 'replace', path: 'roles', value: [{ value: 'admin' }] }]));
  check('even allowed, the only active administrator cannot be demoted while they are the only one', await (async () => {
    await q('UPDATE users SET active = 0 WHERE id = ?', [adminRow.id]);                // the demonstration admin out of the way: boss is the only one
    const r = await scim('PATCH', `/Users/${boss.json.id}`, patchOps([{ op: 'replace', path: 'roles', value: [{ value: 'user' }] }]));
    const r2 = await scim('PATCH', `/Users/${boss.json.id}`, patchOps([{ op: 'replace', path: 'active', value: false }]));
    const r3 = await scim('DELETE', `/Users/${boss.json.id}`);
    await q('UPDATE users SET active = 1 WHERE id = ?', [adminRow.id]);
    return isError(r, 400, 'mutability', /only active administrator/) && isError(r2, 400, 'mutability') && isError(r3, 400, 'mutability') && (await dbUser(boss.json.id)).role === 'admin' && (await dbUser(boss.json.id)).active === 1;
  })());
  check('with another administrator, the second can be switched off', (await scim('PATCH', `/Users/${boss.json.id}`, patchOps([{ op: 'replace', path: 'active', value: false }]))).json.active === false);
  await adminSettings({ allowAdmin: false });
  check('and turned off again', (await one('SELECT allow_admin FROM scim_settings')).allow_admin === 0 && isError(await scim('PATCH', `/Users/${boss.json.id}`, patchOps([{ op: 'replace', path: 'roles', value: [{ value: 'user' }] }])), 400, 'mutability'));
  check('an administrator that SCIM may not demote can still be switched off by it when they are not the last (a leaver)', (await scim('PATCH', `/Users/${boss.json.id}`, patchOps([{ op: 'replace', path: 'active', value: false }]))).status === 200);
  check('the default role can be agent, not admin', (await adminSettings({ defaultRole: 'agent' })).status === 200 && (await scim('POST', '/Users', userBody('defrole'))).json.roles[0].value === 'agent'
    && (await admin.post('/settings/scim/settings', { default_role: 'admin' })).status === 400 && (await one('SELECT default_role FROM scim_settings')).default_role === 'agent');
  await adminSettings({ defaultRole: 'user' });
  check('saving the same choices again says nothing changed and writes no entry', await (async () => { const n = await auditCount('scim.settings.changed'); const r = await adminSettings({ defaultRole: 'user' }); return /Nothing changed/.test(r.text) && n === await auditCount('scim.settings.changed'); })());

  section = 'deleting';
  const gone = (await scim('POST', '/Users', userBody('goner'))).json;
  const delGone = await scim('DELETE', `/Users/${gone.id}`);
  check('deleting a person with no history removes them: 204, no body, then 404', delGone.status === 204 && delGone.text === '' && isError(await scim('GET', `/Users/${gone.id}`), 404, null) && await count('SELECT count(*) AS c FROM users WHERE id = ?', [gone.id]) === 0);
  check('and says so in the audit log', /removed/.test((await lastAudit('scim.user.deleted')).detail));
  const kept = (await scim('POST', '/Users', userBody('kept'))).json;
  await q(`INSERT INTO incidents (number, short_description, caller_id) VALUES (?, 'history', ?)`, [`INCK-${tag}`, kept.id]);
  const delKept = await scim('DELETE', `/Users/${kept.id}`);
  check('a person with tickets is switched off instead, and the history stays', delKept.status === 204 && (await dbUser(kept.id)).active === 0 && await count('SELECT count(*) AS c FROM incidents WHERE caller_id = ?', [kept.id]) === 1 && /switched off/.test((await lastAudit('scim.user.deleted')).detail));
  check('such a person can still be read, as switched off, and switched on again', (await scim('GET', `/Users/${kept.id}`)).json.active === false && (await scim('PATCH', `/Users/${kept.id}`, patchOps([{ op: 'replace', path: 'active', value: true }]))).json.active === true);

  section = 'anonymised people';
  const ghost = (await scim('POST', '/Users', userBody('ghost', { externalId: `ext-ghost-${tag}` }))).json;
  const privacy = require('../src/privacy/anonymise');
  const adminForPrivacy = await one("SELECT * FROM users WHERE username = 'admin'");
  await privacy.anonymise(Number(ghost.id), { actor: adminForPrivacy });
  const gRow = await dbUser(ghost.id);
  check('anonymising a SCIM person clears the provider\'s id and the managed mark (the privacy tools know about SCIM)', gRow.anonymised_at !== null && gRow.scim_external_id === null && gRow.scim_managed === 0 && gRow.email === null);
  check('SCIM can no longer see them: read, list, filter, replace, patch, delete are all 404 or empty', isError(await scim('GET', `/Users/${ghost.id}`), 404, null) && isError(await scim('PUT', `/Users/${ghost.id}`, userBody('ghost')), 404, null) && isError(await scim('PATCH', `/Users/${ghost.id}`, patchOps([{ op: 'replace', path: 'active', value: true }])), 404, null) && isError(await scim('DELETE', `/Users/${ghost.id}`), 404, null)
    && (await find(`userName eq "ghost${tag}@corp.local"`)).json.totalResults === 0 && (await find(`id eq "${ghost.id}"`)).json.totalResults === 0 && !JSON.stringify((await scim('GET', '/Users?count=100')).json).includes(`anonymised-${ghost.id}`));
  check('and they stay inactive', (await dbUser(ghost.id)).active === 0);
  const reborn = await scim('POST', '/Users', userBody('ghost', { externalId: `ext-ghost-${tag}` }));
  check('the provider can create the same person again afterwards, as a new account', reborn.status === 201 && reborn.json.id !== ghost.id);

  // ------------------------------------------------------------------------------------------------------------- groups
  section = 'groups';
  const gl = await scim('GET', '/Groups');
  check('the eight assignment groups, as read-only-named groups with ids from their names', gl.json.totalResults === 8 && gl.json.Resources.map((g) => g.id).join() === 'iro-windows,iro-unix,iro-database,iro-network-security,iro-cloudops,iro-build-decom,iro-backup-storage,iro-servicedesk' && gl.json.Resources[5].displayName === 'IRO-Build/Decom' && gl.json.Resources[0].schemas[0] === 'urn:ietf:params:scim:schemas:core:2.0:Group');
  check('find one by displayName (any capitals) or id; read one; unknown is 404', (await scim('GET', `/Groups?filter=${encodeURIComponent('displayName eq "iro-unix"')}`)).json.Resources[0].id === 'iro-unix' && (await scim('GET', `/Groups?filter=${encodeURIComponent('id eq "iro-database"')}`)).json.totalResults === 1 && (await scim('GET', '/Groups/IRO-UNIX')).json.displayName === 'IRO-UNIX' && isError(await scim('GET', '/Groups/nope'), 404, null) && isError(await scim('GET', `/Groups?filter=${encodeURIComponent('members eq "1"')}`), 400, 'invalidFilter'));
  check('groups cannot be created or deleted', isError(await scim('POST', '/Groups', { displayName: 'New' }), 403, null, /fixed/) && isError(await scim('DELETE', '/Groups/iro-unix'), 403, null));
  const janeRow = await one("SELECT id FROM users WHERE username = 'jdoe'");
  const decomBefore = (await scim('GET', '/Groups/iro-build-decom')).json.members.map((m) => m.value);
  check('changing membership is refused while the choice is off, and changes nothing', isError(await scim('PATCH', '/Groups/iro-build-decom', patchOps([{ op: 'add', path: 'members', value: [{ value: String(annId) }] }])), 403, null, /switched off/) && isError(await scim('PUT', '/Groups/iro-build-decom', { displayName: 'IRO-Build/Decom', members: [] }), 403, null) && (await scim('GET', '/Groups/iro-build-decom')).json.members.map((m) => m.value).join() === decomBefore.join());
  await adminSettings({ allowGroups: true });
  const g1 = await scim('PATCH', '/Groups/iro-unix', patchOps([{ op: 'add', path: 'members', value: [{ value: String(annId) }, { value: String(janeRow.id) }] }]));
  check('allowed: add members (Entra form)', g1.status === 200 && g1.json.members.map((m) => m.value).sort().join() === [String(annId), String(janeRow.id)].sort().join() && g1.json.members.every((m) => m.$ref === `${base}/scim/v2/Users/${m.value}` && m.type === 'User' && m.display));
  check('the person now shows the group, and the database has it', (await scim('GET', `/Users/${annId}`)).json.groups[0].value === 'iro-unix' && await count("SELECT count(*) AS c FROM user_assignment_groups WHERE user_id = ? AND group_name = 'IRO-UNIX'", [annId]) === 1);
  check('adding who is already in changes nothing and is not audited again', await (async () => { const n = await auditCount('scim.group.members'); const r = await scim('PATCH', '/Groups/iro-unix', patchOps([{ op: 'add', path: 'members', value: [{ value: String(annId) }] }])); return r.status === 200 && r.json.members.length === 2 && n === await auditCount('scim.group.members'); })());
  check('remove one member by a filtered path', (await scim('PATCH', '/Groups/iro-unix', patchOps([{ op: 'remove', path: `members[value eq "${janeRow.id}"]` }]))).json.members.map((m) => m.value).join() === String(annId));
  check('remove a list of members (Okta/Entra form: path members with values)', (await scim('PATCH', '/Groups/iro-unix', patchOps([{ op: 'remove', path: 'members', value: [{ value: String(annId) }] }]))).json.members.length === 0);
  check('replace the members', (await scim('PATCH', '/Groups/iro-unix', patchOps([{ op: 'add', path: 'members', value: [{ value: String(annId) }] }, { op: 'replace', path: 'members', value: [{ value: String(janeRow.id) }] }]))).json.members.map((m) => m.value).join() === String(janeRow.id));
  check('remove all members (no value)', (await scim('PATCH', '/Groups/iro-unix', patchOps([{ op: 'remove', path: 'members' }]))).json.members.length === 0);
  check('PUT replaces the whole membership', (await scim('PUT', '/Groups/iro-unix', { displayName: 'IRO-UNIX', members: [{ value: String(annId) }, { value: String(janeRow.id) }] })).json.members.length === 2 && (await scim('PUT', '/Groups/iro-unix', { members: [] })).json.members.length === 0);
  check('the name of a group cannot be changed', isError(await scim('PUT', '/Groups/iro-unix', { displayName: 'Renamed', members: [] }), 400, 'mutability') && isError(await scim('PATCH', '/Groups/iro-unix', patchOps([{ op: 'replace', path: 'displayName', value: 'Renamed' }])), 400, 'mutability') && (await scim('GET', '/Groups/iro-unix')).json.displayName === 'IRO-UNIX');
  check('a member who does not exist, is not a number, or was anonymised is refused, and nothing is half done', isError(await scim('PATCH', '/Groups/iro-unix', patchOps([{ op: 'add', path: 'members', value: [{ value: String(annId) }, { value: '999999' }] }])), 400, 'invalidValue', /No such person/)
    && isError(await scim('PATCH', '/Groups/iro-unix', patchOps([{ op: 'add', path: 'members', value: [{ value: 'abc' }] }])), 400, 'invalidValue') && isError(await scim('PATCH', '/Groups/iro-unix', patchOps([{ op: 'add', path: 'members', value: [{ value: ghost.id }] }])), 400, 'invalidValue')
    && (await scim('GET', '/Groups/iro-unix')).json.members.length === 0);
  check('a bad group patch is refused', isError(await scim('PATCH', '/Groups/iro-unix', patchOps([{ op: 'add', path: 'owner', value: 1 }])), 400, 'invalidPath') && isError(await scim('PATCH', '/Groups/iro-unix', patchOps([{ op: 'add', path: 'members', value: 'x' }])), 400, 'invalidValue') && isError(await scim('PATCH', '/Groups/iro-unix', patchOps([{ op: 'move', path: 'members' }])), 400, 'invalidSyntax'));
  const gAudit = await lastAudit('scim.group.members');
  check('membership changes are audited by group, with who was added and removed', gAudit && gAudit.target_name === 'IRO-UNIX' && /added/.test(gAudit.detail) && gAudit.actor_name === `SCIM: Okta ${tag}`);
  await scim('PUT', '/Groups/iro-unix', { members: [{ value: String(annId) }] });
  const annGroups = (await scim('GET', `/Users/${annId}`)).json.groups;
  check('a person in a group reads back the group even after a PUT of the person (PUT does not touch groups)', annGroups.length === 1 && (await scim('PUT', `/Users/${annId}`, userBody('ann', { userName: `ann${tag}@corp.local`, groups: [] }))).json.groups.length === 1);
  await scim('PUT', '/Groups/iro-unix', { members: [] });
  await adminSettings({ allowGroups: false });

  // ----------------------------------------------------------------------------------- single sign-on of a provisioned person
  section = 'single sign-on';
  const idp = (p, body) => fetch(IDP + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
  const sso = async (identity) => {
    await idp('/__next', identity);
    const person = new Browser(base);
    const start = await person.get('/auth/oidc/start');
    if (start.status !== 302) return { person, start };
    const auth = await fetch(start.loc, { redirect: 'manual' });
    const back = new URL(auth.headers.get('location'));
    const cb = await person.get(back.pathname + back.search);
    return { person, start, cb };
  };
  const hire = (await scim('POST', '/Users', userBody('hire', { roles: [{ value: 'agent' }] }))).json;
  const hireEmail = `hire${tag}@corp.local`;
  const first = await sso({ sub: `sub-hire-${tag}`, email: hireEmail, email_verified: true, name: 'Hire Tester' });
  const me = first.cb && first.cb.status === 302 ? await first.person.get('/profile') : { text: '' };
  check('a person the provider created signs in with single sign-on, and is the account SCIM made (not a second one)', first.cb && first.cb.status === 302 && first.cb.loc === '/' && me.text.includes(`value="hire${tag}@corp.local"`) && await count('SELECT count(*) AS c FROM users WHERE lower(email) = ?', [hireEmail]) === 1);
  check('with the role the provider gave', (await dbUser(hire.id)).role === 'agent' && (await first.person.get('/incidents')).status === 200);
  check('the first sign-in linked the identity to that account', await count('SELECT count(*) AS c FROM user_identities WHERE user_id = ?', [hire.id]) === 1);
  const offSso = await scim('PATCH', `/Users/${hire.id}`, patchOps([{ op: 'Replace', path: 'active', value: 'False' }]));
  check('the provider switches them off: the open sign-in ends', offSso.json.active === false && (await first.person.get('/profile')).status === 302);
  const refused = await sso({ sub: `sub-hire-${tag}`, email: hireEmail, email_verified: true });
  check('and single sign-on is refused with "turned off"', refused.cb && refused.cb.status === 401 && /turned off/.test(refused.cb.text));
  await scim('PATCH', `/Users/${hire.id}`, patchOps([{ op: 'Replace', path: 'active', value: 'True' }]));
  const back = await sso({ sub: `sub-hire-${tag}`, email: hireEmail, email_verified: true });
  check('switched on again, they sign in again', back.cb && back.cb.status === 302 && back.cb.loc === '/');
  const early = (await scim('POST', '/Users', userBody('early'))).json;
  const unverified = await sso({ sub: `sub-early-${tag}`, email: `early${tag}@corp.local`, email_verified: false });
  check('a provisioned person is still only matched by email when the provider verified it', unverified.cb && unverified.cb.status === 401 && /not verified your email/.test(unverified.cb.text) && await count('SELECT count(*) AS c FROM user_identities WHERE user_id = ?', [early.id]) === 0);
  const rename = await scim('PATCH', `/Users/${hire.id}`, patchOps([{ op: 'replace', path: 'emails.value', value: `hire.moved${tag}@corp.local` }]));
  const byStableId = await sso({ sub: `sub-hire-${tag}`, email: `hire.moved${tag}@corp.local`, email_verified: true });
  check('after SCIM changes their email, the sign-in still finds them by the provider\'s stable id', rename.status === 200 && byStableId.cb && byStableId.cb.status === 302 && await count('SELECT count(*) AS c FROM user_identities WHERE user_id = ?', [hire.id]) === 1);

  // --------------------------------------------------------------------------------------------------- the audit log, privacy
  section = 'audit and privacy';
  const kinds = (await q("SELECT DISTINCT action FROM audit_log WHERE action LIKE 'scim.%' ORDER BY 1")).map((r) => r.action);
  check('every kind of action was recorded', ['scim.group.members', 'scim.settings.changed', 'scim.token.created', 'scim.token.revoked', 'scim.user.created', 'scim.user.deactivated', 'scim.user.deleted', 'scim.user.reactivated', 'scim.user.updated'].every((k) => kinds.includes(k)), kinds.join());
  const listed = await admin.get('/settings/scim');
  check('the page shows recent SCIM activity and how many people SCIM manages', /scim\.user\.created/.test(listed.text) && /\d+ so far/.test(listed.text));
  const rows = await q("SELECT actor_id, actor_name FROM audit_log WHERE action LIKE 'scim.user.%' OR action = 'scim.group.members'");
  check('every provisioning action is by a token, never a person', rows.length > 10 && rows.every((r) => r.actor_id === null && /^SCIM: /.test(r.actor_name)));
  check('no token value is anywhere in the audit log', await count('SELECT count(*) AS c FROM audit_log WHERE detail LIKE ? OR target_name LIKE ?', ['%nds_%', '%nds_%']) === 0);
  const exportFile = JSON.parse((await admin.post(`/privacy/person/${annId}/export`)).text);
  check('the privacy export says the person is provisioned by an identity provider', exportFile.profile.provisioned_by_identity_provider === true);

  // ------------------------------------------------------------------------------------------------------------ rate limits
  section = 'rate limits';
  const secondary = start(18272, { PUBLIC_URL: `http://127.0.0.1:18272`, RATE_LIMIT_SCIM_PER_MIN: '8', RATE_LIMIT_IP_PER_MIN: '60' });
  try {
    if (!(await healthy(18272, secondary))) throw new Error('the second NovaDesk did not start');
    const t2 = await tokens.createToken({ name: `limit ${tag}`, expiresInDays: 90, createdBy: null });
    const t3 = await tokens.createToken({ name: `other ${tag}`, expiresInDays: 90, createdBy: null });
    const hit = (t) => fetch('http://127.0.0.1:18272/scim/v2/ServiceProviderConfig', { headers: { Authorization: `Bearer ${t}` } });
    const results = []; for (let i = 0; i < 10; i++) results.push(await hit(t2.token));
    check('a token over its allowance (8 a minute here) is told to wait, in SCIM\'s shape, with Retry-After', results.slice(0, 8).every((r) => r.status === 200) && results[8].status === 429 && Number(results[8].headers.get('retry-after')) > 0 && JSON.parse(await results[8].text()).status === '429');
    check('another token is not affected', (await hit(t3.token)).status === 200);
    const flood = []; for (let i = 0; i < 70; i++) flood.push((await fetch('http://127.0.0.1:18272/scim/v2/Users', { headers: { Authorization: `Bearer ${t3.token}` } })).status);
    const limited = await fetch('http://127.0.0.1:18272/scim/v2/Users', { headers: { Authorization: `Bearer ${t3.token}` } });
    check('the per-address safety net answers SCIM clients in SCIM\'s shape too', limited.status === 429 && /scim\+json/.test(limited.headers.get('content-type')) && JSON.parse(await limited.text()).schemas[0] === SCHEMA_ERROR && flood.includes(429));
  } finally { secondary.child.kill(); await secondary.exited; }
  const floodFail = []; for (let i = 0; i < 34; i++) floodFail.push((await scim('GET', '/Users', undefined, { token: `nds_${crypto.randomBytes(30).toString('base64url')}` })).status);
  const firstBlocked = floodFail.indexOf(429);
  check('guessing tokens is slowed down: after 30 wrong ones from one address the answer is 429, and stays 429', firstBlocked > 0 && firstBlocked <= 31 && floodFail.slice(firstBlocked).every((s) => s === 429) && floodFail.slice(0, firstBlocked).every((s) => s === 401), floodFail.join());
  check('but a right token still works from that address, so a flood cannot lock the provider out', (await scim('GET', '/Users')).status === 200);

  // leave the settings as found
  await q('UPDATE scim_settings SET allow_admin = ?, allow_groups = ?, default_role = ?', [settingsBefore.allow_admin, settingsBefore.allow_groups, settingsBefore.default_role]);
  await q('UPDATE scim_tokens SET revoked_at = ? WHERE revoked_at IS NULL', ['2026-01-01 00:00:00']);
  section = 'the log';
  const errors = app.text().split('\n').filter((l) => /error|unhandled|exception|failed/i.test(l) && !/\[SCIM\] refused/.test(l));
  check('the server log shows no errors from any of this', errors.length === 0, errors.slice(-3).join(' | '));
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASS');
  process.exitCode = failed ? 1 : 0;
}

// The privacy module opens its own database pool in this process, so end explicitly rather than wait for it to idle out.
main().then(() => process.exit(process.exitCode || 0), (e) => { console.error(e); process.exit(1); });
