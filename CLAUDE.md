# CLAUDE.md — OpenMasjidOS

> This file is the single source of truth for the OpenMasjidOS project. Read it fully before writing any code. When in doubt, follow this document over your own assumptions. If something here is ambiguous, ask before guessing.

---

## 1. What we are building (one paragraph)

**OpenMasjidOS** is a free, fully open-source, self-hosted operating layer that lets any masjid run useful software on their own hardware (a cheap mini-PC, a Raspberry Pi, a VPS — anything that runs Docker) with **zero technical knowledge**. It installs with a single `curl` one-liner that runs a complete guided setup, runs entirely in Docker, and presents a beautiful, masjid-themed web dashboard protected by a login. From that dashboard, an admin sees live system stats, browses an **App Store**, and installs apps with one click. Each app is just a Docker container described by a manifest, and **each app collects its own masjid-specific settings** (prayer calculation, location, etc.) — the platform itself stays generic. The apps live in a **separate repository called `OpenMasjidAPPS`**; OpenMasjidOS is the engine that finds, installs, runs, updates, and removes them.

Think: **"umbrelOS, but purpose-built and themed for masjids, and dead simple for a volunteer to run."**

---

## 2. The repositories

OpenMasjidOS is a **platform**, and apps live **outside** it. There are three layers:

| Repo | Purpose | Built in this project? |
|------|---------|------------------------|
| **`OpenMasjidOS`** (this repo) | The core platform: installer, backend daemon, web dashboard (with auth), app-store client, Docker lifecycle management, system stats. | ✅ Yes |
| **`OpenMasjidAPPS`** | The app **catalog/registry** — *not* app source. It holds a `registry.yaml` listing the app repos to include, plus tooling that aggregates them into a single static `catalog.json` at its repo root. This repo defines the catalog format and the app contract. | ⚙️ Separate repo (has its own `CLAUDE.md`). |
| **App repos** (one per app) | Each app lives in its **own** GitHub repo (`openmasjid-<id>`) with its `manifest.yaml`, `docker-compose.yml`, icon/screenshots, and a **public multi-arch image**. Listed in `OpenMasjidAPPS/registry.yaml`. | ❌ No (authored by app makers). |

```
app repos ──listed in──▶ OpenMasjidAPPS/registry.yaml ──build──▶ catalog.json ──fetched by──▶ OpenMasjidOS
```

**The platform only ever reads `catalog.json`** (default
`https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidAPPS/main/catalog.json`). How that file
is assembled (separate repos via a registry) is OpenMasjidAPPS's concern; the platform contract is
just the `catalog.json` shape + install mechanics in §10.

**Scope rule:** In *this* repo we do **not** build the individual end-user apps (prayer clock, donation app, etc.). We build the *platform that runs them* and we define the *contract* (manifest spec) that apps in `OpenMasjidAPPS` must follow. Any masjid-specific configuration (prayer times, location, calculation method) is owned by the individual apps, **never** by the platform.

---

## Branching policy

**Read this before touching the repo. It applies to every session.**

| Branch | Role |
|--------|------|
| **`master`** | **Stable / release.** What beta masjids run. Protected. |
| **`dev`** | **The default working branch.** All commits land here. |

- **All development happens on `dev`, from this point on, permanently.** Never commit to `master`. This holds for every change — features, fixes, docs, one-line typos, dependency bumps. There is no size of change that justifies going straight to `master`.
- **`master` receives changes ONLY when Hasan explicitly says "merge to main."** Never merge, fast-forward, rebase onto, or cherry-pick into `master` on your own initiative — not for hotfixes, not for docs, not for "trivial" one-liners. That merge *is* a release: bump `VERSION`, tag, publish, and add a `CHANGELOG.md` entry per §18.
- **After every push to `dev`, end the reply by asking whether to push to main.** Once work is committed and pushed to `dev`, the last thing in the response asks: *do you want me to push this to main?* Then keep working on `dev` — and keep asking after each push — until Hasan says "push to main" (or "merge to main"). Do not treat silence, a new task, or approval of the *work* as approval to release; only those words are.
- **Session-start check:** run `git branch --show-current`. If it is not `dev`, switch before touching anything.
- **Branches:** only `master`, `dev`, and `cla-signatures` should exist. Delete feature branches once merged. **Never delete `cla-signatures`** — it holds `signatures/version1/cla.json`, the record of who signed the CLA, and the CLA Assistant bot commits there (§3). It looks like a stray branch and is not one.

> **Why `master` and not `main`.** The org standardises on `main` = stable, and the *update channel* value is literally `'main'` because it indexes OpenMasjidAPPS, whose stable branch genuinely is `main`. This repo's stable branch is still `master`: renaming a default branch retargets the protection rule and the required `cla` check and breaks every existing clone, for no functional gain. So **the channel word is not always the branch name** — `system/channel.ts` `osBranch()` owns that mapping (`'main'` → `master`), and anything needing a git ref for this repo must go through it rather than interpolating the channel. A rename is a deliberate future decision, not something to do in passing.

## 3. Prior art & licensing — read this carefully

OpenMasjidOS is **heavily inspired by umbrelOS** (`getumbrel/umbrel`). That is our UX target: a polished React dashboard, a one-command install, an app store of Docker apps, and live system stats. We deliberately mirror its **stack and design language** — a TypeScript monorepo, a Node daemon that manages Docker, and a React + Vite + Tailwind + tRPC frontend.

**However, umbrelOS is licensed under PolyForm Noncommercial 1.0.0 — it is NOT free for commercial use.** OpenMasjidOS is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)** — a strong copyleft, OSI-approved open-source license. PolyForm-Noncommercial and AGPL-3.0 are **incompatible** (one forbids commercial use, the other guarantees it), so their code cannot legally be combined. Therefore:

- ✅ **Take inspiration.** Study how Umbrel structures things, mirror the stack, and reimplement similar UI/UX patterns **in our own original code**.
- ❌ **Do NOT copy, paste, vendor, or fork Umbrel's source code, assets, icons, or app manifests** into this repo. Combining PolyForm-Noncommercial code with AGPL-3.0 is a license violation — the two terms directly contradict each other.
- 🛑 **If you ever catch yourself pasting Umbrel code, stop** and re-implement it from the described behaviour instead.
- Umbrel's app catalog (`getumbrel/umbrel-apps`) is likewise under its own license. Our apps live in our own `OpenMasjidAPPS` repo and are authored fresh.

Everything in this repo must be safe to ship under AGPL-3.0. When in doubt about provenance, write it yourself.

### What AGPL-3.0 means for this project (practical summary, not legal advice)

AGPL is strong copyleft with a **network clause (Section 13)**: anyone who runs a **modified** version and lets users interact with it over a network must offer those users the modified source. Practical implications for how we build:

