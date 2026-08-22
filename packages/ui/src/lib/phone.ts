// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Phone numbers: the country table, and turning digits into something a human reads.
 *
 * Pure — no React, no i18n — for two reasons. It is used both by the input
 * (`components/PhoneField.tsx`) and by every place the dashboard shows a number BACK to
 * the admin, so it does not belong to the component. And `packages/ui` has no test
 * runner of its own, so the only way this logic gets covered is a core test importing
 * it (`packages/core/test/phone-format.test.ts`) — which a module pulling in React
 * could not offer.
 *
 * No phone-number library. libphonenumber is ~150 KB gzipped for validation depth this
 * does not need, and Pi-friendliness is a stated value (CLAUDE.md §6). Dial codes are a
 * static table; grouping is cosmetic. The SERVER stays the authority on what is valid —
 * nothing here rejects a number, it only makes one readable.
 */

/** Dial codes, longest-prefix-first at lookup time so +1876 beats +1. */
export interface Country {
  iso: string;
  name: string;
  dial: string;
  /** Shown instead of `name` where one dial code covers several countries. */
  label?: string;
  /**
   * What the closed picker shows, e.g. `US/CA`. Defaults to `iso`, which is already the
   * two-letter acronym for every country here bar two.
   *
   * The picker used to render the full name (`United States / Canada +1`) inside a fixed
   * 9.5rem box, so every longer country was clipped mid-word — and a control that looks
   * broken is worse than one that is merely terse. The acronym plus the dial code is the
   * part that identifies the country anyway; the full name stays as the option's `title`.
   */
  short?: string;
}

// Not exhaustive — the countries a masjid using this is realistically in, plus the whole
// of the Gulf, South Asia, Southeast Asia and Africa where the platform is likeliest to
// land. "Other" in the picker lets any number be entered in full.
export const COUNTRIES: Country[] = [
  // One entry, because they share a dial code: two options with the same `value` would
  // make picking Canada snap the box back to "United States".
  { iso: 'US', name: 'United States', dial: '1', label: 'United States / Canada', short: 'US/CA' },
  // ISO says GB; every British reader writes UK, and this label is read, not parsed.
  { iso: 'GB', name: 'United Kingdom', dial: '44', short: 'UK' },
  { iso: 'IE', name: 'Ireland', dial: '353' },
  { iso: 'AU', name: 'Australia', dial: '61' },
  { iso: 'NZ', name: 'New Zealand', dial: '64' },
  { iso: 'ZA', name: 'South Africa', dial: '27' },
  { iso: 'NG', name: 'Nigeria', dial: '234' },
  { iso: 'KE', name: 'Kenya', dial: '254' },
  { iso: 'TZ', name: 'Tanzania', dial: '255' },
  { iso: 'EG', name: 'Egypt', dial: '20' },
  { iso: 'MA', name: 'Morocco', dial: '212' },
  { iso: 'DZ', name: 'Algeria', dial: '213' },
  { iso: 'TN', name: 'Tunisia', dial: '216' },
  { iso: 'SA', name: 'Saudi Arabia', dial: '966' },
  { iso: 'AE', name: 'United Arab Emirates', dial: '971' },
  { iso: 'QA', name: 'Qatar', dial: '974' },
  { iso: 'KW', name: 'Kuwait', dial: '965' },
  { iso: 'BH', name: 'Bahrain', dial: '973' },
  { iso: 'OM', name: 'Oman', dial: '968' },
  { iso: 'JO', name: 'Jordan', dial: '962' },
  { iso: 'LB', name: 'Lebanon', dial: '961' },
  { iso: 'TR', name: 'Türkiye', dial: '90' },
  { iso: 'PK', name: 'Pakistan', dial: '92' },
  { iso: 'IN', name: 'India', dial: '91' },
  { iso: 'BD', name: 'Bangladesh', dial: '880' },
  { iso: 'LK', name: 'Sri Lanka', dial: '94' },
  { iso: 'MY', name: 'Malaysia', dial: '60' },
  { iso: 'ID', name: 'Indonesia', dial: '62' },
  { iso: 'SG', name: 'Singapore', dial: '65' },
  { iso: 'FR', name: 'France', dial: '33' },
  { iso: 'DE', name: 'Germany', dial: '49' },
  { iso: 'NL', name: 'Netherlands', dial: '31' },
  { iso: 'BE', name: 'Belgium', dial: '32' },
  { iso: 'ES', name: 'Spain', dial: '34' },
  { iso: 'IT', name: 'Italy', dial: '39' },
  { iso: 'SE', name: 'Sweden', dial: '46' },
  { iso: 'NO', name: 'Norway', dial: '47' },
  { iso: 'DK', name: 'Denmark', dial: '45' },
];

