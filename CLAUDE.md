# CLAUDE.md — OpenMasjidOS

> This file is the single source of truth for the OpenMasjidOS project. Read it fully before writing any code. When in doubt, follow this document over your own assumptions. If something here is ambiguous, ask before guessing.

---

## 1. What we are building (one paragraph)

**OpenMasjidOS** is a free, fully open-source, self-hosted operating layer that lets any masjid run useful software on their own hardware (a cheap mini-PC, a Raspberry Pi, a VPS — anything that runs Docker) with **zero technical knowledge**. It installs with a single `curl` one-liner, runs entirely in Docker, and presents a beautiful, masjid-themed web dashboard. From that dashboard, an admin browses an **App Store** (prayer-time displays, donation pages, announcement boards, event calendars, Quran resources, etc.), and installs apps with one click. Each app is just a Docker container described by a manifest. The apps themselves live in a **separate repository called `OpenMasjidAPPS`**; OpenMasjidOS is the engine that finds, installs, runs, updates, and removes them.

Think: **"CasaOS / Umbrel, but purpose-built and themed for masjids, and dead simple for a volunteer to run."**

---

## 2. The two repositories

| Repo | Purpose | Built in this project? |
|------|---------|------------------------|
| **`OpenMasjidOS`** (this repo) | The core platform: installer, backend control plane, web dashboard, app-store client, Docker lifecycle management. | ✅ Yes |
| **`OpenMasjidAPPS`** | The app catalog. A collection of app definitions (manifest + compose + icon + screenshots). OpenMasjidOS fetches this catalog to populate the App Store. | ⚙️ We define its format and scaffold a couple of example apps, but it is a separate repo. |

**Scope rule:** In *this* repo we do **not** build the individual end-user apps (prayer clock, donation app, etc.). We build the *platform that runs them* and we define the *contract* (manifest spec) that apps in `OpenMasjidAPPS` must follow.

---

## 3. Scope — read this carefully

### ✅ In scope (v1.0)
- One-line `curl | bash` installer that works on common Linux (Debian/Ubuntu, Raspberry Pi OS, Fedora) and is architecture-aware (amd64 + arm64).
- Installer auto-installs Docker + Docker Compose plugin if missing, sets up OpenMasjidOS as a managed service, and prints the access URL when done.
- **Core backend (control plane):** REST/JSON API + WebSocket for live updates. Manages container lifecycle via the Docker Engine API.
- **Web dashboard (UI):** install/start/stop/restart/remove/update apps; view status, logs, and resource usage; manage settings.
- **App Store client:** fetches the catalog from `OpenMasjidAPPS`, renders app listings, handles one-click install.
- **Masjid profile** stored centrally (name, address, lat/long, prayer-time calculation method, Asr madhab, timezone, language) so apps can consume it.
- **Single admin auth** (username + password, hashed). Session via secure HTTP-only cookie.
- **Theming:** light + dark mode, **dark is default**, with high-quality animations and full `prefers-reduced-motion` support.
- **i18n + RTL:** English first, but the UI must be translation-ready and must render correctly right-to-left (Arabic/Urdu).
- Automatic update check for the OpenMasjidOS core itself.
- Backup/restore of platform config + per-app volumes (basic, tar-based).

### ❌ Out of scope (v1.0) — do not build these
- The actual end-user apps (they live in `OpenMasjidAPPS`).
- Kubernetes, multi-node clustering, or any orchestration beyond a single host running Docker Compose.
- Native mobile apps.
- Built-in payment processing (donation *apps* integrate their own providers; the platform stays payment-agnostic).
- Multi-tenant hosting (one OpenMasjidOS install serves one masjid/one host).
- A public account system / cloud sync. Everything is local-first and self-hosted.

### 🔭 Later (v1.1+, design for but don't implement now)
- Multiple admin users with roles.
- Remote-access helper (Tailscale/Cloudflare-tunnel wizard).
- Community-submitted app catalog with review flow.

---

## 4. Architecture

