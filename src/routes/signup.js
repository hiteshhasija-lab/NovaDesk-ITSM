// The sign-up page for new workspaces (src/signup.js). Answers only on SIGNUP_HOST, and exists only when that is set.
//   GET  /              the form
//   POST /signup        asks for a workspace: checks everything, sends the link by email, says "check your email" whatever the answer to "is this address known"
//   GET  /verify/:token shows what would be made (opening a link never makes anything: a mail scanner may open it)
//   POST /verify/:token makes it
// Every refusal is a sentence for the person; a flood of requests, a paused service, a bad address or a program (hidden field, too quick) never reaches the mail server.
'use strict';
const express = require('express');
const signup = require('../signup');
const mailer = require('../mailer');
const platform = require('../platform');
const tenants = require('../tenants');
const { createWindowCounter } = require('../rateLimit');
const { escapeHtml } = require('../helpers');

function mount(env = process.env) {
  const cfg = signup.config(env);
  if (!cfg.enabled) return (req, res, next) => next();
  const router = express.Router();
  const perIp = createWindowCounter({ windowMs: 60 * 60 * 1000, max: cfg.perIpPerHour });
  const confirmPerIp = createWindowCounter({ windowMs: 60 * 60 * 1000, max: 20 });
  const page = (res, view, data = {}, status = 200) => { res.set('Cache-Control', 'no-store'); return res.status(status).render(`signup/${view}`, { title: 'Create your workspace', error: null, form: {}, terms: cfg.terms, base: cfg.base, back: false, ...data }); };
  const message = (res, title, text, status = 200, back = false) => page(res, 'message', { title, message: text, back }, status);
  const formPage = (res, data = {}, status = 200) => page(res, 'form', { formToken: signup.formToken(env), ...data }, status);

  router.use(express.urlencoded({ extended: false, limit: '20kb' }));
  router.get('/', async (req, res, next) => {
    try { if (await signup.paused()) return message(res, 'Sign-ups are closed', 'New workspaces cannot be created at the moment. Please try again later.', 503); formPage(res); } catch (e) { next(e); }
  });

  router.post('/signup', async (req, res, next) => {
    try {
      const b = req.body || {};
      // Things only a program does: fill the hidden field, or post at once. Answered like a success, so there is nothing to learn from.
      if (b.website) return page(res, 'sent', { hours: cfg.linkHours });
      const timing = signup.checkFormToken(env, b.t);
      if (timing) return formPage(res, { error: timing, form: b }, 400);
      if (await signup.paused()) return message(res, 'Sign-ups are closed', 'New workspaces cannot be created at the moment. Please try again later.', 503);
      if (!perIp.hit(req.ip).allowed) return message(res, 'Too many requests', 'Too many requests from your address. Please try again in an hour.', 429);
      if (cfg.maxPerDay && (await signup.lastDay()) >= cfg.maxPerDay) return message(res, 'Sign-ups are busy', 'We have had many requests today. Please try again tomorrow.', 503);
      const checked = signup.checkRequest(cfg, b);
      if (checked.error) return formPage(res, { error: checked.error, form: b }, 400);
      const v = checked.value;
      // The short name is told to be taken (the person has to choose another); whether an email address is known is not told.
      if (await tenants.slugTaken(v.slug)) return formPage(res, { error: `The short name "${v.slug}" is already taken. Choose another.`, form: b }, 400);
      // One address gets at most 3 links an hour (nobody's inbox is for filling); the page says the same as for a sent one.
      if ((await signup.forEmail(v.email)) >= 3) return page(res, 'sent', { hours: cfg.linkHours });
      const token = await signup.createPending(cfg, v, req.ip);
      const link = `${cfg.scheme}://${cfg.host}/verify/${token}`;
      const sent = await mailer.sendSystem({
        to: v.email, subject: 'Confirm your email address to create your workspace',
        html: `<p>Hi ${escapeHtml(v.adminName)},</p><p>Someone (we hope you) asked for the workspace <strong>${escapeHtml(v.orgName)}</strong> at <strong>${escapeHtml(v.slug)}.${escapeHtml(cfg.base)}</strong> using this address. To go on, open this link and press the button on the page:</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p><p>The link is good for ${cfg.linkHours} hours and works once. If it was not you, ignore this message: nothing is made without it.</p>`,
      });
      if (!sent || sent.status === 'failed' || sent.status === 'not_configured') {
        console.error(`[Signup] the confirmation link could not be sent: ${sent && sent.error}`);
        return message(res, 'We could not send the email', 'The email with your link could not be sent. Please try again in a little while.', 502, true);
      }
      page(res, 'sent', { hours: cfg.linkHours });
    } catch (e) { next(e); }
  });

  router.get('/verify/:token', async (req, res, next) => {
    try {
      const p = await signup.pendingFor(req.params.token);
      if (!p) return message(res, 'This link cannot be used', 'This link has already been used, or it has expired, or it is not right. If you already confirmed, your workspace is ready at its address. Otherwise start again.', 404, true);
      page(res, 'confirm', { req: p, token: req.params.token, address: signup.urlFor(cfg, p.slug), approval: cfg.approval, formToken: signup.formToken(env) });
    } catch (e) { next(e); }
  });

  router.post('/verify/:token', async (req, res, next) => {
    try {
      if (!confirmPerIp.hit(req.ip).allowed) return message(res, 'Too many requests', 'Too many requests from your address. Please try again later.', 429);
      const timing = signup.checkFormToken(env, (req.body || {}).t);
      if (timing && !/very quick/.test(timing)) return message(res, 'Open the link again', timing, 400, false);
      try {
        const r = await signup.complete(cfg, req.params.token, { req, mailer });
        page(res, 'done', { name: r.tenant.name, url: r.url, username: r.username, suspended: r.suspended });
      } catch (err) {
        if (err instanceof signup.SignupError) return message(res, 'Your workspace was not made', err.message, 400, true);
        throw err;
      }
    } catch (e) { next(e); }
  });

  router.use((req, res) => message(res, 'Not found', 'There is no such page.', 404, true));

  return (req, res, next) => (tenants.hostOf(req) === cfg.host ? router(req, res, next) : next());
}

module.exports = { mount };
