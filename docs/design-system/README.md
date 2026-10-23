<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# The OpenMasjid design system

One design system for every OpenMasjid app. Someone moving between OpenMasjidOS,
Donations, Companion, Students, Kiosk and Display should not be able to tell they changed
apps except by the content.

Built on **shadcn/ui + Radix + Tailwind v4** — all MIT/ISC, so all AGPL-compatible. React Bits
Pro was evaluated and rejected on licensing; the reasoning is in
[PREREQUISITES.md §1](./PREREQUISITES.md).

| | |
|---|---|
| **Where it lives** | `packages/ui` (published to other apps as `@openmasjid/ui`) |
| **Theme** | `packages/ui/src/styles/tokens.css` — the only place colours and fonts are defined |
| **Primitives** | `packages/ui/src/components/ui/` — written by the shadcn CLI, **never hand-edited** |
| **Wrappers** | `packages/ui/src/components/` — our domain components, which may compose primitives |
| **Gates** | `packages/core/test/ui-design-gates.test.ts` |
| **Migration state** | [MIGRATION.md](./MIGRATION.md) · per-app audits in each repo's `docs/design-system/audit.md` |

---

## The rules

**1. Colours and fonts are defined in `tokens.css` and nowhere else.** Everything else uses
`var(--color-…)`. No raw hex, no `font-family` outside the token file. Enforced.

**2. Use the logical direction utilities, never the physical ones.** Arabic and Urdu are
first-class, and this codebase is already 35-logical-to-4-physical — an asset worth keeping.

| Never | Always |
|---|---|
| `ml-*` `mr-*` | `ms-*` `me-*` |
| `pl-*` `pr-*` | `ps-*` `pe-*` |
| `left-*` `right-*` | `start-*` `end-*` |
| `text-left` `text-right` | `text-start` `text-end` |
| `border-l` `border-r` | `border-s` `border-e` |
| `margin-left` `padding-right` (CSS) | `margin-inline-start`, `padding-inline-end` |

Enforced, with a budget of **zero**. There is nothing to grandfather: Tailwind utilities are
new here, so every physical one would be a fresh choice.

**3. Never hand-edit `components/ui/`.** Those files are the shadcn CLI's output. If a
primitive needs different behaviour, wrap it in `components/`. This is what keeps
`npx shadcn@latest add <name>` re-runnable when upstream fixes an accessibility bug.

**4. Motion honours `prefers-reduced-motion`, always.** Non-negotiable per `CLAUDE.md` §14.
New `@keyframes` are budgeted; prefer a shared preset from `lib/motion.ts`.

**5. Pi-friendly.** The dashboard runs on a Raspberry Pi and on wall-mounted kiosk hardware.
Ask before adding a dependency. `backdrop-filter` is already the measured frame budget.

---

## The gates

`packages/core/test/ui-design-gates.test.ts`, run by `npm run test`. Each is a **ratchet**: the
budget is the current measured count, and the test fails if the count goes **up** *or* **down**
— down means "you fixed one, lower the number so it can't creep back."

| Gate | Budget | Meaning |
|---|---:|---|
| Physical Tailwind utilities | **0** | must stay zero, forever |
| Physical CSS/inline properties | 4 | 2 in `app.css` (overlay, centring) + 2 in `WindowManager.tsx` (drag geometry — a real RTL gap, recorded) |
| Raw hex outside `tokens.css` | 10 | drive to 0 during migration |
| Hardcoded font stacks | 3 | three `ui-monospace` stacks in `app.css` |
| `@keyframes` | 5 | 4 in `app.css`, 1 in `glass.css` |
| `@/` alias parity | — | `tsconfig.json` and `vite.config.ts` must agree |
| `cn()` uses `twMerge` | — | see below |
| `components.json` correctness | — | CLI must point at our real paths |

**Why the alias gate exists.** The shadcn CLI bakes `@/lib/cn` into every component it writes.
The alias has to be declared in *both* `tsconfig.json` (for `npm run lint`, our only typecheck)
and `vite.config.ts` (for the bundle). If they drift, one resolves and the other doesn't — a
green build and a blank page.

**Why `cn()` uses `tailwind-merge`.** With plain `clsx`, `cn('px-4', props.className)` where the
caller passes `px-2` emits *both*, and the winner is decided by stylesheet order rather than by
the caller. A wrapper's override silently does nothing. `twMerge` resolves by Tailwind's own
group semantics so the last value wins. Our hand-written BEM class names (`glass-raised`,
`app-card`) pass through untouched, so the two systems coexist during the migration.

---

## Adding a component

```bash
cd packages/ui
npx shadcn@latest add button        # writes src/components/ui/button.tsx
```

Then:

1. Read the generated file. Replace any physical utility with its logical form (the CLI emits
   physical ones by default — this is the single most common way RTL regresses).
2. If it needs OpenMasjid behaviour, wrap it in `src/components/` — do not edit the primitive.
3. Add it to the `/design-system` gallery (Slice 4) so it is covered by the visual baseline.
4. `npm run lint && npm run test`.

> Tests must run in **WSL Ubuntu**, never on Windows or `/mnt/c` — two security tests only
> execute there. Run `bash ~/omos-sync.sh` first or you are testing stale code.
> `wsl -d Ubuntu -e bash -lc 'bash ~/omos-sync.sh && cd ~/omos && npm run test'`

**If you add a test file, register it by name in `packages/core/package.json`'s `test` script.**
An unlisted test never runs and nothing tells you (`CLAUDE.md` §17).

**If a gate needs to read a new config file**, add that file to `~/omos-sync.sh` too. The sync
script copies a fixed list; a gate reading an unsynced file passes on Windows and reads stale
or missing content in WSL. That happened while writing these gates.

---

## Progress

15 slices, each pushed to `dev` with its own test notes. See [MIGRATION.md](./MIGRATION.md).
