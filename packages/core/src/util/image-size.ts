// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Intrinsic pixel dimensions of a PNG / JPEG / WebP, read from its header bytes.
 *
 * Exists so an email can size the masjid logo with exact `width`/`height`
 * attributes: Outlook renders with Word's engine and ignores `max-width` /
 * `max-height`, so the only way to guarantee a logo is never distorted there is to
 * do the aspect-ratio maths ourselves. See notify/email.ts `logoTag`.
 *
 * No dependency on purpose — an image library is far too heavy for a Raspberry Pi
 * install (CLAUDE.md: lightweight is a core value) when all we need is a handful of
 * header fields.
 *
 * THE INPUT IS AN ADMIN-UPLOADED FILE, so this is written to be unbreakable rather
 * than clever: every read is bounds-checked first, the JPEG marker walk is capped,
 * and anything not confidently recognised returns null. It never throws.
 */

/** JPEG markers that carry a Start-Of-Frame header (width/height). Deliberately
 *  EXCLUDES the three 0xFFCn markers that are not frame headers: C4 = DHT
 *  (Huffman table), C8 = JPG (reserved), CC = DAC (arithmetic coding). */
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** Markers that stand alone with no length field. */
const STANDALONE = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9]);

export interface ImageSize {
  width: number;
  height: number;
}

function ok(size: ImageSize | null): ImageSize | null {
  if (!size) return null;
  // A zero or absurd dimension means we misparsed; refuse rather than emit it into
  // an <img> attribute.
  const { width: w, height: h } = size;
  if (!Number.isInteger(w) || !Number.isInteger(h)) return null;
  if (w < 1 || h < 1 || w > 100_000 || h > 100_000) return null;
  return size;
}

function pngSize(b: Buffer): ImageSize | null {
  // 8-byte signature, then a chunk: 4-byte length, 4-byte type "IHDR",
  // then width and height as 4-byte big-endian each.
  if (b.length < 24) return null;
  if (b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (b.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function jpegSize(b: Buffer): ImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  // Cap the walk: a crafted file must not be able to spin here.
  for (let guard = 0; guard < 10_000; guard++) {
    // Segments are separated by 0xFF; padding fill bytes are legal.
    while (i < b.length && b[i] !== 0xff) i++;
    while (i < b.length && b[i] === 0xff) i++;
    if (i >= b.length) return null;
    const marker = b[i]!;
    i++;
    if (STANDALONE.has(marker)) continue;
    // Every other segment carries a 2-byte big-endian length that INCLUDES itself.
    if (i + 2 > b.length) return null;
    const len = b.readUInt16BE(i);
    // A length under 2 is malformed and would make no forward progress.
    if (len < 2 || i + len > b.length) return null;
    if (SOF_MARKERS.has(marker)) {
      // Payload: 1 byte sample precision, 2 bytes height, 2 bytes width — height FIRST.
      if (i + 7 > b.length) return null;
      return { width: b.readUInt16BE(i + 5), height: b.readUInt16BE(i + 3) };
    }
    i += len;
  }
  return null;
}

function webpSize(b: Buffer): ImageSize | null {
  if (b.length < 16) return null;
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null;
  const kind = b.toString('latin1', 12, 16);
  if (kind === 'VP8 ') {
    // Lossy: 8-byte chunk header, 3-byte frame tag, 3-byte sync code (9D 01 2A),
    // then width and height as 14-bit little-endian values.
    if (b.length < 30) return null;
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (kind === 'VP8L') {
    // Lossless: 8-byte chunk header, 1-byte signature 0x2F, then 32 bits holding
    // (width-1) in bits 0..13 and (height-1) in bits 14..27.
    if (b.length < 25) return null;
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (kind === 'VP8X') {
    // Extended: 8-byte chunk header, 4 bytes of flags, then canvas width-1 and
    // height-1 as 24-bit little-endian each.
    if (b.length < 30) return null;
    const w = b[24]! | (b[25]! << 8) | (b[26]! << 16);
    const h = b[27]! | (b[28]! << 8) | (b[29]! << 16);
    return { width: w + 1, height: h + 1 };
  }
  return null;
}

/**
 * Pixel dimensions of an image buffer, or null when they cannot be determined.
 *
 * `mime` is only a hint for which parser to try first — the magic bytes decide, so
 * a mislabelled upload still reads correctly (or returns null) rather than
 * producing a wrong number.
 */
export function imageSize(buf: Buffer, mime?: string): ImageSize | null {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
  try {
    const m = (mime ?? '').toLowerCase();
    const order = m.includes('png')
      ? [pngSize, jpegSize, webpSize]
      : m.includes('webp')
        ? [webpSize, pngSize, jpegSize]
        : m.includes('jpe')
          ? [jpegSize, pngSize, webpSize]
          : [pngSize, jpegSize, webpSize];
    for (const parse of order) {
      const size = ok(parse(buf));
      if (size) return size;
    }
    return null;
  } catch {
    // Defence in depth: the bounds checks above should make this unreachable, but a
    // logo is untrusted input and a throw here would break every alert email.
    return null;
  }
}
