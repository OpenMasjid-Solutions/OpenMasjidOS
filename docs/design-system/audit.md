<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# OpenMasjidOS — React Bits Pro migration audit

OpenMasjidOS is the self-hosted **platform** a masjid runs on its own hardware: a Node/Fastify +
tRPC daemon (`packages/core`) that manages Docker apps, and a single-page dashboard
(`packages/ui`) that the daemon also serves as static assets. It is **not** the masjid-facing
admin app — there is no prayer timetable, members list, donations page or events screen in this
repo, by design (`CLAUDE.md` §4 / §13 forbid masjid data in the platform). The frontend is
**React 18.3.1** + **react-dom 18.3.1**, **Vite 6.4.3** (`@vitejs/plugin-react`), **react-router-dom
7.18.2** (declarative `<Routes>` in `packages/ui/src/Root.tsx`, not file-based), and **Tailwind CSS
4.3.1** wired through `@tailwindcss/vite` — but see §4 and §6: Tailwind is installed and imported
and then **not used**; all styling is hand-written BEM-ish CSS over CSS custom properties. There is
no shadcn/ui, no `components.json`, and no Radix. In scope: **8 router routes**, **2 auth states**,
**8 Settings sections**, **12 in-dashboard window surfaces** and **~22 distinct dialog/overlay
surfaces**, implemented by **46 `.tsx` files / 8,746 lines** under `packages/ui/src` (largest:
`routes/Settings.tsx` at 3,629 lines) plus **1,711 lines of CSS**.

> **A note on the category mapping.** The screen→category mapping supplied by the directive was
> written for the masjid **admin** product (Prayer timetable, Members, Donations, Announcements,
> Display nodes …). None of those screens exist in this repo. Rows below use the mapping where a
> row genuinely applies (Shell & navigation, Dashboard/home, Settings, Auth & first run, Files &
> media, Empty/loading/error) and otherwise pick the closest category from the fixed RB category
> list, marked **(no mapping row)**.

---

## 1. Screen map

Routes are declared in `packages/ui/src/Root.tsx` (react-router-dom `<BrowserRouter>` +
`<Routes>`). Every route renders inside `AppShell`, which only mounts when `auth.me` reports an
authenticated session — so the auth gate is structural, not per-route.

| Route / screen | Current component file(s) | RB category | Variant | Status |
|---|---|---|---|---|
| **Shell** — authenticated desktop shell (splash, topbar, main, window manager, dock) | `components/AppShell.tsx` | app-shell | PENDING | not started |
| **Top bar** — glass clock + profile/sign-out menu | `components/Clock.tsx`, `components/ProfileMenu.tsx` | navbar | PENDING | not started |
| **Dock** — floating bottom nav: primary links, pinned apps (HTML5 drag reorder), minimised windows, hover preview | `components/Dock.tsx` | app-sidebar | PENDING | not started |
| **Window manager** — draggable / minimisable in-dashboard windows that survive route changes | `components/Windows.tsx`, `components/WindowManager.tsx` | app-shell + app-dialog | PENDING | not started |
| **Command menu** — **does not exist.** No `cmdk`, `kbar` or palette anywhere in `packages/ui` | — (to be built) | command-menu | PENDING | not started |
| **Mobile / narrow layout** — no mobile-specific components; **one** breakpoint in the whole UI (`styles/app.css:1138`, `max-width: 56rem`, settings nav only) | `styles/app.css` | mobile | PENDING | not started |
| `/` — Dashboard: 6-card live stats strip + installed-apps grid + update / dev-channel banners | `routes/Dashboard.tsx` (362), `components/StatCard.tsx`, `components/AppCard.tsx` | dashboard + analytics + card | PENDING | not started |
| `/store` — App Store: catalog grid, search filter, skeletons, install modal | `routes/Store.tsx` (313) | integrations + card + filtering *(no mapping row)* | PENDING | not started |
| `/store/custom` — 3rd-party hub, two tabs: Community (CasaOS repos) and Docker Compose paste | `routes/StoreCustom.tsx` (453), `components/PortConflicts.tsx` | integrations + forms + list *(no mapping row)* | PENDING | not started |
| `/apps/:id` — App detail: icon / screenshots / description, actions, review gate | `routes/AppDetail.tsx` (220) | card + settings-form + monitoring *(no mapping row)* | PENDING | not started |
| `/files` — File Explorer: breadcrumbs, drag-drop upload, rename-in-place, download, delete | `routes/Files.tsx` (283), `components/FileViewer.tsx`, `lib/files.ts` | file-manager | PENDING | not started |
| `/settings` — Settings shell, defaults to the `appearance` pane | `routes/Settings.tsx` (3,629) | settings-form + integrations | PENDING | not started |
| `/settings/:section` — one of eight panes (below) | `routes/Settings.tsx` | settings-form + integrations | PENDING | not started |
| `*` — Not found | `routes/NotFound.tsx` (24), `components/Glyphs.tsx` (`MasjidScene`) | empty-state | PENDING | not started |
| **First run** — create the admin account (name + email + password, theme pick) | `components/AuthScreen.tsx` (`setupRequired` branch) | onboarding + authentication | PENDING | not started |
| **Login** — username-or-email + password, rate-limited | `components/AuthScreen.tsx` | authentication | PENDING | not started |

