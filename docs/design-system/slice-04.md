<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Slice 4 — the gallery, and the first three primitives

Ships in **`0.51.2-dev.3`**. First slice with something to look at: visit **`/design-system`**.

## What landed

- **`/design-system`** — every shared primitive rendered in **four panes at once**: dark/light
  × LTR/RTL. Lazy-loaded like every other non-Dashboard route, so it costs a masjid nothing.
- **Switch, Checkbox, Label** — the first shadcn primitives, exported from `@openmasjid/ui`.
- **`cn` is now shadcn's package**, with `lib/cn.ts` kept as a one-line swap seam;
  `clsx` and `tailwind-merge` were dropped (3 dependencies → 1).

## Three bugs the slice caught, and what each says

**1. The first primitive installed had an RTL bug.** shadcn's Switch moves its thumb with
`translate-x-[calc(100%-2px)]`, which is *physical*. In RTL the track mirrors — flex follows
`dir` — so the thumb starts at the right edge and a positive `translateX` walks it straight out
of the track. Nothing about that reads as wrong in the source.

Fixed by removing the two utilities from `components/ui/switch.tsx` and doing the travel in
`app.css`, keyed on `[dir]` — still a transform, so still compositor-cheap. The physical-utility
budget stays at **0**, so a future `shadcn add switch` that restores them **fails the build**
rather than silently undoing the fix. That is how a local edit to a generated file is kept safe.

**2. The gate that was supposed to catch it, didn't.** Tailwind variants prefix the utility
(`data-[state=checked]:translate-x-…`), and my regex only accepted whitespace or a quote before
a utility name. So it reported a clean zero on a file containing two physical translates. The
prefix set now includes `:`, and the list gained `translate-x`, `inset-x`, `space-x`, `divide-x`
and the `scroll-*` family. **A gate that cannot fire is worse than no gate** — this one was
proven by injecting the bug, not by reading it.

**3. `dark:` was pointing at the wrong thing entirely.** Tailwind's `dark:` variant means
`prefers-color-scheme` out of the box. We theme with `data-theme` on `<html>`. Left alone, every
shadcn component shipping a `dark:` utility — the Switch does — would follow the **operating
system** and ignore the choice made in Settings: a masjid on a light laptop who picks Dark would
get light switches on a dark dashboard.

`@custom-variant dark` in `index.css` now maps it to `:root:not([data-theme="light"])`, mirroring
`tokens.css` exactly. Verified in the built CSS:
`.dark\:bg-input\/30:where(:root:not([data-theme=light]), …)`. It is pinned by a gate, because
deleting it is a silent whole-product regression.

## On `cn`

The CLI writes `import { cn } from "cn"` into every generated component and no longer honours
`aliases.utils`, so the package is on the critical path whether we use it or not. Keeping our
own `clsx` + `tailwind-merge` beside it would mean two class-merging implementations that could
disagree, avoidable only by hand-editing every primitive — the one thing that must stay
re-runnable. So `cn` is the implementation, and it bundles compiled equivalents of both
(486 KB unpacked against their combined 1,147 KB), which also suits a Pi.

`lib/cn.ts` stays as the **seam**: six modules and the public `index.ts` import from there, so
swapping back — `cn` is still 0.3.x — is one line rather than an edit everywhere. The gate that
used to grep for `twMerge(clsx(...))` is now **behavioural**: `cn('px-4','px-2')` must yield
`px-2`. A gate that breaks when you swap an implementation was testing the implementation, not
the guarantee.

## What to test

**Go to `/design-system`.** Four panes, and the same controls in each.

1. **Switch, RTL panes.** Toggle it on. The thumb must move to the **left** (the inline end in
   RTL) and stay inside the track. If it slides out of the track, the fix regressed.
2. **Switch, LTR panes.** Thumb moves right, inside the track. Normal.
3. **The light panes must be light** — pale background, dark text — even though the dashboard
   around them is dark. That proves `dark:` is following `data-theme` and not your laptop.
   Then set your OS to light mode and reload: the dark panes must **stay dark**.
4. **Checkbox** — the tick must be visible in both themes. Labels click through to their control.
5. **Everything else in the app is unchanged.** No existing screen uses these yet.

```
Settings → Advanced           should read 0.51.2-dev.3
wsl -d Ubuntu -e bash -lc 'bash ~/omos-sync.sh && cd ~/omos && npm run test'   → 639 pass
```

**Verification:** lint clean · build clean · 639/639 · three mutations checked (regenerated
switch, a `hover:` physical utility, and removal of the dark variant each fail the suite).
