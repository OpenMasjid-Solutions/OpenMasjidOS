<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Slice 5 — DropdownMenu, and both real menus migrated

Ships in **`0.51.2-dev.4`**. First slice that changes something a masjid actually uses.

## The plan changed, on evidence

Slice 5 was going to be **Select, Popover, Tooltip**. Surveying what the dashboard actually
does said otherwise:

- **5 native `<select>` elements** (Settings, Store, PhoneField). Native selects are already
  accessible and give a proper picker on touch devices — which matters on Kiosk and Display
  hardware. Replacing them with a Radix Select would be a **downgrade**, so they stay.
- **0 tooltips.** Nothing to replace.
- **2 hand-rolled dropdown menus** — `ProfileMenu` and `AppCard`'s ⋮ — both with real
  accessibility gaps.

The reduced scope says add a primitive *only where it fixes something real*, so the slice
became DropdownMenu and nothing else.

## What was actually broken

`ProfileMenu` declared `role="menu"` on a `<div>` whose children were ordinary `<button>`s with
no `role="menuitem"` — **an ARIA menu with no items, which reads worse to a screen reader than
claiming nothing at all.** Both menus additionally had:

- no arrow-key movement between items
- no Escape to close
- no `aria-expanded` / `aria-haspopup` on the trigger
- **no focus return** — a keyboard user who opened a menu was left with focus on the page body
- dismissal via a `document.addEventListener('click')`, which does not fire on focus leaving

Radix supplies all of it, plus typeahead and collision-aware placement, and mirrors correctly
in RTL.

## Three problems found while migrating

**1. The generated component had 11 physical utilities** — `pl-8`, `pr-2`, `left-2`, `ml-auto`.
Every one direction-sensitive: `left-2` positions the checkmark, `ml-auto` pushes the shortcut
text, `pl-8` is the item indent. In Arabic all three land on the wrong side. Converted to
`ps-8`, `pe-2`, `start-2`, `ms-auto`. The gate found them; it is the second primitive in a row
to ship with RTL bugs.

**2. The card's `z-index: 200` would have hidden the menu behind the card.** The old menu was a
*descendant* of the card, so the card was lifted above the dock to stop the dock covering it.
Radix portals the content to the document root, where shadcn gives it `z-50` — so the lifted
card (200) would have painted **over** its own menu. The lift is removed (nothing inside the
card needs it any more) and portalled menus are explicitly layered at `z-index: 300`, above the
dock (50), the modal (250) and the window manager (260), so a dropdown opened from inside a
Settings window works too.

**3. `contentVisibility: 'visible'` is gone.** It existed because `content-visibility: auto` on
the card clipped a menu overflowing the card's box. With the menu portalled there is nothing
left to clip, so the workaround and the `menuOpen` state that drove it both went — along with
the hand-rolled click-outside effect and its `useRef`.

## What to test

**The two menus are the whole slice.** Both should feel the same and behave better.

1. **App card ⋮ menu.** Open it on a card near the **bottom** of the grid, over the dock — the
   menu must appear *above* the dock, not behind it. Open one on the last row and check it
   flips upward rather than running off screen.
2. **Clicking a menu item must not launch the app.** The card itself is clickable; picking
   Restart or View logs must do only that.
3. **Keyboard.** Tab to the ⋮ button, press Enter or ↓. Arrow keys move between items, Escape
   closes, and **focus returns to the ⋮ button** — that last part is new.
4. **Account menu (top right).** Same checks. Dark/light toggle, What's new, Settings, Sign out
   all still work, and the version still shows at the bottom.
5. **`/design-system`** — the DropdownMenu row. In the **RTL** panes, open the menu: the
   destructive item's alignment and any indent must sit on the right-hand (inline-start) side.
6. **Drag-to-pin still works** — drag a card onto the dock. The refactor touched the card's
   styling, so this is worth one check.

```
Settings → Advanced    →  0.51.2-dev.4
wsl -d Ubuntu -e bash -lc 'bash ~/omos-sync.sh && cd ~/omos && npm run test'   → 639 pass
```

**Verification:** lint clean · build clean · 639/639 · two mutations checked (restoring the
physical utilities, and adding a primitive without recording it in the manifest).

**Known cosmetic risk:** the menus now carry both `glass-raised` and shadcn's `bg-popover`.
`app.css` loads after Tailwind so the glass treatment wins, and the two should look identical
to before — but this is the thing most worth a second glance.
