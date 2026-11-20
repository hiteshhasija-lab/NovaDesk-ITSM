// The hand-written tar writer: headers are valid (checked by the system tar where there is one), content survives, sizes that are not a
// multiple of 512 are padded, and names that cannot be stored are refused.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { PassThrough, Readable } = require('node:stream');
const { TarWriter, header, padding, BLOCK } = require('../src/tarWriter');

const hasTar = (() => { try { execFileSync('tar', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('a header is one block, with a checksum that adds up and the size in octal', () => {
  const h = header('tables/users.jsonl', 1234, 1700000000);
  assert.strictEqual(h.length, BLOCK);
  assert.strictEqual(h.toString('ascii', 0, 18), 'tables/users.jsonl');
  assert.strictEqual(parseInt(h.toString('ascii', 124, 135), 8), 1234);
  assert.strictEqual(h.toString('ascii', 257, 262), 'ustar');
  const stored = parseInt(h.toString('ascii', 148, 154), 8);
  const copy = Buffer.from(h); copy.write('        ', 148, 'ascii');
  assert.strictEqual([...copy].reduce((a, b) => a + b, 0), stored, 'the checksum is the sum of the block with the checksum field as spaces');
});

test('padding fills up to the next block, and nothing when a size is already a multiple', () => {
  assert.deepStrictEqual([padding(0).length, padding(1).length, padding(511).length, padding(512).length, padding(513).length], [0, 511, 1, 0, 511]);
});

test('names that cannot be stored are refused', () => {
  assert.throws(() => header('', 1), /1 to 99 bytes/);
  assert.throws(() => header('x'.repeat(100), 1), /1 to 99 bytes/);
  assert.doesNotThrow(() => header('x'.repeat(99), 1));
  assert.throws(() => header('é'.repeat(60), 1), /1 to 99 bytes/, 'bytes, not characters');
});

async function archive(build) {
  const out = new PassThrough(); const chunks = []; out.on('data', (c) => chunks.push(c));
  const closed = new Promise((r) => out.on('end', r));
  const tar = new TarWriter(out);
  await build(tar);
  tar.finish();
  await closed;
  return Buffer.concat(chunks);
}

test('an archive is a whole number of blocks and ends with two empty ones', async () => {
  const buf = await archive(async (t) => { await t.addBuffer('a.txt', 'hello'); await t.addBuffer('b/empty.txt', ''); });
  assert.strictEqual(buf.length % BLOCK, 0);
  assert.ok(buf.subarray(buf.length - 2 * BLOCK).every((b) => b === 0));
  assert.strictEqual(buf.length, BLOCK * (1 + 1 + 1 + 2), 'header + one data block, a header for the empty file, two end blocks');
});

test('a stream whose size is wrong is refused', async () => {
  const out = new PassThrough(); out.resume();
  const t = new TarWriter(out);
  await assert.rejects(() => t.addStream('f', 3, Readable.from([Buffer.from('toolong')])), /grew/);
  await assert.rejects(() => t.addStream('g', 10, Readable.from([Buffer.from('short')])), /changed size/);
});

test('the system tar reads what was written, content and all, including sizes that are not a block', { skip: !hasTar && 'no tar command' }, async () => {
  const big = Buffer.alloc(100000, 'x'); big.write('begin', 0); big.write('end', big.length - 3);
  const buf = await archive(async (t) => {
    await t.addBuffer('tables/users.jsonl', '{"id":1}\n{"id":2}\n');
    await t.addBuffer('manifest.json', JSON.stringify({ ok: true }));
    await t.addStream('files/incident/big.bin', big.length, Readable.from([big.subarray(0, 40000), big.subarray(40000)]));
    await t.addBuffer('files/branding/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]));
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-tar-'));
  const gz = path.join(dir, 'a.tar.gz'); fs.writeFileSync(gz, zlib.gzipSync(buf));
  const list = execFileSync('tar', ['-tzf', gz]).toString().trim().split('\n');
  assert.deepStrictEqual(list, ['tables/users.jsonl', 'manifest.json', 'files/incident/big.bin', 'files/branding/logo.png']);
  execFileSync('tar', ['-xzf', gz, '-C', dir]);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'tables/users.jsonl'), 'utf8'), '{"id":1}\n{"id":2}\n');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')), { ok: true });
  assert.ok(fs.readFileSync(path.join(dir, 'files/incident/big.bin')).equals(big), '100 000 bytes come back byte for byte');
  assert.ok(fs.readFileSync(path.join(dir, 'files/branding/logo.png')).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255])), 'binary content is untouched');
});
