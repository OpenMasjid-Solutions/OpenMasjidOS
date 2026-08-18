<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# OpenMasjidOS Theming Guide

This document is the authoritative reference for all theming decisions in OpenMasjidOS. Every contributor working on the frontend must read this before touching styles, tokens, or motion.

---

## 1. Philosophy

The OpenMasjidOS interface should feel **calm, dignified, and modern** — a tool worthy of a masjid environment. The visual language draws from two sources:

**Islamic geometric art** — the mathematical precision of girih tiling, arabesque tessellations, and interlocking star patterns conveys order, depth, and timelessness without being decorative for its own sake. These patterns appear as subtle background textures and empty-state illustrations, never as loud foreground elements.

**Masjid architecture** — the dome, the mihrab arch, the minaret, the crescent. These forms are recognizable across cultures and carry inherent dignity. They inform our iconography, card shapes (gently arch-topped where appropriate), and illustrated states.

### What this means in practice

- Serene, not busy. Every element earns its place.
- Restrained color palette. Gold is a highlight, not a wallpaper.
- Motion that settles — spring physics feel alive and intentional, not mechanical.
- Language that is warm and direct. The user is a volunteer, not an engineer.
- No kitsch. No excessive crescent-moon clipart. No green-and-gold overload.

---

## 2. The Token System

All colour, glass, glow, shadow, radius and scene values are **CSS custom properties**
defined in **`packages/ui/src/styles/tokens.css`**. Components reference the variables and
never a literal — no hardcoded hex, no magic pixel where a token exists.

Theme switching is one attribute: `data-theme="dark"` or `data-theme="light"` on `<html>`.
The first block defines the **dark** theme (dark is the default) under a combined
`:root, [data-theme="dark"]` selector, so an un-set attribute and an explicit `dark` resolve
identically. A `[data-theme="light"]` block then overrides the same names.

```css
/* tokens.css structure */
:root,
[data-theme="dark"] {
  color-scheme: dark;
  --color-surface: #030D1A;
  /* … */
}

[data-theme="light"] {
  color-scheme: light;
  --color-surface: #F7FAFC;
  /* overrides only — same names */
}
```

React components consume tokens through ordinary CSS (`packages/ui/src/styles/app.css`,
`glass.css`) or inline style where a value is dynamic:

```tsx
<div className="app-card" style={{ borderColor: 'var(--color-border)' }} />
```

```css
.app-card {
  background: var(--glass-bg-raised);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-card);
  box-shadow: var(--glass-shadow-raised);
  color: var(--color-ink);
}
```

### The wallpaper axis, and the trap in it

There is a **second** attribute: `data-wallpaper`, one of nine scenes the admin picks in
Settings. Each `[data-wallpaper="…"]` block sets the scene tokens (`--scene-*`,
`--aurora-*`) that `SceneBackground` paints behind the frosted panels.

**`data-wallpaper` is always set** — `lib/prefs.ts` defaults it to `aurora` — and every
wallpaper block has the *same specificity* as `[data-theme="light"]` while appearing later
in the file. So for a long time light mode never got a light scene: white glass at 55%
alpha composited over a near-black gradient came out mid-grey, and then dark-blue ink went
on top of it. Nothing in the light palette was wrong; the cascade simply overrode it.

The fix, and the rule now: **every wallpaper must have a
`[data-theme="light"][data-wallpaper="…"]` counterpart**, which wins on specificity rather
than on file order. Each counterpart keeps the wallpaper's hue and inverts its lightness,
so Ocean is still blue and Forest still green — the picker means the same thing in both
themes. `packages/core/test/theme-tokens.test.ts` fails the build if a wallpaper is added
without its light counterpart, if the picker list and the stylesheet drift apart, or if a
"light" scene is not actually light (Rec. 601 luma > 0.85).

---

## 3. Token Reference

53 tokens in the base block, in ten groups. This is the real list; check
`tokens.css` if you need current values, and add a token there rather than inventing one
at a call site.

### 3.1 Colour (22)

