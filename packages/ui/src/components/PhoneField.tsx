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
 * The country table and the digit grouping live in `lib/phone.ts`: they are shared with
 * every place the dashboard shows a number back to the admin, and being React-free is
 * what lets a core test cover them (`packages/ui` has no test runner of its own).
 */
import { useId, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { COUNTRIES, DEFAULT_DIAL, digitsOnly, group, splitPhone } from '../lib/phone';

interface PhoneFieldProps {
  /** E.164 digits, no `+`. Empty string when unset. */
  value: string;
  onChange: (e164: string) => void;
  label?: string;
  hint?: string;
  id?: string;
  disabled?: boolean;
  /**
   * Rendered on the same row as the inputs — for an action that belongs to the number,
   * like "Get a code".
   *
   * A slot rather than the caller placing a sibling button: the field is a label, a row
   * of inputs AND a hint, so a button flexed alongside the whole field lines up with the
   * bottom of the hint text and floats visibly below the inputs. Inside the row it sits
   * where it belongs, whatever the hint says.
   */
  trailing?: ReactNode;
}

export function PhoneField({ value, onChange, label, hint, id, disabled, trailing }: PhoneFieldProps) {
  const { t } = useTranslation();
  // A label must point at its box; without an id from the caller it pointed at nothing.
  const autoId = useId();
  const inputId = id ?? autoId;
  const split = useMemo(() => splitPhone(value), [value]);
  // "Other" chosen on purpose. It has to be remembered: on an empty field the choice
  // left nothing in the value to tell it apart from "nothing chosen", so the list
  // snapped straight back to +1. While it holds, the whole number is typed here, code
  // and all, even when its first digits happen to match a listed country.
  const [other, setOther] = useState(false);
  // An empty field starts on +1 rather than "choose a country", so the common case is
  // type-and-go. A number already stored under a dial code that is not in the list falls
  // to "Other", where the whole number is typed — defaulting THAT to +1 would silently
  // rewrite someone's saved number.
  const dial = other ? '' : split.dial || (digitsOnly(value) ? '' : DEFAULT_DIAL);
  const national = other ? digitsOnly(value) : split.national;

  function setDial(next: string) {
    setOther(next === '');
    onChange(next ? `${next}${digitsOnly(national)}` : digitsOnly(national));
  }

  function setNational(raw: string) {
    const typed = digitsOnly(raw);
    // A number typed or pasted with its "+" carries its own country code, so it is kept
    // as it is — listed country or not. Putting the selected code in front of a
    // +256 number made it a number in another country.
    if (raw.trim().startsWith('+')) {
      setOther(!splitPhone(typed).dial);
      return onChange(typed);
    }
    onChange(`${dial}${typed}`);
  }

  return (
    // Wider when it carries an action, so the button is not squeezed against the number.
    <div className="field" style={{ maxWidth: trailing ? '34rem' : '22rem' }}>
      {label && (
        <label className="label" htmlFor={inputId}>
          {label}
        </label>
      )}
      <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
        <select
          className="input glass-inset"
          // Sized to its own content, NOT to a number someone picked by eye. A fixed
          // width was wrong twice here — 9.5rem clipped the old full country names, and
          // the 7.5rem that replaced it still clipped `US/CA (+1)` once the dropdown
          // arrow and the input's padding took their share. Guessing a third number
          // would only have moved the guess: the arrow's width and the input padding are
          // the browser's business, not something this file can know. `auto` asks it to
          // fit the widest option, which is the actual requirement; the floor stops the
          // control collapsing if the list is ever trimmed to short labels.
          style={{ inlineSize: 'auto', minInlineSize: '9rem', flex: '0 0 auto' }}
          value={dial}
          disabled={disabled}
          onChange={(e) => setDial(e.target.value)}
          aria-label={t('settings.phoneCountry')}
        >
          {/* No "choose a country" placeholder: one is always selected, so there is never
              a state where typing produces a number with no country code. "Other" is the
              escape hatch for a country not listed — then the code is typed too. */}
          {COUNTRIES.map((c) => (
            // `title` keeps the full name reachable on hover, so shortening the visible
            // label costs nothing for a country whose acronym someone does not know.
            <option key={c.iso} value={c.dial} title={c.label ?? c.name}>
              {c.short ?? c.iso} (+{c.dial})
            </option>
          ))}
          <option value="">{t('settings.phoneCountryOther')}</option>
        </select>
        <input
          id={inputId}
          className="input glass-inset"
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          // The dial code is shown as a prefix rather than typed, so there is exactly one
          // place a country code can come from.
          style={{ flex: '1 1 auto', minInlineSize: '8rem' }}
          disabled={disabled}
          value={group(national, dial)}
          onChange={(e) => setNational(e.target.value)}
          placeholder={t('settings.phoneNumberPlaceholder')}
        />
        {trailing}
      </div>
      <span className="hint">{dial ? (hint ?? t('settings.phoneHint')) : t('settings.phoneHintOther')}</span>
    </div>
  );
}
