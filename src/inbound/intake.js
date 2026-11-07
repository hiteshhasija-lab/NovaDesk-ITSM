// POST /api/inbound/email: a mail system hands over one message as it received it (the raw email, Content-Type message/rfc822),
// with the shared secret as a bearer token. For a mail provider's "forward to a web address" feature, or a mail server
// that pipes messages to a script:  curl -H "Authorization: Bearer $INBOUND_SECRET" -H "Content-Type: message/rfc822" --data-binary @message.eml  https://helpdesk.example.com/api/inbound/email
'use strict';
const crypto = require('crypto');
const express = require('express');
const { inboundConfig } = require('../settings');
const { parseMessage } = require('./parse');
const { processMessage, recordUnreadable } = require('./process');
const tenancy = require('../tenancy');
const tenants = require('../tenants');
const inboundSettings = require('../inboundSettings');

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest(); const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function handler(env = process.env) {
  const cfg = inboundConfig(env);
  const raw = express.raw({ type: () => true, limit: cfg.maxMessageBytes });
  return [
    // Who is handing the message over: the installation's own secret (the default tenant's), or a tenant's own token (which says which tenant).
    // With neither anywhere the address does not exist: nothing to probe.
    async (req, res, next) => {
      try {
        if (!cfg.secret && !(await inboundSettings.anyTenantToken())) return res.status(404).json({ error: 'Not found.' });
        const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
        const token = m ? m[1].trim() : '';
        let target = null;
        if (token && cfg.secret && safeEqual(token, cfg.secret)) target = { tenantId: 1, own: false };
        else if (token) { const tid = await inboundSettings.tenantOfToken(token); if (tid && (await tenants.isActive(tid))) target = { tenantId: tid, own: true }; }
        if (!target) return res.status(401).json({ error: 'Missing or wrong secret.' });
        req.intake = target;
        next();
      } catch (err) { next(err); }
    },
    raw,
    // What arrives belongs to the tenant whose secret or token was shown (the body parser above would have lost the tenant, so it is entered here).
    (req, res, next) => tenancy.run(req.intake.tenantId, next),
    async (req, res) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || !body.length) return res.status(400).json({ error: 'Send the raw email as the request body (Content-Type: message/rfc822).' });
      // The rules are the tenant's own when it has settings; the default tenant with the installation's secret uses the installation's.
      let ruleEnv = env;
      if (req.intake.own) { const s = await inboundSettings.forTenant(); if (!s) return res.status(404).json({ error: 'Not found.' }); ruleEnv = s.env; }
      let parsed;
      try { parsed = await parseMessage(body); } catch (err) {
        await recordUnreadable({ messageId: `http:${crypto.createHash('sha256').update(body).digest('hex')}`, source: 'http', size: body.length, reason: `could not be read as an email: ${err.message}` }).catch(() => {});
        return res.status(400).json({ error: 'That is not a readable email.' });
      }
      try {
        const result = await processMessage(parsed, { source: 'http', env: ruleEnv });
        // 202: taken in. What was done (ticket, comment, ignored, rejected) is in the body, so a caller can log it.
        res.status(202).json({ outcome: result.outcome, reason: result.reason || null, incident_id: result.recordId || null });
      } catch (err) {
        console.error(`[Inbound] could not handle a message handed over by HTTP: ${err.message}`);
        res.status(503).json({ error: 'Could not be handled right now; send it again.' });   // a mail system retries on 5xx
      }
    },
  ];
}

module.exports = { handler };