| Token | Role |
|---|---|
| `--color-surface` | The base surface behind everything. |
| `--color-surface-raised` | A panel or card lifted off the base. |
| `--color-surface-overlay` | Modals, popovers, menus. |
| `--color-surface-hover` | Hover wash over a surface (an alpha, not a solid). |
| `--color-surface-shimmer` | The lighter band in a skeleton loader. |
| `--color-primary` | Primary accent. Interactive, focused, active. |
| `--color-primary-hover` | Primary, hovered. |
| `--color-primary-muted` | A dimmed primary for less-loud states. |
| `--color-primary-subtle` | Low-alpha primary for fills and rings. |
| `--color-accent` / `--color-gold` | The warm accent, used sparingly. |
| `--color-gold-subtle` | Low-alpha gold, for a highlight wash. |
| `--color-ink` | Body text. |
| `--color-ink-muted` | Secondary text, hints, captions. |
| `--color-ink-faint` | Disabled and least-emphasis text. |
| `--color-border` | Default border. |
| `--color-success` / `--color-warning` / `--color-danger` | Semantic status. Never the accent. |
| `--color-btn` / `--color-btn-hover` | Neutral button surface. |
| `--color-on-primary` | Text/icon **on** a primary fill — never assume white. |

### 3.2 Glass (14)

The dashboard's panels are frosted, so the glass tokens carry the whole look:
`--glass-blur`, `--glass-blur-inset`, `--glass-blur-strong`, `--glass-saturate`,
`--glass-saturate-strong`, `--glass-bg`, `--glass-bg-raised`, `--glass-bg-inset`,
`--glass-tint`, `--glass-highlight`, `--glass-border`, `--glass-glow`, `--glass-shadow`,
`--glass-shadow-raised`.

Two things to keep in mind: the `-bg-*` values are **alphas** and only read correctly over
a scene, which is why the wallpaper counterparts above matter; and `backdrop-filter` is
expensive on a Raspberry Pi, so don't add new blurring layers casually.

### 3.3 Scene and pattern (9)

`--scene-base`, `--scene-gradient`, `--scene-vignette`; `--aurora-cyan`, `--aurora-navy`,
`--aurora-gold`, `--aurora-blur`; `--pattern-opacity`, `--geometric-pattern`.

Set per wallpaper (and per wallpaper **per theme**). `--geometric-pattern` is the tessellating
motif; `--pattern-opacity` keeps it a texture rather than a decoration.

### 3.4 Everything else (8)

`--shadow-card`, `--shadow-modal`; `--radius-card`, `--radius-button`; `--glint`,
`--glint-strong`; `--glow-primary`, `--glow-strength`.

> Type scale, spacing and motion durations are **not** tokens here — type and spacing come
> from Tailwind v4's own scale, and motion values live in `packages/ui/src/lib/motion.ts` as
> shared Motion presets. Don't add a parallel set.

---

## 4. Switching Themes

The theme, accent, wallpaper and language are all applied by **`packages/ui/src/lib/prefs.ts`**,
which owns the attributes on `<html>`:

```ts
// packages/ui/src/lib/prefs.ts — the only place these attributes are written
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}
```

`prefsStore.hydrate()` is called once from `main.tsx` **before the first paint**, so there is
no flash of the wrong theme and no inline script in `index.html` to keep in step.

**Rules:**

- Never read `data-theme` in component logic to branch on it. Style through tokens and let
  the cascade resolve; a component that knows which theme it is in will be wrong in the
  other one.
- Never set `data-theme` anywhere but `prefs.ts`.
- Never apply theme classes to individual components. Theme is a `:root` concern.
- "Follow system" resolves to a concrete `dark`/`light` value in `prefs.ts` — the stylesheet
  only ever sees the two real themes.

---
## 5. Typography

### Font Choices

| Role | Font | Fallback |
|---|---|---|
| UI / body | `Inter` (variable font) | `system-ui, -apple-system, sans-serif` |
| Display / headings | `Playfair Display` (variable, regular + italic) | `Georgia, serif` |
| Arabic / Naskh (RTL) | `Noto Naskh Arabic` | `Arial, sans-serif` |
| Monospace (logs, code) | `JetBrains Mono` | `ui-monospace, monospace` |

