<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Slice 6 — Modal on Radix Dialog

Ships in **`0.51.2-dev.5`**. Three commits. The riskiest slice, and the one an adversarial
review changed most.

## Shape of the change

`Modal.tsx`'s **internals** were rewritten; its prop surface, its visuals and its animation are
unchanged. All **25 rendered dialog instances** — 15 `<Modal>` literals, four of which are
wrapper components (`ConfirmDialog`, `AppReviewDialog`, `RestoreModal`, `UpdateModal`) covering
the rest — migrated with **zero call-site edits**.

Migrating "a safe subset first" was considered and rejected: they all resolve to one component,
so a subset means two dialog implementations alive at once — two Escape mechanisms, two entries
in the `openModals` contract, two answers to what a locked dialog does. Risk is staged by
commit order instead.

## What we actually gained

**A focus trap — which here is a security control, not an accessibility nicety.** Nothing in
this UI trapped focus before (three `autoFocus` hits, zero `tabIndex`, zero `inert`). So while
the **locked** update dialog was up, `Tab` walked straight out to the Dock's `NavLink`, and
`Enter` changed route — unmounting the page and taking the locked dialog with it, **mid core
update**. The mouse was blocked by the backdrop; the keyboard was not. That is the bug `locked`
exists to prevent, reachable by keyboard the whole time.

Also: focus now returns to whatever opened the dialog, Escape and outside-click are Radix's,
and the background is properly inert.

## The three things the review caught that I had wrong

**1. `modal={false}` would have shipped the bug it looks like it avoids.** It is the obvious way
to keep our own backdrop, and it silently deletes the focus trap *and* renders no overlay. A
test now refuses the prop outright. The lock is expressed as controlled `open` plus
`preventDefault` on `onEscapeKeyDown` and `onInteractOutside`.

**2. The counter test only checked the increment.** `audit-hardening`'s "one Escape closes one
thing" asserted `openModals += 1` and said nothing about the decrement — so an implementation
that increments and never decrements passed green. That is the quiet failure: `anyModalOpen()`
stays true for the life of the page, **Escape stops closing windows for ever**, the X still
works so nobody reports it, and a wall-mounted dashboard runs for weeks. Both directions are
pinned now, and the assertion was added *before* the rewrite, while the old code still satisfied
it.

**3. My `/design-system` comment stated a falsehood as proven.** It claimed a `data-theme` on
each pane made everything resolve per pane. Tokens do — `tokens.css` scopes to `[data-theme]`.
But `@custom-variant dark` reads `:root`, i.e. `<html>`, so a light pane still had `dark:`
utilities switched **on**; and portalled content renders at `document.body`, outside every
pane's `dir` and `data-theme` entirely. The comment is corrected, the menus are passed an
explicit `dir`, and the page gained root-level theme/direction toggles — which are the real
mechanism, and therefore the only honest way to test it.

## Smaller corrections

- `createPortal` → `DialogPortal`. Same guarantee (document.body); the test is re-pinned, and
  now also refuses a `container` prop, which would put dialogs back inside the transformed
  route wrapper and reintroduce the off-centre clipping bug.
- The panel is a **child** of the backdrop, not a sibling: `.modal-backdrop` is
  `display: grid; place-items: center`, so shadcn's `top-[50%] left-[50%] translate-x/y-[-50%]`
  was **deleted** rather than converted — there is no logical `translate-x`, and the centring
  was already free and direction-neutral.
- shadcn's `dialog.tsx` imports a `Button` component that does not exist here; it would have
  broken the build. Removed along with the unused `DialogFooter` close affordance.
- `animate-in` / `zoom-in-95` dropped (no plugin installed, so they compile to nothing).
  Motion still drives the spring and the blur, unchanged.
- A `DialogTitle` is always rendered, visually hidden when `title` is absent — Radix's warning
  provider is a no-op in this version, so a titleless dialog would ship unlabelled with no
  feedback. All 15 current call sites pass a title; this is for the next one that does not.

## What to test

The dialogs are everywhere, so this is the slice most worth a real pass.

1. **The locked update dialog is the important one.** Settings → Advanced → check for updates,
   and start one. Then: press **Escape** (nothing), click the **backdrop** (nothing), confirm
   there is **no X**. Now press **Tab** ten or fifteen times — focus must stay inside the
   dialog and must **never reach the dock**. Before this slice it escaped on the first few.
2. **Escape closes one thing.** Open a log or terminal window, then open any dialog on top of
   it. One Escape must close **only the dialog**. Then press Escape again — now the window
   closes. If the second press does nothing ever again, the counter is over-counting.
3. **Focus return.** Tab to a button that opens a dialog, press Enter, close with Escape — the
   focus ring must come back to that button.
4. **Ordinary dialogs still behave.** App card → ⋯ → Remove: the "also delete data" tick must
   be **cleared** when you close and reopen. Settings → restore a backup: the dialog must
   survive clicking a different Settings section mid-upload.
5. **Visuals unchanged.** The spring entrance and the blurred exit should look exactly as
   before. Any hard cut is a bug in this slice.
6. **`/design-system`** now has "Open dialog" and "Open LOCKED dialog", plus root theme and
   direction toggles. Use the toggles to check `dark:` behaviour properly — the panes alone
   cannot show it.

```
Settings → Advanced    →  0.51.2-dev.5
wsl -d Ubuntu -e bash -lc 'bash ~/omos-sync.sh && cd ~/omos && npm run test'   → 641 pass
```

**Verification:** lint clean · build clean · 641/641 · eleven mutations checked across the
three commits, including one that must *not* fire (a correctly side-paired slide utility stays
allowed).

## Deliberately not in this slice

- Hoisting `Dashboard.tsx`'s `<UpdateModal>` out of the route element. With the focus trap in
  place the keyboard route to unmounting it is closed, so this is now a tidy-up rather than a
  fix — it belongs in its own commit.
- Adding the missing `!disable.isPending` guard to the WhatsApp delete-everything dialog
  (`Settings.tsx`), the one destructive dialog whose `onClose` has no pending check while a
  load-bearing ordered teardown runs behind it. Unrelated to the migration; its own commit.
