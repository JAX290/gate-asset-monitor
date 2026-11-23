'use strict';

/**
 * Minimal, zero-dependency ZIP writer (STORE method, no compression).
 * Produces a valid PKZIP archive from {name, data} entries. Used for the
 * "export everything" bundle so third-party tools (Excel / pandas / unzip)
 * can open it without any npm package.
 *
 * Implements: local file headers, central directory, EOCD, CRC-32, UTF-8
 * filename flag (0x0800). No encryption, no zip64 (fine for our data sizes).
 *
 * `build()` materialises the whole archive (used by tests and the offline CLI).
 * `stream()` yields one buffer at a time for HTTP downloads, so peak memory
 * stays at the size of the largest single entry instead of 2x the bundle.
 */

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[i] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d) {
  const yr = Math.min(2107, Math.max(1980, d.getFullYear()));
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const date = ((yr - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xFFFF, date: date & 0xFFFF };
}

function normalise(e) {
  return {
    name: Buffer.from(e.name, 'utf8'),
    data: Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8'),
  };
}

function localHeader(time, date, crc, size, nameLen) {
  const b = Buffer.alloc(30);
  b.writeUInt32LE(0x04034b50, 0);   // local file header signature
  b.writeUInt16LE(20, 4);           // version needed
  b.writeUInt16LE(0x0800, 6);       // flags: UTF-8 filenames
  b.writeUInt16LE(0, 8);            // method: STORE
  b.writeUInt16LE(time, 10);
  b.writeUInt16LE(date, 12);
  b.writeUInt32LE(crc, 14);
  b.writeUInt32LE(size, 18);        // compressed size
  b.writeUInt32LE(size, 22);        // uncompressed size
  b.writeUInt16LE(nameLen, 26);
  b.writeUInt16LE(0, 28);           // extra length
  return b;
}

function centralHeader(time, date, crc, size, nameLen, offset) {
  const b = Buffer.alloc(46);
  b.writeUInt32LE(0x02014b50, 0);   // central dir signature
  b.writeUInt16LE(20, 4);           // version made by
  b.writeUInt16LE(20, 6);           // version needed
  b.writeUInt16LE(0x0800, 8);       // flags
  b.writeUInt16LE(0, 10);           // method
  b.writeUInt16LE(time, 12);
  b.writeUInt16LE(date, 14);
  b.writeUInt32LE(crc, 16);
  b.writeUInt32LE(size, 20);
  b.writeUInt32LE(size, 24);
  b.writeUInt16LE(nameLen, 28);
  b.writeUInt16LE(0, 30);           // extra length
  b.writeUInt16LE(0, 32);           // comment length
  b.writeUInt16LE(0, 34);           // disk number
  b.writeUInt16LE(0, 36);           // internal attrs
  b.writeUInt32LE(0, 38);           // external attrs
  b.writeUInt32LE(offset, 42);      // relative offset of local header
  return b;
}

function eocd(count, centralLen, offset) {
  const b = Buffer.alloc(22);
  b.writeUInt32LE(0x06054b50, 0);
  b.writeUInt16LE(0, 4);            // disk number
  b.writeUInt16LE(0, 6);            // disk with central dir
  b.writeUInt16LE(count, 8);
  b.writeUInt16LE(count, 10);
  b.writeUInt32LE(centralLen, 12);
  b.writeUInt32LE(offset, 16);      // central dir offset
  b.writeUInt16LE(0, 20);           // comment length
  return b;
}

/**
 * @param {Array<{name:string, data:Buffer|string}>} entries
 * @param {Date} [now] injectable for byte-for-byte tests
 * @returns {Buffer} complete zip archive
 */
function build(entries, now = new Date()) {
  const { time, date } = dosDateTime(now);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const { name, data } = normalise(e);
    const crc = crc32(data);
    locals.push(localHeader(time, date, crc, data.length, name.length), name, data);
    centrals.push(centralHeader(time, date, crc, data.length, name.length, offset), name);
    offset += 30 + name.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  return Buffer.concat([...locals, centralBuf, eocd(entries.length, centralBuf.length, offset)]);
}

/**
 * Generator form: identical bytes to build(), but yields each header / entry
 * separately. Intended for `res.write()` with backpressure handling.
 * @param {Array<{name:string, data:Buffer|string}>} entries
 * @param {Date} [now]
 */
function* stream(entries, now = new Date()) {
  const { time, date } = dosDateTime(now);
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const { name, data } = normalise(e);
    const crc = crc32(data);
    yield localHeader(time, date, crc, data.length, name.length);
    yield name;
    yield data;
    centrals.push(centralHeader(time, date, crc, data.length, name.length, offset), name);
    offset += 30 + name.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  yield centralBuf;
  yield eocd(entries.length, centralBuf.length, offset);
}

module.exports = { build, stream, crc32 };