Load fonts via `@font-face` with `font-display: swap`. Subset aggressively — the Latin subset of Inter is enough for non-RTL locales. Load the Arabic face only when `lang` is `ar` or `ur`.

### Type Scale Tokens

| Token | Value | Usage |
|---|---|---|
| `--text-xs` | `0.75rem / 1rem` | Captions, timestamps, badge labels |
| `--text-sm` | `0.875rem / 1.25rem` | Secondary body, form labels |
| `--text-base` | `1rem / 1.625rem` | Primary body text |
| `--text-lg` | `1.125rem / 1.75rem` | Card taglines, emphasized body |
| `--text-xl` | `1.25rem / 1.75rem` | Section subheadings |
| `--text-2xl` | `1.5rem / 2rem` | Page headings |
| `--text-3xl` | `1.875rem / 2.25rem` | Major section titles |
| `--text-4xl` | `2.25rem / 2.75rem` | Hero / display text (sparingly) |

Apply the display font only for `--text-2xl` and above, and only for actual headings. Body text always uses Inter.

### Font Weight Conventions

| Weight | Usage |
|---|---|
| 400 (regular) | Body text |
| 500 (medium) | Labels, nav items, button text |
| 600 (semibold) | Card titles, form section headings |
| 700 (bold) | Page headings with Inter; all weights with Playfair Display |

---

## 6. Islamic Geometric Motif Usage

### The Background Pattern

The low-opacity geometric tessellation that underlies the dashboard is generated as an inline SVG pattern and applied via `background-image` on `--color-bg-base` surfaces. Key rules:

- Opacity must be `var(--color-geometric-pattern)` — approximately 4% opacity in dark mode, 6% in light. At this level it reads as texture, not decoration.
- The pattern must be the same tile in both themes; only opacity changes.
- Never animate the background pattern itself (it would be distracting and expensive).
- The SVG tile is a girih-style star polygon — 8-point or 10-point. Avoid the 5-point star (it carries unintended nationalist connotations in some contexts).
- File lives at `packages/ui/src/styles/tokens.css` as the `--geometric-pattern` token (an inline SVG data URI), painted by `components/SceneBackground.tsx`.

### Where Motifs Appear

| Context | Motif | Guidance |
|---|---|---|
| Page background | Girih tessellation | Always, at very low opacity |
| Empty states | Dome or mihrab illustration | One per empty state, monochrome in `--color-primary-300` or `--color-text-tertiary` |
| App Store hero | Geometric star | Optional, one instance, paired with text |
| Icons | Crescent, dome, minaret, mihrab | Only from the custom glyph set (see Section 7) |
| Splash screen | Geometric pattern assembling | Exactly once on first load, < 1s, skip immediately on interaction |

### Where Motifs Must NOT Appear

- Loading spinners. Use a skeleton shimmer instead.
- Button backgrounds.
- Toast/notification chrome.
- Error or warning states (the motif evokes dignity; error states need clarity).
- Anywhere that would make the motif feel like repeated wallpaper.

---

## 7. Custom Icon / Glyph Set

OpenMasjidOS ships a small set of custom masjid glyphs alongside `lucide-react`. These are SVG components, not an icon font. Each glyph is designed on a 24×24 viewBox with a 1.5px stroke, matching the Lucide visual style.

### The Glyph Set

| Glyph | Component name | Usage |
|---|---|---|
| Dome | `<IconDome />` | Dashboard home, app category: displays |
| Minaret | `<IconMinaret />` | Settings, administration apps |
| Crescent + star | `<IconCrescent />` | Quran/Islamic resources category, brand mark |
| Mihrab arch | `<IconMihrab />` | Empty states for app listings, prayer category |

