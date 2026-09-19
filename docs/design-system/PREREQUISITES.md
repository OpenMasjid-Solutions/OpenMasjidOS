<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Design-system unification — prerequisites and cost

**Status:** planning. No code has been changed. Nothing here is committed to any repo.
**Decision taken 2026-09-18:** React Bits Pro is **not** being adopted (see §1). The suite
unifies on **shadcn/ui + Radix + Tailwind v4**, which are MIT/ISC and AGPL-compatible.
**Sources:** the seven `docs/design-system/audit.md` files written the same day.

---

## 1. Why React Bits Pro was dropped

RB Pro's licence (§2.4) forbids distributing, publishing or sublicensing the Product or any
substantial part of it, and names "open source repositories… starter kits, or boilerplates"
explicitly. All six app repos are AGPL-3.0-only (`LICENSE` = GNU Affero; SPDX headers on every
tracked source file — 321 in Students, 154 in Display). AGPL §1 makes the Corresponding Source
of a conveyed binary include everything needed to build it, §6 requires conveying it to every
recipient, and §13 extends that to network users. OpenMasjidOS ships a **public Docker image**
to masjids, so AGPL compels disclosure of exactly what RB forbids.

Keeping `@openmasjid/ui` private does not fix this — it is what creates the violation. The
obligation attaches to the shipped artifact, not the repository. Same structural conflict as
`CLAUDE.md` §3's umbrelOS/PolyForm rule.

`OpenMasjidWebsite` is the one surface with no AGPL obligation (no `LICENSE`, no SPDX headers).
It is not worth a separate proprietary dependency on its own.

## 2. What the decision changes about the prerequisites

| Prerequisite | Under RB | Under shadcn/ui | Effect |
|---|---|---|---|
| React 19 | required | **not required** | Radix peers are `^16.8 \|\| ^17.0 \|\| ^18.0 \|\| ^19.0`; shadcn supports 18 and 19. **A six-repo React migration comes off the plan.** |
| Tailwind v4 | required | required | Unchanged — this is the real cost. |
| `shadcn init` | required | required | Unchanged. |
| Licence key / MCP / Agent Kit | required | **not needed** | No external dependency, no key handling, no CI secret. |
| Design skill (`skill-apple-minimal`) | prescribed | **n/a** | We already have a design language (`CLAUDE.md` §14). Keep it. |

React 19 may still be done later on its own merits. It is no longer blocking and should not be
bundled into this work.

## 3. Two recorded decisions that must be reversed first

These are free to change and block everything after them.

1. **`OpenMasjidStudents/CLAUDE.md` line 959 forbids shadcn/ui and Radix** — "**NOT shadcn/ui,
   and not Radix**… OpenMasjidOS/Display/Kiosk share `styles/{tokens,glass,app}.css` and none of
   them pull in shadcn/Radix/tailwind-merge, so matching them (§15 parity, the harder
   constraint) means not adding it here either." Also recorded in `docs/DATA_MODEL.md`.
   The reasoning is **parity, not merit** — it says don't diverge from the family. Moving the
   whole family together satisfies it. But the text must be updated in the same change, or the
   next session reads a prohibition and stops.
2. **`OpenMasjidOS/CLAUDE.md` §6 already claims shadcn/ui** ("Components | **shadcn/ui** (Radix
   primitives, copied-in)") and the audit found **no Radix, no `components.json`, no
   `components/ui`** anywhere. The spec has wanted this all along; it was never built. So
   adopting shadcn brings OS *into* compliance with its own spec.

Net: the family is currently unified on "no shadcn", while the reference repo's spec mandates
it. Either the OS line or the Students line is wrong today whichever way this goes.

## 4. Where each repo actually stands

Counts are from the audits, not estimates.