- A masjid running the **official, unmodified** build has nothing extra to do — they aren't distributing a modified version.
- Anyone who **forks/modifies** OpenMasjidOS and hosts it for others must make their modified source available. To make compliance effortless, **the UI must include a visible "Source code" link** (in Settings → Advanced / About) pointing to the project repository. Build this in.
- **Apps stay at arm's length, so they keep their own licenses.** Apps (catalog and 3rd-party) run as **separate Docker containers/processes** that only communicate with the platform over defined interfaces (network, the Docker socket, env vars). Separate programs communicating at arm's length are generally not a single combined work, so **app authors may license their apps however they wish** (MIT, proprietary, etc.) — the platform's AGPL does not reach into them. Keep this boundary clean: never link app code into the core, and never make an app import core runtime code. (This is why the `license:` field in an app manifest is the app author's choice.)
- **Permissively licensed dependencies are fine.** React, Vite, Tailwind, tRPC, Fastify, dockerode, systeminformation, Motion, shadcn/ui, lucide (all MIT/ISC/BSD) are AGPL-compatible. Avoid adding any dependency whose license is incompatible with AGPL-3.0.
- **Contributions: AGPL-3.0 + a CLA (dual-licensing).** Every contribution is governed by the **Contributor License Agreement** ([`CLA.md`](CLA.md)) and `CONTRIBUTING.md`. Contributors keep their copyright but grant OpenMasjid-Solutions the right to **also** offer the software under commercial/proprietary terms (dual licensing) — so the public tree is *always* AGPL-3.0 while the maintainer can sustain the project commercially. The CLA is signed once, automatically, on a contributor's first PR (CLA Assistant bot → `.github/workflows/cla.yml`). Signatures are committed to `signatures/version1/cla.json` on a **dedicated, unprotected `cla-signatures` branch** — NOT the default branch, which is protected with a required `cla` status check that the bot cannot commit to (`Required status check "cla" is expected`). Every repo in the org uses this identical workflow. Keep every source file's SPDX header (`SPDX-License-Identifier: AGPL-3.0-only`).

*(Licensing specifics can be subtle — confirm anything load-bearing with a qualified source rather than relying on this summary.)*

---

## 4. Scope

### ✅ In scope (v1.0)
- **A full-lifecycle one-line `curl | bash` installer.** On a fresh machine it runs a complete guided **install**. On a machine that already has OpenMasjidOS, the same command opens a **management menu**: Update / Repair / Reconfigure network / Uninstall. Works on common Linux (Debian/Ubuntu, Raspberry Pi OS, Fedora), architecture-aware (amd64 + arm64).
- Installer auto-installs Docker + the Docker Compose plugin if missing, sets up OpenMasjidOS as a managed service, and during install also:
  - **Optionally configures a static IP** for the machine (guided, confirmed, safe — see §8).
  - **Sets a hostname and mDNS** so the dashboard is reachable at **`http://openmasjidos.local`** (plus the raw IP as a fallback).
- **Web UI authentication.** The dashboard is always behind a login. The **first time** the dashboard is opened, the user creates the **admin account**. Sessions use secure, HTTP-only cookies. No part of the UI is reachable unauthenticated except the login/first-run screen.
- **Core backend (daemon):** a type-safe **tRPC** API (over HTTP, with WebSocket subscriptions for live data). Manages container lifecycle via the Docker Engine API.
- **Dashboard home with live system stats:** CPU %, RAM used/total, disk used/total, CPU temperature (where available), uptime, and count of running apps — updated live — alongside the grid of installed apps.
- **App management:** install / start / stop / restart / remove / update apps; view status and logs.
- **File explorer:** a dock app to browse, upload, download, rename, and delete files under the data dir (sandboxed server-side — no path-traversal or symlink escape).
- **App Store client:** fetches the catalog from `OpenMasjidAPPS`, renders listings, handles one-click install.
- **Settings (platform-only):** dashboard customization (theme, accent, dashboard name, UI language, display preferences) and an **Advanced** section (see §13). **Settings contains NO masjid/prayer details** — those belong to apps.
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

## 5. Architecture

```
                       ┌──────────────────────────────────────────┐
                       │             User's browser                │
                       │   OpenMasjidOS UI (React + Vite + TW)      │
                       │       reached at openmasjidos.local        │
                       └───────────────▲────────────────────────────┘
                                       │ tRPC over HTTPS
                                       │ (+ WebSocket subscriptions)
                                       │   — login required —
                       ┌───────────────┴────────────────────────────┐
                       │   OpenMasjidOS Core (Node + TypeScript)     │
                       │  • tRPC routers (auth/apps/store/...)       │
                       │  • Auth & sessions (admin account)          │
                       │  • App lifecycle (install/start/stop/rm)    │
                       │  • App Store client (fetches catalog)       │
                       │  • Custom-compose (3rd-party) installer      │
                       │  • Platform settings store                  │
                       │  • Live system stats (CPU/RAM/disk/temp)    │
                       │  • Serves the built UI static assets        │
                       └───────┬───────────────────────┬─────────────┘
                               │ dockerode + compose    │ HTTPS
                ┌──────────────▼──────────────┐   ┌─────▼──────────────────────┐
                │   Docker (host daemon)       │   │  OpenMasjidAPPS catalog    │
                │  • app containers/stacks     │   │  (GitHub raw / releases)   │
                │  • custom (3rd-party) stacks │   │  catalog.json + manifests  │
                │  • named volumes per app     │   └────────────────────────────┘
                └──────────────────────────────┘
        Host: avahi (mDNS → .local), optional static IP, host /proc for stats
```

- **Core** is a single Node/TypeScript daemon, shipped as **one Docker image** (`openmasjid/core`) that both serves the built React UI and exposes the tRPC API. It talks to the host Docker daemon via the mounted socket `/var/run/docker.sock`.
- **Type safety end-to-end:** the UI imports the core's tRPC `AppRouter` **type** (types only, never runtime code) so the client and server can never drift. Live data (stats, status, logs) uses **tRPC subscriptions over WebSocket**.
- **System stats** come from `systeminformation`, reading host metrics (mount host `/proc` and `/sys` read-only into the core so CPU/RAM/disk/temp reflect the *machine*, not the container).
- **Apps** (catalog and custom) are launched as their own Docker Compose projects (one project per app), labeled so the core can find and manage them.
- **Networking:** the host runs avahi so `openmasjidos.local` resolves on the LAN; the installer can optionally pin a static IP.
- **Catalog** is plain static files served from the `OpenMasjidAPPS` repo. No app-store server to run.

---

## 6. Tech stack (this mirrors umbrelOS deliberately — confirm or override before deviating)

| Layer | Choice | Notes |
|-------|--------|-------|
| Language | **TypeScript everywhere** | One language across the whole codebase. No `any` without a justifying comment. |
| Repo layout | **npm workspaces monorepo** (`packages/*`) | Like umbrelOS. Optional Turborepo later if builds get heavy. |
| Backend runtime | **Node.js 20+** daemon | The "umbreld" equivalent. Long-running service. |
| API layer | **tRPC** | End-to-end type safety; queries/mutations + **subscriptions over WebSocket** for live data. |
| HTTP server | **Fastify** (tRPC Fastify adapter) | Lightweight, fast; also serves the built UI assets. |
| Docker control | **dockerode** + shelling to `docker compose` | All Docker interaction wrapped in one module. |
| System stats | **systeminformation** | CPU/RAM/disk/uptime/temperature; reads host `/proc`. |
| Auth | **argon2** (hashing) + signed, HTTP-only session cookie | Single admin in v1.0. |
| Frontend framework | **React 18 + Vite + TypeScript** | The UX target's framework; biggest animation/component ecosystem. |
| Styling | **Tailwind CSS v4** + CSS custom properties | Tailwind v4 uses CSS `@theme`; theme tokens live in CSS and flip via `data-theme`. |
| Components | **shadcn/ui** (Radix primitives, copied-in) | Accessible, fully owned in-repo, easy to theme. |
| Animation | **Motion** (formerly Framer Motion) | Spring physics + micro-interactions; honors reduced-motion. |
| Data/state | **TanStack Query** via tRPC's React Query integration | Caching, live updates, optimistic UI. |
| Charts | tiny SVG sparkline/gauge components | For the live CPU/RAM/temp cards; keep light. |
| Icons | **lucide-react** + a small custom masjid glyph set (dome, minaret, crescent, mihrab arch) | Consistent, light. |
| i18n | **i18next / react-i18next** | Translation-ready + RTL aware from day one. |
| Build/deploy | Docker multi-stage (build UI + core → one runtime image) | Final image runs the Node daemon, which serves the UI. |
| Container mgmt | Docker Compose v2 (`docker compose` plugin) | Every app is a compose project. |
| Host networking | `avahi-daemon` (mDNS), distro-native static-IP tool (netplan / nmcli / dhcpcd) | `.local` access + optional fixed IP. |