```
                       ┌──────────────────────────────────────────┐
                       │             User's browser                │
                       │   OpenMasjidOS Dashboard (SvelteKit SPA)   │
                       └───────────────▲────────────────────────────┘
                                       │ HTTPS (JSON + WebSocket)
                       ┌───────────────┴────────────────────────────┐
                       │        OpenMasjidOS Core (Go binary)        │
                       │  • Auth & sessions                          │
                       │  • App lifecycle (install/start/stop/rm)    │
                       │  • App Store client (fetches catalog)       │
                       │  • Masjid profile + settings store          │
                       │  • Live status via Docker events           │
                       └───────┬───────────────────────┬─────────────┘
                               │ Docker Engine API      │ HTTPS
                ┌──────────────▼──────────────┐   ┌─────▼──────────────────────┐
                │   Docker (host daemon)       │   │  OpenMasjidAPPS catalog    │
                │  • app containers/stacks     │   │  (GitHub raw / releases)   │
                │  • named volumes per app     │   │  catalog.json + manifests  │
                └──────────────────────────────┘   └────────────────────────────┘
```

- **Core** is a single Go binary, shipped as a Docker image (`openmasjid/core`). It is itself run by Docker, and it talks to the host Docker daemon via the mounted socket `/var/run/docker.sock`.
- **Apps** are launched as their own Docker Compose projects (one project per app), labeled so the core can find and manage them.
- **Catalog** is plain static files served from the `OpenMasjidAPPS` repo (GitHub raw URLs or release assets). No app-store server to run.

---

## 5. Tech stack (opinionated — confirm or override before deviating)

| Layer | Choice | Why |
|-------|--------|-----|
| Backend | **Go** (1.22+) | Single static binary, tiny image, first-class Docker SDK (`github.com/docker/docker/client`). |
| HTTP router | `chi` (or stdlib `net/http` + `ServeMux`) | Lightweight, no heavy framework. |
| Frontend | **SvelteKit** (SPA / `adapter-static`) | Smallest bundles + best built-in animation/transition primitives → matches "lightweight + very slick." |
| Styling | **Tailwind CSS** + CSS custom properties | Theme via CSS variables so light/dark is a single attribute swap. |
| Animation | Svelte `transition`/`animate`/`motion` + **Motion One** for spring physics | Buttery, GPU-friendly, respects reduced-motion. |
| Icons | `lucide-svelte` + a small custom set of masjid glyphs (dome, minaret, crescent, mihrab arch) | Consistent, light. |
| State | Svelte stores + TanStack Query (svelte-query) for server cache | Simple, reactive. |
| Build/deploy | Docker multi-stage; final image is `scratch`/`distroless` + the Go binary with embedded UI assets | One image, no runtime deps. |
| Container mgmt | Docker Compose v2 (the `docker compose` plugin) | Standard, every app is a compose project. |

**Embed the built UI into the Go binary** (`go:embed`) so the whole platform ships as one image and serves the dashboard itself. No separate web server.

---

## 6. Repository structure (`OpenMasjidOS`)

```
OpenMasjidOS/
├── CLAUDE.md                  # this file
├── README.md                  # human-facing, with the curl one-liner up top
├── LICENSE                    # MIT or Apache-2.0
├── install.sh                 # the one-line installer target
├── docker-compose.yml         # how the core runs itself
├── Makefile                   # build, lint, test, dev shortcuts
│
├── backend/
│   ├── cmd/openmasjid/main.go
│   ├── internal/
│   │   ├── api/               # HTTP handlers, routing, middleware
│   │   ├── auth/              # admin auth, sessions, password hashing (argon2)
│   │   ├── docker/            # Docker engine + compose wrappers
│   │   ├── apps/              # install/lifecycle logic, manifest parsing
│   │   ├── store/             # App Store catalog client + cache
│   │   ├── config/            # masjid profile + settings persistence
│   │   └── ws/                # websocket hub for live status/logs
│   ├── embed.go               # go:embed of built UI
│   └── go.mod
│
├── frontend/
│   ├── src/
│   │   ├── routes/            # dashboard, store, app detail, settings, login
│   │   ├── lib/
│   │   │   ├── components/    # cards, buttons, toggles, modals, toasts
│   │   │   ├── theme/         # tokens.css, theme store, RTL handling
│   │   │   ├── animations/    # shared transition/spring presets
│   │   │   ├── i18n/          # locale files + helpers
│   │   │   └── api/           # typed client for the core API
│   │   └── app.html
│   ├── tailwind.config.js
│   └── package.json
│
├── scripts/                   # build helpers used by Makefile/install.sh
└── docs/
    ├── ARCHITECTURE.md
    ├── APP_MANIFEST_SPEC.md   # the contract OpenMasjidAPPS must follow
    └── THEMING.md
```

---

## 7. The one-line installer (`install.sh`)

**Goal:** a non-technical masjid volunteer copies one line, pastes it into their server's terminal, and a minute later gets a URL to open.

