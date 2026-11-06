#!/usr/bin/env node
// Branding, end to end, against a copy of NovaDesk that this script starts itself (port 18320) on the database named by
// PGHOST, PGUSER, PGPASSWORD and PGDATABASE: the built-in look when nothing is set, who may change it, the name, wording,
// colour and logo on every kind of page, each refusal (empty or long text, a colour too light to read, an SVG or a
// disguised file as a logo, a logo that is too big), the logo's own address (headers, caching, public), the email frame,
// the two-step label, the audit log, and putting everything back.
// Needs the demonstration users. Leaves the branding at the built-in look.
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const zlib = require('zlib');
const knexLib = require('knex');
const { dbConfig } = require('../src/settings');
const branding = require('../src/branding');

const ROOT = path.join(__dirname, '..');
let failed = 0; let section = '';
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  [${section}] ${name}${!ok && extra ? '  -- ' + String(extra).slice(0, 400) : ''}`); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Math.random().toString(36).slice(2, 7);

class Browser {
  constructor(base) { this.base = base; this.cookie = ''; this.csrf = null; }
  jar(res) { for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]; const j = Object.fromEntries(this.cookie.split('; ').filter(Boolean).map((x) => [x.split('=')[0], x])); j[kv.split('=')[0]] = kv; this.cookie = Object.values(j).join('; '); } }
  async raw(method, p, { form, multipart, headers = {} } = {}) {
    const h = { Cookie: this.cookie, ...headers }; let body;
    if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    if (multipart) body = multipart;
    const res = await fetch(this.base + p, { method, headers: h, body, redirect: 'manual' });
    this.jar(res);
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    const meta = text.match(/<meta name="csrf-token" content="([^"]+)"/); if (meta) this.csrf = meta[1];
    return { status: res.status, loc: res.headers.get('location'), text, buf, headers: res.headers };
  }
  get(p, headers) { return this.raw('GET', p, { headers }); }
  async ensureToken() { if (!this.csrf) { await this.get('/login'); if (!this.csrf) await this.get('/profile'); } return this.csrf; }
  async post(p, form = {}, { token = true } = {}) { await this.ensureToken(); const r = await this.raw('POST', p, { form: { ...(token ? { _csrf: this.csrf } : {}), ...form } }); if (r.headers.getSetCookie().length) this.csrf = null; return r; }
  // A form with a file in it, as a browser sends it. file: { buf, name, type } or null (then no file part is sent at all).
  async upload(p, fields = {}, file = null, { token = true } = {}) {
    await this.ensureToken();
    const fd = new FormData();
    if (token) fd.append('_csrf', this.csrf);
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    if (file) fd.append(file.field || 'logo', new Blob([file.buf], { type: file.type || 'application/octet-stream' }), file.name || 'logo.bin');
    return this.raw('POST', p, { multipart: fd });
  }
  login(u, pw) { return this.post('/login', { username: u, password: pw }); }
}

function start(port, env) {
  const log = [];
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SEED_DEMO: 'true', SLA_SWEEP_S: '3600', SESSION_SECRET: `br-check-${tag}`, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => log.push(String(d))); child.stderr.on('data', (d) => log.push(String(d)));
  return { child, text: () => log.join(''), exited: new Promise((r) => child.on('exit', r)) };
}
async function healthy(port, srv) { for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true; } catch { /* wait */ } if (srv.child.exitCode !== null) return false; await sleep(500); } return false; }

async function main() {
  const port = 18320; const base = `http://127.0.0.1:${port}`;
  const app = start(port, { PUBLIC_URL: base });
  const knex = knexLib({ client: 'pg', connection: dbConfig(process.env), pool: { min: 0, max: 3 } });
  try {
    if (!(await healthy(port, app))) throw new Error(`NovaDesk did not start: ${app.text().slice(-400)}`);
    await run(base, knex, app);
  } finally { await knex.destroy(); app.child.kill(); await app.exited; }
}