### Settings sections

Enumerated by `SECTIONS` at `routes/Settings.tsx:226`; each is addressable as `/settings/<id>` and
gated by a `show('<id>')` call. `test/settings-nav.test.ts` fails the build if any of the three
pieces (list entry, `show()` gate, `settings.nav.<id>` string) is missing.

| Route / screen | Current component file(s) | RB category | Variant | Status |
|---|---|---|---|---|
| `/settings/appearance` — theme, 5 accents, 9 wallpapers, custom wallpaper URL, dashboard name, masjid logo upload, clock / timezone / 12-24h, splash | `routes/Settings.tsx:437`, `lib/prefs.ts`, `components/AppearanceSync.tsx` | settings-form | PENDING | not started |
| `/settings/account` — admin name, email, phone (`PhoneField`), password change | `routes/Settings.tsx:568`, `components/PhoneField.tsx` | settings-form | PENDING | not started |
| `/settings/email` — SMTP or Resend provider, From name / address, send-test | `routes/Settings.tsx:571` | settings-form + integrations | PENDING | not started |
| `/settings/whatsapp` — Setup / Groups / Commands sub-strip (local state, not the URL) | `routes/Settings.tsx:578` | settings-form + integrations | PENDING | not started |
| `/settings/alerts` — per-alert × per-channel matrix (Email / Webhook / WhatsApp) | `routes/Settings.tsx:580` | notifications + settings-form | PENDING | not started |
| `/settings/payments` — Stripe account vault, status dots, dispute polling | `routes/Settings.tsx:590` | billing + integrations | PENDING | not started |
| `/settings/remote` — Cloudflare tunnel, per-app exposure, tunnel refusal log | `routes/Settings.tsx:593` | integrations + monitoring | PENDING | not started |
| `/settings/advanced` — custom apps, app shells, root terminal, network info, update channel, check-for-updates, backup / restore, SSL, source link | `routes/Settings.tsx:595`, `components/UpdateChannel.tsx`, `components/ChannelMigrate.tsx` | settings-form + monitoring | PENDING | not started |

### Window surfaces (`windows.open(...)`)

| Route / screen | Current component file(s) | RB category | Variant | Status |
|---|---|---|---|---|
| App update progress (per app) | `components/AppCard.tsx:88`, `routes/Dashboard.tsx:113`, `components/AppUpdate.tsx` | monitoring + app-dialog | PENDING | not started |
| Update-all-apps (sequential) | `routes/Dashboard.tsx:133`, `components/UpdateAllApps.tsx` | monitoring + app-dialog | PENDING | not started |
| App shell (xterm terminal into a container) | `components/AppCard.tsx:99`, `components/LazyTerminal.tsx`, `components/Terminal.tsx` | monitoring *(no mapping row)* | PENDING | not started |
| App logs (live stream) | `components/AppCard.tsx:109`, `components/AppLogs.tsx`, `components/LogStream.tsx` | monitoring | PENDING | not started |
| OpenWA gateway logs | `routes/Settings.tsx:2148` | monitoring | PENDING | not started |
| File viewer / text editor | `routes/Files.tsx:85`, `components/FileViewer.tsx` | file-manager + editor | PENDING | not started |
| Channel migrate (move apps after a channel switch) | `routes/Settings.tsx:330`, `components/ChannelMigrate.tsx` | monitoring + wizard | PENDING | not started |
| Root terminal | `routes/Settings.tsx:370` | monitoring *(no mapping row)* | PENDING | not started |
| Source-code / AGPL note | `routes/Settings.tsx:387` (`EagerNote`) | card | PENDING | not started |
| Backup setup (rclone remote) | `routes/Settings.tsx:1226` | settings-form + wizard | PENDING | not started |
| Stripe account add / edit | `routes/Settings.tsx:3230` | billing + forms | PENDING | not started |
| "What's new" changelog | `components/ChangelogWindow.tsx`, `components/Changelog.tsx`, `lib/changelog.ts` | notifications + card | PENDING | not started |

### Dialog and overlay surfaces (`<Modal>` / `<ConfirmDialog>` / transient)

