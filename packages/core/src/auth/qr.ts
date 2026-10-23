// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * QR encoding for the enrolment screen — the `otpauth://` URI as a module grid.
 *
 * WHY THIS IS ON THE SERVER. Three reasons, in order of how much they mattered:
 *
 *  1. It is testable here. `packages/ui` has no test runner (every UI-shaped test
 *     in this repo lives in the core's suite and reads the UI's source as text),
 *     so an encoder in the browser bundle could not be checked at all. A QR that
 *     encodes the wrong string looks exactly like one that encodes the right one.
 *  2. `@openmasjid/ui` is a design system other apps in the fleet consume. A QR
 *     encoder is not a design system, and putting it there would make every app
 *     carry it.
 *  3. The result is DATA, not markup — a grid of bits. The UI draws it as one
 *     SVG path, so nothing is injected as HTML and there is no
 *     `dangerouslySetInnerHTML` anywhere near the sign-in flow.
 *
 * WHY A DEPENDENCY. QR is Reed-Solomon plus a mask chosen by penalty score, and
 * the failure mode of getting the mask wrong is the worst kind: the code scans
 * on the machine you wrote it on and not on the admin's phone. `qrcode-generator`
 * is MIT, has no dependencies of its own, and ships its own types.
 */
import qrcode from 'qrcode-generator';

/**
 * Error correction level 'L'.
 *
 * L is the lowest, and that is the right choice for a code rendered on a screen
 * and scanned once, from ~20cm, with nothing to damage it. The redundancy that M
 * and Q buy pays for print smudges and torn labels; here it only makes the grid
 * denser, and a denser grid is HARDER to scan on a phone. For a realistic URI
 * (an email as the account name, a 32-character secret) this is the difference
 * between a 49-module code and a 61-module one.
 */
const EC_LEVEL = 'L' as const;

export interface QrMatrix {
  /** Modules per side. Always odd, 21…177. Excludes the quiet zone. */
  size: number;
  /** Row-major, one character per module, '1' = dark. Length is size × size. */
  modules: string;
}

/**
 * Encode `text` as a QR module grid.
 *
 * ASCII ONLY, enforced rather than assumed. `qrcode-generator`'s default
 * string-to-bytes conversion is the Shift_JIS one — UTF-8 is a separate entry
 * point in that package — so a non-ASCII character would be silently encoded in
 * the wrong charset and produce a QR that scans to mojibake. Every URI we pass
 * here comes from `otpauthUri`, which builds its query with `URLSearchParams`
 * and its label with `encodeURIComponent`, so the output is ASCII by
 * construction. This turns that construction into a checked precondition: if
 * someone later changes `otpauthUri` to stop escaping, this throws instead of
 * shipping a QR nobody can scan.
 */
export function qrMatrix(text: string): QrMatrix {
  if (!/^[\x20-\x7E]+$/.test(text)) {
    throw new Error('qrMatrix: only printable ASCII can be encoded safely here (see the note above).');
  }
  const qr = qrcode(0, EC_LEVEL); // 0 = pick the smallest version that fits
  qr.addData(text); // byte mode, the default
  qr.make();

  const size = qr.getModuleCount();
  let modules = '';
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) modules += qr.isDark(row, col) ? '1' : '0';
  }
  return { size, modules };
}

/** Read one module out of a matrix. Bounds-checked; outside the grid is light. */
export function isDark(m: QrMatrix, row: number, col: number): boolean {
  if (row < 0 || col < 0 || row >= m.size || col >= m.size) return false;
  return m.modules[row * m.size + col] === '1';
}
