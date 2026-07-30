// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Reading a logo's pixel dimensions from its header (util/image-size.ts).
 *
 * This parses an ADMIN-UPLOADED file, so the hostile-input half matters as much as
 * the correctness half: a throw here would break every alert email, and a wrong
 * number would silently distort the logo — which is the bug this whole module
 * exists to fix.
 *
 * Real image files are used where the repo has them, rather than only bytes
 * synthesised from the same spec the parser was written against.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { imageSize } from '../src/util/image-size';

const REPO = path.join(__dirname, '..', '..', '..');
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Build a spec-valid PNG header with the given dimensions. */
function png(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  return Buffer.concat([PNG_SIG, ihdr]);
}

/** Build a minimal JPEG with an APPn segment before the SOF, to exercise the walk. */
function jpeg(w: number, h: number, marker = 0xc0): Buffer {
  const app = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Array(14).fill(0)]);
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xff00 | marker, 0);
  sof.writeUInt16BE(8, 2); // segment length
  sof.writeUInt8(8, 4); // precision
  sof.writeUInt16BE(h, 5); // height FIRST
  sof.writeUInt16BE(w, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app, sof]);
}

test('reads real PNG files shipped in this repo', () => {
  // The dashboard's own mark is 512x512 — the square shape whose distortion
  // ("stretched out to the sides") prompted this module.
  const mark = fs.readFileSync(path.join(REPO, 'packages', 'ui', 'src', 'assets', 'logo-mark.png'));
  assert.deepEqual(imageSize(mark, 'image/png'), { width: 512, height: 512 });
});

test('reads a real JPEG', () => {
  const p = path.join(REPO, 'node_modules', '@fastify', 'static', 'example', 'public', 'images', 'sample.jpg');
  if (!fs.existsSync(p)) return; // dependency layout changed; the synthetic cases still cover it
  assert.deepEqual(imageSize(fs.readFileSync(p), 'image/jpeg'), { width: 500, height: 500 });
});

test('reads non-square PNG dimensions in the right order', () => {
  // Transposed width/height is the classic silent bug — it distorts rather than fails.
  assert.deepEqual(imageSize(png(1200, 150), 'image/png'), { width: 1200, height: 150 });
  assert.deepEqual(imageSize(png(150, 1200), 'image/png'), { width: 150, height: 1200 });
});

test('reads JPEG dimensions, walking past APPn, for every SOF flavour', () => {
  // height comes BEFORE width in a SOF payload.
  assert.deepEqual(imageSize(jpeg(400, 100), 'image/jpeg'), { width: 400, height: 100 });
  for (const m of [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]) {
    assert.deepEqual(imageSize(jpeg(64, 32, m), 'image/jpeg'), { width: 64, height: 32 }, `SOF 0x${m.toString(16)}`);
  }
});

test('does NOT mistake a Huffman table for a frame header', () => {
  // 0xFFC4 (DHT), 0xFFC8 (JPG) and 0xFFCC (DAC) live in the same 0xFFCn space as
  // the SOF markers but carry no dimensions. Reading one yields garbage.
  for (const m of [0xc4, 0xc8, 0xcc]) {
    assert.equal(imageSize(jpeg(64, 32, m), 'image/jpeg'), null, `0x${m.toString(16)} must not parse`);
  }
});

test('reads all three WebP variants', () => {
  const riff = (kind: string, rest: Buffer) =>
    Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from(kind), rest]);
  // VP8 (lossy): 4-byte chunk size, 3-byte frame tag, 9D 01 2A sync, then 14-bit LE w/h.
  const lossy = Buffer.alloc(14);
  lossy.writeUInt8(0x9d, 7);
  lossy.writeUInt8(0x01, 8);
  lossy.writeUInt8(0x2a, 9);
  lossy.writeUInt16LE(300, 10);
  lossy.writeUInt16LE(120, 12);
  assert.deepEqual(imageSize(riff('VP8 ', lossy), 'image/webp'), { width: 300, height: 120 });

  // VP8L (lossless): 4-byte size, 0x2F signature, then (w-1) in bits 0..13 and
  // (h-1) in bits 14..27.
  const ll = Buffer.alloc(9);
  ll.writeUInt8(0x2f, 4);
  ll.writeUInt32LE((299 & 0x3fff) | ((119 & 0x3fff) << 14), 5);
  assert.deepEqual(imageSize(riff('VP8L', ll), 'image/webp'), { width: 300, height: 120 });

  // VP8X (extended): 4-byte size, 4 flag bytes, then canvas w-1 / h-1 as 24-bit LE.
  const x = Buffer.alloc(14);
  x.writeUIntLE(299, 8, 3);
  x.writeUIntLE(119, 11, 3);
  assert.deepEqual(imageSize(riff('VP8X', x), 'image/webp'), { width: 300, height: 120 });
});

test('a mislabelled MIME still reads correctly — magic bytes decide', () => {
  // An admin can upload a PNG named .jpg; we must not emit a wrong number.
  assert.deepEqual(imageSize(png(300, 100), 'image/jpeg'), { width: 300, height: 100 });
  assert.deepEqual(imageSize(jpeg(300, 100), 'image/png'), { width: 300, height: 100 });
});

test('every malformed or hostile input returns null, without throwing or hanging', () => {
  const cases: [string, Buffer][] = [
    ['empty', Buffer.alloc(0)],
    ['3 bytes', Buffer.from([1, 2, 3])],
    ['PNG signature only', PNG_SIG],
    ['PNG signature, no IHDR', Buffer.concat([PNG_SIG, Buffer.alloc(20)])],
    ['zero-dimension PNG', png(0, 0)],
    ['all 0xFF — JPEG marker-walk bait', Buffer.alloc(20_000, 0xff)],
    ['JPEG segment length 0', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00])],
    ['JPEG segment length 1', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01])],
    ['JPEG length past end', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0x00])],
    ['JPEG truncated SOF', Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08])],
    ['RIFF with a lying size', Buffer.concat([Buffer.from('RIFF'), Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from('WEBPVP8 ')])],
    ['WebP with unknown chunk', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPNOPE'), Buffer.alloc(20)])],
    ['random noise', Buffer.from(Array.from({ length: 8000 }, (_, i) => (i * 37) % 256))],
    ['an SVG (raster-only store, but be safe)', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
  ];
  for (const [name, buf] of cases) {
    const started = Date.now();
    let result: unknown;
    assert.doesNotThrow(() => {
      result = imageSize(buf, 'image/png');
    }, name);
    assert.equal(result, null, name);
    assert.ok(Date.now() - started < 500, `${name} took too long — possible unbounded walk`);
  }
});

test('a non-Buffer input is rejected rather than crashing', () => {
  // Defensive: this sits behind an upload path.
  for (const junk of [null, undefined, 'string', 42, {}, []]) {
    assert.equal(imageSize(junk as unknown as Buffer, 'image/png'), null, String(junk));
  }
});
