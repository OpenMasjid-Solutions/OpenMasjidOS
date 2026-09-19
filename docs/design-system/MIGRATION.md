<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Design-system migration log

OpenMasjidOS is the reference implementation. Every other app inherits the same package, theme
and primitives — see [CONSUMING.md](./CONSUMING.md).

15 slices. Each lands on `dev` on its own, with what changed and what to test. Nothing reaches
`master` until the whole set is done and Hasan says so.

| # | Slice | Status |
|---|---|---|
| 1 | Foundation — shadcn init, `cn()`, CI gates | ✅ done |
| 2 | `theme.css` — tokens mapped to Tailwind v4 `@theme` | ✅ done |
| 3 | `@openmasjid/ui` package contract + `ui-manifest.json` | ⬜ |
| 4 | `/design-system` gallery — light+dark, LTR+RTL | ⬜ |
| 5 | Primitives A — Button, Card, Input, Label | ⬜ |
| 6 | Primitives B — Dialog, Dropdown, Tooltip, Popover | ⬜ |
| 7 | Primitives C — Select, Checkbox, Switch, Textarea, RadioGroup | ⬜ |
| 8 | Data — Table, Badge, Skeleton, Separator, ScrollArea | ⬜ |
| 9 | Feedback — Toast, Alert, Progress | ⬜ |
| 10 | Navigation — Tabs, Breadcrumb, Command (⌘K) | ⬜ |
| 11 | Motion vocabulary | ⬜ |
| 12 | Migrate Dashboard + AppCard + Dock | ⬜ |
| 13 | Migrate Settings part 1 | ⬜ |
| 14 | Migrate Settings part 2 + Store/AppDetail/Files | ⬜ |
| 15 | Auth/first-run, dead-code sweep, downstream docs | ⬜ |

---

## Slice 1 — Foundation and gates

**Shipped.** Additive only: nothing that renders today was touched, so there is no visual
change and no behaviour change.

**Added**
- `tailwind-merge@3.7.0` and `class-variance-authority@0.7.1` to `packages/ui` — the two
  packages every shadcn component assumes. ~8 KB gzipped combined.
- `packages/ui/components.json` — the shadcn CLI contract. `style: new-york`, `rsc: false`
  (this is a Vite SPA), `tailwind.config: ""` (v4 keeps the theme in CSS), and
  `aliases.utils: "@/lib/cn"` because our helper is `lib/cn.ts`, not shadcn's default
  `lib/utils.ts`.
- `@/*` → `./src/*` in **both** `tsconfig.json` and `vite.config.ts`.
- `packages/core/test/ui-design-gates.test.ts` — 8 gates, registered in
  `packages/core/package.json`.
- `docs/design-system/README.md`, this file, and `CONSUMING.md`.

**Changed**
- `packages/ui/src/lib/cn.ts` now wraps `clsx` in `twMerge`. This is the only behavioural
  change in the slice, and it cannot affect current rendering because no Tailwind utility
  classes are in use yet — `twMerge` passes unrecognised class names through untouched.

**Not changed:** no component, no route, no style, no tRPC procedure, no schema.

**Gates, and why they are first.** The audit found this codebase is already near
RTL-correct — 35 logical direction properties against 4 physical, and **zero** physical
Tailwind utilities. Tailwind's defaults are physical and so is every shadcn example, so the
realistic failure mode is RTL regressing one component at a time until someone opens the
dashboard in Arabic. Putting the gates in before the first component is the whole point of
making this Slice 1.

All 5 ratchets mutation-checked: a physical utility, a physical CSS property, a raw hex, a new
`@keyframes` and an alias drift were each introduced and each failed the suite, then reverted.

**Two things found while building it**
- The font-stack budget was wrong on the first pass (2, actually 3 — the third is
  `app.css:1067`). The ratchet caught my own miscount, which is the argument for ratchets.
- `~/omos-sync.sh` copies a fixed file list that did not include `components.json` or
  `vite.config.ts`, so two gates read missing files in WSL while passing on Windows. The
  script now copies both. **Any gate reading a new config file must be paired with a sync-list
  entry** — otherwise it is a guard that cannot fire.

**Verification:** `npm run lint` clean · `npm run build` clean · **629/629** tests pass in WSL
(621 before + 8 gates).

### What to test

Nothing should look or behave differently. The check is that it doesn't.

