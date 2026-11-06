// Branding: the product name, logo, accent colour and sign-in wording an organisation shows its people.
//
// One row (branding_settings). Everything left empty is the built-in NovaDesk look, so an install that never opens
// Settings > Branding looks as it always did. What a setting changes:
//   name     the navigation bar, the sign-in pages, the browser tab, outgoing email, the two-step verification label
//   logo     the navigation bar, the sign-in pages, the browser tab icon, the top of outgoing email (when PUBLIC_URL is set)
//   accent   links, buttons, the navigation bar and the sign-in page, in both the light and the dark theme
//   wording  the two lines above the sign-in form, and a closing line on outgoing email
// Not changed: the names integrations rely on (the X-NovaDesk-* webhook headers, the SCIM and API schemas).
//
// The accent colour is checked, not trusted: white text must stay readable on it (the navigation bar) and, lightened for
// the dark theme, it must stay readable as a link on the dark page. The shades the pages need are worked out from it here.
'use strict';
const crypto = require('crypto');
const { db, nowStr } = require('./db');
const tenancy = require('./tenancy');

const DEFAULTS = { name: 'NovaDesk', welcome: 'Welcome to', tagline: 'Sign in to your account' };
const LIMITS = { name: 40, welcome: 60, tagline: 120, footer: 300, logoBytes: 512 * 1024, backgroundBytes: 2 * 1024 * 1024 };
const BACKGROUNDS = ['builtin', 'plain', 'custom'];
const MIN_CONTRAST = 4.5;     // WCAG AA for body text
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];
const DARK_SURFACE = [23, 30, 41];     // --surface in the dark theme (style.css)
const LOGIN_INK = [5, 19, 31];         // the dark text on the sign-in button (#05131f)

class BrandingError extends Error {}