```bash
curl -fsSL https://get.openmasjid.org | bash
```
(Before a domain exists, the fallback is the raw GitHub URL:
`curl -fsSL https://raw.githubusercontent.com/OpenMasjidOS/OpenMasjidOS/main/install.sh | bash`)

`install.sh` must:
1. Be **POSIX-ish bash**, fail fast (`set -euo pipefail`), and be re-runnable (idempotent — re-running upgrades, never breaks an existing install).
2. Detect OS + architecture; refuse clearly on unsupported platforms with a friendly message.
3. Check for Docker. If missing, install it via the official convenience method, then ensure the `docker compose` plugin exists.
4. Create a data directory at `/opt/openmasjid` (config, volumes, app state).
5. Write/refresh the core `docker-compose.yml` and pull `openmasjid/core:latest`.
6. Start the core, wait for health, then **print a clear success box**: the access URL (`http://<server-ip>:8723`), the default first-run note, and how to get help.
7. Be safe to inspect — the script must be readable and commented, because we are asking people to pipe it to bash. Никаких obfuscation. Keep it auditable.

**Default port:** `8723`. **Data dir:** `/opt/openmasjid`. Core runs as a restart-`unless-stopped` service so it survives reboots.

First time the dashboard is opened, show a **setup wizard** (no pre-baked password): create admin account → enter masjid profile (name, location, calculation method, timezone, language) → done.

---

## 8. App manifest contract (lives in `docs/APP_MANIFEST_SPEC.md`)

Every app in `OpenMasjidAPPS` is a folder containing a `manifest.yaml`, a `docker-compose.yml`, an `icon.svg` (or png), and optional screenshots. The catalog is an aggregated `catalog.json` (generated by CI in that repo) that OpenMasjidOS fetches.

```yaml
# manifest.yaml
id: prayer-times-display          # unique, kebab-case
name: Prayer Times Display
tagline: A beautiful prayer clock for your masjid's screens
category: displays                # displays | donations | community | quran | admin | utilities
version: 1.0.0
author: OpenMasjidAPPS
license: MIT
icon: icon.svg
screenshots: [shot1.png, shot2.png]
description: |
  Full markdown description shown on the app detail page.
# What the app needs from the masjid profile (injected as env vars):
uses_profile: [name, latitude, longitude, calc_method, asr_madhab, timezone]
# User-configurable settings shown before install:
settings:
  - key: SCREEN_ORIENTATION
    label: Screen orientation
    type: select
    options: [landscape, portrait]
    default: landscape
ports:
  - container: 80
    label: Web interface
resources:
  memory_hint: 128M
```

Rules for the core:
- Install = render the app's compose with injected env (profile values + user settings), then `docker compose -p omos-<id> up -d`.
- Label every resource with `com.openmasjid.app=<id>` so we can find/clean it.
- Per-app volumes live under `/opt/openmasjid/apps/<id>/`.
- Remove = compose down; offer "also delete data" choice.

---

## 9. Design system & theming (this is a priority — make it feel premium)

### Identity
Calm, dignified, and modern. Inspired by Islamic geometric art (girih/arabesque tessellations) and the architecture of masjids (domes, arches/mihrab, minarets, the crescent). It should feel respectful and serene, never gaudy.

### Color tokens (define in `tokens.css` as CSS custom properties)
- **Dark (DEFAULT):** deep night-sky base (`#0E1814`-ish charcoal-green), elevated surfaces a step lighter, **emerald/teal** primary (`#1FA37A` family), warm **gold** accent (`#D4AF37` used sparingly for highlights/active states). Text near-white with green undertone.
- **Light:** soft warm ivory/parchment base, same emerald primary tuned for contrast, gold accent.
- All colors as variables so switching theme = toggling `data-theme="dark|light"` on `<html>`. Never hardcode hex in components.
- Meet WCAG AA contrast in both themes.

### Typography
- Clean modern sans for UI (e.g. Inter / system stack).
- A subtly elegant display face for headings only.
- Bundle a good **Arabic/Naskh** face for RTL locales.
- **Do not** place Quranic verses or sacred Arabic text into decorative chrome, loading spinners, or throwaway UI. Keep decoration to geometric/architectural motifs. If any religious text is ever shown, it must be intentional, correct, and dignified — flag to the maintainer rather than improvising.