| Route / screen | Current component file(s) | RB category | Variant | Status |
|---|---|---|---|---|
| Base modal (portal, backdrop, `locked` mode, `aria-modal`) | `components/Modal.tsx` | app-dialog | PENDING | not started |
| Generic confirm (title / body / cost / confirm label) | `components/ConfirmDialog.tsx` | app-dialog | PENDING | not started |
| App install (settings form generated from the manifest) | `routes/Store.tsx:230` (`InstallModal`) | forms + wizard | PENDING | not started |
| Community app install confirm | `routes/StoreCustom.tsx:287` | app-dialog | PENDING | not started |
| Port-conflict remap | `components/PortConflicts.tsx` (used at `StoreCustom.tsx:311, 415`) | forms | PENDING | not started |
| App remove confirm | `components/AppCard.tsx:280` | app-dialog | PENDING | not started |
| App update available | `components/AppCard.tsx:327` | app-dialog + notifications | PENDING | not started |
| Restored-app review gate | `components/AppReviewDialog.tsx` (`AppCard.tsx:313`, `AppDetail.tsx:164`) | app-dialog | PENDING | not started |
| Core update (live log, locked until done) | `components/UpdateModal.tsx` (`Dashboard.tsx:359`, `Settings.tsx:756`) | app-dialog + monitoring | PENDING | not started |
| Update-channel switch confirm (incl. the dev→main downgrade warning) | `components/UpdateChannel.tsx:149` | app-dialog | PENDING | not started |
| Restore from backup (upload) | `components/RestoreModal.tsx` (`AuthScreen.tsx:286`, `Settings.tsx:774`) | app-dialog + file-manager | PENDING | not started |
| Restore confirm (post-upload) | `routes/Settings.tsx:758` | app-dialog | PENDING | not started |
| Reboot confirm | `routes/Settings.tsx:776` | app-dialog | PENDING | not started |
| SSL certificate upload | `routes/Settings.tsx:941` | forms | PENDING | not started |
| WhatsApp enable (ban-risk accept) | `routes/Settings.tsx:1971` | app-dialog | PENDING | not started |
| WhatsApp disable (keep-or-delete choice) | `routes/Settings.tsx:1991` | app-dialog | PENDING | not started |
| WhatsApp unlink handset | `routes/Settings.tsx:2048` | app-dialog | PENDING | not started |
| WhatsApp discard held queue | `routes/Settings.tsx:2419` | app-dialog | PENDING | not started |
| WhatsApp group test message | `routes/Settings.tsx:2663` | app-dialog | PENDING | not started |
| Admin-commands enable (risk accept) | `routes/Settings.tsx:3098` | app-dialog | PENDING | not started |
| Command trustee remove | `routes/Settings.tsx:3111` | app-dialog | PENDING | not started |
| Stripe account remove | `routes/Settings.tsx:3302` | app-dialog | PENDING | not started |
| Password-reset help (points at the installer) | `components/AuthScreen.tsx:275` | app-dialog + authentication | PENDING | not started |
| New folder | `routes/Files.tsx:255` | file-manager + forms | PENDING | not started |
| Delete file confirm | `routes/Files.tsx:272` | file-manager + app-dialog | PENDING | not started |
| Toasts (transient, `aria-live`) | `components/ToastProvider.tsx` | notifications | PENDING | not started |
| Splash / Suspense fallback | `components/Splash.tsx`, `components/Glyphs.tsx` | preloader | PENDING | not started |
| Error boundary | `components/ErrorBoundary.tsx` | empty-state | PENDING | not started |
| Skeletons (5 mount points: Store, Files, AppDetail ×2, ChangelogWindow) | `.skeleton` in `styles/app.css:880-890` | block-native skeletons | PENDING | not started |

---

## 2. Animation inventory

**Libraries present:** `motion` **11.18.2** (the renamed Framer Motion), imported as `motion/react`
in **13 files**. **No gsap, no react-spring, no lottie** anywhere in `packages/ui` or
`packages/core`. **Zero** Tailwind `animate-*` or `transition-*` utility classes — a strict scan of
all 135 distinct class names used in JSX found no Tailwind utilities at all (see §3 / §6).