// ---- colour
const HEX = /^#[0-9a-f]{6}$/i;
const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb) => `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const luminance = (rgb) => {
  const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
// The least that `rgb` has to be mixed toward `toward` for `against` to read on it at `ratio` or better.
function shadeFor(rgb, toward, against, ratio) {
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const c = mix(rgb, toward, t);
    if (contrast(c, against) >= ratio) return c;
  }
  return toward;
}
const triple = (rgb) => rgb.map((v) => Math.round(v)).join(', ');

// Checks a colour typed or picked by an administrator. Returns the normalised "#rrggbb", or null for "use the default".
function checkAccent(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return null;
  if (!HEX.test(t)) throw new BrandingError('The colour must be six hexadecimal digits after a #, for example #0b6e4f.');
  const hex = t.toLowerCase();
  const ratio = contrast(toRgb(hex), WHITE);
  if (ratio < MIN_CONTRAST) throw new BrandingError(`${hex} is too light: white text on it would be hard to read (contrast ${ratio.toFixed(1)}, at least ${MIN_CONTRAST} is needed). Choose a darker shade.`);
  return hex;
}

// Every shade the pages use, from the one colour. Light theme: the colour itself and a darker partner for the bar.
// Dark theme: the colour lightened until it reads on the dark page. Sign-in page (always dark): two light shades the
// dark button text reads on.
function palette(accent) {
  const base = toRgb(accent);
  const lightDark = shadeFor(base, WHITE, DARK_SURFACE, MIN_CONTRAST);
  const loginB = shadeFor(base, WHITE, LOGIN_INK, 9);
  const loginA = shadeFor(base, WHITE, LOGIN_INK, 5);
  return {
    light: { brand: accent, brandDark: toHex(mix(base, BLACK, 0.34)) },
    dark: { brand: toHex(lightDark), brandDark: toHex(mix(lightDark, BLACK, 0.62)), hover: toHex(mix(lightDark, WHITE, 0.25)) },
    login: { a: toHex(loginA), b: toHex(loginB), titleEnd: toHex(mix(loginB, WHITE, 0.45)) },
    rgb: { light: triple(base), lightDark: triple(mix(base, BLACK, 0.34)), dark: triple(lightDark), darkDark: triple(mix(lightDark, BLACK, 0.62)), darkHover: triple(mix(lightDark, WHITE, 0.25)), loginA: triple(loginA), loginB: triple(loginB) },
  };
}

// The <style> text that restyles the pages. Only numbers and hex digits produced above go into it.
// Besides the application's own --brand colours, Bootstrap's "primary" (buttons, outline buttons, links, pagination, the
// ticked box, the focus ring) is pointed at the accent, so the whole application changes colour and not only the bar.
// Buttons keep the accent itself as their background in both themes, because white text is known to read on it.
function cssFor(accent) {
  if (!accent) return '';
  const p = palette(accent);
  const A = p.light.brand; const AD = p.light.brandDark; const R = p.rgb.light;
  return `:root{--brand:${A};--brand-dark:${AD};--brand-rgb:${R};--brand-dark-rgb:${p.rgb.lightDark};`
    + `--login-a:${p.login.a};--login-b:${p.login.b};--login-link:${p.login.b};--login-title-end:${p.login.titleEnd};--lg1:${p.rgb.loginB};--lg2:${p.rgb.loginA};--lg3:${p.rgb.loginB};`
    + `--bs-primary:${A};--bs-primary-rgb:${R};--bs-link-color:${A};--bs-link-color-rgb:${R};--bs-link-hover-color:${AD};--bs-link-hover-color-rgb:${p.rgb.lightDark}}`
    + `[data-bs-theme="dark"]{--brand:${p.dark.brand};--brand-dark:${p.dark.brandDark};--brand-rgb:${p.rgb.dark};--brand-dark-rgb:${p.rgb.darkDark};`
    + `--bs-primary:${p.dark.brand};--bs-primary-rgb:${p.rgb.dark};--bs-link-color:${p.dark.brand};--bs-link-color-rgb:${p.rgb.dark};--bs-link-hover-color:${p.dark.hover};--bs-link-hover-color-rgb:${p.rgb.darkHover}}`
    + `.btn-primary{--bs-btn-color:#fff;--bs-btn-bg:${A};--bs-btn-border-color:${A};--bs-btn-hover-color:#fff;--bs-btn-hover-bg:${AD};--bs-btn-hover-border-color:${AD};--bs-btn-active-color:#fff;--bs-btn-active-bg:${AD};--bs-btn-active-border-color:${AD};--bs-btn-disabled-color:#fff;--bs-btn-disabled-bg:${A};--bs-btn-disabled-border-color:${A};--bs-btn-focus-shadow-rgb:${R}}`
    + `.btn-outline-primary{--bs-btn-color:var(--bs-primary);--bs-btn-border-color:var(--bs-primary);--bs-btn-hover-color:#fff;--bs-btn-hover-bg:${A};--bs-btn-hover-border-color:${A};--bs-btn-active-color:#fff;--bs-btn-active-bg:${AD};--bs-btn-active-border-color:${AD};--bs-btn-disabled-color:var(--bs-primary);--bs-btn-disabled-border-color:var(--bs-primary);--bs-btn-focus-shadow-rgb:${R}}`
    + `.btn-link{--bs-btn-color:var(--bs-link-color);--bs-btn-hover-color:var(--bs-link-hover-color)}`
    + `.pagination{--bs-pagination-color:var(--bs-link-color);--bs-pagination-hover-color:var(--bs-link-hover-color);--bs-pagination-active-bg:${A};--bs-pagination-active-border-color:${A};--bs-pagination-active-color:#fff}`
    + `.list-group{--bs-list-group-active-bg:${A};--bs-list-group-active-border-color:${A}}`
    + `.nav-pills{--bs-nav-pills-link-active-bg:${A}}`
    + `.dropdown-menu{--bs-dropdown-link-active-bg:${A}}`
    + `.form-check-input:checked,.form-check-input[type=checkbox]:indeterminate{background-color:${A};border-color:${A}}`
    + `.form-control:focus,.form-select:focus,.form-check-input:focus{border-color:rgba(${R},.6);box-shadow:0 0 0 .25rem rgba(${R},.25)}`
    + `.progress{--bs-progress-bar-bg:${A}}`;
}