> **"Lightweight" now means "runs comfortably on a Raspberry Pi / small mini-PC"** (umbrelOS's proven footprint), not "single static binary." Keep dependencies lean, lazy-load heavy UI, and don't pull in frameworks we don't need.

---

## 7. Repository structure (`OpenMasjidOS`)

```
OpenMasjidOS/
├── CLAUDE.md                  # this file
├── README.md                  # human-facing, with the curl one-liner up top
├── LICENSE                    # AGPL-3.0 (NOT PolyForm — see §3)
├── VERSION                    # single source of truth for the version (see §18)
├── package.json               # npm workspaces root + top-level scripts
├── install.sh                 # the one-line installer / lifecycle manager
├── Dockerfile                 # multi-stage: build ui + core → one runtime image
├── docker-compose.yml         # how the core runs itself
│
├── packages/
│   ├── core/                  # Node + TypeScript daemon (the "umbreld" equivalent)
│   │   ├── src/
│   │   │   ├── index.ts                # boot: Fastify + tRPC + WS + static UI
│   │   │   ├── trpc/
│   │   │   │   ├── router.ts            # root AppRouter (exported type → UI)
│   │   │   │   ├── auth.ts              # first-run, login, sessions
│   │   │   │   ├── apps.ts              # catalog app lifecycle
│   │   │   │   ├── custom.ts            # 3rd-party pasted-compose install
│   │   │   │   ├── store.ts             # App Store catalog client + cache
│   │   │   │   ├── settings.ts          # platform settings (NO masjid data)
│   │   │   │   ├── stats.ts             # live system stats subscription
│   │   │   │   └── system.ts            # updates, backup/restore, network info
│   │   │   ├── auth/                    # argon2, session helpers
│   │   │   ├── docker/                  # dockerode + compose wrappers (single entry point)
│   │   │   ├── apps/                    # manifest parsing + lifecycle logic
│   │   │   ├── store/                   # catalog fetch + cache
│   │   │   └── stats/                   # systeminformation host metrics
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── ui/                    # React + Vite + Tailwind v4 + shadcn
│       ├── src/
│       │   ├── main.tsx
│       │   ├── routes/
│       │   │   ├── login/              # login + first-run admin creation
│       │   │   ├── dashboard/          # home: system stats + installed apps grid
│       │   │   ├── store/              # App Store (+ "3rd Party App" entry when enabled)
│       │   │   ├── store/custom/       # paste-a-compose install UI
│       │   │   ├── apps/$id/           # app detail: status, logs, controls
│       │   │   └── settings/           # customize + account + advanced
│       │   ├── components/             # shadcn-based + masjid components, stat gauges
│       │   ├── lib/
│       │   │   ├── trpc.ts             # typed client (imports AppRouter type from core)
│       │   │   ├── theme/              # tokens.css, theme provider, RTL handling
│       │   │   ├── motion/             # shared Motion presets (springs, transitions)
│       │   │   └── i18n/               # locales + helpers (RTL aware)
│       │   └── index.css               # Tailwind v4 @import + @theme tokens
│       └── package.json
│
├── scripts/                   # dev helpers used by package.json/install.sh
└── docs/
    ├── ARCHITECTURE.md
    ├── APP_MANIFEST_SPEC.md   # catalog contract + the OpenMasjidOS Fabric (app integration: appearance + SSO)
    ├── NETWORKING.md          # static IP + mDNS behaviour and safety notes
    └── THEMING.md
```

**Type-only import rule:** `packages/ui` may import **types** from `packages/core` (e.g. `import type { AppRouter } from "@openmasjid/core"`), never runtime code. The browser bundle must not contain server code.

---

## 8. The installer (`install.sh`) — a full lifecycle tool

**Goal:** a non-technical masjid volunteer copies one line, pastes it into their server's terminal, answers a couple of friendly prompts, and a minute later gets a URL to open. Running the *same* line again later gives them safe maintenance options — they never need to remember any other command.

```bash
bash -c "$(curl -fsSL https://get.openmasjid.org || wget -qO- https://get.openmasjid.org)"
```
(The curl-or-wget form means it still works on minimal systems that ship without curl — the
installer then installs curl itself for the steps that need it. Before a domain exists, swap the
domain for the raw GitHub URL: `https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidOS/master/install.sh`.)

### 8.1 Behaviour: detect state, then branch
On start the script detects whether OpenMasjidOS is already installed (presence of `/opt/openmasjid` and/or the core container).

**A) Fresh machine → guided INSTALL** (see 8.2).
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

### 8.2 Guided INSTALL steps
The script must:
1. Be **POSIX-ish bash**, fail fast (`set -euo pipefail`), and be idempotent (re-running is always safe).
2. Detect OS + architecture; refuse clearly on unsupported platforms with a friendly message.
3. Ensure `curl` is present (many minimal systems/LXC templates ship without it) — install it via the system package manager if missing. Then ensure Docker is present; if missing, install via the official convenience method, then ensure the `docker compose` plugin exists.
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

### 8.3 Flags (for advanced/automated use; interactive is the default)
Support non-interactive overrides: `--yes` (accept defaults), `--hostname <name>`, `--static-ip <cidr> --gateway <ip> --iface <name>`, `--no-network` (skip static IP **and** hostname changes), `--port <n>` (default `80`).

**Default port:** `80` (so the dashboard URL needs no port suffix). **Data dir:** `/opt/openmasjid`.

> The installer is piped to bash, so it must stay **readable and commented** — we are asking people to trust it. No obfuscation, ever. Keep it auditable and minimal in privilege.

---

## 9. First-run web setup & authentication

The dashboard is **always** behind a login. There is no pre-baked password and no anonymous access to any feature.

- **First visit (no admin exists yet):** the user lands on a first-run screen and **creates the admin account** — **name + email + password** (enforce a sane minimum strength). **Login is by username** (= the name), NOT the email; the **email is stored only for sending OS alerts** (an app going offline, etc.). This keeps pre-email installs working (they log in with their original username; they can add an alert email in Settings → Account). `verifyCredentials` accepts the stored username OR the email. Optionally let them pick a theme (dark is pre-selected) and UI language. Then they go straight to the dashboard. **Do not ask for any masjid/prayer details here** — that belongs to apps.
- **Subsequent visits:** standard login screen → dashboard. Wrong credentials get a friendly, rate-limited error.
- **Sessions:** server-side session, secure + HTTP-only + SameSite cookie. Logout clears it. Passwords hashed with **argon2id** (the `argon2` package), never stored or logged in plaintext.
- **Account management** (in Settings): change password. (Multiple users/roles are v1.1.)
- **tRPC guard:** every router except the auth/first-run procedures requires a valid session; the UI redirects unauthenticated users to login.

---

## 10. App catalog contract (what the platform consumes)

Apps are **not** part of this repo, and they are **not** folders in `OpenMasjidAPPS` either. Each app
lives in its **own** repository (`openmasjid-<id>`: a `manifest.yaml`, a `docker-compose.yml`, an
icon, screenshots, and a public **multi-arch** image). `OpenMasjidAPPS` keeps a `registry.yaml`
listing those app repos, and its CI aggregates them into one static **`catalog.json`** at its repo
root. **The platform only ever fetches that `catalog.json`** — it never sees the individual app
repos. How the catalog is assembled is `OpenMasjidAPPS`'s concern (see its own `CLAUDE.md` +
`docs/BUILDING_AN_APP.md`).

