# CLAUDE.md — OpenMasjidOS

> This file is the single source of truth for the OpenMasjidOS project. Read it fully before writing any code. When in doubt, follow this document over your own assumptions. If something here is ambiguous, ask before guessing.

---

## 1. What we are building (one paragraph)

**OpenMasjidOS** is a free, fully open-source, self-hosted operating layer that lets any masjid run useful software on their own hardware (a cheap mini-PC, a Raspberry Pi, a VPS — anything that runs Docker) with **zero technical knowledge**. It installs with a single `curl` one-liner that runs a complete guided setup, runs entirely in Docker, and presents a beautiful, masjid-themed web dashboard protected by a login. From that dashboard, an admin sees live system stats, browses an **App Store**, and installs apps with one click. Each app is just a Docker container described by a manifest, and **each app collects its own masjid-specific settings** (prayer calculation, location, etc.) — the platform itself stays generic. The apps live in a **separate repository called `OpenMasjidAPPS`**; OpenMasjidOS is the engine that finds, installs, runs, updates, and removes them.

Think: **"CasaOS / Umbrel, but purpose-built and themed for masjids, and dead simple for a volunteer to run."**

---

## 2. The two repositories

| Repo | Purpose | Built in this project? |
|------|---------|------------------------|
| **`OpenMasjidOS`** (this repo) | The core platform: installer, backend control plane, web dashboard (with auth), app-store client, Docker lifecycle management, system stats. | ✅ Yes |
| **`OpenMasjidAPPS`** | The app catalog. A collection of app definitions (manifest + compose + icon + screenshots). OpenMasjidOS fetches this catalog to populate the App Store. | ⚙️ We define its format and scaffold a couple of example apps, but it is a separate repo. |

**Scope rule:** In *this* repo we do **not** build the individual end-user apps (prayer clock, donation app, etc.). We build the *platform that runs them* and we define the *contract* (manifest spec) that apps in `OpenMasjidAPPS` must follow. Any masjid-specific configuration (prayer times, location, calculation method) is owned by the individual apps, **never** by the platform.

---

## 3. Scope — read this carefully

### ✅ In scope (v1.0)
- **A full-lifecycle one-line `curl | bash` installer.** On a fresh machine it runs a complete guided **install**. On a machine that already has OpenMasjidOS, the same command opens a **management menu**: Update / Repair / Reconfigure network / Uninstall. Works on common Linux (Debian/Ubuntu, Raspberry Pi OS, Fedora), architecture-aware (amd64 + arm64).
- Installer auto-installs Docker + the Docker Compose plugin if missing, sets up OpenMasjidOS as a managed service, and during install also:
  - **Optionally configures a static IP** for the machine (guided, confirmed, safe — see §7).
  - **Sets a hostname and mDNS** so the dashboard is reachable at **`http://openmasjidos.local`** (plus the raw IP as a fallback).
- **Web UI authentication.** The dashboard is always behind a login. The **first time** the dashboard is opened, the user creates the **admin account**. Sessions use secure, HTTP-only cookies. No part of the UI is reachable unauthenticated except the login/first-run screen.
- **Core backend (control plane):** REST/JSON API + WebSocket for live updates. Manages container lifecycle via the Docker Engine API.
- **Dashboard home with live system stats:** CPU %, RAM used/total, disk used/total, uptime, and count of running apps — updated live — alongside the grid of installed apps.
- **App management:** install / start / stop / restart / remove / update apps; view status and logs.
- **App Store client:** fetches the catalog from `OpenMasjidAPPS`, renders listings, handles one-click install.
- **Settings (platform-only):** dashboard customization (theme, accent, dashboard name, UI language, display preferences) and an **Advanced** section (see below). **Settings contains NO masjid/prayer details** — those belong to apps.
- **Advanced → custom apps:** an opt-in toggle (off by default) that, when enabled, adds a **"3rd Party App"** button to the App Store. That button opens a UI where an advanced user can install any container by **pasting a `docker-compose.yml`**. Clearly gated behind warnings.
- **Theming:** light + dark mode, **dark is default**, with high-quality animations and full `prefers-reduced-motion` support.
- **i18n + RTL:** English first, but the UI must be translation-ready and must render correctly right-to-left (Arabic/Urdu).
- Automatic update check for the OpenMasjidOS core itself.
- Backup/restore of platform config + per-app volumes (basic, tar-based).