// ---- the logo
// Read from the first bytes, never from the file name or the type the browser claims. SVG is refused: a picture that
// can carry script has no place on the same address as the application.
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 6).toString('latin1') === 'GIF87a' || buf.subarray(0, 6).toString('latin1') === 'GIF89a') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
// What a picture is called in a message, and how large it may be.
const KINDS = {
  logo: { noun: 'logo', limit: LIMITS.logoBytes, hint: 'a logo rarely needs more than 400 pixels across' },
  background: { noun: 'background picture', limit: LIMITS.backgroundBytes, hint: 'about 1920 pixels wide, saved as a JPEG, is plenty' },
};
function checkPicture(buf, kind = 'logo') {
  const k = KINDS[kind];
  if (buf.length > k.limit) throw new BrandingError(`The ${k.noun} is ${(buf.length / 1024).toFixed(0)} KB; the limit is ${k.limit / 1024} KB. Use a smaller picture (${k.hint}).`);
  const mime = sniffImage(buf);
  if (!mime) {
    const head = buf.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
    if (head.startsWith('<svg') || head.startsWith('<?xml')) throw new BrandingError(`An SVG ${k.noun} is not accepted, because an SVG can carry script. Export it as a PNG, JPEG, GIF or WebP picture instead.`);
    throw new BrandingError(`The ${k.noun} must be a PNG, JPEG, GIF or WebP picture.`);
  }
  return { mime, version: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12) };
}
const checkLogo = (buf) => checkPicture(buf, 'logo');

// ---- the text
const clean = (v) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
function text(v, label, max, { required = false } = {}) {
  const t = clean(v);
  if (!t) { if (required) throw new BrandingError(`${label} cannot be empty.`); return null; }
  if ([...t].length > max) throw new BrandingError(`${label} can be at most ${max} characters.`);
  return t;
}
// The email footer may have line breaks, so it is cleaned line by line.
function footerText(v) {
  const lines = String(v == null ? '' : v).replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/[ \t]+/g, ' ').trim());
  const t = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!t) return null;
  if ([...t].length > LIMITS.footer) throw new BrandingError(`The email footer can be at most ${LIMITS.footer} characters.`);
  return t;
}

// What an administrator typed, checked. Throws BrandingError with a sentence to show. `files` holds the uploaded pictures
// ({ logo, background }, each a Buffer or absent). `had` says whether a background picture is already stored.
function validate(body, files, { hadBackground = false } = {}) {
  const b = body || {};
  const sent = files || {};
  const out = {
    product_name: text(b.product_name, 'The product name', LIMITS.name, { required: true }),
    accent_color: checkAccent(b.accent_color),
    login_welcome: text(b.login_welcome, 'The welcome line', LIMITS.welcome),
    login_tagline: text(b.login_tagline, 'The sign-in line', LIMITS.tagline),
    email_footer: footerText(b.email_footer),
    logo: null,
    removeLogo: b.remove_logo === 'on' || b.remove_logo === '1',
    login_background: String(b.login_background || 'builtin'),
    background: null,
  };
  if (!BACKGROUNDS.includes(out.login_background)) throw new BrandingError('Choose what goes behind the sign-in card: the built-in picture, a plain backdrop, or your own picture.');
  if (sent.logo) out.logo = { buffer: sent.logo, ...checkPicture(sent.logo, 'logo') };
  if (sent.background) out.background = { buffer: sent.background, ...checkPicture(sent.background, 'background') };
  // Uploading a picture means "use it".
  if (out.background) out.login_background = 'custom';
  if (out.login_background === 'custom' && !out.background && !hadBackground) throw new BrandingError('Choose a picture to put behind the sign-in card, or pick another background.');
  return out;
}

// ---- reading
// One entry for each tenant.
const caches = new Map();
const TTL_MS = 5000;
const tenantKey = () => tenancy.currentId() || 0;
const invalidate = () => { caches.delete(tenantKey()); };