1. `npm run dev`, open the dashboard. Confirm it is visually **identical** — same colours,
   spacing, fonts, dock, windows. Any difference is a bug in this slice.
2. Toggle dark/light in Settings → Appearance and change the accent. Both should behave
   exactly as before.
3. `npm run lint` → clean. `npm run build` → clean.
4. WSL: `wsl -d Ubuntu -e bash -lc 'bash ~/omos-sync.sh && cd ~/omos && npm run test'`
   → 629 pass, 0 fail.
5. *Optional, to see the gates work:* add `className="ml-4"` to any component and re-run the
   suite — `no physical-direction Tailwind utilities, ever` should fail. Revert.

---

## Slice 2 — Theme bridge

**Shipped.** One deliberate visual change (below); everything else is inert until the first
shadcn component lands in Slice 5.

**How it works.** shadcn components are written against fixed semantic names (`bg-background`,
`text-muted-foreground`, `border-input`, `ring-ring`) that are not configurable per component.
Rather than rename 62 tokens and 1,711 lines of CSS, a **bridge** in `styles/tokens.css` maps
those names onto the tokens we already have, and `@theme inline` in `index.css` maps Tailwind's
utility namespace onto the bridge.

```
Tailwind utility        @theme inline (index.css)     bridge (tokens.css)     token (tokens.css)
.bg-card            ->  --color-card: var(--card)  -> --card: var(--color-surface-raised) -> #0A1828
```

- **No colour value appears in `index.css`.** Every entry is a `var()` indirection, so
  `tokens.css` stays the single source of truth and the "colours live in tokens.css" gate holds.
- **`@theme inline` is load-bearing.** Plain `@theme` bakes the value into the utility at build
  time, which would freeze the theme: light mode would stop switching and a user-chosen accent
  could never reach a shadcn component. Verified against the built CSS — every utility emits
  `var(--token)`, e.g. `.bg-card{background-color:var(--card)}`.
- **Names are unprefixed** (`--primary`, `--accent`) while ours are `--color-*`. That is what
  keeps them from colliding: we have `--color-accent` meaning decorative gold, shadcn's `accent`
  means the subtle hover background. **Tailwind's `bg-accent` means shadcn's sense, not gold** —
  use `--color-gold` for gold.
- **`--primary` maps to `--color-btn`, not `--color-primary`.** shadcn's `primary` is the
  filled-button colour; the two are the same hex in dark but differ in light (`#0369A1` vs
  `#0284C7`). `applyAccent` writes `--color-btn` inline at runtime, so a user-chosen accent
  already flows through the bridge.
- **`--radius` is `var(--radius-button)` = 0.625rem = 10px**, the radius the product already
  uses, and the `sm/md/lg/xl` ladder derives from it.

**The one visual change — an AA fix.** `.btn--danger` hardcoded `color: #fff`. On dark's
`--color-danger` (`#F87171`) that measures **2.77:1**, well under AA's 4.5:1 — on the Remove-app
button and the new "Start anyway" consent button, the two highest-stakes clicks in the product.
Same shape as the accent-ink bug fixed in v0.51.1: a light fill needs dark ink. New
`--color-on-danger` token: dark `#00131c` (**6.84:1**), light keeps `#FFFFFF` (**4.83:1**).
So **danger buttons in dark mode now have dark text instead of white.** That is intended.

**Added** `--color-on-danger`, `--font-body`/`--font-heading` aliases, the 20-entry bridge,
`@theme inline`, and 2 gates + 1 contrast test (6 mutations checked).
**Raw-hex ratchet 10 → 9**, since `.btn--danger` now uses the token.

**Verification:** lint clean · build clean · **632/632** in WSL (629 + 3).

### What to test

1. **The danger fix.** Dashboard → any app → ⋯ → Remove. In **dark** mode the "Remove app"
   button should now have **dark text on red** and be clearly readable — previously white on
   red and hard to read. In **light** mode it stays white on red. Same for "Start anyway" on a
   held app, and any other red button.
2. **Everything else is unchanged.** Dark and light, all five accents, all nine wallpapers —
   identical to before. Any other visual difference is a bug in this slice.
3. `npm run lint` → clean. `npm run build` → clean.
4. `wsl -d Ubuntu -e bash -lc 'bash ~/omos-sync.sh && cd ~/omos && npm run test'` → 632 pass.
