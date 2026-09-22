<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Slice 7 — an RTL bug in our own code, and giving the primitives real consumers

Ships in **`0.51.2-dev.6`**.

## The Command palette was dropped, and why

Slice 7 was going to be a ⌘K command palette. Checked against the reduced scope — *replace
hand-rolled controls with accessible ones, and stop the seven-copies drift* — it earns nothing:
it is a **new feature**, not a fix, and the audience is a masjid volunteer rather than a power
user. Building it would have been adding surface area while the plan's own rationale said not to.

Looking for what did earn the slice turned up something better.

## The real find: our own `Toggle` is broken in RTL

`.toggle::after` positions the thumb with `inset-inline-start` — logical, correct. But
`.toggle.is-on::after` moved it with `transform: translateX(1.2rem)` — **physical**. In Arabic
or Urdu the thumb starts at the inline end (the right edge) and translating right again walks it
**straight out of the track**.

That is the same bug shadcn's Switch arrived with in Slice 4, sitting in our own component, used
**17 times** across Settings and the app page. Fixed with a `[dir="rtl"]` counterpart, kept as a
transform so it stays on the compositor.

**And my CSS gate never looked at `transform`.** It checks `left:`, `margin-left` and friends, so
this reported a clean zero while being straightforwardly wrong. The gate now requires every
inline-axis `translateX` to have a `[dir="rtl"]` counterpart, with `±50%` exempt because
self-centring is symmetric. It found a second case immediately: the primary button's specular
sweep, which now runs with the reading direction (and mirrors its gradient, `115deg` → `245deg`,
so the bright leading edge stays at the front of the travel).

**The gate had a bug of its own**, found while fixing this: a global regex requiring a `}` before
each selector consumed the brace that ended the previous rule, so it only ever saw **alternate**
rules — and duly reported one of the two `.btn--primary` sweeps while missing the other. It parses
by splitting on `}` now, which cannot skip a rule.

## Giving Switch, Checkbox and Label honest consumers

I should be straight about this: the three primitives added in Slice 4 had **no consumer in the
product** — only the gallery. That is the inert-code pattern I have been flagging elsewhere.

- **Checkbox and Label now do.** Six places rendered a raw `<input type="checkbox">` inside a
  `<label>` with the flex layout repeated inline. A raw checkbox is natively accessible, so this
  is a **consistency** fix, not an accessibility one: the browser default ignores the theme
  entirely, so on a dark glass panel it was a grey-and-white box with a system-blue tick, and
  different on every OS. Two of the six are the most consequential confirmations in the
  dashboard — delete an app's data, and the WhatsApp delete-everything teardown.
  They now go through one wrapper, `CheckboxField`, the first entry in the manifest's `wrappers`.
- **Switch still does not.** `Toggle` already has `role="switch"`, `aria-checked`, `aria-label`
  and native button keyboard handling, so migrating 17 call sites to Radix Switch would be churn
  with regression risk and **no accessibility gain**. Fixing `Toggle`'s actual bug was worth far
  more than replacing it. Switch stays exported for the other apps, which have their own
  bespoke toggles — Slice 8 either adopts it there or retires it.

`CheckboxField` overrides shadcn's `Label` typography in one place (`text-sm leading-none
font-medium` → base size, normal weight and leading). Our labels are prose, not form captions,
and several wrap to two or three lines where `leading-none` reads as cramped. Overriding once in
a wrapper is the point of having a wrapper layer; the alternative was three utility overrides at
six call sites, or forking the primitive.

## What to test

1. **Toggles in RTL — the actual fix.** `/design-system` → "Flip root direction", then go to
   **Settings**. Turn any switch on: the thumb must move to the **left** and stay **inside** the
   track. Before this it slid out of the track entirely. Then flip back and confirm LTR is
   unchanged.
2. **The six checkboxes.** They should now look like part of the product — themed box, themed
   tick — rather than a browser default:
   - App card → ⋯ → Remove → *"Also delete this app's data"*
   - A held app → Start anyway → the acknowledgement tick
   - Settings → WhatsApp → turn off → *"also delete everything"*
   - App Store → install an app that asks to be shared online
   - 3rd Party App → the share-online tick, and the risk acknowledgement
   In each: clicking the **label text** must still toggle the box, and the tick must be visible
   in both themes.
3. **The remove dialog still clears its tick** on close and reopen. That behaviour predates this
   slice and the wrapper must not have lost it.
4. **Primary buttons** — hover one. The light sweep should look as before in LTR, and run
   right-to-left in RTL.

```
Settings → Advanced    →  0.51.2-dev.6
wsl -d Ubuntu -e bash -lc 'bash ~/omos-sync.sh && cd ~/omos && npm run test'   → 642 pass
```

**Verification:** lint clean · build clean · 642/642 · three mutations checked, including one
that must *not* fire (`translateX(-50%)` self-centring stays allowed).

## Revised remaining plan

| # | Slice | Status |
|---|---|---|
| 7 | Toggle RTL fix + Checkbox/Label consumers | ✅ `dev.6` |
| 8 | Publish the package and migrate the other apps | ⬜ |

Slice 8 is the one with the real remaining value: the other six repos each carry a **copy** of
this CSS, and a fix here does not reach them. That is the problem worth solving, and it is why
the Command palette lost its place.
