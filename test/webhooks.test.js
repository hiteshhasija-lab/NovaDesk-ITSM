'use strict';
const test = require('node:test');
const assert = require('node:assert');
const webhooks = require('../src/webhooks');
const { WebhookUrlError } = require('../src/webhookNet');

test('the events that can be subscribed to: every record kind, created / updated / status_changed, commented where there are comments', () => {
  const types = webhooks.EVENT_TYPES;
  assert.strictEqual(new Set(types).size, types.length);
  for (const entity of ['incident', 'change', 'problem', 'request', 'ci', 'article']) {
    for (const op of ['created', 'updated', 'status_changed']) assert.ok(types.includes(`${entity}.${op}`), `${entity}.${op}`);
  }
  assert.deepStrictEqual(types.filter((t) => t.endsWith('.commented')).sort(), ['change.commented', 'incident.commented', 'problem.commented']);
  assert.strictEqual(types.length, 21);
});

test('choosing events: one or several, everything, never nothing, never something unknown', () => {
  assert.strictEqual(webhooks.parseEvents(['incident.created', 'ci.updated', 'incident.created']), 'incident.created,ci.updated');
  assert.strictEqual(webhooks.parseEvents('incident.created'), 'incident.created');
  assert.strictEqual(webhooks.parseEvents(['incident.created', '*']), '*');
  assert.throws(() => webhooks.parseEvents([]), WebhookUrlError);
  assert.throws(() => webhooks.parseEvents(undefined), /at least one event/);
  assert.throws(() => webhooks.parseEvents(['incident.deleted']), /not an event NovaDesk sends/);
});

test('a webhook receives an event when it listed it, or listed everything', () => {
  assert.ok(webhooks.subscribes({ events: '*' }, 'incident.created'));
  assert.ok(webhooks.subscribes({ events: 'incident.created,ci.updated' }, 'ci.updated'));
  assert.ok(!webhooks.subscribes({ events: 'incident.created,ci.updated' }, 'ci.created'));
  assert.ok(!webhooks.subscribes({ events: 'incident.created' }, 'incident.created.extra'), 'whole names only');
  assert.ok(!webhooks.subscribes({ events: 'incident.status_changed' }, 'incident'), 'a prefix is not a match');
});

test('a signing secret that can no longer be read gives a clear instruction, not a cryptic error', () => {
  const { encryptSecret } = require('../src/mfaCrypto');
  const { readSecret } = webhooks._testing;
  const mine = encryptSecret('whsec_x');                                        // under this process's key
  assert.strictEqual(readSecret({ secret_enc: mine }), 'whsec_x');
  const foreign = encryptSecret('whsec_x', { SESSION_SECRET: 'a'.repeat(40) });  // under another copy's key
  assert.throws(() => readSecret({ secret_enc: foreign }), /signing secret cannot be read.*SESSION_SECRET.*New secret/);
  assert.throws(() => readSecret({ secret_enc: 'garbage' }), /signing secret cannot be read/);
});
