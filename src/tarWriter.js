// A tar archive written by hand (ustar), so an export needs no extra package. Entries are added one after the other to a writable stream
// (usually a gzip stream); a file's size has to be known before its content is written, which is why a table is read into memory first
// and a file from disk is stat-ed first. Names must be at most 99 bytes (the exporter's own names are far shorter).
'use strict';
const { once } = require('events');

const BLOCK = 512;
const octal = (n, width) => n.toString(8).padStart(width - 1, '0') + '\0';

function header(name, size, mtimeSec = Math.floor(Date.now() / 1000)) {
  const nameBytes = Buffer.from(String(name), 'utf8');
  if (!nameBytes.length || nameBytes.length > 99) throw new Error(`tar entry name must be 1 to 99 bytes: ${name}`);
  const h = Buffer.alloc(BLOCK, 0);
  nameBytes.copy(h, 0);
  h.write(octal(0o644, 8), 100, 'ascii');          // mode
  h.write(octal(0, 8), 108, 'ascii');              // uid
  h.write(octal(0, 8), 116, 'ascii');              // gid
  h.write(octal(size, 12), 124, 'ascii');          // size
  h.write(octal(mtimeSec, 12), 136, 'ascii');      // mtime
  h.write('        ', 148, 'ascii');               // checksum, counted as spaces
  h.write('0', 156, 'ascii');                      // a regular file
  h.write('ustar\0', 257, 'ascii'); h.write('00', 263, 'ascii');
  let sum = 0; for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}
const padding = (size) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK, 0);

// Writes a chunk, waiting for the stream to drain when it is full.
async function put(out, chunk) { if (!out.write(chunk)) await once(out, 'drain'); }

class TarWriter {
  constructor(out) { this.out = out; this.entries = 0; }
  async addBuffer(name, buf) {
    const body = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
    await put(this.out, header(name, body.length));
    if (body.length) await put(this.out, body);
    await put(this.out, padding(body.length));
    this.entries++;
  }
  // A file or any readable whose exact size is known beforehand.
  async addStream(name, size, readable) {
    await put(this.out, header(name, size));
    let sent = 0;
    for await (const chunk of readable) { sent += chunk.length; if (sent > size) throw new Error(`${name} grew while it was being read`); await put(this.out, chunk); }
    if (sent !== size) throw new Error(`${name} changed size while it was being read`);
    await put(this.out, padding(size));
    this.entries++;
  }
  finish() { this.out.write(Buffer.alloc(BLOCK * 2, 0)); this.out.end(); }
}

module.exports = { TarWriter, header, padding, BLOCK };
