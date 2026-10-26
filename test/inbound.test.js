'use strict';
const test = require('node:test');
const assert = require('node:assert');
const rules = require('../src/inbound/rules');
const { parseMessage } = require('../src/inbound/parse');
const { inboundConfig } = require('../src/settings');

const hdr = (o) => new Map(Object.entries(o));

test('inbound rules: machines are recognised, people are not', () => {
  for (const [headers, subject, expect] of [
    [{ 'auto-submitted': 'auto-replied' }, 'x', /automatic message/],
    [{ 'auto-submitted': 'auto-generated' }, 'x', /automatic message/],
    [{ precedence: 'bulk' }, 'x', /bulk/], [{ precedence: 'junk' }, 'x', /bulk/], [{ precedence: 'auto_reply' }, 'x', /bulk/],
    [{ 'x-autoreply': 'yes' }, 'x', /automatic reply/], [{ 'x-auto-response-suppress': 'OOF, AutoReply' }, 'x', /automatic reply/],
    [{ list: { id: { id: 'news.example.test' } } }, 'x', /mailing list/], [{ 'list-id': '<a.example>' }, 'x', /mailing list/], [{ 'list-unsubscribe': '<mailto:x@y>' }, 'x', /mailing list/],
    [{ 'x-failed-recipients': 'a@b' }, 'x', /delivery failure/], [{ 'return-path': '<>' }, 'x', /bounce/],
    [{ 'content-type': { value: 'multipart/report', params: { 'report-type': 'delivery-status' } } }, 'x', /delivery failure/],
    [{}, 'Automatic reply: I am away', /subject/], [{}, 'Out of Office until Monday', /subject/], [{}, 'Undeliverable: your message', /subject/], [{}, 'Delivery Status Notification (Failure)', /subject/],
  ]) assert.match(rules.automatedReason(hdr(headers), { from: 'pat@corp.test', subject }) || '', expect, JSON.stringify([headers, subject]));
  assert.match(rules.automatedReason(hdr({}), { from: 'MAILER-DAEMON@mx.test', subject: 'x' }), /delivery failure/);
  assert.match(rules.automatedReason(hdr({}), { from: 'postmaster@mx.test', subject: 'x' }), /delivery failure/);
  for (const [headers, subject] of [[{}, 'Printer is broken'], [{ 'auto-submitted': 'no' }, 'Re: hello'], [{ precedence: 'first-class' }, 'Out of order printer'], [{ 'x-auto-response-suppress': '' }, 'A normal subject']]) {
    assert.strictEqual(rules.automatedReason(hdr(headers), { from: 'pat@corp.test', subject }), null, JSON.stringify([headers, subject]));
  }
});

test('inbound rules: what the receiving server says about the sender', () => {
  const v = (text) => rules.authVerdict(hdr(text === undefined ? {} : { 'authentication-results': text })).verdict;
  assert.strictEqual(v(undefined), 'unknown');
  assert.strictEqual(v('mx.example.test; none'), 'unknown');
  assert.strictEqual(v('mx.example.test; spf=pass smtp.mailfrom=a@b'), 'pass');
  assert.strictEqual(v('mx.example.test; dkim=pass header.d=b'), 'pass');
  assert.strictEqual(v('mx.example.test; spf=fail; dkim=none'), 'fail');
  assert.strictEqual(v('mx.example.test; dmarc=fail (p=reject)'), 'fail');
  assert.strictEqual(v('mx.example.test; spf=fail; dmarc=pass'), 'pass', 'DMARC decides when the server ran it');
  assert.strictEqual(v('mx.example.test; spf=pass; dkim=fail; dmarc=pass'), 'pass', 'a forwarded message');
  assert.strictEqual(v('mx.example.test; spf=softfail'), 'unknown');
  assert.strictEqual(v('mx; xspf=fail'), 'unknown', 'a word that only ends in spf is not spf');
});

test('inbound rules: subjects, ticket numbers, message ids', () => {
  assert.strictEqual(rules.cleanSubject('Re: RE: Fwd: AW: Printer   down'), 'Printer down');
  assert.strictEqual(rules.cleanSubject('Re[2]: hello'), 'hello');
  assert.strictEqual(rules.cleanSubject('Return of the printer'), 'Return of the printer', 'only real reply prefixes go');
  assert.strictEqual(rules.cleanSubject(''), '(no subject)');
  assert.strictEqual(rules.cleanSubject('Re:'), '(no subject)');
  assert.strictEqual(rules.cleanSubject('line\r\nBcc: x@y'), 'line Bcc: x@y', 'one line, no control characters');
  assert.strictEqual(rules.cleanSubject('x'.repeat(500)).length, 200);
  assert.deepStrictEqual(rules.incidentRefs('Re: [INC0000012] New comment (INC0000013)'), ['INC0000012', 'INC0000013']);
  assert.deepStrictEqual(rules.incidentRefs('INC12 or XINC0000012 or INC00000123'), [], 'exactly INC and seven digits, as a word');
  assert.deepStrictEqual(rules.messageIds('<a@x> <b@y>', ['<c@z>', '<a@x>']), ['a@x', 'b@y', 'c@z']);
  assert.deepStrictEqual(rules.messageIds(undefined, ''), []);
});