### ❌ Out of scope (v1.0) — do not build these
- The actual end-user apps (they live in `OpenMasjidAPPS`).
- A central "masjid profile" on the platform. Masjid-specific config is per-app only.
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
                       │       reached at openmasjidos.local        │
                       └───────────────▲────────────────────────────┘
                                       │ HTTPS (JSON + WebSocket)
                                       │   — login required —
                       ┌───────────────┴────────────────────────────┐
                       │        OpenMasjidOS Core (Go binary)        │
                       │  • Auth & sessions (admin account)          │
                       │  • App lifecycle (install/start/stop/rm)    │
                       │  • App Store client (fetches catalog)       │
                       │  • Custom-compose (3rd-party) installer      │
                       │  • Platform settings store                  │
                       │  • Live system stats (CPU/RAM/disk)         │
                       │  • Live status/logs via Docker events       │
                       └───────┬───────────────────────┬─────────────┘
                               │ Docker Engine API      │ HTTPS
                ┌──────────────▼──────────────┐   ┌─────▼──────────────────────┐
                │   Docker (host daemon)       │   │  OpenMasjidAPPS catalog    │
                │  • app containers/stacks     │   │  (GitHub raw / releases)   │
                │  • custom (3rd-party) stacks │   │  catalog.json + manifests  │
                │  • named volumes per app     │   └────────────────────────────┘
                └──────────────────────────────┘
        Host: avahi (mDNS → .local), optional static IP, host /proc for stats
```

- **Core** is a single Go binary, shipped as a Docker image (`openmasjid/core`). It is itself run by Docker and talks to the host Docker daemon via the mounted socket `/var/run/docker.sock`.
- **System stats** are read from the host (mount host `/proc` and `/sys` read-only into the core, set `HOST_PROC`/`HOST_SYS` for gopsutil) so CPU/RAM/disk reflect the *machine*, not the container.
- **Apps** (catalog and custom) are launched as their own Docker Compose projects (one project per app), labeled so the core can find and manage them.
- **Networking:** the host runs avahi so `openmasjidos.local` resolves on the LAN; the installer can optionally pin a static IP.
- **Catalog** is plain static files served from the `OpenMasjidAPPS` repo. No app-store server to run.

---

## 5. Tech stack (opinionated — confirm or override before deviating)

| Layer | Choice | Why |
|-------|--------|-----|
| Backend | **Go** (1.22+) | Single static binary, tiny image, first-class Docker SDK (`github.com/docker/docker/client`). |
| HTTP router | `chi` (or stdlib `net/http` + `ServeMux`) | Lightweight, no heavy framework. |
| System stats | `gopsutil` (with host `/proc` mounted) | CPU/RAM/disk/uptime without shelling out. |
| Frontend | **SvelteKit** (SPA / `adapter-static`) | Smallest bundles + best built-in animation/transition primitives → matches "lightweight + very slick." |
| Styling | **Tailwind CSS** + CSS custom properties | Theme via CSS variables so light/dark is a single attribute swap. |
| Animation | Svelte `transition`/`animate`/`motion` + **Motion One** for spring physics | Buttery, GPU-friendly, respects reduced-motion. |
| Charts | tiny sparkline/gauge (hand-rolled SVG or `layerchart`) | For the live CPU/RAM cards; keep it light. |
| Icons | `lucide-svelte` + a small custom set of masjid glyphs (dome, minaret, crescent, mihrab arch) | Consistent, light. |
| State | Svelte stores + TanStack Query (svelte-query) for server cache | Simple, reactive. |
| Build/deploy | Docker multi-stage; final image is `scratch`/`distroless` + the Go binary with embedded UI assets | One image, no runtime deps. |
| Container mgmt | Docker Compose v2 (the `docker compose` plugin) | Standard, every app is a compose project. |
| Host networking | `avahi-daemon` (mDNS), distro-native static-IP tool (netplan / nmcli / dhcpcd) | `.local` access + optional fixed IP. |

**Embed the built UI into the Go binary** (`go:embed`) so the whole platform ships as one image and serves the dashboard itself. No separate web server.

---

## 6. Repository structure (`OpenMasjidOS`)

```
OpenMasjidOS/
├── CLAUDE.md                  # this file
├── README.md                  # human-facing, with the curl one-liner up top
├── LICENSE                    # MIT or Apache-2.0
├── VERSION                    # single source of truth for the version (see §17)
├── install.sh                 # the one-line installer / lifecycle manager
├── docker-compose.yml         # how the core runs itself
├── Makefile                   # build, lint, test, dev shortcuts
│
├── backend/
│   ├── cmd/openmasjid/main.go
│   ├── internal/
│   │   ├── api/               # HTTP handlers, routing, middleware
│   │   ├── auth/              # admin account, first-run, sessions, argon2
│   │   ├── docker/            # Docker engine + compose wrappers
│   │   ├── apps/              # install/lifecycle logic, manifest parsing
│   │   ├── custom/            # 3rd-party / pasted-compose install + validation
│   │   ├── store/             # App Store catalog client + cache
│   │   ├── stats/             # host CPU/RAM/disk via gopsutil
│   │   ├── settings/          # platform settings persistence (NO masjid data)
│   │   └── ws/                # websocket hub for live stats/status/logs
│   ├── embed.go               # go:embed of built UI
│   └── go.mod
│
├── frontend/
│   ├── src/
│   │   ├── routes/
│   │   │   ├── login/         # login + first-run admin creation
│   │   │   ├── dashboard/     # home: system stats + installed apps grid
│   │   │   ├── store/         # App Store (+ "3rd Party App" entry when enabled)
│   │   │   ├── store/custom/  # paste-a-compose install UI
│   │   │   ├── apps/[id]/     # app detail: status, logs, controls
│   │   │   └── settings/      # customization + advanced
│   │   ├── lib/
│   │   │   ├── components/    # cards, buttons, toggles, modals, toasts, stat gauges
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
    ├── NETWORKING.md          # static IP + mDNS behaviour and safety notes
    └── THEMING.md
