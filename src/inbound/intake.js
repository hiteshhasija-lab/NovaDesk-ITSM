// POST /api/inbound/email: a mail system hands over one message as it received it (the raw email, Content-Type message/rfc822),
// with the shared secret as a bearer token. For a mail provider's "forward to a web address" feature, or a mail server
// that pipes messages to a script:  curl -H "Authorization: Bearer $INBOUND_SECRET" -H "Content-Type: message/rfc822" --data-binary @message.eml  https://helpdesk.example.com/api/inbound/email
'use strict';
const crypto = require('crypto');
const express = require('express');
const { inboundConfig } = require('../settings');
const { parseMessage } = require('./parse');
const { processMessage, recordUnreadable } = require('./process');

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest(); const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function handler(env = process.env) {
  const cfg = inboundConfig(env);
  const raw = express.raw({ type: () => true, limit: cfg.maxMessageBytes });
  return [
    // Without a secret the address does not exist: nothing to probe.
    (req, res, next) => (cfg.secret ? next() : res.status(404).json({ error: 'Not found.' })),
    (req, res, next) => {
      const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
      if (!m || !safeEqual(m[1].trim(), cfg.secret)) return res.status(401).json({ error: 'Missing or wrong secret.' });
      next();
    },
    raw,
    async (req, res) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || !body.length) return res.status(400).json({ error: 'Send the raw email as the request body (Content-Type: message/rfc822).' });
      let parsed;
      try { parsed = await parseMessage(body); } catch (err) {
        await recordUnreadable({ messageId: `http:${crypto.createHash('sha256').update(body).digest('hex')}`, source: 'http', size: body.length, reason: `could not be read as an email: ${err.message}` }).catch(() => {});
        return res.status(400).json({ error: 'That is not a readable email.' });
      }
      try {
        const result = await processMessage(parsed, { source: 'http', env });
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