test('inbound rules: only the new part of a reply is kept', () => {
  const s = rules.stripQuoted;
  assert.strictEqual(s('Thanks, fixed.\n\nOn Mon, Oct 26, 2026 at 9:00 AM Help Desk <help@desk.test> wrote:\n> hi\n> there'), 'Thanks, fixed.');
  assert.strictEqual(s('Yes.\n\nOn Mon, Oct 26, 2026 at 9:00 AM, Someone With A Long Name\n<help@desk.test> wrote:\n> hi'), 'Yes.', 'the "wrote:" wrapped onto the next line');
  assert.strictEqual(s('Done.\n\n-----Original Message-----\nFrom: x\nSent: y\n\nold text'), 'Done.');
  assert.strictEqual(s('Done.\n\n________________________________\nFrom: Help <h@d>\nSent: Monday\nSubject: x\n\nold'), 'Done.');
  assert.strictEqual(s('Done.\n\nFrom: Help Desk <h@d.test>\nSent: Monday, 26 October 2026\nTo: me\n\nold'), 'Done.');
  assert.strictEqual(s('Done.\n\nVon: Help <h@d>\nGesendet: Montag\n\nalt'), 'Done.');
  assert.strictEqual(s('First para.\n\n> quoted\n> more quoted\n'), 'First para.');
  assert.strictEqual(s('See below.\n> inline quote\nMy answer in between.\n> another'), 'See below.\n> inline quote\nMy answer in between.', 'a quote followed by new text is not cut');
  assert.strictEqual(s('> only a quote\n> nothing new'), '> only a quote\n> nothing new', 'never returns nothing');
  assert.strictEqual(s('Line one\r\nLine two\r\n'), 'Line one\nLine two');
  assert.strictEqual(s('I wrote: a note on Monday'), 'I wrote: a note on Monday', '"wrote:" in a sentence is not a marker');
});

