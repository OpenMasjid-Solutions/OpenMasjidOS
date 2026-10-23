// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * TOTP (RFC 6238) over HOTP (RFC 4226), plus the RFC 4648 base32 an authenticator
 * app expects in an `otpauth://` URI.
 *
 * Hand-written rather than pulled from npm, and that is a deliberate call for
 * this one case: the whole algorithm is ~40 lines of `crypto.createHmac` and a
 * dynamic truncation, it has PUBLISHED TEST VECTORS (RFC 6238 Appendix B) so
 * correctness is provable rather than assumed, and a second-factor library is
 * about the worst place to take a transitive-dependency surface on a daemon that
 * runs as root with the Docker socket. `test/totp.test.ts` runs the published
 * vectors for SHA-1, SHA-256 and SHA-512.
 *
 * SHA-1 is the default and that is correct here, not laziness: RFC 6238 specifies
 * it, every authenticator app implements it, and several implement nothing else.
 * Its collision weakness does not apply to HMAC.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO: it does not remember anything. Replay
 * prevention needs state (the last counter accepted), and state belongs with the
 * store, not with the maths — see `auth/twofactor.ts`. A verifier that cannot
 * refuse a code it has already seen is not a second factor, it is a password
 * with a 30-second lifetime.
 */
import crypto from 'node:crypto';

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

/** Seconds per code. 30 is the universal default; changing it breaks every app. */
export const TOTP_STEP_SECONDS = 30;
/** Code length. 6 is what every authenticator shows. */
export const TOTP_DIGITS = 6;

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, unpadded — the spelling `otpauth://` URIs use. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Decode base32, tolerantly: padding, lowercase and the spaces authenticator
 * apps put in a displayed secret are all accepted, because an admin typing the
 * key in by hand will reproduce what they were shown, spaces and all. Anything
 * that is not a base32 character after that is a real error and throws.
 */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (!clean) throw new Error('Empty secret.');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`Not a valid key character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit secret — the size RFC 4226 recommends for HMAC-SHA1. */
export function generateSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

/**
 * HOTP (RFC 4226 §5.3): HMAC the 8-byte big-endian counter, then dynamic
 * truncation — take the low nibble of the last byte as an offset, read 4 bytes
 * there, clear the sign bit, and take the low `digits` decimal places.
 */
export function hotp(
  secret: Buffer,
  counter: number,
  digits = TOTP_DIGITS,
  algorithm: TotpAlgorithm = 'sha1',
): string {
  const buf = Buffer.alloc(8);
  // `counter` exceeds 32 bits well before it matters (year 6000-odd at a 30s
  // step), but writing it as a BigInt costs nothing and removes the question.
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac(algorithm, secret).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** Which 30-second step a unix-seconds timestamp falls in. */
export function totpCounter(unixSeconds: number, step = TOTP_STEP_SECONDS): number {
  return Math.floor(unixSeconds / step);
}

/** The code for a given moment. `nowMs` is injectable so tests are not timing-dependent. */
export function totp(
  secretBase32: string,
  nowMs: number = Date.now(),
  opts: { digits?: number; step?: number; algorithm?: TotpAlgorithm } = {},
): string {
  const { digits = TOTP_DIGITS, step = TOTP_STEP_SECONDS, algorithm = 'sha1' } = opts;
  return hotp(base32Decode(secretBase32), totpCounter(Math.floor(nowMs / 1000), step), digits, algorithm);
}

/**
 * Check a code, returning the COUNTER it matched (so the caller can refuse a
 * replay) or null.
 *
 * `window` is how many steps either side are accepted — 1 means the previous,
 * current and next code, i.e. roughly ±30s of clock skew. That is the usual
 * setting and it is a real trade-off: a wider window is kinder to a phone whose
 * clock has drifted and proportionally more generous to someone guessing.
 *
 * The comparison is constant-time. A length check first, because
 * `timingSafeEqual` throws on a length mismatch and the length of a submitted
 * code is not a secret.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  nowMs: number = Date.now(),
  opts: { digits?: number; step?: number; algorithm?: TotpAlgorithm; window?: number } = {},
): number | null {
  const { digits = TOTP_DIGITS, step = TOTP_STEP_SECONDS, algorithm = 'sha1', window = 1 } = opts;
  const submitted = code.replace(/\s/g, '');
  if (!/^\d+$/.test(submitted) || submitted.length !== digits) return null;

  const secret = base32Decode(secretBase32);
  const current = totpCounter(Math.floor(nowMs / 1000), step);
  for (let drift = -window; drift <= window; drift++) {
    const counter = current + drift;
    if (counter < 0) continue;
    const expected = hotp(secret, counter, digits, algorithm);
    if (timingSafeEqualString(expected, submitted)) return counter;
  }
  return null;
}

/** Constant-time string compare that tolerates a length mismatch. */
export function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * The `otpauth://` URI an authenticator app scans or accepts pasted.
 *
 * `issuer` appears twice by design — as a label prefix and as a parameter —
 * because apps disagree about which they read, and an entry that says only
 * "admin" is useless on a phone that holds a dozen of them.
 */
export function otpauthUri(opts: {
  secretBase32: string;
  account: string;
  issuer: string;
  digits?: number;
  step?: number;
  algorithm?: TotpAlgorithm;
}): string {
  const { secretBase32, account, issuer, digits = TOTP_DIGITS, step = TOTP_STEP_SECONDS, algorithm = 'sha1' } = opts;
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: algorithm.toUpperCase(),
    digits: String(digits),
    period: String(step),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * How far out this server's clock would have to be for `code` to be the right
 * one, in 30-second steps — or null if the code is simply wrong.
 *
 * A DIAGNOSTIC, NEVER AN ACCEPTANCE PATH. It searches a much wider window than
 * `verifyTotp` accepts and reports what it finds; the code is still refused.
 * The distinction matters enough to say twice: nothing may call this to decide
 * whether someone gets in.
 *
 * It exists because a wrong clock and a wrong code are indistinguishable to the
 * person typing, and they have opposite fixes. An admin whose server drifted
 * three minutes sees "that code is not right" five times, burns their sign-in
 * attempt, and has no reason to suspect the one thing that would explain it.
 * The HTTP `Date` header already states this server's clock to anyone who asks,
 * so reporting the offset discloses nothing new.
 */
export function clockSkewSteps(
  secretBase32: string,
  code: string,
  nowMs: number = Date.now(),
  maxSteps = 40, // ±20 minutes: wide enough for a real drift, cheap enough to run on a failure
): number | null {
  const matched = verifyTotp(secretBase32, code, nowMs, { window: maxSteps });
  if (matched === null) return null;
  const current = Math.floor(Math.floor(nowMs / 1000) / TOTP_STEP_SECONDS);
  return matched - current;
}