| Source | Where (file:line) | What it does | RB replacement |
|---|---|---|---|
| Motion preset | `lib/motion.ts:12` (`springSoft`) | Shared spring (stiffness 320, damping 30, mass 0.9) that every other preset composes | removed |
| Motion preset | `lib/motion.ts:15` (`fadeRise`) | Route / page entrance: opacity 0→1, y 12→0; exit y 0→−8 | block-native |
| Motion preset | `lib/motion.ts:22` (`staggerContainer`) | Grid container, `staggerChildren: 0.05`, `delayChildren: 0.04` | animated-list-tw |
| Motion preset | `lib/motion.ts:27` (`staggerItem`) | Card entrance: opacity + y 14 + scale 0.98, spring | animated-list-tw |
| Motion inline | `components/Dock.tsx:29, 98` (`reorderSpring`) | `layout` spring (stiffness 600, damping 38) so pinned dock apps slide when reordered | magic-transform-tw |
| Motion inline | `components/Modal.tsx:88-90` | Backdrop opacity fade | modal-cards-tw |
| Motion inline | `components/Modal.tsx:96-98` | Panel: scale 0.94→1, y 12→0, `blur(8px)`→`blur(0px)` | modal-cards-tw |
| Motion inline | `components/Splash.tsx:14-15` | Splash wrapper fade-out on exit | preloader-tw |
| Motion inline | `components/Splash.tsx:20-22` | `MasjidMark` assembly: scale 0.8→1, rotate −8°→0, spring | preloader-tw |
| Motion inline | `components/ToastProvider.tsx:45-47` | Toast enter / exit: opacity + y 16 | block-native |
| Motion usage | `components/Page.tsx:10` | Applies `fadeRise` to every route's content | block-native |
| Motion usage | `routes/Dashboard.tsx:180, 352`; `routes/Store.tsx:131, 135`; `components/StatCard.tsx:22`; `components/AppCard.tsx:176`; `components/AuthScreen.tsx:106` | 7 mount points consuming the 4 shared presets | animated-list-tw |
| Motion orchestration | `App.tsx:66` (`<MotionConfig reducedMotion="user">`) | The single thing that makes Motion honour `prefers-reduced-motion` — CSS cannot reach Motion's JS-written inline styles | block-native (must be re-established) |
| `AnimatePresence` | `components/AppShell.tsx:45`, `components/Modal.tsx:84`, `components/ToastProvider.tsx:40` | Exit-animation orchestration for splash, modals, toasts | block-native |
| `@keyframes` | `styles/app.css:72` (`auroraDrift`), used `:70` | 32 s infinite-alternate drift of the aurora backdrop; disabled under reduced motion (`app.css:839`) | removed |
| `@keyframes` | `styles/app.css:661` (`winIn`), used `:660` | 0.24 s window-open entrance; disabled under reduced motion (`app.css:836`) | modal-cards-tw |
| `@keyframes` | `styles/app.css:875` (`spin`), used `:871` | `.spinner` — 0.7 s linear infinite, 8 JSX mount points | preloader-tw |
| `@keyframes` | `styles/app.css:886` (`shimmer`), used `:884` | `.skeleton` — 1.4 s shimmer, 5 JSX mount points | block-native |
| `@keyframes` | `styles/glass.css:117` (`pulseGlow`), used `:110` | `.status-dot::after` — 2.4 s pulse; disabled under reduced motion (`glass.css:123`) | block-native |
| CSS transition | `styles/app.css:149` (`.dock-item`) | Dock tile lift + colour on hover | block-native |
| CSS transition | `styles/app.css:227` (`.profile-btn`) | Transform on hover / press | block-native |
| CSS transition | `styles/app.css:304` (`.gauge-fill`) | Stat-card gauge width animates to the new live value | simple-graph-tw |
| CSS transition | `styles/app.css:319` (`.app-card`) | Card lift + shadow on hover | block-native |
| CSS transition | `styles/app.css:450` (`.btn`) | Press / hover transform, background, opacity | block-native |
| CSS transition | `styles/app.css:471` (`.btn--primary::after`) | 0.7 s sheen sweep across the primary button | block-native |
| CSS transition | `styles/app.css:529` (`.toggle`) | Track colour | block-native |
| CSS transition | `styles/app.css:541` (`.toggle::after`) | Knob travel | block-native |
| CSS transition | `styles/app.css:724` (`.tl`) | Dock tile filter + transform | hover-preview-tw |
| CSS transition | `styles/app.css:734` (`.tl svg`) | Tile icon fade | hover-preview-tw |
| CSS transition | `styles/app.css:760` (`.dock-pop`) | Dock hover preview (name / live window thumbnail) fade + rise | hover-preview-tw |
| CSS transition | `styles/app.css:1116` (`.settings-nav__item`) | Settings nav item hover / active | block-native |
| CSS transition | `styles/tokens.css:351` | Theme-flip fade — background / border / colour / shadow over 0.2 s, scoped to a named selector list rather than `*` | block-native |
| Inline CSS transition | `components/AuthScreen.tsx:197` | Theme-swatch background fade on the first-run theme picker | block-native |
| JS rAF effect | `lib/cursorFx.ts` (whole file) | Pointer-tracking `--mx` / `--my` glint on `.fx-glint` panes; rAF-throttled, bails out under reduced motion and on coarse pointers | removed |

**Total distinct animation definitions: 30** — 10 Motion definitions (4 shared presets + 5 inline
specs + 1 named dock spring), 5 `@keyframes`, 14 transition declarations (13 CSS rules + 1 inline
JSX style; a 14th CSS `transition:` at `app.css:837` is a reduced-motion override, not a
definition), and 1 rAF-driven pointer effect.

---

## 3. Third-party UI inventory

Only two workspaces have a `package.json` (`packages/core`, `packages/ui`); the core has no UI
dependencies. Versions are the exact resolutions from `package-lock.json`.