All four glyphs live in `packages/ui/src/components/Glyphs.tsx`. They take `size` and `className`, and inherit colour via `currentColor`. Always provide `aria-label` or pair with a visible label — do not use these as purely decorative elements without an `aria-hidden="true"`.

### Using Lucide vs Custom Glyphs

Use **Lucide** for:
- UI actions (search, close, menu, settings, arrow, check, alert, download, etc.)
- Generic concepts that Lucide covers well

Use the **custom glyphs** for:
- Category icons in the App Store
- Empty state illustrations (scaled up to 48–96px)
- The dashboard nav logo/wordmark area

Do not scale Lucide icons above 32px or below 14px. Custom glyphs may be used at any size since they are illustrative.

---

## 8. Motion Principles

### Core Philosophy

Motion in OpenMasjidOS is not decoration — it communicates state change. Every animation should answer the question: "What just changed, and why?"

The guiding aesthetic is **settled spring physics**: elements feel like they have mass, overshoot slightly on entry, and come to rest naturally. This is achieved with Motion One's `spring()` easing or `cubic-bezier(0.34, 1.56, 0.64, 1)` for CSS transitions.

### prefers-reduced-motion (Non-Negotiable)

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

That rule lives in `tokens.css` and covers everything driven by CSS.

**It does not cover Motion, and that is the part people miss.** Motion animates via inline
styles from JavaScript, so a CSS `animation-duration: 0.01ms` override cannot touch a spring
on `y` or `scale`. Motion has to be told separately, once, at the top of the tree:

```tsx
// packages/ui/src/App.tsx — one MotionConfig, wrapping everything
import { MotionConfig } from 'motion/react';

<MotionConfig reducedMotion="user">
  {/* the whole app */}
</MotionConfig>
```

`reducedMotion="user"` makes Motion honour the OS setting for transform and layout
animations while still allowing opacity — which is exactly the "collapse to instant or
opacity-only" behaviour CLAUDE.md §14 requires. **Motion's default is `"never"`**, i.e. it
ignores the preference entirely unless you say otherwise, so the absence of this wrapper is
silent: everything looks right on the machine of anyone who has not asked for reduced
motion.

Prefer the shared presets in `lib/motion.ts` over hand-written transitions, so this stays a
single decision rather than one per component.

### Animation Catalogue

| Element | Animation | Duration | Easing |
|---|---|---|---|
| Page/route transition | Crossfade + 6px rise | `--duration-slow` | `--easing-out` |
| Card enter (staggered grid) | Fade + 8px rise, 40ms stagger | `--duration-normal` | `--easing-out` |
| Card hover | Scale 1.0 → 1.015, shadow lift | `--duration-fast` | `--easing-spring` |
| Button press | Scale 1.0 → 0.97 | `80ms` | `--easing-in` |
| Modal open | Scale 0.95 → 1.0, fade | `--duration-normal` | `--easing-spring` |
| Modal close | Scale 1.0 → 0.95, fade out | `--duration-fast` | `--easing-in` |
| Toast enter (from bottom-right) | Slide up + fade | `--duration-normal` | `--easing-out` |
| Toast exit | Slide right + fade | `--duration-fast` | `--easing-in` |
| Skeleton shimmer | Gradient sweep | `1.6s` infinite | `linear` |
| Install progress (pulling) | Indeterminate progress bar | `--duration-deliberate` looping | `--easing-smooth` |
| Install progress (starting) | Determinate fill to 80% | `--duration-deliberate` | `--easing-smooth` |
| Install success | Scale pop + checkmark draw | `--duration-normal` | `--easing-spring` |
| Dashboard splash | Geometric pattern assembles | `< 800ms` total | Staggered `--easing-out` |
| Sidebar nav item active | Gold indicator slides in | `--duration-fast` | `--easing-spring` |
| Toggle (on/off) | Thumb slides + track color cross-fades | `--duration-fast` | `--easing-spring` |

### What Not to Animate

- Background colors on large surfaces (expensive, jarring).
- `width` or `height` directly — animate `transform: scaleX/Y` or `max-height` instead.
- Anything that moves for longer than 600ms without user intent.
- The geometric background pattern.
- Text content swaps (just cut to new text; fading text is rarely legible mid-transition).