```

---

## 7. The installer (`install.sh`) — a full lifecycle tool

**Goal:** a non-technical masjid volunteer copies one line, pastes it into their server's terminal, answers a couple of friendly prompts, and a minute later gets a URL to open. Running the *same* line again later gives them safe maintenance options — they never need to remember any other command.

```bash
curl -fsSL https://get.openmasjid.org | bash
```
(Before a domain exists, the fallback is the raw GitHub URL:
`curl -fsSL https://raw.githubusercontent.com/OpenMasjidOS/OpenMasjidOS/main/install.sh | bash`)

### 7.1 Behaviour: detect state, then branch
On start the script detects whether OpenMasjidOS is already installed (presence of `/opt/openmasjid` and/or the core container).

**A) Fresh machine → guided INSTALL** (see 7.2).
**B) Already installed → MANAGEMENT MENU:**
```
OpenMasjidOS is already installed (vX.Y.Z).
What would you like to do?
  1) Update            — get the latest version (keeps all data & apps)
  2) Repair            — re-apply config, re-pull, restart, fix permissions
  3) Reconfigure network — change static IP / hostname (.local)
  4) Uninstall         — remove OpenMasjidOS
  5) Quit
```
- **Update:** pull latest `openmasjid/core`, recreate the core container, keep data and all installed apps untouched.
- **Repair:** rewrite the core `docker-compose.yml`, re-pull, restart, re-ensure avahi + hostname, fix `/opt/openmasjid` permissions. Non-destructive.
- **Reconfigure network:** re-run the static-IP and hostname steps from install.
- **Uninstall:** stop & remove the core. Then ask, separately and explicitly: *"Also remove all installed apps and their data? This cannot be undone."* Removing data requires the user to type `DELETE` to confirm. Default is to keep app data.

### 7.2 Guided INSTALL steps
The script must:
1. Be **POSIX-ish bash**, fail fast (`set -euo pipefail`), and be idempotent (re-running is always safe).
2. Detect OS + architecture; refuse clearly on unsupported platforms with a friendly message.
3. Ensure Docker is present. If missing, install via the official convenience method, then ensure the `docker compose` plugin exists.
4. **Networking — static IP (optional, guided, safe):**
   - Detect the active network stack (netplan / NetworkManager-`nmcli` / systemd-networkd / dhcpcd) and the current interface, IP, and gateway.
   - **If a cloud/VPS environment is detected, default to SKIP** and say so (the provider manages addressing; changing it can lock the user out).
   - Otherwise *offer* to pin the current IP as a static address. Show the exact proposed config and require a yes/no confirmation. Warn that changing the IP on a remote box can drop the SSH session.
   - Apply via the detected tool only after confirmation. If anything looks risky/unknown, skip and tell the user how to do it manually (link `docs/NETWORKING.md`).