| Package | Version | Used where | Disposition |
|---|---|---|---|
| `react` | 18.3.1 | everywhere | kept — **must go to 19** (§6) |
| `react-dom` | 18.3.1 | `main.tsx` (`createRoot` + `<React.StrictMode>`) | kept — **must go to 19** (§6) |
| `react-router-dom` | 7.18.2 | `App.tsx` (`BrowserRouter`), `Root.tsx` (`Routes`), `Dock.tsx` / `Settings.tsx` (`NavLink`) | kept |
| `motion` | 11.18.2 | 13 files; see §2 | removed (RB motion primitives replace it; the `reducedMotion="user"` guarantee must be re-established) |
| `lucide-react` | 0.460.0 | 17 import sites, ~21 distinct icons (`Cpu`, `MemoryStick`, `HardDrive`, `Thermometer`, `Clock`, `Boxes`, `AlertTriangle`, `Sparkles`, `Download`, `Beaker`, `Upload`, `Store`, `Settings`, `FolderOpen`, `AppWindow`, `KeyRound`, `Bell`, `MessageCircle`, `CreditCard`, `Globe`, `SlidersHorizontal`) | **kept** — shadcn/ui and RB both build on lucide |
| `clsx` | 2.1.1 | `lib/cn.ts`, consumed across components | **kept** — the shadcn/RB `cn()` primitive. Note `tailwind-merge` is **not** installed; `lib/cn.ts` is clsx alone and will need it |
| `@tanstack/react-query` | 5.101.0 | `App.tsx` + every data component via tRPC | kept (data layer, not UI) |
| `@trpc/client`, `@trpc/react-query`, `@trpc/server` | 11.x | `lib/trpc.ts`, `lib/trpcClient.ts` | kept (data layer) |
| `i18next` | 23.16.8 | `lib/i18n/index.ts` | kept (see §5) |
| `react-i18next` | 15.7.4 | every component with copy | kept |
| `@xterm/xterm` | 5.5.0 | `components/Terminal.tsx` (root shell, per-app shells), lazy-loaded via `LazyTerminal.tsx` | **kept** — no RB equivalent; a real terminal emulator over a WebSocket |
| `@xterm/addon-fit` | 0.10.0 | `components/Terminal.tsx` | kept |
| `@fontsource-variable/inter` | 5.2.8 | `main.tsx`; backs `--font-sans` | see §4 — self-hosted; keep or re-decide |
| `@fontsource-variable/space-grotesk` | 5.2.10 | `main.tsx`; backs `--font-display` | see §4 |
| `tailwindcss` | 4.3.1 | `index.css` (`@import "tailwindcss"`) — **imported, never used** | kept and **actually adopted** (§6) |
| `@tailwindcss/vite` | 4.3.1 | `vite.config.ts` | kept |
| `vite` | 6.4.3 | dev server (`/trpc` + `/api` proxy to :8723) and build (manual vendor chunks) | kept |
| `typescript` | 5.9.3 | `npm run lint` = `tsc --noEmit`, the only typecheck | kept |

**Absent entirely** — confirmed by grep across both workspaces: MUI, Chakra, Mantine, Headless UI,
**Radix** (so no shadcn/ui primitives at all), any date picker, any chart library (the gauges are
hand-rolled `div`s), any toast library (`ToastProvider.tsx` is bespoke), any carousel, any
drag-and-drop library (the dock uses native HTML5 drag events on purpose — see the comment at
`Dock.tsx:11`), any rich-text editor.

---

## 4. Token inventory

`packages/ui/src/styles/tokens.css` (368 lines) is the single source of truth. **62 distinct custom
properties.** There is **no Tailwind `@theme` block, no `@apply`, no `tailwind.config.*`** — the
tokens are plain CSS variables flipped by `data-theme` / `data-wallpaper` on `<html>`, not Tailwind
theme tokens.

| Token kind | Where defined | Count | Disposition |
|---|---|---|---|
| Fonts | `styles/tokens.css:220-222` (`--font-sans`, `--font-display`); files loaded in `main.tsx` from `@fontsource-variable/*` | 2 | re-map to the RB type scale; keep self-hosted — no CDN, because an offline / LAN-only masjid box must still render |
| Colour tokens | `styles/tokens.css` `--color-*`, defined twice (dark `:root,[data-theme="dark"]`; light `[data-theme="light"]`) | 24 per theme (48 declarations) | re-map to RB tokens; the light/dark pairing is non-negotiable |
| Accent palette (runtime) | `lib/prefs.ts:57` `ACCENTS` — 5 entries of `{primary, hover, subtle, onPrimary}`; `applyAccent` writes 6 inline custom properties onto `<html>`, beating the stylesheet | 5 × 4 = 20 values | keep the **mechanism** — RB tokens must stay overridable at runtime the same way |
| Wallpaper scenes | `styles/tokens.css:236-347` — 9 dark `[data-wallpaper]` blocks + 9 `[data-theme="light"][data-wallpaper]` counterparts; catalogue at `lib/prefs.ts:68` `WALLPAPERS` | 18 blocks / 9 wallpapers | keep — `test/theme-tokens.test.ts` fails the build if a wallpaper lacks its light counterpart |
| Glass tokens | `styles/tokens.css` `--glass-*` plus `--glint` / `--glint-strong` (blur ×3, saturate ×2, bg ×3, tint, highlight, border, glow, 2 composed shadows) | 16 | likely removed — but this is the product's entire visual identity, so dropping it is a design decision, not a cleanup |
| Radii | `styles/tokens.css` `--radius-card` (1rem), `--radius-button` (0.625rem); plus `--radius-sm` declared ad hoc in `styles/app.css` | 3 | re-map to the RB radius scale |
| Shadows | `styles/tokens.css` `--shadow-card`, `--shadow-modal`, `--glass-shadow`, `--glass-shadow-raised`, `--glow-primary`, `--glow-strength` | 6 | re-map |
| Spacing scale | **none.** No `--space-*`, `--gap-*` or `--size-*` token exists; `app.css` / `glass.css` use **60 distinct hard-coded `rem` values** | 0 tokens / 60 literals | replaced by the Tailwind spacing scale — the single biggest mechanical win of the migration |
| Z-index scale | **none.** 9 raw `z-index` values in CSS (`-1, 1, 2, 5, 40, 50, 60, 250, 260`) plus 3 in JSX (`200` at `AppCard.tsx:184`, `300` at `AppShell.tsx:47`, `110 + i` at `WindowManager.tsx:41`) | 0 tokens / 12 literals | must become a real scale — window stacking vs dock vs splash is currently held together by comments |
| Motion tokens | `styles/tokens.css:214-218` — `--ease-settle` (a `linear()` spring curve), `--dur-micro` 140 ms, `--dur-settle` 420 ms, `--lift-y` −6px, `--tilt-max` 7deg | 5 | removed / re-map to RB motion |
| Scene + aurora | `--scene-base`, `--scene-gradient`, `--scene-vignette`, `--aurora-cyan/navy/gold/blur`, `--pattern-opacity`, `--geometric-pattern` (an inline SVG data-URI girih tile) | 10 | keep `--geometric-pattern` — it is the masjid identity per `CLAUDE.md` §14; the rest are scene-specific |
| Breakpoints | **one**, `styles/app.css:1138` (`max-width: 56rem`), affecting only the settings nav | 1 | replaced by Tailwind breakpoints |

