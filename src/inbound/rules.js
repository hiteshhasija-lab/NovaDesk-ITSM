// The judgement calls in reading incoming mail, kept apart from the database and the mail libraries so each one can be
// tried on its own: is this a person writing or a machine, did the receiving server vouch for the sender, which ticket
// is a reply about, and which part of a reply is new.
'use strict';

// headers: a Map of lower-case header name to string (what mailparser gives), or a plain object.
const header = (headers, name) => {
  const v = headers instanceof Map ? headers.get(name) : headers && headers[name];
  const first = Array.isArray(v) ? v[0] : v;
  if (first == null) return '';
  // mailparser turns some headers (List-Id, List-Unsubscribe, Content-Type, addresses) into objects: use their text, or
  // failing that a plain rendering, so that "the header is there" is never read as "the header is empty".
  if (typeof first === 'object') return String(first.text || first.value || (Object.keys(first).length ? JSON.stringify(first) : ''));
  return String(first);
};

// A reason when the message was written by a machine (an out-of-office, a bounce, a newsletter, another help desk's
// acknowledgement), else null. Answering those would start a loop between two systems.
function automatedReason(headers, { from = '', subject = '' } = {}) {
  const h = (n) => header(headers, n).trim();
  const auto = h('auto-submitted').toLowerCase();
  if (auto && auto !== 'no') return `automatic message (Auto-Submitted: ${auto.slice(0, 30)})`;
  if (/^(bulk|junk|list|auto_reply)$/i.test(h('precedence'))) return `bulk mail (Precedence: ${h('precedence').toLowerCase()})`;
  if (h('x-autoreply') || h('x-autorespond')) return 'automatic reply';
  if (/\b(oof|autoreply|dr|rn|nrn)\b/i.test(h('x-auto-response-suppress'))) return 'automatic reply (X-Auto-Response-Suppress)';
  if (h('list-id') || h('list-unsubscribe') || h('list')) return 'mailing list or newsletter';   // mailparser files the List-* headers under 'list'
  if (h('x-failed-recipients')) return 'delivery failure notice';
  if (/multipart\/report/i.test(h('content-type')) || /delivery-status/i.test(h('content-type'))) return 'delivery failure notice';
  const returnPath = h('return-path').replace(/\s/g, '');
  if (returnPath === '<>') return 'bounce (empty return path)';
  if (/^(mailer-daemon|postmaster)@/i.test(from)) return 'delivery failure notice';
  if (/^(automatic reply|auto[- ]?reply|auto:|out of office|undeliverable|delivery status notification|returned mail)/i.test(String(subject).trim())) return 'automatic reply (by its subject)';
  return null;
}

// What the receiving mail server wrote in Authentication-Results about the sender. 'fail' means it checked and the
// sender is not who the message says; 'pass' that at least one check passed; 'unknown' that it said nothing.
function authVerdict(headers) {
  const raw = header(headers, 'authentication-results');
  if (!raw) return { verdict: 'unknown', spf: null, dkim: null, dmarc: null };
  const pick = (name) => { const m = new RegExp(`(?:^|[\\s;])${name}\\s*=\\s*([a-z]+)`, 'i').exec(raw); return m ? m[1].toLowerCase() : null; };
  const spf = pick('spf'), dkim = pick('dkim'), dmarc = pick('dmarc');
  // DMARC is the verdict when the server ran it (forwarded mail often fails DKIM yet passes DMARC); otherwise any failure counts.
  if (dmarc === 'pass' || dmarc === 'fail') return { verdict: dmarc, spf, dkim, dmarc };
  if ([spf, dkim].includes('fail')) return { verdict: 'fail', spf, dkim, dmarc };
  if ([spf, dkim, dmarc].includes('pass')) return { verdict: 'pass', spf, dkim, dmarc };
  return { verdict: 'unknown', spf, dkim, dmarc };
}