| Repo | Screens | React | Tailwind | Utility classes used | Router | shadcn | i18n |
|---|---:|---|---|---|---|---|---|
| OpenMasjidOS | 76 | 18.3.1 | v4.3.1 installed | **0** | react-router 7.18.2 | no | i18next, 778 keys, `en` |
| OpenMasjidStudents | 54 | 18.3.1 | v4.0.0 installed | **0** | **none** | no | i18next, 1,652 keys, `en` |
| OpenMasjidDonations | 41 | 18.3.1 | **v3.4.17** | yes | **none** (regex) | no | **none** |
| OpenMasjidCompanion | 26 | 18.3.1 | **v3.4.19** | yes | **none** (by design) | no | **none** |
| OpenMasjidKiosk | 22 | 18.3.1 | **v3.4.19** | **0** | **none** (hash) | no | **none** |
| OpenMasjidDisplay | 47 | 18.3.1 | **not installed** | **0** | **none** | no | **none** |
| OpenMasjidWebsite | 13 | **none at all** | v4.3.3 | yes | Astro file-based | no | **none** |

`OpenMasjidCloud` is not on this machine and was not audited.

**The headline is not the Tailwind version.** In five of seven repos Tailwind utilities are
**not used at all** — roughly **10,500 lines of hand-written BEM-ish CSS** carry the entire
design (OS 1,711 · Students 3,480 · Companion ~2,100 · Kiosk ~1,060 · Donations ~800 ·
Display ~1,350). So this is a Tailwind *adoption*, not an upgrade.

## 5. The three real risks

**5.1 `preflight: false` is load-bearing in three repos.** Donations, Companion and Kiosk
disable Tailwind's reset deliberately so their hand-written CSS stays authoritative. Tailwind
v4 re-enables preflight by default and shadcn assumes it. Turning it on restyles every screen
at once, on repos serving live masjids.

> **Recommendation: do not enable preflight.** Import shadcn's reset scoped to a wrapper class
> around shadcn subtrees instead. It costs one CSS scoping layer and removes the single largest
> regression risk in the programme. Revisit per repo only once its own CSS is retired.

**5.2 A Tailwind rebuild will *lose* RTL correctness unless gated.** Every repo is already
near-perfect on logical properties — physical-direction declarations: Companion **0**,
Donations **0**, Website **0**, OS **4**, Kiosk **6**, Students **7**, Display **9**, against
185 logical in Website, 518 in Students, 194 in Display. Tailwind's defaults are *physical*
(`ml-*`, `pl-*`, `text-left`, `left-*`).

> **Recommendation: mandate the logical utilities** (`ms-* me-* ps-* pe-* start-* end-*
> text-start text-end`) and add a CI grep gate banning the physical ones **before** the first
> shadcn component lands. Cheap, and it protects an asset that took real work to build.

**5.3 Source-shape tests will fail by design.** These are not incidental:

| Repo | Test | What it pins |
|---|---|---|
| OS | `settings-nav.test.ts` | every section id has a `show()` gate + nav string, both directions, 13 named panels |
| OS | `i18n-keys.test.ts` | every `t()` literal exists in `en.json`; dynamic keys capped at 2 |
| OS | `theme-tokens.test.ts` | contrast arithmetic over all 5 accents; every wallpaper needs a light counterpart |
| Students | `paintCost.test.ts`, `layoutClasses.test.ts` | the four `backdrop-filter` paint-cost corrections; layout class shape |
| Kiosk | `server/src/theme-contrast.test.ts` | parses `tokens.css` by literal selector; WCAG AA over 9 wallpapers × 2 themes |
| Display | `webScreen.test.ts` | the two-entry Vite build, `dist/screen.html`, and relative-only cross-package imports |
| Companion | `licenseHeaders.test.ts` | AGPL SPDX header on every `.ts/.tsx/.css/.md` |
| Website | 3 CI copy gates + zero-external-request gate | install one-liner verbatim in 5 places; no CDN/beacon in built output |

Ten `packages/core` tests in OS additionally read `packages/ui/src` **by path** and break on any
file move. `packages/ui` has no test runner, so these are the UI's only guarantees.

## 6. Prerequisite cost, per repo

Engineering-days, prerequisites only — **no screens rebuilt**. Assumes preflight stays off
(§5.1); enabling it roughly doubles the Tailwind column in Donations, Companion and Kiosk.

