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

All visual values — colors, typography sizes, spacing, border radii, shadows, motion durations — are defined as **CSS custom properties** in `frontend/src/lib/theme/tokens.css`. Components must reference these variables exclusively. No hardcoded hex values, no magic pixel numbers where a token exists.

Theme switching works by toggling `data-theme="dark"` or `data-theme="light"` on the root `<html>` element. The `:root` block defines dark-mode defaults (dark is the default theme). A `[data-theme="light"]` block overrides the same variable names for light mode.

```css
/* tokens.css structure */

:root {
  /* dark theme — the default */
  --color-bg-base: #0E1814;
  /* ... all tokens ... */
}

[data-theme="light"] {
  --color-bg-base: #F5F0E8;
  /* ... overrides only ... */
}
```

Svelte components consume tokens like this:

```svelte
<style>
  .card {
    background-color: var(--color-surface-raised);
    border-color: var(--color-border-subtle);
    color: var(--color-text-primary);
  }
</style>
```

---

## 3. Complete Token Reference

### 3.1 Color Tokens

All tokens listed with their dark-theme value first, then the light-theme override.

#### Background & Surface

| Token | Dark value | Light value | Usage |
|---|---|---|---|
| `--color-bg-base` | `#0E1814` | `#F5F0E8` | Page background, the lowest layer |
| `--color-bg-subtle` | `#111F18` | `#EDE8DE` | Slightly lifted areas (sidebar, nav) |
| `--color-surface-base` | `#162219` | `#FFFFFF` | Default card/panel surface |
| `--color-surface-raised` | `#1C2B22` | `#F9F6F0` | Elevated cards, modals |
| `--color-surface-overlay` | `#223320` | `#F0EBE2` | Tooltip backgrounds, popovers |
| `--color-surface-sunken` | `#0A1210` | `#E8E3D9` | Input backgrounds, code blocks |

#### Border

| Token | Dark value | Light value | Usage |
|---|---|---|---|
| `--color-border-subtle` | `rgba(255,255,255,0.07)` | `rgba(0,0,0,0.08)` | Dividers, card outlines (low emphasis) |
| `--color-border-default` | `rgba(255,255,255,0.13)` | `rgba(0,0,0,0.15)` | Input borders, section dividers |
| `--color-border-strong` | `rgba(255,255,255,0.25)` | `rgba(0,0,0,0.28)` | Focus rings before primary color is applied |

#### Primary (Emerald/Teal)

| Token | Dark value | Light value | Usage |
|---|---|---|---|
| `--color-primary-900` | `#0A3D2B` | `#0A3D2B` | Darkest — pressed states |
| `--color-primary-800` | `#0E5238` | `#0E5238` | Active/selected backgrounds |
| `--color-primary-700` | `#137047` | `#137047` | Hover backgrounds on primary elements |
| `--color-primary-600` | `#1A8F5C` | `#1A8F5C` | Default primary button background |
| `--color-primary-500` | `#1FA37A` | `#198A68` | Brand color; links, icons, focus rings |
| `--color-primary-400` | `#2DBF93` | `#1FA37A` | Hover for text links |
| `--color-primary-300` | `#52D4A9` | `#2DBF93` | Active/checked indicators |
| `--color-primary-200` | `#96E8CC` | `#52D4A9` | Light fills, chips, badge backgrounds |
| `--color-primary-100` | `#D2F5EA` | `#D2F5EA` | Faintest tint; success backgrounds |

The light-theme primary-500 is shifted slightly darker (`#198A68`) to maintain WCAG AA contrast on light backgrounds. All other steps are shared.

#### Accent (Gold)

| Token | Dark value | Light value | Usage |
|---|---|---|---|
| `--color-accent-800` | `#7A6000` | `#7A6000` | Pressed gold elements |
| `--color-accent-700` | `#A07C00` | `#A07C00` | Hover on gold elements |
| `--color-accent-600` | `#C4980A` | `#B08800` | Active gold highlight |
| `--color-accent-500` | `#D4AF37` | `#B8941E` | The gold — active states, key highlights |
| `--color-accent-400` | `#E3C45A` | `#D4AF37` | Gold on hover |
| `--color-accent-300` | `#EDD98A` | `#E3C45A` | Light gold tint |
| `--color-accent-100` | `#FBF4D6` | `#FBF4D6` | Faintest gold tint |

**Gold is an accent, not a primary color.** Use it for: active sidebar item indicators, star ratings, premium badge borders, highlighted metric values, and nothing else. If gold appears more than a few times per screen, there is too much of it.

#### Text

| Token | Dark value | Light value | Usage |
|---|---|---|---|
| `--color-text-primary` | `#E8F0EC` | `#12201A` | Body text, headings |
| `--color-text-secondary` | `#9DB5A6` | `#3D5C4A` | Supporting text, captions, labels |
| `--color-text-tertiary` | `#627D6E` | `#627D6E` | Placeholders, very soft labels |
| `--color-text-disabled` | `#3D5247` | `#AABFB3` | Disabled form elements |
| `--color-text-inverse` | `#0E1814` | `#F5F0E8` | Text on primary-colored backgrounds |
| `--color-text-link` | `#2DBF93` | `#198A68` | Hyperlinks |
| `--color-text-link-hover` | `#52D4A9` | `#1FA37A` | Link hover state |

