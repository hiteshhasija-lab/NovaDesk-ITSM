'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const csp = require('../src/csp');

const directive = (policy, name) => (policy.split('; ').find((d) => d.startsWith(name + ' ')) || '').slice(name.length + 1);

test('csp: scripts only from this server, two named CDNs and the page nonce; no inline handlers, no eval', () => {
  const p = csp.policy('NONCE123');
  const scripts = directive(p, 'script-src');
  assert.ok(scripts.includes("'self'") && scripts.includes("'nonce-NONCE123'"));
  assert.ok(!scripts.includes('unsafe-inline') && !scripts.includes('unsafe-eval') && !scripts.includes('*'));
  assert.deepStrictEqual(scripts.split(' ').filter((s) => s.startsWith('https:')), ['https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com']);
  assert.strictEqual(directive(p, 'script-src-attr'), "'none'");
  assert.strictEqual(directive(p, 'object-src'), "'none'");
  assert.strictEqual(directive(p, 'base-uri'), "'self'");
  assert.strictEqual(directive(p, 'form-action'), "'self'");
  assert.strictEqual(directive(p, 'frame-ancestors'), "'self'");
  assert.strictEqual(directive(p, 'connect-src'), "'self'");
  assert.strictEqual(directive(p, 'default-src'), "'self'");
  assert.ok(directive(p, 'report-uri') === '/csp-report');
});

test('csp: every page gets its own nonce; the mode picks the header (or none)', () => {
  const run = (env) => { const res = { locals: {}, headers: {}, set(k, v) { this.headers[k] = v; } }; csp.middleware(env)({}, res, () => {}); return res; };
  const a = run({}), b = run({});
  assert.ok(a.locals.cspNonce && a.locals.cspNonce !== b.locals.cspNonce);
  assert.ok(Buffer.from(a.locals.cspNonce, 'base64').length >= 16, 'at least 128 bits');
  assert.ok(a.headers['Content-Security-Policy'].includes(`'nonce-${a.locals.cspNonce}'`));
  assert.ok(run({ CSP_MODE: 'report' }).headers['Content-Security-Policy-Report-Only'] && !run({ CSP_MODE: 'report' }).headers['Content-Security-Policy']);
  assert.deepStrictEqual(run({ CSP_MODE: 'off' }).headers, {});
  assert.throws(() => csp.mode({ CSP_MODE: 'sometimes' }), /enforce, report or off/);
});

test('csp: what a browser reports is shortened and cleaned before it is logged', () => {
  const line = csp.describe({ 'csp-report': { 'violated-directive': "script-src-elem\nFAKE LOG LINE", 'blocked-uri': 'inline', 'document-uri': 'http://x/incidents', 'source-file': 'http://x/a.js', 'line-number': 12 } });
  assert.ok(!/\n/.test(line) && /blocked inline on http:\/\/x\/incidents \(http:\/\/x\/a\.js:12\)/.test(line));
  assert.ok(csp.describe({ 'csp-report': { 'blocked-uri': 'x'.repeat(5000) } }).length < 600);
  assert.doesNotThrow(() => csp.describe(null));
  assert.doesNotThrow(() => csp.describe('text'));
});

// The pages themselves: the guard that keeps the policy workable. A new inline handler, a script without the nonce or a
// javascript: link would be blocked by the browser (and the feature behind it silently stop working).
const viewFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? viewFiles(path.join(dir, e.name)) : e.name.endsWith('.ejs') ? [path.join(dir, e.name)] : []));
const VIEWS = path.join(__dirname, '..', 'views');

test('csp: no view has an inline event handler or a javascript: link', () => {
  for (const file of viewFiles(VIEWS)) {
    const text = fs.readFileSync(file, 'utf8');
    const handler = text.match(/<[a-z][^>]*\s(on[a-z]+)\s*=/i);
    assert.ok(!handler, `${path.relative(VIEWS, file)} has an inline ${handler && handler[1]} handler: use a data attribute (see public/js/app.js)`);
    assert.ok(!/(href|src|action)\s*=\s*["']\s*javascript:/i.test(text), `${path.relative(VIEWS, file)} has a javascript: link`);
  }
});

test('csp: every inline <script> carries the page nonce, and none builds one from page data', () => {
  let inline = 0;
  for (const file of viewFiles(VIEWS)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/<script\b((?:<%[\s\S]*?%>|[^>])*)>/g)) {
      if (/\bsrc\s*=/.test(m[1])) continue;
      inline++;
      assert.ok(/\bnonce="<%= cspNonce %>"/.test(m[1]), `${path.relative(VIEWS, file)} has an inline <script> without nonce="<%= cspNonce %>"`);
    }
  }
  assert.ok(inline >= 15, `found the page scripts (${inline})`);
});

test('csp: the two behaviours the handlers used to give are in the shared script', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.ok(/data-confirm/.test(app) && /data-href/.test(app) && /data-no-row/.test(app) && /__dragging/.test(app));
  const foot = fs.readFileSync(path.join(VIEWS, 'partials', 'foot.ejs'), 'utf8');
  assert.ok(/src="\/js\/app\.js"/.test(foot));
});