/** Longest dial code first, so `1876` (Jamaica) is not read as `1` (US). */
const BY_LENGTH = [...COUNTRIES].sort((a, b) => b.dial.length - a.dial.length);

/** Where an empty field starts. */
export const DEFAULT_DIAL = '1';

export function digitsOnly(s: string): string {
  return String(s ?? '').replace(/[^0-9]/g, '');
}

/**
 * Split stored E.164 digits into a country and the rest.
 *
 * Ambiguity is real (`1` is both the US and Canada) and it does not matter: the pair only
 * has to re-join to the same digits, and both pick the same dial code.
 */
export function splitPhone(e164: string): { dial: string; national: string } {
  const d = digitsOnly(e164);
  if (!d) return { dial: '', national: '' };
  const hit = BY_LENGTH.find((c) => d.startsWith(c.dial));
  return hit ? { dial: hit.dial, national: d.slice(hit.dial.length) } : { dial: '', national: d };
}

/** The one dial code with a national format worth special-casing. See `group`. */
const NANP_DIAL = '1';

/**
 * `(555) 010-1234` — the North American Numbering Plan, and the ONE exception to the
 * neutral rule below.
 *
 * It earns the exception because it is not really a "national format" at all: +1 is a
 * single shared plan across the US, Canada and the Caribbean, it is always exactly ten
 * digits, and it has exactly one written shape that every reader of it recognises. So
 * there is nothing to get wrong and nothing to maintain — the two failure modes the
 * neutral rule exists to avoid.
 *
 * Formats progressively while typing, and always from the left, so digits already on
 * screen never move: the only reflow is the parenthesis appearing at the fourth digit.
 * Anything past the tenth digit is appended rather than hidden — a number that is too
 * long is a mistake the person needs to SEE, not one the field should quietly swallow.
 */
function groupNanp(d: string): string {
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  const rest = d.length > 10 ? ` ${d.slice(10)}` : '';
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6, 10)}${rest}`;
}

/**
 * Cosmetic grouping so a long string of digits stays readable while being typed.
 *
 * Threes from the left, EXCEPT that a trailing single digit joins the group before it.
 * That exception is the whole point: plain threes wrote a US number as `555 010 123 4`,
 * putting a space after the ninth digit and stranding the last one — which is exactly
 * what a masjid reported. Merging gives `555 010 1234`.
 *
 * Still deliberately not a table of national formats, for everything except +1. A neutral
 * rule is wrong in a boring way; a table is wrong in a confident way, and it would need
 * maintaining for every country a masjid might be in. `groupNanp` above is the single
 * carve-out and says why it is safe. Purely presentation either way — the stored value is
 * always bare digits, and the server is the authority on what is valid.
 *
 * Grouping from the left also keeps the digits still as they are typed: anchoring the
 * last four instead reflows every group on each keystroke.
 */
export function group(national: string, dial?: string): string {
  const d = digitsOnly(national);
  if (dial === NANP_DIAL) return groupNanp(d);
  if (d.length <= 4) return d;
  const chunks = d.match(/.{1,3}/g) ?? [];
  if (chunks.length > 1 && chunks[chunks.length - 1]!.length === 1) {
    chunks[chunks.length - 2] += chunks.pop();
  }
  return chunks.join(' ');
}

/**
 * Stored E.164 digits as a human reads them: `+1 (555) 010-1234`, `+44 7700 900123`.
 *
 * For DISPLAY only — anywhere the platform shows back a number it holds, rather than one
 * being typed. A bare `+15550101234` is a string a volunteer has to decode digit by digit
 * to check it is the right phone, and the place that matters most is the panel telling
 * them which number their masjid is now sending from.
 *
 * Falls back to a bare `+digits` for a dial code not in the table, because inventing
 * grouping for a number we cannot attribute to a country is how a correct number starts
 * looking wrong. An empty input gives an empty string, never a lone `+`.
 */
export function formatPhone(e164: string): string {
  const d = digitsOnly(e164);
  if (!d) return '';
  const { dial, national } = splitPhone(d);
  if (!dial) return `+${d}`;
  return `+${dial} ${group(national, dial)}`.trimEnd();
}
