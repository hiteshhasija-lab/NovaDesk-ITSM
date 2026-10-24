'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { isPrivateAddress, checkTarget, sign, verifySignature, retryDelays, postJson, WebhookUrlError } = require('../src/webhookNet');

test('private, local and reserved addresses are recognised, public ones are not (IPv4 and IPv6)', () => {
  for (const ip of ['127.0.0.1', '127.9.9.9', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '255.255.255.255', '198.18.0.1',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.1.2.3', '::ffff:7f00:1', '64:ff9b::a00:1', '2002:c0a8:101::1']) assert.ok(isPrivateAddress(ip), `${ip} should be private`);
  for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.113.10', '172.15.255.255', '172.32.0.1', '11.0.0.1', '100.63.255.255', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '2002:0808:0808::1']) assert.ok(!isPrivateAddress(ip), `${ip} should be public`);
  assert.ok(isPrivateAddress('not-an-ip'), 'anything that is not an address is never called');
});

const resolver = (map) => async (host) => { if (!map[host]) throw new Error('ENOTFOUND'); return map[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 })); };
const refuses = (text, pattern, opts) => assert.rejects(checkTarget(text, opts), (e) => e instanceof WebhookUrlError && pattern.test(e.message), text);

test('a webhook address must be https, have no credentials, and point only at public addresses', async () => {
  const resolve = resolver({ 'hooks.example.com': ['203.0.113.7'], 'internal.example.com': ['10.0.0.9'], 'mixed.example.com': ['203.0.113.7', '192.168.0.4'], 'meta.example.com': ['169.254.169.254'] });
  const ok = await checkTarget('https://hooks.example.com:8443/path?x=1', { resolve });
  assert.deepStrictEqual([ok.address, ok.family, ok.url.port, ok.url.pathname], ['203.0.113.7', 4, '8443', '/path']);
  assert.strictEqual((await checkTarget('https://203.0.113.10/hook', { resolve })).address, '203.0.113.10', 'an address literal needs no lookup');
  await refuses('http://hooks.example.com/x', /must start with https/, { resolve });
  await refuses('https://user:pass@hooks.example.com/', /user name or password/, { resolve });
  await refuses('https://internal.example.com/', /private, local or reserved/, { resolve });
  await refuses('https://mixed.example.com/', /private, local or reserved/, { resolve });
  await refuses('https://meta.example.com/', /private, local or reserved/, { resolve });
  await refuses('https://127.0.0.1/', /private, local or reserved/, { resolve });
  await refuses('https://[::1]/', /private, local or reserved/, { resolve });
  await refuses('https://169.254.169.254/latest/meta-data', /private, local or reserved/, { resolve });
  await refuses('https://nowhere.example.com/', /could not be looked up/, { resolve });
  await refuses('not a url', /not a web address/, { resolve });
  await refuses(`https://hooks.example.com/${'a'.repeat(2100)}`, /too long/, { resolve });
});

test('with WEBHOOK_ALLOW_PRIVATE, private addresses and plain http are accepted (for internal receivers and tests)', async () => {
  const opts = { allowPrivate: true, resolve: resolver({ 'internal.example.com': ['10.0.0.9'] }) };
  assert.strictEqual((await checkTarget('http://127.0.0.1:9000/hook', opts)).address, '127.0.0.1');
  assert.strictEqual((await checkTarget('https://internal.example.com/hook', opts)).address, '10.0.0.9');
  await refuses('http://user:pw@127.0.0.1/', /user name or password/, opts);      // credentials are never allowed
});

test('a delivery is signed so the receiver can check it came from NovaDesk, was not altered and is fresh', () => {
  const secret = 'whsec_test'; const body = '{"id":"evt_1","type":"incident.created"}';
  const header = sign(secret, body, 1_800_000_000);
  assert.match(header, /^t=1800000000,v1=[0-9a-f]{64}$/);
  assert.strictEqual(header, sign(secret, body, 1_800_000_000), 'the same input signs the same');
  assert.ok(verifySignature(secret, header, body, { nowSeconds: 1_800_000_100 }));
  assert.ok(!verifySignature(secret, header, `${body} `, { nowSeconds: 1_800_000_100 }), 'an altered body fails');
  assert.ok(!verifySignature('whsec_other', header, body, { nowSeconds: 1_800_000_100 }), 'another secret fails');
  assert.ok(!verifySignature(secret, header, body, { nowSeconds: 1_800_000_000 + 301 }), 'a replay after five minutes fails');
  assert.ok(!verifySignature(secret, header.replace('t=1800000000', 't=1800000001'), body, { nowSeconds: 1_800_000_100 }), 'a changed timestamp fails');
  for (const bad of ['', 'v1=abc', 't=1,v1=zz', null, undefined]) assert.ok(!verifySignature(secret, bad, body));
  // A fixed vector, so a receiver written in any language can be checked against it.
  assert.strictEqual(sign('secret', 'body', 1), 't=1,v1=' + require('node:crypto').createHmac('sha256', 'secret').update('1.body').digest('hex'));
});

test('retry delays: 1 min, 5 min, 30 min, 2 h, 6 h, and replaceable for tests', () => {
  assert.deepStrictEqual(retryDelays({}), [60, 300, 1800, 7200, 21600]);
  assert.deepStrictEqual(retryDelays({ WEBHOOK_RETRY_DELAYS_S: '1, 2,3' }), [1, 2, 3]);
  assert.throws(() => retryDelays({ WEBHOOK_RETRY_DELAYS_S: '1,x' }), /WEBHOOK_RETRY_DELAYS_S/);
});

test('one POST: connects to the checked address, sends the body and headers, reads a short answer, follows no redirect', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ url: req.url, host: req.headers.host, type: req.headers['content-type'], sig: req.headers['x-test'], body });
      if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:1/elsewhere' }); return res.end(); }
      if (req.url === '/slow') return;                                        // never answers
      res.writeHead(req.url === '/fail' ? 500 : 200); res.end('x'.repeat(5000));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const target = async (p) => ({ url: new URL(`http://hooks.example.test:${port}${p}`), address: '127.0.0.1', family: 4 });   // the NAME is fake: only the checked address is used
  try {
    const ok = await postJson(await target('/hook'), { 'Content-Type': 'application/json', 'X-Test': 'abc' }, '{"a":1}');
    assert.strictEqual(ok.status, 200);
    assert.ok(ok.snippet.length <= 300, 'only a snippet of the answer is kept');
    assert.deepStrictEqual([seen[0].url, seen[0].type, seen[0].sig, seen[0].body, seen[0].host], ['/hook', 'application/json', 'abc', '{"a":1}', `hooks.example.test:${port}`]);
    assert.strictEqual((await postJson(await target('/fail'), {}, '{}')).status, 500);
    assert.strictEqual((await postJson(await target('/redirect'), {}, '{}')).status, 302, 'a redirect is reported, never followed');
    assert.strictEqual(seen.filter((s) => s.url === '/elsewhere').length, 0);
    await assert.rejects(postJson(await target('/slow'), {}, '{}', { timeoutMs: 300 }), /no answer within/);
    server.close();
    await assert.rejects(postJson(await target('/hook'), {}, '{}'), /connection refused/);
  } finally { server.close(); }
});