5. **Networking — hostname + mDNS:**
   - Set the system hostname (default `openmasjidos`, prompt to accept/change).
   - Install and enable `avahi-daemon` so the box answers at `openmasjidos.local` on the LAN.
6. Create the data directory at `/opt/openmasjid` (config, volumes, app state).
7. Write/refresh the core `docker-compose.yml` (mounts `/var/run/docker.sock`, host `/proc` & `/sys` read-only, and `/opt/openmasjid`), and pull `openmasjid/core:latest`.
8. Start the core as a `restart: unless-stopped` service so it survives reboots; wait for health.
9. **Print a clear success box**, e.g.:
   ```
   ✅ OpenMasjidOS is ready!

   Open it in your browser:
     →  http://openmasjidos.local      (easiest)
     →  http://192.168.1.50             (works everywhere on your network)

   First time? You'll be asked to create your admin account.
   Need help? https://openmasjid.org/help
   ```

### 7.3 Flags (for advanced/automated use; interactive is the default)
Support non-interactive overrides so power users can script installs:
`--yes` (accept defaults), `--hostname <name>`, `--static-ip <cidr> --gateway <ip> --iface <name>`, `--no-network` (skip static IP **and** hostname changes), `--port <n>` (default `80`).

**Default port:** `80` (so the dashboard URL needs no port suffix). **Data dir:** `/opt/openmasjid`.

> The installer is piped to bash, so it must stay **readable and commented** — we are asking people to trust it. No obfuscation, ever. Keep it auditable and minimal in privilege.

---

## 8. First-run web setup & authentication

The dashboard is **always** behind a login. There is no pre-baked password and no anonymous access to any feature.

- **First visit (no admin exists yet):** the user lands on a first-run screen and **creates the admin account** (username + password; enforce a sane minimum strength). Optionally let them pick a theme (dark is pre-selected) and UI language. Then they go straight to the dashboard. **Do not ask for any masjid/prayer details here** — that belongs to apps.
- **Subsequent visits:** standard login screen → dashboard. Wrong credentials get a friendly, rate-limited error.
- **Sessions:** server-side session, secure + HTTP-only + SameSite cookie. Logout clears it. Passwords hashed with **argon2id**, never stored or logged in plaintext.
- **Account management** (in Settings): change password. (Multiple users/roles are v1.1.)

---

## 9. App manifest contract (lives in `docs/APP_MANIFEST_SPEC.md`)

Every app in `OpenMasjidAPPS` is a folder containing a `manifest.yaml`, a `docker-compose.yml`, an `icon.svg` (or png), and optional screenshots. The catalog is an aggregated `catalog.json` (generated by CI in that repo) that OpenMasjidOS fetches.

**Important:** the platform does **not** hold a central masjid profile. Anything masjid-specific (location, prayer calculation method, Asr madhab, timezone for prayer math, etc.) is collected **by the app itself** via its own `settings` block below, and configured inside that app after install.

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
# Everything this app needs is collected here (no platform profile is injected):
settings:
  - key: MASJID_NAME
    label: Masjid name
    type: text
    default: ""
  - key: LATITUDE
    label: Latitude
    type: text
  - key: LONGITUDE
    label: Longitude
    type: text
  - key: CALC_METHOD
    label: Prayer calculation method
    type: select
    options: [MWL, ISNA, Egypt, Makkah, Karachi, Tehran, Jafari]
    default: MWL
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
- Install = render the app's compose with the user-provided `settings` as env, then `docker compose -p omos-<id> up -d`.
- Label every resource with `com.openmasjid.app=<id>` and `com.openmasjid.kind=catalog` so we can find/clean it.
- Per-app volumes live under `/opt/openmasjid/apps/<id>/`.
- Remove = compose down; offer an "also delete this app's data" choice.