**Primary brand accent, both themes** (verbatim from `styles/tokens.css`):

- **Dark** (the default): `--color-primary: #22D3EE` (cyan), hover `#67E8F9`, on-primary ink
  `--color-on-primary: #00131c`. Secondary accent `--color-accent` / `--color-gold: #F59E0B`.
  Base surface `--color-surface: #030D1A`.
- **Light**: `--color-primary: #0284C7`, hover `#0369A1`, button `--color-btn: #0369A1`, ink
  `--color-on-primary: #FFFFFF`. Secondary accent `#D97706`. Base surface `#F0F9FF`.
- Cyan is also the default of the 5 user-selectable accents (`lib/prefs.ts:62`), whose primaries are
  `#22D3EE` (Cyan), `#2DD4BF` (Teal), `#38BDF8` (Sky), `#A78BFA` (Violet), `#FBBF24` (Gold).

---

## 5. RTL / i18n inventory

**Library:** `i18next` 23.16.8 + `react-i18next` 15.7.4, initialised at `lib/i18n/index.ts`.

**Locales actually registered: one — `en`.** The init call is
`resources: { en: { translation: en } }, lng: 'en', fallbackLng: 'en'`. The `lib/i18n/` directory
contains exactly two files (`en.json`, `index.ts`); there is no second locale file anywhere in the
repo. `en.json` holds **778 leaf keys** (52 KB). There is deliberately **no language picker** in
Settings — `CLAUDE.md` §13.1 states this explicitly. The `language` pref exists in `lib/prefs.ts`
and defaults to `'en'`, but nothing in the UI can change it.

**`dir="rtl"`:** set in exactly one place — `lib/prefs.ts:127`,
`document.documentElement.setAttribute('dir', RTL_LANGS.has(lang) ? 'rtl' : 'ltr')`, where
`RTL_LANGS = new Set(['ar', 'ur'])` (`lib/prefs.ts:81`). It is reached from `applyLanguage`, called
by `prefsStore.hydrate()` (`prefs.ts:196`) and on a language-pref change (`prefs.ts:167`). Since no
UI can set `language` to anything but `'en'`, **the RTL code path is wired but never taken at
runtime.** `packages/ui/index.html` hard-codes `lang="en"` and sets no `dir`.

**Physical vs logical CSS** (across `packages/ui/src`, `.css` + `.tsx`):

| Direction | Occurrences | Detail |
|---|---|---|
| **Physical** | **4 total** | `left:` only. `app.css:644` (`left: 0` on a full-bleed overlay), `app.css:647` (`left: 50%` centring), `WindowManager.tsx:85` (`left: '2vw'`, fullscreen frame) and `:87` (`left: pos.x`, a dragged window). **Zero** `right:`, `margin-left/right`, `padding-left/right`, `border-left/right`, `text-align: left\|right`. |
| **Logical** | **35 total** | `inline-start` ×13, `inset-inline` ×7, `margin-inline` ×6, `padding-inline` ×3, `border-inline` ×3, `text-align: start` ×3, `inline-end` ×2 |

An unusually clean ratio — **35 logical to 4 physical**, and three of the four physical uses are
geometric (centring, viewport placement) rather than directional. The one genuine RTL gap is
`WindowManager.tsx:85-87`, where a window's dragged position is stored and applied as `left`, so
window placement would not mirror.

**Dates / times / currency:**

- **No Hijri / Islamic-calendar handling anywhere.** Grep for `hijri|islamic|umalqura` across both
  workspaces returns only prose in `docs/THEMING.md` and `CLAUDE.md` about *geometric art*. Dates
  are Gregorian only — consistent with §4 scope, since prayer and calendar logic belong to apps.