So the contract the platform owns is the **`catalog.json` shape + install mechanics** below — this is
the source of truth both repos must agree on. If it changes here, `OpenMasjidAPPS` must change to
match (and vice-versa).

**Important:** the platform holds **no** masjid profile. Anything masjid-specific (location, calc
method, Asr madhab, timezone, masjid name) is collected **by the app itself** via its own `settings`
block and used inside the app — never injected by the platform.

`catalog.json` is `{ "apps": [ … ] }` (a bare array is also accepted). Each entry is a `CatalogApp`
(`packages/core/src/apps/types.ts`). An app author writes most of this as their repo's
`manifest.yaml`; the catalog build embeds the repo's `docker-compose.yml` as the `compose` string
and rewrites `icon`/`screenshots` to absolute URLs:

```yaml
id: prayer-times-display          # REQUIRED. unique, kebab-case, ^[a-z0-9][a-z0-9-]{0,79}$
name: Prayer Times Display        # REQUIRED
version: 1.0.0                     # REQUIRED. semver (drives "Check for update")
compose: |                        # REQUIRED. the app's ENTIRE docker-compose.yml, as a string
  services:
    app:
      image: ghcr.io/owner/openmasjid-prayer-times-display:1.0.0   # pinned, public, multi-arch
      environment:
        LATITUDE: ${LATITUDE}     # settings arrive as ${KEY} via an --env-file
        CALC_METHOD: ${CALC_METHOD}
      ports: ["8080:80"]          # MUST publish the web-UI port (used for "Open")
      restart: unless-stopped
tagline: A beautiful prayer clock for your masjid's screens
category: displays                # displays | donations | community | quran | admin | utilities
author: Your Name
license: MIT                      # the app author's choice (apps run at arm's length — see §3)
icon: https://…/icon.svg          # absolute URL (catalog build makes it absolute)
screenshots: [https://…/1.png]    # absolute URLs
description: |                     # markdown, shown on the app detail page
  Full description here.
settings:                         # collected from the user before install (no platform profile)
  - key: LATITUDE
    label: Latitude
    type: text                    # text | select | number | password | boolean
  - key: CALC_METHOD
    label: Prayer calculation method
    type: select
    options: [MWL, ISNA, Egypt, Makkah, Karachi, Tehran, Jafari]
    default: MWL
ports:                            # informational metadata only (the compose does the real publish)
  - container: 80
    label: Web interface
fabric:                           # OPTIONAL — app-to-app broker (v0.40.0); catalog apps only
  provides:                       #   capabilities this app SERVES at /fabric/<capability>/<method>
    - capability: billing
  consumes:                       #   capabilities it may CALL, "<target-app-id>/<capability>"
    - students/billing
tunnel: true                      # OPTIONAL — REQUEST internet exposure (admin confirms in Settings)
email: true                       # OPTIONAL (v0.41.0) — may POST /api/fabric/email to send mail
alerts:                           # OPTIONAL (v0.41.0) — admin gets a granular on/off per alert
  - id: reader-offline            #   kebab id passed to POST /api/fabric/alert
    label: Card reader offline
    description: A payment reader stopped responding.
```

How the core installs/manages a catalog app (the real behaviour):
- **Install** = write the entry's `compose` to `compose.yml`, write the user's `settings` answers to a
  `.env`, then `docker compose -p omos-<id> --env-file .env up -d --remove-orphans`. Per-app files +
  data live under `/opt/openmasjid/apps/<id>/`.
- **Discovery** is by the compose **project name** `omos-<id>` (Docker's automatic
  `com.docker.compose.project` label). Apps add **no** special labels; the platform records each
  app's kind/version in its own `apps/<id>/meta.json`.
- **Open URL** comes from the container's **published host port**; the platform checks host-port
  conflicts before install and offers to remap.
