// Protection against forged requests: a page on another site making your browser submit a NovaDesk form.
// Every signed-in session has a random token. NovaDesk writes it into each form it shows (a hidden field) and
// into a <meta> tag that public/js/csrf.js sends as a header with fetch calls, and refuses any POST, PUT, PATCH or
// DELETE that does not carry it. This sits on top of the SameSite cookie setting, which stays.
//
// Not covered here, because they do not use the browser session: /api/ (API keys and the integration key).
// Uploads (multipart) are checked by the upload route itself, after the file has been read, with checkRequest().
'use strict';
const crypto = require('crypto');

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const newToken = () => crypto.randomBytes(24).toString('base64url');

function tokenFor(req) {
  if (!req.session) return '';
  if (!req.session.csrf) req.session.csrf = newToken();
  return req.session.csrf;
}

const sameToken = (a, b) => {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};
// The token travels in the form body or a header, never in the address (addresses end up in logs and referrers).
const presented = (req) => (req.body && req.body._csrf) || req.get('x-csrf-token') || '';

// true when the request carries this session's token
function checkRequest(req) {
  return sameToken(presented(req), req.session && req.session.csrf);
}

// A script (it sent a JSON body, or the token header, or asks for JSON only) gets JSON back; a browser gets a page.
const wantsJson = (req) => req.get('x-csrf-token') !== undefined || /json/.test(req.get('content-type') || '') || (/json/.test(req.get('accept') || '') && !/html/.test(req.get('accept') || ''));
function refuse(req, res) {
  console.warn(`[CSRF] refused ${req.method} ${req.path} from ${req.ip}`);
  if (wantsJson(req)) return res.status(403).json({ error: 'Your session has changed since this page was loaded. Reload the page and try again.' });
  return res.status(403).render('error', { title: 'Please reload the page', message: 'This form was opened in an earlier session, or came from somewhere other than NovaDesk, so it was not submitted. Reload the page and try again.' });
}

function middleware(req, res, next) {
  if (SAFE.has(req.method) || req.path.startsWith('/api/')) return next();
  if (/^multipart\/form-data/i.test(req.get('content-type') || '')) return next();   // the upload route checks after reading the body
  if (checkRequest(req)) return next();
  return refuse(req, res);
}

// ---- inserting the token into the pages
const FORM_OPEN = /<form\b[^>]*\bmethod\s*=\s*["']?post["']?[^>]*>/gi;
const HAS_POST_FORM = /<form\b[^>]*\bmethod\s*=\s*["']?post["']?/i;
const EXTERNAL_ACTION = /\baction\s*=\s*["']?(https?:)?\/\//i;
function inject(html, token) {
  if (typeof html !== 'string') return html;
  let out = html.replace(FORM_OPEN, (tag) => (EXTERNAL_ACTION.test(tag) ? tag : `${tag}<input type="hidden" name="_csrf" value="${token}">`));
  if (out.includes('</head>')) out = out.replace('</head>', `<meta name="csrf-token" content="${token}"><script src="/js/csrf.js"></script></head>`);
  return out;
}

// Wraps res.render so every page that goes out carries the token.
function renderWithToken(req, res, next) {
  const render = res.render.bind(res);
  res.render = function (view, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? undefined : options;
    if (cb) return render(view, opts, cb);
    return render(view, opts, (err, html) => {
      if (err) return req.next(err);
      // A token (and with it a session) is only made when the page has a form to protect or is for a signed-in person,
      // so a visitor who just meets a 404 does not cost a session.
      const needed = HAS_POST_FORM.test(html) || Boolean(req.session && req.session.user);
      res.send(needed ? inject(html, tokenFor(req)) : html);
    });
  };
  next();
}

module.exports = { middleware, renderWithToken, checkRequest, refuse, tokenFor, inject, newToken };
