'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const qr = require('../src/qr');
const { otpauthUri } = require('../src/totp');

const { build, rsDivisor, rsRemainder, maskApplies } = qr._internals;
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

// Reads a code the way a phone does, from the finished matrix alone: format information, unmasking, the codeword
// zigzag, de-interleaving, a Reed-Solomon check of every block, then the payload. (The encoder was also read back
// by a real decoder, Apple's, once, for sizes from version 1 to 29; this keeps that true as the code changes.)
function read(q) {
  const { modules, size, version } = q;
  const bitAt = (x, y) => (modules[y][x] ? 1 : 0);
  let format = 0;
  for (let i = 0; i <= 5; i++) format |= bitAt(8, i) << i;
  format |= bitAt(8, 7) << 6; format |= bitAt(8, 8) << 7; format |= bitAt(7, 8) << 8;
  for (let i = 9; i < 15; i++) format |= bitAt(14 - i, 8) << i;
  format ^= 0x5412;
  let check = format;                                 // 5 data bits + 10 BCH bits: divisible by the generator
  for (let i = 4; i >= 0; i--) if ((check >>> (i + 10)) & 1) check ^= 0x537 << i;
  assert.strictEqual(check, 0, 'format information has a valid BCH code');
  assert.strictEqual(format >>> 13, 0, 'error correction level M');
  const mask = (format >>> 10) & 7;
  assert.strictEqual(mask, q.mask);

  const { fixed } = build(new Array(0), version, 0);
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!fixed[y][x]) bits.push(bitAt(x, y) ^ (maskApplies(mask, x, y) ? 1 : 0));
      }
    }
  }
  const words = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  return { words, version };
}

function deinterleave(words, version) {
  const ECC = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
  const BLK = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
  const nb = BLK[version], eccLen = ECC[version];
  const raw = words.length;
  const numShort = nb - (raw % nb), shortLen = Math.floor(raw / nb);
  const blocks = Array.from({ length: nb }, () => []);
  let k = 0;
  for (let i = 0; i < shortLen + 1; i++) {
    for (let j = 0; j < nb; j++) {
      if (i === shortLen - eccLen && j < numShort) continue;      // short blocks have no data byte here
      blocks[j].push(words[k++]);
    }
  }
  return { blocks, eccLen, numShort };
}

function payloadOf(q) {
  const { words, version } = read(q);
  const { blocks, eccLen } = deinterleave(words, version);
  const divisor = rsDivisor(eccLen);
  const data = [];
  blocks.forEach((block, j) => {
    const dataLen = block.length - eccLen;
    assert.deepStrictEqual(rsRemainder(block.slice(0, dataLen), divisor), block.slice(dataLen), `block ${j} of v${version} fails its Reed-Solomon check`);
    data.push(...block.slice(0, dataLen));
  });
  const bits = data.flatMap((b) => Array.from({ length: 8 }, (_, i) => (b >>> (7 - i)) & 1));
  let at = 0;
  const take = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | bits[at++]; return v; };
  assert.strictEqual(take(4), 0x4, 'byte mode');
  const length = take(version < 10 ? 8 : 16);
  return Buffer.from(Array.from({ length }, () => take(8))).toString('utf8');
}

test('qr: codes read back to exactly the text, from the smallest to a large one', () => {
  const texts = ['a', 'NovaDesk', 'x'.repeat(14), 'x'.repeat(100), otpauthUri({ issuer: 'NovaDesk', account: 'pat.example@corp.example', secret: SECRET }), 'Ab9-_/:?=&% '.repeat(30), 'y'.repeat(900), 'héllo ✓ 日本語'];
  const seen = new Set();
  for (const text of texts) {
    const q = qr.encode(text);
    assert.ok(q, text.slice(0, 20));
    assert.strictEqual(q.size, 17 + 4 * q.version);
    assert.strictEqual(payloadOf(q), text);
    seen.add(q.version);
  }
  assert.ok(seen.size >= 6, 'a spread of sizes was tried: ' + [...seen]);
  assert.ok([...seen].some((v) => v >= 7), 'including one that carries version information');
});

test('qr: finder patterns sit in three corners and the timing line alternates', () => {
  const { modules, size } = qr.encode('NovaDesk');
  for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let d = 0; d < 7; d++) {
      assert.ok(modules[oy][ox + d] && modules[oy + 6][ox + d] && modules[oy + d][ox] && modules[oy + d][ox + 6], 'outer ring');
    }
    assert.ok(modules[oy + 3][ox + 3], 'centre');
    assert.ok(!modules[oy + 1][ox + 1] && !modules[oy + 5][ox + 5], 'light ring');
  }
  for (let i = 8; i < size - 8; i++) assert.strictEqual(modules[6][i], i % 2 === 0);
});

test('qr: the same text always gives the same picture, and it is a plain inline svg', () => {
  const uri = otpauthUri({ issuer: 'NovaDesk', account: 'pat', secret: SECRET });
  const a = qr.toSvg(uri, { label: 'Set <up> "key"' }), b = qr.toSvg(uri);
  assert.ok(a && b);
  assert.strictEqual(qr.toSvg(uri), b);
  assert.ok(a.startsWith('<svg') && a.endsWith('</svg>'));
  assert.ok(!/<script|onload|href/i.test(a));
  assert.ok(/aria-label="Set up key"/.test(a), 'the label cannot break out of the attribute');
  // A change to the drawing code that alters any module changes this on purpose: re-read the new picture with a real
  // decoder before updating it.
  assert.strictEqual(crypto.createHash('sha256').update(b).digest('hex'), GOLDEN);
});

test('qr: text that cannot fit gives null instead of a broken picture', () => {
  assert.ok(qr.encode('z'.repeat(2331)), 'the largest that fits at level M');
  assert.strictEqual(qr.encode('z'.repeat(2332)), null);
  assert.strictEqual(qr.toSvg('z'.repeat(3000)), null);
});

const GOLDEN = '35d69d27649c1e0ded40135d13726a7375e2ddab5378544df6da3a17d3ee8aa5';