// ---- pictures: a real 1x1 PNG, then padded with a marker so each "logo" is different (a PNG reader ignores what follows IEND)
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const png = (marker, pad = 0) => Buffer.concat([PNG_1PX, Buffer.from(`${marker}`), Buffer.alloc(pad, 0x20)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0'), Buffer.from('jpeg-marker')]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([1, 0, 1, 0, 0, 0, 0]), Buffer.from('gif-marker')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([30, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.from('webp-marker')]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
const sha = (b) => require('crypto').createHash('sha256').update(b).digest('hex');

async function run(base, knex, app) {
  const q = async (sql, params = []) => (await knex.raw(sql, params)).rows;
  const one = async (sql, params = []) => (await q(sql, params))[0];
  const admin = new Browser(base); await admin.login('admin', 'admin123');
  const jane = new Browser(base); await jane.login('jdoe', 'agent123');
  const maria = new Browser(base); await maria.login('mchen', 'user123');
  const anon = new Browser(base);
  const mariaId = (await one("SELECT id FROM users WHERE username = 'mchen'")).id;
  const lastAudit = async (action) => one('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1', [action]);
  const auditCount = async (action) => Number((await one('SELECT count(*) AS c FROM audit_log WHERE action = ?', [action])).c);
  const row = () => one('SELECT product_name, accent_color, login_welcome, login_tagline, email_footer, logo_mime, logo_version, (logo IS NOT NULL) AS has_logo, login_background, background_mime, background_version, (background IS NOT NULL) AS has_background FROM branding_settings WHERE id = 1');
  const FORM = (over = {}) => ({ product_name: 'NovaDesk', accent_color: '', login_welcome: '', login_tagline: '', email_footer: '', login_background: 'builtin', ...over });
  const save = (over, file, b = admin) => b.upload('/settings/branding', FORM(over), file);
  const css = (html) => { const m = html.match(/<style nonce="[^"]*">(:root\{--brand:[^<]*)<\/style>/); return m ? m[1] : null; };
  const varOf = (text, name, theme = 'light') => { const part = theme === 'dark' ? text.slice(text.indexOf('[data-bs-theme="dark"]')) : text.slice(0, text.indexOf('[data-bs-theme="dark"]')); const m = part.match(new RegExp(`--${name}:([^;}]+)`)); return m ? m[1] : null; };

  await admin.post('/settings/branding/reset');   // start from the built-in look, whatever an earlier run left

  // ------------------------------------------------------------------------------------------------------ built-in look
  section = 'built-in look';
  let login = await anon.get('/login');
  check('the sign-in page is the NovaDesk one', login.text.includes('<title>Log In · NovaDesk ITSM</title>') && login.text.includes('<div class="login-title">NovaDesk</div>') && login.text.includes('Welcome to') && login.text.includes('Sign in to your account'));
  check('with the built-in icon, and no colour override', login.text.includes('href="/img/novadesk-icon.png"') && login.text.includes('src="/img/novadesk-icon.png"') && !css(login.text) && !login.text.includes('brand-logo-custom'));
  check('SSO is not set up on this copy, so the greyed-out SSO button is there and does nothing', login.text.includes('id="ssoPlaceholder"') && login.text.includes('aria-disabled="true"') && login.text.includes('Sign in with SSO') && login.text.includes('SSO is not configured for this instance') && !login.text.includes('/auth/oidc/start') && /<button type="button" class="btn login-btn-sso/.test(login.text));
  check('there is no logo to fetch', (await anon.get('/branding/logo')).status === 404);
  const home = await admin.get('/');
  check('the navigation bar says NovaDesk', />NovaDesk<\/span>/.test(home.text) && home.text.includes('/settings/branding'));
  const r0 = await row();
  check('the stored settings are the defaults', r0.product_name === 'NovaDesk' && !r0.accent_color && !r0.has_logo && !r0.login_welcome);

  // ------------------------------------------------------------------------------------------------------ who may change it
  section = 'access';
  check('signed out, the page sends you to sign in', (await anon.get('/settings/branding')).status === 302);
  check('an agent is refused', (await jane.get('/settings/branding')).status === 403);
  check('an end user is refused', (await maria.get('/settings/branding')).status === 403);
  const before = await auditCount('branding.changed');
  const agentTry = await save({ product_name: 'Hijacked' }, null, jane);
  check('an agent cannot save, and nothing changes', agentTry.status === 403 && (await row()).product_name === 'NovaDesk' && await auditCount('branding.changed') === before);
  const noToken = await admin.upload('/settings/branding', FORM({ product_name: 'No token' }), null, { token: false });
  check('a form without the session token is refused', noToken.status === 403 && (await row()).product_name === 'NovaDesk');
  check('an agent cannot reset either', (await jane.post('/settings/branding/reset')).status === 403);
  check('the page for an administrator shows the form', (await admin.get('/settings/branding')).text.includes('name="product_name"'));
  check('the menu entry is only for administrators', !(await jane.get('/')).text.includes('/settings/branding'));

  // ------------------------------------------------------------------------------------------------------ name and wording
  section = 'name and wording';
  const NAME = `Acme Service Desk ${tag}`;
  const ok1 = await save({ product_name: NAME, login_welcome: 'Welcome back to', login_tagline: 'Staff sign-in', email_footer: `Acme IT, ext. 4100\nOpen 08:00-18:00 ${tag}` });
  check('saving redirects back with a notice', ok1.status === 302 && ok1.loc === '/settings/branding' && (await admin.get('/settings/branding')).text.includes('Saved.'));
  login = await anon.get('/login');
  check('the sign-in page uses the name and the two lines', new RegExp(`<div class="login-title[^"]*">${NAME}</div>`).test(login.text) && login.text.includes('Welcome back to') && login.text.includes('Staff sign-in') && !login.text.includes('Sign in to your account'));
  check('the placeholder stays with a branded sign-in page', login.text.includes('id="ssoPlaceholder"'));
  check('the browser tab says it too', login.text.includes(`<title>Log In · ${NAME}</title>`));
  const reg = await anon.get('/register');
  check('the sign-up page uses the name and keeps its own second line', reg.text.includes(`>${NAME}<`) && reg.text.includes('Create your account') && reg.text.includes('Welcome back to'));
  const home2 = await admin.get('/');
  check('the navigation bar says it', home2.text.includes(`<span>${NAME}</span>`));
  check('help text on other pages says it', (await admin.get('/settings/scim')).text.includes(`people in ${NAME} by itself`) && (await admin.get('/privacy')).text.includes(`See everything ${NAME} holds`));
  check('an error page uses it', (await admin.get('/no-such-page')).text.includes(`· ${NAME}</title>`));
  const docs = await anon.get('/api/docs');
  check('the API guide is named for it, but the header names integrations rely on stay', docs.text.includes(`${NAME} API`) && docs.text.includes('X-NovaDesk-Signature') && docs.text.includes('NovaDesk-Webhooks/1'));
  check('the form shows what is saved', (await admin.get('/settings/branding')).text.includes(`value="${NAME}"`));
  const mfaPage = await maria.post('/profile/mfa/setup');
  const mfaGet = await maria.get('/profile/mfa');
  check('two-step setup is labelled with the name for the authenticator app', mfaGet.text.includes(`QR code for the ${NAME} setup key`) && mfaGet.text.includes(`issuer=${encodeURIComponent(NAME)}`), (mfaGet.text.match(/otpauth:[^"]+/) || [''])[0]);
  await maria.post('/profile/mfa/cancel');

  const nasty = '<b>Tom</b> & "Co" \'x\'';
  await save({ product_name: nasty });
  const nastyLogin = await anon.get('/login');
  check('markup in the name is shown as text, never run', !nastyLogin.text.includes('<b>Tom</b>') && nastyLogin.text.includes('&lt;b&gt;Tom&lt;/b&gt; &amp; &#34;Co&#34;'));
  const nastyNav = await admin.get('/');
  check('also in the navigation bar and the tab', !nastyNav.text.includes('<b>Tom</b>') && nastyNav.text.includes('&lt;b&gt;Tom&lt;/b&gt;'));
  await save({ product_name: `  Two   words\n${tag}\t ` });
  check('stray spaces and line breaks are tidied', (await row()).product_name === `Two words ${tag}`);

  const refused = async (over, file, words) => { const b = (await row()); const r = await save(over, file); const a = await row(); return r.status === 400 && words.every((w) => r.text.includes(w)) && JSON.stringify(a) === JSON.stringify(b); };
  check('an empty name is refused', await refused({ product_name: '   ' }, null, ['cannot be empty']));
  check('a name over 40 characters is refused', await refused({ product_name: 'x'.repeat(41) }, null, ['at most 40']));
  check('a name of exactly 40 is fine', (await save({ product_name: 'y'.repeat(40) })).status === 302);
  check('a welcome line over 60 is refused', await refused({ login_welcome: 'w'.repeat(61) }, null, ['at most 60']));
  check('a sign-in line over 120 is refused', await refused({ login_tagline: 't'.repeat(121) }, null, ['at most 120']));
  check('an email footer over 300 is refused', await refused({ email_footer: 'f'.repeat(301) }, null, ['at most 300']));
  const longLogin = await anon.get('/login');
  check('a very long name gets a smaller size on the sign-in page', longLogin.text.includes('login-title-long'));
  await save({ product_name: `Short ${tag}` });
  check('and a short one does not', !(await anon.get('/login')).text.includes('login-title-long'));
  check('emoji and accents are kept', (await save({ product_name: 'Café Ünïcode 🚀' })).status === 302 && (await row()).product_name === 'Café Ünïcode 🚀' && (await anon.get('/login')).text.includes('Café Ünïcode 🚀'));

  // ------------------------------------------------------------------------------------------------------ colour
  section = 'colour';
  await save({ product_name: NAME });
  for (const bad of ['red', '#12', '#12345', '#1234567', '0b6e4f', '#gggggg', 'rgb(1,2,3)', '#0b6e4f; } body { display:none', '</style><script>x</script>']) {
    const r = await save({ accent_color: bad });
    check(`"${bad.slice(0, 30)}" is refused`, r.status === 400 && r.text.includes('six hexadecimal digits') && !(await row()).accent_color);
  }
  const light = await save({ accent_color: '#ffee00' });
  check('a colour too light for white text is refused, with the reason', light.status === 400 && light.text.includes('too light') && light.text.includes('contrast') && !(await row()).accent_color);
  check('white itself is refused', (await save({ accent_color: '#ffffff' })).status === 400);
  const good = await save({ accent_color: '#0B6E4F', product_name: NAME });
  check('a readable colour is accepted and stored in lower case', good.status === 302 && (await row()).accent_color === '#0b6e4f');
  const styled = await admin.get('/incidents');
  const sheet = css(styled.text);
  check('every page carries the derived colours', sheet && varOf(sheet, 'brand') === '#0b6e4f' && /^#[0-9a-f]{6}$/.test(varOf(sheet, 'brand-dark')) && /^\d+, \d+, \d+$/.test(varOf(sheet, 'brand-rgb')), sheet);
  check('the dark theme gets its own lighter shade', sheet && varOf(sheet, 'brand', 'dark') !== '#0b6e4f' && /^#[0-9a-f]{6}$/.test(varOf(sheet, 'brand', 'dark')));
  const dk = branding.toRgb(varOf(sheet, 'brand', 'dark'));
  check('which reads on the dark page (contrast 4.5 or more)', branding.contrast(dk, [23, 30, 41]) >= 4.5);
  check('and white text reads on the light-theme colour (4.5 or more)', branding.contrast(branding.toRgb('#0b6e4f'), [255, 255, 255]) >= 4.5);
  const lb = branding.toRgb(varOf(sheet, 'login-b')); const la = branding.toRgb(varOf(sheet, 'login-a'));
  check('the sign-in button\'s dark text reads on both ends of its gradient', branding.contrast(lb, [5, 19, 31]) >= 9 && branding.contrast(la, [5, 19, 31]) >= 5);
  const loginColoured = await anon.get('/login');
  check('the sign-in page (signed out) carries it too', css(loginColoured.text) === sheet);
  check('nothing outside the derived numbers got into the style block', /^[-a-z0-9:#,.;{}\[\]="\s()!>]+$/.test(sheet));
  check('the form shows the saved colour', (await admin.get('/settings/branding')).text.includes('value="#0b6e4f"'));
  const dark = await save({ accent_color: '#10253a', product_name: NAME });
  const darkSheet = css((await anon.get('/login')).text);
  check('a very dark colour works: the dark theme lightens it until it reads', dark.status === 302 && branding.contrast(branding.toRgb(varOf(darkSheet, 'brand', 'dark')), [23, 30, 41]) >= 4.5);
  await save({ accent_color: '', product_name: NAME });
  check('clearing the colour removes the override', !css((await anon.get('/login')).text) && !(await row()).accent_color);

  // ------------------------------------------------------------------------------------------------------ logo
  section = 'logo';
  const logo1 = png(`one-${tag}`);
  const up = await save({ product_name: NAME }, { buf: logo1, name: 'logo.png', type: 'image/png' });
  check('a PNG is accepted', up.status === 302);
  const st = await row();
  check('it is stored with its type and a short version', st.has_logo && st.logo_mime === 'image/png' && /^[0-9a-f]{12}$/.test(st.logo_version) && st.logo_version === sha(logo1).slice(0, 12));
  const got = await anon.get('/branding/logo');
  check('anyone can fetch it, signed out, and it is the same bytes', got.status === 200 && got.headers.get('content-type') === 'image/png' && got.buf.equals(logo1));
  check('it is cacheable and carries a validator', /max-age=3600/.test(got.headers.get('cache-control') || '') && got.headers.get('etag') === `"${st.logo_version}"`);
  check('it cannot run anything even if opened directly', /sandbox/.test(got.headers.get('content-security-policy') || '') && got.headers.get('x-content-type-options') === 'nosniff');
  const cond = await anon.get('/branding/logo', { 'If-None-Match': `"${st.logo_version}"` });
  check('a browser that has it is told so (304)', cond.status === 304 && cond.buf.length === 0);
  login = await anon.get('/login');
  check('the sign-in page shows it, by an address that changes with the picture', login.text.includes(`src="/branding/logo?v=${st.logo_version}"`) && login.text.includes('login-logo-mark mx-auto brand-logo-custom'));
  check('the tab icon is the logo, without a wrong type', login.text.includes(`rel="icon" href="/branding/logo?v=${st.logo_version}"`));
  const navPage = await admin.get('/');
  check('the navigation bar shows it', navPage.text.includes(`src="/branding/logo?v=${st.logo_version}" alt="" height="28" class="me-2 brand-logo-custom"`));
  check('the form says a logo is in use and offers to remove it', (await admin.get('/settings/branding')).text.includes('Your logo is in use.') && (await admin.get('/settings/branding')).text.includes('name="remove_logo"'));
  const logo2 = png(`two-${tag}`);
  await save({ product_name: NAME }, { buf: logo2, name: 'other.png', type: 'image/png' });
  const st2 = await row();
  check('a new logo replaces the old one, with a new version in the address', st2.logo_version !== st.logo_version && (await anon.get('/branding/logo')).buf.equals(logo2) && (await anon.get('/login')).text.includes(`?v=${st2.logo_version}`));
  check('saving the form again without a file keeps the logo', (await save({ product_name: NAME })).status === 302 && (await row()).logo_version === st2.logo_version);
  const keep = async (file, words, label) => { const r = await save({ product_name: NAME }, file); const a = await row(); return check(label, r.status === 400 && words.every((w) => r.text.includes(w)) && a.logo_version === st2.logo_version, r.text.slice(r.text.indexOf('alert-danger'), r.text.indexOf('alert-danger') + 200)); };
  await keep({ buf: SVG, name: 'logo.svg', type: 'image/svg+xml' }, ['An SVG logo is not accepted'], 'an SVG is refused, and the old logo stays');
  await keep({ buf: SVG, name: 'logo.png', type: 'image/png' }, ['An SVG logo is not accepted'], 'an SVG named .png and typed image/png is still refused');
  await keep({ buf: Buffer.from('<html><script>alert(1)</script></html> padding padding'), name: 'logo.png', type: 'image/png' }, ['PNG, JPEG, GIF or WebP'], 'HTML pretending to be a PNG is refused');
  await keep({ buf: Buffer.from('just some text, not a picture at all'), name: 'logo.jpg', type: 'image/jpeg' }, ['PNG, JPEG, GIF or WebP'], 'text named .jpg is refused');
  await keep({ buf: Buffer.from('GIF'), name: 'tiny.gif', type: 'image/gif' }, ['PNG, JPEG, GIF or WebP'], 'a file too short to be a picture is refused');
  await keep({ buf: png('big', 600 * 1024), name: 'big.png', type: 'image/png' }, ['512 KB'], 'a logo over 512 KB is refused, with the limit');
  await keep({ buf: png('huge', 3 * 1024 * 1024), name: 'huge.png', type: 'image/png' }, ['512 KB'], 'a 3 MB upload is refused before it is read in full');
  check('a logo of exactly the limit is fine', (await save({ product_name: NAME }, { buf: png('edge', branding.LIMITS.logoBytes - PNG_1PX.length - 4), name: 'edge.png', type: 'image/png' })).status === 302);
  for (const [buf, mime, name] of [[JPEG, 'image/jpeg', 'a.jpg'], [GIF, 'image/gif', 'a.gif'], [WEBP, 'image/webp', 'a.webp']]) {
    await save({ product_name: NAME }, { buf, name, type: 'application/octet-stream' });
    const g = await anon.get('/branding/logo');
    check(`${mime} is recognised from its bytes, whatever the browser said`, g.status === 200 && g.headers.get('content-type') === mime && g.buf.equals(buf));
  }
  await save({ product_name: NAME }, { buf: logo2, name: 'wrong.gif', type: 'image/gif' });
  check('the stored type comes from the bytes, not the name or claimed type', (await row()).logo_mime === 'image/png');
  const unique = (await q('SELECT count(*) AS c FROM branding_settings'))[0].c;
  check('there is only ever one settings row', Number(unique) === 1);

  // ------------------------------------------------------------------------------------------------------ sign-in background
  section = 'sign-in background';
  await admin.post('/settings/branding/reset');
  await save({ product_name: NAME, accent_color: '#0b6e4f' });
  const wrapperOf = (html) => (html.match(/<div class="login-wrapper([^"]*)"([^>]*)>/) || [null, null, null]).slice(1);
  check('built in by default: the photograph, no extra class', JSON.stringify(wrapperOf((await anon.get('/login')).text)) === JSON.stringify(['', '']));
  const formHtml = (await admin.get('/settings/branding')).text;
  check('the form shows the three choices and the file box, built in ticked', ['value="builtin" checked', 'value="plain"', 'value="custom"', 'name="background"'].every((t) => formHtml.includes(t)));
  await save({ login_background: 'plain', product_name: NAME, accent_color: '#0b6e4f' });
  check('plain: a class on the sign-in page and the sign-up page', (await Promise.all(['/login', '/register'].map((u) => anon.get(u)))).every((r) => wrapperOf(r.text)[0] === ' login-plain'));
  check('and nothing outside the page changes', !(await admin.get('/incidents')).text.includes('login-plain'));
  check('plain needs no picture and fetching one is 404', (await anon.get('/branding/background')).status === 404 && !(await row()).has_background);
  const noPic = await save({ login_background: 'custom', product_name: NAME });
  check('"my own picture" with none sent or stored is refused, with what to do', noPic.status === 400 && noPic.text.includes('Choose a picture to put behind') && (await row()).login_background === 'plain');
  const bgA = png(`bg-a-${tag}`, 2000);
  const up2 = await save({ login_background: 'plain', product_name: NAME }, { field: 'background', buf: bgA, name: 'office.png', type: 'image/png' });
  check('sending a picture switches "my own" on, whatever was ticked', up2.status === 302 && (await row()).login_background === 'custom' && (await row()).has_background);
  const sb = await row();
  const bgGot = await anon.get('/branding/background');
  check('anyone can fetch it, signed out, with the same safe headers as the logo', bgGot.status === 200 && bgGot.buf.equals(bgA) && bgGot.headers.get('content-type') === 'image/png' && /sandbox/.test(bgGot.headers.get('content-security-policy') || '') && bgGot.headers.get('etag') === `"${sb.background_version}"`);
  check('a browser that has it gets a 304', (await anon.get('/branding/background', { 'If-None-Match': `"${sb.background_version}"` })).status === 304);
  const customPage = await anon.get('/login');
  check('the sign-in page uses it, by an address that changes with the picture', wrapperOf(customPage.text)[0] === ' login-custom-bg' && wrapperOf(customPage.text)[1].includes(`url('/branding/background?v=${sb.background_version}')`), wrapperOf(customPage.text).join('|'));
  check('the logo is a separate thing: it is still not set', !sb.has_logo && (await anon.get('/branding/logo')).status === 404);
  await save({ login_background: 'builtin', product_name: NAME });
  check('switching away keeps the picture stored but stops showing it', wrapperOf((await anon.get('/login')).text)[0] === '' && (await row()).has_background && (await anon.get('/branding/background')).status === 200);
  check('switching back needs no new upload', (await save({ login_background: 'custom', product_name: NAME })).status === 302 && wrapperOf((await anon.get('/login')).text)[0] === ' login-custom-bg');
  const bgB = png(`bg-b-${tag}`, 1_500_000);
  check('a picture over a megabyte is fine for a background (but not for a logo)', (await save({ product_name: NAME }, { field: 'background', buf: bgB, name: 'big.png', type: 'image/png' })).status === 302 && (await anon.get('/branding/background')).buf.equals(bgB));
  check('the same picture sent as a logo is refused', (await save({ product_name: NAME }, { field: 'logo', buf: bgB, name: 'big.png', type: 'image/png' })).status === 400);
  const keepBg = (await row()).background_version;
  const badBg = async (buf, name, type, words, label) => { const r = await save({ product_name: NAME }, { field: 'background', buf, name, type }); return check(label, r.status === 400 && words.every((w) => r.text.includes(w)) && (await row()).background_version === keepBg); };
  await badBg(SVG, 'bg.svg', 'image/svg+xml', ['An SVG background picture is not accepted'], 'an SVG background is refused, and the old picture stays');
  await badBg(Buffer.from('<html>not a picture at all, just a page</html>'), 'bg.jpg', 'image/jpeg', ['background picture must be a PNG'], 'a page named .jpg is refused');
  await badBg(png('huge', 2 * 1024 * 1024 + 500 - PNG_1PX.length - 4), 'huge.png', 'image/png', ['2048 KB'], 'a background over 2 MB is refused, with the limit');
  await badBg(png('enormous', 4 * 1024 * 1024), 'e.png', 'image/png', ['too large'], 'a 4 MB upload is refused before it is read in full');
  const bothSaved = await save({ product_name: NAME }, { field: 'logo', buf: png(`logo-${tag}`), name: 'l.png', type: 'image/png' });
  check('the logo and the background are kept separately', bothSaved.status === 302 && (await row()).has_logo && (await row()).has_background && (await anon.get('/branding/logo')).buf.equals(png(`logo-${tag}`)) && (await anon.get('/branding/background')).buf.equals(bgB));
  check('a forged mode is refused', (await save({ login_background: 'javascript:alert(1)', product_name: NAME })).status === 400);
  check('the audit log says what happened, without the picture', /sign-in picture replaced \(image\/png, \d+ KB\)/.test((await one("SELECT detail FROM audit_log WHERE action = 'branding.changed' AND detail LIKE '%sign-in picture replaced%' ORDER BY id DESC LIMIT 1")).detail) && /sign-in background \w+ -> \w+/.test((await one("SELECT detail FROM audit_log WHERE action = 'branding.changed' AND detail LIKE '%sign-in background%' ORDER BY id DESC LIMIT 1")).detail));

  // ------------------------------------------------------------------------------------------------------ email
  section = 'email';
  await save({ product_name: NAME, accent_color: '#0b6e4f', email_footer: `Acme IT <desk@acme.test> & co\nOpen 08:00-18:00 ${tag}` });
  const stMail = await row();
  const mailStamp = Number((await one('SELECT COALESCE(MAX(id), 0) AS m FROM notifications')).m);
  const inc = await admin.post('/incidents', { short_description: `Brand mail ${tag}`, caller_id: String(mariaId), priority: '3', category: 'Software' });
  const incId = Number((inc.loc || '').split('/').pop());
  // The notice is recorded once the mail server has answered (the sandbox mailbox needs the internet), so wait for it.
  const notice = async (id, after) => { for (let i = 0; i < 60; i++) { const n = await one("SELECT * FROM notifications WHERE related_type = 'incident' AND related_id = ? AND id > ? ORDER BY id DESC LIMIT 1", [id, after]); if (n) return n; await sleep(500); } return null; };
  const mail = await notice(incId, mailStamp);
  check('a notice was recorded for the caller', Boolean(mail) && inc.status === 302, inc.status);
  const body = (mail && mail.body) || '';
  check('it is framed with the name in the accent colour', body.includes(`>${NAME}</strong>`) && body.includes('border-top:4px solid #0b6e4f'));
  check('with the logo, by a full address (the server knows its own address)', body.includes(`<img src="${base}/branding/logo?v=${stMail.logo_version}"`));
  check('and the closing line, escaped, with its line break', body.includes('Acme IT &lt;desk@acme.test&gt; &amp; co<br>Open 08:00-18:00'));
  check('the message itself is still there', body.includes('has been logged'));
  check('the copy kept for Preview is the framed one', !body.includes('Sent by') && body.startsWith('<div style='));
  await save({ product_name: NAME, accent_color: '', email_footer: '' }, null);
  await admin.post('/settings/branding', { _csrf: admin.csrf });   // (a plain form post without a file part: nothing breaks)
  const inc2 = await admin.post('/incidents', { short_description: `Brand mail two ${tag}`, caller_id: String(mariaId), priority: '3', category: 'Software' });
  const mail2 = await notice(Number((inc2.loc || '').split('/').pop()), mailStamp);
  check('with no footer set, it closes with "Sent by <name>."', mail2 && mail2.body.includes(`Sent by ${NAME}.`) && mail2.body.includes('border-top:4px solid #2f4b7c'), mail2 && mail2.body.slice(-200));
  check('the earlier notice is not rewritten', (await one('SELECT body FROM notifications WHERE id = ?', [mail.id])).body === body);
  const prev = await admin.get(`/notifications/${mail.id}`);
  check('Preview shows the framed message', prev.status === 200 && prev.text.includes('has been logged') && prev.text.includes('Acme IT'));

  // ------------------------------------------------------------------------------------------------------ audit
  section = 'audit';
  const a1 = await one("SELECT detail FROM audit_log WHERE action = 'branding.changed' AND detail LIKE '%logo replaced%' ORDER BY id DESC LIMIT 1");
  check('a logo change is recorded as words (type and size), never the picture', a1 && /logo replaced \(image\/png, \d+ KB\)/.test(a1.detail) && a1.detail.length < 500);
  const a2 = await one("SELECT detail, actor_name FROM audit_log WHERE action = 'branding.changed' AND detail LIKE '%colour%' ORDER BY id DESC LIMIT 1");
  check('a colour change says from what to what', a2 && /colour .* -> /.test(a2.detail) && a2.actor_name === 'Alex Admin');
  const a3 = await one("SELECT detail FROM audit_log WHERE action = 'branding.changed' AND detail LIKE '%email footer%' ORDER BY id DESC LIMIT 1");
  check('a footer change is recorded', Boolean(a3));
  const sameCount = await auditCount('branding.changed');
  await save({ product_name: NAME });
  const nothing = await lastAudit('branding.changed');
  check('saving with nothing changed says so', nothing.detail === 'saved without changes' && await auditCount('branding.changed') === sameCount + 1);
  check('a refused save writes nothing to the log', await (async () => { const n = await auditCount('branding.changed'); await save({ product_name: '' }); return await auditCount('branding.changed') === n; })());
  check('the audit page lists it', (await admin.get('/settings/audit')).text.includes('branding.changed'));

  // ------------------------------------------------------------------------------------------------------ reset
  section = 'reset';
  await save({ product_name: NAME, accent_color: '#0b6e4f', login_welcome: 'Hi', login_tagline: 'There', email_footer: 'x' }, { buf: logo1, name: 'l.png', type: 'image/png' });
  const resetRes = await admin.post('/settings/branding/reset');
  check('reset redirects with a notice', resetRes.status === 302 && (await admin.get('/settings/branding')).text.includes('built-in NovaDesk look'));
  const rr = await row();
  check('everything is back to the defaults', rr.product_name === 'NovaDesk' && !rr.accent_color && !rr.has_logo && !rr.logo_mime && !rr.logo_version && !rr.login_welcome && !rr.login_tagline && !rr.email_footer && rr.login_background === 'builtin' && !rr.has_background && !rr.background_version);
  check('and the sign-in picture address is gone too', (await anon.get('/branding/background')).status === 404 && wrapperOf((await anon.get('/login')).text)[0] === '');
  login = await anon.get('/login');
  check('the sign-in page is the built-in one again, at once', login.text.includes('<div class="login-title">NovaDesk</div>') && login.text.includes('Welcome to') && !css(login.text) && login.text.includes('href="/img/novadesk-icon.png"'));
  check('the logo address is gone', (await anon.get('/branding/logo')).status === 404);
  check('the reset is in the audit log', (await lastAudit('branding.reset')).detail.includes('built-in look'));
  await save({ product_name: NAME }, { buf: logo1, name: 'l.png', type: 'image/png' });
  await save({ product_name: 'NovaDesk', remove_logo: 'on' });
  check('"remove my logo" removes only the logo', !(await row()).has_logo && (await anon.get('/branding/logo')).status === 404 && (await row()).product_name === 'NovaDesk');
  check('removing it is recorded', (await lastAudit('branding.changed')).detail.includes('logo removed'));

  // ------------------------------------------------------------------------------------------------------ the log
  section = 'the log';
  const errors = app.text().split('\n').filter((l) => /error|unhandled|exception|failed/i.test(l) && !/test mailbox|ethereal/i.test(l));
  check('the server log shows no errors from any of this', errors.length === 0, errors.slice(-3).join(' | '));
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASS');
  process.exitCode = failed ? 1 : 0;
}

main().then(() => process.exit(process.exitCode || 0), (e) => { console.error(e); process.exit(1); });