function viewModel(row) {
  const r = row || {};
  const name = r.product_name || DEFAULTS.name;
  const logoUrl = r.logo_version ? `/branding/logo?v=${r.logo_version}` : null;
  const backgroundUrl = r.background_version ? `/branding/background?v=${r.background_version}` : null;
  const mode = r.login_background === 'plain' ? 'plain' : (r.login_background === 'custom' && backgroundUrl ? 'custom' : 'builtin');
  return {
    name,
    titleName: name === DEFAULTS.name ? 'NovaDesk ITSM' : name,
    isDefaultName: name === DEFAULTS.name,
    accent: r.accent_color || null,
    css: cssFor(r.accent_color),
    logoUrl,
    iconUrl: logoUrl || '/img/novadesk-icon.png',
    welcome: r.login_welcome || DEFAULTS.welcome,
    tagline: r.login_tagline || DEFAULTS.tagline,
    footer: r.email_footer || '',
    loginBackground: mode,
    backgroundUrl,
    // On the sign-in pages' outer element: the class and (for the organisation's own picture) the picture. Built from hex digits only.
    loginClass: mode === 'plain' ? ' login-plain' : (mode === 'custom' ? ' login-custom-bg' : ''),
    loginStyle: mode === 'custom' ? ` style="background-image:url('${backgroundUrl}')"` : '',
    raw: { welcome: r.login_welcome || '', tagline: r.login_tagline || '' },
    updatedAt: r.updated_at || null,
  };
}

async function get() {
  const key = tenantKey();
  const hit = caches.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value;
  try {
    const row = await db.prepare('SELECT product_name, accent_color, login_welcome, login_tagline, email_footer, logo_version, login_background, background_version, updated_at FROM branding_settings WHERE tenant_id = nd_tenant()').get();
    value = viewModel(row);
  } catch (err) {
    // The database being down must not take the error pages with it: show the built-in look (and do not ask again for a second).
    const fallback = { at: Date.now() - TTL_MS + 1000, value: viewModel(null) };
    caches.set(key, fallback);
    return fallback.value;
  }
  caches.set(key, { at: Date.now(), value });
  return value;
}

// A stored picture, or null. The column names come from this table, never from a request.
const PICTURES = { logo: ['logo', 'logo_mime', 'logo_version'], background: ['background', 'background_mime', 'background_version'] };
async function picture(kind) {
  const [data, mime, version] = PICTURES[kind];
  const row = await db.prepare(`SELECT ${data} AS data, ${mime} AS mime, ${version} AS version FROM branding_settings WHERE tenant_id = nd_tenant()`).get();
  if (!row || !row.data || !row.mime) return null;
  return { buffer: Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data), mime: row.mime, version: row.version };
}
const logo = () => picture('logo');

// ---- writing
// What changed, in words, for the audit log (never the picture itself).
function describeChange(before, after, pictureChanges) {
  const parts = [];
  if (before.name !== after.name) parts.push(`name "${before.name}" -> "${after.name}"`);
  if ((before.accent || '') !== (after.accent || '')) parts.push(`colour ${before.accent || 'default'} -> ${after.accent || 'default'}`);
  if (before.raw.welcome !== after.raw.welcome) parts.push('welcome line');
  if (before.raw.tagline !== after.raw.tagline) parts.push('sign-in line');
  if (before.footer !== after.footer) parts.push('email footer');
  if (before.loginBackground !== after.loginBackground) parts.push(`sign-in background ${before.loginBackground} -> ${after.loginBackground}`);
  parts.push(...pictureChanges);
  return parts.join('; ') || 'saved without changes';
}

async function save(values, actor) {
  const before = await get();
  const changes = [];
  await db.transaction(async (tx) => {
    await tx.prepare('UPDATE branding_settings SET product_name = ?, accent_color = ?, login_welcome = ?, login_tagline = ?, email_footer = ?, login_background = ?, updated_at = ?, updated_by = ? WHERE tenant_id = nd_tenant()')
      .run(values.product_name, values.accent_color, values.login_welcome, values.login_tagline, values.email_footer, values.login_background, nowStr(), actor ? actor.id : null);
    if (values.logo) {
      await tx.prepare('UPDATE branding_settings SET logo = ?, logo_mime = ?, logo_version = ? WHERE tenant_id = nd_tenant()').run(values.logo.buffer, values.logo.mime, values.logo.version);
      changes.push(`logo replaced (${values.logo.mime}, ${Math.ceil(values.logo.buffer.length / 1024)} KB)`);
    } else if (values.removeLogo) {
      await tx.prepare('UPDATE branding_settings SET logo = NULL, logo_mime = NULL, logo_version = NULL WHERE tenant_id = nd_tenant()').run();
      changes.push('logo removed');
    }
    if (values.background) {
      await tx.prepare('UPDATE branding_settings SET background = ?, background_mime = ?, background_version = ? WHERE tenant_id = nd_tenant()').run(values.background.buffer, values.background.mime, values.background.version);
      changes.push(`sign-in picture replaced (${values.background.mime}, ${Math.ceil(values.background.buffer.length / 1024)} KB)`);
    }
  });
  invalidate();
  return describeChange(before, await get(), changes);
}