- **Update** (catalog app) = re-fetch the entry, rewrite `compose.yml` (keeping the user's `.env`),
  `compose pull` + `up -d` — settings and data preserved (app ⋮ → "Check for update").
- **Remove** = `compose down` (with `--rmi all -v` when the user also deletes the app's data).
- Validate every entry before running it (kebab `id`, required fields); never `up` an untrusted
  compose without risk-checking it first (§11, §15). A `fabric:` block is shape-validated
  (`parseFabric`) and issues the app the per-app secret; `tunnel: true` is a request that the admin
  confirms per-app in Settings (default off). Full contract + broker/tunnel mechanics:
  `docs/APP_MANIFEST_SPEC.md` and `docs/FABRIC_APP_LINK_AND_TUNNEL.md`.

---

## 11. Third-party / custom apps (advanced, opt-in)

This is **off by default**. It is enabled in **Settings → Advanced → "Allow custom apps"**.

- When enabled, the **App Store gets a "3rd Party App" button** (visually marked as advanced). When disabled, that button does not exist anywhere in the UI.
- The button opens a hub with two ways in:
  - **Community apps** — browse + install apps from **CasaOS-compatible app stores** the admin adds by URL (an "Add app store" field; a note recommends CasaOS-compatible repos). Installed community apps are tagged "Community".
  - **Docker Compose** — a **paste-a-compose** UI: a name, an optional icon, a `docker-compose.yml` text area, and an optional `.env` text area.
- On submit the core **validates** the YAML before running anything: it must parse; reject or hard-warn on dangerous settings (`privileged: true`, `network_mode: host`, mounting `/var/run/docker.sock`, mounting sensitive host paths). Dangerous stacks require an explicit "I understand the risk" confirmation.
- The stack runs as project `omos-custom-<slug>`, labeled `com.openmasjid.app=custom-<slug>` and `com.openmasjid.kind=custom`. Data lives under `/opt/openmasjid/apps/custom-<slug>/`.
- After install it appears in the dashboard's installed-apps grid and is managed exactly like a catalog app (start / stop / logs / remove), but visually tagged "Custom".
- **Wording must make the risk clear** without being scary: e.g. *"Custom apps come from outside the OpenMasjidOS store and aren't reviewed by us. Only install ones you trust."*

---

## 12. Dashboard (home screen)

The dashboard is the landing page after login. It has two regions:

1. **System stats strip** (top): live cards for **CPU %**, **RAM used / total (+ %)**, **Disk used / total**, **CPU temperature** (where available), **Uptime**, and **Apps running (N)**. Values stream via a **tRPC subscription** (~2s cadence) from the `stats` router (host metrics through systeminformation). Each numeric card has a small, tasteful sparkline/gauge — light, not busy.
2. **Installed apps grid**: each app as a card showing icon, name, running/stopped state, and quick actions (Open, Stop/Start, ⋯ for logs/remove/update). Empty state invites the user to "Visit the App Store." Custom apps carry a small "Custom" tag.

A primary call-to-action links to the **App Store**. Everything animates in with a gentle staggered entrance (respecting reduced-motion).

---

## 13. Settings (platform-only — NO masjid details)

Settings is about the **platform and the dashboard**, never about prayer/masjid configuration (that lives in apps). Three groups:

### 13.1 Customize
- **Theme:** Dark (default) / Light / Follow system.
- **Accent color:** small curated palette (emerald default, plus a few tasteful options incl. gold).
- **Dashboard name:** cosmetic title shown in the header (default `OpenMasjidOS`; a masjid may rename it to whatever they like — this is decoration, not prayer config).
- **Masjid logo:** an optional uploaded logo (PNG/JPG/WebP, ≤1 MB; raster only — no SVG). Stored server-side as raw bytes (`config/branding/`, chmod 600), NOT a data URI in settings. Reused across the masjid's outbound comms: notification webhooks (Slack/Discord) show it as the sender avatar, OS-sent emails (alerts + the test) show it as a remote `<img>` — **both only when remote access is configured**, because the receiving service fetches the image from *its* network, so a LAN address is useless — and apps can read it over the Fabric (`/api/public/appearance` → `logo`) to brand their own receipts. **Email deliberately does NOT use a CID attachment** (it did until v0.47.0): the MIME was correct — nodemailer emits `multipart/related` + `Content-Disposition: inline`, and Resend's `content_id` is its only documented inline lever with no disposition field — but mail clients list *any* part carrying a filename in their attachment row, so the logo arrived as a downloadable `logo.png`. Dropping the filename is the only thing that changes the MIME and it breaks inline rendering in Outlook/Thunderbird, so the only provider-independent fix is to send no attachment at all. Without a tunnel, the masjid's name renders as a text wordmark instead (always rendered, so a client that blocks remote images is never left with a blank header). Admin upload/clear is LAN-only + auth-gated; the read is the public `GET /api/public/logo`. Still presentation, not masjid/prayer config.
- **UI language:** dashboard language (drives i18n + RTL).
- **Display preferences:** time format (12/24h) and timezone used for showing timestamps/log times in the dashboard. (Purely a display setting for the platform — not used for prayer calculations.)
- **Animations:** on / reduced (also auto-respects the OS reduced-motion setting).

### 13.2 Account
- Change admin **name + email** (email = login id + where OS alerts go) and password.

### 13.2b Email (SMTP / Resend)
- Configure ONE email provider — **SMTP** (host/port/TLS/user/pass) or **Resend** (API key) — plus a From address/name. The secret (SMTP password / Resend key) is stored in `config/email.json` (chmod 600) and never returned to the UI (only "is set" flags). A **"Send test email"** button verifies it, and a green/red status dot shows configured/not. Apps send mail through this over the Fabric (`POST /api/fabric/email`, `email` capability) — no app ever handles the credentials or the From address.

### 13.2c Alerts (granular per-alert × per-channel matrix, UniFi-style)
- A list of every alert type — OS built-ins (an app going offline, a **core update available**, an **app update available**, a **card payment disputed** — see 13.2d) **plus each installed app's declared `alerts:`** — each with a **per-channel matrix**: route it to the admin **Email**, the **Webhook**, both, or neither. **Both channels on by default**; the platform persists only non-default choices (`config/alerts.json` → `channels`, with a legacy `disabled`-set migrated on load). When an alert fires, `deliverAlert` sends it to exactly the channels the admin chose (each fail-soft). Apps raise their declared alerts via `POST /api/fabric/alert`; the webhook (`/api/fabric/notify`) stays available on its own. The OS built-in update alerts are fired by a background monitor (`system/update-monitor.ts`) that polls for a new core version + newer versions of installed catalog apps and raises `core-update` / `app-update` the moment one is detected (once per version, not every cycle). **These alerts go to the ADMIN only** — an app emailing an end user (donor/parent/teacher) does that itself via `POST /api/fabric/email`, outside this matrix.

### 13.2d Chargeback alerts (`stripe-chargeback`)
- The platform polls each configured Stripe account for **disputes** (chargebacks) and raises the OS `stripe-chargeback` alert through the same matrix (`system/stripe-monitor.ts` + `stripe/disputes.ts`). No-op until a Stripe account exists; no app change needed.
- **Why the platform and not a donations app.** A dispute belongs to the **account**, and the whole point of the Stripe vault (§13.2 / `store/stripe.ts`) is that several apps share ONE account — so an app-raised alert would double-fire or, if that app were stopped, never fire. Chargebacks also arrive days/weeks after the payment, when the app may well be off.
- **Why polling and not a webhook.** A Stripe webhook needs a publicly reachable platform route, and §15 permits exactly two public-over-tunnel routes (`/api/public/appearance`, `/api/public/logo`) — a third would breach that invariant, and would still leave every LAN-only masjid with no alerts. Polling is outbound-only, adds no attack surface, and works with no remote access. The cost is latency (≤ one 30-min interval) against a dispute window measured in days.
- **This is monitoring, not payment processing** — it stays inside §4's "payment-agnostic" rule. The platform creates no charges and moves no money; it reads dispute status with credentials it already holds, exactly as the existing green/red Stripe status dot does.
- Rules that must not regress: **state is PERSISTED** (`config/stripe-disputes.json`) because a chargeback is a one-shot event — in-memory tracking would re-alert every open dispute on each restart; a **failure to reach Stripe records NOTHING** (treating "couldn't ask" as "none" would mark unseen chargebacks as seen and lose them permanently) and never alerts; **first run** absorbs settled history silently but DOES alert anything still `needs_response`, because doing nothing loses that money by default; and **>5 new disputes in one poll become one grouped alert**, since card-testing fraud can otherwise flood the inbox. Amounts respect zero-/two-/three-decimal currencies (JPY, KWD) — dividing by 100 regardless would misreport a Gulf masjid's KWD by 10x.

### 13.4 Update channel (Stable / Development)
- **ONE global setting** (`updateChannel: 'main' | 'dev'`, default `'main'`) governs the OS, the App Store catalogue **and every installed app together**. Never a mix; no per-app override in v1. `system/channel.ts` is the single place that turns a channel into concrete targets:

  | | Stable (`main`) | Development (`dev`) |
  |---|---|---|
  | Catalogue | `OpenMasjidAPPS/main/catalog.json` | `OpenMasjidAPPS/dev/catalog.json` |
  | Core image | `:latest` | `:dev` |
  | This repo's branch (VERSION, CHANGELOG) | `master` | `dev` |

- **The channel word is NOT the branch name for this repo** — `osBranch()` maps `'main'` → `master` (see the Branching policy above). Never interpolate the channel into an OpenMasjidOS raw URL.
- **The platform updates by image tag, not by git.** `docker/update.ts` inspects its own container and rewrites only the *tag*, so a masjid on a private mirror keeps their registry — and a **digest-pinned** reference is left alone, because the operator pinned it deliberately.
- **Switching goes through `system.setUpdateChannel`, never `settings.update`.** The order is the safety property: read the TARGET catalogue first (`requireCatalog`, which throws), and only persist once it's proven readable. An unreachable or malformed dev catalogue therefore leaves the masjid exactly where it was rather than pointing at a channel whose apps it can't resolve. Both caches are keyed by channel *and* cleared on switch, so a switch can never serve the other channel's entries.
- **Apps don't move on their own.** After a switch, `appsPendingChannel()` lists catalogue apps still on the old channel and the UI offers "Update all" plus per-app update, reusing the existing update stream. Recreating every container the instant a toggle flips would take a masjid's displays down unannounced. `AppMeta.channel` records where each app came from; `undefined` is grandfathered as `'main'` so upgrading doesn't mark every existing app pending.
- **Development is VERSIONED, and therefore uses the same update path as Stable — there is no Development-specific update logic, and nothing should reintroduce any.** A dev build's version is a semver **prerelease**: this repo's `dev/VERSION` holds `0.50.0-dev.1`, and a dev catalogue entry holds e.g. `0.11.0-dev.1` and pins that **exact immutable image tag** (never `:dev`). So `checkForUpdate` / `checkCatalogUpdate` just compare versions on both channels, the update alert fires on both, and `reason` is only `'version' | 'channel'`.
  - **Ordering is the point:** `0.49.3 < 0.50.0-dev.1 < 0.50.0-dev.2 < 0.50.0`. A prerelease sorts above the last release and below the one it precedes, which is exactly what a dev build is. `util/version.ts` implements real semver precedence — prerelease identifiers compare **numerically** (`-dev.10 > -dev.9`; a text compare silently stops offering updates at the tenth dev build) and a release outranks its own prereleases (the old dotted-numeric compare read `0.50.0-dev.4` as `[0,50,0,4]` and so called it *newer* than `0.50.0`). `packages/ui/src/lib/version.ts` is a deliberate copy — keep the two in step.
  - **An update pulls the exact version, not the channel alias.** `coreTargetTag()` returns the version on dev (`:0.50.0-dev.2`) and `:latest` on Stable. `:dev` is a moving alias that can still point at the previous build while a new one publishes, so pulling it can install different bytes than the version just announced; the exact tag either gets that build or fails loudly, and "it may still be building" is the honest message. Stable stays on `:latest` because there the two are equivalent by construction and `:latest` is what the installer writes.
  - **This is why `dev/VERSION` must be bumped to publish a dev build** — the bump *is* the publish, and CI tags the image from `VERSION` (`type=raw`), which is what makes the tag pullable. Pushing to dev without bumping republishes the same tag; that's tolerable only because no box was told to move to it.
  - **What this replaced, and must not come back:** dev entries used to repeat the stable version and point at `:dev`, so nothing observable changed when a build was published. Everything built to compensate — `usesMovingTags()`, `movingTag`, `reason: 'dev-refresh'`, `certain`, a `CatalogApp.imageDigests` map, `docker/image-ref.ts`'s digest comparison, a suppressed update banner, a manual "check for a new Development build" action — was a second update axis faking a version axis, and all of it is deleted. If Development ever seems to need its own detection mechanism again, the actual bug is a dev build without a distinct version.
- **dev → main is a DOWNGRADE, not a symmetrical toggle.** Dev may be ahead in ways that don't reverse: images and schemas need not be backward compatible. Both directions are confirmed, and the downgrade dialog says plainly that data written by a Development version may misbehave and that a pre-switch backup is the remedy. **No automatic data migration is attempted** — pretending to migrate would be worse than saying we can't.
- Only **catalogue** apps track a channel. Community and custom apps come from a URL or a pasted compose the admin owns, so the OS has no other version to offer and must not claim they're pending.
- Legacy: `updateChannel` shipped in ≤0.48.x as `'stable' | 'beta'` — declared but never read. `coerceChannel` migrates `stable`→`main`, `beta`→`dev`, and anything unrecognised → `main`, because the safe answer to "I can't tell which channel you wanted" is the tested one. This **must** run after the spread in `withDefaults`, or the persisted legacy word wins and the catalogue URL 404s.
- CI must build **both** branches (`branches: [master, dev]`) and publish **both** a channel alias and the version. `type=ref,event=branch` gives `:dev`; `type=raw,value=<VERSION file>` gives `:0.50.0-dev.1`, which is the tag the Development channel actually pulls — without it Development can detect an update it cannot install. `:latest` stays default-branch-only so Development can never overwrite what stable boxes pull.

### 13.3 Advanced
- **Allow custom apps** (off by default) → enables the "3rd Party App" button in the App Store (see §11), with a clear risk note.
- **Enable app shells** (off by default) → adds an "Open shell" option to each app (a browser terminal into that app's container, via the Docker API with a TTY).
- **Enable root terminal** (off by default) → a root shell into the OpenMasjidOS core itself, launched from Advanced. Clearly marked as powerful.
- **Network info:** show current hostname, `.local` address, and IP (read-only here; changes are made via the installer's "Reconfigure network").
- **"Check for updates" + one-click live update** for the core: the dashboard pulls the new image and recreates the core itself (via a detached helper container), streaming progress to a live log window and reconnecting when it's back — no terminal needed. Installed apps are never touched (golden rule).
- **Backup / Restore:** download a tarball of platform config + app volumes, and restore from one.

---

## 14. Design system & theming (this is a priority — make it feel premium)

### Identity
Calm, dignified, and modern. Inspired by Islamic geometric art (girih/arabesque tessellations) and the architecture of masjids (domes, arches/mihrab, minarets, the crescent). It should feel respectful and serene, never gaudy. The *level of polish* should match umbrelOS; the *visual language* is masjid, not generic.

### Color tokens (Tailwind v4 `@theme` + CSS custom properties in `tokens.css`)
- **Dark (DEFAULT):** deep night-sky base (`#0E1814`-ish charcoal-green), elevated surfaces a step lighter, **emerald/teal** primary (`#1FA37A` family), warm **gold** accent (`#D4AF37`, used sparingly for highlights/active states). Text near-white with a green undertone.
- **Light:** soft warm ivory/parchment base, same emerald primary tuned for contrast, gold accent.
- All colors as CSS variables so switching theme = toggling `data-theme="dark|light"` on the root. Never hardcode hex in components.
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

### Motion (use **Motion**; make it "very very nice" but tasteful)
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

## 15. Coding conventions

**General**
- Prefer clarity over cleverness. Comment the *why*, not the *what*.
- Small, focused commits with conventional-commit messages (`feat:`, `fix:`, `docs:`...).
- Everything must build and run with `npm run dev` and `npm run build`. Keep the root scripts current.
- **Never copy code from umbrelOS (PolyForm-Noncommercial) or any source whose license is incompatible with AGPL-3.0** (see §3). Re-implement from behaviour. Incorporating AGPL/GPL-compatible or permissively licensed code is fine *with proper attribution and notices*.

**TypeScript (both packages)**
- `strict` mode on. No `any` without a one-line comment justifying it.
- **Share types, never duplicate them.** The UI consumes the core's tRPC `AppRouter` type; do not hand-write request/response interfaces that mirror the server.
- Validate all external input (manifests, pasted compose, settings) with a schema (e.g. `zod`) at the tRPC boundary.

**Backend (core)**
- All Docker interaction goes through the `docker/` module (dockerode + the one wrapped `docker compose` invocation). No ad-hoc shelling elsewhere.
- tRPC routers stay thin; business logic lives in the `apps/`, `store/`, `stats/`, `auth/` modules.
- Errors surfaced to the UI are typed tRPC errors with friendly messages; full detail is logged server-side only.
- Hash passwords with argon2id. Sessions in secure, HTTP-only, SameSite cookies. Never log secrets.
- The platform never injects masjid data into apps — apps own that.

**Frontend (ui)**
- Components small and composable; build on shadcn/ui primitives; shared Motion presets live in `lib/motion`, not redefined ad hoc.
- All user-facing strings go through i18next — no hardcoded English in components.
- All colors/spacing via theme tokens; no magic hex or px where a token exists.
- Layout must work LTR and RTL (use logical CSS properties: `margin-inline-start`, etc.).
- Guard authenticated routes; an unauthenticated visit always lands on login/first-run.
- No server-only imports in the browser bundle (types only from core).

**Security**
- The installer is piped to bash, so it must stay readable and minimal in privilege.
- Validate every manifest **and** every pasted custom compose before running it; never `up` an untrusted stack without parsing and risk-checking it first.
- Default to least privilege for app containers.
- Network changes (static IP) are always confirmed and reversible-with-guidance; never silently rewrite a user's network config.

**Security invariants — DO NOT REGRESS** (established by the v0.39.0 sweep; the core runs as **root with the Docker socket**, so an app-isolation gap = host root):
- **`apps/compose-validate.ts` is the SOLE install-time risk gate** for catalog, community, AND custom (paste-a-compose) apps. It must keep flagging: `volumes_from` (a `container:openmasjid-core` entry inherits the mounted docker.sock + `/data`), `env_file` with an absolute or `..` path (reads other apps'/platform secrets), top-level `secrets:`/`configs:` with a `file:` source (host-file read), and **truthy** boolean flags via `isTruthyFlag` (`privileged: yes|on|1|"true"`, not just `=== true`), plus the existing namespace/mount/cap checks. Any new check here **must be mirrored in `OpenMasjidAPPS/scripts/validate-compose.mjs`** so "passes the catalog build == safe to install".
- **The gate runs on EVERY path that starts a compose** (v0.45.0): install (catalog/community/custom), **update** (`updateCatalogApp` — previously the one path that skipped it), and post-restore `reupAllApps`. A refreshed catalog entry is fresh external data; never write + `up` one unchecked.
- **`checkCompose` returns `dangers` AND `refusals`** (v0.45.0). `refusals` are NEVER acknowledgeable — no "I understand the risk" path, on any router. Currently: a top-level volume that uses `external:` (short or long form) or `name:` to attach to an `omos-*` volume, i.e. another app's data or platform infra. Neither form names a host path, so `bindSource`/`checkHostPath` return early and saw nothing. Keep `refusals` refused everywhere; keep the non-`omos-` external/renamed case an ordinary `danger`.
- **Every listener that serves `/api/fabric` must carry `registerFabricTunnelGuard`** (v0.45.0) — the TLS dashboard server as well as the HTTP front door. `test/fabric-lan-only.test.ts` pins this structurally.
- **Every path comparison against a request URL matches the DECODED path, not the raw text** (v0.46.0). The router dispatches on the percent-decoded path, so a guard that compared `req.url` verbatim was walked past with `/api/%66abric/app/…` — raw text that doesn't start with `/api/fabric` but still reached the app-to-app broker. `matchesSecretRoute` and `isFabricSubpath` now test the raw **and** `decodedPath()` spellings and fail closed; `decodedPath` resolves escape-by-escape so one malformed `%zz` can't throw the comparison away. `isViaTunnel` likewise compares the first `x-forwarded-proto` hop trimmed + lowercased (`"HTTPS"`, `"https,http"`, and a duplicated header all count). Never reintroduce a raw-string `startsWith` on a URL in a security check.
- **A backup must never report success it can't back** (v0.45.0). `backupStream()` returns `{ stream, done }`; a volume that fails to archive fails the whole backup (its partial file is deleted), the outer tar's exit code flows through `done`, and a failure destroys the stream. `runBackup` requires `upload.ok && archive.ok` **before** recording success and **before** `pruneOld` — pruning on an unverified result is how repeated silent failures evict every good archive. One backup at a time (`BackupBusyError` → 409); manual download and scheduler share one staging path. Restore stops apps before refilling volumes and reports per-volume failures. In `tarVolume`, a staging **write** failure is tracked separately from the container's exit code (`writeFailed`, v0.46.0) — the two are independent, and folding it in with `code ??= -1` silently reported success whenever `docker run` had already exited 0 (i.e. ENOSPC on the final flush, the likeliest real failure). **Known-open, and NOT covered by `ok`:** volumes are tarred live, and a torn SQLite/WAL capture still exits tar 0 — so `ok: true` is not proof the databases inside will open. That fix is app-side (`VACUUM INTO` snapshots in each app); don't add a platform-side check that only looks like it covers it. The archive is also unencrypted (`rclone crypt` is the real fix).
- **The Cloudflare tunnel exposes ONLY app paths.** The dashboard, tRPC, and the **secret-gated Fabric routes** (`/api/fabric/*`, `/api/auth/session`) stay LAN-only. Registered routes skip the front-door `notFoundHandler`, so those routes are blocked over the tunnel by an explicit `onRequest` guard in `index.ts` (`viaTunnel` = `cf-ray` header or `x-forwarded-proto: https`). Never add a new secret route to `front` without that guard; the ONLY intentionally-public-over-tunnel routes are `/api/public/appearance` and `/api/public/logo` (low-sensitivity presentation assets — the latter is the masjid logo, raster-only so no SVG-script vector, served for webhook avatars + apps' public pages). Admin logo upload/clear (`/api/branding/logo`) is registered on the LAN `server` only, never `front`. The tunnel is not started in the no-TLS fallback.
- **The reverse proxies are a hostile boundary.** `system/ingress.ts` + `system/app-proxy.ts` strip client-supplied `X-Forwarded-*`/`Forwarded` + hop-by-hop headers and set trusted values. Don't relay request headers verbatim to app containers.
- **The Fabric app-to-app broker (`fabric/appLink.ts`, `POST /api/fabric/app/:target/:capability/:method`) is LAN-only and least-privilege** (v0.40.0). It inherits the `/api/fabric` viaTunnel guard (`registerFabricTunnelGuard`, `system/via-tunnel.ts` — the single shared implementation), authorizes by **static manifest grants** (caller `consumes` ∧ target `provides`), builds the target URL ONLY from the registry (`127.0.0.1:<published port>` — no request-controlled host/path, no SSRF), injects the **target's own** secret + a trusted `X-OpenMasjid-Caller-App` while stripping caller-supplied identity/forwarding/hop-by-hop headers, caps JSON at 256 KB each way with a 10 s timeout + per-caller rate limit, returns `{ fabric_error }` on platform failures, and **never logs bodies**. Don't weaken any of these.
- **Tunnel exposure is per-app opt-in** (v0.40.0). `ingress.rebuild()` routes an app only when `meta.exposed !== false` (grandfathered `undefined` = exposed, so pre-0.40 installs don't go dark); the admin toggles it in Settings (default from the manifest `tunnel:true` request). An app's own **`/fabric/*` is refused over the tunnel** on BOTH the HTTP and WebSocket ingress paths (`isFabricSubpath`) — those routes are LAN-only. `OPENMASJID_PUBLIC_URL` is injected empty unless exposed; `/api/fabric/site` stays the live source of truth.
- **Email + alerts over the Fabric are LAN-only + least-privilege** (v0.41.0). The SMTP password / Resend API key live in `config/email.json` (chmod 600) and never leave `store/email.ts` except to the sender (`notify/email.ts`); the admin API returns only "is set" flags. `POST /api/fabric/email` (capability `email`) and `POST /api/fabric/alert` (gated on the app having declared the alert in its manifest) are under `/api/fabric`, so they inherit the viaTunnel LAN-only guard; both are rate-limited and never log bodies. Alerts are gated by the admin's granular per-type toggle (`notify/alerts.ts`, disabled-set in `config/alerts.json`) before any email/webhook is sent. The admin email (`auth/store.ts` `getAdminEmail`) is the only alert recipient.
- **The File Explorer's sandbox is NOT just "inside the data dir"** (v0.47.3) [OPENMASJIDOS-004]. The data dir is also where the platform keeps its control plane, so confinement to `/data` still exposed two things to any authenticated session: (a) **every platform secret** — `config/` holds the admin password hash, the SMTP password / Resend key, the Stripe keys, the tunnel token and the TLS private key, all of which every other surface deliberately refuses to return to the client; and (b) **host root** — start/update run `docker compose -f apps/<id>/compose.yml up`, reading that file *from disk*, so rewriting it and pressing Start launches a `privileged: true` / docker.sock-mounted container **without passing `apps/compose-validate.ts`**, the sole install-time gate. `apps/<id>/meta.json` is the same class (it carries `ssoSecret` and the Fabric capability grants). `files/manager.ts` now has ONE decider, `protectedReason()`, and **every entry point asks it** — `resolve()` is the choke point, and constructed targets (rename destination, upload destination, the `writeTextFile` leaf) each call `assertAllowed` because they don't pass through `resolve()`. Protected: `config/**`, `.backup-staging/**`, and exactly `compose.yml` / `.env` / `meta.json` directly inside `apps/<id>/` (matched case-insensitively; deeper paths are the app's own data and stay browsable). The guard checks the **realpath as well as the requested path** — a symlink at `apps/x/data/link` → `config/stripe.json` is legitimately *inside* the sandbox, so checking one spelling isn't enough (same lesson as the raw-vs-decoded guards). **Backup and restore must stay independent of this module**: they archive `config/` and `apps/` directly and import nothing from `files/manager.ts` — `test/files-guard.test.ts` pins that structurally, because a guard that reached the backup path would silently produce backups missing every setting.
- **A damaged file in the data dir must never stop the daemon booting** (v0.47.2). The dashboard's TLS cert is the case that proved it: `ensureCert` checked only that `cert.pem`/`key.pem` *existed*, `loadCert` was a bare `readFileSync`, and Node builds the TLS context **inside the Fastify constructor** — which sits outside the try/catch that wraps reading the cert. A corrupt-but-present cert therefore exited the process, and under `restart: unless-stopped` that is a crash-loop with no dashboard left to repair it from, on hardware that may be wall-mounted. Both installer self-service paths (Update, Repair) re-read the same file, so it needed a drive to the masjid. Now: `certPairProblem` runs the same three checks Node does (parse cert, parse key, `checkPrivateKey` — the last is the only thing that catches a *partial restore*, where both files are valid PEM but from different boxes); `ensureCert` validates **content**, quarantines the damage as `*.broken`, and regenerates; `loadCert` throws rather than returning unusable bytes; and `index.ts` rebuilds the server **without TLS** if the constructor throws anyway, which also keeps the tunnel refused. `generateSelfSigned` verifies what openssl actually wrote instead of trusting exit code 0. Two rules when touching this: **a healthy cert must be left byte-for-byte alone** (churning it re-triggers the browser warning on every device on the LAN), and **never remove the plain-HTTP fallback** — it is the last way in. `test/tls-boot.test.ts` pins all of it, including the real `ensureCert → loadCert → createServer` sequence. The same shape applies to any other boot-critical file: validate before trusting, degrade rather than exit.
- **Secrets at rest:** persist config secrets 0o600 (`writeJson` does this; `CONFIG_DIR` is 0o700; `config/email.json` too). First-run `auth.setup` uses `createAdminIfUnset` (compare-and-set, capturing email/name) — don't reintroduce an unconditional write.
- **CI:** the CLA workflow runs on `pull_request_target` — keep third-party actions pinned to a commit SHA (never a tag) and never `actions/checkout` the PR head there. It **does** need `permissions: actions: write` (the official contributor-assistant setup): after a contributor posts the sign comment, the action re-runs the PR workflow to flip the required `cla` check green — without it the signature records but the check stays red (`Resource not accessible by integration`). That's safe here specifically because the job runs ONLY the pinned action and never checks out/executes the PR's code.

---

## 16. Build & run commands (keep these working)

```bash
npm install         # install all workspaces
npm run dev         # run core + ui together with hot reload
npm run build       # typecheck + build ui and core
npm run lint        # eslint + tsc --noEmit across workspaces
npm run test        # tests across workspaces
npm run image       # build & tag the runtime Docker image openmasjid/core:dev
```

The production image is built from the multi-stage `Dockerfile`: stage 1 builds the UI (Vite), stage 2 builds the core (tsc), final stage runs Node and serves the built UI + API as `openmasjid/core`.

---

## 17. Definition of done (for any feature)

A change is "done" only when: it builds via `npm run build`; `tsc` and `eslint` are clean; it's covered by at least a basic test where logic is non-trivial; it works in **both** light and dark themes; it works in **both** LTR and RTL; it honors `prefers-reduced-motion`; authenticated areas stay behind login; client/server types are shared (no hand-duplicated types); all new strings are in i18next; user-facing wording is plain and friendly; and no raw technical error can reach the user un-prettified.

---

## 18. Version control policy

The canonical version lives in the **`VERSION`** file at the repository root. It is the single source of truth. The build reads `VERSION` and injects it into the app (e.g. as a build-time env var / a generated `version.ts`), and the Docker image is tagged from it. Never hardcode a version string anywhere else.

### Scheme: `MAJOR.MINOR.PATCH`

| Segment | When to bump | Example |
|---------|--------------|---------|
| **PATCH** (3rd) | Any small, backwards-compatible change — bug fixes, copy tweaks, minor UI improvements, dependency bumps. | `0.1.0` → `0.1.1` |
| **MINOR** (2nd) | A meaningful new feature or a significant change to existing behaviour — new page, new tRPC procedure, new installer capability. | `0.1.x` → `0.2.0` |
| **MAJOR** (1st) | **Reserved for the official public launch.** `1.0.0` signals production-ready, fully stable software. Do not bump to `1.x` before that milestone. | — |

### Current version: `0.1.0`

We are in **pre-release / active development**. All changes during this phase are `0.1.x` (patch) or `0.2.x`+ (minor feature milestones).

### How to bump the version
1. Edit the `VERSION` file — change the number, nothing else.
2. Commit with message `chore: bump version to x.y.z`.
3. Push. CI picks up the new version automatically and stamps it into the build/image. The dashboard shows it in Settings → Advanced.

---

## 19. Working agreement for Claude (the coding agent)

- Read this file first, every session. Treat the **Branching policy** (work on `dev`; never touch `master` without an explicit "merge to main"), §3 (licensing), §4 (scope), §9 (auth), §13 (settings = platform-only), and §14 (design/voice) as hard constraints.
- **First command of every session: `git branch --show-current`.** If it is not `dev`, switch.
- Build **vertically**: ship one full working slice end-to-end — core router + tRPC type + UI + theme + i18n — before starting the next.
- Suggested build order:
  1. Monorepo skeleton + installer (fresh-install path) + core that boots, serves the UI shell, and exposes a hello tRPC procedure.
  2. **Auth: first-run admin creation + login + sessions + route guards.**
  3. Dashboard home with **live system stats** (tRPC subscription + systeminformation).
  4. Docker lifecycle for a hardcoded test app (install/start/stop/logs/remove via dockerode).
  5. App Store catalog fetch + one-click install.
  6. **Settings** (customize + account + advanced toggle).
  7. **3rd-party custom-compose install** behind the advanced toggle (with validation).
  8. Installer lifecycle menu (update / repair / reconfigure network / uninstall) + **static IP + `.local` hostname**.
  9. Updates + backup/restore.
  10. Polish pass on animations and empty states.
- When you make a non-trivial architectural or naming decision, write it down in `docs/ARCHITECTURE.md`.
- If a task seems to require building an actual end-user app, **stop** — that belongs in `OpenMasjidAPPS`. Scaffold the manifest contract instead and ask.
- Never put masjid/prayer configuration into platform settings. If a feature seems to need it, it's an app concern.
- Never copy umbrelOS source into this repo. Re-implement patterns from scratch (see §3).
- **Licensing is a hard rule (see §3 + `CLA.md`).** This repo is AGPL-3.0 + CLA; *every line you write here is AGPL-3.0 and CLA-covered*. **Every new file must start with the SPDX header** in its comment syntax — `// SPDX-License-Identifier: AGPL-3.0-only` (ts/tsx/js/css), `# …` (yml/sh/Dockerfile), `<!-- … -->` (md/html) — followed by `Copyright (C) 2026 OpenMasjid-Solutions`. Never strip an existing header; never add code/assets/deps under an AGPL-incompatible license.
- Ask before adding heavy dependencies; "lightweight" (Pi-friendly) is a core value.
- Keep the README's curl one-liner accurate at all times.