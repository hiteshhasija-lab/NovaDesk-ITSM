// The parts of branding that need no database: colour maths, the checks on a typed-in colour, name and wording, what is
// accepted as a logo, the style text and the email frame. What happens on real pages is checked by scripts/branding-check.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const b = require('../src/branding');

const WHITE = [255, 255, 255];
const DARK_SURFACE = [23, 30, 41];
const LOGIN_INK = [5, 19, 31];

test('contrast is the WCAG ratio', () => {
  assert.strictEqual(b.contrast([0, 0, 0], WHITE).toFixed(2), '21.00');
  assert.strictEqual(b.contrast(WHITE, WHITE), 1);
  assert.strictEqual(b.contrast(b.toRgb('#777777'), WHITE).toFixed(2), '4.48');
  assert.ok(b.contrast(b.toRgb('#767676'), WHITE) >= 4.5, '#767676 is the lightest grey that passes on white');
});

test('hex and rgb convert both ways, and mixing goes between two colours', () => {
  assert.deepStrictEqual(b.toRgb('#0b6e4f'), [11, 110, 79]);
  assert.strictEqual(b.toHex([11, 110, 79]), '#0b6e4f');
  assert.strictEqual(b.toHex([300, -5, 7.6]), '#ff0008', 'out-of-range values are held to 0-255');
  assert.deepStrictEqual(b.mix([0, 0, 0], [100, 200, 50], 0.5), [50, 100, 25]);
});

test('a colour is accepted only as #rrggbb, normalised to lower case, and only if white text reads on it', () => {
  assert.strictEqual(b.checkAccent('#0B6E4F'), '#0b6e4f');
  assert.strictEqual(b.checkAccent('  #2f4b7c '), '#2f4b7c');
  for (const empty of ['', '   ', null, undefined]) assert.strictEqual(b.checkAccent(empty), null, 'empty means the built-in colour');
  for (const bad of ['red', '#abc', '#12345g', '2f4b7c', '#2f4b7c;', 'rgb(1,2,3)', '#2f4b7c7c', '</style>']) assert.throws(() => b.checkAccent(bad), /six hexadecimal digits/, bad);
  for (const pale of ['#ffffff', '#ffee00', '#aaaaaa', '#7fe3ff']) assert.throws(() => b.checkAccent(pale), /too light/, pale);
  assert.throws(() => b.checkAccent('#ffee00'), (e) => e instanceof b.BrandingError && /contrast \d+\.\d/.test(e.message));
});

test('every readable colour gets shades that read where they are used', () => {
  // A spread across the whole range of colours white text reads on, not a few hand-picked ones.
  let tried = 0;
  for (let r = 0; r < 256; r += 51) for (let g = 0; g < 256; g += 51) for (let bl = 0; bl < 256; bl += 51) {
    const hex = b.toHex([r, g, bl]);
    let accent; try { accent = b.checkAccent(hex); } catch { continue; }
    tried++;
    const p = b.palette(accent);
    assert.ok(b.contrast(b.toRgb(p.dark.brand), DARK_SURFACE) >= b.MIN_CONTRAST - 0.05, `${hex}: link colour on the dark page (${p.dark.brand})`);
    assert.ok(b.contrast(b.toRgb(p.login.b), LOGIN_INK) >= 8.9, `${hex}: button text on the light end (${p.login.b})`);
    assert.ok(b.contrast(b.toRgb(p.login.a), LOGIN_INK) >= 4.9, `${hex}: button text on the other end (${p.login.a})`);
    assert.ok(b.contrast(b.toRgb(p.light.brand), WHITE) >= b.MIN_CONTRAST, `${hex}: white on the light theme colour`);
    assert.ok(b.luminance(b.toRgb(p.light.brandDark)) <= b.luminance(b.toRgb(accent)), `${hex}: the bar's dark partner is not lighter`);
    for (const v of [p.light.brandDark, p.dark.brand, p.dark.brandDark, p.login.a, p.login.b, p.login.titleEnd]) assert.match(v, /^#[0-9a-f]{6}$/, hex);
  }
  assert.ok(tried > 40, `checked ${tried} colours`);
});

test('the style text holds only what was worked out, and nothing for the built-in colour', () => {
  assert.strictEqual(b.cssFor(null), '');
  assert.strictEqual(b.cssFor(''), '');
  const css = b.cssFor('#0b6e4f');
  assert.ok(css.startsWith(':root{--brand:#0b6e4f;') && css.includes('[data-bs-theme="dark"]{--brand:'));
  for (const v of ['brand', 'brand-dark', 'brand-rgb', 'brand-dark-rgb', 'login-a', 'login-b', 'login-link', 'login-title-end', 'lg1', 'lg2', 'lg3']) assert.ok(css.includes(`--${v}:`), v);
  assert.match(css, /^[-a-z0-9:#,.;{}\[\]="\s()!>]+$/);
  assert.match(css, /--brand-rgb:11, 110, 79;/);
  for (const piece of ['--bs-primary:#0b6e4f', '--bs-btn-bg:#0b6e4f', '.btn-outline-primary{', '.pagination{', '.form-check-input:checked', '.form-control:focus']) assert.ok(css.includes(piece), `Bootstrap's primary follows the accent: ${piece}`);
  const dark = css.slice(css.indexOf('[data-bs-theme="dark"]'));
  assert.ok(/--bs-link-color:#[0-9a-f]{6}/.test(dark) && !dark.slice(0, dark.indexOf('}')).includes('--bs-primary:#0b6e4f'), 'links get the lightened shade in the dark theme');
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test('a logo is recognised from its first bytes, not its name', () => {
  assert.strictEqual(b.sniffImage(png), 'image/png');
  assert.strictEqual(b.sniffImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)])), 'image/jpeg');
  assert.strictEqual(b.sniffImage(Buffer.concat([Buffer.from('GIF87a'), Buffer.alloc(20)])), 'image/gif');
  assert.strictEqual(b.sniffImage(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)])), 'image/gif');
  assert.strictEqual(b.sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)])), 'image/webp');
  assert.strictEqual(b.sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(8)])), null, 'other RIFF files are not pictures');
  for (const no of [Buffer.alloc(0), Buffer.from('GIF'), Buffer.from('<html>'.repeat(5)), Buffer.from('%PDF-1.7 and some more'), null, 'text']) assert.strictEqual(b.sniffImage(no), null);
});

