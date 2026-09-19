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
| 2 | `theme.css` — tokens mapped to Tailwind v4 `@theme` | ⬜ |
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