### Motifs
- Subtle geometric pattern as a low-opacity background texture.
- Custom glyph set: dome, minaret, crescent+star, mihrab arch — used as iconography and empty-state art.
- Rounded, arch-topped cards are encouraged where it reads as elegant (don't overdo it).

### Motion (make it "very very nice" but tasteful)
- **Spring physics** for interactive elements (cards lift on hover, buttons press), not linear easing.
- Page/route transitions: gentle crossfade + slight rise.
- App install: a satisfying multi-stage progress animation (pulling → starting → ready) with a celebratory but understated success state.
- Skeleton shimmer loaders, never spinners-only.
- Staggered entrance for grids of app cards.
- A short, elegant splash on first dashboard load (geometric pattern assembling) — keep it < 1s and skippable.
- **Always honor `prefers-reduced-motion`**: collapse to instant/opacity-only. This is non-negotiable for accessibility.

### Voice & wording (critical to the brief)
Every label and message uses plain, warm, non-technical language. The user is a masjid volunteer, not a sysadmin.
- ✅ "Install" / "Open" / "Turn off" / "Update available" / "This app is running"
- ❌ "Deploy container" / "Orchestrate stack" / "Exited (0)" / "SIGTERM"
- Errors explain what happened and what to do next, in one or two friendly sentences. Never show a raw stack trace to the user (log it, show a tidy message + a "view technical details" expander).

---

## 10. Coding conventions

**General**
- Prefer clarity over cleverness. Comment the *why*, not the *what*.
- Small, focused commits with conventional-commit messages (`feat:`, `fix:`, `docs:`...).
- Everything must build and run with `make dev` and `make build`. Keep the Makefile current.

**Go (backend)**
- Idiomatic Go; `gofmt` + `golangci-lint` clean.
- Errors wrapped with context (`fmt.Errorf("...: %w", err)`), never silently swallowed.
- All Docker interaction goes through `internal/docker` — no `os/exec` of docker scattered around (the one exception is `docker compose` invocation, which is also wrapped there).
- Hash passwords with argon2id. Sessions in secure, HTTP-only, SameSite cookies.
- API responses are JSON with a consistent envelope `{ data | error }`.
- Never log secrets. Never expose the Docker socket to apps unless an app's manifest explicitly requests it and the user confirms.

**Svelte/TS (frontend)**
- TypeScript everywhere; no `any` without a comment justifying it.
- Components small and composable; shared transitions/spring presets imported from `lib/animations`, not redefined ad hoc.
- All user-facing strings go through the i18n layer — no hardcoded English in components.
- All colors/spacing via tokens; no magic hex or px where a token exists.
- Layout must work LTR and RTL (use logical CSS properties: `margin-inline-start`, etc.).

**Security**
- The installer is piped to bash, so it must stay readable and minimal in privilege.
- Validate every manifest before running it; never `up` an untrusted compose without parsing/limiting it.
- Default to least privilege for app containers.

---

## 11. Build & run commands (keep these working)

```bash
make dev        # run backend + frontend with hot reload for local development
make build      # build UI, embed into Go binary, produce the Docker image
make lint       # golangci-lint + svelte-check + eslint
make test       # go test ./... + frontend unit tests
make image      # build & tag openmasjid/core:dev
```

---

## 12. Definition of done (for any feature)

A change is "done" only when: it builds via `make build`; it's covered by at least a basic test where logic is non-trivial; it works in **both** light and dark themes; it works in **both** LTR and RTL; it honors `prefers-reduced-motion`; all new strings are in i18n; user-facing wording is plain and friendly; and no raw technical error can reach the user un-prettified.

---

## 13. Working agreement for Claude (the coding agent)

- Read this file first, every session. Treat Sections 3 (scope) and 9 (design/voice) as hard constraints.
- Build **vertically**: ship one full working slice (e.g., "list installed apps") end-to-end — backend + API + UI + theme + i18n — before starting the next.
- Suggested build order: (1) installer + core skeleton that boots and serves an empty dashboard → (2) auth + setup wizard + masjid profile → (3) Docker lifecycle for a hardcoded test app → (4) App Store catalog fetch + one-click install → (5) live status/logs over WebSocket → (6) updates + backup → (7) polish pass on animations/empty states.
- When you make a non-trivial architectural or naming decision, write it down in `docs/ARCHITECTURE.md`.
- If a task seems to require building an actual end-user app, **stop** — that belongs in `OpenMasjidAPPS`. Scaffold the manifest contract instead and ask.
- Ask before adding heavy dependencies; "lightweight" is a core value.
- Keep the README's curl one-liner accurate at all times.
