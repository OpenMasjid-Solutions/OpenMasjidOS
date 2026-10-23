<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Slice 8 — full test and bugcheck of Slices 1–7

Ships in **`0.51.2-dev.7`**. No new primitives. This slice audits what the previous seven
landed, and it found four real defects — three of them mine, one of them a latent hazard.

## 1. Focus restore silently did nothing (Slice 6)

The worst of the four, and exactly the failure mode this project keeps naming: code that reads
correctly and does nothing.

`Modal` captured the element to refocus in a `useEffect`. **React flushes effects bottom-up, and
Radix's `FocusScope` is a descendant** — so by the time that effect ran, the focus trap had
already moved focus into the dialog, and we captured an element *inside* it. Restoring that on
close is `.focus()` on a detached node.

So the "focus returns to the button you opened it from" claim in Slice 6's notes was **false**.
The capture now happens during render, on the `false → true` transition, before the DOM is
touched. Confirmed against the Radix source: `onCloseAutoFocus` is wired to
`onUnmountAutoFocus`, and Radix's own handler (`triggerRef.current?.focus()`) is correctly
skipped because ours calls `preventDefault` first.

Two things the same source read **confirmed were right**: `trapFocus: context.open` and
`disableOutsidePointerEvents: context.open` are tied to `open` rather than mount, and
`hideOthers` runs in a `[]`-deps effect — so the `{open && …}` gate around `forceMount` really
was load-bearing, not caution.

## 2. A duplicate DOM id in a consent dialog (Slice 7)

`AppReviewDialog` is rendered **once per app card**, so `id="app-review-ack"` put the same
`id`/`htmlFor` pair on screen as many times as the masjid has apps. Latent rather than broken —
only one dialog is mounted at a time — but a duplicate id makes `htmlFor` resolve to whichever
came first in the DOM, and that is not a thing to leave in a dialog whose entire job is
recording consent. `CheckboxField`'s `id` is now optional and defaults to `useId()`.

## 3. A spacing regression I introduced (Slice 7)

`.check-field` applied a 1rem block margin to all six checkboxes. Three of the six had it
inline before; **two had none** (the share-online ticks in the App Store and the 3rd-party
installer, which sit in an already-spaced panel). They now pass `flush`.

## 4. Bundle size — the number, honestly

Nobody had measured this since Radix arrived. The entry chunk had gone from
**184 kB / 58.65 kB gzipped** to **307.75 kB / 102.50 kB** — a 75% increase on a project whose
core value is running on a Raspberry Pi.

Tree-shaking **is** working (Accordion, Slider, Tabs, Tooltip, Popover, Toast are all absent
from the build), so that is genuinely what Switch, Checkbox, Label, DropdownMenu and Dialog
cost: their shared focus-scope / dismissable-layer / presence / portal machinery.

Radix is now its own manual chunk, so it is cached across app-code changes:

| | before Radix | after | now |
|---|---:|---:|---:|
| entry chunk (gzip) | 58.65 kB | 102.50 kB | **71.26 kB** |
| radix chunk (gzip) | — | — | **32.88 kB** |

Net cost of five primitives: **~45 kB gzipped**, and no longer re-downloaded on every deploy.

## 5. It boots — verified for the first time

The handoff document has carried "❓ does `npm run dev` / the image actually run?" as **LOW
confidence, never verified** since before this work started. It does:

```
/api/health   → {"status":"ok","version":"0.51.2-dev.6"}
https://…/    → HTTP 200, <title>OpenMasjidOS</title>, <div id="root">
boot log      → no errors; TLS cert generated; all monitors started
```

## 6. Test hygiene — a mess I left behind

Booting it surfaced `Recovered orphaned app from Docker: held-app`. `held-app` is a fixture id
from `app-review-gate.test.ts`, and its container had been **running nginx in WSL Docker for
seven days** — created on 18 Sep when a mutation run disabled the start guard and `startApp`
went on to really call `compose up`.

Removed, along with five stray `/tmp/omos-*` directories. **The test suite itself is clean** —
in the unmutated code every one of those calls throws before reaching `composeUp`. It is the
*mutation procedure* that has side effects, which is worth knowing before the next one.

One container left deliberately: `omos-donations-app-1`, created 2026-07-31 with a working dir
of `/data/apps/donations` — not a test fixture and not mine, so not mine to delete. Worth a
look if you do not recognise it.

## What to test

1. **Focus restore, now that it works.** Tab to any button that opens a dialog (app card ⋯ →
   Remove), press Enter, then Escape. The focus ring must come back **to that button**. This is
   the one behaviour Slice 6 claimed and did not deliver.
2. **Checkbox spacing** in the App Store install dialog and 3rd Party App — the share-online
   tick should sit snug in its panel, not pushed 1rem away.
3. **Everything else unchanged** — the dialogs, menus, toggles and checkboxes from Slices 5–7.

```
Settings → Advanced    →  0.51.2-dev.7
wsl -d Ubuntu -e bash -lc 'bash ~/omos-sync.sh && cd ~/omos && npm run test'   → 644 pass
```

**Verification:** lint clean · build clean · **644/644** · boots and serves · two new gates,
both mutation-checked.

## Still outstanding

- **The cross-repo migration has not started**, and it is the remaining value: the other six
  repos each carry a *copy* of this CSS, so none of the AA contrast fix, the focus trap or the
  Toggle RTL fix has reached them. It needs a distribution decision first (publish
  `@openmasjid/ui` to GitHub Packages, or vendor it) — publishing is outward-facing, so it
  waits for an explicit go-ahead.
- The two fixes deferred from Slice 6, still deferred and still each worth its own commit:
  hoisting `Dashboard`'s `<UpdateModal>` out of the route element, and the missing
  `!disable.isPending` guard on the WhatsApp delete-everything dialog.
