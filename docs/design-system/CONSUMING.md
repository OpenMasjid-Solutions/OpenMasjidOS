<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Inheriting the design system in another OpenMasjid app

**Audience:** whoever is migrating OpenMasjidStudents, Donations, Companion, Kiosk, Display or
the Website. OpenMasjidOS is the reference implementation; this page is how you get the same
look without re-deciding anything.

> **Status: not ready to consume yet.** The package contract lands in Slice 3 and the
> primitives in Slices 5–11. This page is written as those land so nobody has to reverse
> engineer it later. Follow [MIGRATION.md](./MIGRATION.md) for what is actually available.

---

## The short version

1. Your app declares `@openmasjid/ui` and imports **only** from it.
2. You import one stylesheet. You do not define colours, fonts or radii anywhere in your app.
3. You use the logical direction utilities. A CI gate enforces it.
4. If shadcn has a primitive, you use it. You do not write your own.

## What you must not do

| Don't | Why |
|---|---|
| Define a colour, font or radius in your app | There is one theme. Overriding it is how the suite stops looking like one product. |
| Hand-edit anything under `components/ui/` | It is shadcn CLI output and must stay re-runnable. Wrap it instead. |
| Use `ml-*` `pl-*` `left-*` `text-left` `border-l` | They break Arabic and Urdu. Use `ms-* ps-* start-* text-start border-s`. |
| Add `framer-motion`, `gsap`, `react-spring` or `lottie` | Motion comes from the shared vocabulary so it is consistent and reduced-motion-safe. |
| Add a second component library | MUI, Chakra, Mantine, Headless UI. If something is missing, compose it from what is here and record it. |
| Add a CDN font, icon or script | Masjids run LAN-only and offline. Everything is bundled. The Website's CI already fails the build on any external request. |

## Per-repo prerequisites

From the audits. Do these **before** consuming anything, each as its own standalone commit.

| Repo | Needs |
|---|---|
| **Students** | Reverse the `CLAUDE.md` §7 / `DATA_MODEL.md` ban on shadcn+Radix (the reason given is parity with OS — moving together satisfies it). Introduce a router: sections are `useState` and unaddressable today. Tailwind is installed but unused. |
| **Donations** | Tailwind 3.4 → v4. **Keep `preflight: false`.** Verify `@stripe/react-stripe-js` peers. Introduce a router (currently regex path matching). Preserve `base: './'` and `web/src/base.ts` for the tunnel path. |
| **Companion** | Tailwind 3.4 → v4, `preflight: false`. Respect the 260 KB first-load budget — a musalli opens this on mobile data at Fajr. Keep the lazy admin boundary and `base: './'`. |
| **Kiosk** | Tailwind 3.4 → v4, `preflight: false`. `server/src/theme-contrast.test.ts` parses `tokens.css` by literal selector and will need rewriting. The donor UI is Jetpack Compose and is **out of scope**. |
| **Display** | Tailwind from zero — nothing is installed. Keep the two-entry Vite build (`webScreen.test.ts` pins `dist/screen.html`). The television page is server-rendered SVG and is **out of scope**. |
| **Website** | Astro 5 with **no React at all**. Needs `@astrojs/react` + React as new dependencies, and a hydration decision per island. The build box is a 4 GB LXC that already OOMs. `/docs` (Rspress, React 18) is out of scope. |

**React 19 is not required.** Radix supports `^16.8 || ^17.0 || ^18.0 || ^19.0` and shadcn
supports React 18 and 19. Every app can stay on 18.

**Do not enable Tailwind's preflight** in Donations, Companion or Kiosk. It is off deliberately
so their hand-written CSS stays authoritative; turning it on restyles every screen at once on
repos serving live masjids. Scope shadcn's reset to a wrapper class instead.

## Surfaces this cannot reach

Plan around these — they are outside the shared system by construction:

- **Kiosk's donor flow** — Jetpack Compose (22 `.kt` files) plus a Stripe.js WebView page.
- **Display's television output** — server-rendered SVG rasterised to the Pi framebuffer.
- **Students' 11 server-rendered HTML surfaces** — printed documents, public admissions forms,
  the embeddable widget that runs inside the masjid's own website, and `offline.html`.
- **Donations' `/w/<slug>` widget** — must draw no background, ignore OS dark preference and
  postMessage its height. An opaque card or `min-h-screen` breaks it.
- **Website `/docs`** — Rspress, pinned to React 18.

## The theme

Identical across all seven repos already, so no app needs to choose:

| Token | Dark (default) | Light |
|---|---|---|
| `--color-primary` | `#22D3EE` | `#0284C7` |
| primary hover | `#67E8F9` | `#0369A1` |
| button | `#22D3EE` | `#0369A1` |
| on-primary ink | `#00131c` | `#FFFFFF` |
| accent / gold | `#F59E0B` | `#D97706` |
| surface | `#030D1A` | `#F0F9FF` |
| ink | `#F4F7FB` | `#0C4A6E` |

Radius `10px`. Fonts are self-hosted via `@fontsource-variable/inter` and `space-grotesk`.
The accent is **user-chosen at runtime** — `applyAccent` writes `--color-primary`,
`--color-btn` and `--color-on-primary` inline on the root element, which beats the stylesheet.
Never assume the stylesheet value is the live one.

## i18n, honestly

Only OpenMasjidOS (778 keys) and Students (1,652) have any i18n. Donations, Companion, Kiosk,
Display and the Website have **none** — every string is hardcoded English. Making Arabic and
Urdu real means introducing i18n from zero in five repos and extracting several thousand
strings, which is a programme of comparable size to the UI work. It is **scoped separately**.

What this migration does guarantee is that the *layout* is ready for it: logical properties
throughout, enforced by a gate with a budget of zero.
