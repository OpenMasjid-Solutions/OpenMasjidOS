// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * How a phone number is written on screen.
 *
 * This is presentation, not validation — the server stays the authority on what is a
 * valid number — so what is worth pinning is the two ways presentation can actively
 * mislead a masjid:
 *
 *  1. **Digits going missing.** Every format here must be reversible: strip the spaces,
 *     brackets and dashes and you must get back exactly the digits that went in. A
 *     formatter that drops the eleventh digit of a mistyped number hides the mistake
 *     instead of showing it, and the number then fails at the gateway with no clue why.
 *  2. **The picker being unreadable.** The country `<select>` is a fixed-width box; the
 *     labels used to be full country names and were clipped mid-word. They are acronyms
 *     now, so this asserts they stay short enough to fit.
 *
 * Lives in the core's suite because that is the only suite that runs — `packages/ui` has
 * no test script — which is also why `lib/phone.ts` is deliberately React-free (importing
 * the component would drag React into a node:test run). Same arrangement as
 * `i18n-keys.test.ts` and `version-precedence.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const req = createRequire(__filename);
const phone = req(
  path.join(__dirname, '..', '..', 'ui', 'src', 'lib', 'phone.ts'),
) as typeof import('../../ui/src/lib/phone');
const { COUNTRIES, digitsOnly, splitPhone, group, formatPhone } = phone;

test('a US number is written the way North America writes it', () => {
  assert.equal(formatPhone('15550101234'), '+1 (555) 010-1234');
  // The shape asked for, spelled out: dial code, bracketed area code, then 3-4.
  assert.match(formatPhone('11231231234'), /^\+1 \(\d{3}\) \d{3}-\d{4}$/);
});

test('typing a US number formats progressively, and never moves digits already typed', () => {
  // A real keystroke sequence: one digit at a time, so each step IS a prefix of the next.
  const full = '1231231234';
  const steps = Array.from({ length: full.length }, (_, i) => full.slice(0, i + 1));
  const seen = steps.map((d) => group(d, '1'));
  assert.deepEqual(seen.slice(0, 4), ['1', '12', '123', '(123) 1']);
  assert.equal(seen[seen.length - 1], '(123) 123-1234');
  // The real property: at every keystroke the digits are still in the same order, and
  // each step only ever ADDS to the previous one's digits. Anything else means the
  // field is reflowing under the person's fingers.
  for (let i = 0; i < steps.length; i++) {
    assert.equal(digitsOnly(seen[i]!), steps[i], `step ${i + 1} must preserve its digits`);
    if (i > 0) assert.ok(digitsOnly(seen[i]!).startsWith(digitsOnly(seen[i - 1]!)));
  }
});

test('a number longer than the plan allows is shown, not silently truncated', () => {
  // NANP is exactly ten digits. An eleventh is a typo, and the person has to be able to
  // SEE it — a formatter that hides it turns a visible mistake into a failed send.
  assert.equal(digitsOnly(group('12312312345', '1')), '12312312345');
  assert.equal(digitsOnly(formatPhone('112312312345')), '112312312345');
});

test('every other country keeps the neutral grouping — no invented national formats', () => {
  assert.equal(formatPhone('447700900123'), '+44 770 090 0123');
  assert.equal(formatPhone('923001234567'), '+92 300 123 4567');
  assert.equal(formatPhone('966501234567'), '+966 501 234 567');
  // The trailing-single-digit merge that a masjid reported: never `... 123 4`.
  assert.doesNotMatch(formatPhone('447700900123'), /\s\d$/);
  assert.doesNotMatch(formatPhone('923001234567'), /\s\d$/);
});

test('FORMATTING IS REVERSIBLE: no format anywhere loses or invents a digit', () => {
  const samples = [
    '15550101234', '11231231234', '112312312345', '1', '15', '155',
    '447700900123', '4477009', '923001234567', '966501234567', '971501234567',
    '8801712345678', '9990001234', '0',
  ];
  for (const e164 of samples) {
    assert.equal(digitsOnly(formatPhone(e164)), e164, `formatPhone must preserve every digit of ${e164}`);
  }
});

test('an unknown dial code is shown plainly rather than grouped as a guess', () => {
  // `999` is not in the table. Inventing grouping for a number we cannot attribute to a
  // country is how a correct number starts looking wrong to the person checking it.
  const out = formatPhone('9990001');
  assert.equal(out, '+9990001');
  assert.equal(splitPhone('9990001').dial, '');
});

test('an empty number renders as nothing, never a lone +', () => {
  assert.equal(formatPhone(''), '');
  assert.equal(formatPhone('abc'), '');
});

test('the country picker labels stay short enough for a fixed-width box', () => {
  for (const c of COUNTRIES) {
    const shown = `${c.short ?? c.iso} (+${c.dial})`;
    // The select is 7.5rem. Names like "United Arab Emirates +971" were being clipped
    // mid-word, which reads as broken rather than as abbreviated.
    assert.ok(shown.length <= 12, `"${shown}" is too long for the picker`);
    assert.match(shown, /^[A-Z/]{2,5} \(\+\d{1,4}\)$/, `"${shown}" is not "XX (+N)" shaped`);
  }
});

test('the two countries whose acronym is not their ISO code are spelled as people write them', () => {
  const byIso = (iso: string) => COUNTRIES.find((c) => c.iso === iso);
  assert.equal(byIso('US')?.short, 'US/CA', '+1 is shared, so the label names both');
  assert.equal(byIso('GB')?.short, 'UK', 'ISO says GB; every British reader writes UK');
  // And the full name is still reachable, because the picker puts it in `title`.
  assert.ok(byIso('AE')?.name);
});

test('dial codes stay unambiguous: no two countries share one, longest still wins', () => {
  // Two options with the same `value` would make picking one snap the box to the other.
  const dials = COUNTRIES.map((c) => c.dial);
  assert.equal(new Set(dials).size, dials.length, 'a duplicate dial code breaks the picker');
  // `1876` (Jamaica) must not be read as `1` — the longest-prefix rule.
  assert.equal(splitPhone('447700900123').dial, '44');
  assert.equal(splitPhone('9665012345').dial, '966');
});