// "Re: RE: Fwd: Printer down" -> "Printer down"; no control characters, one line, at most 200.
function cleanSubject(subject) {
  let s = String(subject || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 10; i++) {
    const next = s.replace(/^\s*(re|fw|fwd|aw|sv|vs|antw|wg|tr|rv)\s*(\[\d+\])?\s*:\s*/i, '');
    if (next === s) break;
    s = next;
  }
  return (s || '(no subject)').slice(0, 200);
}

// Incident numbers a message is about, from its subject: "[INC0000012] New comment" -> ['INC0000012'].
function incidentRefs(subject) {
  const found = new Set();
  for (const m of String(subject || '').matchAll(/\bINC\d{7}\b/g)) found.add(m[0]);
  return [...found];
}

// Message ids from In-Reply-To / References, without the angle brackets.
function messageIds(...values) {
  const ids = [];
  for (const v of values) for (const m of String(Array.isArray(v) ? v.join(' ') : v || '').matchAll(/<([^<>\s]+)>/g)) ids.push(m[1]);
  return [...new Set(ids)];
}

// The new part of a reply: everything above "On Monday, Pat wrote:", "-----Original Message-----", an Outlook
// header block or a run of "> quoted" lines. Never returns nothing: a message that is all quote is kept whole.
function stripQuoted(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const marker = (i) => {
    const l = lines[i];
    if (/^\s*-{2,}\s*(original message|forwarded message|reply message)\s*-{2,}\s*$/i.test(l)) return true;
    if (/^\s*_{10,}\s*$/.test(l) && /^\s*from:/i.test(lines[i + 1] || '')) return true;
    if (/^\s*on .{5,200}wrote:\s*$/i.test(l)) return true;
    if (/^\s*on .{5,200}$/i.test(l) && /wrote:\s*$/i.test(lines[i + 1] || '')) return true;       // wrapped onto two lines
    if (/^\s*(from|von|de):\s.+/i.test(l) && /^\s*(sent|gesendet|envoy[eé]|date):\s/i.test(lines[i + 1] || '')) return true;
    if (/^\s*>/.test(l) && lines.slice(i).every((x) => /^\s*(>.*)?$/.test(x))) return true;       // only quote from here on
    return false;
  };
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) if (marker(i)) { cut = i; break; }
  const kept = lines.slice(0, cut).join('\n').trim();
  return kept || String(text || '').trim();
}

// Plain text safe to store: no control characters except newline and tab, bounded.
function cleanBody(text, max = 20000) {
  const s = String(text || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\n{4,}/g, '\n\n\n').trim();
  return s.length > max ? `${s.slice(0, max)}\n\n[The message was shortened: it was ${s.length} characters long.]` : s;
}

const normalizeAddress = (a) => String(a || '').trim().toLowerCase();
const domainOf = (a) => normalizeAddress(a).split('@')[1] || '';

// Is the address on the block list (an address, or a whole domain written as "@example.com" or "example.com")?
function blocked(address, list) {
  const a = normalizeAddress(address), d = domainOf(a);
  return (list || []).some((entry) => entry === a || entry === d || entry === `@${d}`);
}
function domainAllowed(address, list) {
  if (!list || !list.length) return true;
  const d = domainOf(address);
  return list.some((entry) => entry === d || entry === `@${d}`);
}

// A name for a new contact: the sender's display name, else the part of the address before the @, tidied.
function contactName(displayName, address) {
  const name = String(displayName || '').replace(/[\u0000-\u001f\u007f<>"]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (name && !name.includes('@')) return name.slice(0, 100);
  const local = normalizeAddress(address).split('@')[0].replace(/[._+-]+/g, ' ').trim();
  return (local.replace(/\b[a-z]/g, (c) => c.toUpperCase()) || 'Email contact').slice(0, 100);
}
// A user name for a new contact: from the address, lower case, and the caller adds a number when it is taken.
const contactUsername = (address) => `mail.${normalizeAddress(address).replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '')}`.slice(0, 60);

module.exports = { automatedReason, authVerdict, cleanSubject, incidentRefs, messageIds, stripQuoted, cleanBody, blocked, domainAllowed, contactName, contactUsername, normalizeAddress, domainOf, header };