---

## 10. Third-party / custom apps (advanced, opt-in)

This is **off by default**. It is enabled in **Settings → Advanced → "Allow custom apps"**.

- When enabled, the **App Store gets a "3rd Party App" button** (visually marked as advanced). When disabled, that button does not exist anywhere in the UI.
- The button opens a **paste-a-compose** UI: a name, an optional icon, a `docker-compose.yml` text area, and an optional `.env` text area.
- On submit the core **validates** the YAML before running anything: it must parse; reject or hard-warn on dangerous settings (`privileged: true`, `network_mode: host`, mounting `/var/run/docker.sock`, mounting sensitive host paths). Dangerous stacks require an explicit "I understand the risk" confirmation.
- The stack runs as project `omos-custom-<slug>`, labeled `com.openmasjid.app=custom-<slug>` and `com.openmasjid.kind=custom`. Data lives under `/opt/openmasjid/apps/custom-<slug>/`.
- After install it appears in the dashboard's installed-apps grid and is managed exactly like a catalog app (start / stop / logs / remove), but visually tagged "Custom".
- **Wording must make the risk clear** without being scary: e.g. *"Custom apps come from outside the OpenMasjidOS store and aren't reviewed by us. Only install ones you trust."*

---

## 11. Dashboard (home screen)

The dashboard is the landing page after login. It has two regions:

1. **System stats strip** (top): live cards for **CPU %**, **RAM used / total (+ %)**, **Disk used / total**, **Uptime**, and **Apps running (N)**. Values stream over WebSocket (~2s cadence) from the `stats` package (host `/proc`). Each numeric card has a small, tasteful sparkline/gauge — light, not busy.
2. **Installed apps grid**: each app as a card showing icon, name, running/stopped state, and quick actions (Open, Stop/Start, ⋯ for logs/remove/update). Empty state invites the user to "Visit the App Store." Custom apps carry a small "Custom" tag.

A primary call-to-action links to the **App Store**. Everything animates in with a gentle staggered entrance (respecting reduced-motion).

---

## 12. Settings (platform-only — NO masjid details)

Settings is about the **platform and the dashboard**, never about prayer/masjid configuration (that lives in apps). Two groups:

### 12.1 Customize
- **Theme:** Dark (default) / Light / Follow system.
- **Accent color:** small curated palette (emerald default, plus a few tasteful options incl. gold).
- **Dashboard name:** cosmetic title shown in the header (default `OpenMasjidOS`; a masjid may rename it to whatever they like — this is decoration, not prayer config).
- **UI language:** dashboard language (drives i18n + RTL).
- **Display preferences:** time format (12/24h) and timezone used for showing timestamps/log times in the dashboard. (Purely a display setting for the platform — not used for prayer calculations.)
- **Animations:** on / reduced (also auto-respects the OS reduced-motion setting).

### 12.2 Account
- Change admin password.

