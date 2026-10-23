// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The QR grid behind the authenticator-app enrolment screen.
 *
 * BE HONEST ABOUT WHAT THIS PROVES. No test here decodes a QR code, because
 * writing a decoder to check an encoder is a second implementation with its own
 * bugs, and a wrong decoder fails a correct encoder. What these tests do is:
 *
 *   - check properties the QR SPEC fixes, independently of this library: where
 *     the finder patterns sit, how the timing patterns alternate, and which
 *     version the encoder must choose for a payload of a given length;
 *   - pin the exact output for a fixed input, so a dependency bump or a
 *     silently-changed error-correction level shows up as a failing test rather
 *     than as a code that scans on the laptop it was written on;
 *   - refuse input that would be encoded in the wrong charset.
 *
 * The acceptance test is a person pointing a real authenticator app at it. That
 * is listed in the slice notes, and nothing here replaces it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const req = createRequire(__filename);
const { qrMatrix, isDark } = req('../src/auth/qr') as typeof import('../src/auth/qr');
const { otpauthUri } = req('../src/auth/totp') as typeof import('../src/auth/totp');

/** A realistic payload: an email as the account name and a full 32-char secret. */
const URI =
  'otpauth://totp/OpenMasjidOS:admin@masjid.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=OpenMasjidOS&algorithm=SHA1&digits=6&period=30';

// ── the spec, not the library ──────────────────────────────────────────────

test('a QR grid is square, odd-sided, and a legal version', () => {
  const m = qrMatrix(URI);
  assert.equal(m.modules.length, m.size * m.size, 'the bit string must cover the grid exactly');
  assert.match(m.modules, /^[01]+$/);
  // Version v has 17 + 4v modules per side, v in 1..40.
  assert.equal((m.size - 17) % 4, 0, `${m.size} is not 17 + 4v for any v`);
  const version = (m.size - 17) / 4;
  assert.ok(version >= 1 && version <= 40, `version ${version} is out of range`);
});

test('the encoder picks the SMALLEST version that fits, at level L', () => {
  // Byte-mode data capacity at error-correction level L, versions 1..10. This is
  // published spec data, so it is an independent check of version selection —
  // not a number read back out of the library under test.
  const CAPACITY_L = [17, 32, 53, 78, 106, 134, 154, 192, 230, 271];
  for (const text of ['a', 'a'.repeat(17), 'a'.repeat(18), 'a'.repeat(106), 'a'.repeat(135), URI]) {
    const m = qrMatrix(text);
    const version = (m.size - 17) / 4;
    const expected = CAPACITY_L.findIndex((c) => c >= text.length) + 1;
    assert.equal(
      version,
      expected,
      `${text.length} bytes should fit version ${expected} at level L, got ${version}. ` +
        'If this fails after a dependency bump, check the error-correction level in auth/qr.ts ' +
        'has not changed — a denser grid is harder to scan on a phone.',
    );
  }
});

test('the three finder patterns are where the spec puts them', () => {
  // Top-left, top-right, bottom-left. Each is a 7x7: a dark ring, a light ring,
  // a 3x3 dark core. Nothing about this depends on the payload or the library.
  const m = qrMatrix(URI);
  const corners = [
    [0, 0],
    [0, m.size - 7],
    [m.size - 7, 0],
  ];
  for (const [r0, c0] of corners) {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const ring = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        assert.equal(
          isDark(m, r0! + r, c0! + c),
          ring || core,
          `finder at (${r0},${c0}) is wrong at offset (${r},${c})`,
        );
      }
    }
  }
});

test('the timing patterns alternate', () => {
  // Row 6 and column 6 carry alternating modules between the finders, dark on
  // even indices. A scanner uses these to work out the module pitch.
  const m = qrMatrix(URI);
  for (let i = 8; i < m.size - 8; i++) {
    assert.equal(isDark(m, 6, i), i % 2 === 0, `horizontal timing wrong at column ${i}`);
    assert.equal(isDark(m, i, 6), i % 2 === 0, `vertical timing wrong at row ${i}`);
  }
});

test('reading outside the grid is light, not an exception', () => {
  const m = qrMatrix('hello');
  assert.equal(isDark(m, -1, 0), false);
  assert.equal(isDark(m, 0, -1), false);
  assert.equal(isDark(m, m.size, 0), false);
  assert.equal(isDark(m, 0, m.size), false);
});

// ── pinned output ──────────────────────────────────────────────────────────

test('THE EXACT GRID FOR A FIXED INPUT IS PINNED', () => {
  // A QR that encodes the wrong thing looks exactly like one that encodes the
  // right thing. So the one input a human has actually scanned is pinned by
  // hash: a dependency bump, a changed error-correction level or a different
  // mask choice all move this, and all of them are things to look at rather
  // than to discover on someone's phone.
  const m = qrMatrix(URI);
  assert.equal(m.size, 45);
  assert.equal(
    crypto.createHash('sha256').update(m.modules).digest('hex'),
    'a4370f15a00903b8fe8182e077ba9f8a06be1766bdb2231a3f316bf847d84a1d',
    'the encoded grid changed. Scan it with a real authenticator app before updating this hash.',
  );
});

test('the payload actually reaches the grid', () => {
  // Weak on its own, but it catches the failure where a refactor encodes a
  // constant, or the secret is dropped from the URI.
  const a = qrMatrix(URI);
  const b = qrMatrix(URI.replace('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXQ'));
  assert.notEqual(a.modules, b.modules, 'two different secrets produced the same QR');
});

// ── the charset precondition ───────────────────────────────────────────────

test('NON-ASCII IS REFUSED RATHER THAN MIS-ENCODED', () => {
  // qrcode-generator's default byte conversion is the Shift_JIS one — UTF-8 is a
  // separate entry point in that package — so a non-ASCII character would encode
  // in the wrong charset and scan to mojibake. Throwing is the correct outcome:
  // every URI we pass comes from `otpauthUri`, which escapes, so a throw here
  // means that escaping has been removed.
  assert.throws(() => qrMatrix('masjid al-huda — admin'), /ASCII/);
  assert.throws(() => qrMatrix('مسجد'), /ASCII/);
  assert.throws(() => qrMatrix(''), /ASCII/);
});

test('every otpauth URI we generate satisfies that precondition', () => {
  // The contract the test above depends on: `otpauthUri` escapes its label with
  // encodeURIComponent and builds its query with URLSearchParams, so the result
  // is ASCII whatever the masjid called itself.
  const uri = otpauthUri({
    secretBase32: 'JBSWY3DPEHPK3PXP',
    account: 'مدير@مسجد.test',
    issuer: 'OpenMasjidOS — المسجد',
  });
  assert.match(uri, /^[\x20-\x7E]+$/, 'otpauthUri emitted a non-ASCII character');
  assert.doesNotThrow(() => qrMatrix(uri));
});