#### Semantic / Status

| Token | Dark value | Light value | Usage |
|---|---|---|---|
| `--color-success-bg` | `#0D2E1F` | `#EBF9F3` | Success alert/toast background |
| `--color-success-border` | `#1A6645` | `#52D4A9` | Success border |
| `--color-success-text` | `#52D4A9` | `#0E5238` | Success text |
| `--color-warning-bg` | `#2A1F00` | `#FEF9E7` | Warning alert background |
| `--color-warning-border` | `#8A6000` | `#E3C45A` | Warning border |
| `--color-warning-text` | `#E3C45A` | `#7A5500` | Warning text |
| `--color-error-bg` | `#2A0F0F` | `#FEF2F2` | Error alert background |
| `--color-error-border` | `#8A2020` | `#F87171` | Error border |
| `--color-error-text` | `#F87171` | `#991B1B` | Error text |
| `--color-info-bg` | `#0F1F2A` | `#EFF6FF` | Info alert background |
| `--color-info-border` | `#204A6A` | `#93C5FD` | Info border |
| `--color-info-text` | `#93C5FD` | `#1E40AF` | Info text |

#### App Status Colors

| Token | Dark value | Light value | Usage |
|---|---|---|---|
| `--color-status-running` | `#1FA37A` | `#198A68` | "This app is running" dot/label |
| `--color-status-stopped` | `#627D6E` | `#627D6E` | "Turned off" indicator |
| `--color-status-updating` | `#D4AF37` | `#B8941E` | Update in progress |
| `--color-status-error` | `#F87171` | `#DC2626` | Something went wrong |
| `--color-status-installing` | `#2DBF93` | `#1FA37A` | Install in progress (animated) |

#### Overlay & Scrim

| Token | Dark value | Light value | Usage |
|---|---|---|---|
| `--color-scrim` | `rgba(5,10,8,0.72)` | `rgba(10,20,15,0.55)` | Modal backdrop |
| `--color-geometric-pattern` | `rgba(31,163,122,0.04)` | `rgba(31,163,122,0.06)` | Background geometric texture tint |

### 3.2 Non-Color Tokens

#### Border Radius

| Token | Value | Usage |
|---|---|---|
| `--radius-sm` | `0.25rem` | Chips, badges, small buttons |
| `--radius-md` | `0.5rem` | Input fields, secondary cards |
| `--radius-lg` | `0.875rem` | Primary cards, panels |
| `--radius-xl` | `1.25rem` | Feature cards, large modals |
| `--radius-2xl` | `2rem` | Full-rounded pill buttons, avatar chips |
| `--radius-arch` | `50% 50% 0 0 / 30% 30% 0 0` | The mihrab/arch shape — use `border-radius` shorthand on top of a card for the arch-top motif |
| `--radius-full` | `9999px` | Circles, toggle tracks |

#### Shadow

| Token | Dark value | Light value | Usage |
|---|---|---|---|
| `--shadow-sm` | `0 1px 3px rgba(0,0,0,0.4)` | `0 1px 3px rgba(0,0,0,0.08)` | Subtle card lift |
| `--shadow-md` | `0 4px 12px rgba(0,0,0,0.5)` | `0 4px 12px rgba(0,0,0,0.12)` | Default card shadow |
| `--shadow-lg` | `0 8px 32px rgba(0,0,0,0.6)` | `0 8px 32px rgba(0,0,0,0.18)` | Raised modals, dropdowns |
| `--shadow-glow-primary` | `0 0 20px rgba(31,163,122,0.25)` | `0 0 16px rgba(31,163,122,0.18)` | Primary button hover glow |
| `--shadow-glow-accent` | `0 0 16px rgba(212,175,55,0.30)` | `0 0 12px rgba(184,148,30,0.22)` | Accent/gold hover glow |

#### Spacing Scale

Use Tailwind's spacing scale for most layout needs. The tokens below exist for values that must be consistent across components and cannot be expressed as Tailwind utilities.

| Token | Value | Usage |
|---|---|---|
| `--space-page-gutter` | `clamp(1rem, 4vw, 2.5rem)` | Horizontal page margin |
| `--space-card-padding` | `1.25rem` | Default card inner padding |
| `--space-section-gap` | `2rem` | Gap between major sections |

#### Motion Tokens

See Section 7 for full motion guidelines. Tokens:

| Token | Value | Usage |
|---|---|---|
| `--duration-instant` | `0ms` | Used when `prefers-reduced-motion: reduce` is active |
| `--duration-fast` | `120ms` | Button press, toggle flick |
| `--duration-normal` | `220ms` | Card enter, modal open |
| `--duration-slow` | `380ms` | Page transition, splash assembly |
| `--duration-deliberate` | `600ms` | Multi-step progress animations |
| `--easing-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Spring-like overshoot for lifts and pops |
| `--easing-smooth` | `cubic-bezier(0.4, 0, 0.2, 1)` | Standard material-style smooth |
| `--easing-in` | `cubic-bezier(0.4, 0, 1, 1)` | Elements leaving the screen |
| `--easing-out` | `cubic-bezier(0, 0, 0.2, 1)` | Elements entering the screen |

---

## 4. Switching Themes

The theme is controlled exclusively by the `data-theme` attribute on `<html>`. The Svelte theme store manages this:

```typescript
// frontend/src/lib/theme/themeStore.ts
import { browser } from '$app/environment';
import { writable } from 'svelte/store';

