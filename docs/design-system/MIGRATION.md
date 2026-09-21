<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Design-system migration log

OpenMasjidOS is the reference implementation. Every other app inherits the same package, theme
and primitives — see [CONSUMING.md](./CONSUMING.md).

15 slices. Each lands on `dev` on its own, with what changed and what to test. Nothing reaches
`master` until the whole set is done and Hasan says so.

> **Every slice bumps `VERSION`.** On the Development channel the version bump IS the
> publish (CLAUDE.md §13.4): CI tags the image from `VERSION`, and `checkForUpdate` compares
> versions — so pushing to `dev` without bumping republishes the *same* tag and a dev box is
> never offered the update. Slices 1–3 were pushed without a bump and were therefore
> invisible to a box on Development until `0.51.2-dev.2`.

| Ships in | Contains |
|---|---|
| `0.51.2-dev.2` | restore→Start security fix + Slices 1–3 |

| # | Slice | Status |
|---|---|---|
| 1 | Foundation — shadcn init, `cn()`, CI gates | ✅ `dev.2` |
| 2 | Theme bridge — tokens on Tailwind v4 `@theme` | ✅ `dev.2` |
| 3 | `@openmasjid/ui` package contract + manifest | ✅ `dev.2` |
| 4 | `/design-system` gallery + Switch, Checkbox, Label | ✅ `dev.3` |
| 5 | DropdownMenu + both hand-rolled menus migrated | ✅ `dev.4` |
| 6 | **Dialog** — `Modal` rewritten on Radix, 25 instances, no call-site edits | ✅ `dev.5` |
| 7 | Command palette (⌘K) | ⬜ |
| 8 | Publish the package + migrate the other apps | ⬜ |

> **Scope was cut from 15 slices to 8 on 2026-09-19.** React Bits Pro was the source of
> ~300 prebuilt *screens*; shadcn/ui gives ~50 *primitives*, so hand-composing 279 screens
> got more expensive, not less — while the audits showed all seven repos **already share the
> same palette**, having copied it from each other. The real problem was never that the apps
> look different; it is that there are seven copies of the same CSS that drift. So the
> remaining slices do the two things that still pay: replace hand-rolled controls with
> accessible ones, and make the other apps consume this package instead of copying it.
> The 279 working screens are left alone.

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

---

## Slice 3 — Package contract

**Shipped.** No visual change. `packages/ui` now has a public surface other apps can consume,
carved out of the app it also contains.

**Added**
- `src/styles/design-system.css` — the whole design system in one import, in the one order that
  works. **OpenMasjidOS now imports this instead of its own list**, so the path other apps
  depend on is exercised by every build here. An export nobody dogfoods is an export nobody
  tests, and a gate enforces the dogfooding.
- `src/index.ts` — the code barrel. Exports `cn` and nothing else yet, which is honest: the
  primitives land in Slices 5–10 and motion in Slice 11.
- `ui-manifest.json` — the machine-readable contract: entry points, stylesheet order, semantic
  token names, exports, primitives, and the gate budgets.
- `exports` map in `package.json` — four subpaths, **no wildcard**. The dashboard's own
  entry points (`main.tsx`, `App.tsx`, `routes/`, the tRPC client, the window manager) stay
  internal; they are OpenMasjidOS features, not a design system.

**Changed**
- The five gate budgets now **read from `ui-manifest.json`** instead of being written in the
  test. Two copies of a number is one place to forget, and the manifest is the file a
  downstream app reads — so it is the one that has to be right.
- `main.tsx` imports the aggregate rather than six separate stylesheets.

**Proving the aggregate is equivalent.** Switching the import graph changed the built CSS from
49,188 to 48,070 bytes, which is not "no change" and needed explaining. Diffed at rule level:
the differences are purely Lightning CSS optimising harder now that it sees one document —
`#FFFFFF`→`#fff`, `U+0460`→`U+460`, whitespace. At selector level exactly three differ, all
equivalent: an `@supports` condition with its two operands swapped, and `.scene--image:before`
+ `:after` merged into one rule. **No rule lost, 1,118 bytes saved.**

**Six new gates** (all mutation-checked): stylesheet order matches the manifest; OpenMasjidOS
dogfoods the aggregate; every manifest token exists in the bridge; `index.ts` and
`manifest.exports` agree; `components/ui/` and `manifest.primitives` agree (empty until Slice
5, and the thing that stops a component being installed and never recorded); and the exports
map has no wildcard and leaks no internals.

**One bug worth recording.** Appending the tests via a shell heredoc silently ate a backslash:
`\s` became `\s`, which inside a template literal collapses to a literal `s`, so the regex was
`^s*--backgrounds*:` and could never match. The test failed loudly here — but the same mangling
in a `doesNotMatch` would have passed forever. The project handoff already warns that heredocs
mangle backslashes; **write test files with the Write tool, not by appending through a shell.**

**Verification:** lint clean · build clean · **638/638** in WSL (632 + 6).

### What to test

1. `npm run dev` → dashboard **visually identical**, fonts included. The font loading path
   changed (JS import → CSS `@import`), so specifically check that Inter and Space Grotesk
   still render — headings should be Space Grotesk, body Inter, not a system fallback.
2. Dark/light, all five accents, all nine wallpapers — unchanged.
3. `npm run build` → clean, and `packages/ui/dist/assets/*.css` should be ~48 KB.
4. `wsl -d Ubuntu -e bash -lc 'bash ~/omos-sync.sh && cd ~/omos && npm run test'` → 638 pass.
5. *Optional:* open `packages/ui/ui-manifest.json` — that is the contract other apps read.
