// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * TOTP, checked against the PUBLISHED vectors rather than against itself.
 *
 * This is the whole argument for hand-writing the algorithm instead of taking a
 * dependency: RFC 6238 Appendix B and RFC 4226 Appendix D both ship known
 * answers, so "is our implementation correct" is a question with a citable
 * answer. A second factor that is subtly wrong fails in the worst possible
 * way — it looks like it works, because our generator and our verifier agree
 * with each other, and then a real authenticator app disagrees with both.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  base32Decode,
  base32Encode,
  generateSecret,
  hotp,
  otpauthUri,
  timingSafeEqualString,
  totp,
  verifyTotp,
} from '../src/auth/totp';

// RFC 6238 uses the ASCII seed "12345678901234567890", extended for the wider
// hashes. Our API speaks base32, so encode them once here.
const SEED_SHA1 = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
const SEED_SHA256 = base32Encode(Buffer.from('12345678901234567890123456789012', 'ascii'));
const SEED_SHA512 = base32Encode(
  Buffer.from('1234567890123456789012345678901234567890123456789012345678901234', 'ascii'),
);

test('RFC 4226 Appendix D — the HOTP vectors', () => {
  const secret = Buffer.from('12345678901234567890', 'ascii');
  const expected = [
    '755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489',
  ];
  expected.forEach((code, counter) => {
    assert.equal(hotp(secret, counter), code, `counter ${counter}`);
  });
});

test('RFC 6238 Appendix B — the TOTP vectors, all three hashes', () => {
  // [unix seconds, sha1, sha256, sha512] — 8 digits, as the RFC tabulates them.
  const vectors: Array<[number, string, string, string]> = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  for (const [seconds, sha1, sha256, sha512] of vectors) {
    const at = seconds * 1000;
    assert.equal(totp(SEED_SHA1, at, { digits: 8, algorithm: 'sha1' }), sha1, `sha1 @ ${seconds}`);
    assert.equal(totp(SEED_SHA256, at, { digits: 8, algorithm: 'sha256' }), sha256, `sha256 @ ${seconds}`);
    assert.equal(totp(SEED_SHA512, at, { digits: 8, algorithm: 'sha512' }), sha512, `sha512 @ ${seconds}`);
  }
});

test('base32 round-trips, and tolerates how a human retypes a key', () => {
  for (let n = 1; n <= 40; n++) {
    const bytes = Buffer.alloc(n, n);
    assert.deepEqual(base32Decode(base32Encode(bytes)), bytes, `${n} bytes`);
  }
  // An authenticator shows the key in spaced groups and some apps lowercase it;
  // an admin typing it back reproduces what they saw.
  const secret = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
  const spaced = secret.replace(/(.{4})/g, '$1 ').trim().toLowerCase();
  assert.deepEqual(base32Decode(spaced), base32Decode(secret));
  assert.deepEqual(base32Decode(`${secret}======`), base32Decode(secret));
  assert.throws(() => base32Decode('has!punctuation'), /valid key character/);
  assert.throws(() => base32Decode('   '), /Empty secret/);
});

test('a generated secret is 160 bits, and every one is different', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const s = generateSecret();
    assert.equal(base32Decode(s).length, 20, 'RFC 4226 recommends 160-bit secrets');
    assert.ok(!seen.has(s), 'secrets must not repeat');
    seen.add(s);
  }
});

// ── verification ───────────────────────────────────────────────────────────

test('verify accepts the current code and returns the counter it matched', () => {
  const now = 1_700_000_000_000;
  const code = totp(SEED_SHA1, now);
  const counter = verifyTotp(SEED_SHA1, code, now);
  assert.equal(counter, Math.floor(now / 1000 / 30), 'must report WHICH step matched');
});

test('verify accepts one step of drift either way, and nothing beyond it', () => {
  const now = 1_700_000_000_000;
  const step = 30_000;
  // A phone 30s fast or slow still works.
  assert.ok(verifyTotp(SEED_SHA1, totp(SEED_SHA1, now - step), now) !== null, 'previous step');
  assert.ok(verifyTotp(SEED_SHA1, totp(SEED_SHA1, now + step), now) !== null, 'next step');
  // Two steps out does not. This is the bound on how long a shoulder-surfed or
  // phished code stays usable, so it is worth pinning rather than leaving to a default.
  assert.equal(verifyTotp(SEED_SHA1, totp(SEED_SHA1, now - 2 * step), now), null, 'two steps back');
  assert.equal(verifyTotp(SEED_SHA1, totp(SEED_SHA1, now + 2 * step), now), null, 'two steps forward');
});

test('verify refuses anything that is not a code of the right shape', () => {
  const now = 1_700_000_000_000;
  for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56', '+12345', '12345a', '  ']) {
    assert.equal(verifyTotp(SEED_SHA1, bad, now), null, JSON.stringify(bad));
  }
  // A correct code with surrounding whitespace IS accepted — people paste.
  assert.ok(verifyTotp(SEED_SHA1, ` ${totp(SEED_SHA1, now)} `, now) !== null);
});

test('the comparison is length-safe as well as constant-time', () => {
  // timingSafeEqual throws on a length mismatch, and the length of a submitted
  // code is not a secret — so it is checked first rather than allowed to throw.
  assert.equal(timingSafeEqualString('123456', '1234567'), false);
  assert.equal(timingSafeEqualString('123456', ''), false);
  assert.equal(timingSafeEqualString('123456', '123456'), true);
  assert.equal(timingSafeEqualString('123456', '123457'), false);
});

test('the otpauth URI carries the issuer twice, because apps disagree', () => {
  const uri = otpauthUri({ secretBase32: SEED_SHA1, account: 'admin', issuer: 'OpenMasjidOS' });
  assert.match(uri, /^otpauth:\/\/totp\/OpenMasjidOS:admin\?/, 'label prefix');
  const q = new URLSearchParams(uri.split('?')[1]);
  assert.equal(q.get('issuer'), 'OpenMasjidOS', 'and the parameter');
  assert.equal(q.get('secret'), SEED_SHA1);
  assert.equal(q.get('algorithm'), 'SHA1');
  assert.equal(q.get('digits'), '6');
  assert.equal(q.get('period'), '30');
});

test('a masjid name with a space or a colon does not corrupt the URI', () => {
  // A colon is the label separator, so an unencoded one silently reassigns the
  // issuer and the account — the entry then shows up on the phone under the
  // wrong name, or not at all.
  const uri = otpauthUri({ secretBase32: SEED_SHA1, account: 'admin@masjid', issuer: 'Green Lane: Masjid' });
  const label = uri.slice('otpauth://totp/'.length).split('?')[0]!;

  // The separator must be the ONLY raw colon: an unencoded one in the issuer
  // silently reassigns which half is which, and the entry shows up on the phone
  // under the wrong name or not at all.
  assert.equal(label.split(':').length, 2, 'exactly one separator colon survives encoding');

  const [issuerPart, accountPart] = label.split(':');
  assert.equal(decodeURIComponent(issuerPart!), 'Green Lane: Masjid');
  assert.equal(decodeURIComponent(accountPart!), 'admin@masjid');
});