### Shared Presets

All transition and spring presets live in `packages/ui/src/lib/motion.ts`. Do not define `cubic-bezier` values or duration numbers ad hoc in a component — import a preset. This ensures global consistency and makes reduced-motion overrides maintainable in one place.

---

## 9. RTL Support

OpenMasjidOS targets Arabic and Urdu as first-tier RTL locales. RTL support is not an afterthought — it is built in from the start.

### The `dir` Attribute

`lang` and `dir` are set on `<html>` from the active locale by `applyLanguage` in
`packages/ui/src/lib/prefs.ts` — the same file that owns `data-theme`, so all root attributes
have one writer:

```ts
// packages/ui/src/lib/prefs.ts
export function applyLanguage(lang: string): void {
  const el = document.documentElement;
  el.setAttribute('lang', lang);
  el.setAttribute('dir', RTL_LANGS.has(lang) ? 'rtl' : 'ltr');
}
```

Never check a locale string in a component to decide direction — style against `dir` with
logical properties and let the document tell you.

> **Status:** the plumbing is in place and the CSS below is followed, but there is **no
> language picker in Settings yet**, so `applyLanguage` only ever runs with `en` in practice
> and the RTL path is untested against real Arabic/Urdu copy. Treat the rules here as the
> standard to build to, not as a shipped, exercised feature. `en.json` is the only locale
> file.

### CSS Logical Properties

Use CSS logical properties everywhere. Never use `left`, `right`, `margin-left`, `padding-right`, etc. in component styles.

| Physical (forbidden) | Logical (required) |
|---|---|
| `margin-left` | `margin-inline-start` |
| `padding-right` | `padding-inline-end` |
| `border-left` | `border-inline-start` |
| `left: 0` | `inset-inline-start: 0` |
| `text-align: left` | `text-align: start` |
| `float: right` | `float: inline-end` |

Tailwind's JIT mode supports logical property utilities (`ms-*`, `me-*`, `ps-*`, `pe-*`, `start-*`, `end-*`). Prefer these utilities in markup; use raw logical properties in `<style>` blocks.

### Typography in RTL

When `dir="rtl"`:
- Body text uses `Noto Naskh Arabic` (loaded conditionally).
- Headings: Playfair Display does not have Arabic glyphs — fall back to Noto Naskh Arabic for headings too in RTL mode. Do not mix the two faces in a single heading.
- Line height increases to `1.8` for Arabic text (`--line-height-rtl: 1.8`).
- Letter spacing is always `0` for Arabic (never apply `letter-spacing` to Arabic text).

### Icons in RTL

Directional icons (arrows, chevrons, "back/forward" affordances) must be mirrored in RTL. Apply the `.icon-rtl-mirror` utility class, which applies `transform: scaleX(-1)` under `[dir="rtl"]`. Non-directional icons (the custom glyph set, status dots, check marks) are never mirrored.

### Layout in RTL

Flexbox and Grid with logical values handle most layout automatically when `dir` is set. Test the following in RTL before marking any feature done:
- Sidebar position (should shift to the right in RTL).
- Breadcrumb arrow direction.
- Progress bar fill direction.
- Toast slide-in direction.
- Modal internal padding alignment.

---

## 10. WCAG AA Contrast Requirements

All text and interactive elements must meet WCAG 2.1 Level AA:

| Content type | Minimum contrast ratio |
|---|---|
| Normal text (< 18pt / < 14pt bold) | 4.5:1 |
| Large text (≥ 18pt / ≥ 14pt bold) | 3:1 |
| UI components and graphical objects | 3:1 |

### Checking Contrast

During development, check contrast with one of these methods:

1. **Browser DevTools**: Chrome and Firefox both show contrast ratios in the color picker when inspecting text elements.
2. **Colour Contrast Analyser** (free desktop app): paste hex values from your computed tokens.
3. **Not automated.** There is no contrast check in CI — `npm run lint` is `tsc --noEmit` only. Changing a token value is therefore a manual re-verification, which is exactly why the pairs below are written down.