- **Time:** `components/Clock.tsx:14-26` uses `Intl.DateTimeFormat(undefined, …)` — locale from the
  browser, `hour12: !clock24h` from the pref, `timeZone` from the `timezone` pref (empty string =
  the device's zone). This is the only properly preference-aware formatter in the UI.
- **Other timestamps:** `routes/Settings.tsx` calls bare `toLocaleDateString()` / `toLocaleString()`
  / `toLocaleTimeString()` at 8 sites (`:895, :921, :1270, :1271, :2797, :2807, :3074, :3075`).
  These ignore the `timezone` and `clock24h` prefs — a pre-existing inconsistency, worth fixing
  during the rebuild rather than reproducing.
- **Bytes / uptime / percent:** `lib/format.ts` — hand-rolled, English unit suffixes
  (`B/KB/MB/GB/TB`, `d/h/m`), **not** routed through i18next and not locale-aware.
- **Currency:** server-side only, `packages/core/src/stripe/disputes.ts:115` —
  `Intl.NumberFormat('en', { style: 'currency', … })` with correct zero-/two-/three-decimal handling
  (`currencyDecimals`, JPY/KWD-safe). Dispute deadlines use
  `toLocaleDateString('en-GB', { timeZone: 'UTC' })` at `:163`. The UI never formats currency.

**What would REGRESS if screens were rebuilt:**

1. **The 35:4 logical-property ratio.** RB blocks authored in Tailwind will emit `ml-*`, `pl-*`,
   `left-*`, `text-left` unless each is rewritten as `ms-*`, `ps-*`, `start-*`, `text-start`. This
   repo is currently *better* than a fresh Tailwind build is by default, and `CLAUDE.md` §15
   mandates logical properties.
2. **`test/i18n-keys.test.ts`** reads every `t('…')` literal out of `packages/ui/src/**` and asserts
   the key exists in `en.json`, capping runtime-assembled keys at two. A rebuild that introduces
   templated keys (`` t(`settings.nav.${id}`) ``) fails the build — deliberately; a missing key
   ships as raw text on screen and has done so once.
3. **`test/settings-nav.test.ts`** reads `routes/Settings.tsx` as source and fails if a `SECTIONS`
   id has no `show('<id>')` gate, if a nav label key is missing, or if any of thirteen named panels
   stops being rendered anywhere. Restructuring Settings breaks it by design.
4. **`test/theme-tokens.test.ts`** reads `tokens.css` + `lib/prefs.ts`, does contrast arithmetic on
   all 5 accents' `onPrimary`, and asserts every wallpaper has a light-theme counterpart.
5. **Ten core test files are coupled to `packages/ui/src` paths** and break on file moves or
   renames: `i18n-keys`, `settings-nav`, `theme-tokens`, `audit-hardening`, `app-review-gate`
   (`components/AppReviewDialog.tsx`), `phone-format` (`lib/phone.ts`), `update-channel`
   (`components/UpdateChannel.tsx`, `routes/Dashboard.tsx`), `update-idempotent`
   (`components/ChannelMigrate.tsx`, `routes/Settings.tsx`), `version-precedence` (`lib/version.ts`),
   `image-size`. `packages/ui` has no test runner of its own, so these *are* the UI's guarantees.
6. **`<MotionConfig reducedMotion="user">`** (`App.tsx:66`). The CSS reduced-motion block cannot
   reach Motion's JS-written inline styles; this one wrapper is the whole mechanism. Any
   replacement animation runtime needs its own equivalent or the accessibility guarantee
   (`CLAUDE.md` §14: non-negotiable) silently disappears.
7. **`components/PhoneField.tsx`** — a country picker plus a national number, backed by
   `lib/phone.ts` (deliberately React-free so a core test can cover it; no libphonenumber, ~150 KB
   saved). A generic RB phone input would change the stored representation, which the server's
   `toDigits` is the authority on.

---

## 6. Prerequisites and blockers

- **React 18.3.1, required 19.** `packages/ui/package.json` pins `react: ^18.3.1`,
  `react-dom: ^18.3.1`, `@types/react: ^18.3.12`, `@types/react-dom: ^18.3.1`. `react-router-dom`
  is already 7.18.2, which is React-19-compatible, so the router is not the obstacle; `motion@11`
  is (React 19 support landed in Motion 12) — and Motion is being removed anyway.
- **Tailwind 4.3.1 is installed and effectively unused.** `@tailwindcss/vite` is registered in
  `vite.config.ts` and `index.css` is three lines (`@import "tailwindcss"`), and then: no
  `tailwind.config.*`, no `@theme`, no `@apply`, and **zero utility classes** — a strict match of
  all 135 distinct JSX class names against the common utility patterns found none. 100% of styling
  is 1,711 lines of hand-written CSS (`app.css` 1,158, `tokens.css` 368, `glass.css` 182) addressed
  by BEM-ish names (`.btn` ×118, `.setting-row__hint` ×105, `.glass-inset` ×105). **The Tailwind
  version requirement is met on paper and not at all in practice** — this is a from-scratch Tailwind
  adoption, not a Tailwind upgrade.
- **No `components.json`.** No shadcn/ui and no Radix anywhere. Every primitive (`Modal`, `Toggle`,
  `ConfirmDialog`, `ProfileMenu`, `PortConflicts`, `PhoneField`) is bespoke, so **no accessibility
  behaviour is inherited** — focus trapping, `aria-modal`, roving tabindex are hand-rolled in
  `Modal.tsx` and need auditing either way.
- **Node engine `>=20`** (root `package.json:8`; neither workspace declares its own). The runtime
  image is `node:20-alpine` (`Dockerfile:15, 35`), built multi-arch for amd64 + arm64.
- **Hardware constraint — the hard one.** `CLAUDE.md` §6: *"lightweight now means runs comfortably
  on a Raspberry Pi / small mini-PC"*, and §19 requires asking before adding heavy dependencies.
  The current build honours this: `vite.config.ts` manually chunks react / motion / query / i18n,
  every route but the Dashboard is `React.lazy`-loaded (`Root.tsx:18-23`), and xterm is deferred
  behind `LazyTerminal.tsx`. A block library that ships large per-block JS, or a design leaning on
  continuous GPU animation, regresses the product's stated core value. The dashboard is also
  frequently shown on kiosk / display hardware — `cursorFx.ts` already bails out on
  `(pointer: coarse)` and no-hover for exactly that reason.
- **Licensing — potentially fatal, and it must be settled before a line is written.** This repo is
  **AGPL-3.0-only** with an SPDX header on every source file, and `CLAUDE.md` §3 / §19 are explicit:
  *"never add code/assets/deps under an AGPL-incompatible license."* React Bits Pro is a **paid,
  proprietary** component library. Copying its blocks into this tree publishes them under
  AGPL-3.0, which its licence almost certainly forbids; and the AGPL §13 network clause means any
  masjid running a *modified* build must be offered the complete corresponding source, those blocks
  included. This is the same reasoning that bars umbrelOS code from this repo. **Blocker: have the
  RB Pro licence terms reviewed against AGPL-3.0 for this repo specifically.** Other repos in the
  fleet may be licensed differently; this one is not.
- **RB MCP server + licence key are unavailable**, so every `Variant` in §1 is `PENDING` — no
  variant can be chosen without browsing the real catalogue.
- **`npm run lint` (`tsc --noEmit`) is the only typecheck, and there is no ESLint** despite
  `// eslint-disable-next-line` comments at `App.tsx:18`, `SceneBackground.tsx:31` and in
  `Terminal.tsx` — those are inert. Neither `vite build` nor esbuild typechecks. Do not assume a
  linter will catch anything.

### What makes this repo harder than the others

1. **The licence.** AGPL-3.0 + per-file SPDX + a CLA, against a proprietary paid component library.
   No other constraint here can be worked around by trying harder.
2. **`routes/Settings.tsx` is 3,629 lines** — 42% of the entire UI — covering eight panes, ~15
   dialogs and 6 window launchers, with `test/settings-nav.test.ts` asserting its internal structure
   from the outside.
3. **Ten core tests read UI source files by path.** The UI has no test runner, so its guarantees
   live in `packages/core/test/`. Moving or renaming a UI file breaks `npm run test`, and any new
   test file must also be added **by name** to the `test` script in `packages/core/package.json`
   (`CLAUDE.md` §17 — an unlisted test never runs and nothing tells you).
4. **There is no "app shell + content" separation to lift.** The dashboard is a *desktop metaphor*:
   a floating dock, drag-to-pin with reordering, and a window manager whose windows survive route
   changes and keep live WebSockets open while minimised (`Windows.tsx:5-9`), plus a `locked` window
   mode that exists because closing an update window and pressing the button again once left a
   masjid's box down (`Windows.tsx:22-30`). RB's `app-shell` / `app-sidebar` blocks assume a
   conventional sidebar-and-page layout; this is not that.
5. **Live data everywhere.** Stats stream over a tRPC WebSocket subscription at ~2 s, app lists poll
   at 8 s, logs and terminals are raw WebSockets. Blocks must accept streaming values without
   re-mounting — `StatCard` is `memo`'d at `StatCard.tsx:20` precisely for this.
6. **The glass identity is 182 lines of `backdrop-filter`, mask-composite refractive edges and a
   pointer-tracked glint.** Whatever replaces it is a visible product change, not a refactor.

---

## 7. Notes

- **The most surprising finding: Tailwind is installed, imported, and never used.** Not
  under-used — *zero* utility classes in 862 `className` sites. Any plan that assumes "it is already
  Tailwind v4, so the tokens port across" is wrong; there is nothing to port, only CSS variables to
  re-map.
- **There is exactly one responsive breakpoint in the entire product** (`app.css:1138`,
  `max-width: 56rem`), and it only restyles the settings nav. Reflow otherwise rests on three
  `repeat(auto-fit|auto-fill, minmax(…))` grids and zero `clamp()`. The `mobile` RB category is a
  build, not a port.
- **RTL is in better shape than a casual read would suggest** — 35 logical properties to 4 physical,
  three of which are geometric. The migration is far more likely to *lose* RTL correctness than
  gain it.
- **`packages/ui` has no test script at all.** The root `npm run test` uses `--if-present`, so the
  UI silently contributes nothing; ten core tests compensate by reading UI files as text.
- The repo ships an **`ambient.mp4`** in `packages/ui/public/` — an optional looping video wallpaper
  behind a localStorage-only flag (`lib/ambient.ts`), never synced to the server and not exposed in
  the appearance prefs. Easy to miss, easy to drop.
- `docs/THEMING.md` already documents the intended design language (girih tiling, mihrab arches, the
  custom `MasjidMark` / `MasjidScene` glyphs in `components/Glyphs.tsx`). Whatever RB provides,
  `CLAUDE.md` §14 still forbids putting Quranic or sacred Arabic text into decorative chrome,
  spinners or throwaway UI.
- `VERSION` is `0.51.2-dev.1` and the current branch is `dev`, which is where all work belongs
  (`CLAUDE.md` Branching policy). This audit changed nothing but its own file.