| Repo | shadcn init | Tailwind | Router | Other | Total |
|---|---:|---:|---:|---|---:|
| OpenMasjidOS | 0.5 | 1.0 | — | — | **1.5** |
| OpenMasjidStudents | 0.5 | 1.0 | 2.0 | reverse the §7 ban + `DATA_MODEL.md` | **3.5** |
| OpenMasjidDonations | 0.5 | 2.5 | 1.5 | verify Stripe Elements peers | **4.5** |
| OpenMasjidCompanion | 0.5 | 2.5 | 1.0 | 260 KB budget, service-worker asset graph | **4.0** |
| OpenMasjidKiosk | 0.5 | 2.0 | 1.0 | `theme-contrast.test.ts` rewrite | **3.5** |
| OpenMasjidDisplay | 0.5 | 2.0 | 1.0 | Tailwind from zero; 2-entry build | **3.5** |
| OpenMasjidWebsite | 0.5 | — | — | **introduce React 19 + @astrojs/react** | **2.5** |
| Shared `@openmasjid/ui` | — | — | — | package, theme.css, manifest, gallery, CI gates | **5.0** |
| | | | | **Total** | **≈ 28 days** |

**The prerequisites are the small half.** 279 screens remain to rebuild. At an optimistic
half-day each that is ~140 days; the realistic figure is higher because Settings alone is
3,629 lines in OS and `admin.tsx` is 2,987 lines in Donations, both single modules with no
per-screen file to swap. **This is a multi-month programme, not a sprint.** Worth deciding
scope on that basis before starting.

## 7. Surfaces shadcn cannot reach

These are outside the unification by construction, and the "indistinguishable apps" test has to
exclude them or be met another way:

- **Kiosk's donor UI is Jetpack Compose** — 22 `.kt` files plus a hand-written Stripe.js
  WebView page. No React surface exists for the donation flow.
- **Display's television output is server-rendered SVG** rasterised to the Pi framebuffer; the
  Pi never loads React.
- **Students has 11 server-rendered HTML surfaces** — 4 printed documents, 4 public admissions
  forms, an embeddable widget that runs inside the masjid's own website, and `offline.html`.
- **Donations' `/w/<slug>` widget** must draw no background, ignore OS dark preference and
  postMessage its own height — any opaque card or `min-h-screen` breaks it.
- **Website's `/docs`** is Rspress, pinned to React 18.3.1; out of scope (separate Rspress 2
  migration).

## 8. i18n is a much bigger gap than the brief assumes

Only OS (778 keys) and Students (1,652 keys) have any i18n. **Donations, Companion, Kiosk,
Display and Website have none at all** — every user-facing string is hardcoded English.
"Arabic and Urdu first-class" therefore means introducing i18n from zero in five repos and
extracting several thousand strings, which is comparable in size to the UI rebuild itself.

Note also that English-only is a *deliberate* decision in OS (`CLAUDE.md` §13.1: no language
picker, `i18n/index.ts` registers only `en`). Making RTL real is a product decision, not a
by-product of the rebuild. **Recommend scoping it separately.**

## 9. Suggested order

1. Reverse the two recorded decisions (§3). Cheap, unblocks everything.
2. Build `@openmasjid/ui` — `theme.css`, `ui-manifest.json`, wrappers, `/design-system`
   gallery, and the CI gates **including the RTL gate** (§5.2) before any component lands.
3. OpenMasjidOS prerequisites, then one screen end-to-end as the reference. Stop and review.
4. Students, Donations, Companion, Kiosk, Display — prerequisites first, then screens.
5. Website last; it needs a React introduction and its build box has 4 GB and already OOMs.

## 10. Theme values (already derived — no decision needed)

Consistent across all seven repos, so `theme.css` can be written today:

| Token | Dark (default) | Light |
|---|---|---|
| `--color-primary` | `#22D3EE` | `#0284C7` |
| primary hover | `#67E8F9` | `#0369A1` |
| button | `#22D3EE` | `#0369A1` |
| on-primary ink | `#00131c` | `#FFFFFF` |
| accent / gold | `#F59E0B` | `#D97706` |
| surface | `#030D1A` | `#F0F9FF` |
| ink | `#F4F7FB` | `#0C4A6E` |

Radius `10px`. Fonts already self-hosted via `@fontsource-variable/inter` +
`space-grotesk` — **no CDN**, which is required: masjids run LAN-only and the Website CI fails
the build on any third-party runtime request. An Arabic face still needs adding for §9.