test('inbound rules: body cleaning, block and allow lists, names', () => {
  assert.strictEqual(rules.cleanBody('a\u0000b\u0007c\r\nd'), 'abc\nd');
  assert.strictEqual(rules.cleanBody('x\n\n\n\n\n\ny'), 'x\n\n\ny');
  assert.match(rules.cleanBody('z'.repeat(30000)), /shortened: it was 30000 characters/);
  assert.strictEqual(rules.cleanBody('a'.repeat(30000)).length < 20200, true);
  assert.ok(rules.blocked('Bad@Spam.test', ['bad@spam.test']));
  assert.ok(rules.blocked('x@spam.test', ['spam.test']));
  assert.ok(rules.blocked('x@spam.test', ['@spam.test']));
  assert.ok(!rules.blocked('x@notspam.test', ['spam.test']));
  assert.ok(!rules.blocked('x@y.test', []));
  assert.ok(rules.domainAllowed('x@y.test', []) && rules.domainAllowed('x@Y.test', ['y.test']) && !rules.domainAllowed('x@z.test', ['y.test']));
  assert.strictEqual(rules.contactName('Pat Example', 'pat@corp.test'), 'Pat Example');
  assert.strictEqual(rules.contactName('', 'pat.example@corp.test'), 'Pat Example');
  assert.strictEqual(rules.contactName('pat@corp.test', 'pat@corp.test'), 'Pat', 'a display name that is just the address is not a name');
  assert.ok(!/[<>"]/.test(rules.contactName('<b>Pat</b>"', 'p@c.test')) && /Pat/.test(rules.contactName('<b>Pat</b>"', 'p@c.test')), 'no markup characters survive in a name');
  assert.strictEqual(rules.contactUsername('Pat.Example+tag@Corp.test'), 'mail.pat.example.tag.corp.test');
  assert.ok(rules.contactUsername(`${'a'.repeat(100)}@x.test`).length <= 60);
});

test('inbound parsing: text from HTML, files, odd subjects, missing ids', async () => {
  const html = await parseMessage('From: "Pat" <PAT@Corp.test>\r\nSubject: =?UTF-8?B?UHJpbnRlciDinJM=?=\r\nMessage-ID: <m1@corp.test>\r\nIn-Reply-To: <orig@desk.test>\r\nReferences: <a@x> <orig@desk.test>\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<style>p{}</style><p>The <b>printer</b> is <script>alert(1)</script>broken</p><img src="http://evil.test/x.gif">');
  assert.strictEqual(html.fromAddress, 'pat@corp.test');
  assert.strictEqual(html.subject, 'Printer ✓');
  assert.strictEqual(html.messageId, 'm1@corp.test');
  assert.deepStrictEqual(html.inReplyTo, ['orig@desk.test', 'a@x']);
  assert.strictEqual(html.text, 'The printer is broken', 'no tags, no script, no remote image');
  const multi = await parseMessage('From: a@b.test\r\nSubject: x\r\nContent-Type: multipart/mixed; boundary=B\r\n\r\n--B\r\nContent-Type: text/html\r\n\r\n<p>Body <script>x()</script>text</p>\r\n--B\r\nContent-Type: application/octet-stream; name=a.bin\r\nContent-Disposition: attachment; filename=a.bin\r\nContent-Transfer-Encoding: base64\r\n\r\nAAEC\r\n--B--\r\n');
  assert.strictEqual(multi.text, 'Body text', 'an HTML body next to an attachment still gives text');
  assert.strictEqual(multi.attachments.length, 1);
  assert.deepStrictEqual([multi.attachments[0].filename, multi.attachments[0].size, multi.attachments[0].inline], ['a.bin', 3, false]);
  assert.match(multi.messageId, /^sha256:[0-9a-f]{64}$/, 'no Message-ID: a fingerprint of the message');
  assert.strictEqual((await parseMessage('From: a@b.test\r\nSubject: x\r\n\r\nhi')).messageId.length > 10, true);
  const same = 'From: a@b.test\r\nSubject: x\r\n\r\nsame';
  assert.strictEqual((await parseMessage(same)).messageId, (await parseMessage(same)).messageId);
  const none = await parseMessage('Subject: no sender\r\n\r\nhello');
  assert.strictEqual(none.fromAddress, '');
  await assert.doesNotReject(parseMessage(Buffer.from([0, 1, 2, 3, 255, 254, 10, 13, 0])));
});

test('inbound settings: off by default, and wrong settings are refused with a plain message', () => {
  const off = inboundConfig({});
  assert.deepStrictEqual([off.enabled, off.imap, off.secret], [false, null, null]);
  assert.deepStrictEqual([off.unknownSenders, off.maxPerSenderHour, off.requireAuth, off.logDays, off.maxMessageBytes], ['create', 10, false, 90, 25 * 1048576]);
  const on = inboundConfig({ INBOUND_IMAP_HOST: 'imap.example.test', INBOUND_IMAP_USER: 'help@example.test', INBOUND_IMAP_PASSWORD: 'p' });
  assert.deepStrictEqual([on.enabled, on.imap.port, on.imap.secure, on.imap.folder, on.imap.pollSeconds, on.address], [true, 993, true, 'INBOX', 60, 'help@example.test']);
  assert.strictEqual(inboundConfig({ INBOUND_IMAP_HOST: 'h', INBOUND_IMAP_USER: 'u', INBOUND_IMAP_PASSWORD: 'p', INBOUND_IMAP_PORT: '143' }).imap.secure, false, 'port 143 means STARTTLS');
  assert.deepStrictEqual([inboundConfig({ INBOUND_SECRET: 'x'.repeat(24) }).enabled, inboundConfig({ INBOUND_SECRET: 'x'.repeat(24) }).imap], [true, null]);
  const lists = inboundConfig({ INBOUND_ALLOWED_DOMAINS: ' Corp.test, @partner.test ,', INBOUND_BLOCKED_SENDERS: 'Spam@x.test' });
  assert.deepStrictEqual([lists.allowedDomains, lists.blockedSenders], [['corp.test', '@partner.test'], ['spam@x.test']]);
  const refused = [
    [{ INBOUND_IMAP_HOST: 'h' }, /needs INBOUND_IMAP_USER and INBOUND_IMAP_PASSWORD/],
    [{ INBOUND_IMAP_USER: 'u', INBOUND_IMAP_PASSWORD: 'p' }, /need INBOUND_IMAP_HOST/],
    [{ INBOUND_SECRET: 'short' }, /at least 24 characters/],
    [{ INBOUND_UNKNOWN_SENDERS: 'maybe' }, /create or ignore/],
    [{ INBOUND_ADDRESS: 'not an address' }, /INBOUND_ADDRESS must be an email address/],
    [{ INBOUND_SECRET: 'x'.repeat(24), INBOUND_MAX_PER_SENDER_HOUR: '-1' }, /INBOUND_MAX_PER_SENDER_HOUR must be a whole number/],
    [{ INBOUND_SECRET: 'x'.repeat(24), INBOUND_MAX_MESSAGE_MB: '500' }, /INBOUND_MAX_MESSAGE_MB/],
    [{ INBOUND_IMAP_HOST: 'h', INBOUND_IMAP_USER: 'u', INBOUND_IMAP_PASSWORD: 'p', INBOUND_POLL_SECONDS: '2' }, /INBOUND_POLL_SECONDS must be a whole number from 10 to 3600/],
    [{ INBOUND_IMAP_HOST: 'h', INBOUND_IMAP_USER: 'u', INBOUND_IMAP_PASSWORD: 'p', INBOUND_IMAP_SECURE: 'yes' }, /INBOUND_IMAP_SECURE must be true or false/],
    [{ INBOUND_SECRET: 'x'.repeat(24), INBOUND_REQUIRE_AUTH: 'sure' }, /INBOUND_REQUIRE_AUTH must be true or false/],
  ];
  for (const [env, message] of refused) assert.throws(() => inboundConfig(env), message, JSON.stringify(env));
});
