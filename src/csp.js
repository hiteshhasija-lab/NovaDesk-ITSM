// Content-Security-Policy: the browser runs only the scripts NovaDesk itself sends.
//
// Every page gets a fresh random nonce; the policy allows an inline <script> only if it carries that nonce, and
// allows external scripts only from this server and the two libraries' CDNs. Inline event handlers (onclick=...)
// and javascript: links are not allowed at all, so text that reaches a page by mistake (a ticket description
// with <script>, an <img onerror=...>) cannot run, however it got there. Styles may be inline (the pages use
// style="..." widely); images only from here and data:; connections only back to this server.
//
//   CSP_MODE=enforce   (default) block and report
//   CSP_MODE=report    only report: for trying a change without breaking pages
//   CSP_MODE=off       no header (an escape hatch, not a setting to keep)
// Violations are posted by the browser to /csp-report and written to the server log as "[CSP] ...".
'use strict';
const crypto = require('crypto');

const SCRIPT_HOSTS = ['https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com'];   // Bootstrap; Chart.js, Sortable
const STYLE_HOSTS = ['https://cdn.jsdelivr.net'];                                     // Bootstrap, Bootstrap Icons
const FONT_HOSTS = ['https://cdn.jsdelivr.net'];                                      // Bootstrap Icons' font

function mode(env = process.env) {
  const m = String(env.CSP_MODE || 'enforce').trim().toLowerCase();
  if (!['enforce', 'report', 'off'].includes(m)) throw new Error('CSP_MODE must be enforce, report or off.');
  return m;
}

function policy(nonce) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' ${SCRIPT_HOSTS.join(' ')}`,
    "script-src-attr 'none'",
    `style-src 'self' 'unsafe-inline' ${STYLE_HOSTS.join(' ')}`,
    `font-src 'self' data: ${FONT_HOSTS.join(' ')}`,
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    'report-uri /csp-report',
  ].join('; ');
}

function middleware(env = process.env) {
  const m = mode(env);
  return (req, res, next) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.locals.cspNonce = nonce;                   // pages write <script nonce="<%= cspNonce %>">
    if (m !== 'off') res.set(m === 'report' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy', policy(nonce));
    next();
  };
}

// What the browser says it blocked, cleaned up for a log line (anyone can post here, so nothing is trusted).
const clean = (v, max = 200) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, max);
function describe(body) {
  const r = (body && (body['csp-report'] || body)) || {};
  return `${clean(r['violated-directive'] || r.effectiveDirective)} blocked ${clean(r['blocked-uri'] || r.blockedURL)} on ${clean(r['document-uri'] || r.documentURL)}${r['source-file'] || r.sourceFile ? ` (${clean(r['source-file'] || r.sourceFile)}:${clean(r['line-number'] || r.lineNumber, 8)})` : ''}`;
}
let reported = 0; let windowStart = Date.now();
function reportHandler(req, res) {
  // A flood of reports (a broken page open in many tabs) writes at most 30 lines a minute.
  if (Date.now() - windowStart > 60000) { windowStart = Date.now(); reported = 0; }
  if (reported++ < 30) console.warn(`[CSP] ${describe(req.body)}`);
  res.status(204).end();
}

module.exports = { middleware, policy, mode, reportHandler, describe };