type Theme = 'dark' | 'light';

const stored = browser
  ? (localStorage.getItem('omos-theme') as Theme | null)
  : null;

// Dark is the default. Only use light if explicitly chosen.
export const theme = writable<Theme>(stored ?? 'dark');

theme.subscribe((value) => {
  if (!browser) return;
  document.documentElement.setAttribute('data-theme', value);
  localStorage.setItem('omos-theme', value);
});
```

Apply the attribute server-side (in `app.html`) to prevent a flash of wrong theme:

```html
<!-- app.html -->
<script>
  // Inline script — runs before paint
  const t = localStorage.getItem('omos-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', t);
</script>
```

**Rule:** Never read `data-theme` in component logic. Import and subscribe to the `theme` store if you need to react to theme changes. Never apply theme classes to individual components — the token system handles everything at the `:root` level.

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
- File lives at `frontend/src/lib/theme/geometric-pattern.svg` and is inlined at build time.

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

OpenMasjidOS ships a small set of custom masjid glyphs alongside `lucide-svelte`. These are SVG components, not an icon font. Each glyph is designed on a 24×24 viewBox with a 1.5px stroke, matching the Lucide visual style.

### The Glyph Set

| Glyph | Component name | Usage |
|---|---|---|
| Dome | `<IconDome />` | Dashboard home, app category: displays |
| Minaret | `<IconMinaret />` | Settings, administration apps |
| Crescent + star | `<IconCrescent />` | Quran/Islamic resources category, brand mark |
| Mihrab arch | `<IconMihrab />` | Empty states for app listings, prayer category |

All four glyphs live in `frontend/src/lib/components/icons/`. They accept `size`, `color`, and `aria-label` props. Always provide `aria-label` or pair with a visible label — do not use these as purely decorative elements without an `aria-hidden="true"`.

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

This rule goes into `tokens.css` and overrides everything. When building a Svelte transition, also check the motion preference in the transition function and return `{ duration: 0 }` when reduced motion is requested:

```typescript
// frontend/src/lib/animations/index.ts
import { prefersReducedMotion } from '$lib/animations/reducedMotion';

export function cardEnter(node: Element, params = {}) {
  if (prefersReducedMotion()) return { duration: 0 };
  return {
    duration: 220,
    easing: cubicOut,
    css: (t: number) => `
      opacity: ${t};
      transform: translateY(${(1 - t) * 8}px);
    `
  };
}
```

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

All transition and spring presets live in `frontend/src/lib/animations/`. Do not define `cubic-bezier` values or duration numbers ad hoc in component `<style>` blocks — import a preset. This ensures global consistency and makes reduced-motion overrides maintainable in one place.

---

## 9. RTL Support

OpenMasjidOS targets Arabic and Urdu as first-tier RTL locales. RTL support is not an afterthought — it is built in from the start.

### The `dir` Attribute

The root layout sets `dir` based on the active locale:

```svelte
<!-- +layout.svelte -->
<svelte:head>
  <html lang={$locale} dir={$isRTL ? 'rtl' : 'ltr'} />
</svelte:head>
```

The `isRTL` store derives from the locale store and is the single source of truth. Never check locale strings directly in components to decide direction.

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
3. **Automated**: `make lint` runs `@accessibility/color-contrast` checks as part of `svelte-check`. Any failure blocks the build.

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

```svelte
<!-- WRONG -->
<p>{error.message}</p>  <!-- "ECONNREFUSED 127.0.0.1:2375" -->

<!-- RIGHT -->
<ErrorMessage
  friendly="We could not reach the app right now."
  action="Try refreshing, or check that Docker is running."
  technical={error.message}
/>
```

The `<ErrorMessage>` component shows only the friendly message by default and hides the technical detail behind a "View details" toggle (collapsed by default).

### Never use spinners as the only loading state

Skeleton shimmers are required for content that takes more than ~200ms to load. A spinner may accompany a skeleton for very short loads, but a spinner alone (without skeleton) is only acceptable for action confirmations (e.g., a button's own loading state during a quick API call).

### Never disable `prefers-reduced-motion` overrides for "just this one animation"

The reduced-motion check in `tokens.css` and in animation presets is unconditional. Do not add `!important` to override it. Do not gate it behind a feature flag. Accessibility is not optional.

### Never use gold as a primary or link color

`--color-accent-500` does not meet 4.5:1 contrast on most surfaces. Gold is for decoration and active-state indicators. If you find yourself reaching for gold for text or interactive affordances, you are using it wrong.

---

*Last updated: 2026-06-18. Changes to this document require explicit discussion and should be accompanied by token updates and a contrast re-verification pass.*