### 12.3 Advanced
- **Allow custom apps** (off by default) → enables the "3rd Party App" button in the App Store (see §10), with a clear risk note.
- **Network info:** show current hostname, `.local` address, and IP (read-only here; changes are made via the installer's "Reconfigure network").
- **Update channel & "Check for updates"** for the core.
- **Backup / Restore:** download a tarball of platform config + app volumes, and restore from one.

---

## 13. Design system & theming (this is a priority — make it feel premium)

### Identity
Calm, dignified, and modern. Inspired by Islamic geometric art (girih/arabesque tessellations) and the architecture of masjids (domes, arches/mihrab, minarets, the crescent). It should feel respectful and serene, never gaudy.

### Color tokens (define in `tokens.css` as CSS custom properties)
- **Dark (DEFAULT):** deep night-sky base (`#0E1814`-ish charcoal-green), elevated surfaces a step lighter, **emerald/teal** primary (`#1FA37A` family), warm **gold** accent (`#D4AF37`, used sparingly for highlights/active states). Text near-white with a green undertone.
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
- Live stat cards animate value changes smoothly (no jarring jumps).
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

## 14. Coding conventions

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
- Never log secrets. The platform never injects masjid data into apps — apps own that.

**Svelte/TS (frontend)**
- TypeScript everywhere; no `any` without a comment justifying it.
- Components small and composable; shared transitions/spring presets imported from `lib/animations`, not redefined ad hoc.
- All user-facing strings go through the i18n layer — no hardcoded English in components.
- All colors/spacing via tokens; no magic hex or px where a token exists.
- Layout must work LTR and RTL (use logical CSS properties: `margin-inline-start`, etc.).
- Guard authenticated routes; an unauthenticated visit always lands on login/first-run.

**Security**
- The installer is piped to bash, so it must stay readable and minimal in privilege.
- Validate every manifest **and** every pasted custom compose before running it; never `up` an untrusted stack without parsing and risk-checking it first.
- Default to least privilege for app containers.
- Network changes (static IP) are always confirmed and reversible-with-guidance; never silently rewrite a user's network config.

---

## 15. Build & run commands (keep these working)

```bash
make dev        # run backend + frontend with hot reload for local development
make build      # build UI, embed into Go binary, produce the Docker image
make lint       # golangci-lint + svelte-check + eslint
make test       # go test ./... + frontend unit tests
make image      # build & tag openmasjid/core:dev
```

---

## 16. Definition of done (for any feature)

A change is "done" only when: it builds via `make build`; it's covered by at least a basic test where logic is non-trivial; it works in **both** light and dark themes; it works in **both** LTR and RTL; it honors `prefers-reduced-motion`; authenticated areas stay behind login; all new strings are in i18n; user-facing wording is plain and friendly; and no raw technical error can reach the user un-prettified.

---

## 17. Version control policy

The canonical version lives in the **`VERSION`** file at the repository root. It is the single source of truth — the Makefile and Dockerfile both read it and stamp it into the Go binary via `-ldflags "-X ...api.version=<VERSION>"`. Never hardcode a version string anywhere else.

### Scheme: `MAJOR.MINOR.PATCH`

| Segment | When to bump | Example |
|---------|--------------|---------|
| **PATCH** (3rd) | Any small, backwards-compatible change — bug fixes, copy tweaks, minor UI improvements, dependency bumps. | `0.1.0` → `0.1.1` |
| **MINOR** (2nd) | A meaningful new feature or a significant change to existing behaviour — new page, new API endpoint, new installer capability. | `0.1.x` → `0.2.0` |
| **MAJOR** (1st) | **Reserved for the official public launch.** `1.0.0` signals production-ready, fully stable software. Do not bump to `1.x` before that milestone. | — |

### Current version: `0.1.0`

We are in **pre-release / active development**. All changes during this phase are `0.1.x` (patch) or `0.2.x`+ (minor feature milestones).

### How to bump the version
1. Edit the `VERSION` file — change the number, nothing else.
2. Commit with message `chore: bump version to x.y.z`.
3. Push. CI picks up the new version automatically and stamps it into the Docker image. The dashboard shows it in the Advanced → Network/About area.

---

## 18. Working agreement for Claude (the coding agent)

- Read this file first, every session. Treat §3 (scope), §8 (auth), §12 (settings = platform-only), and §13 (design/voice) as hard constraints.
- Build **vertically**: ship one full working slice end-to-end — backend + API + UI + theme + i18n — before starting the next.
- Suggested build order:
  1. Installer skeleton (fresh install path) + core that boots and serves the UI shell.
  2. **Auth: first-run admin creation + login + sessions.**
  3. Dashboard home with **live system stats**.
  4. Docker lifecycle for a hardcoded test app (install/start/stop/logs/remove).
  5. App Store catalog fetch + one-click install.
  6. **Settings** (customize + account + advanced toggle).
  7. **3rd-party custom-compose install** behind the advanced toggle.
  8. Installer lifecycle menu (update / repair / reconfigure network / uninstall) + **static IP + `.local` hostname**.
  9. Updates + backup/restore.
  10. Polish pass on animations and empty states.
- When you make a non-trivial architectural or naming decision, write it down in `docs/ARCHITECTURE.md`.
- If a task seems to require building an actual end-user app, **stop** — that belongs in `OpenMasjidAPPS`. Scaffold the manifest contract instead and ask.
- Never put masjid/prayer configuration into platform settings. If a feature seems to need it, it's an app concern.
- Ask before adding heavy dependencies; "lightweight" is a core value.
- Keep the README's curl one-liner accurate at all times.