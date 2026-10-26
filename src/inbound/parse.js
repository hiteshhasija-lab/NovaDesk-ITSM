// Raw email in, a plain object out. mailparser does the MIME work (nested parts, character sets, encodings); nothing
// from the message is ever kept as HTML: only its text, its headers and its files.
'use strict';
const crypto = require('crypto');
const { simpleParser } = require('mailparser');
const rules = require('./rules');
const { htmlToText } = require('../mailTransport');

// mailparser leaves text empty for some HTML-only messages (an HTML body next to an attachment): make it from the HTML,
// without scripts, styles or comments, and never keep the HTML itself.
const textFromHtml = (html) => htmlToText(String(html || '').replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, ''));

async function parseMessage(raw) {
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const mail = await simpleParser(buffer, { skipImageLinks: true, skipTextToHtml: true, skipHtmlToText: false });
  const sender = (mail.from && mail.from.value && mail.from.value[0]) || {};
  const idHeader = String(mail.messageId || '').replace(/^<|>$/g, '').trim();
  return {
    // A message with no Message-ID is identified by what it contains, so reading it twice still counts once.
    messageId: (idHeader || `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`).slice(0, 300),
    inReplyTo: rules.messageIds(mail.inReplyTo, mail.references),
    fromAddress: rules.normalizeAddress(sender.address),
    fromName: sender.name || '',
    subject: mail.subject || '',
    // An image in an HTML message comes out of the conversion as a line holding only its address, "[http://...]": dropped.
    text: (mail.text || (mail.html ? textFromHtml(mail.html) : '')).replace(/^[ \t]*\[(?:https?:)?\/\/[^\]\s]+\][ \t]*$/gm, '').replace(/\n{3,}/g, '\n\n').trim(),
    headers: mail.headers,
    date: mail.date || null,
    size: buffer.length,
    attachments: (mail.attachments || []).map((a) => ({
      filename: a.filename || '',
      contentType: a.contentType || 'application/octet-stream',
      size: a.size != null ? a.size : (a.content ? a.content.length : 0),
      content: a.content,
      inline: a.contentDisposition === 'inline' || Boolean(a.related),
    })),
  };
}

module.exports = { parseMessage };
