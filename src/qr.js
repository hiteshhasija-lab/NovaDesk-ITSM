// QR code encoder for the two-step verification setup page: text in, inline SVG out.
//
// Written out here instead of using a package or an online QR service, so the secret in the setup link never
// leaves this server and nothing new has to be installed. It does only what the page needs:
//   - byte mode (the setup link is plain ASCII), error correction level M, versions 1-40
//   - mask chosen by the usual penalty rules
// A link too long for version 40 gives null and the page shows the typed key alone.
//
// Layout of the code follows ISO/IEC 18004: finder, timing and alignment patterns, format and version
// information, data and Reed-Solomon codewords interleaved over blocks.
'use strict';

// Per version (index 0 unused): error-correction codewords per block, and number of blocks, at level M.
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
const FORMAT_BITS_M = 0;          // level M is 00 in the format information
const QUIET_ZONE = 4;             // modules of white around the code

const bit = (x, i) => ((x >>> i) & 1) !== 0;

// ---- Reed-Solomon over GF(2^8), polynomial x^8 + x^4 + x^3 + x^2 + 1 ----
function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11D);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}
function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMultiply(coef, factor); });
  }
  return result;
}

// ---- sizes ----
const sizeOf = (version) => version * 4 + 17;
function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}
const dataCodewords = (version) => Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[version] * NUM_BLOCKS[version];
function alignmentPositions(version) {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = sizeOf(version) - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// ---- the data bits and the codewords ----
function dataBits(bytes, version) {
  const bits = [];
  const put = (value, count) => { for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(0x4, 4);                                  // byte mode
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capacityBits = dataCodewords(version) * 8;
  put(0, Math.min(4, capacityBits - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xEC; bits.length < capacityBits; pad ^= 0xEC ^ 0x11) put(pad, 8);
  const out = new Array(bits.length / 8).fill(0);
  bits.forEach((b, i) => { out[i >>> 3] |= b << (7 - (i & 7)); });
  return out;
}
function addEccAndInterleave(data, version) {
  const numBlocks = NUM_BLOCKS[version];
  const eccLen = ECC_PER_BLOCK[version];
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const numShort = numBlocks - (rawCodewords % numBlocks);
  const shortLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => { if (i !== shortLen - eccLen || j >= numShort) result.push(block[i]); });
  }
  return result;
}

// ---- the matrix ----
function build(codewords, version, mask) {
  const size = sizeOf(version);
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (x, y, dark) => { modules[y][x] = dark; fixed[y][x] = true; };

  for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, Math.max(Math.abs(dx), Math.abs(dy)) !== 2 && Math.max(Math.abs(dx), Math.abs(dy)) !== 4);
      }
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const pos = alignmentPositions(version);
  pos.forEach((px, i) => pos.forEach((py, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));

  // Format information (level + mask, with its BCH code), twice; and the always-dark module.
  const formatData = (FORMAT_BITS_M << 3) | mask;
  let rem = formatData;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const format = ((formatData << 10) | rem) ^ 0x5412;
  for (let i = 0; i <= 5; i++) setFn(8, i, bit(format, i));
  setFn(8, 7, bit(format, 6)); setFn(8, 8, bit(format, 7)); setFn(7, 8, bit(format, 8));
  for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(format, i));
  for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(format, i));
  for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(format, i));
  setFn(8, size - 8, true);

  if (version >= 7) {                           // version information, twice
    let r = version;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1F25);
    const bits = (version << 12) | r;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      setFn(a, b, bit(bits, i)); setFn(b, a, bit(bits, i));
    }
  }

  // Codewords, in the two-column zigzag from the bottom right.
  let n = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!fixed[y][x] && n < codewords.length * 8) { modules[y][x] = bit(codewords[n >>> 3], 7 - (n & 7)); n++; }
      }
    }
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y][x] && maskApplies(mask, x, y)) modules[y][x] = !modules[y][x];
  return { modules, fixed, size };
}
function maskApplies(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

// How awkward a mask is to read: long runs, 2x2 blocks, finder-like runs, and an uneven balance.
function penalty(modules, size) {
  let score = 0;
  const line = (get) => {
    let run = 1;
    for (let i = 1; i < size; i++) {
      if (get(i) === get(i - 1)) { run++; if (run === 5) score += 3; else if (run > 5) score += 1; } else run = 1;
    }
    const s = Array.from({ length: size }, (_, i) => (get(i) ? 1 : 0)).join('');
    for (let i = 0; i + 11 <= size; i++) {
      const w = s.slice(i, i + 11);
      if (w === '10111010000' || w === '00001011101') score += 40;
    }
  };
  for (let y = 0; y < size; y++) line((i) => modules[y][i]);
  for (let x = 0; x < size; x++) line((i) => modules[i][x]);
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const c = modules[y][x];
    if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
  }
  const dark = modules.reduce((n, row) => n + row.filter(Boolean).length, 0);
  score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  return score;
}

// The module matrix for a string, or null when it does not fit. true = dark.
function encode(text) {
  const bytes = Array.from(Buffer.from(String(text), 'utf8'));
  let version = 1;
  for (; version <= 40; version++) {
    const lenBits = version < 10 ? 8 : 16;
    if (4 + lenBits + bytes.length * 8 <= dataCodewords(version) * 8) break;
  }
  if (version > 40) return null;
  const codewords = addEccAndInterleave(dataBits(bytes, version), version);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const built = build(codewords, version, mask);
    const score = penalty(built.modules, built.size);
    if (!best || score < best.score) best = { ...built, score, mask, version };
  }
  return best;
}

// An inline SVG with the usual white border, black on white whatever the page's colours are.
function toSvg(text, { label = 'QR code' } = {}) {
  const qr = encode(text);
  if (!qr) return null;
  const total = qr.size + QUIET_ZONE * 2;
  const rows = [];
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y][x]) continue;
      let end = x;
      while (end + 1 < qr.size && qr.modules[y][end + 1]) end++;
      rows.push(`M${x + QUIET_ZONE} ${y + QUIET_ZONE}h${end - x + 1}v1h-${end - x + 1}z`);
      x = end;
    }
  }
  const safe = String(label).replace(/[&<>"]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" role="img" aria-label="${safe}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#fff"/><path fill="#000" d="${rows.join('')}"/></svg>`;
}

module.exports = { encode, toSvg, _internals: { dataCodewords, sizeOf, addEccAndInterleave, rsDivisor, rsRemainder, maskApplies, build, alignmentPositions } };
