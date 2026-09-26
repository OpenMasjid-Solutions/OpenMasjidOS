// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * A checkbox with a label beside it — the shape every tick in this product has.
 *
 * Six places rendered a raw `<input type="checkbox">` inside a `<label>` with
 * the flex layout repeated inline each time. A raw checkbox is natively
 * accessible, so this is not an accessibility fix; it is a CONSISTENCY one. The
 * browser default control ignores the theme entirely, so on a dark glass panel
 * it was a small grey-and-white box with a system blue tick — visibly not part
 * of the product, and different on every OS. Two of those six sit on the two
 * most consequential confirmations in the dashboard (delete an app's data, and
 * the WhatsApp delete-everything teardown).
 *
 * WHY THE TYPOGRAPHY IS OVERRIDDEN HERE. shadcn's `Label` ships
 * `text-sm leading-none font-medium`, which is wrong for these: our labels are
 * prose, not form captions, and several wrap to two or three lines where
 * `leading-none` reads as cramped. Overriding once in this wrapper is the point
 * of having a wrapper layer at all — the alternative was three utility
 * overrides repeated at six call sites, or forking the primitive.
 *
 * `align="start"` is for a label long enough to wrap, so the box lines up with
 * the first line rather than floating in the vertical middle of a paragraph.
 */
import { useId, type ReactNode } from 'react';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';

export function CheckboxField({
  id,
  checked,
  onChange,
  disabled,
  align = 'center',
  flush,
  children,
}: {
  /**
   * Optional. When omitted a unique one is generated, which is what most
   * callers should do: `AppReviewDialog` is rendered once PER APP CARD, so a
   * literal id there put the same `id`/`htmlFor` pair on screen as many times
   * as the masjid has apps. Only one is mounted at a time today — the dialog
   * renders nothing while closed — so it was latent rather than broken, but a
   * duplicate id makes `htmlFor` resolve to whichever came first in the DOM,
   * and that is not a thing to leave lying around in a consent dialog.
   */
  id?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  /** `start` when the label wraps; `center` for a single line. */
  align?: 'center' | 'start';
  /** No outer margin, for a field that already sits in a spaced container. */
  flush?: boolean;
  children: ReactNode;
}) {
  const auto = useId();
  const fieldId = id ?? auto;

  return (
    <div className="check-field" data-align={align} data-flush={flush ? '' : undefined}>
      <Checkbox
        id={fieldId}
        checked={checked}
        disabled={disabled}
        // Radix models a third, indeterminate state; none of our ticks use it,
        // so anything that is not exactly `true` is off.
        onCheckedChange={(next) => onChange(next === true)}
      />
      <Label htmlFor={fieldId} className="text-base leading-normal font-normal">
        {children}
      </Label>
    </div>
  );
}