### Pre-verified Critical Pairs

These combinations have been verified at both themes. Do not change the underlying token values without re-verifying.

| Token pair | Dark ratio | Light ratio |
|---|---|---|
| `--color-text-primary` on `--color-bg-base` | 14.2:1 | 13.8:1 |
| `--color-text-secondary` on `--color-bg-base` | 5.1:1 | 4.8:1 |
| `--color-text-primary` on `--color-surface-raised` | 11.4:1 | 12.1:1 |
| `--color-primary-500` text on `--color-bg-base` | 4.6:1 | 4.7:1 |
| White text on `--color-primary-600` button | 5.2:1 | 5.2:1 |
| `--color-text-primary` on `--color-surface-sunken` | 13.1:1 | 11.6:1 |
| `--color-accent-500` on `--color-bg-base` | 3.2:1 | 3.1:1 (large text only) |

Note: `--color-accent-500` (gold) does not meet 4.5:1 in either theme. **Do not use gold for body text or links.** Use it only for decorative highlights, active indicators (paired with an icon or shape, not text alone), and large-text contexts where 3:1 is sufficient.

---

## 11. What NOT to Do

These are hard rules, not suggestions. A PR that violates any of these must be corrected before merge.

### Never place sacred or Quranic text in decorative UI

Do not use Quranic verses (Ayat), the Basmala, the Shahadah, or any Arabic sacred phrase:
- As a loading message or spinner label.
- As placeholder text in form fields.
- As decorative background text.
- As a tooltip or error message.
- As any element that may be dismissed, truncated, overlaid, or treated as boilerplate.

If a use of religious text is genuinely appropriate and intentional (for example, a "Quran resources" app category description written by a qualified contributor), flag it for explicit maintainer review before committing. When in doubt, use architectural/geometric language instead.

This rule exists out of respect. Treat it accordingly.

### Never hardcode hex values, pixels, or font sizes in components

```css
/* WRONG */
.card { background: #1C2B22; color: #E8F0EC; font-size: 14px; }

/* RIGHT */
.card { background: var(--color-surface-raised); color: var(--color-text-primary); font-size: var(--text-sm); }
```

If a token does not exist for a value you need, add the token to `tokens.css` first, then use it. Do not introduce one-off values.

### Never use `left`/`right` physical CSS properties

```css
/* WRONG */
.icon { margin-left: 0.5rem; }

/* RIGHT */
.icon { margin-inline-start: 0.5rem; }
```

### Never show raw technical error messages to users

```tsx
{/* WRONG */}
<p>{error.message}</p>  {/* "ECONNREFUSED /var/run/docker.sock" */}

{/* RIGHT — a plain sentence, a next step, and the detail folded away */}
<ErrorNote
  friendly={t('errors.appUnreachable')}
  action={t('errors.appUnreachableAction')}
  technical={error.message}
/>
```

Show only the friendly message by default and hide the technical detail behind a collapsed
"View details" toggle. Note the strings go through `t()` — a hardcoded English sentence is the
same defect in a different coat.

### Never use spinners as the only loading state

Skeleton shimmers are required for content that takes more than ~200ms to load. A spinner may accompany a skeleton for very short loads, but a spinner alone (without skeleton) is only acceptable for action confirmations (e.g., a button's own loading state during a quick API call).

### Never disable `prefers-reduced-motion` overrides for "just this one animation"

The reduced-motion check in `tokens.css` and in animation presets is unconditional. Do not add `!important` to override it. Do not gate it behind a feature flag. Accessibility is not optional.

### Never use gold as a primary or link color

`--color-accent-500` does not meet 4.5:1 contrast on most surfaces. Gold is for decoration and active-state indicators. If you find yourself reaching for gold for text or interactive affordances, you are using it wrong.

---

*Last updated: 2026-06-18. Changes to this document require explicit discussion and should be accompanied by token updates and a contrast re-verification pass.*
