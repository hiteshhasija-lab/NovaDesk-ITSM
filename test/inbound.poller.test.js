'use strict';
// The mailbox reader, tried with a stand-in for the mail server and for the intake: no network, no database.
const test = require('node:test');
const assert = require('node:assert');
const poller = require('../src/inbound/imapPoller');
const { inboundConfig } = require('../src/settings');

const { deps, setConfig, attempts, MAX_TRIES } = poller._test;
const base = { INBOUND_IMAP_HOST: 'imap.test', INBOUND_IMAP_USER: 'help@desk.test', INBOUND_IMAP_PASSWORD: 'p' };

function fakeMailbox(messages) {
  const seen = new Set(); const moved = [];
  const client = {
    mailbox: { uidValidity: 7 },
    on() {}, async connect() {}, async logout() {}, close() {},
    async getMailboxLock() { return { release() {} }; },
    async search() { return [...messages.keys()].filter((u) => !seen.has(u)); },
    async fetchOne(uid, q) { const m = messages.get(uid); return q.size ? { size: m.size } : { source: m.source }; },
    async messageFlagsAdd(uid) { seen.add(uid); },
    async messageMove(uid, folder) { moved.push([uid, folder]); seen.add(uid); },
  };
  return { client, seen, moved };
}
const msg = (n, extra = {}) => [n, { size: 100, source: Buffer.from(`m${n}`), ...extra }];

function setup(messages, env = {}) {
  const mailbox = fakeMailbox(new Map(messages));
  const calls = { handled: [], recorded: [] };
  setConfig(inboundConfig({ ...base, ...env }));
  attempts.clear();
  deps.createClient = () => mailbox.client;
  deps.parseMessage = async (source) => { if (String(source) === 'garbage') throw new Error('not mail'); return { id: String(source) }; };
  deps.processMessage = async (parsed) => { calls.handled.push(parsed.id); return { outcome: 'ticket' }; };
  deps.recordUnreadable = async (r) => { calls.recorded.push(r); };
  return { mailbox, calls };
}

test('mailbox reader: every unread message is handled, then marked read', async () => {
  const { mailbox, calls } = setup([msg(1), msg(2), msg(3)]);
  assert.strictEqual(await poller.lookOnce(), 3);
  assert.deepStrictEqual(calls.handled, ['m1', 'm2', 'm3']);
  assert.deepStrictEqual([...mailbox.seen].sort(), [1, 2, 3]);
  assert.strictEqual(await poller.lookOnce(), 0, 'a second look finds nothing');
});

test('mailbox reader: with a processed folder, handled messages are moved there', async () => {
  const { mailbox } = setup([msg(1), msg(2)], { INBOUND_PROCESSED_FOLDER: 'Done' });
  await poller.lookOnce();
  assert.deepStrictEqual(mailbox.moved, [[1, 'Done'], [2, 'Done']]);
});

test('mailbox reader: a message too large is written down as rejected and never read', async () => {
  const { mailbox, calls } = setup([msg(1, { size: 30 * 1048576 }), msg(2)], { INBOUND_MAX_MESSAGE_MB: '25' });
  await poller.lookOnce();
  assert.deepStrictEqual(calls.handled, ['m2'], 'only the small one went to the intake');
  assert.strictEqual(calls.recorded.length, 1);
  assert.deepStrictEqual([calls.recorded[0].outcome, /MB limit/.test(calls.recorded[0].reason), calls.recorded[0].messageId], ['rejected', true, 'imap:help@desk.test:INBOX:7:1']);
  assert.deepStrictEqual([...mailbox.seen].sort(), [1, 2]);
});

test('mailbox reader: text that is not an email is written down as failed and set aside', async () => {
  const { mailbox, calls } = setup([msg(1, { source: Buffer.from('garbage') }), msg(2)]);
  await poller.lookOnce();
  assert.deepStrictEqual(calls.handled, ['m2']);
  assert.match(calls.recorded[0].reason, /could not be read as an email: not mail/);
  assert.deepStrictEqual([...mailbox.seen].sort(), [1, 2], 'it will not be looked at again');
});

test('mailbox reader: something down (the database) leaves the message unread, and the others are still handled', async () => {
  const { mailbox, calls } = setup([msg(1), msg(2), msg(3)]);
  deps.processMessage = async (parsed) => { if (parsed.id === 'm2') throw new Error('the database is down'); calls.handled.push(parsed.id); return {}; };
  assert.strictEqual(await poller.lookOnce(), 2);
  assert.deepStrictEqual(calls.handled, ['m1', 'm3']);
  assert.deepStrictEqual([...mailbox.seen].sort(), [1, 3], 'm2 is still unread, to be tried again');
  assert.strictEqual(attempts.get('imap:help@desk.test:INBOX:7:2'), 1);
});

test('mailbox reader: a message that keeps failing is set aside after three tries, so it cannot hold up the rest', async () => {
  const { mailbox, calls } = setup([msg(1), msg(2)]);
  deps.processMessage = async (parsed) => { if (parsed.id === 'm1') throw new Error('this message breaks the intake'); calls.handled.push(parsed.id); return {}; };
  for (let i = 1; i < MAX_TRIES; i++) { await poller.lookOnce(); assert.ok(!mailbox.seen.has(1), `still unread after try ${i}`); }
  await poller.lookOnce();
  assert.ok(mailbox.seen.has(1), 'set aside on the last try');
  assert.strictEqual(calls.recorded.length, 1);
  assert.match(calls.recorded[0].reason, new RegExp(`could not be handled after ${MAX_TRIES} tries: this message breaks the intake`));
  assert.deepStrictEqual(calls.handled, ['m2'], 'the other message was handled the first time round');
});

test('mailbox reader: with the database down, mail is never set aside (it could not be written down), however long it lasts', async () => {
  const { mailbox } = setup([msg(1)]);
  deps.processMessage = async () => { throw new Error('the database is down'); };
  deps.recordUnreadable = async () => { throw new Error('the database is down'); };
  for (let i = 0; i < MAX_TRIES * 3; i++) await poller.lookOnce();
  assert.ok(!mailbox.seen.has(1), 'still unread after many looks: nothing was lost');
  deps.processMessage = async () => ({ outcome: 'ticket' });
  deps.recordUnreadable = async () => {};
  assert.strictEqual(await poller.lookOnce(), 1, 'and it is handled as soon as the database is back');
  assert.ok(mailbox.seen.has(1));
});

test('mailbox reader: at most 25 messages are handled per look; the rest wait for the next', async () => {
  const { mailbox } = setup(Array.from({ length: 30 }, (_, i) => msg(i + 1)));
  assert.strictEqual(await poller.lookOnce(), 25);
  assert.strictEqual(mailbox.seen.size, 25);
  assert.strictEqual(await poller.lookOnce(), 5);
});