async function reset(actor) {
  await db.prepare("UPDATE branding_settings SET product_name = ?, accent_color = NULL, login_welcome = NULL, login_tagline = NULL, email_footer = NULL, logo = NULL, logo_mime = NULL, logo_version = NULL, login_background = 'builtin', background = NULL, background_mime = NULL, background_version = NULL, updated_at = ?, updated_by = ? WHERE tenant_id = nd_tenant()")
    .run(DEFAULTS.name, nowStr(), actor ? actor.id : null);
  invalidate();
}

// ---- in the pages
// Every page gets `brand` (name, colours, logo, wording). Never throws.
async function middleware(req, res, next) {
  res.locals.brand = await get();
  next();
}

// The picture itself. Public (the sign-in page shows it), cached by the browser for as long as its ?v= stays the same.
const serveLogo = (req, res) => servePicture('logo', req, res);
const serveBackground = (req, res) => servePicture('background', req, res);
async function servePicture(kind, req, res) {
  const l = await picture(kind);
  if (!l) return res.status(404).type('text/plain').send(`No ${kind} has been set.`);
  res.set({
    'Content-Type': l.mime,
    'Content-Length': String(l.buffer.length),
    'Cache-Control': 'public, max-age=3600',
    ETag: `"${l.version}"`,
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Content-Disposition': 'inline',
  });
  if (req.get('if-none-match') === `"${l.version}"`) return res.status(304).end();
  return res.end(l.buffer);
}

// ---- in email
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const publicUrl = () => (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');

// The name on the From line of the sandbox mailbox and in the authenticator app. No characters that mean something in either place.
const plainName = (name) => String(name).replace(/["\\:<>]/g, ' ').replace(/\s+/g, ' ').trim() || DEFAULTS.name;
async function senderName() {
  const b = await get();
  return b.isDefaultName ? 'NovaDesk ITSM' : plainName(b.name);
}
async function issuerName() { return plainName((await get()).name); }

// The same words around every notice: the name (and logo, when the server knows its own address), the message, a closing line.
async function emailFrame(html) {
  const b = await get();
  const accent = b.accent || '#2f4b7c';
  const base = publicUrl();
  const logoImg = b.logoUrl && base ? `<img src="${esc(base + b.logoUrl)}" alt="" height="32" style="height:32px;vertical-align:middle;margin-right:10px;border:0">` : '';
  const closing = b.footer ? esc(b.footer).replace(/\n/g, '<br>') : `Sent by ${esc(b.name)}.`;
  return `<div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1c2530;max-width:640px">`
    + `<div style="border-top:4px solid ${esc(accent)};padding:12px 0 8px">${logoImg}<strong style="font-size:17px;color:${esc(accent)};vertical-align:middle">${esc(b.name)}</strong></div>`
    + `<div>${html}</div>`
    + `<div style="border-top:1px solid #e3e7ee;margin-top:24px;padding-top:10px;font-size:12px;color:#6c757d">${closing}</div></div>`;
}

module.exports = {
  DEFAULTS, LIMITS, BACKGROUNDS, BrandingError, MIN_CONTRAST,
  toRgb, toHex, mix, contrast, luminance, checkAccent, palette, cssFor,
  sniffImage, checkLogo, checkPicture, validate, viewModel, get, logo, picture, save, reset, invalidate,
  middleware, serveLogo, serveBackground, senderName, issuerName, emailFrame, plainName,
};
