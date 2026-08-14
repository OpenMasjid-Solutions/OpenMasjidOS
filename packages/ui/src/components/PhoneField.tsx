// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * A phone number field that removes the "what format?" question entirely.
 *
 * A plain text box asking for an international number is a guessing game: `+1 555…`,
 * `001555…`, `1-555-…` and `555…` all look reasonable, three of them are wrong, and the
 * one thing the platform must never do is guess a missing country code — that would send
 * a masjid's fee reminder to a stranger who owns that number somewhere else.
 *
 * So the country is a CHOICE, not something typed: pick it from the list, type the rest
 * of the number as it would be written locally, and the component produces the E.164
 * digits the gateway wants. Pasting a full `+44 7700 900123` still works — the country is
 * detected from the prefix and the field splits itself.
 *
 * No phone-number library. libphonenumber is ~150 KB gzipped for validation depth this
 * does not need, and Pi-friendliness is a stated value (CLAUDE.md §6). Dial codes are a
 * static table; grouping is cosmetic.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

/** Dial codes, longest-prefix-first at lookup time so +1876 beats +1. */
interface Country {
  iso: string;
  name: string;
  dial: string;
  /** Shown instead of `name` where one dial code covers several countries. */
  label?: string;
}

// Not exhaustive — the countries a masjid using this is realistically in, plus the whole
// of the Gulf, South Asia, Southeast Asia and Africa where the platform is likeliest to
// land. "Other" below lets any number be entered in full.
const COUNTRIES: Country[] = [
  // One entry, because they share a dial code: two options with the same `value` would
  // make picking Canada snap the box back to "United States".
  { iso: 'US', name: 'United States', dial: '1', label: 'United States / Canada' },
  { iso: 'GB', name: 'United Kingdom', dial: '44' },
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
const DEFAULT_DIAL = '1';

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

/**
 * Cosmetic grouping so a long string of digits stays readable while being typed.
 *
 * Threes from the left, EXCEPT that a trailing single digit joins the group before it.
 * That exception is the whole point: plain threes wrote a US number as `555 010 123 4`,
 * putting a space after the ninth digit and stranding the last one — which is exactly
 * what a masjid reported. Merging gives `555 010 1234`.
 *
 * Deliberately not a per-country pattern. A neutral rule is wrong in a boring way; a
 * table of national formats is wrong in a confident way, and it would need maintaining
 * for every country a masjid might be in. Purely presentation — `value` is always bare
 * digits, and the server is the authority on what is valid.
 *
 * Grouping from the left also keeps the digits still as they are typed: anchoring the
 * last four instead reflows every group on each keystroke.
 */
function group(national: string): string {
  const d = digitsOnly(national);
  if (d.length <= 4) return d;
  const chunks = d.match(/.{1,3}/g) ?? [];
  if (chunks.length > 1 && chunks[chunks.length - 1]!.length === 1) {
    chunks[chunks.length - 2] += chunks.pop();
  }
  return chunks.join(' ');
}

interface PhoneFieldProps {
  /** E.164 digits, no `+`. Empty string when unset. */
  value: string;
  onChange: (e164: string) => void;
  label?: string;
  hint?: string;
  id?: string;
  disabled?: boolean;
}

export function PhoneField({ value, onChange, label, hint, id, disabled }: PhoneFieldProps) {
  const { t } = useTranslation();
  const split = useMemo(() => splitPhone(value), [value]);
  // An empty field starts on +1 rather than "choose a country", so the common case is
  // type-and-go. A number already stored under a dial code that is not in the list falls
  // to "Other", where the whole number is typed — defaulting THAT to +1 would silently
  // rewrite someone's saved number.
  const dial = split.dial || (digitsOnly(value) ? '' : DEFAULT_DIAL);
  const national = split.national;

  function setDial(next: string) {
    onChange(next ? `${next}${digitsOnly(national)}` : digitsOnly(national));
  }

  function setNational(raw: string) {
    const typed = digitsOnly(raw);
    // A pasted full international number (with or without +) should just work rather
    // than being appended to the selected country's code.
    if (raw.trim().startsWith('+')) {
      const split = splitPhone(typed);
      if (split.dial) return onChange(typed);
    }
    onChange(`${dial}${typed}`);
  }

  return (
    <div className="field" style={{ maxWidth: '22rem' }}>
      {label && (
        <label className="label" htmlFor={id}>
          {label}
        </label>
      )}
      <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
        <select
          className="input glass-inset"
          style={{ inlineSize: '9.5rem', flex: '0 0 auto' }}
          value={dial}
          disabled={disabled}
          onChange={(e) => setDial(e.target.value)}
          aria-label={t('settings.phoneCountry')}
        >
          {/* No "choose a country" placeholder: one is always selected, so there is never
              a state where typing produces a number with no country code. "Other" is the
              escape hatch for a country not listed — then the code is typed too. */}
          {COUNTRIES.map((c) => (
            <option key={c.iso} value={c.dial}>
              {c.label ?? c.name} +{c.dial}
            </option>
          ))}
          <option value="">{t('settings.phoneCountryOther')}</option>
        </select>
        <input
          id={id}
          className="input glass-inset"
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          // The dial code is shown as a prefix rather than typed, so there is exactly one
          // place a country code can come from.
          style={{ flex: '1 1 auto', minInlineSize: '8rem' }}
          disabled={disabled}
          value={group(national)}
          onChange={(e) => setNational(e.target.value)}
          placeholder={t('settings.phoneNumberPlaceholder')}
        />
      </div>
      <span className="hint">{dial ? (hint ?? t('settings.phoneHint')) : t('settings.phoneHintOther')}</span>
    </div>
  );
}