test('SVG, disguised files and oversized pictures are refused, each with a reason', () => {
  assert.throws(() => b.checkLogo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')), /An SVG logo is not accepted/);
  assert.throws(() => b.checkLogo(Buffer.from('  \n<?xml version="1.0"?><svg/>')), /An SVG logo is not accepted/);
  assert.throws(() => b.checkLogo(Buffer.from('<!doctype html><script>alert(1)</script> padding')), /PNG, JPEG, GIF or WebP/);
  assert.throws(() => b.checkLogo(Buffer.concat([png, Buffer.alloc(b.LIMITS.logoBytes)])), /limit is 512 KB/);
  assert.strictEqual(b.checkLogo(png).mime, 'image/png');
  assert.match(b.checkLogo(png).version, /^[0-9a-f]{12}$/);
  assert.notStrictEqual(b.checkLogo(png).version, b.checkLogo(Buffer.concat([png, Buffer.from('x')])).version, 'a different picture has a different version');
});

const form = (over = {}) => ({ product_name: 'Acme Desk', accent_color: '', login_welcome: '', login_tagline: '', email_footer: '', ...over });

test('the form is checked: text is tidied, limits are in characters, empty wording means the built-in wording', () => {
  const ok = b.validate(form({ product_name: '  Acme \n  Desk\t', login_welcome: ' Hi ', email_footer: 'a  b\r\n\r\n\r\n\r\nc  ' }), null);
  assert.strictEqual(ok.product_name, 'Acme Desk');
  assert.strictEqual(ok.login_welcome, 'Hi');
  assert.strictEqual(ok.login_tagline, null);
  assert.strictEqual(ok.email_footer, 'a b\n\nc', 'line breaks are kept, runs of blank lines are not');
  assert.strictEqual(ok.accent_color, null);
  assert.strictEqual(ok.logo, null);
  assert.strictEqual(ok.removeLogo, false);
  assert.throws(() => b.validate(form({ product_name: '' }), null), /cannot be empty/);
  assert.throws(() => b.validate(form({ product_name: '\u0000\u0007\n' }), null), /cannot be empty/, 'control characters are not a name');
  assert.throws(() => b.validate(form({ product_name: 'x'.repeat(41) }), null), /at most 40/);
  assert.strictEqual(b.validate(form({ product_name: '🚀'.repeat(40) }), null).product_name.length, 80, '40 emoji are 40 characters');
  assert.throws(() => b.validate(form({ product_name: '🚀'.repeat(41) }), null), /at most 40/);
  assert.throws(() => b.validate(form({ login_welcome: 'x'.repeat(61) }), null), /at most 60/);
  assert.throws(() => b.validate(form({ login_tagline: 'x'.repeat(121) }), null), /at most 120/);
  assert.throws(() => b.validate(form({ email_footer: 'x'.repeat(301) }), null), /at most 300/);
  assert.throws(() => b.validate(form({ accent_color: 'blue' }), null), /hexadecimal/);
  assert.strictEqual(b.validate(form({ remove_logo: 'on' }), null).removeLogo, true);
  const withLogo = b.validate(form(), { logo: png });
  assert.strictEqual(withLogo.logo.mime, 'image/png');
  assert.ok(withLogo.logo.buffer.equals(png));
  assert.throws(() => b.validate(form(), { logo: Buffer.from('nope, not a picture') }), b.BrandingError);
  assert.throws(() => b.validate(undefined, null), b.BrandingError, 'a missing form is a refusal, not a crash');
});

test('the built-in look is what an empty row gives, and the tab and bar keep their old wording', () => {
  const v = b.viewModel(null);
  assert.deepStrictEqual([v.name, v.titleName, v.isDefaultName, v.accent, v.css, v.logoUrl, v.iconUrl, v.welcome, v.tagline, v.footer],
    ['NovaDesk', 'NovaDesk ITSM', true, null, '', null, '/img/novadesk-icon.png', 'Welcome to', 'Sign in to your account', '']);
  const c = b.viewModel({ product_name: 'Acme', accent_color: '#0b6e4f', login_welcome: 'Hi', login_tagline: 'There', email_footer: 'Bye', logo_version: 'abc123abc123' });
  assert.deepStrictEqual([c.name, c.titleName, c.isDefaultName, c.accent, c.logoUrl, c.iconUrl, c.welcome, c.tagline, c.footer],
    ['Acme', 'Acme', false, '#0b6e4f', '/branding/logo?v=abc123abc123', '/branding/logo?v=abc123abc123', 'Hi', 'There', 'Bye']);
  assert.ok(c.css.includes('#0b6e4f'));
});

test('names are made safe for the places that are not web pages: the authenticator label and the sender name', () => {
  assert.strictEqual(b.plainName('Acme: "Desk" <IT>\\'), 'Acme Desk IT');
  assert.strictEqual(b.plainName('::'), 'NovaDesk', 'nothing left means the built-in name');
  assert.strictEqual(b.plainName('Café Ünï'), 'Café Ünï');
});

test('the sign-in background: three choices, a picture means "use it", "my own" needs one, SVG and oversize are refused', () => {
  assert.strictEqual(b.validate(form(), {}).login_background, 'builtin', 'the built-in picture unless told otherwise');
  assert.strictEqual(b.validate(form({ login_background: 'plain' }), {}).login_background, 'plain');
  assert.throws(() => b.validate(form({ login_background: 'neon' }), {}), /Choose what goes behind/);
  assert.throws(() => b.validate(form({ login_background: 'custom' }), {}), /Choose a picture to put behind/, 'my own picture, with none stored and none sent');
  assert.strictEqual(b.validate(form({ login_background: 'custom' }), {}, { hadBackground: true }).login_background, 'custom', 'a stored picture is enough');
  const up = b.validate(form({ login_background: 'plain' }), { background: png });
  assert.deepStrictEqual([up.login_background, up.background.mime, up.background.buffer.equals(png)], ['custom', 'image/png', true], 'sending a picture switches it on, whatever was ticked');
  assert.throws(() => b.validate(form(), { background: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') }), /An SVG background picture is not accepted/);
  assert.throws(() => b.validate(form(), { background: Buffer.from('plain text, not a picture') }), /background picture must be a PNG/);
  assert.throws(() => b.validate(form(), { background: Buffer.concat([png, Buffer.alloc(b.LIMITS.backgroundBytes)]) }), /limit is 2048 KB/);
  assert.doesNotThrow(() => b.validate(form(), { background: Buffer.concat([png, Buffer.alloc(b.LIMITS.backgroundBytes - png.length)]) }), 'exactly the limit is fine');
  assert.doesNotThrow(() => b.validate(form(), { logo: png, background: png }), 'both at once');
});

test('the sign-in page gets a class and, for a picture of its own, a style made only from hex digits', () => {
  const none = b.viewModel(null);
  assert.deepStrictEqual([none.loginBackground, none.loginClass, none.loginStyle, none.backgroundUrl], ['builtin', '', '', null]);
  const plain = b.viewModel({ login_background: 'plain' });
  assert.deepStrictEqual([plain.loginBackground, plain.loginClass, plain.loginStyle], ['plain', ' login-plain', '']);
  const custom = b.viewModel({ login_background: 'custom', background_version: 'abc123abc123' });
  assert.deepStrictEqual([custom.loginBackground, custom.loginClass, custom.loginStyle, custom.backgroundUrl],
    ['custom', ' login-custom-bg', ` style="background-image:url('/branding/background?v=abc123abc123')"`, '/branding/background?v=abc123abc123']);
  assert.strictEqual(b.viewModel({ login_background: 'custom' }).loginBackground, 'builtin', '"my own" with no picture stored falls back to the built-in one');
  assert.strictEqual(b.viewModel({ login_background: 'bogus' }).loginBackground, 'builtin');
});
