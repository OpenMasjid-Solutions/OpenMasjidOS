<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

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
- **A full-lifecycle one-line `curl | bash` installer.** On a fresh machine it runs a complete guided **install**. On a machine that already has OpenMasjidOS, the same command opens a **management menu**: Update / Repair / Reset sign-in / Remove. Works on common Linux (Debian/Ubuntu, Raspberry Pi OS, Fedora), architecture-aware (amd64 + arm64).
- Installer auto-installs Docker + the Docker Compose plugin if missing, sets up OpenMasjidOS as a managed service, and during install also:
  - **Optionally configures a static IP** for the machine (guided, confirmed, safe — see §8). **⚠️ NOT YET IMPLEMENTED** — still wanted, not shipped.
  - **Sets a hostname and mDNS** so the dashboard is reachable at **`openmasjidos.local`** (plus the raw IP as a fallback). **⚠️ NOT YET IMPLEMENTED** — still wanted, not shipped. Today the dashboard is reached at `https://<server-ip>`, and the `.local` name only appears as a certificate SAN so it will work if mDNS is ever added.
- **Web UI authentication.** The dashboard is always behind a login. The **first time** the dashboard is opened, the user creates the **admin account**. Sessions use HTTP-only cookies — always `Secure` on the remote dashboard, deliberately not by default on the LAN, so plain-HTTP apps keep single sign-on (§9). No part of the UI is reachable unauthenticated except the login/first-run screen.
- **Core backend (daemon):** a type-safe **tRPC** API (over HTTP, with WebSocket subscriptions for live data). Manages container lifecycle via the Docker Engine API.
- **Dashboard home with live system stats:** CPU %, RAM used/total, disk used/total, CPU temperature (where available), uptime, and count of running apps — updated live — alongside the grid of installed apps.
- **App management:** install / start / stop / restart / remove / update apps; view status and logs.
- **File explorer:** a dock app to browse, upload, download, rename, and delete files under the data dir (sandboxed server-side — no path-traversal or symlink escape).
- **App Store client:** fetches the catalog from `OpenMasjidAPPS`, renders listings, handles one-click install.
- **Settings (platform-only):** dashboard customization (theme, accent, wallpaper, dashboard name, masjid logo, display preferences) and an **Advanced** section (see §13). **Settings contains NO masjid/prayer details** — those belong to apps.
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
- Remote-access helper (Tailscale/Cloudflare-tunnel wizard). Remote access itself already ships: a Cloudflare tunnel the masjid creates by hand and pastes the token of into Settings → Remote access (§13.2e). What is later is a helper that sets one up for them.
- Community-submitted app catalog with review flow.

---

## 5. Architecture

```
                       ┌──────────────────────────────────────────┐
                       │             User's browser                │
                       │   OpenMasjidOS UI (React + Vite + TW)      │
                       │       reached at https://<server-ip>       │
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
        Host: /proc + /sys for stats. (avahi/mDNS and a static IP: planned, NOT built — §4.)
```

- **Core** is a single Node/TypeScript daemon, shipped as **one Docker image** (`openmasjid/core`) that both serves the built React UI and exposes the tRPC API. It talks to the host Docker daemon via the mounted socket `/var/run/docker.sock`.
- **Type safety end-to-end:** the UI imports the core's tRPC `AppRouter` **type** (types only, never runtime code) so the client and server can never drift. Live data (stats, status, logs) uses **tRPC subscriptions over WebSocket**.
- **System stats** come from `systeminformation`, reading host metrics (mount host `/proc` and `/sys` read-only into the core so CPU/RAM/disk/temp reflect the *machine*, not the container).
- **Apps** (catalog and custom) are launched as their own Docker Compose projects (one project per app, `omos-<id>`), found by Docker's own compose project label — the platform adds no labels of its own (§10, §11).
- **Networking:** on the masjid's network the dashboard is `https://<server-ip>` (443, with 80 as a plain-HTTP front door — §8). mDNS (`openmasjidos.local`) and an installer static-IP step are wanted but **NOT IMPLEMENTED** (§4, §8). From outside, an optional Cloudflare tunnel lands on port 80: app paths on the apps' hostname (a shared app for anyone, the rest only for the admin, opened from the remote dashboard), and — only when the admin switches it on — the dashboard, at the root of that same hostname, kept apart from the app pages beside it by its key (§13.2e, §15).
- **Catalog** is plain static files served from the `OpenMasjidAPPS` repo. No app-store server to run.

---

## 6. Tech stack (this mirrors umbrelOS deliberately — confirm or override before deviating)

| Layer | Choice | Notes |
|-------|--------|-------|
| Language | **TypeScript everywhere** | One language across the whole codebase. No `any` without a justifying comment. |
| Repo layout | **npm workspaces monorepo** (`packages/*`) | Like umbrelOS. Optional Turborepo later if builds get heavy. |
| Backend runtime | **Node.js 22 LTS** daemon | The "umbreld" equivalent. Long-running service. The image and CI run Node 22 (Node 20 is end-of-life); the core's esbuild target stays `node20`, which runs on 22. |
| API layer | **tRPC** | End-to-end type safety; queries/mutations + **subscriptions over WebSocket** for live data. |
| HTTP server | **Fastify** (tRPC Fastify adapter) | Lightweight, fast; also serves the built UI assets. |
| Docker control | **dockerode** + shelling to `docker compose` | All Docker interaction wrapped in one module. |
| System stats | **systeminformation** | CPU/RAM/disk/uptime/temperature; reads host `/proc`. |
| Auth | **`@node-rs/argon2`** (argon2id) + signed, HTTP-only session cookie | Prebuilt musl/glibc binaries, so the multi-arch Alpine image needs no compiler. Single admin in v1.0. |
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
| Host networking | `avahi-daemon` (mDNS), distro-native static-IP tool (netplan / nmcli / dhcpcd) | `.local` access + optional fixed IP. **Planned, NOT implemented** (§4, §8). |

> **"Lightweight" now means "runs comfortably on a Raspberry Pi / small mini-PC"** (umbrelOS's proven footprint), not "single static binary." Keep dependencies lean, lazy-load heavy UI, and don't pull in frameworks we don't need.

---

## 7. Repository structure (`OpenMasjidOS`)

```
OpenMasjidOS/
├── CLAUDE.md                  # this file
├── README.md                  # human-facing, with the curl one-liner up top
├── LICENSE                    # AGPL-3.0 (NOT PolyForm — see §3)
├── CLA.md                     # the Contributor License Agreement (§3)
├── CONTRIBUTING.md            # how to work on this repo
├── CHANGELOG.md               # fetched live by the dashboard as "What's new" (§18)
├── VERSION                    # single source of truth for the version (see §18)
├── package.json               # npm workspaces root + top-level scripts
├── install.sh                 # the one-line installer / lifecycle manager
├── Dockerfile                 # multi-stage: build ui + core → one runtime image
├── docker-compose.yml         # how the core runs itself
├── tsconfig.base.json         # shared compiler options both workspaces extend
├── .github/workflows/         # docker-build (image + tags), cla. The lockfile is committed by
│                              #   hand (`npm install`); there is no bot that commits it.
│
├── assets/                    # brand/readme images
├── signatures/                # CLA signatures land on the cla-signatures branch, not here
│
├── packages/
│   ├── core/                  # Node + TypeScript daemon (the "umbreld" equivalent)
│   │   ├── src/
│   │   │   ├── index.ts                # boot: TLS dashboard + HTTP front door, tRPC, WS, static UI
│   │   │   ├── config.ts  logger.ts  version.ts
│   │   │   ├── reset-password.ts  reset-auth.ts   # sign-in recovery; Reset sign-in runs reset-auth (§8.1)
│   │   │   ├── trpc/
│   │   │   │   ├── router.ts            # root AppRouter (exported type → UI)
│   │   │   │   ├── context.ts  trpc.ts  # session/CSRF context, procedure builders
│   │   │   │   │                        #   (no signed-in change while a restore runs, §15)
│   │   │   │   └── routers/             # one file per area: auth, twofactor, apps, store,
│   │   │   │                            #   community, custom, settings, stats, system, files,
│   │   │   │                            #   backups, alerts, notifications, email, whatsapp,
│   │   │   │                            #   commands, stripe, cloudflare
│   │   │   ├── api/                     # plain HTTP/WS routes: fabric, files, terminals,
│   │   │   │                            #   update, app-update, restore, branding,
│   │   │   │                            #   backup-download (sending a backup, LAN + remote),
│   │   │   │                            #   static-ui, ws-auth (`requestUser`)
│   │   │   ├── auth/                    # argon2 (@node-rs/argon2), sessions (+ per-app access
│   │   │   │                            #   tokens), admin store, twofactor + totp + qr
│   │   │   │                            #   (the enrolment QR), login-challenge, ip-lockout
│   │   │   ├── docker/                  # dockerode + the one `docker compose` wrapper
│   │   │   ├── apps/                    # manifest parsing, lifecycle, compose-validate (the gate),
│   │   │   │                            #   paths (the shape of an app path, and the first
│   │   │   │                            #   segments no app may take)
│   │   │   ├── commands/                # WhatsApp admin commands: normalise → gate → parse →
│   │   │   │                            #   registry → execute, + reply/conversation/os
│   │   │   ├── fabric/                  # app↔app broker (appLink), proxy, appCommands
│   │   │   ├── files/                   # File Explorer sandbox (protectedReason)
│   │   │   ├── notify/                  # email, webhook, alerts, whatsapp (the queue),
│   │   │   │                            #   whatsapp-gateway (the OpenWA client), whatsapp-inbound
│   │   │   ├── settings/                # platform settings store (NO masjid data)
│   │   │   ├── stats/                   # systeminformation host metrics
│   │   │   ├── store/                   # catalog/casaos/changelog + config stores
│   │   │   │                            #   (email, whatsapp, stripe, commands, branding)
│   │   │   ├── stripe/                  # dispute (chargeback) polling
│   │   │   ├── system/                  # channel, tls, ingress, app-proxy, app-host, backup,
│   │   │   │                            #   restore, cloudflared, update-lock, monitors,
│   │   │   │                            #   via-tunnel, tunnel-refusals, remote-admin (the
│   │   │   │                            #   door + front-door gate), app-access (Open from
│   │   │   │                            #   outside), remote-sockets, socket-relay (both
│   │   │   │                            #   ends of a relayed socket close together), …
│   │   │   └── util/                    # phone, version, origin, id, json-store, image-size,
│   │   │                                #   net (why a peer check can't work), slug
│   │   ├── test/              # node:test. EVERY file must be listed in package.json's
│   │   │                      #   `test` script — an unlisted test never runs (§17).
│   │   ├── package.json  tsconfig.json  tsconfig.test.json
│   │
│   └── ui/                    # React + Vite + Tailwind v4
│       ├── src/
│       │   ├── main.tsx  App.tsx  Root.tsx
│       │   ├── routes/                 # Dashboard, Store, StoreCustom, AppDetail, Files,
│       │   │                           #   Settings (the shell: sections, nav, Advanced,
│       │   │                           #   dialogs), NotFound (login/first-run is
│       │   │                           #   components/AuthScreen.tsx)
│       │   │   └── settings/           # one file per Settings panel (§13.5)
│       │   ├── components/             # AppCard, Dock, Modal, PhoneField, Terminal,
│       │   │                           #   SceneBackground, Windows, Glyphs, …
│       │   ├── lib/
│       │   │   ├── trpc.ts             # typed client (imports AppRouter TYPE from core)
│       │   │   ├── trpcClient.ts       # links: batched HTTP + a LAZY WebSocket (§15 says why lazy)
│       │   │   ├── prefs.ts            # theme/accent/wallpaper applied pre-paint
│       │   │   ├── motion.ts           # shared Motion presets
│       │   │   ├── version.ts          # deliberate copy of core's util/version.ts (§13.4)
│       │   │   ├── phone.ts            # country table + display formatting + `nationalPart`
│       │   │   │                       #   (a trunk 0 after the country code is dropped);
│       │   │   │                       #   React-free so a core test can cover it (ui has no runner)
│       │   │   ├── errors.ts           # `errorText`: what an error may say on screen — the
│       │   │   │                       #   server's own message or a plain fallback, never a
│       │   │   │                       #   dropped connection's or Cloudflare's text
│       │   │   ├── app-url.ts          # where an app opens from here (LAN port vs. outside);
│       │   │   │                       #   React-free for the same reason
│       │   │   ├── apps.ts             # Open: the LAN port, or `apps.openRemote` from outside
│       │   │   ├── update-endings.ts   # what an app update's close code means; React-free
│       │   │   │                       #   so a core test holds it to the server's (§13.4)
│       │   │   ├── session.ts          # the dashboard key: this origin's storage on the LAN, memory only from outside (§15)
│       │   │   ├── files.ts            # File Explorer transfers + the 100 MB limit from outside
│       │   │   └── i18n/               # en.json + helpers (RTL aware)
│       │   ├── styles/                 # tokens.css (theme tokens), app.css, glass.css
│       │   └── index.css               # Tailwind v4 @import
│       └── package.json
│
└── docs/
    ├── ARCHITECTURE.md
    ├── APP_MANIFEST_SPEC.md   # catalog contract + the Fabric (appearance, SSO, email, whatsapp, commands)
    ├── APP_UI_DESIGN_SPEC.md  # how an app's own UI should look beside the dashboard
    ├── FABRIC_APP_LINK_AND_TUNNEL.md  # app↔app broker + per-app tunnel exposure
    ├── REMOTE_ADMIN.md        # the dashboard over the tunnel, beside the apps, and the key rule
    ├── WHATSAPP.md            # gateway, pacing, groups, admin commands
    ├── SECURITY.md            # the security model, as told to an operator
    ├── NETWORKING.md          # how the dashboard is reached: LAN address, ports, the tunnel
    ├── THEMING.md
    ├── design-system/         # the shared OpenMasjid design system (shadcn/ui + Radix + Tailwind v4)
    ├── screenshots/           # the README's images
    └── audit/                 # point-in-time audit records (dated; not a live to-do list)
```

> There is no `scripts/` directory. This tree listed one for a long time; dev helpers live in
> the root `package.json` scripts instead. Keep this tree honest — it is the map a new session
> reads before touching anything, and every wrong entry here costs someone a search.

**Type-only import rule:** `packages/ui` may import **types** from `packages/core` (e.g. `import type { AppRouter } from "@openmasjid/core"`), never runtime code. The browser bundle must not contain server code.

---

## 8. The installer (`install.sh`) — a full lifecycle tool

**Goal:** a non-technical masjid volunteer copies one line, pastes it into their server's terminal, answers a couple of friendly prompts, and a minute later gets a URL to open. Running the *same* line again later gives them safe maintenance options — they never need to remember any other command.

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidOS/master/install.sh || wget -qO- https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidOS/master/install.sh)"
```
(The curl-or-wget form means it still works on minimal systems that ship without curl — the
installer then installs curl itself for the steps that need it.)

> **`get.openmasjid.org` does not exist yet, so the raw GitHub URL above is the real command.**
> This section used to lead with the short domain and mention the raw URL as a fallback, which is
> backwards while the domain does not resolve — and the README, which masjids actually copy from,
> has always used the raw URL. **The two must not drift** (§19 requires the README one-liner be
> accurate at all times); when the domain goes live, change both together.

### 8.1 Behaviour: detect state, then branch
On start the script detects whether OpenMasjidOS is already installed (presence of `/opt/openmasjid` and/or the core container).

**A) Fresh machine → guided INSTALL** (see 8.2).
**B) Already installed → MANAGEMENT MENU** (`menu_existing`, as shipped):
```
OpenMasjidOS is already installed
What would you like to do?
  1) Update        — get the latest version (keeps your apps & data)
  2) Repair        — fix a broken install and restart
  3) Reset sign-in — new password + re-link apps (keeps all data)
  4) Remove        — uninstall (your apps & data stay safe)
  5) Quit          — do nothing
```
- **Update:** resolve the channel's newest build (`resolve_image`), download it, and only THEN write it into the core `docker-compose.yml` and recreate the core container — data and all installed apps untouched. The order is load-bearing (`do_update`): it used to write the file first, so a download that failed (the script stops, `set -e`) left the file naming a build the core had never run, and whatever next recreated the core from it — Repair, which keeps the exact reference; a restore, before it pinned the running build (§15) — brought it back on that build.
- **Repair:** rewrite the core `docker-compose.yml` with **the exact reference already there**, download that image only if this machine does not have it, restart, fix `/opt/openmasjid` permissions. Non-destructive, and deliberately never moves the machine to another version or channel. It used to re-pull the reference every time — but install and the installer's Update write the channel alias (`:latest`, `:dev`), and re-pulling an alias moved the box to the newest build, the one thing Repair promises never to do. A re-pull never repaired a damaged local image anyway (pull skips layers it has), so nothing was lost, and Repair now works offline. Update and Repair both end with *"Open it at: https://<ip>"* (`TLS_PORT`) — they printed `http://`, which reached the dashboard only through port 80's redirect, and only on the masjid's network.
- **Reset sign-in:** run the core's `reset-auth` (`do_reset_signin` → `docker exec … reset-auth.js`) — a new admin password, every session signed out, every app's Fabric key re-issued and the apps restarted with them, all data kept. This is the way back in when nobody knows the password. **It can also turn two-step sign-in off** — asked only when two-step sign-in is on, `[y/N]`, so the default leaves it alone — because nothing else can: the dashboard asks for a current code to change two-step sign-in, on the masjid's network too (`requireSudo`, §9), so an admin who lost the phone with their authenticator AND the backup codes had no way to remove or replace it. Whoever runs the tool already has the server, so it gives nothing away; with no factor, managing from outside stays shut until one is set up again (§13.2e). `reset-password` is the lighter tool (the password only, run by hand with `docker exec`); it leaves the second factor alone and, when one is on, says to run this full reset instead. `test/credential-binding.test.ts` (*THE FULL SIGN-IN RESET CAN TURN TWO-STEP SIGN-IN OFF*) drives the real tool as a separate process, the `[y/N]` answered both ways.
- **Remove:** stop & remove the core, and the Cloudflare tunnel's container (`openmasjid-cloudflared` restarts by itself, so it went on forwarding both public hostnames to this machine after removal and after every reboot; its token stays in `config/`, and the core starts it again after a reinstall). Then ask, separately and explicitly: *"Also remove all installed apps and their data? This cannot be undone."* Removing data requires the user to type `DELETE` to confirm. Default is to keep app data. `DELETE` also removes every volume labelled with an `omos-*` compose project, because an app removed earlier with "keep its data" has volumes but no containers, and the per-project `down -v` never saw it.
- **Every menu and prompt reads the TERMINAL** (`has_tty`, which actually opens `/dev/tty`; `[ -r /dev/tty ]` is true with no terminal at all). Under `curl … | sudo bash`, stdin is the pipe the script arrived on, already at its end — so Reset sign-in read EOF and quietly changed nothing until it was made to read `/dev/tty`.
- **The installer's data paths:** `/opt/openmasjid` holds settings (`config/`) and app files (`apps/<id>/`); each app's own data — its database — is in Docker named volumes, so copying that folder to another machine loses it, and a backup is how to move. The installer says so; it used to create an unused `volumes/` directory and say "your data lives in ./apps and ./volumes".

> **There is no "Reconfigure network" entry, and no mDNS or static-IP code in `install.sh` at all.**
> §4 still lists both as v1.0 scope and they remain wanted — but they are **not implemented**, so
> nothing in this file, the README or `docs/NETWORKING.md` may describe them as things the installer
> does. Today the dashboard is reached by IP over HTTPS; a masjid wanting a fixed address adds a DHCP
> reservation on their router. If you implement it, this menu and §8.2 steps 4–5 are the spec.

### 8.2 Guided INSTALL steps
The script must:
1. Be **POSIX-ish bash**, fail fast (`set -euo pipefail`), and be idempotent (re-running is always safe).
2. Detect OS + architecture; refuse clearly on unsupported platforms with a friendly message.
3. Ensure `curl` is present (many minimal systems/LXC templates ship without it) — install it via the system package manager if missing. Then ensure Docker is present; if missing, install via the official convenience method, then ensure the `docker compose` plugin exists.
4. **NOT IMPLEMENTED — static IP.** Spec, for whoever builds it: detect the active network stack (netplan / NetworkManager-`nmcli` / systemd-networkd / dhcpcd) and the current interface, IP and gateway; **default to SKIP on a detected cloud/VPS** (the provider manages addressing and changing it can lock the user out); otherwise *offer* to pin the current IP, showing the exact proposed config and requiring a yes/no confirmation, warning that changing the IP on a remote box can drop the SSH session; apply via the detected tool only after confirmation, and skip with a pointer to `docs/NETWORKING.md` if anything looks unknown.
5. **NOT IMPLEMENTED — hostname + mDNS.** Spec: set the system hostname (default `openmasjidos`, prompt to accept/change) and install/enable `avahi-daemon` so the box answers at `openmasjidos.local` on the LAN.
6. Create the data directory at `/opt/openmasjid` (`config/` and `apps/`; apps' own data is in Docker named volumes). A fresh `--channel=dev` install also seeds `config/settings.json` with `{"updateChannel": "dev"}` (0600, only when no settings file exists) — otherwise the platform, whose settings default to Stable, served the Stable catalogue on a Development build and offered a "downgrade".
7. Write/refresh the core `docker-compose.yml` (mounts `/var/run/docker.sock`, host `/proc` & `/sys` read-only, and `/opt/openmasjid`), and pull the reference `resolve_image` decided.
8. Start the core as a `restart: unless-stopped` service so it survives reboots; wait for health.
9. **Print a clear success box.** As shipped it names one HTTPS address, the machine's IP — because that is the only address that actually works today — and warns about the self-signed certificate, since every device on the LAN meets that warning once:
   ```
   ╔══════════════════════════════════════════════════════════╗
   ║  [=]  OpenMasjidOS is ready!                             ║
   ║  Open your browser and go to:                            ║
   ║  https://192.168.1.50                                    ║
   ╠══════════════════════════════════════════════════════════╣
   ║  First time?                                             ║
   ║  The setup wizard will guide you through creating         ║
   ║  your admin account to sign in.                          ║
   ╠══════════════════════════════════════════════════════════╣
   ║  Need help or want to report an issue?                   ║
   ║  https://github.com/OpenMasjid-Solutions/OpenMasjidOS    ║
   ╚══════════════════════════════════════════════════════════╝
   ```
   Point at the GitHub repo, **not** `openmasjid.org/help` — that domain does not resolve, and a
   dead link in the one message every masjid reads is worse than no link.

### 8.3 Flags (for advanced/automated use; interactive is the default)
As shipped, `main()` parses exactly: `--install`, `--update`, `--repair`, `--reset-signin`, `--uninstall` / `--remove`, `--channel=main|dev`, and `--dev` (shorthand for `--channel=dev`). An unrecognised channel is a hard error rather than a guess.

> **`--yes`, `--hostname`, `--static-ip`, `--gateway`, `--iface`, `--no-network` and `--port` are NOT implemented.** This section listed them for a long time while the arg loop silently ignored them — the worst kind of documented flag. **Any unknown option now stops the installer** (*"Unknown option: …"*), and so does `--channel main` with a space (*"Use --channel=main or --channel=dev."*); `--` ends the options. `PORT=80` / `TLS_PORT=443` are constants at the top of the script. Add the flag *and* the doc line together, or neither.

**The installer must never move a machine between update channels by accident.** `write_compose_file` wrote `image: …:latest` unconditionally and both Update and Repair call it, so a Development box that ran the one-liner to repair a broken update was silently put back on Stable — which also meant a broken dev box could not be repaired from the installer at all. `resolve_image` now decides: an explicit `--channel` wins; otherwise the tag already in `${DATA_DIR}/docker-compose.yml` is authoritative (the dashboard's `alignComposeImage` writes that same line, so it reflects a switch made in Settings) — and when that file is missing or damaged, the image the `openmasjid-core` container was started from (`current_core_ref`), because "no reference" put a Development box on `:latest`. **Only the tag ever changes**: the registry the machine already pulls from (a private mirror) is kept, by the same rule as `retarget` in `docker/update.ts` (`image_repo`). Callers resolve the image themselves and `write_compose_file` only writes, so Update's resolve → pull → write order (§8.1) is visible where it is called. **Repair keeps the exact reference** — repair means "make this work again", never "move it to another version" — while **Update resolves to the channel alias**, because keeping the exact pinned version would make Update a no-op. A digest pin survives both. `is_installed` is deliberately generous (compose file *or* `config/` *or* `apps/` *or* the container): offering a fresh install to a masjid that has one reads as "your server is empty", and a damaged compose file is the likeliest casualty of a half-finished update.

**Ports:** the dashboard is served over **HTTPS on 443** (`TLS_PORT`), with **80** (`PORT`) as an HTTP front door that 308-redirects LAN browsers to HTTPS and carries the LAN-only Fabric routes for app backends (which cannot trust a self-signed cert server-to-server). Port 80 is also where an optional Cloudflare tunnel lands: it serves app paths there and hands remote dashboard requests to the 443 listener (§13.2e, §15). So the dashboard URL needs no port suffix, but it is `https://`. **Data dir:** `/opt/openmasjid`.

> The installer is piped to bash, so it must stay **readable and commented** — we are asking people to trust it. No obfuscation, ever. Keep it auditable and minimal in privilege.

---

## 9. First-run web setup & authentication

The dashboard is **always** behind a login. There is no pre-baked password and no anonymous access to any feature.

- **First visit (no admin exists yet):** the user lands on a first-run screen and **creates the admin account** — **name + email + password** (enforce a sane minimum strength). **The login username is the name**, not the email. The **email is where OS alerts go** (an app going offline, etc.) and, once emailed sign-in codes are switched on, where those codes go (below); `verifyCredentials` also accepts it in place of the username. This keeps pre-email installs working (they log in with their original username; they can add an alert email in Settings → Account). Optionally let them pick a theme (dark is pre-selected). Then they go straight to the dashboard. **Do not ask for any masjid/prayer details here** — that belongs to apps.
- **Subsequent visits:** standard login screen → dashboard. Wrong credentials get a friendly, rate-limited error.
- **Sessions:** server-side session, HTTP-only + SameSite=Lax cookie (non-`Secure` on the LAN so plain-HTTP apps keep SSO). Logout clears it. Passwords hashed with **argon2id** via **`@node-rs/argon2`**, never stored or logged in plaintext.
  - **Sessions are PERSISTED (`config/sessions.json`, 0600, atomic), and that is a lockout fix** (v0.51.2-dev.15). They lived in a process-memory Map while the browser kept the cookie for seven days, so every update, reboot and crash silently invalidated the admin's cookie — and the dashboard (fetching `auth.me` once on mount) went on drawing the signed-in shell. Pressing **Open** handed the app a dead cookie; the app's SSO check said "not signed in"; and because the platform WAS reachable, every OpenMasjid app also refused its own password recovery ("sign in through your dashboard"). A masjid reported it as "it randomly asks for the control panel password". It was every restart.
  - **Revocation is BOUND TO THE PASSWORD, never read off the file — and the first cut got this wrong.** Each session stores a fingerprint of the password hash it was created under (a SHA-256 of it, never the hash) and is honoured only while that matches the current one. The first version instead treated "this token is missing from a readable file" as revoked, and an adversarial review found five ways that broke: the installer's Reset sign-in is a **separate process** that only restarts the core minutes later, after reinstalling every app, while the daemon still holds the OLD hash — so a sign-in with the old password in that window was persisted and **survived the reset**, handing a seven-day session to exactly the person being locked out; a failed write was indistinguishable from a revocation, so the next good write from another device evicted the unsaved session (the reported lockout, back); and a restore, a race with the reset tools, or time on an older Stable build (which never touches the file) could each revive sessions. Bound to the password, none depend on the file: whoever changes the password — this daemon, the reset tools, a restore with a different password, an older build — revokes everything older the moment the daemon holding the new hash reads it, and argon2's per-hash salt means re-setting the SAME password still revokes. `test/credential-binding.test.ts` drives the **real** `reset-password` tool, prompts and argon2 included, as a separate process to pin it.
  - **The binding comes from the password that was PROVED, not the password current when the session is written — and a second review is why.** Binding at write time (`currentCred()` inside `createSession`) left three gaps of one shape: something is awaited between "the password was right" and "mint the session", and the binding was read at the END. argon2 itself — a change landing mid-verify minted a session bound to the NEW password for someone who had only shown the old one; the up-to-ten-minute wait for a remote sign-in's second factor; and the admin store being read once at boot, so for the whole Reset sign-in window the daemon went on *accepting* the old password. Now `verifyCredentials` captures the hash before argon2 and returns its fingerprint, `login` refuses unless it still matches, a tunnel challenge carries it and `completeLogin` refuses a stale one with `restart: true`, and `changePassword` re-reads after hashing (CONFLICT on a concurrent change) and clears every pending challenge. **A third review found the same shape twice more, so both halves are now structural:** the check after the verify reads FRESH (`freshCredential`), because the throttled copy can be a second stale after a reset written by another process; and `createSession(username, cred)` takes the fingerprint that was proved instead of reading the current hash, because a refresh landing between check and mint bound the session to a password nobody had shown. `cred` is a REQUIRED parameter, so `npm run lint` refuses a caller that leaves it out (a structural test stood in for the compiler first, and a multi-line call with a trailing comma walked past it); `test/credential-binding.test.ts` pins that it stays required. The two-step settings' password re-check (`requireSudo`) follows the same rule. `test/credential-binding.test.ts` drives each through the real router, the reset tool as a separate process included.
  - **The admin store notices a change made by another process** (`auth/store.ts` `refresh`): a stat stamp (inode, mtime, size) checked at most once a second on reads, and always before a write or a password check. Three rules, each load-bearing. **Only a good read is adopted** — a damaged or MISSING file keeps the last good copy, because adopting a missing file as "no admin yet" re-opens first-run setup to the next visitor, the exact takeover the `corrupt` flag exists to prevent. **A write merges onto the latest file**, or a profile edit writes the old hash back over a reset. And **a restore holds it** (`holdForRestore`, released in a `finally`): reads keep the identity the restore began with, and writes are refused, because between restore's `rmSync` and `renameSync` `config/` does not exist and a write would recreate it and make the rename fail. The hold is **owned** — `holdForRestore()` returns that restore's own release — because a shared flag let a second restore that stopped early lift the first's hold mid-way; and restores are **single-flight** on the server (`withUpdateLock('restore')`, the upload refusing with 409 while one runs). Two more rules from the same review: **write first, then believe it** (`save(next)` assigns the cache only after `writeJson` succeeds — the other order left a failed password change half-applied in memory, signing the admin out and refusing the old password, with nothing able to repair it because the file never changed); and **a read that failed at boot is retried** (`lastStamp` starts at a value no stat produces), or one transient EIO refused the right password until a restart.
  - **Other rules, each from a specific failure.** A damaged file never stops boot (it starts empty — the old behaviour). A failed write never fails a sign-in and never evicts anything; memory is authoritative in-process. A sign-out the disk refuses **removes the file** rather than leaving the revoked token to return at the next boot (unlink works on a full disk; a missing file boots empty, failing closed). Signing out a token that is not a live session **writes nothing** — logout is a public procedure and tRPC batches, so one request could otherwise force hundreds of synchronous fsyncs on an SD card. A failed write removes its temp file, which holds the same tokens. **A password file that cannot be read is not a password change**: while `isAuthStoreDamaged()`, no session is honoured (fail closed) but none is discarded (`isDead` vs `isLive`), and the boot load retries the read first — treating "unreadable" as "changed" dropped every saved session after one transient EIO at boot, which is the reported symptom again. And a restore ends every session **at the next boot** (`endAllSessionsAtNextBoot` → `config/sessions.reset`), as it always did when sessions lived in memory — **not mid-restore**: the first fix called `destroyAllSessions()` straight after the rename, which signed the admin out part-way through and unmounted the window reporting whether the restore worked. The marker is spent once, and also ends any session made during the restore (the old core keeps serving until it is replaced).
  - **A session records whether it is REMOTE, and which second factor it proved; from the tunnel only such a session
    counts** (v0.51.2-dev.16). `remote: true` originates in exactly one place — `completeLogin`, i.e. the second
    factor passing on tunnel traffic — together with `tf`, the second-factor epoch the code was checked against
    (`VerifyResult.epoch`), and `handedOver`, whether the front door handed that sign-in over (below). The
    `createSession` type requires both with `remote: true`, for the reason `cred` is required. The only other place
    that writes them only carries them over: `changePassword`, called through the tunnel, gives the replacement
    session exactly the OLD session's grant (`remoteGrantOf` → `{ tf, handedOver }`) — the factor it proved and
    whether the remote dashboard made it, never whatever is current. Every dashboard route asks through
    `getSessionUserFor(token, { viaTunnel, handedOver })` (tRPC context, and `api/ws-auth.ts` `requestUser` for the
    raw routes), which on a tunnel request honours only a remote session whose `tf` still equals
    `secondFactorEpoch()`, and refuses a LAN session — password only — **without discarding it**. This is what
    makes "everything works remotely" defensible: a LAN cookie is not proof of anything from outside, because every
    app on the masjid's network receives the admin's cookie (that is how single sign-on works), so any app that kept
    one could otherwise have walked past the second factor. Only a literal `true` in the file counts.
    - **From outside, only a session the REMOTE DASHBOARD itself made counts** (`Session.handedOver`). A sign-in
      through a reverse proxy the masjid runs on its own network passes the second factor too — the proxy sends
      `X-Forwarded-Proto: https`, so it looks like the tunnel — and its session is `remote`. But it lives in the LAN
      cookie on the proxy's host, which every app opened from that page receives (cookies ignore ports), and any of
      those apps could compute, by the public formula, an access token for EVERY app (§15) and use it from the
      internet, private apps included. A review proved it. So `isRemoteSession` — the remote dashboard's routes and
      sockets, `claimsDashboardSocket`, `mintAppTicket`, and the sweep through `isRemoteSessionAt` — and
      `appAccessToken`/`appAccessUser` honour only a session marked `handedOver`, and `getSessionUserFor` requires one
      for every handed-over request. Such a proxy session still works THROUGH THE PROXY, second factor and all
      (`getSessionUserFor` without `handedOver`). A remote session written before the flag existed has none, so its
      owner signs in once more from outside.
      `test/remote-apps.test.ts` (*A SIGN-IN THROUGH A REVERSE PROXY AT THE MASJID IS NEVER USABLE FROM OUTSIDE*).
    - **Two cookies, two names.** The LAN session lives in `omos_session` (`COOKIE_NAME`), non-`Secure` as above. The
      remote dashboard's lives in `__Host-omos_session` (`REMOTE_COOKIE_NAME`), set with `REMOTE_COOKIE_OPTS` — always
      `Secure`, `HttpOnly`, `Path=/`, no `Domain` — and only a request the front door handed over reads or sets it
      (`trpc/context.ts`, `api/ws-auth.ts`). The prefix is the point: a page or backend on a sibling hostname may set a
      cookie for the parent domain, and a planted `omos_session` would shadow the real session on every request it
      covered, signing the admin out in a loop. A browser refuses a `__Host-` cookie that names a `Domain`, so nothing
      on another hostname can plant it, and no script can overwrite it while it is set (`HttpOnly`). `Path=/` means the
      browser sends it with app paths too, since the dashboard shares the apps' hostname (§13.2e); the ingress removes
      it before forwarding (`cookieHeaderForApp`). Being sent is not the danger — the KEY is (§15, *ONE ADDRESS*).
    - **For a handed-over request the door is part of the session.** The tRPC context and `requestUser` also require
      `remoteAdminEnabled()`; because a WebSocket's context is built once and lives as long as the connection,
      `trpc.ts` `isAuthed` re-checks the door AND `isRemoteSession` on every protected call, terminals re-check before
      every keystroke, and `system/remote-sockets.ts` closes what no longer qualifies (§15).
    - **Through the tunnel, an app's single sign-on never sees a session at all.** `/api/auth/session` (LAN-only, app
      secret) still resolves the forwarded `omos_session` with `getSessionUser` — any live session, exactly as on the
      LAN — or else an app access token made for the calling app (`appAccessSsoUser`, §15). The first draft of this
      bullet ended "app SSO still accepts any live session", and through the tunnel that was a hole: the ingress relayed
      the browser's cookies to a shared app verbatim, so a password-only LAN cookie presented there was forwarded by the
      app and accepted, with no second factor. The ingress now removes every platform session cookie from what an app
      receives through the tunnel and puts back only that app's own access token (`cookieHeaderForApp`).
  - **The second factor has an EPOCH, so replacing it ends what it opened — from outside** (`auth/twofactor.ts`
    `epoch`, v0.51.2-dev.16). It is re-randomised — random rather than a counter, so a restored file can never collide
    with a later value — by enrolling an authenticator (`confirmEnrolment`), replacing the backup codes, switching
    emailed codes on or off, and turning two-step sign-in off (`disableTwoFactor` keeps nothing but a new epoch, so a
    session made under the removed factor cannot come back if it is switched on again). Never by USING a factor:
    signing in must not sign everyone else out. Every remote session made under the old epoch stops working from
    outside, and with it every app access token derived from one; before, a session made with a lost phone or a found
    backup code ran its full seven days, files and terminals included, whatever the admin did about the factor.
    - **The epoch revokes REMOTE use and nothing else, by design.** `getSessionUserFor` consults it only for a tunnel
      request; on the masjid's network every session stays bound to the password alone. The second factor has never
      been part of signing in there — `login` demands it on tunnel traffic only, at Hasan's direction, so a volunteer is
      never locked out of the dashboard by a phone left at home (`trpc/routers/auth.ts`) — so a change to it has
      nothing to revoke on the LAN. What ends a session everywhere is a password change. Tying LAN sessions to the
      epoch would sign the admin out at the masjid for an event that never protected the masjid.
    - **The session that made the change keeps going.** A change made FROM OUTSIDE moves the caller's own session to
      the new epoch (`rebindRemoteSession`, from `afterFactorChange` in `trpc/routers/twofactor.ts` — judged by
      `viaTunnel`, deliberately, not by the hand-over: a session made through a reverse proxy at the masjid is held
      to the epoch as well, so it is moved with it), because they have just proved the password and a current code
      and are usually reading backup codes shown once — signing them out there unmounts the codes before they are
      written down. Every other handed-over socket that no longer qualifies is
      closed at once (`sweepHandedOverSockets`). (Turning two-step off shuts the door on the caller too: with no factor
      there is no remote administration.) A change is refused if another lands while its password is being checked
      (`requireSudo`'s CONFLICT, §15), and for as long as a restore runs (below).
    - **Around a restore, the epoch is HELD and then RENEWED** (§15 has the restore's side). A restore that carries
      `config/` replaces `twofactor.json` under the running daemon with the backup's, which holds the epoch the factor
      had when the backup was taken. So from just before that swap until the restore ends, `secondFactorEpoch()`
      answers the epoch as it stood when the hold was taken (`holdSecondFactorEpoch`), and **a sign-in completed
      meanwhile is bound to that HELD epoch** (`verifySecondFactor` returns it, not the file's) — bound to the restored
      file's, it was refused the moment it was made. **Nothing about the factor can be CHANGED while a restore runs —
      the whole restore, not only the hold** (`refuseDuringRestore` in `trpc/routers/twofactor.ts`:
      `secondFactorHeld() || isUpdating('restore')`, a CONFLICT: *"A backup is being restored right now. Please try
      this again once it has finished."*). Before the swap, the backup's settings would simply overwrite a change;
      during the hold it counted for nothing until the release, and the admin who made it, moved onto the held
      epoch, was signed out from outside the moment the restore let go — earlier versions let both happen. It is
      asked at the start of `requireSudo`, again once the password has been checked — a restore can begin while
      argon2 runs — and at the start of `confirm`, so all five two-step mutations are refused before any code is
      spent. (Every other signed-in change is refused for the whole restore too — §15, *NOTHING IS CHANGED FROM THE
      DASHBOARD WHILE A RESTORE RUNS* — and that rule answers first; but it is asked only as a call arrives, so this
      one's second ask, after the password, is still what catches a restore that begins mid-check.) Signing IN goes
      on working throughout. And **a restore that puts a backup's `config/` in place RENEWS
      the epoch** (`renewSecondFactorEpoch`, straight after the rename) **and moves only the restoring admin's own
      remote session onto it** (`rebindRemoteSession`, with the token `api/restore.ts` passes from
      `requestSessionToken`, in the restore's `finally` while both holds still stand, so there is no moment that
      session does not count) — and only if that session STILL counts then (`remoteGrantOf`, judged against the held
      epoch): one shut out while the restore ran must stay out, and the rebind used to carry it back in
      (`test/remote-restore.test.ts`, *A RESTORE DOES NOT CARRY ITS CALLER BACK IN*). Releasing the hold onto the
      backup's epoch, as the first cut did, brought back from outside every session made under the factor as the
      backup had it — one the admin had shut out since by replacing the factor included — and shut out the admin
      doing the restore whenever the factor had changed since the backup. A new epoch counts for nobody else, and
      every session ends at the next boot anyway (`endAllSessionsAtNextBoot`). The renewal ends sessions; it does not
      undo the factor itself, whose backup codes come back as the backup had them (§15).
  - **An emailed code is bound to WHERE it goes** (`emailBoundTo`, v0.51.2-dev.16). It proves "this person can read
    the masjid admin's mail" only while it is sent there, and both the admin's address (Settings → Account) and the
    mail account (Settings → Email) can be changed by a password-only session on the LAN. Unbound, that session could
    quietly redirect the next sign-in code, and the factor would no longer mean what the admin switched on. **Be exact
    about what the binding is NOT:** it is not what stands between a dashboard session at the masjid and signing in
    from outside. Such a session can download a backup, and a backup holds the authenticator's secret along with every
    other one (backups are unencrypted, §15). What two-step sign-in protects is remote access from someone who knows
    the password but cannot reach the masjid's network. This bullet used to say the binding stopped a LAN password
    being turned into a remote session, "the one thing two-step sign-in exists to stop" — which promised more than any
    binding can give. So codes are sent and honoured only while the admin's address and
    `emailDeliveryFingerprint()` (the provider plus the SMTP host, port, TLS flag and user, or a hash of the Resend key
    — not the From address, which changes only what a recipient sees, and not the SMTP password, whose rotation keeps
    the same mailbox) still match what they were when emailed codes were switched on. A change PAUSES them
    (`emailUsable`; `twoFactorStatus().emailPaused`, which the two-step panel says out loud) rather than following it,
    and turning them on again is `setEmailFactor` behind `requireSudo`: the password and a current authenticator or
    backup code. **Emailed codes can be switched on only alongside an authenticator, and the server enforces it**
    (`setEmailFactor` refuses `enabled: true` without one, PRECONDITION_FAILED; §15 says why the screen alone was not
    enough), so a pause never leaves the admin without a factor. Configurations from before the binding are adopted at
    boot (`adoptLegacyEmailBinding`) — never from a read, because a status check must not change security state.
    Residual: a configuration from before that rule with emailed codes as its ONLY factor keeps working until they
    pause; then nothing is enrolled, remote administration closes, and they cannot be switched back on without an
    authenticator — so the way back is enrolling one, on the masjid's network.
  - **Backups leave `config/sessions.json` and its `.tmp` OUT, and ONLY those** (`backupTarArgs`): a bearer credential in an unencrypted archive. Two GNU tar traps, both caught: exclusion and anchoring options are **positional** in tar ≥1.29 (Alpine ships GNU tar 1.35 — the image's `apk add tar`), so after the paths they exclude nothing; and patterns are **unanchored by default**, so a bare `--exclude=config/sessions.json` also silently dropped any app's own `apps/<id>/config/sessions.json` from a backup that still reported success. Hence `--anchored … --no-anchored`, before the paths. `test/session-persistence.test.ts` runs the real arguments through the real binary and checks both directions.
  - **The dashboard re-checks `auth.me` on EVERY window focus (`'always'`) and every 60 s** (`Root.tsx`). `true` would honour the global 30 s `staleTime`, and coming back within half a minute is exactly what an admin does after an app tells them to "press Open from the dashboard" — so the loop would survive. A background refetch with data present neither flashes the splash nor remounts the sign-in screen.
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
tunnel: true                      # OPTIONAL — REQUEST internet exposure (the admin decides, at install + in Settings)
email: true                       # OPTIONAL (v0.41.0) — may POST /api/fabric/email to send mail
whatsapp: true                    # OPTIONAL (v0.51.0) — may POST /api/fabric/whatsapp (QUEUES, never sends)
alerts:                           # OPTIONAL (v0.41.0) — admin gets a granular on/off per alert
  - id: reader-offline            #   kebab id passed to POST /api/fabric/alert
    label: Card reader offline
    description: A payment reader stopped responding.
```

How the core installs/manages a catalog app (the real behaviour):
- **Install** = write the entry's `compose` to `compose.yml`, write the user's `settings` answers to a
  `.env`, then `docker compose -p omos-<id> --env-file .env up -d --remove-orphans`. Per-app files
  live under `/opt/openmasjid/apps/<id>/`; an app's own data is in its Docker named volumes.
  - **A value reaches the app exactly as typed** (`encodeEnvValue`, v0.51.2-dev.18): compose
    interpolates an unquoted `.env` value and cuts it at ` #`, so `pa$$w0rd` arrived as `pa$w0rd`.
    A plain value is written as it is; anything with `$`, `#`, a quote, a backslash or edge
    whitespace is double-quoted, with backslashes and quotes escaped and every `$` doubled
    (compose-go's dotenv rules), and `readEnvFile` decodes it (`decodeEnvValue`). Every rewrite
    of an existing `.env` goes through `updateEnvFile`, which changes only its own keys and leaves
    every other line byte-for-byte; a custom app's pasted `.env` is written as pasted.
  - **Start, stop and restart throw when Docker refuses** (a `docker compose` failure shows only in
    its exit code); Docker's output is logged and the admin, or the WhatsApp sender, is told.
- **Discovery** is by the compose **project name** `omos-<id>` (Docker's automatic
  `com.docker.compose.project` label). Apps add **no** special labels; the platform records each
  app's kind/version in its own `apps/<id>/meta.json`.
- **Open URL** comes from the container's **published host port**; the platform checks host-port
  conflicts before install and offers to remap. That is on the masjid's network. From outside, Open goes
  through a one-use ticket to the app's PATH on the apps' hostname (§13.2e, §15), so an app must work under
  a base path to be usable there.
- **Update** (catalog app) = re-fetch the entry, rewrite `compose.yml` (keeping the user's `.env`),
  `compose pull` + `up -d` — settings and data preserved (app ⋮ → "Check for update"). The new compose is
  risk-checked first (§15), the old one is put back if the download or the start fails, and the window says how it
  ended (§13.4).
- **Remove** = `compose down` (with `--rmi all -v` when the user also deletes the app's data).
- Validate every entry before running it (kebab `id`, required fields); never `up` an untrusted
  compose without risk-checking it first (§11, §15). A `fabric:` block is shape-validated
  (`parseFabric`) and issues the app the per-app secret; `tunnel: true` is only a request — the Store
  asks at install (the box pre-ticked when the manifest requests it), the admin can change it per app in
  Settings → Remote access, and with no answer the app stays private. Full contract + broker/tunnel mechanics:
  `docs/APP_MANIFEST_SPEC.md` and `docs/FABRIC_APP_LINK_AND_TUNNEL.md`.

---

## 11. Third-party / custom apps (advanced, opt-in)

This is **off by default**. It is enabled in **Settings → Advanced → "Allow custom apps"**.

- When enabled, the **App Store gets a "3rd Party App" button** (visually marked as advanced). When disabled, that button does not exist anywhere in the UI.
- The button opens a hub with two ways in:
  - **Community apps** — browse + install apps from **CasaOS-compatible app stores** the admin adds by URL (an "Add app store" field; a note recommends CasaOS-compatible repos). Installed community apps are tagged "Community".
  - **Docker Compose** — a **paste-a-compose** UI: a name, an optional icon, a `docker-compose.yml` text area, and an optional `.env` text area.
- On submit the core **validates** the YAML before running anything: it must parse; reject or hard-warn on dangerous settings (`privileged: true`, `network_mode: host`, mounting `/var/run/docker.sock`, mounting sensitive host paths). Dangerous stacks require an explicit "I understand the risk" confirmation.
- The stack runs as compose project `omos-custom-<slug>`; data lives under
  `/opt/openmasjid/apps/custom-<slug>/`. **The platform writes no Docker labels** — discovery is
  by the compose project name (Docker's own `com.docker.compose.project`) exactly as §10 says,
  and the kind is recorded in `apps/<id>/meta.json`. `docker/discovery.ts` *reads* a
  `com.openmasjid.kind`/`.name` label if an app happens to set one, but nothing here sets it, so
  never rely on one being there.
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
- **Accent color:** the five in `lib/prefs.ts` `ACCENTS` — **Cyan (default)**, Teal, Sky, Violet,
  Gold. Each carries its own `onPrimary`, a very dark variant of itself used as the ink on top
  of it; `applyAccent` must set the two together or light mode puts white text on a bright
  button (`theme-tokens.test.ts` does the contrast arithmetic).
- **Dashboard name:** cosmetic title shown in the header (default `OpenMasjidOS`; a masjid may rename it to whatever they like — this is decoration, not prayer config).
- **Masjid logo:** an optional uploaded logo (PNG/JPG/WebP, ≤1 MB; raster only — no SVG). Stored server-side as raw bytes (`config/branding/`, chmod 600), NOT a data URI in settings. Reused across the masjid's outbound comms: notification webhooks (Slack/Discord) show it as the sender avatar, OS-sent emails (alerts + the test) show it as a remote `<img>` — **both only when remote access is configured**, because the receiving service fetches the image from *its* network, so a LAN address is useless — and apps can read it over the Fabric (`/api/public/appearance` → `logo`) to brand their own receipts. **Email deliberately does NOT use a CID attachment** (it did until v0.47.0): the MIME was correct — nodemailer emits `multipart/related` + `Content-Disposition: inline`, and Resend's `content_id` is its only documented inline lever with no disposition field — but mail clients list *any* part carrying a filename in their attachment row, so the logo arrived as a downloadable `logo.png`. Dropping the filename is the only thing that changes the MIME and it breaks inline rendering in Outlook/Thunderbird, so the only provider-independent fix is to send no attachment at all. Without a tunnel, the masjid's name renders as a text wordmark instead (always rendered, so a client that blocks remote images is never left with a blank header). Admin upload/clear (`/api/branding/logo`) is auth-gated and registered on the dashboard listener only, never the HTTP front door — so from outside it is reachable only through remote administration, on the dashboard's own address, by a session that passed the second factor (§13.2e, §15); the read is the public `GET /api/public/logo`. Still presentation, not masjid/prayer config.
- **UI language: there is NO language control, and this is deliberate.** English is the only
  locale, `i18n/index.ts` registers only `en`, and Settings has never rendered a picker. The
  i18next plumbing stays — every string still goes through `t()`, because a missing key then
  fails a test instead of shipping raw text to a masjid — but do not describe a language
  setting that a masjid cannot find, and do not justify a design decision by appealing to
  translations that do not exist. `applyLanguage` and `RTL_LANGS` remain wired for the day a
  second locale lands.
- **Display preferences:** time format (12/24h) and timezone used for showing timestamps/log times in the dashboard. (Purely a display setting for the platform — not used for prayer calculations.)
- **Animations: there is NO on/reduced control, and the OS setting is the whole mechanism.** `prefers-reduced-motion` is honoured unconditionally in `tokens.css` and in the Motion presets, which is the part that matters for accessibility and is non-negotiable (§14). A dashboard toggle was described here for a long time and has never existed in `routes/Settings.tsx`; if one is wanted it is a `reduceMotion` pref feeding `MotionConfig` plus a `data-motion` attribute the CSS blocks key off — a deliberate change, not something to describe as already shipped.

### 13.2 Account
- Change the admin's **name, email and WhatsApp number**, and the **password**. The email is where OS alerts (and
  emailed sign-in codes) go and is accepted at sign-in in place of the username; the number is a destination only
  (§13.2b-ii). The login username itself does not change here.
- **Two-step sign-in** (`components/TwoFactorPanel.tsx`): an authenticator app with ten backup codes, and — only
  alongside it — emailed codes. It is asked for only when signing in from outside, and remote administration cannot
  be switched on without it (§9, §13.2e); a change to it needs the password and, once one is active, a current code —
  on the masjid's network too. So with the phone AND the backup codes lost, the only way to remove it is the
  installer's Reset sign-in (§8.1). Emailed codes need a mail provider (§13.2b) AND an address on the account, and
  the panel names whichever is missing (`twoFactor.status` `emailMissing: 'provider' | 'address'`) — it used to send
  an admin with a provider but no address off to set up a provider (`test/twofactor-router.test.ts`, *when emailed
  codes cannot be used, the panel is told WHICH is missing*).

### 13.2b Email (SMTP / Resend)
- Configure ONE email provider — **SMTP** (host/port/TLS/user/pass) or **Resend** (API key) — plus a From address/name. The secret (SMTP password / Resend key) is stored in `config/email.json` (chmod 600) and never returned to the UI (only "is set" flags). A **"Send test email"** button verifies it, and a green/red status dot shows configured/not. Apps send mail through this over the Fabric (`POST /api/fabric/email`, `email` capability) — no app ever handles the credentials or the From address.

### 13.2b-ii WhatsApp (OpenWA)

- A second outbound transport beside email, through **OpenWA** — a self-hosted, MIT-licensed WhatsApp gateway the masjid installs **from the App Store** (the catalogue entry lives in OpenMasjidAPPS; the platform never runs it). The API key lives in `config/whatsapp.json` (chmod 600) and never returns to the UI (only an "is set" flag). The gateway is resolved automatically from the app registry at its published host port — via `system/app-host.ts`, the same no-SSRF rule the Fabric broker follows — with a typed `baseUrl` as the override for a gateway on another machine.
- **The admin phone number lives on the admin record** (`auth/store.ts` `phone`, `getAdminPhone()`), exactly as the email does: a destination for OS alerts and the test message, **never a login identifier**. Stored as digits, so one number has one representation. Every phone input in the UI is `components/PhoneField.tsx` — a country picker plus the national number, never a free-text box asking for "international format", because `+1 555…` / `001555…` / `555…` all look reasonable and three of them are wrong. No phone library (libphonenumber is ~150 KB gzipped); the server's `toDigits` stays the authority and **never guesses a missing country code** — and refuses a number starting with 0, because no country code does (v0.51.2-dev.18: `07700 900123` and `0044 7700…` were accepted, answered 202 and never delivered). The field drops a trunk 0 typed after the country code (`lib/phone.ts` `nationalPart`; Italy, +39, keeps it): its hint says to type the number "as you'd normally write it", which at home includes the 0, and +44 07700… was stored as 4407700…, a number WhatsApp does not know.
- **The whole feature is behind ONE switch that is off by default, and the gateway app is hidden until it is on.** `apps/managed.ts` marks OpenWA platform-managed: `visibleCatalog` keeps it out of the App Store unless `provider !== 'none'` (fail-closed — a managed id with no gate stays hidden), and `InstalledApp.managed` keeps it off the dashboard grid and out of the dock. Turning the switch on requires accepting the ban-risk warning, and then leads straight into installing it (`/store?install=<id>`). The reason is not tidiness: the platform **owns the session** — it creates, starts, pairs and paces — and every one of those guarantees breaks if an admin links a second phone in OpenWA's own UI or sends from there, bypassing the one queue. Opening OpenWA to *read or reply to chats* is fine and is the only thing the Settings button is for. From outside the masjid that button is disabled and says why (`whatsappGatewayOpenRemote`): OpenWA's own screen does not work under a path, which is how the tunnel serves an app (§13.2e).
- **Turning the switch OFF asks WHICH off, because there are two and only the admin knows which they mean.** Off-and-keep (the default) writes `provider: 'none'` and nothing else, so the key, session, linked number, approved groups and trustee list stay on disk and switching back on restores the setup exactly — that is a promise the UI now makes out loud, and `test/whatsapp-delete.test.ts` pins it. Off-and-delete erases all of it plus the gateway app **with its data**. It used to switch off silently, which was defensible but left an admin who believed they had removed WhatsApp with every secret still on disk, and an admin who only wanted a pause with no way to know their setup was safe.
  - **The ORDER of the delete is load-bearing, and the first step is the one that is easy to leave out.** Unlink at WhatsApp FIRST, while the gateway container still exists: `POST /api/sessions/:id/logout` is the ONLY route that asks WhatsApp to release the companion device. `stop`, `force-kill` and `DELETE /api/sessions/:id` all release things **locally only** — verified against OpenWA's own source, whose comment on the method says exactly that — so the device stays listed under Linked Devices on the masjid's handset. Remove the container first and nothing in this dashboard can ever revoke it again. Then, in order: `provider:'none'` (so `enqueue` refuses and the pump drains rather than spinning against a gateway about to vanish) → `deleteWhatsAppConfig` → queue store + runtime → alerts column → commands → `removeApp(OPENWA_APP_ID, true)`. That `true` is not a nicety: it is what removes the Docker volumes holding the linked-device credentials and `apps/openwa/.env`, which is a SECOND copy of the API key and is written without an 0600 mode.
  - **A 200 from `logout` is an acknowledgement, not a look at the handset**, and a **502** (`SESSION_LOGOUT_INCOMPLETE`) means the device may still be linked — so it is surfaced as "go and remove it on the phone", never folded into a generic failure and never reported as unlinked. The gateway steps are best-effort: a masjid deleting a BROKEN install must not be blocked by the very thing that is broken.
  - **Three erasures exist only because nothing else could do them.** `deleteWhatsAppConfig` is separate from `saveWhatsAppConfig` because `computeNext` ignores a blank `apiKey` **by design** (so editing a limit never makes an admin re-paste a secret) — which means no admin edit can ever blank the key. `clearWhatsAppChannels` exists because the alerts matrix keeps its own copy of "route this to WhatsApp": without it a delete-then-reinstall silently resumes messaging the phone, breaking the exact promise that column's OFF default was added to make. `clearCommandPeople` exists because the trustee list is an authorisation model in its own right — a phone on it starts, stops and updates apps with no password step — so it must not outlive the transport it rides on. And `clearWhatsAppRuntime` is deliberately NOT `__resetPacingForTests`: the latter leaves `outcomes` and `lidPhones` (a cache of WhatsApp privacy ids → real phone numbers) alone, and both are personal data belonging to a masjid that has just asked for all of it to go. Merging them silently widens one or narrows the other.
  - **Unlink is its own action, not a side effect of turning the feature off.** Changing handsets must not mean re-pasting a key and re-approving every group, so `whatsapp.unlink` logs out and keeps everything else. And once a phone IS linked the panel states the number instead of still showing an empty "Link your phone" box — which read as "this didn't work" and invited linking a second handset over a working one. `linkedPhone` requires `state === 'ready'` **and** a number: `pending` and `problem` can also carry one (a linked-then-disconnected handset), and calling that "sending from" would be a lie on the one panel an admin checks when messages stop.
- **A session can DIE while still reporting `ready`, and that is the failure the health monitor exists for.** A masjid's session expired the way WhatsApp Desktop signs itself out. Apps kept getting `202 {queued}`, OpenWA kept accepting, and every message was recorded **`sent`** — while OpenWA's own UI showed them sent to the right chat and undelivered. Unlink + relink fixed it instantly.
  - **Polling `gatewayStatus()` would NOT have caught it, and nothing should be built on the assumption that it would.** `pump` only sends when `ensureStarted` sees `status === 'ready'`, and messages went out — so the session row said `ready` throughout. A status poll reads the same cached field the sender reads: the detector and the sender agree with each other and are both wrong, and the admin gets a green dot for the whole outage. So `system/whatsapp-monitor.ts` probes `/chats` (`probeLink`), whose **503** is OpenWA saying the engine's WhatsApp connection is gone. `gatewayStatus()` is still read, but **only for bad news** — its `ready` is never proof of health.
  - **`sent` means "OpenWA's HTTP layer returned 2xx"** — an accept receipt from the gateway process, not from WhatsApp and not from the recipient's phone. The log line said "delivered" and no longer does. Genuinely knowing delivery needs WhatsApp's acks, which are undocumented and only reach an install with commands enabled; `whatsapp-inbound.ts` now records the **key names only** of the frames it discards (`noteEventShape`), surfaced in the Commands diagnostics, so the shape can be OBSERVED on real gateways before anything is built on it. Do not write ack handling from memory — that mistake has been made here once already.
  - **Detection rules that must not regress:** two consecutive agreeing ticks before acting (a blip must not page anyone or pause a real queue); an inconclusive probe records **nothing**, never alerts, and does not count towards those ticks (§13.2d's "couldn't ask is not an answer"); state persisted **before** alerting; and the monitor is a complete no-op until a phone has actually been linked. A run of 401/403s on the send path counts as evidence too — those messages are dropped after one attempt, so they used to be a silent loss.
  - **A confirmed incident PAUSES the queue, and only an admin releases it.** Held items keep their bodies, so they can be resent; `MAX_HELD_MS` now measures **time the link was usable** (`effectiveHeldMs`), because wall-clock turned a weekend outage into silent data loss on the next restart. The queue does **not** drain when the link returns — a two-day backlog going out back to back from a freshly relinked number is the clearest ban signal there is. `releaseQueue` banks the paused time before clearing the flag, or everything would expire the moment it was freed.
  - **The blind window is reported, not papered over.** Between the link dying and detection, messages are marked `sent` and their bodies deleted (the item leaves the queue *before* the outcome is written), so they are unrecoverable **by construction**. The alert and Settings name the window and the per-app counts; `GET /api/fabric/whatsapp/suspect` (additive, GET-only, on the read budget, scoped to the caller's own `source`) lets an app reconcile from **its own** records. Never imply the platform can resend them.
  - **This alert can never be routed over WhatsApp.** `whatsappAllowed` takes an alert id now, and `whatsapp-link-lost` is refused on **read** as well as write — otherwise the matrix offers a live toggle that sends a "WhatsApp is down" alert into the down gateway, where `enqueue` returns `{queued:false}` and it vanishes with no log and no fallback.
- **This is an UNOFFICIAL client and the linked number can be restricted or banned.** That is stated in the UI *before* linking, not as a footnote, and in `docs/WHATSAPP.md`. Email remains the fallback, and nothing auth-critical (a login code, a password reset) may ever depend on WhatsApp.
- **OpenWA's lifecycle is create → START → pair, and skipping the start is why linking returned a bare 400.** A created session has no engine, so every engine route answers `400 Session is not started`; the status panel meanwhile said "gateway running, no phone linked yet", which was true and pointed nowhere. `ensureStarted` reads the session first (`ready` = already linked, `engineLoaded` = already running, and `start` itself refuses a live engine with a 400 that must be read as success), and the pairing request retries a `409` because the engine takes a moment to come up after starting. The pump waits on the same check rather than spending a message's retry budget on "not linked yet". `restriction` from the session row is surfaced to the admin — it is the ban risk actually materialising, and swallowing it would leave a masjid wondering why messages stopped.
- **ONE serialised queue owns all sending — never add a second path.** Ban risk attaches to the NUMBER, not to a caller, so two apps each sending "politely" at once still produce a burst. Every message — OS alerts and every app's Fabric call — goes through `notify/whatsapp.ts`. OpenWA's `send-bulk` is deliberately unused: it paces *within one request*, which does nothing about two requests overlapping.
- **Almost ALL pacing has been removed, in stages, at Hasan’s direction.** What remains is per-message and bounded: one serialised queue (never two sends at once), a typing indicator scaled to the message (5s floor for an image) then `paused`, presence online-while-working, `contacts/check` before first contact, and a bounded retry with widening backoff on a transient failure. `blockedReason` now returns `null` unconditionally and carries the full reasoning; `capExceeded` and `warmupFactor` are inert and documented as such.
  - **REMOVED and not to be reinstated without asking:** quiet hours (held staff alerts overnight; evaluated in the container’s UTC clock so “21:00–07:00” was really 17:00–03:00 US Eastern), the individual hour/day caps (12/60 → **3/hour** once the warm-up ramp applied, which blocked testing the feature), the per-recipient (60s) and **per-group (30 MINUTE)** cooldowns, the group caps (4/hr, 10/day), the warm-up ramp, and the randomised 6–20s inter-message gap. Each is pinned by a test asserting its ABSENCE, so none can creep back silently.
  - **The residual risk is accepted, not overlooked.** Nothing now stops an app looping over hundreds of recipients as fast as the typing indicator allows; ban risk attaches to the NUMBER and a ban is terminal. If a ceiling is ever wanted again it belongs on the SHARED queue in `blockedReason`, never per-app — an app-level limiter cannot see the number’s total traffic, which is the only figure WhatsApp cares about.
  - **Two head-of-line blocks in `pump` are fixed and must not return** (v0.51.1-dev.6). It read `queue[0]` and, when that item could not go, slept and re-read the SAME item — so one waiting message stalled every other app’s traffic for the length of its own wait (half an hour, with the group cooldown). And a transient failure did `await sleep(backoff)` inside the loop — up to 15 min × 5 attempts of total silence caused by one bad send. Now: the loop sends the first SENDABLE item, and a failure sets a per-item `notBefore` (persisted) instead of stalling. This is the mechanism behind the reported “one app’s image never arrives while another app’s later messages do”.
  - **There is NO time-of-day hold, and nothing should add one back to the pacer** (removed v0.51.1). Quiet hours held EVERY message on the one shared queue, and with no per-message urgency flag an app could not mark one as un-holdable — so the same window that reasonably delayed a parent's receipt also delayed a staff alert about a declined card until morning, which is the entire reason a treasurer carries a phone. It was also evaluated against `new Date().getHours()`, i.e. the **container's** clock, and nothing sets `TZ` — so "21:00–07:00" was UTC, landing at 17:00–03:00 for a US Eastern masjid and swallowing the whole evening. `test/whatsapp-pacing.test.ts` fails the build if `getHours()` reappears in the module. Quiet time belongs to the **sender**, which knows whether it is messaging a parent or a treasurer; the pacer deliberately does not.
- **The queue, the pacing history and recent outcomes are PERSISTED** (`notify/whatsapp-queue-store.ts` → `config/whatsapp-queue.json`, 0600 because a body carries a child's name and a family's fees). The queue was memory-only until v0.51.1, so anything the pacer was holding died with the process — and on a Development box, which restarts often, that produced the worst possible failure: `202 {queued:true}`, logged as queued, never delivered, **no error anywhere**, for over 24 hours on a real masjid. The tell was that `!os` commands worked throughout, because a reply goes out via `sendImmediate` and never touches the queue; "commands work but messages do not" localises the fault to the queue exactly. The **history** is persisted for a second reason: it is the ban-risk budget, and a box in a restart loop that forgets its sends does not really have caps. A message held >24h is dropped rather than released (a backlog flushed at once is the burst that gets a number restricted) and recorded as `expired`; a damaged store degrades to empty rather than stopping the daemon.
- **An app can ask what became of a message.** `POST /api/fabric/whatsapp` returns `202 {queued, id}` and `GET /api/fabric/whatsapp/status/:id` answers `queued|sent|failed|expired` with a reason. **Scoped to the caller's own `source`** — another app's id answers 404, the same as an unknown one, so this cannot become a way to observe another app's traffic — and the record holds no message text and no recipient. This exists because `202` used to be the end of the story: an app had recorded that it handed the message over and nothing anywhere could contradict it, which is what made the outage above undiagnosable from the app's side.
  - **The outcome history is bounded PER SOURCE (500, 24h), never globally, and the status route has its OWN rate budget.** Both were wrong in the first cut and both broke the feature for exactly the apps that adopted it. A single 200-record ring is a resource every app shares, so the app that sends most evicts everyone else's records — a student-billing app messaging a 200-family roster wiped the reader-offline and refund outcomes of every other app on the box, then its own earliest ones, which are the failures most worth reporting. And `RATE_MAX_APP` (120/min) covered every Fabric route, so an app doing precisely what the platform asks — record the id, poll for the outcome — spent its **send** allowance on in-memory reads and was 429'd part-way through reconciling. `capOutcomes` (count caps, no clock) is separate from `trimOutcomes` (age + counts) because `saveQueueState` is a serialiser: giving it its own `Date.now()` silently discarded every record whose timestamp wasn't near the wall clock, which is every test fixture and every box whose clock NTP has just corrected. The read tier is **GET-only and matches the raw *and* dot-resolved spellings** — a raw `startsWith` would have priced `POST /api/fabric/whatsapp/status/..`, which Fastify resolves to the send route, as a read (§15's raw-vs-decoded rule, reappearing in a rate limiter).
- **Sending to the gateway's OWN linked number is refused at the door**, not queued. WhatsApp treats it as "message yourself", the platform cannot verify delivery, and an alert in the masjid phone's self-chat is not an alert anyone reads. The linked number is recorded by `recordLinkedPhone` from the session status (platform-recorded, never an admin field) so `enqueue` can answer synchronously.
- **Group posts go only to groups the ADMIN approved** (`store/whatsapp.ts` `isApprovedGroup` — the single authorisation check; `apps/` never see anything else). One message reaches everyone, which is exactly why the approval step is the security model and not a convenience: OpenWA's group list is the masjid's **entire** group membership, personal chats included, so `listGatewayGroups()` is admin-only (tRPC) and `GET /api/fabric/whatsapp/groups` returns the approved list alone — never a proxy of the gateway's. An unapproved id is a **403**, checked before anything is queued. Group JIDs are shape-validated (`isGroupJid`, `@g.us` only) before reaching a URL, and a `@c.us` address must never pass — it would silently turn "post to the parents group" into "message one person". **The platform never touches membership**: no add, remove, promote, demote or leave. Bulk-adding is both a top-tier ban signal and a consent failure, so people join by a link the masjid shares. Groups have **no budget of their own any more** — `groupPerHour`/`groupPerDay`/`perGroupCooldownSeconds` are stored and clamped but read by nothing, like every other field of `WhatsAppLimits`. Only the ONE serialised queue still applies. The reasoning for a separate, tighter group ceiling remains sound (an announcement must not eat the allowance fee reminders need, nor the reverse) and is why the shape is kept, but nothing enforces it today. **WhatsApp Channels cannot be posted to at all** (OpenWA has no send endpoint for them); a Community's announcement group is just a group and works normally.
- **An optional `media` sends an IMAGE** (`{data: base64, mimeType, filename?}`, `text` becomes the caption) through OpenWA's `send-image`, which takes base64 directly — verified against its `SendMediaRequest`; note it spells the field `mimetype` while our API uses `mimeType`, so neither side should be "fixed" to match the other. Images only (`png`/`jpeg`/`webp`) because documents/video/audio are separate gateway routes with their own rules. **Same queue, same pacing** — an image is a *more* conspicuous event than a sentence, with a composing-time floor so a half-megabyte upload isn't preceded by a two-second flicker. **A failed image is NEVER downgraded to its caption**: an app would report that a poster went out when only a sentence did. Caps: 2 MB decoded, 1024-char caption (the gateway's own limit, enforced at the door so it fails while the caller is listening), and **4 queued images max** — queued bytes are in memory while a paused queue or a downed gateway holds them, which on a Pi is an OOM kill that takes the dashboard with it. On disk each queued image is written ONCE, to `config/whatsapp-media/<id>` (0600, removed when its message leaves the queue, and by the delete-everything path), never inline in `whatsapp-queue.json`: that file is rewritten on every enqueue, send and retry, and inline it carried up to ~11 MB of base64 onto the SD card each time. An image that cannot be read back after a restart fails that message alone. The route sets its **own `bodyLimit`** because `registerFabric` runs on BOTH servers and they disagreed: the dashboard allows 25 MB while the HTTP front door — the one apps actually reach over `OPENMASJID_BASE_URL` — was on Fastify's 1 MB default. `GET /api/fabric/whatsapp` advertises `media` + `maxMediaBytes`, and an absent field must read as false.
- `POST /api/fabric/whatsapp` (capability `whatsapp`) returns **202 `{queued}`**, never "sent" — pacing puts delivery seconds to hours away. **One recipient per call**, because the API shape is the first place to discourage a cold blast. LAN-only under `/api/fabric`, rate-limited, and bodies are never logged (they routinely carry a child's name and a family's fees).
- The alerts matrix gains a **WhatsApp** column that defaults **OFF** for every alert, unlike email/webhook. An `alerts.json` written before this existed has no `whatsapp` key, so absence reads as off and an upgrade can never silently start messaging a phone.
- **The WhatsApp column is for OS alerts ONLY; an app's rows read "Set up in the app"** (`whatsappAllowed`, enforced in `getAlertChannels` on READ and refused in `setAlertChannel`, not merely hidden in the UI). The matrix routes to the ADMIN, and the platform knows exactly one number — so a toggle on an app's alert promised routing it cannot do. An app that messages over WhatsApp is reaching a parent about fees or a donor about a receipt, and those recipients, the wording and the timing are the app's own settings. **What does not change: apps still send through the platform** — `POST /api/fabric/whatsapp`, same gateway, same credentials they never see, same single paced queue. Only the *choice* moved. Email and the webhook stay available to apps, because those genuinely are "tell the admin something happened".

### 13.2b-iii Admin commands over WhatsApp (v0.51.0)

- An authorised phone can run things by message: `!os stats`, `!os restart 2`, `!display 1`. **This is a real escalation of the threat model** — a WhatsApp message becomes an action on a daemon running as root with the Docker socket, authenticated by possession of a phone. Off by default; most of the design is containment, and several capabilities are refused outright rather than confirmed.
- **Transport is a Socket.IO client, core → gateway** (`notify/whatsapp-inbound.ts`), the SAME direction the send path already runs via `appOrigin(port)`. So it adds **no inbound route and no new attack surface**, and works on an install predating the feature. A webhook was the alternative and is worse *here*: it needs the core's LAN address baked into the gateway, raw-body HMAC handling, a new route, and OpenWA's SSRF guard relaxed in the masjid's compose. **OpenWA does not document its wire protocol**, so it was read from its source: namespace `/events`, a single Socket.IO channel `'message'` carrying every frame, the WhatsApp event name in `payload.event`, and delivery only to a room you subscribe to (`{type:'subscribe', sessionId, events}`, whose ack is *returned* from the handler and so must be read with `.timeout().emit(ch, payload, cb)` — a plain `emit` discards it). So reception is `s.on('message')` filtering on `payload.event`, **not** `onAny()`: `onAny` is kept purely as a diagnostic, listing what the gateway has actually sent, because "connected and hearing nothing" is the failure this undocumented surface makes likely. The event filter rejects `ack|status|reaction|receipt|…` FIRST — reading a `message.ack` as a message would re-execute a command on every delivery receipt of our own reply — and matches the whole name as well as its last dotted segment (matching only the tail missed `message.received` itself).
- **The gate order is the security property** (`commands/gate.ts`): `fromMe` (absent ⇒ ours, or replies loop back in) → **a positively matched PERSONAL chat** → text only → 3s post-connect quiet window → age → **the whitelist** → **something granted** → duplicate LRU → the `!` prefix → rate limit.
  - **A listed person with nothing granted gets the same silence as a stranger** (drop reason `no-grants`, counted apart from `unknown-sender` so the diagnostics can tell them apart). Settings adds people with nothing ticked, and such a person used to be dropped from the list on every load, so they vanished at the next restart or restore; they are kept now, and this step is what makes keeping them safe. The list is written before it is believed (`save`), so a failed write leaves the running code on what the disk holds.
  - "Personal" is an **allow-list of address spaces, never a `!== '@g.us'` test** — WhatsApp has more than two: `@lid` (a privacy id, now common), `@newsletter` (Channels), `@broadcast` and `status@broadcast`. `isPersonalChatJid` admits `c.us` and `lid` only. And in a group the sender is `author`, not `chatId`, so a whitelist check on the wrong field reads the group's id as a person. Where the gateway supplies its own `isGroup` flag that flag is authoritative for **group-ness** — but "not a group" is not "a person", so the allow-list still has to pass: trusting the flag alone (which is how `@lid` support first landed) let a `@newsletter` or `@broadcast` chat through as direct, with its author then treated as a whitelist-checkable identity.
  - A `@lid` sender carries **no phone number**, so it is not an identity on its own. `resolveLidPhone` asks the gateway; a FAILED resolution drops the message rather than guessing. Two orderings are load-bearing: **dedupe AFTER the whitelist** (else a stranger's flood evicts the entries preventing a double-execution) and **the prefix BEFORE the rate limit** (else ordinary conversation drains an admin's own bucket and is then refused as "too many commands").
- **An unlisted sender gets SILENCE** — no reply, no log line. A refusal confirms to a stranger that this number runs a masjid's server, spends the budget fee reminders need, and is the strongest ban signal the account can emit. Only a prefixed attempt from an unlisted number is logged, rate-limited.
- **Every command starts with `!`, with ONE exemption: while the platform is holding a question for that sender.** A menu number still needs its prefix (`!display 2`), and a bare word still does nothing at any other moment — but `commands/gate.ts` step 12 skips the prefix rule when `awaitingReply(digits, now)` is true, i.e. an app is mid-question (`AppSession`) or a confirmation is being held. That is what makes a multi-step flow usable ("Which prayer?" → `Maghrib`), and inside a live exchange a bare message is unambiguously an answer rather than possibly-conversation, which is the only condition under which the prefix earns nothing. `!yes CODE` still works and is the only path available with no exchange open; while one IS open, a plain `yes`/`no` is accepted (`takeConfirmed`). The confirmation code is not authentication (the sender is already authorised) — it stops the WRONG message running: a typo, a stale menu number, a forwarded screenshot. Single-use, 90s (`CONFIRM_TTL_MS`, which the prompt's wording is built from), one pending per sender.
  - **The exemption's bounds ARE the security property, so all three must hold.** `AppSession` expires on idle (3 min), absolute age (15 min) and turn count (12); a held confirmation expires at `CONFIRM_TTL_MS` — and `hasPending` must apply that TTL, not merely test for presence. It didn't until v0.51.0, so an *ignored* prompt (which the prompt itself invites: "Ignore this to cancel") left the exemption open for ever, and every ordinary message that person sent afterwards spent a rate-limit token and drew an automated reply. `sweep` did not save it either: `touch` refreshes the idle timer on every inbound, so chatting kept the stale pending alive. `hasPending` is deliberately a PURE predicate — the gate evaluates it per message, and a security step must not mutate per-sender state as a side effect.
- **A menu number resolves against the menu that sender was SHOWN**, not a positional index into the current list, which moves when an app update inserts a command.
- **Replies reuse the ONE non-queued path** (`sendImmediate`, generalised from the test-send; `replyTo` takes **digits**, never a JID, so it cannot post to a group). Bypasses the queue. There is no budget left to spend — what stops "message yourself in a loop" is that a reply only ever answers an inbound message from an authorised sender, bounded by the **inbound** rate limit in `commands/gate.ts` (5, refill 1/15s). A solicited reply to a known contact is the lowest-risk traffic the number emits — that stays true only because **no command may take a phone number as an argument**, pinned structurally in `test/command-execute.test.ts`.
- **There is deliberately NO sending-allowance check on a mutating command, and nothing should add one back.** An earlier version refused to run one when the hour/day allowance was spent, reasoning that "it restarted but you will never know" is the worst outcome. The premise was false: a reply goes out via `replyTo` → `sendImmediate`, which calls `sendOne` directly and never consults the caps — so the check protected nothing while blocking real work, and it bit hardest on a freshly linked number, whose warm-up ramp quarters the hourly cap to ~3, locking an admin out of the very commands they were testing. It surfaced as `!os update` always answering *"I've hit today's WhatsApp limit"*. What bounds commands is the **inbound** rate limit in `commands/gate.ts` (5, refill 1/15s), which is tighter anyway. **Every mutating command still raises the `command-run` OS alert**: with one admin account there is no second pair of eyes, and a stolen phone does not have the inbox.
- **Refused, with the reasons written into `commands/os.ts`:** rebooting the host, app logs (secrets + PII, and a chat keeps a copy forever), OS self-update (it replaces the process holding the conversation), removing an app. **`!os update <app>` IS offered** — it recreates only that app's container, so the core survives to report back — but is refused for any `isPlatformManaged` app, because updating the gateway would sever the connection carrying the command. It reports what really happened (`updateCatalogApp`'s outcome, §13.4): an update that was refused or put back answers, for example, *"Donations wasn't updated, so nothing was changed. Have a look on the dashboard to see why."* — it used to say the app was updated, because the stayed-up check then found the OLD version still running. An update that is not staying up (`not-running`) says *"…was updated, but it isn't staying running"*, and `!os update` runs no second stayed-up check of its own. **"Couldn't ask" is never "up to date"**: an app the store has no version for (custom, gone from the store, the catalogue unreachable — `latest === null`) is reported as not checked by `!os update` and counted as unchecked by `!os updates`. `!os updates` saves the rows it numbered as the sender's app list, so the `!os update 1` it suggests means the first row it showed.
- **A held confirmation answers its own prompt only.** Any command other than a confirm or a cancel abandons it (`handleInboundCommand`), so a reflexive "ok" after `!os stats` cannot run the stop asked about earlier; and `runConfirmed` re-checks the sender's grant against this message's namespaces before running anything, because a restore replaces the list without firing the change hook.
- Apps declare `commands:` like `alerts:` (`parseCommands`); the platform authorises and renders, the app only executes at `POST /fabric/commands/run`. **`commands` is a reserved Fabric capability** — allowing it in `fabric.provides` would let another app reach that handler through the broker. The platform identifies itself as **`omos:platform`**, unforgeable *by construction* because the colon is outside `APP_ID_RE`'s charset; words like `os` are refused at install via `RESERVED_ID_WORDS`, deliberately **not** `RESERVED_APP_IDS`, which `rmSync`s the directory of anything in it.

### 13.2c Alerts (granular per-alert × per-channel matrix, UniFi-style)
- A list of every alert type — OS built-ins (an app going offline, a **core update available**, an **app update available**, a **card payment disputed** — see 13.2d) **plus each installed app's declared `alerts:`** — each with a **per-channel matrix**: route it to the admin **Email**, the **Webhook**, both, or neither. **Both channels on by default**; the platform persists only non-default choices (`config/alerts.json` → `channels`, with a legacy `disabled`-set migrated on load). When an alert fires, `deliverAlert` sends it to exactly the channels the admin chose (each fail-soft). Apps raise their declared alerts via `POST /api/fabric/alert`; the webhook (`/api/fabric/notify`) stays available on its own. The OS built-in update alerts are fired by a background monitor (`system/update-monitor.ts`) that polls for a new core version + newer versions of installed catalog apps and raises `core-update` / `app-update` the moment one is detected (once per version, not every cycle). **These alerts go to the ADMIN only** — an app emailing an end user (donor/parent/teacher) does that itself via `POST /api/fabric/email`, outside this matrix.

### 13.2d Chargeback alerts (`stripe-chargeback`)
- The platform polls each configured Stripe account for **disputes** (chargebacks) and raises the OS `stripe-chargeback` alert through the same matrix (`system/stripe-monitor.ts` + `stripe/disputes.ts`). No-op until a Stripe account exists; no app change needed.
- **Why the platform and not a donations app.** A dispute belongs to the **account**, and the whole point of the Stripe vault (§13.2 / `store/stripe.ts`) is that several apps share ONE account — so an app-raised alert would double-fire or, if that app were stopped, never fire. Chargebacks also arrive days/weeks after the payment, when the app may well be off.
- **Why polling and not a webhook.** A Stripe webhook needs a publicly reachable platform route, and §15 keeps the platform's public routes to presentation assets that carry nothing and one that does nothing without a one-use ticket the platform itself minted for an admin signed in from outside (`/_omos/open`) — plus, only if the admin switches it on, the dashboard's sign-in. A route accepting Stripe POSTs from anyone would breach that, and would still leave every LAN-only masjid with no alerts. Polling is outbound-only, adds no attack surface, and works with no remote access. The cost is latency (≤ one 30-min interval) against a dispute window measured in days.
- **This is monitoring, not payment processing** — it stays inside §4's "payment-agnostic" rule. The platform creates no charges and moves no money; it reads dispute status with credentials it already holds, exactly as the existing green/red Stripe status dot does.
- Rules that must not regress: **state is PERSISTED** (`config/stripe-disputes.json`) because a chargeback is a one-shot event — in-memory tracking would re-alert every open dispute on each restart; a **failure to reach Stripe records NOTHING** (treating "couldn't ask" as "none" would mark unseen chargebacks as seen and lose them permanently) and never alerts; **first run** absorbs settled history silently but DOES alert anything still `needs_response`, because doing nothing loses that money by default; and **>5 new disputes in one poll become one grouped alert**, since card-testing fraud can otherwise flood the inbox. Amounts respect zero-/two-/three-decimal currencies (JPY, KWD) — dividing by 100 regardless would misreport a Gulf masjid's KWD by 10x.

### 13.2e Remote administration (Settings → Remote access, v0.51.2)

- **Serving the DASHBOARD over the Cloudflare tunnel, not just app paths — at the root of the apps' address.** Off by
  default, and absent from every `settings.json` written before it existed, so an upgrade can never publish a
  masjid's dashboard. It needs nothing in Cloudflare beyond the ONE public hostname remote access already has —
  **Your apps' address** (`settings.cloudflare.domain`, formerly "Your domain"), Type HTTP, URL `localhost:80`
  (`PORT`). The remote dashboard is `https://<apps' hostname>/`, with every app beside it at `/<path>/` (v0.51.2-dev.17,
  at Hasan's direction: *"having to set up a separate subdomain just for remote access … is not it"*). That makes every
  app page the dashboard's own ORIGIN, and what keeps app pages out is the dashboard KEY, which none of them can ever
  obtain — §15, *ONE ADDRESS: THE KEY IS THE BOUNDARY*. The history matters, because both earlier answers were
  wrong or rejected: dev.13–dev.15 also served the dashboard there, but kept the key in `localStorage`, readable by
  every app page — host root from any app (§15); dev.16 drew the line with a second Cloudflare hostname for the
  dashboard alone (`settings.cloudflare.adminHost`, the "Dashboard address"), which was sound and which the masjid
  rejected as one more thing to set up and manage. All of dev.16's address machinery is deleted (`adminHost()`,
  `isAdminHost()`, `validateAdminHost()`, `remoteDoorOpen()`, `doorClosedReason()`, the refusal reasons
  `no-admin-host`, `dashboard-elsewhere` and `app-on-admin-host`). **Nothing looks at the hostname now**: whatever the
  tunnel delivers is served, so a box that kept dev.16's second hostname is served there too. The apps' address is
  used only where the platform must NAME a hostname — the plain-`http://` upgrade, *Open*, each app's public URL — and
  is saved bare (`hostnameOfDomain` strips a scheme and anything after the first `/`, then `normalizeHost`). The
  operator's steps are in `docs/REMOTE_ADMIN.md`.
- **The door is ONE predicate of four conditions, all re-read per request** (`system/remote-admin.ts`):
  `remoteAdminEnabled()` = `settingsOpenTheDoor(cf) && twoFactorActive() && isConfigured()`. The settings half —
  the tunnel is on and the switch is on, each a literal `true`, never merely truthy — is `settingsOpenTheDoor`, a pure
  function of a cloudflare settings object, because a restore from outside asks the very same question of the backup
  it is about to put in place (§15 says what a copy of the rule cost: a hand-written copy missed dev.16's hostname
  condition). The second factor is the point — an admin who turns two-step sign-in off closes this door in the
  same action, rather than leaving a password-only admin dashboard on the internet. The admin is the backstop
  (v0.51.2-dev.16): the second factor lives in its own file, so a box whose admin record went missing while those
  settings survived would otherwise offer first-run setup and first-run restore — open by design, "the box belongs to
  whoever reaches it first" — to the internet. `auth.setup` and the first-run restore routes also refuse tunnel
  traffic outright. `remoteAdminEnabled()` is the question every long-lived connection keeps asking (§15). The switch
  and the effect can therefore disagree, so `cloudflare.status` reports `remoteAdmin` (the setting) **and**
  `remoteAdminActive` (what is actually happening), plus `remoteAdminBlocked` (`remoteAdminBlockedReason()`:
  `no-two-factor` or `no-tunnel`), and Settings says which out loud; showing only the switch would be a screen that
  lies. `setRemoteAdmin` refuses to switch on for the same two. A refused dashboard visit while the door is shut is
  recorded as `lan-only-route`.
- **Turning it on is a dialog, not a toggle that fires.** It is the one control on that page whose effect is outside the
  building, and the dialog says plainly that the sign-in page at `https://<apps' hostname>/` will answer to anyone on
  the internet who knows the address. It also states what the second factor is really protecting, rather than listing
  reassurances.
- **Turning it OFF from outside asks first; at the masjid it does not.** Switching remote access (the tunnel) off,
  switching managing-from-outside off, and removing the tunnel each end the very connection the admin is using, and
  only someone at the masjid can turn them back on — so from outside each opens a `ConfirmDialog` that says exactly
  that (`settings.cfCutOff*`). On the masjid's network they stay one click, by `ConfirmDialog`'s own rule: a control
  that is reversible right beside it gets no dialog, because a dialog on every toggle trains people to click through
  the ones that matter. Removing the tunnel (`cloudflare.clear`) also switches remote administration off, rather than
  leaving it dormant to switch itself back on with the next tunnel the masjid configures.
  - **A cut-off confirmed from outside usually never gets its answer, and that is the action WORKING.** Switching the
    tunnel off or removing it takes down the connection the request came through, so Cloudflare answers with its own
    error page instead of the dashboard's reply. The panel used to toast that as a raw parse error, with the dialog
    still armed to do it again; now a failure with no tRPC error code there means done — *"Done — this window can't
    reach the dashboard any more. Someone at the masjid can turn it back on."* (`settings.cfCutOffDone`) — and the
    dialog is disarmed. (Switching managing-from-outside off is not treated so: it closes the open sockets, not the
    request that asked, and that request gets its answer.)
  - **Turning two-step sign-in off says the same from outside** (`TwoFactorPanel`): its dialog gets wording for
    someone outside — it shuts this window out at once, and changing phones is *Use a different phone* instead, which
    keeps them signed in — and the same cost line, *"Only someone at the masjid can turn it back on."*
- **Settings → Remote access CHECKS EVERYTHING, THEN WRITES ONCE** (`cloudflare.save`). The apps' address and the
  tunnel token share one Save. It works out the final address, checks the token (below), and only then writes the
  token and ONE `updateCloudflare` — so a refused save changes nothing (`test/remote-settings.test.ts`). (dev.16's
  version also validated a dashboard address, and its first cut wrote the apps' address before refusing the dashboard
  one, so a save that said "refused" had already changed something; three reviewers found it separately.) The apps'
  address MAY be changed from outside: Cloudflare, not this setting, decides which hostname reaches the box, so a
  typo breaks *Open* and the apps' public links until it is put right from the same window — it never cuts off the
  dashboard.
  - **The tunnel token is the masjid's.** From outside (`ctx.handedOver`: the front door's hand-over, never a header —
    *"FROM OUTSIDE" IS THE HAND-OVER* below), saving one recreates the cloudflared container — from
    outside, the very connection the request came through — and a token for another tunnel, a stale one or half of
    one connects nowhere useful while the platform logged *"Cloudflare tunnel is running."* (it no longer does —
    below): the remote dashboard and every shared app stay offline until someone at the masjid fixes it. So from
    outside only the token already in use is accepted (`isCurrentTunnelToken` — re-pasting it changes nothing) and
    any other is FORBIDDEN (*"Replace
    the tunnel token at the masjid — if the new one didn't work, this window and every shared app would go offline
    until someone there fixed it."*); the field is disabled from outside, with a hint. Everywhere, a paste that is not
    a whole token is refused before anything is written (`system/cloudflared.ts` `normalizeTunnelToken`: base64 of a
    JSON `{a, t, s}`, `t` a UUID), and Cloudflare's whole install command — `… --token X`, `--token=X`,
    `service install X`, which is what its page shows — is reduced to the token inside it. That check is of the
    SHAPE only: a whole token for a different tunnel is still accepted at the masjid, where a mistake can be seen and
    put right on the spot. **A token pasted without its `=` padding is REPAIRED, and only the canonical form is
    stored** (`isTunnelToken`: a whole number of four-character blocks that re-encodes to exactly itself).
    cloudflared reads the token with Go's padded base64, which refuses a final block without its padding or with too
    much; Node's decoder accepts both, so a token cloudflared then refused used to be saved as it was — and a
    double-click selects letters and digits only, i.e. all of a token except its padding. The padding is fixed by the
    length, so it is put back (a length of 4n+1 cannot be base64 and is refused); from outside, the token in use
    re-pasted without its padding is the same token and changes nothing. And **Settings no longer calls a tunnel stuck
    restarting "running"** (`cloudflaredRunning` → `tunnelContainerUp`: `Running && !Restarting`): Docker reports a
    container in its restart loop — which is what a refused token produces — as Running too, so the panel showed
    *"Tunnel is running."* over a remote dashboard and shared apps that were all offline. A tunnel switched on but
    not up now says *"Tunnel is turned on but isn't connecting. Check that the tunnel token is the right one."*
    (`settings.cfNotConnecting`); it fell through to *"Tunnel is set up but turned off."*,
    over a switch that was on (the red dot was already right). And `ensureCloudflared` logs *"Cloudflare tunnel
    started."*, not *"…is running."*: starting the container is all it knows, and a refused token got that line too.
    `test/remote-settings.test.ts` (*A TOKEN WHOSE "=" PADDING WAS LEFT BEHIND IS REPAIRED*, and *a tunnel stuck
    restarting on a refused token is not shown as running*, which pins the "isn't connecting" wording as well).
  - The UI sends the apps' address only when it was edited: sending whatever the field held put back the value from
    when the page loaded, undoing a change made on another device (and every shared app's public links with it).
    After a successful save the field refills from what the server stored, as it normalised it. After a refused one
    only the panel's status refreshes: the field is filled from the server once, when the panel opens, so it keeps
    what was typed, still marked as edited. Every save closes the handed-over
    sockets that no longer qualify (`sweepHandedOverSockets`).
- **EVERYTHING works remotely once two-step sign-in is set up — at the masjid's request** (v0.51.2-dev.16). The
  first cut served the dashboard and nothing else: files, terminals and backup/restore were kept LAN-only on purpose
  (`LAN_ONLY_FEATURES`, now deleted), and so — by accident — were core and app updates and the logo upload, because
  every one of them is an `/api` route on the dashboard listener. And **no app opened at all**: Open built
  `http://<hostname>:<app port>`, a port the tunnel does not carry. Now:
  - the front door **hands** every permitted remote dashboard request (HTTP and WebSocket) to the dashboard listener as
    its own event (`server.server.emit('request' | 'upgrade', …)`), so the remote dashboard IS the LAN dashboard —
    same routes, limits and checks, no second copy (§15);
  - **Open, from outside, never builds a URL** (`ui/src/lib/app-url.ts` `appOpenUrl` returns null there). It asks
    `apps.openRemote` for a one-use, 60-second ticket bound to the remote session and the app, and sends a new tab —
    opened blank first, while the click is still a click (pop-up blockers), with its `opener` cut — to
    `https://<apps' hostname>/_omos/open?t=<ticket>`, which spends it, gives that browser the app's access token and
    sends it on to `/<its path>/` (`ui/src/lib/apps.ts`, `system/app-access.ts`, §15). An app NOT shared online opens
    this way too, for the admin alone; to anyone else its path is the same 404 as an empty address, and it still has
    no public URL;
  - from outside, an app's own favicon (the fallback when it has no catalogue icon) is loaded only for a SHARED app,
    from the apps' hostname (`appBaseUrl`) — anything else there is served only to a browser holding that app's token;
  - the safety property is two rules together: the session rule in §9 (from the tunnel, only a session that passed
    the second factor, and is still under that factor, counts) and the key rule in §15 (the dashboard shares an origin
    with the apps, and no app page can ever obtain the dashboard key).
  Honest limits: an app must be **base-path aware** to work under its path (every OpenMasjid app is; a
  community/custom app may not be) — OpenWA's own screen is not, so its **Open** button is disabled from outside and
  says so; Cloudflare's free plan refuses request bodies over **100 MB**, so a larger restore or File Explorer upload
  must be done at the masjid — both say so before sending anything (`ui/src/lib/files.ts` `REMOTE_UPLOAD_LIMIT`) and
  read Cloudflare's own 413 page as the same thing; a backup download from outside answers at once but sends nothing
  until every app's data is copied, and Cloudflare can drop a connection that stays silent for about 100 s, so on a
  very large install it can still fail (§15); a restore from outside goes ahead only if the backup keeps the way back
  in, and the restore dialog warns about that, and the 100 MB limit, before the upload (§15); an update or a change of
  update channel from outside goes ahead only to a version that can itself be managed from outside, so going back to
  Stable is refused there until Stable has remote administration (§13.4); `/api/health` stays refused over the
  tunnel, so the update and restore dialogs watch `/trpc/auth.me` — which reports `version` to a signed-in session
  and `appOrigin` to a remote one — to see the core come back; Cloudflare also closes a WebSocket that carries
  nothing either way for about 100 s, so the platform pings the dashboard's own sockets (§15) but not an app's — an
  app that keeps a socket quiet for that long needs a heartbeat of its own; the apps share ONE origin with each
  other and with the dashboard on the apps' hostname (§15); and Safari before 16.4 sends no `Sec-Fetch-Dest`, so it
  is never given the key with the page and signs in again after every reload from outside (§15).
- **"FROM OUTSIDE" IS THE HAND-OVER, NOT A HEADER — for everything the dashboard DOES differently there.** `auth.me`'s
  `remote` and `appOrigin` (and its answer, without the key, of "signed out"), the key in the dashboard's page
  (`registerRemoteDashboardPages`), `apps.openRemote` (which refuses anything else), `cloudflare.save`'s from-outside refusal,
  `system.setUpdateChannel`'s version check, and the `remote` flags of the core update (`api/update.ts`) and the
  restore (`api/restore.ts`), both `wasHandedOver(req.raw)`, all read the mark the front door sets on what it hands
  over (`ctx.handedOver`, §15), never `isViaTunnel`. A reverse proxy the masjid runs on its own network — nginx,
  Caddy, Tailscale Serve — sends `X-Forwarded-Proto: https`, so `viaTunnel` is true behind it, and answering
  "remote" there sent every Open button down the from-outside path, where it was refused: at the masjid, every app.
  The SECURITY rules keep `viaTunnel` — the second factor at sign-in, the per-IP lockout, marking a session remote,
  the first-run refusals, the session rule — because each of them only ever demands more of a request, and a proxy
  at the masjid paying that is a cost, not a hole (§15, *"LAN-only" means…*). A session made through such a proxy
  is where the two meet: it is `remote` (it passed the second factor) but never `handedOver`, so it works through
  the proxy and never from outside (§9). `test/remote-apps.test.ts` (*A REVERSE PROXY ON THE MASJID'S OWN NETWORK IS
  NOT "OUTSIDE"*) and `test/remote-settings.test.ts` pin it.
- **NO BOX NEEDS A VISIT TO THE MASJID TO MOVE TO ONE ADDRESS** (Development only; Stable never had remote
  administration). A box managed remotely on dev.13–dev.15 had its dashboard at the root of the apps' hostname, where
  dev.17 puts it again; its sessions have no `remote` flag and the remote dashboard reads only `__Host-omos_session`,
  so the admin signs in once more — password and code — at the same address. A box on dev.16 had it on a second
  hostname; that hostname goes on being served while Cloudflare routes it (nothing looks at the hostname), its
  sessions work there, the admin signs in once at the apps' address (the cookie is per hostname), and the stored
  `adminHost` is simply no longer read. (dev.16 itself needed that visit: it moved the dashboard OFF the apps'
  hostname, and the new address could only be entered at the masjid.)
- **A SPENT SIGN-IN MUST SEND THE ADMIN BACK, NOT SIT ON A BUTTON THAT CANNOT WORK** (v0.51.2-dev.14).
  `completeLogin` threw one sentence — *"That sign-in attempt has expired. Please start again."* — for all four
  `claimChallenge` refusals. Five wrong codes destroyed the challenge, so every press afterwards said "expired" seconds
  after starting, which the admin knew was untrue, while the primary button stayed **Sign in**: an action that could
  never again succeed. They pressed it repeatedly, because that is what the screen invited. It reached a masjid.
  Now: a dead challenge is a **returned** `restart: true` rather than a thrown error, so the UI takes them back to the
  password step carrying the reason; a wrong code says **how many tries are left**, so the wall at five is visible
  before it arrives; and `noteFailedAttempt` no longer deletes at the cap — it used to, which made
  `claimChallenge`'s `too-many-attempts` branch dead code and is why the message was wrong in the first place.
  "Too many tries" is told apart because reaching it required holding a real challenge, i.e. the password; the other
  three stay merged on the original reasoning that there is nothing useful to learn from the difference.
- **A DRIFTED SERVER CLOCK AND A MISTYPED CODE ARE INDISTINGUISHABLE TO THE PERSON TYPING**, and have opposite fixes.
  `clockSkewSteps` searches a far wider window than `verifyTotp` accepts and reports the offset; **the code is still
  refused** — nothing may call it to decide whether someone gets in. Without it an admin whose box drifted watches
  five correct codes be rejected with no reason to suspect the one thing that explains it. It discloses nothing: the
  HTTP `Date` header already states this server's clock to anyone who asks.
- **What the masjid sees when it is off must not change**, including the refusal record. `system/tunnel-refusals.ts`
  is what an admin reads when a public page 404s, and a gate that refused dashboard paths silently would have taken it
  away for exactly the addresses people mistype.

### 13.4 Update channel (Stable / Development)
- **ONE global setting** (`updateChannel: 'main' | 'dev'`, default `'main'`) governs the OS, the App Store catalogue **and every installed app together**. Never a mix; no per-app override in v1. `system/channel.ts` is the single place that turns a channel into concrete targets:

  | | Stable (`main`) | Development (`dev`) |
  |---|---|---|
  | Catalogue | `OpenMasjidAPPS/main/catalog.json` | `OpenMasjidAPPS/dev/catalog.json` |
  | Core image | `:latest` | `:dev` |
  | This repo's branch (VERSION, CHANGELOG) | `master` | `dev` |

- **The channel word is NOT the branch name for this repo** — `osBranch()` maps `'main'` → `master` (see the Branching policy above). Never interpolate the channel into an OpenMasjidOS raw URL.
- **The platform updates by image tag, not by git.** `docker/update.ts` inspects its own container and rewrites only the *tag*, so a masjid on a private mirror keeps their registry — and a **digest-pinned** reference is left alone, because the operator pinned it deliberately.
  - **So a core pinned to a digest is not "updated" onto itself** (v0.51.2-dev.16). When the core's compose line names a digest (`composeImageRef()` contains `@`), `runUpdateInner` refuses before anything is downloaded — after the up-to-date and from-outside checks — with *"OpenMasjidOS is pinned to one exact build on this machine, so it can't update itself from here. Nothing was changed."* (4001). Before, every press pulled that same build and restarted the dashboard onto it, for nothing, while the banner went on offering the update. **Residual:** `checkForUpdate` is unchanged, so the banner and the `core-update` alert still offer an update to a digest-pinned core; pressing it now explains rather than restarts. `test/remote-update.test.ts` (*A CORE PINNED TO ONE EXACT BUILD IS NOT "UPDATED" ONTO THAT SAME BUILD, AGAIN AND AGAIN*).
- **Switching goes through `system.setUpdateChannel`, never `settings.update`.** The order is the safety property: read the TARGET catalogue first (`requireCatalog`, which throws), and only persist once it's proven readable. An unreachable or malformed dev catalogue therefore leaves the masjid exactly where it was rather than pointing at a channel whose apps it can't resolve. Both caches are keyed by channel *and* cleared on switch, so a switch can never serve the other channel's entries.
- **Apps don't move on their own.** After a switch, `appsPendingChannel()` lists catalogue apps still on the old channel and the UI offers "Update all" plus per-app update, reusing the existing update stream. Recreating every container the instant a toggle flips would take a masjid's displays down unannounced. `AppMeta.channel` records where each app came from; `undefined` is grandfathered as `'main'` so upgrading doesn't mark every existing app pending.
- **Development is VERSIONED, and therefore uses the same update path as Stable — there is no Development-specific update logic, and nothing should reintroduce any.** A dev build's version is a semver **prerelease**: this repo's `dev/VERSION` holds `0.50.0-dev.1`, and a dev catalogue entry holds e.g. `0.11.0-dev.1` and pins that **exact immutable image tag** (never `:dev`). So `checkForUpdate` / `checkCatalogUpdate` just compare versions on both channels, the update alert fires on both, and `reason` is only `'version' | 'channel'`.
  - **Ordering is the point:** `0.49.3 < 0.50.0-dev.1 < 0.50.0-dev.2 < 0.50.0`. A prerelease sorts above the last release and below the one it precedes, which is exactly what a dev build is. `util/version.ts` implements real semver precedence — prerelease identifiers compare **numerically** (`-dev.10 > -dev.9`; a text compare silently stops offering updates at the tenth dev build) and a release outranks its own prereleases (the old dotted-numeric compare read `0.50.0-dev.4` as `[0,50,0,4]` and so called it *newer* than `0.50.0`). `packages/ui/src/lib/version.ts` is a deliberate copy — keep the two in step.
  - **An update pulls the exact version on BOTH channels, never the channel alias.** `coreTargetTag()` returns the version (`:0.50.2`, `:0.50.2-dev.1`) and falls back to the alias only when there is no version to aim at — which, since `runUpdate` stops on its own channel when the version cannot be read (*"Couldn't check for the latest version just now, so nothing was changed."* — it used to say "already up to date", which nobody knew), means a channel move made at the masjid while the target's version cannot be read (offline). A moving alias can point at different bytes than the version just announced, and every failure that produces is **silent**: you pull, you recreate, you are still on the old build, and the check offers the same update forever. The exact tag either gets that build or fails loudly ("it may still be building"). Stable was exempted from this once, on the claim that `:latest` and `:X.Y.Z` were "equivalent by construction" — **that was false and cost a release to learn**: `:latest` was published by both the master-branch build and the release-tag build, so on v0.50.1 it held `5eaf997` while `:0.50.1` held `23696bb`, and `:0.50.0` had already been silently republished by a README-only commit pushed straight to master. Don't re-exempt either channel.
  - **This is why `dev/VERSION` must be bumped to publish a dev build** — the bump *is* the publish, and CI tags the image from `VERSION` (`type=raw`), which is what makes the tag pullable. Pushing to dev without bumping republishes the same tag; that's tolerable only because no box was told to move to it.
  - **What this replaced, and must not come back:** dev entries used to repeat the stable version and point at `:dev`, so nothing observable changed when a build was published. Everything built to compensate — `usesMovingTags()`, `movingTag`, `reason: 'dev-refresh'`, `certain`, a `CatalogApp.imageDigests` map, `docker/image-ref.ts`'s digest comparison, a suppressed update banner, a manual "check for a new Development build" action — was a second update axis faking a version axis, and all of it is deleted. If Development ever seems to need its own detection mechanism again, the actual bug is a dev build without a distinct version.
- **dev → main is a DOWNGRADE, not a symmetrical toggle.** Dev may be ahead in ways that don't reverse: images and schemas need not be backward compatible. Both directions are confirmed, and the downgrade dialog says plainly that data written by a Development version may misbehave and that a pre-switch backup is the remedy. **No automatic data migration is attempted** — pretending to migrate would be worse than saying we can't. From outside the masjid it is refused outright for as long as Stable cannot be managed from outside (next bullet).
- **From outside, the dashboard never moves the box to a version that cannot be managed from outside**
  (v0.51.2-dev.16). `FIRST_REMOTE_ADMIN_VERSION` (`system/remote-admin.ts`, `'0.51.2-dev.16'`) is the first build
  with everything managing from outside needs (the hand-over, remote sessions, *Open*; dev.16 itself served the
  dashboard on a second hostname, but no update from dev.17 can land on it — updates only go forward, and Stable is
  older), and `managesFromOutside(version)` is a semver `>=` against it.
  Both of the dashboard's paths that move the OS ask it — for a request the front door handed over, and nothing
  else (§13.2e, *"FROM OUTSIDE" IS THE HAND-OVER*); a root terminal opened from outside can still do anything, this
  included:
  - **the core update**: `runUpdate(onLine, { remote })`, with `remote` = `wasHandedOver(req.raw)` in
    `api/update.ts`. After the checks that find nothing to do and before anything is pulled, a target it could not
    read (`checkForUpdate().latest` null — by then only a channel move's, since on its own channel an unreadable
    version has already stopped the update) is refused — *"Couldn't check which version this would install, so it
    can't be done from outside right now."* — and so is one below that build — *"Version X can't be managed from
    outside the masjid, so installing it from here would cut you off."* — each ending *"Nothing was changed."*
    Unknown is refused rather than guessed because nobody out there could put a wrong guess right.
  - **the channel switch**: `system.setUpdateChannel` with `ctx.handedOver` reads the TARGET channel's published
    VERSION before anything else (`system/system.ts` `publishedVersion`, the read `checkForUpdate` makes):
    unreadable is SERVICE_UNAVAILABLE, below that build is FORBIDDEN, and both say nothing was changed. Refusing the
    switch itself, not just the OS step at its end, is the point: refusing only that step would leave the apps on
    one channel and the platform on the other, the mixed state this section exists to prevent.
  Without it, going back to Stable from outside — whose releases so far, up to 0.51.1, have no remote dashboard at
  all — and letting the dashboard move the OS across would cut off every window from outside until someone at the
  masjid moved the box on again. At the masjid both go ahead as before, and once Stable reaches that build the
  switch is allowed from outside too. `test/remote-update.test.ts`.
- **The update window is told how the update ended, and says "updated" only on EVIDENCE** — by the close code of
  its progress socket (`api/update.ts` `UPDATE_CLOSE`, from `runUpdate`'s `UpdateOutcome`). **4001** `unchanged`:
  already up to date, a version that could not be read, a download that failed, an updater that could not start (the
  compose file is put back first, §15), a refusal from outside, a core pinned to a digest (above), a restore or an
  app's update in the way (§15, *one at a time*), an error — and the window says *"Nothing was changed. The messages above say why."* at once
  (`update.unchanged`), unlocked, with a Close button. Any 4000–4999 close lands there, and the 4401/4403 refusals at
  the door send their reason as a line first, so there are messages above. A stream that never connected began
  nothing — `LogStream` reports whether the socket ever opened — and says *"Couldn't connect to OpenMasjidOS, so
  nothing was changed. Please try again."* **1000** `restarting` means the core is expected to be replaced: by this
  update's helper, or by the one already running when the same update was asked for twice (*"An update is already
  running. It will finish on its own."*). The window waits for that, as it does for a stream that merely drops,
  watching `/trpc/auth.me` (§13.2e), and `UpdateModal` says it updated only when a new version answers, or when it
  saw the core go down and come back (and cannot see the version). It counts the core as down only after TWO failed
  checks in a row, a good answer resetting the count: one blip — a 502, the Wi-Fi — read as the restart kept the
  dialog locked for three minutes and could claim a restart that never happened. With no sign of a restart after
  ~30 s it says so, unlocked, and goes on watching (*"OpenMasjidOS hasn't restarted yet. If nothing changes in a
  minute or two, reload this page to see which version is running."*); after ~3 min it ends there. When the core
  comes back on the SAME version it watches ~30 s more (15 checks), in case another restart is still to come, and
  then ends, unlocked, on *"OpenMasjidOS restarted, but it is still on v{{version}}. Reload this page, then try the
  update again."* — it used to hold the dialog shut for the rest of the three minutes first. It used to read every
  ending as a restart and, after three locked minutes, announce "Update applied." over an update that had changed
  nothing, was still downloading, or had failed. `test/remote-update.test.ts` reads `UpdateModal.tsx` to keep the
  two copies of the codes in step, and pins the two-failure rule (*the update window is told whether anything
  changed — and waits only for a restart*).
- **An app's update says how it ended too** (`apps/manager.ts` `updateCatalogApp` → `AppUpdateOutcome`;
  `api/app-update.ts` `APP_UPDATE_CLOSE`): **1000** updated; **4001** nothing was changed — already current, held
  back by the risk gate, put back after a download or a start that failed, or refused by the update lock; **4003**
  updated, but the new version is not staying up; **4002** stopped part-way (an error). A refusal before it starts
  says why as a line and closes 4401/4403, an impossible app id 4400. One React-free map turns a close into an ending
  for every window that streams an app update (`ui/src/lib/update-endings.ts`, held to the server's codes by
  `test/remote-update.test.ts`): `AppUpdate` says *"{{name}} is up to date now."* for 1000 only, *"We lost touch with
  this update…"* for a drop part-way (it may still be finishing), and that nothing was changed for a stream that
  never connected. It used to close with no code, and the window called the app up to date whatever had happened.
  *Update all apps* and the channel switch count what really happened: *"All N apps updated."* only when every one
  did, otherwise *"U of N apps updated. The messages above say what happened to the others."* (`UpdateAllApps`,
  §13.5); `ChannelMigrate` says how many apps really moved, and reads its OS step's close — any 4xxx, or a stream that
  never connected, is *"OpenMasjidOS itself was not changed — the messages above say why."*
- Only **catalogue** apps track a channel. Community and custom apps come from a URL or a pasted compose the admin owns, so the OS has no other version to offer and must not claim they're pending.
- Legacy: `updateChannel` shipped in ≤0.48.x as `'stable' | 'beta'` — declared but never read. `coerceChannel` migrates `stable`→`main`, `beta`→`dev`, and anything unrecognised → `main`, because the safe answer to "I can't tell which channel you wanted" is the tested one. This **must** run after the spread in `withDefaults`, or the persisted legacy word wins and the catalogue URL 404s.
- CI must build **both** branches (`branches: [master, dev]`) and publish **both** a channel alias and the version. `type=ref,event=branch` gives `:dev`; `type=raw,value=<VERSION file>` gives `:0.50.2-dev.1`, the tag the Development channel actually pulls — without it Development can detect an update it cannot install.
  - **Every published tag must have exactly ONE writer.** Two runs building the same commit do not produce the same bytes, so any tag written by two triggers silently drifts. Both halves of this rule were learned the hard way: the raw version tag is **scoped to the dev branch** (enabled for every branch, a master push republished `:0.50.0` over what the `v0.50.0` tag had published — and a README-only commit pushed straight to master did exactly that), and `:latest` is enabled **only on a non-prerelease `v*` tag** (`is_default_branch` reads like "master pushes only" but is *also* true on a tag push, so `:latest` was written twice per release and ended up holding the branch build rather than the release build). Excluding prereleases stops a `v*-dev.*` tag from dragging every Stable box onto a Development build.
  - A release is therefore: push `master`, then push the `v*` tag. If the tag is forgotten, `:latest` stays put and the update fails **visibly** on a missing version tag — which is why `coreTargetTag` pulls the exact version rather than trusting the alias.

### 13.3 Advanced
- **Allow custom apps** (off by default) → enables the "3rd Party App" button in the App Store (see §11), with a clear risk note.
- **Enable app shells** (off by default) → adds an "Open shell" option to each app (a browser terminal into that app's container, via the Docker API with a TTY).
- **Enable root terminal** (off by default) → a root shell into the OpenMasjidOS core itself, launched from Advanced. Clearly marked as powerful.
- **Network info:** the machine's address on the masjid's network (`desiredAddress()`), read-only. Not the core's own interfaces or hostname: inside the bridge-networked container those are its 172.x address and its id, which is what this showed until v0.51.2-dev.18. **There is nowhere to change
  it from** — the installer has no network step (§8.1) and mDNS is unimplemented, so a masjid
  wanting a fixed address adds a DHCP reservation on their router. Do not link this to a
  "Reconfigure network" entry; it does not exist.
- **"Check for updates" + one-click live update** for the core: the dashboard pulls the new image and recreates the core itself (via a detached helper container), streaming progress to a live log window and reconnecting when it's back — no terminal needed. The window is told how the update ended, so one that changed nothing says so at once, and it calls the update done only once it has seen the core restart (§13.4). Installed apps are never touched (golden rule), and an update never runs alongside a restore or an app's update, nor while a backup is being made — nor in the minutes before the core it handed over is actually replaced (§15).
- **Backup / Restore:** download a tarball of platform config + app volumes, and restore from one. While a restore runs no setting or account detail can be changed from the dashboard and no app can be started, installed or removed (§15 says what that does not cover); the window says how it ended, and a restore that left apps without their data, not started, or not paused first is named again on the dashboard after the next sign-in (§15).
- Everything above also works from outside once remote administration is on, behind the second factor — the
  terminals behind the same off-by-default switches — within the limits §13.2e lists (an upload over 100 MB, a
  restore or a file, has to be done at the masjid) and with three differences: a backup download starts answering
  before the backup is made, a restore goes ahead only if the backup keeps the way back in (both §15), and an update
  goes ahead only to a version that can itself be managed from outside (§13.4).

---

### 13.5 Settings is SECTIONED, and a section must never be orphaned

Settings outgrew a single scrolling page — eleven stacked panels, ~3,000 lines, with the
WhatsApp panel alone about a third of it. Since v0.51.2-dev.18 each panel is its own file in
`routes/settings/` (moved verbatim); `routes/Settings.tsx` is the shell — the section table,
the nav, the gates, the Advanced pane (its state is the shell's) and the dialogs. `SECTIONS` in `routes/Settings.tsx` is now the
one list of panes (Appearance, Account, Email, WhatsApp, Alerts, Payments, Remote access,
Advanced), each addressable as `/settings/<id>` via a `:section` route, so anything in the
product can link straight to the setting it means instead of dropping someone at the top
of the page. Only the chosen pane is mounted, which also stops the panes nobody is looking
at from running their polling queries.

- **The new failure mode is an ORPHANED section, and nothing else would catch it.** A pane
  can be listed in the nav while nothing renders under its `show('<id>')` gate: `tsc` sees
  a used component, the build is clean, the tests pass, and a masjid simply cannot find
  their Stripe keys any more. `test/settings-nav.test.ts` reads the source and fails if any
  section id has no `show()`, if a nav label is missing (the nav would render the raw key),
  or if any of the thirteen panels stops being rendered anywhere. It is mutation-checked —
  orphaning a section really does fail it.
- **Adding a section is three things or none:** an entry in `SECTIONS`, a `show('<id>')`
  gate, and a `settings.nav.<id>` string. The test enforces all three in both directions,
  so a removed section cannot leave a dead label behind either.
- **Dialogs render OUTSIDE the panes.** Several are opened from one section and must
  survive navigating away — the restore upload especially, which would abandon a file
  mid-flight if a nav click unmounted it.
- **Nav labels are written out, not built as `settings.nav.${id}`.** A key assembled at
  runtime cannot be checked against `en.json`, and `i18n-keys.test.ts` caps dynamic keys at
  two precisely because a missing key ships as the raw key on screen — which it once did,
  in the WhatsApp panel. Satisfy that guard rather than raising its bound.
- **WhatsApp carries its own Setup / Groups / Commands strip**, local state rather than the
  URL: they are three views of one connection, and `/settings/whatsapp` is already the link
  anything outside the panel wants. The strip appears only once a phone is linked, because
  Groups and Commands error before that — three tabs where two fail is worse than none.
- **"Update all apps" reuses the per-app stream, one app at a time** (`UpdateAllApps`,
  offered on the dashboard when more than one **version** update is waiting). Same
  reasoning as `ChannelMigrate`: `/api/apps/update` already re-runs the compose risk gate,
  preserves the volumes and `.env`, and **verifies the container stayed up** rather than
  trusting `compose up` exiting 0 — a bulk endpoint would be a second implementation of all
  of it, and the startup check is exactly what you would not notice was missing. Sequential
  because simultaneous recreation takes the display, the donations page and the kiosk down
  together. Channel moves are excluded: they are the update channel's job (Settings →
  Advanced), which also brings the OS across, and doing half of that here leaves the
  mixed-channel state §13.4 exists to prevent. It counts the apps that really updated, by
  each stream's close code (`lib/update-endings.ts`, §13.4): *"All N apps updated."* only
  when every one did, otherwise how many, with a warning — it used to say "all" over a run
  in which one had been refused or put back.

## 14. Design system & theming (this is a priority — make it feel premium)

### Identity
Calm, dignified, and modern. Inspired by Islamic geometric art (girih/arabesque tessellations) and the architecture of masjids (domes, arches/mihrab, minarets, the crescent). It should feel respectful and serene, never gaudy. The *level of polish* should match umbrelOS; the *visual language* is masjid, not generic.

### Color tokens (Tailwind v4 `@theme` + CSS custom properties in `tokens.css`)
> The emerald-on-charcoal palette this section described for a long time was never built. What
> shipped is a **cyan-on-deep-navy** scheme, and a contributor copying the old hexes produced
> colours that appear nowhere in the product. `packages/ui/src/styles/tokens.css` is the source
> of truth; the values below are transcribed from it.

- **Dark (DEFAULT):** deep navy base (`--color-surface: #030D1A`), raised surfaces a step lighter
  (`#0A1828`, `#0F2040`), **cyan** primary (`--color-primary: #22D3EE`, hover `#67E8F9`), warm
  **amber** accent (`--color-accent`/`--color-gold: #F59E0B`, used sparingly). Ink is near-white
  with a cool cast (`--color-ink: #F4F7FB`).
- **Light:** a pale ground with the same amber accent and a deeper blue primary
  (`--color-primary: #0284C7`, buttons `--color-btn: #0369A1`), because the bright cyan cannot
  carry white text at AA on a light background.
- **The accent is user-chosen** (§13.1) and `applyAccent` overwrites `--color-primary`,
  `--color-btn` and `--color-on-primary` inline on the root element, which beats the
  `[data-theme="light"]` block. So never assume the stylesheet's value is the live one.
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
- Hash passwords with argon2id. Sessions in HTTP-only, SameSite cookies, `Secure` where §9 says (the remote dashboard's always; the LAN one deliberately not by default). Never log secrets.
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
- **The gate runs on every path that introduces or refreshes a compose** (v0.45.0): install (catalog/community/custom), **update** (`updateCatalogApp` — previously the one path that skipped it), and a restore — `reviewEveryApp` the moment `apps/` is in place, and `reupAllApps` again before it starts anything (next bullet). A refreshed catalog entry is fresh external data; never write + `up` one unchecked.
  - **`startApp` is gated by a PERSISTED REVIEW VERDICT, and the two earlier versions of this bullet were both wrong** (v0.51.2-dev.1). It runs `docker compose up` on whatever `apps/<id>/compose.yml` is on disk. Until v0.51.0 this claimed "EVERY path that starts a compose", which was false. It then claimed the gap was contained because "every *write* vector into that file is closed: install/update/restore all pass the gate" — **and that was false too.** `system/restore.ts` `rmSync`s `apps/` and `renameSync`s the archive's tree straight into place with **no gate on the write**; the gate ran only afterwards in `reupAllApps`, which correctly declined to auto-start a dangerous stack, printed `(not started — needs review: …)` into the restore stream, and **then discarded the verdict** — `AppMeta` had nowhere to put it. So once the restore window closed, an app carrying a smuggled `privileged: true` was an ordinary Stopped card with a Start button, and the core runs as root with the Docker socket, so pressing it was **host root with no warning at the moment of the click**. The same ungated entry was reachable from `!os start` over WhatsApp and from the exposure toggle. A false containment argument is worse than a documented gap: it is precisely what stops anyone re-examining it.
    Now: `reviewCompose()` records the verdict on `AppMeta.review` (`{kind, reasons[], at}`) and **clears it** when a compose passes, so a legitimate update or a fixed file is the way out rather than a dead end. **A restore records that verdict the moment `apps/` is in place** (v0.51.2-dev.16: `reviewEveryApp()`, straight after `config/` and `apps/` are moved into place and before any volume is refilled; `reupAllApps` reviews again at the end): until then the restored `meta.json` carried the BACKUP's verdict — none at all, for a compose smuggled in beside it — so anything that started the app while its data was being put back started it unvetted, from WhatsApp too. Starts are refused for the whole restore as well (`assertAppFree`, the update-lock bullet below), but the review does not rely on that (`test/remote-restore.test.ts`, *A RESTORED APP'S COMPOSE IS CHECKED THE MOMENT IT IS IN PLACE*). **Refusals are never acknowledgeable** — the original advice stands, and `kind` is a stored field rather than something inferred from the text so the UI can tell a `danger` (offer the tickbox) from a `refusal` (explain, offer no confirm at all) from `unreadable` (say plainly that nothing was checked). **WhatsApp deliberately cannot acknowledge**: possession of a phone must not be enough to consent to a root-capable compose, so `!os start` reports the hold and points at the dashboard. Honest residual: an app restored by a build **older than this one** carries no marker and stays grandfathered startable; it gains one the next time a restore runs.
    Four things here are load-bearing and were each wrong in the first cut — an adversarial review of the fix found them, which is the only reason they are listed rather than shipped:
      - **The gate must read the compose BEFORE it touches `meta.json`, and never depend on it.** `reviewCompose` opened with `loadMeta(id); if (!meta) return null`, so a single unparseable byte in `meta.json` — which arrives in the *same* backup as the compose — produced "no finding" and `reupAllApps` then **auto-started** the unvetted stack. That is strictly worse than the hole being closed. `startBlockedReason` fails closed on the same input (present-but-unparseable ⇒ held; absent ⇒ not installed, the caller's own error path).
      - **The COMPUTED verdict always wins over the persisted one.** Skipping the write when only the reason *text* matched let a pre-seeded `kind: 'danger'` survive a genuine refusal, turning a never-acknowledgeable finding into a tickbox. `sameReview` compares kind and every reason.
      - **`restartApp` is guarded too.** `docker compose restart` starts a *stopped* container, so "restart" is a start path; guarding only `startApp` left `!os restart` as a way round `!os start` from the very phone denied consent. `stopApp` is deliberately **not** guarded. So the choke point is two functions, not one — don't write it as "everything goes through `startApp`", which is the same false-containment shape as the bullet above.
      - **Every finding is persisted, not just the first.** "I understand the risk" over one of five dangers is consent the admin did not give.
      - **A record that exists but will not parse is never recovered over** (v0.51.2-dev.18). The listing (`buildInstalled`) treated such an app, when Docker reported its project, as an orphan and wrote a fresh record with no review over it — so a backup pairing a broken `meta.json` with a privileged compose, for an app already on the box, became an ordinary Start button within one listing. Its row is held as `unreadable` now, exactly what `startBlockedReason` answers, and the file is left alone.
- **`checkCompose` returns `dangers` AND `refusals`** (v0.45.0). `refusals` are NEVER acknowledgeable — no "I understand the risk" path, on any router. Currently: a top-level volume that uses `external:` (short or long form) or `name:` to attach to an `omos-*` volume, i.e. another app's data or platform infra. Neither form names a host path, so `bindSource`/`checkHostPath` return early and saw nothing. Keep `refusals` refused everywhere; keep the non-`omos-` external/renamed case an ordinary `danger`.
- **Every listener that serves `/api/fabric` must carry `registerFabricTunnelGuard`** (v0.45.0) — the TLS dashboard server as well as the HTTP front door. `test/fabric-lan-only.test.ts` pins this structurally.
- **Every path comparison against a request URL matches the DECODED path, not the raw text** (v0.46.0). The router dispatches on the percent-decoded path, so a guard that compared `req.url` verbatim was walked past with `/api/%66abric/app/…` — raw text that doesn't start with `/api/fabric` but still reached the app-to-app broker. `matchesSecretRoute` and `isFabricSubpath` now test the raw **and** `decodedPath()` spellings and fail closed; `decodedPath` resolves escape-by-escape so one malformed `%zz` can't throw the comparison away. `isViaTunnel` likewise compares the first `x-forwarded-proto` hop trimmed + lowercased (`"HTTPS"`, `"https,http"`, and a duplicated header all count). Never reintroduce a raw-string `startsWith` on a URL in a security check. **And a request target is not always a path** (v0.51.2-dev.15): HTTP also allows `GET http://host/path` and `GET *`, find-my-way routes the absolute form by its path, and every guard here read its first segment as `http:` — the front-door gate, the Fabric guard and the CSRF check all said "not mine". `registerOriginFormGuard` refuses anything not starting with `/`, as the FIRST hook on both listeners — and a refused **upgrade** is closed (`hijack` + `destroy`), never answered: on the dashboard listener `@fastify/websocket` only destroys the socket from its own hook, which a reply from an earlier one skips, so the first version's 400 left every refused upgrade's socket open for good. Not reachable through Cloudflare (which always sends a path), so this closed a spelling rather than a door — closed because every guard assumes one.
- **A backup must never report success it can't back** (v0.45.0). `backupStream()` returns `{ stream, done }`; a volume that fails to archive fails the whole backup (its partial file is deleted), the outer tar's exit code flows through `done`, and a failure destroys the stream. `runBackup` requires `upload.ok && archive.ok` **before** recording success and **before** `pruneOld` — pruning on an unverified result is how repeated silent failures evict every good archive. One backup at a time (`BackupBusyError` → 409); manual download and scheduler share one staging path. Restore stops apps before refilling volumes, reports per-volume failures, and names any app Docker would not stop (*A restore says HOW it ended*, below). In `tarVolume`, a staging **write** failure is tracked separately from the container's exit code (`writeFailed`, v0.46.0) — the two are independent, and folding it in with `code ??= -1` silently reported success whenever `docker run` had already exited 0 (i.e. ENOSPC on the final flush, the likeliest real failure). **Known-open, and NOT covered by `ok`:** volumes are tarred live, and a torn SQLite/WAL capture still exits tar 0 — so `ok: true` is not proof the databases inside will open. That fix is app-side (`VACUUM INTO` snapshots in each app); don't add a platform-side check that only looks like it covers it. The archive is also unencrypted (`rclone crypt` is the real fix).
  - **App volumes are picked by NAME, never by compose's label** (`appVolumeNames`: `omos-*`, the platform's own `omos-cloudflared*` excluded; v0.51.2-dev.18). A volume a restore created carried no label, so every backup after that restore left that app's data out while reporting success. A restore now creates each volume with compose's project and volume labels too (`composeVolumeLabels`), so compose adopts it as its own.
  - **A restore SWAPS each volume's data in; it never unpacks over what is there** (`VOLUME_REFILL`, run with `sh` in the helper container). The archive is unpacked into a fresh folder inside the volume and swapped in only once tar has succeeded, with the volume root's owner and mode carried over. Unpacked over the old data, a newer SQLite `-wal` stayed beside the restored database and was replayed onto it, and a failure part-way left old and new mixed; now a failed refill leaves the volume exactly as it was. The cost is room for one volume's old and new data at once.
  - **A restore that would fill the disk is refused before anything is stopped**, measured twice: the upload's unpacked size against `min(MAX_UNCOMPRESSED_BYTES (8 GiB), 90% of the free space)` — the gzip-bomb ceiling is for the upload itself — and then, after the staging copy, the app data's unpacked size against 90% of the free space left. The 8 GiB ceiling must NOT be applied to the app data: the first cut did, and every install whose app data unpacked past it could not be restored, with hundreds of GB free.
  - **The off-site run ends the backup when rclone stops** (`backup-upload.ts`): rclone giving up (a wrong password, a NAS gone) left tar blocked on a full pipe, and the one-backup-at-a-time flag it clears on exit set for good — every later backup and restore refused until a restart. A run refused because another is running is not recorded as a failure (the next tick tries again), and whatever a failed run left on the destination is removed, not only after an upload that reported success.
  - **A core update waits for a backup being made** (`docker/update.ts` `backupInTheWay`, asked before the download and again after it): the backup runs in the core it would replace, and an off-site one cut off leaves part of an archive on the destination. And `removeBackupLeftovers()` runs at boot beside `removeRestoreLeftovers()`, so the staging copy of a backup cut off by a restart (every app's data, unencrypted) does not stay on disk.
  - The outer archive is `tar -cf - -I 'gzip -1' …` (still read with `-xzf`): the volume archives inside are gzipped already, so the default level only spent minutes of a Pi's CPU. Volume archives run with `--log-driver none`, because the archive goes to stdout, which Docker otherwise also wrote into the helper container's log.
  - **A download ends only once tar has SAID it succeeded** (`api/backup-download.ts` `sendBackup`, used by the download on the masjid's network and from outside alike). tar's output ends BEFORE tar exits, so a response ended with the output — by a pipe, or by Fastify's `reply.send(stream)` — was delivered whole and clean for a backup tar had FAILED: a file it could not read left out, an archive cut short. The browser said done, the log said "Backup failed", and the admin found out at the restore. Now the bytes go as they come, the response ends only when the output has finished AND `done.ok`, and anything else breaks the download off (`res.destroy()`), which a browser reports as failed. The LAN route hijacks its reply to do it (with `cache-control: private, no-store`) rather than `reply.send(stream)`. `test/remote-backup.test.ts` (*A BACKUP TAR FAILED IS NEVER DELIVERED AS A WHOLE FILE*).
  - **Whether a backup holds anything to restore is decided BEFORE a single app is stopped** (`system/restore.ts`, with `stagedVolumeArchives` the ONE list of volume archives for the check and for the work, so the two cannot disagree about what a backup holds). It used to be found out afterwards, so a backup with nothing usable in it (an "app data only" folder built by hand, say) stopped every app and left them stopped — a container stopped this way does not even come back after a reboot — while saying only that there had been nothing to restore (on dev.15 the window then announced *"Restore complete."*). Now it says *"That backup had nothing to restore. Nothing has been changed."* and stops nothing (`test/remote-restore.test.ts`, *A BACKUP WITH NOTHING TO RESTORE STOPS NO APP*).
  - **NOTHING IS CHANGED FROM THE DASHBOARD WHILE A RESTORE RUNS — looking is fine** (v0.51.2-dev.16; `trpc/trpc.ts` `noChangesDuringRestore`, so `protectedProcedure = t.procedure.use(isAuthed).use(noChangesDuringRestore)`). While `isUpdating('restore')` every protected MUTATION is a CONFLICT — *"A backup is being restored right now. Please try this again once it has finished."*, and during the hold after the hand-off (the update-lock bullet below) *"OpenMasjidOS is restarting to finish restoring your backup. Please try again in a minute or two. Nothing was changed."* (`finishingMessage`); queries still answer, and signing in and out are public procedures, untouched. Two mutations change nothing a restore replaces and go ahead (`ALLOWED_DURING_RESTORE`): `apps.stop` — turning an app off must always work, and it is what a restore does to every app anyway — and `apps.openRemote`, which only mints a one-use ticket in memory. The logo routes (`api/branding.ts`, outside tRPC, writing `config/branding/`) refuse the same way — 409, the same words — after their origin, session and key checks. Why: a restore replaces `config/` whole, so a change made during one was accepted and then silently undone — a review changed the password and switched remote administration off mid-restore, and after the restart the old password worked again and remote administration was back ON. Starting, installing and removing apps are refused too (`assertAppFree`, below). The rule is asked once, as a call arrives: a change already under way when a restore begins is not stopped by it (two-step sign-in asks again after the password, §9). **Residual:** the File Explorer's own writes — uploading, renaming and deleting the masjid's files — are NOT refused during a restore; `config/` and the platform's per-app files are out of its reach anyway (the File Explorer bullet below). `test/remote-restore.test.ts` (*NOTHING IS CHANGED FROM THE DASHBOARD WHILE A RESTORE RUNS*).
  - **…and the restored settings are the ones this process uses from the moment they are in place.** After the swap, when `config/` was moved, `system/restore.ts` calls `reloadSettings`, `reloadEmailConfig`, `reloadStripeConfig`, `reloadWhatsAppConfig` and `reloadCommandConfig`. Each of those stores read its file once at boot and kept the copy, so any write after the swap — a monitor's or a scheduled job's as well as an admin's — put the PRE-restore settings back over the restored file: a review restored a backup with the root terminal off, changed the theme while it ran, and the root terminal came back ON. The admin store re-reads by itself (§9) and the second factor has its own hold and renewal (below). Only those five are reloaded: the WhatsApp queue and link-health records (`whatsapp-queue.json`, `whatsapp-health.json`) are runtime state held in memory, and their next write is this process's copy. A new store that caches a `config/` file needs a reload here, or it reopens this. `test/remote-restore.test.ts` (*A RESTORE PUTS ITS SETTINGS IN PLACE AT ONCE*).
  - **The monitors stand aside while a restore runs.** The app-offline monitor's tick (`system/alert-monitor.ts`) returns at once while `isUpdating('restore')`, and `stopAllApps` also `suppressOfflineAlert`s each app it pauses: the restore pauses every app on purpose, and the alert (*"<Name> has stopped"*, its action note *"Then press Start."*) told the admin to start an app over data still being put back. The off-site backup scheduler (`system/backup-upload.ts`) skips its tick while a restore OR a core update runs — one would copy data being refilled, the other would be cut off when the core is replaced — and the next tick runs it. So does the address monitor (`system/address-monitor.ts`) while a restore runs: it rewrites apps' settings, which would land in a tree about to be swapped out. An app that does not come back is named by the restore itself (the window and the report, below), not by an alert: once the core has restarted, the monitor's first check only records what it sees. `test/remote-restore.test.ts` (*NEITHER THE OFFLINE ALERTS NOR THE OFF-SITE BACKUP RUN WHILE A RESTORE DOES*).
  - **A restore that does not happen leaves no backup behind.** The uploaded `.restore.tar.gz` is every password hash, key and token on a box — possibly another box's — unencrypted, in the data folder. When a restore is refused because OTHER work is in the way (`UpdateBusyError` with `clash`), or during the last restore's own hold (`finishing('restore')` — that one removed its own file on the way out, so anything at the path is the refused request's), `runRestore` removes it — but not while another restore is still RUNNING, which is reading it. The upload route refuses first, 409, before the file is read or saved (the browser may still send it — the refusal is about what the server keeps, not the bytes on the wire): *"A restore is already running. Please wait for it to finish."* while one runs, the finishing message during its hold, and the clash message while an update is in the way (`clashFor('restore')`). And at boot, once the data dir exists, `removeRestoreLeftovers()` (`index.ts` `main`) deletes a `.restore.tar.gz` and a `.restore-staging` left by a restore that never reached its `finally` — a power cut, a crash — logging *"Removed <name> left behind by a restore that did not finish."* While either exists the File Explorer keeps it private (its bullet below). **And a backup and a restore never overlap**: `backupStream` refuses while a restore runs (`backupRefusal` — the download from outside asks before its headers go, so the answer is still a 409), and a restore refuses while a backup is being made (`BACKUP_RUNNING`: the upload route, and `restoreOnce` first thing), because a backup taken mid-restore copied data half put back and reported success. `test/remote-restore.test.ts` (*A BACKUP AND A RESTORE NEVER OVERLAP*). `test/remote-restore.test.ts` (*A RESTORE REFUSED FOR AN UPDATE IN ITS WAY SAYS SO, AND LEAVES NO BACKUP BEHIND*, *WHAT AN UNFINISHED RESTORE LEFT BEHIND IS REMOVED AT BOOT*).
  - **A restore brings the core back on the build it is RUNNING — whatever the compose file says** (`docker/update.ts` `recreateCore` with no tag → `pinComposeToRunningBuild`). The compose file is not a reliable record of that: an update whose helper could not start had already pointed it at the target, and the installer's Update wrote it before downloading. So before the helper runs, the running container's image, by ID, is tagged `<the compose file's repo>:<running VERSION>` (`docker tag`) and the compose line is pointed at that tag (`alignComposeImage(VERSION)`); the helper itself runs from that image by ID (failing that, the reference the compose file names; the channel alias only as a last resort, when there is neither). Nothing is pinned when the compose line or the running reference is a digest (the operator's choice) or the container cannot be inspected (no Docker API: local development). It used to aim at the channel's alias (`:latest`, `:dev`) WITHOUT pulling it — a dashboard update pulls the exact version (§13.4), so the alias named whatever build the installer had last fetched, usually an older one — and a restore quietly put the box back on it — which, done from outside, would have meant a build with no remote dashboard, locking the admin out of the very address the restore had promised to keep. Both ways the file went wrong are closed as well: an update whose helper cannot be started puts the compose file back as it was, so *"Nothing was changed."* stays true, and the installer's Update downloads before it writes (§8.1). The dashboard update still passes the exact version it pulled. It is §13.4's lesson again: a moving alias is not a target, and nor is a file that may be stale (`test/remote-update.test.ts`, *A RESTORE COMES BACK ON THE BUILD THAT IS RUNNING*; `test/remote-restore.test.ts`, *… and the core comes back on the build it is running*).
- **The Cloudflare tunnel exposes app paths on the apps' hostname, and — only when the admin switches it on — the dashboard, at the root of that same hostname.** The **secret-gated Fabric routes** (`/api/fabric/*`, `/api/auth/session`) stay LAN-only unconditionally, and so do `/api/health` and `/api/ready`. This bullet opened with "the tunnel exposes ONLY app paths" until v0.51.2, and that half is now a setting (`system/remote-admin.ts`, §13.2e) rather than an invariant. **The Fabric half did not move and must not**: those routes carry every app’s 256-bit secret and every configured Stripe live key, and `registerFabricTunnelGuard` runs on both listeners regardless of what remote administration is set to. Registered routes skip the front-door `notFoundHandler`, so those routes are blocked over the tunnel by an explicit `onRequest` guard in `index.ts` (`viaTunnel` = `cf-ray` header or `x-forwarded-proto: https`). Never add a new secret route to `front` without that guard; the ONLY intentionally-public-over-tunnel routes are `/api/public/appearance`, `/api/public/logo`, the three root icon aliases `/favicon.ico`, `/apple-touch-icon.png` and `/apple-touch-icon-precomposed.png` (low-sensitivity presentation assets — the icons serve the SAME already-public logo bytes, raster-only so no SVG-script vector, and exist because a phone asks for them at the root of any site it is asked to bookmark), and `/_omos/open` (`system/app-access.ts` `registerAppOpen`, v0.51.2-dev.16), where the remote dashboard's one-use app ticket is spent. That last one is not a presentation asset, and it is safe to publish because it does nothing without a ticket the platform itself minted for a session that passed the second factor: 32 random bytes, spent on first use whether or not it was still valid, dead after 60 s (`TICKET_TTL_MS`), at most 200 outstanding (`MAX_TICKETS`). It refuses with remote administration off (the identical 404) and on the LAN (a plain 404); a spent, expired or unknown ticket gets a friendly 410 page and nothing else; every answer carries the no-store headers and `referrer-policy: no-referrer`, and the refusal record never keeps the query string the ticket travels in. Two residuals are accepted, and must not be written as closed: it does not check that it was asked for on the apps' hostname — any hostname routed to the tunnel would do (minor: the dashboard always builds the link on the apps' hostname) — and because a bad ticket gets the 410 page while the door is open and the ordinary 404 while it is shut, a stranger can tell from this one address whether remote administration is on. What it hands out opens one app and nothing more (the app-opening bullet below), and `_omos` is never routed as an app's path: the ingress routes only the shape an install or Settings gives an app (`apps/paths.ts` `isAppPathShape`, `^[a-z0-9][a-z0-9-]{0,79}$`), because an app is also recovered from any `omos-*` project Docker reports, Docker allows `_` in a project name, and a stack started by hand as `omos-_omos` would otherwise be routed at `/_omos` — ahead of this route, since the ingress hook runs first — where it could receive Open tickets meant for other apps (`test/app-paths.test.ts`, *ONLY THE SHAPE OF AN APP PATH IS EVER ROUTED*). Six routes, not two: count them here whenever one is added, because a registered route skips the front-door `notFoundHandler` and is therefore reachable over the tunnel by construction. (That handler also answers one thing itself rather than refusing it: a service worker's script fetch at a bare one-segment address, an app's or an empty one, gets the self-removing worker — the app-opening bullet below — which carries nothing and is the same everywhere.) Admin logo upload/clear (`/api/branding/logo`) is registered on the dashboard listener `server` only, never `front`, so from outside it is reached only by the remote-administration hand-over (it is in `DASHBOARD_API`). The tunnel is not started in the no-TLS fallback.

  - **ONE ADDRESS: THE KEY IS THE BOUNDARY** (v0.51.2-dev.17). The remote dashboard is served at the root of the apps'
    hostname, so every app page IS its origin — a browser draws the line around "this site's own data" by scheme +
    host + port, NEVER by path — and an app page's script (any app the admin opened, or a cross-site-scripting bug in
    any public app page) can send same-origin requests that carry the admin's cookie and pass the origin check. What
    it must never get is the DASHBOARD KEY (`auth/sessions.ts` `csrf`; `x-omos-csrf`, or `?k=` where a header cannot
    be set), without which `isAuthed` and every raw route's `requestCsrfOk` refuse. dev.13–dev.15 kept the key in
    this origin's `localStorage` (`omos.dashboardKey`), every app page could read it, and an adversarial review showed
    the result: switch the root terminal on and open it — host root, since the core holds the Docker socket — or
    download a backup, which is every secret. dev.16 drew the line with a second hostname for the dashboard; the
    masjid rejected the extra address (§13.2e). So, for a request the front door handed over (`wasHandedOver`):
    - **the remote dashboard never stores the key** — `ui/src/lib/session.ts` keeps it in the tab's memory whenever
      the page carries `<meta name="omos-key">` (only the remote dashboard's pages do), and removes an old stored one;
    - **a reload gets it back from the page itself, and only for a load the BROWSER marks as its own** —
      `api/static-ui.ts` `registerRemoteDashboardPages` serves `index.html` for a handed-over GET/HEAD of a dashboard
      page (`/`, `/index.html`, a `DASHBOARD_SEGMENTS` first segment but `trpc`/`assets`) with the meta's `content` set
      to `sessionKey(token)` ONLY when `Sec-Fetch-Dest: document` AND `Sec-Fetch-Mode: navigate` (headers no script can
      set: a fetch is `empty`, a frame `iframe`/`frame`, an embed `object`/`embed`) AND `requestUser(req)` finds a
      live remote session through an open door; otherwise `content=""`;
    - **nothing can hold that page** — it carries `Cross-Origin-Opener-Policy: same-origin`, `X-Frame-Options: DENY`,
      `Content-Security-Policy: frame-ancestors 'none'` and `Cache-Control: no-store`, and `responseHeadersForTunnel`
      strips COOP from EVERY app response, so an app page never shares a browsing context group with it: a window an
      app opens on the dashboard is cut off the moment the dashboard loads. (Two same-origin pages keep a window only
      when they send the SAME policy — an app allowed to send `same-origin` too would keep its handle and read the key.)
      **These pages are the ONLY dashboard page served from outside**: the SPA fallback (`spaFallback`) never answers a
      handed-over request, which gets a plain 404 instead (v0.51.2-dev.18). It used to serve a plain `index.html` —
      none of the headers above — for any handed-over miss the page hook did not claim: a missing `/assets` file, or a
      raw dot-segment target like `/x/../settings` that the gate resolves to a dashboard page but the hook does not. An
      app page could frame that plain page and get the admin to sign in on it in LAN mode, which stored the key in
      this origin's storage, where every app page on the address can read it. And the dashboard listener's catch-all
      `X-Frame-Options: SAMEORIGIN` is set only when a route has not set its own, so it no longer overwrites `DENY`.
    - **nothing else hands the key, or the admin, out** — `auth.me` never returns the key and, for a handed-over call
      without it, answers as signed out (an app page could otherwise read the admin's name, email and phone with the
      cookie); the File Explorer's inline view, whose address carries `?k=`, is `Referrer-Policy: no-referrer` (an SVG
      opened there could load an image from an app's path and hand it the key in a Referer); and the dashboard's page
      segments are reserved app paths (`apps/paths.ts`, kept in step with `DASHBOARD_SEGMENTS` by
      `test/app-paths.test.ts`), because the ingress takes app paths first.
    Pinned by `test/remote-key.test.ts` (*THE DASHBOARD HANDS ITS KEY BACK ONLY INSIDE ITS OWN PAGE, LOADED BY THE
    BROWSER ITSELF*, *AN APP PAGE ASKING FOR THE DASHBOARD GETS IT WITHOUT THE KEY*, *FROM OUTSIDE, auth.me SAYS WHO IS
    SIGNED IN ONLY TO A CALLER HOLDING THE KEY*, *A FILE VIEWED FROM THE FILE EXPLORER NEVER SENDS ITS ADDRESS ON*,
    *FROM OUTSIDE THE DASHBOARD NEVER STORES THE KEY*) and `test/remote-apps.test.ts` (*AN APP CANNOT PLANT A PLATFORM
    COOKIE, A WORKER OVER THE WHOLE HOSTNAME, OR AN OPENER POLICY*). **A future change must never: store the key where
    a page can read it from outside; put it in any response but that page (no API answer, no redirect, no URL that is
    rendered as a document without `no-referrer`); hand that page to a request the browser did not mark as its own
    top-level load; let an app response carry COOP; or let the dashboard be framed.** Each of those hands host root to
    any app page again. **Accepted residuals, none of which reaches anything needing the key:** an app page can call
    the dashboard's PUBLIC procedures as the admin's browser — `auth.logout`, and failed `auth.login`s that count
    toward the admin's own per-address lockout; it can write the dashboard's display preferences in `localStorage`;
    it can show a fake sign-in at the same address (phishing is easier than across hostnames); the boundary rests on
    browser behaviour (Sec-Fetch metadata, COOP) rather than the origin; Safari before 16.4 sends no `Sec-Fetch-Dest`
    and so signs in again after every reload from outside; and a worker an older build let an app register over `/`
    through `Service-Worker-Allowed` (the bare-address bullet below) now covers the dashboard too, and could read the
    key from its page loads — no new one can be registered. The apps also share ONE origin WITH EACH OTHER on the
    apps' hostname, where on the LAN each has its own port: a malicious app's page can act within another app the
    admin has opened there (its access-token cookie rides any same-origin request to that app's path). Stripping
    `Service-Worker-Allowed` and platform `Set-Cookie`s from app responses, and never serving an app's worker script
    at its bare address — only one that removes itself (below) — keep one app from registering a worker over the
    whole hostname or setting a platform session cookie through its responses; a platform cookie its script writes
    with `document.cookie` never reaches another app either, because of the platform's cookies the ingress passes an
    app only a valid token for that app (`cookieHeaderForApp`).
  - **Remote administration re-checks its preconditions on EVERY request, and that is the property that matters.**
    The four conditions of `remoteAdminEnabled()` (§13.2e) are re-read per request, never captured when the switch
    was flipped. So turning two-step sign-in off closes this door in the same action, without the admin having to know
    the two settings are connected; otherwise the result is a password-only admin dashboard on the public internet
    with nothing on screen saying so. `login` also refuses tunnel traffic outright when no factor is enrolled, as the
    backstop for any path that does not come through here. And a request is not the only unit that matters: every
    protected tRPC call and every raw dashboard route a handed-over request reaches asks `remoteAdminEnabled()` again
    on every use (the long-lived-connection bullet below).
  - **A change to the second factor can reopen the door, so it is guarded like a sign-in.** Two rules, each from a
    review:
    - **`requireSudo` refuses with CONFLICT when the factor changed while the password was being checked.** It
      captures `secondFactorEpoch()` and `twoFactorActive()` before argon2, and if either moved by the end, answers
      *"Two-step sign-in was changed somewhere else a moment ago. Please try again."* rather than building on a state
      nobody proved against. Without it the admin turning two-step sign-in OFF to evict someone could lose the race
      to that someone — holding a remote session and the password — whose own change, begun a moment earlier, then
      found "nothing enrolled", skipped the code, switched emailed codes back on and kept their session under the new
      epoch: the door reopened with them inside, while the admin was told it was shut. A review reproduced it 3 times
      out of 3; `test/twofactor-router.test.ts` (*A CHANGE THAT LANDS WHILE THE PASSWORD IS BEING CHECKED IS
      REFUSED*) pins the refusal. It also refuses — before the password check and again after it — while a restore
      holds the epoch (§9; *NOTHING ABOUT THE SECOND FACTOR CHANGES WHILE A RESTORE HOLDS IT*).
    - **Emailed codes are never the only factor — on the server, not only on the screen** (`setEmailFactor` →
      PRECONDITION_FAILED without an authenticator). As the only factor they are pausable by a password-only session
      on the LAN (a new admin address or mail account pauses them, §9); then nothing is enrolled, the next change to
      the factor needs only the password, and that change could point the codes anywhere. With an authenticator
      always present, switching them back on always takes a current code. The screen had only ever offered them once
      an authenticator existed, but nothing behind it enforced that (*EMAILED CODES ARE NEVER THE ONLY FACTOR*).
  - **What is served over the tunnel is an ALLOW-LIST, not "everything that is not an app".** `isDashboardPath` claims `/`, the first segments in `DASHBOARD_SEGMENTS` (`trpc`, `assets` and the UI's
    own routes: `store`, `apps`, `files`, `settings`, `design-system`), the built UI's root files (`/index.html`,
    `/favicon.svg`, `/ambient.mp4`) and the dashboard's own API routes, `DASHBOARD_API` (`/api/update`,
    `/api/apps/update`, `/api/files`, `/api/terminal`, `/api/backup`, `/api/restore`, `/api/branding/logo`), and
    nothing else — in particular not the Fabric, `/api/auth/session`, health or readiness, and a near miss like
    `/api/backups` is not `/api/backup`. The sockets have their own, narrower list (`DASHBOARD_SOCKETS`, below). Two
    reasons: the published surface is what was decided rather than whatever happens to be registered, and every other
    address goes on being refused, so `system/tunnel-refusals.ts` stays the diagnostic it was instead of every mistyped
    app path silently showing a donor the admin sign-in page. **A new dashboard route is unreachable from outside
    until it is added here, and that is the failure to prefer.** `test/remote-admin.test.ts` reads `Root.tsx` and
    fails if a UI route is added that the list does not cover. Since the dashboard shares the apps' hostname, every
    segment in `DASHBOARD_SEGMENTS` is also a reserved app path (`apps/paths.ts` `RESERVED_PATH_SEGMENTS`, kept in
    step by `test/app-paths.test.ts`), because the ingress takes app paths first and an app at `/settings` would have
    taken the dashboard's Settings page on every reload.
  - **The gate and the server ask DIFFERENT questions, and one predicate answering both was a bypass** (v0.51.2-dev.15).
    Serving the SPA needs `isDashboardPath`: EVERY spelling must agree. Deciding whether the gate even LOOKS at a
    request needs `touchesDashboardPath`: ANY spelling is enough. With `every` in the gate, `/%74rpc/auth.me` (raw
    first segment `%74rpc`) was "not a dashboard path", passed straight through, and the router — which matches the
    DECODED path — handed it to tRPC: the whole dashboard API over the tunnel with remote administration switched
    OFF, proved against the real daemon. It is v0.46.0's `/api/%66abric` lesson with the direction reversed, so
    before reusing a spelling-aware predicate, check which way it fails: an ALLOW must need every spelling, a GATE
    must trigger on any. Claiming a WebSocket for the dashboard is an allow, and was written with `some` — see the
    sockets bullet below for what that cost.
  - **A REGISTERED ROUTE SKIPS THE NOT-FOUND HANDLER, and that is how this feature broke the LAN on its first cut.**
    The front door's `notFoundHandler` was what 308-redirected plain-HTTP LAN traffic to the HTTPS dashboard. The moment
    `@fastify/static` was registered on that listener, `GET /` matched a real route, skipped the handler, and served
    the dashboard over unencrypted HTTP on the masjid's own network. The gate now redirects LAN traffic itself rather
    than falling through. **The unit tests did not catch it** — the front door they build to exercise the gate had no
    static route, so the fall-through still reached the handler there; a smoke test against the real daemon found it.
    Any test that mirrors this listener must register a route at `/`, or it is not testing the thing that breaks. The
    same property is why `/_omos/open` answers every case itself — the LAN, remote administration off — rather than
    counting on the not-found handler to.
  - **THE FRONT DOOR SERVES NO DASHBOARD OF ITS OWN — it decides, and HANDS OVER** (v0.51.2-dev.16). A permitted
    remote request (`frontDoorDecision` → `serve`) is marked (`markHandedOver`), `reply.hijack()`ed and emitted, body
    unread, as a `request` event on the dashboard listener; a dashboard socket is claimed, marked, tracked
    (`trackHandedOverSocket`) and emitted the same way as an `upgrade` event. The first cut registered tRPC and the
    static UI on the front door instead — a second copy of the dashboard, and only part of one (everything under `/api`
    stayed behind, which is why a remote update or logo upload failed), and every route registered there skips the
    not-found handler. `test/remote-admin.test.ts` fails if `fastifyTRPCPlugin`/static files reappear on `front`. The
    dashboard listener's own guards (request target, hand-over, Fabric, origin) run on handed-over requests, which
    still carry Cloudflare's headers, so the session rule applies. Pass nothing else this way: `pass` (not a dashboard
    path) stays with the front door's own routes.
    - **The mark is the one signal nobody can type.** `wasHandedOver` (a `WeakSet` of Node requests that only the gate
      adds to) says "the remote-administration gate let this in"; headers only say "this came through Cloudflare",
      which a LAN client can claim. The mark is what makes the dashboard listener read `__Host-omos_session` instead of
      `omos_session`, honour only a session the remote dashboard made (`Session.handedOver`, §9; a sign-in it hands
      over is marked so), re-check the door, count an anonymous body (the body-limit bullet below), add
      `CDN-Cache-Control` / `Cloudflare-CDN-Cache-Control: no-store` to every response it sends (Cloudflare's edge
      caches by address alone, and a File Explorer download can end in `.pdf`), start a backup download before the
      backup is made, and answer "from outside" for everything the dashboard does differently there — Open, the
      Remote access refusals, the restore's safety rule, the version check on an update or a channel switch (§13.2e
      says why a header cannot stand in for it).
    - **`registerHandoffOnlyGuard` makes the gate unavoidable.** It is the second hook on the dashboard listener,
      straight after the request-target guard and before any plugin, and it refuses any request carrying `cf-ray` that
      the front door did not hand over — the identical 404, and an upgrade is closed rather than answered. The tunnel
      is meant to land on port 80; one wrong field in Cloudflare pointing it at 443 would otherwise have the dashboard
      answer the internet directly, switch off and the key rule's page never served — "off by default" would be a sentence in
      Settings rather than a fact. `cf-ray` because Cloudflare sets it at its edge and no LAN browser or masjid reverse
      proxy sends it; a bare `x-forwarded-proto: https` is still answered (*THE DASHBOARD LISTENER ANSWERS CLOUDFLARE
      ONLY THROUGH THE GATE*). The refusal is recorded as `wrong-port`, not `lan-only-route`, and "Recently turned
      away" names the fix — set that hostname to Type HTTP and URL `localhost:80` — because the cause is a Cloudflare
      setting, and "Local network only" would send the admin looking in the wrong place.
  - **A STRANGER MAY SEND A SIGN-IN AND A CODE, AND NOTHING LARGER** (v0.51.2-dev.16). The dashboard listener accepts
    25 MB bodies, because a signed-in admin uploads wallpapers and pastes compose files; handing the internet's requests
    to it unread made that reachable by anybody, and a handful of concurrent 25 MB posts is a memory-exhaustion attack
    on a Raspberry Pi running as root — taking every public app page down with it. So a handed-over request with no
    live remote session (`hasRemoteSession`) may carry at most `ANONYMOUS_BODY_LIMIT` (64 KB): a declared larger — or
    non-numeric — `Content-Length` is refused 413 at the front door before a byte is read (`anonymousBodyRefusal`), and
    a body that declares nothing (chunked, which a tunnel may use even for a browser's fixed-size request) is counted
    as it arrives and stopped at 413 by the `preParsing` hook of `registerDashboardRequestLimits` (`limitAnonymousBody`)
    — refusing undeclared bodies outright would refuse real sign-ins. The same function makes every `/trpc` request
    other than GET, HEAD and OPTIONS carry `application/json` or get 415, for everyone: tRPC's adapter also takes
    multipart bodies and reads them with NO size limit, and nothing in the dashboard uses that path. (The front door's
    own 1 MB default never applies to remote dashboard traffic: it is handed over unread.) A multipart upload from a
    stranger is refused 401 there before any route reads it (v0.51.2-dev.18).
    - **One request carries at most 40 calls** (`maxBatchSize` on the tRPC adapter, `index.ts`; the dashboard's
      client splits at 20, `maxItems` in `ui/src/lib/trpcClient.ts`, and `test/remote-admin.test.ts` keeps the two in
      step). Unbounded, a single batched request carried hundreds of sign-in attempts past every per-request check and
      queued that many argon2 runs. The per-address lockout is asked again when each attempt's turn comes inside the
      serialized verify, and a failure is counted before the next attempt is let in, so a batch that slips past the
      check on arrival still stops at the threshold; a correct password no longer clears the address's failures —
      only a correct second factor does (`completeLogin`), or anyone holding the password could alternate and guess
      codes without limit.
  - **The dashboard's own sockets are the ONLY non-app upgrades allowed through, and the allowance must stay narrow.**
    `attachIngress`'s `upgrade` handler destroys every socket that is not an app path, deliberately: an abandoned
    upgrade gets no response and no close, so it holds a file descriptor until the peer gives up — an unauthenticated
    resource lever against a daemon running as root with the Docker socket. `claimUpgrade` takes exactly the sockets in
    `DASHBOARD_SOCKETS` (`/trpc`, `/api/update`, `/api/apps/update`, `/api/restore/run`, `/api/terminal/*`), when
    `claimsDashboardSocket` says so — and that asks `frontDoorDecision`, the very function the HTTP gate calls, so a
    socket the gate would redirect or refuse (with the door shut, say) is destroyed rather than answered on a
    connection nothing will close. **EVERY spelling of the URL must be a dashboard socket**, because claiming is an
    allow. It was `some`, and a review found the cost: a dot-segment spelling of nothing (`/x/../trpc`) was claimed and
    answered by the dashboard while a private app's socket was destroyed on the spot, so the difference told a
    stranger which apps were installed. Hence also: a declined app socket (a private app without its token) is offered
    to the claim and then destroyed exactly like an address with nothing at it, never on the spot. Widening any of this to "is anything registered here" would abandon sockets nothing answers.
    - **And only to a signed-in REMOTE session** — one the remote dashboard itself made (`claimsDashboardSocket` ends
      on `hasRemoteSession`, i.e. `isRemoteSession`, §9); a stranger's socket is destroyed exactly like an address
      with nothing at it. Every one of these sockets is useless without a session, and handing over anyone's let a
      stranger hold any number of them open and push frames the dashboard had to buffer and parse — the attack the
      64 KB body limit (above) exists to stop, through the one door it did not cover. It is why the dashboard's tRPC
      socket is **lazy** (`ui/src/lib/trpcClient.ts`, `lazy: { enabled: true, closeMs: 10_000 }`): it opens only
      while something is subscribed, so the sign-in page holds none and the first one opens after signing in, when it
      qualifies — an eager socket, opened before signing in, could only have been refused.
    - **Every dashboard WebSocket message is capped at 1 MiB** (`DASHBOARD_WS_MAX_PAYLOAD`, the dashboard listener's
      `maxPayload`, for every socket on it, LAN ones included). The dashboard only ever sends small frames —
      subscription messages, a terminal's keystrokes and pastes — and uploads go over HTTP; at the library's default,
      100 MB, any socket could make the daemon buffer, stringify and parse that much per message.
    - **Every dashboard WebSocket is pinged every 30 s** (`DASHBOARD_WS_HEARTBEAT_MS`, `startDashboardHeartbeat` on
      the dashboard listener's WebSocket server, LAN sockets included — it costs them nothing). Cloudflare closes a
      WebSocket that carries nothing either way for about 100 s, and nothing else speaks on these while the admin is
      reading: a remote terminal at a prompt or in an editor printed "[Session closed]" in any pause, leaving whatever
      ran inside where nobody could get back to it, and an update's progress window could drop during a long
      download. A browser answers a ping by itself. An app's own sockets are not pinged — their bytes only pass
      through the relay (§13.2e's honest limits). `test/front-door-websocket.test.ts` (*A QUIET DASHBOARD SOCKET IS
      PINGED*).
    - **At most 200 are tracked at once, and at most 150 of them an app's** (`MAX_TRACKED_SOCKETS`,
      `MAX_APP_SOCKETS`, `system/remote-sockets.ts`; the app sockets below). Each belongs to a signed-in remote
      session or carries one of its app tokens, so the admin never comes near the bound, but the table is filled from
      the internet and so gets one; a socket refused for it is destroyed rather than answered, and the refusal is
      logged at most once a minute. The app share is capped so the dashboard's own always have room: an app's page
      opens a socket with the admin's token whenever it likes, and a hostile or merely leaky one (a reconnect loop
      that never closes the old socket) filled all 200 — after which every terminal, update and restore from outside
      failed to start, on every device. `test/front-door-websocket.test.ts` (*AN APP CANNOT TAKE THE LAST PLACES*).
  - **A HANDED-OVER CONNECTION IS RE-CHECKED FOR AS LONG AS IT LIVES** (v0.51.2-dev.16). The gate decides once per
    request, which is enough for HTTP and not for a WebSocket — the dashboard's live data, an update's progress, a root
    terminal — which is one request that lasts for hours. A review found all of them outliving the very actions an
    admin takes to shut a door: a live terminal went on taking keystrokes after remote administration was switched
    off, two-step sign-in was turned off, the admin signed out or the password changed, and a live tRPC socket could
    switch remote administration straight back on. Three layers now: `trpc.ts` `isAuthed` re-checks
    `remoteAdminEnabled()` AND `isRemoteSession(ctx.sessionToken)` on EVERY protected call of a handed-over
    context; `api/ws-auth.ts` `requestUser` re-checks the door on every use, and a terminal asks it (with its Advanced
    switch) before every keystroke; and `system/remote-sockets.ts` records each handed-over socket with its remote
    session and closes those that no longer qualify — on a sweep every 5 s (`SWEEP_MS`), and at once
    (`sweepHandedOverSockets`) from sign-out, a password change, every change to the second factor, remote
    administration switched off, the tunnel switched on or off or cleared, and every save of the Remote access
    addresses. Every dashboard socket handed over carries a remote session now (the bullet above). A sweep reads the
    door, and the second-factor epoch for the dashboard's sockets, ONCE per pass (`isRemoteSessionAt`): it used to
    read them for every socket, a file read per open socket every five seconds on the daemon's only thread. (An app
    socket's check, `appAccessUser`, still reads the epoch for itself.) **An app's socket opened through the tunnel
    WITH the admin's access token is tracked the same way** (`trackAppSocket`, from the ingress's upgrade path) and
    closed by the same sweep when that sign-in ends — sign-out, a new password, a changed second factor, the door
    shutting. The dashboard's sockets closed on every one of those while the app's stayed open, and a review found a
    private app still answering a socket opened before the admin signed out. **Both ends close**: the sweep destroys
    the browser's socket, and `system/socket-relay.ts` `closeTogether` destroys the connection to the app with it. With
    pipes alone it did not — a destroyed socket emits `close` but never `end`, so the app was never told, and the core
    held its connection open until the app noticed by itself, which an idle socket may never do; a review found that
    too. The app sees the connection drop (no close frame — 1006 to a WebSocket library). `closeTogether` is the ONE
    relay lifetime for the ingress and the per-app HTTPS proxy (`system/app-proxy.ts`) alike: either side's `error`
    or `close` destroys the other, except that after a polite end the browser's side is left to finish what is still
    on its way to it. Both proxies' HTTP paths have the same rule (`proxyHttp`, and `app-proxy.ts`'s handler): a
    browser that leaves part-way — a live event stream, a long poll, a big download, Cloudflare dropping the
    connection — destroys the request to the app, where `pipe()` had only paused the app's response and the core held
    that connection until the app gave up (`test/remote-apps.test.ts`, *A BROWSER THAT LEAVES PART-WAY ENDS THE APP'S
    RESPONSE TOO*). But a long-lived HTTP response is NOT tracked like a socket: one opened with the admin's access
    token — a Server-Sent Events stream, say — goes on after that sign-in ends, an accepted residual. A socket opened
    with no token is the public's, and nothing here ends it. Closing a progress socket never stops the work: an update
    or a restore runs to the end (the one-update-at-a-time bullet below).
  - **The ingress is the ONLY upgrade owner on the front door: `@fastify/websocket` must never be registered there.**
    It was, in dev.13–14, to carry the dashboard socket — and it routes EVERY upgrade through Fastify, so each app's
    socket was piped to the app by the ingress AND proxied as plain HTTP by the ingress's onRequest hook. The client
    got an HTTP response inside its WebSocket stream, and every app's live socket over the tunnel died. A claimed
    dashboard socket is now handed to the dashboard listener's own `@fastify/websocket` as an `upgrade` event.
    `test/front-door-websocket.test.ts` drives real sockets through the real ingress, with Docker stubbed to answer the
    way a reachable daemon does — the first version only passed because the machines running it had no Docker, and on
    CI a late rebuild wiped its routes. Every test has a timeout and its front door is closed after it whatever
    happens, so a regression fails the suite rather than hanging it. `test/remote-admin.test.ts` pins the wiring.
  - **Files, terminals and backup/restore ARE exposed now — behind a session that passed the second factor, and the
    key** (v0.51.2-dev.16, at the masjid's request; `LAN_ONLY_FEATURES` is gone). They were kept off on
    purpose, and the reasons have not changed: the File Explorer browses the directory holding the password hash, the
    Stripe keys and the TLS private key; terminals are a root shell; a backup is every secret, unencrypted. What makes
    exposing them defensible is two rules together, and the first draft had only one: the session rule (§9) — from the
    internet they take the password AND the current second factor, where on the LAN they take the password — and the
    key rule above (*ONE ADDRESS*), without which any app page could have driven them with the admin's own cookie. The terminals
    keep their off-by-default Advanced switches and the File Explorer its protected paths (`protectedReason`) — both
    apply remotely. Never relax the session rule on the assumption that "the dashboard already checked": it is the only
    thing standing between these routes and a password-only cookie lifted from any app on the LAN.
    - **A backup download from outside starts answering before the backup is made** (`api/backup-download.ts`
      `remoteBackupDownload` → `sendBackupEarly`, chosen in `index.ts` for a handed-over request). Making one copies
      every app's data first; on the LAN that wait is invisible, but Cloudflare gives an origin 100 s to start answering
      and then shows its own error page, so on any box whose data took longer every remote download failed. The
      headers go first; "already running" is still a proper 409 (`backupInProgress`), because it is known before
      anything is sent; a failure after that breaks the download off (`res.destroy()`) rather than letting the browser
      save a partial file the admin would trust. (The silent wait that is left is an honest limit, §13.2e.)
    - **A browser that leaves must END the backup, at whatever point it leaves.** Leaving was noticed only once the
      backup existed, by a listener attached then — but the `close` had already fired during the minutes spent copying
      app data, and it fires once. The backup was piped into a dead response: the pipe paused for ever, tar blocked on
      a full pipe and never exited, and the one-backup-at-a-time flag it clears on exit stayed set — so every later
      backup, the nightly off-site one included, was refused as "already running" until a restart, with a copy of
      every app's data left on disk. Cancelling a download stuck at 0 bytes was enough, and so was Cloudflare dropping
      a silent connection. Now the `close` listener goes on BEFORE the backup starts (`sendBackupEarly`), a backup that
      finishes after the browser has gone is destroyed at once, and the rest goes through `sendBackup` — the tar-success
      rule above — which ends tar the moment the browser leaves, and ending tar is what clears the flag
      (`test/remote-backup.test.ts`, with the real backup and real tar).
    - **A restore from outside is refused unless the backup keeps the way back in** (`system/restore.ts`
      `remoteRestoreProblem`, run when the front door handed the restore over — `wasHandedOver`, not a header,
      §13.2e — once the archive is unpacked and validated, before anything is stopped or replaced). A restore replaces
      `config/` whole, and from outside a backup taken before remote administration was set up — most of them, the
      feature being new — would turn the door off behind the admin, with only someone in the building able to open it
      again. So from outside it goes ahead only if: the backup's settings pass `settingsOpenTheDoor` — **the live box's
      own rule, not a copy of it**: a hand-written copy here missed a condition dev.16 had ("the dashboard address
      equals the apps' address"), and a restore it waved through shut the remote dashboard behind the admin (the
      backup's apps' address need not match: nothing looks at the hostname, and the tunnel is the same one); the
      same tunnel token (`tunnelTokenMatches`); a username and the same password hash (`isConfigured` needs both, so a
      backup with no username restores a box nobody can sign in to); and the same authenticator secret
      (`sameSecondFactorAs`), which needs an authenticator on BOTH sides — an emailed-only configuration is refused,
      because whether a restored emailed factor would deliver depends on the restored address and mail account, and
      nobody can repair a wrong guess from outside. Otherwise nothing is changed and the admin is told to restore it at
      the masjid. Only the authenticator is compared: the backup's backup codes come back with it, whatever was done to
      them since, so an admin who replaced them because someone saw them should replace them again after restoring an
      older backup. A backup with no `config/` is never refused here, and a restore at the masjid is unchanged.
      First-run restore and `auth.setup` refuse tunnel traffic outright (§13.2e).
    - **A restore HOLDS the second-factor epoch while it runs, and RENEWS it once a backup's `config/` is in place**
      (`holdSecondFactorEpoch`, taken beside `holdForRestore` once the apps are stopped, just before `config/` is
      replaced, and released in the same `finally`, owned like that hold; `renewSecondFactorEpoch` straight after the
      rename). The restored `twofactor.json` can carry an older epoch — any change to the factor since the backup, new
      backup codes say — and a remote session counts only under the epoch it proved, so the admin restoring from
      outside was signed out MID-restore, the sweep closed their progress window, and every line after it was lost. A
      sign-in completed during the hold is bound to the held epoch, and only the restoring admin's own session is
      moved onto the renewed one (`rebindRemoteSession`, before either hold is released), and only if it still counts
      at that moment (`remoteGrantOf`) — §9 says why each. Nothing about the factor can be CHANGED for the whole
      restore, the hold and the minutes before it alike: every two-step mutation is refused with a CONFLICT
      (`refuseDuringRestore`: `secondFactorHeld() || isUpdating('restore')`, §9), because before the swap the backup's
      settings would overwrite the change, and during the hold it counted for nothing until the release and signed out
      from outside the very admin who made it. Signing in goes on working.
    - **A restore says HOW it ended** (`RestoreOutcome`, carried as the WebSocket close code by `api/restore.ts`
      `RESTORE_CLOSE`: 1000 `restarting`, 4003 `restarting-with-problems`, 4001 `unchanged`, 4002 `not-restarted`,
      4004 `restored-not-restarted`). The window used to assume every ending was a restart, so a REFUSED restore — the
      usual result from outside, and every "busy", "too large" or "nothing in it" — sat on *"Restarting OpenMasjidOS —
      reconnecting…"* for four minutes and then announced *"Restore complete."* Now `RestoreModal` says "Nothing was
      changed" for 4001 and every other 4xxx but 4002–4004, and *"Couldn't connect to OpenMasjidOS, so nothing was
      changed."* for a stream that never opened; for 4002 that it stopped before it could finish (*"…reload to see
      where things stand."*) — **4002 is a restore that stopped on an ERROR, read cautiously**: `api/restore.ts`
      starts from `'not-restarted'`, so an unexpected exception closes 4002 even when it came before anything was
      changed, because nobody can vouch for what an exception interrupted (an accepted residual: such a restore is
      told to look rather than told nothing changed) — and for **4004**, everything put back but the helper that
      restarts the core could not be started, *"Your backup was restored, but OpenMasjidOS couldn't restart itself to
      finish. Restarting the machine finishes it — or someone at the masjid can run the install command again and
      choose Repair."* (told apart from 4002 because the advice is the opposite: restoring again would stop every app
      again for nothing). Otherwise it waits for the restart (watching `/trpc/auth.me`, since `/api/health` is refused
      from outside), saying after about 30 s that it has not restarted yet while it goes on waiting, and counting the
      core as down only after TWO failed checks in a row (a good answer resets the count) — one blip read as the
      restart said *"Restore complete."* while the old core was still about to be replaced. And it says it is
      complete only when it HEARD how the restore ended (1000, or 4003): a stream that DROPPED first — any other close,
      a sleeping laptop, the Wi-Fi — ends, once a restart is seen, on *"OpenMasjidOS has restarted, but this window
      couldn't see how the restore ended. Please reload, sign in again and check that your apps and settings look
      right."* (`restore.lost`), because a restart proves only that the core restarted; it used to
      say *"Restore complete."* The refusals made before a restore starts (4401 signed out, 4403 a bad origin or a
      first-run restore from outside) also SEND their reason as a line, ending *"Nothing has been changed."*, because
      "the messages above say why" over an empty log was false. **4003 is a restart in which some app's data could
      not be put back, some app could not be started** (held for review, or `compose up` failed — `reupAllApps`
      returns their names), **or some app could not be paused first**: `stopAllApps` now reads `composeStop`'s exit
      code — it reports a failure there and never throws, so its catch alone never fired and a container Docker
      refused to stop was listed as paused — and such an app prints *"• <Name> (couldn't pause it — its data may not
      restore cleanly)"*, is logged, and is returned, because its data was put back under a running container. The
      window waits for a 4003 like any other restart and then says *"The restore finished, but some of your apps or
      their data need attention — the messages above say which…"* rather than *"Restore complete."* — which is what a
      masjid moving to a new box, ALL of whose app data had failed, was shown over the lines saying otherwise. The
      window's *"Affected:"* line names apps, not Docker volumes (a volume it cannot place keeps its own name).
      `test/remote-restore.test.ts` reads `RestoreModal.tsx` to keep the two copies of the codes in step, and
      `test/remote-update.test.ts` (*the update window is told whether anything changed — and waits only for a
      restart*) pins the two-failure rule and the `lost` ending.
    - **And a restore REMEMBERS what went wrong, for after the restart** (`config/restore-report.json`, 0600:
      `{at, appsWithoutData, appsNotStarted, appsNotPaused}`, app NAMES). The window naming the problem apps is unmounted within a
      minute of the core restarting — every session ends then — and nothing recorded which apps had come back empty.
      So a restore with problems writes the report (and logs each failure with `log.warn`); one with nothing to report
      removes any older report, including one that came back inside the backup's own `config/`. After the next sign-in
      the dashboard shows a warning, *"Your last restore needs a look"*, naming the apps whose data could not be put
      back, the apps that did not start, and the apps that could not be paused (*"These apps couldn't be paused for the
      restore, so their data may not have been put back cleanly: {{apps}}. Please check them."*), until *"I've
      checked them"* dismisses it (`backups.restoreReport` / `backups.dismissRestoreReport`, both protected).
      `test/remote-restore.test.ts` (*AN APP THAT DID NOT START AFTER A RESTORE IS NOT "COMPLETE" EITHER*,
      *"RESTORED, BUT IT COULD NOT RESTART ITSELF" IS NOT "IT STOPPED PART-WAY"*, *AN APP THAT COULD NOT BE PAUSED IS
      NOT "COMPLETE"*).
  - **OPENING AN APP FROM OUTSIDE: a one-use ticket, then a token for that app alone — never the dashboard's session**
    (v0.51.2-dev.16; `system/app-access.ts`). The dashboard's cookie never reaches an app — the ingress removes every
    platform cookie before forwarding (`cookieHeaderForApp`) — so an app has nothing from the admin's browser to go
    on: a private app cannot tell the admin from a stranger, and single sign-on has no cookie to forward. The first
    draft let a private app through for any request carrying a remote session cookie (`privateAppAllowed`, deleted),
    which is any request from the admin's browser on that hostname. Now:
    - Open calls `apps.openRemote`, which mints a ticket (`mintAppTicket`) only for a request the front door handed
      over (§13.2e), for a live remote session the remote dashboard made (§9), with remote administration on and an
      apps' hostname set, for an installed app with a web port, and returns
      `https://<apps' hostname>/_omos/open?t=<ticket>`. Spending it
      (`registerAppOpen`) sets
      `omos_session=<that app's ACCESS TOKEN>; Path=/<app path>; Secure; HttpOnly; SameSite=Lax`, for no longer than the
      session it came from, and 303s to `/<app path>/`.
    - The access token (`auth/sessions.ts` `appAccessToken` / `appAccessUser`) is `a1.<session handle>.<mac>`, the MAC
      an HMAC-SHA256 keyed by the session token over the app id: valid only for THAT app, and only while its remote
      session is valid (same password, same second-factor epoch, not signed out, made by the remote dashboard — never
      one made through a proxy at the masjid, §9) and remote administration is on. It
      cannot be turned back into the session or into another app's token, so an app that keeps it holds a key to itself
      and nothing more. It is NOT a dashboard session: no dashboard route accepts it.
    - **Checking a token is work a stranger can ask for, so it is bounded.** `appAccessFromCookie` tries every
      `omos_session` value in the header (a browser may hold an old one for another path), but at most eight
      (`MAX_TOKEN_CANDIDATES`), and only once the cheap tests pass (any such cookie at all; remote administration on);
      and each session's public handle is memoised. A review measured ~5 ms of the root daemon's single thread per
      request from a 16 KB Cookie header of token-shaped values before both.
    - What an app receives through the tunnel, on the HTTP and the WebSocket path alike: every platform session cookie
      — `omos_session` of any value, `__Host-omos_session` — is REMOVED from the Cookie header, and the app's own valid
      access token, if the request carried one, is put back FIRST (`cookieHeaderForApp`; every OpenMasjid app forwards
      the first `omos_session` it finds). So a LAN cookie presented through the tunnel never reaches an app (§9), and
      single sign-on needs no app change: `/api/auth/session` accepts the token for the app it was made for
      (`appAccessSsoUser`) and for no other.
    - An app NOT shared online is served through the tunnel only with a valid token for it; anyone else falls through
      to the identical 404, recorded as `app-not-shared` (`declinedReason`); on the LAN the front door does not serve it
      at all. Its `/fabric/*` stays refused for everyone, token or not.
    - **A private app's address must answer EXACTLY as an empty one — bodies included — so it is declined FIRST.** The
      ingress hook declines it before the `/fabric` refusal or anything else there can answer for it. A review found
      the `/fabric` refusal answering in that hook, before any body was read, while an empty address went on to the
      not-found handler, where Fastify parses the body first: a malformed or oversized POST then got 404 at an
      installed private app's path and 400/413 at an empty one, which told a stranger which apps were installed.
      Declined first, both take the same road (`test/remote-apps.test.ts`, *A PRIVATE APP'S ADDRESS ANSWERS EXACTLY AS
      AN EMPTY ONE*); a declined app's WebSocket does the same (the sockets bullet above). Any new early answer in the
      ingress must come after the decline, or it re-opens the same probe.
    - **An app's BARE address never serves the app's service worker — only one that removes itself — and nothing
      answered there is cached** (`isBareAppAddress`, `isWorkerScriptFetch`, `answerBareWorkerFetch`). A service
      worker's reach is the directory of its script's address, and the directory of `/<seg>` is `/` — the whole apps'
      hostname, every other app's pages, `/_omos/open` and the dashboard included (a worker there could pass the
      dashboard's own page load through itself and read the key). Stripping `Service-Worker-Allowed` (below) confined
      only a script UNDER `/<seg>/`; a review found an app could serve its worker at the bare address instead. So at
      `/<seg>` with nothing after it but a query, a request the browser marks as a worker's script fetch —
      `Service-Worker: script` or `Sec-Fetch-Dest: serviceworker`, which a page's own fetch cannot carry — never reaches
      the app. It gets `SELF_REMOVING_WORKER` (`system/ingress.ts`): a 200 `text/javascript`, with the no-store
      headers, whose worker skips waiting and unregisters itself on activation, and does nothing else (it clears no
      caches — they are the apps'). Not a 404, which was the first answer: a 404 stops NEW registrations, but by the
      Service Workers specification a failed update check leaves an EXISTING registration running, and every build
      before this one, Stable included, let an app's page register a worker over the whole apps' address from its bare
      one; the browser's next update check now installs this instead, and the registration goes with it. The answer
      is the same at a shared app's bare address, a private app's (token or not), an empty one, and on the masjid's
      network — the front door's not-found handler gives it too — so it says nothing about what is
      installed; it is recorded as `worker-at-bare-address` only when it came through the tunnel (`recordRefusal`),
      because the record is a list of what came in from outside. Everything else at a bare address is proxied to the
      app as it always was, but with `Cache-Control: private, no-store` and the CDN no-store headers (`noStore`), so no
      cached copy, the browser's or Cloudflare's, can later stand in for a worker fetch — on the tunnel and on the LAN
      front door alike. Under `/<seg>/` a worker is the app's own business. Accepted residual: a worker an older build
      let an app register over `/` through `Service-Worker-Allowed`, from a script UNDER its path, is not reached by
      this — its update check is proxied to the app, the header is stripped, and that update fails, which leaves the
      old registration in place in the browsers that hold it — and since dev.17 that registration covers the
      dashboard too (*ONE ADDRESS*, above). **The first fix was a 308 from `/<seg>` to `/<seg>/` for
      every GET, and it is gone for a reason:** an app that treats `/<seg>` as its root and sends `/<seg>/` back there
      — Next.js with a base path does, by default — then bounced between the two for ever, and its public page was
      down. Do not bring the redirect back (`test/remote-apps.test.ts`, *AN APP'S BARE ADDRESS NEVER SERVES THE APP'S
      WORKER*).
    - What an app sends back through the tunnel loses any `Set-Cookie` for a platform cookie name, any
      `Service-Worker-Allowed` and any `Cross-Origin-Opener-Policy` (`responseHeadersForTunnel`): the apps share a
      hostname with each other and with the dashboard, and one must not plant a session on another's path, register a
      worker over all of them — including the address that hands out tokens, and the dashboard — or send the
      dashboard's own opener policy, which would let it keep hold of a window it opened on the dashboard. A private
      page, or anything served to a token, also gets `Cache-Control: private, no-store` plus `CDN-Cache-Control` /
      `Cloudflare-CDN-Cache-Control: no-store` (`NO_STORE_HEADERS`) — Cloudflare keys its cache on the address alone, so
      a cached copy would go to the next person to ask — and so does every tunnel refusal.
    Accepted residuals: a WebSocket's `101` response is relayed raw, so a `Set-Cookie` on it is not filtered; and the
    apps share one origin with each other and with the dashboard (*ONE ADDRESS*, above).
  - **Per-IP lockout is the one thing that gets BETTER over the tunnel** (`auth/ip-lockout.ts`). Cloudflare sets
    `CF-Connecting-IP` at its edge and a tunnel client cannot forge it, so remote sign-ins can be rate-limited per
    address where LAN ones cannot (Docker SNATs every LAN client to the bridge gateway — `util/net.ts`). **The address
    is trusted only when `isViaTunnel` is already true**; `trpc/context.ts` passes `null` otherwise, because
    off-tunnel the header is attacker-supplied and honouring it would be both a bypass and a way to lock out someone
    else's address. The map is bounded: it is keyed by something the internet chooses.
  - **The remote dashboard's cookie is `__Host-omos_session`, always `Secure` — and the LAN cookie's `Secure` rule is NOT "via the tunnel".** A handed-over request reads and sets only `REMOTE_COOKIE_NAME`, with `REMOTE_COOKIE_OPTS` (§9 says why the `__Host-` name). The LAN cookie's flag is still decided per response by `cookieOptsFor`: `cf-ray` present **and** `visitorScheme(headers) === 'https'` (`trpc/context.ts`). It was `isViaTunnel(req)` for one build, on the reasoning "it reached us through Cloudflare, so the browser is on HTTPS" — false: Cloudflare stamps `cf-ray` on a plain `http://` visit too, and a browser **rejects** a `Secure` cookie delivered over plain HTTP, so remote sign-in completed its second factor and bounced back to the sign-in screen. It requires `cf-ray` rather than `isViaTunnel` because the latter is also true for a bare `x-forwarded-proto: https` from a masjid's own LAN reverse proxy, where a `Secure` cookie overwrites the non-Secure one in the same jar and ends SSO for every plain-HTTP app. (Since the hand-over, a request carrying `cf-ray` reaches the dashboard listener only when the gate handed it over — and then gets the remote cookie — so this rule is the second line now; it is kept, and `test/remote-admin.test.ts` still drives it through the real context.) **`visitorScheme` reads `cf-visitor` FIRST**, `x-forwarded-proto` only as a fallback: every reverse proxy rewrites XFP with its own scheme (nginx `$scheme`), and trusting it first made every HTTPS visit behind such a proxy look like HTTP — the upgrade below then redirected the browser to the URL it was already on, for ever. The front-door gate is ONE pure function, `frontDoorDecision` (`system/remote-admin.ts`), called by index.ts AND by the tests, because the first version's hand-built test copy had already drifted (it had no upgrade branch). A plain-`http://` tunnel visit to a dashboard path is **upgraded** (308) to `https://<the CONFIGURED apps' hostname><path>` — the target never comes from the request, so it cannot be an open redirect. (The first version's "Host must equal ours" check on the upgrade alone protected nothing while serving a second routed hostname in clear.) With **no** apps' hostname set, or a target beginning `//`, the visit is **refused** (`plain-http-no-host`) — and never served in clear. Only an EXPLICIT http signal redirects, so a proxy that strips the scheme cannot cause a loop. The flag is decided per response, not per process. Its default stays off for LAN sessions because an app on a plain-HTTP port needs the forwarded cookie for SSO; a session
    for a hostname that resolves on the public internet is the one that must never be sent in clear. They cannot
    collide — the tunnel's hostname and the LAN address are separate origins with separate cookie jars, and the two
    cookies have different names besides.
  - **"LAN-only" means "refused over the tunnel", NOT "only reachable from the LAN" — do not write it as the stronger claim.** The guard is a deny-list on a header signal, and it is sound in the direction that matters (a tunnel client cannot strip `cf-ray`, which Cloudflare sets at its edge — the same fact `registerHandoffOnlyGuard` rests on). But `HOST` is `0.0.0.0` and the compose publishes 80/443, so on a **directly reachable host** — a public-IP VPS, or a router forwarding those ports — requests arrive with no Cloudflare headers and nothing distinguishes the internet from the office laptop. Those routes, and the login page, are then internet-facing — whatever the remote-administration switch says, and under LAN rules (password only), because nothing marks such a request as remote. The opposite imprecision exists too: a masjid's own LAN reverse proxy that sends `x-forwarded-proto: https` is treated as tunnel traffic (`isViaTunnel`), so sign-in through it demands the second factor (and is refused while none is enrolled), and a password-only session presented through it reads as signed out — while a session made through it, second factor and all, is never usable from outside (`handedOver`, §9). That is as far as it goes: what the dashboard DOES differently from outside reads the front door's hand-over, which such a proxy never gets, so behind one apps still open at their own ports (§13.2e).
  - **A source-address check is NOT the fix, and adding one would be a regression.** With Docker's default `userland-proxy=true`, `docker-proxy` re-originates every inbound connection from the bridge gateway: measured on a real daemon, an app container, host-network cloudflared, and a client from **outside the host entirely** all present `172.17.0.1`. So a peer check would answer "private" for the internet — an allow-list in appearance that admits everyone. `util/net.ts` carries the full note and `test/ip-private.test.ts` fails the build if `peerIsPrivate` reappears; the same SNAT fact is why the login lockout cannot be per-IP (`trpc/routers/auth.ts`). The real mitigations are a firewall and a bind address, documented for the operator in `docs/SECURITY.md` → *What "LAN-only" means, exactly*.
  - What holds regardless of network position: **no route grants a session, skips a password, or relaxes CSRF because a request looks local** — `isViaTunnel` only ever refuses something or demands MORE of a request (the second factor, a remote session, a ticket), never less, so a request that merely looks local gets the LAN rules and nothing beyond them — and every `/api/fabric/*` route independently requires the 256-bit per-app secret **and** the declared capability. Reaching a Fabric route is not using it.
- **"COULD NOT ASK DOCKER" IS NOT "THERE IS NOTHING THERE"** (v0.51.1-dev.14). `discoverApps()` caught a Docker failure and returned an empty map, identical to a healthy daemon reporting no containers. `listInstalled()` then listed every app from meta.json with `ports: []` and `running: false`, and two consumers acted on it: `system/ingress.ts` rebuilt its routing table, dropped every app for having no port, and answered `{"error":"Not found."}` to **every visitor of every public app path** until the next 10s tick; and `system/alert-monitor.ts` saw every app go running→stopped and would email an `app-offline` alert for each. **Both had a `try/catch` written to prevent exactly this, and neither could ever fire, because nothing threw.** A guard that cannot be reached is worse than no guard, because it stops anyone looking. `discoverAppsResult()` now returns `{apps, ok}`; `listInstalledWithHealth()` carries `discoveryOk` to the callers that make decisions, while `listInstalled()` stays lossy for the ones that only display. This is the same rule as §13.2d's Stripe case and the WhatsApp health monitor — **a failure to ask records nothing and decides nothing** — and it is worth checking any future poller against it.
  - **That fix was applied to the instances found, not to the class — keep checking.** This bullet used to say `discoveryOk` reached "the two callers that make decisions, while `listInstalled()` stays lossy for the thirteen that only display", which read as a complete audit and is not one. `system/address-monitor.ts` was a third (v0.51.2-dev.18: it now takes `listInstalledWithHealth()`, decides nothing on a failed discovery, and keeps retrying the apps it could not recreate). `restoreAppProxies` (`apps/manager.ts`) was a fourth: run once at boot on the lossy list, a Docker hiccup then left every app's HTTPS proxy off until someone touched it. It now takes `listInstalledWithHealth()` and, when Docker cannot be read, tries again after 5, 15, 30 and 60 s, then logs which apps' HTTPS addresses were not restored. Neither was as loud as the ingress 404 storm, which is why they were missed. Anything new that *acts* on an app list must take `listInstalledWithHealth()`; don't trust a count in this paragraph as proof the sweep was exhaustive.
- **THE PLATFORM MUST NEVER ANSWER AN SSO CHECK "NOT SIGNED IN" FOR ITS OWN REASONS** (v0.51.2-dev.15). Every OpenMasjid app reads anything but `{authenticated:true}` from `GET /api/auth/session` as "platform reachable, not signed in" — **deliberately**, because `reachable:false` is what unlocks an app's local-password recovery, and an attacker must not be able to unlock it by making the platform refuse. So the apps fail closed and are right to. That makes every platform-side refusal a **lockout**: the app says "sign in through your dashboard" and refuses its own password. Two of them were the platform's own rate limits, both silent:
  - the central hook charged SSO introspection to the app's **120/min SEND budget** — shared with every email, WhatsApp, alert and broker call that app makes — so a busy minute (a roster's fee reminders) refused the very next sign-in check;
  - the handler ALSO charged the per-IP tier, which is **one bucket for the whole box** (Docker SNATs every app to the bridge gateway, `util/net.ts`) — so ANOTHER app's traffic refused the app the admin had just pressed.
  Now SSO has its own counter (`appsso:<id>`, `RATE_MAX_APP_SSO`), an **identified** caller is not charged to the shared IP tier (that tier exists to bound an UNAUTHENTICATED flood; a valid 256-bit secret is not one) — on EVERY Fabric route since v0.51.2-dev.18 (`fabricCaller` in `api/fabric.ts`, and the app-to-app broker), not only SSO: one app polling its WhatsApp outcomes at its allowed rate, or five apps each inside their own budget, emptied that one bucket and every app's email, WhatsApp, alerts and Stripe calls were refused for the rest of the minute — an unidentified caller still is, and the generous tier is granted only when **every** spelling resolves exactly to the SSO path (`isSsoIntrospection`, `every` not `some`) — an encoded or dot-segment spelling, a POST, pays the tight send budget. A 429 keeps `authenticated:false` (fail-closed apps unchanged) and adds `retryable` + `Retry-After`. Every refusal is now **logged**, throttled, never with a cookie or secret — the failing exits used to be silent while the success logged at `info`, which is why this could not be found from the log. `test/sso-reliability.test.ts`; `restore.ts` also now calls `invalidateFabricIndex()` after replacing `apps/`, which `saveMeta` never saw — the same lockout through a different door.
- **A REFUSED TUNNEL REQUEST MUST BE OPAQUE OUTSIDE AND EXPLICABLE INSIDE** (v0.51.1-dev.15). Five guards answered tunnel traffic with a byte-identical `{"error":"Not found."}` and **no log line at all**, so three unrelated situations — nothing published at that path, a LAN-only platform route, an app's own LAN-only `/fabric` space — were indistinguishable from outside (correct) and equally indistinguishable from inside (not). `system/tunnel-refusals.ts` records path + host + reason in a bounded in-memory ring, surfaced only to a signed-in admin (`cloudflare.refusals`, Settings → Remote access — on the LAN, or from outside behind the second factor). **The RESPONSE must stay identical for every reason** — a discriminating 404 would let a stranger map which paths are real routes on this platform, which is the same disclosure the version-withholding on `/api/health` exists to prevent; `test/tunnel-refusals.test.ts` fails if a 404 body ever names its guard, and if any guard 404s tunnel traffic without recording. Every guard now answers through ONE responder, `refuseOverTunnel` (v0.51.2-dev.16), because the copies had drifted: the not-found handler gave a browser an HTML page while the dashboard gate and the Fabric guard gave it JSON, so the shape of the answer told a visitor which kind of address they had hit. Every refusal also carries the no-store headers, so Cloudflare cannot cache a 404 and serve it to the admin later. There are SEVEN reasons now, every one seen only in the record: the first three above (`no-app-at-path`, `lan-only-route`, `app-fabric-lan-only`) and four from remote administration — `plain-http-no-host` (dev.15: a plain-`http://` dashboard visit the gate cannot upgrade — no apps' hostname set, or a request target beginning `//`), and in dev.16 `app-not-shared`, `wrong-port` (Cloudflare traffic that reached the HTTPS port directly) and `worker-at-bare-address` (a service worker's script asked for at an app's bare address, the app-opening bullet above). That last is the one reason not answered with THE 404: it gets the self-removing worker, through `answerBareWorkerFetch`, which is just as identical at every bare address and so tells a stranger no more; it is given on the LAN front door too, but recorded (`recordRefusal`, the recorder `refuseOverTunnel` uses) only when it came through the tunnel. Each has its own words in "Recently turned away", and `test/tunnel-refusals.test.ts` fails if a reason in the type has none (*EVERY REASON HAS ITS OWN WORDS*): an unlabelled reason falls back to "Local network only", which is how `wrong-port` (and dev.16's `no-admin-host`, gone with its second hostname, as are `dashboard-elsewhere` and `app-on-admin-host`) were first shown, with nothing to say what to fix. The query string is never stored (that is where tokens live) and the ring is never persisted — this is a "why is my page down right now" diagnostic, not an access log.
- **The reverse proxies are a hostile boundary.** `system/ingress.ts` + `system/app-proxy.ts` strip client-supplied `X-Forwarded-*`/`Forwarded` + hop-by-hop headers and set trusted values. That includes **`X-Forwarded-Prefix`**, which the platform never sends: some frameworks (Spring, ASP.NET, Next.js behind a proxy) take their base path from it, so one arriving was typed by the visitor and would choose where the app believes it lives. Each file strips on two paths, HTTP (`STRIP_HEADERS`) and WebSocket (an inline `drop` set), so a header belongs on all four lists — `cf-connecting-ip` was once added to one path of a file and missed on the other. The two WebSocket relays share ONE lifetime helper, `system/socket-relay.ts` `closeTogether` (the long-lived-connection bullet above says why), for the same reason: the same relay written twice is how one copy gets fixed and the other does not. Their HTTP paths carry its twin, written into each — a browser that leaves part-way destroys the request to the app — so a change to one belongs in both. Through the tunnel the ingress rebuilds the Cookie header too (`cookieHeaderForApp` — no platform session cookie ever reaches an app) and filters what comes back (`responseHeadersForTunnel`); see the app-opening bullet above. Don't relay request headers verbatim to app containers.
- **`checkForUpdate` must offer an update when the RUNNING BUILD is from the other channel, not only when a version is newer** (v0.50.5-dev.1). `runUpdate` had always acted on this (`wrongChannel`), but the detector compared versions alone — so a box running a Stable image while set to Development was never told: no banner, no alert, no error, no way out of the dashboard. It happens for real (an interrupted update repaired with the installer, which pulled `:latest`). `channelMismatch` is symmetric (`isPrerelease(VERSION) !== (channel === 'dev')`) — a per-channel branch here is the old Development special-casing returning — and feeds `updateAvailable`, but only when `latest != null`, because a move needs a target. `reason: 'version' | 'channel'` exists so the UI does not call a channel move "a new version": going back to Stable targets an OLDER number. **This also means a numbering mistake cannot strand a masjid again** — the mismatch alone offers the way back even when the channel's VERSION is below the running one.
- **An update runs ONCE at a time, enforced on the SERVER** (`system/update-lock.ts`, v0.50.4-dev.6). Nothing prevented two updates of the same thing: every WebSocket connection to `/api/update` started a fresh core update and every one to `/api/apps/update?id=…` a fresh app update, so closing the progress window and pressing the button again ran a second over the first — two `compose up --force-recreate` racing for one container, two writers on one compose file. A masjid's box stopped coming back. The dialog/window is also locked while running (`Modal locked`, `OpenWindowOptions.locked`, and `close()` itself refuses a locked window so the Escape handler is covered by the same rule), but **the client lock is the second line of defence, never the first** — a browser can be closed, a laptop can sleep. A refused second run is reported as information, never as "Update failed", because calling it a failure pushes an admin into retrying. A client going away must never abort an update in flight; the work continues and the progress lines are dropped.
  - **And a core update, a restore and an app's update never overlap** (v0.51.2-dev.16). The keys `core` and `restore` are EXCLUSIVE: either is refused while anything else runs, and nothing starts while either does; two different apps' updates touch nothing in common and may still run together. A review pressed Update 300 ms into a restore: the update's helper replaced the core while the restore was still refilling app data — the restore cut off part-way, every app left stopped, a database half put back. A clash is `UpdateBusyError` with `clash: true` and a message naming what is in the way (*"A backup is being restored right now. Please update OpenMasjidOS once it has finished. Nothing was changed."*, and so on for each pair); the same work asked for twice is `clash: false` (the core's: *"An update is already running. It will finish on its own."*). The core update's window closes 1000 when it is the same update asked for twice — the running one is expected to restart the core, so the window waits for that, saying "updated" only on evidence (§13.4) — and 4001 for a clash, because nothing is coming; a refused restore or app update ends "nothing was changed" either way. Two-step sign-in cannot be changed for the whole of a restore either (§9). `test/update-lock.test.ts` (*A CORE UPDATE, A RESTORE AND AN APP UPDATE NEVER OVERLAP*).
  - **A core update or a restore keeps its lock until the core is REPLACED, not just until it hands that job over** (v0.51.2-dev.16). `withUpdateLock(key, busy, fn, { holdAfter })`: once `fn` resolves, `holdAfter(result)` ms keep the key held, released by an unref'd timer; a throw never holds. `runUpdate` holds for `'restarting'`, `runRestore` for `'restarting'` and `'restarting-with-problems'`, each for `HOLD_UNTIL_REPLACED_MS` (5 minutes); every other ending lets go at once. Why: the old core runs on about 12 s after handing its replacement to the helper — the helper's `sleep 2`, then compose's 10 s stop timeout, because the core is node as PID 1 (`Dockerfile` `ENTRYPOINT`) with no SIGTERM handler and so waits to be killed — and releasing at the hand-off accepted a restore, an app update or a second core update in that gap, which the replacement then killed part-way: a review launched three helpers, and cut a restore off with one app's data half put back and every app left stopped. During the hold the work is DONE and only waits for the core to be replaced, so every refusal says that instead (`finishing(key)`, `finishingMessage(key)`): *"OpenMasjidOS is restarting to finish an update. Please try again in a minute or two. Nothing was changed."*, or *"…to finish restoring your backup…"* — in place of the clash message, the same-work *"already running"* (still not a clash, so the update window waits for the restart, close 1000), `assertAppFree`'s messages (next bullet), and the restore middleware's, the logo routes' and the restore upload's (the restore bullets above). Saying *"being restored right now"* over a restore that had finished sent the admin to wait for something that was not happening; while the work is still RUNNING the earlier messages stand. `isUpdating` answers true throughout the hold, so everything keyed on it lasts until the core is gone; the timer is only the backstop, so a helper that never replaces the core cannot wedge the box. `__releaseHeldLocksForTests()` is for tests only. `test/update-lock.test.ts` (*A CORE UPDATE OR A RESTORE KEEPS ITS LOCK UNTIL THE CORE IS REPLACED*), `test/remote-restore.test.ts` (*A RESTORE THAT RESTARTS THE CORE KEEPS ITS LOCK UNTIL THE CORE IS REPLACED*).
  - **No app is started, restarted, installed or removed under a restore or its own update — stopping never is** (v0.51.2-dev.16; `assertAppFree(id, 'start' | 'install' | 'remove')`, an `UpdateBusyError` with `clash: true`). It is asked FIRST — before any compose call, file or `meta.json` write — in `startApp` and `restartApp` (both `'start'`: a restart starts a stopped app), `removeApp`, `installCatalogApp` and `installStack`. During a restore every action is refused (a start: *"A backup is being restored right now. Your apps will start again on their own when it has finished. Nothing was changed."*; an install or a removal: *"A backup is being restored right now. Please install this app once it has finished. Nothing was changed."*, or *remove*); during that app's own update (`app:<id>`) every action (*"This app is being updated right now. Please try again once it has finished. Nothing was changed."*); during a core update an install or a removal only (*"OpenMasjidOS is being updated right now. Please install this app once it has finished. Nothing was changed."*) — it would be cut off with the core, while a start is quick and allowed. Why: a restore stops every app and refills its data, and an app started meanwhile ran over a database being replaced — a review's Start was accepted mid-refill and `compose up` ran before the refill finished — and, worse, a compose that came in with the backup and had not been checked yet could be started with no consent at all (`privileged: true`, host root), from WhatsApp too, which must never be able to consent (the persisted-review bullet above). A Start during the app's own update brought up the compose the update was about to put back. The restore's own `reupAllApps` brings apps up with `composeUp` directly, so it is not refused. `stopApp` never asks: stopping is what a restore does to every app anyway, and turning an app off must always work. Every caller already handles the error: tRPC turns it into CONFLICT (`trpc/routers/apps.ts` `wrap`, and the store, custom and community install routes and the WhatsApp gateway's restart, each of which used to pass it on as INTERNAL_SERVER_ERROR); WhatsApp `!os start` and `!os restart` reply with the message (`say.busy`); the address monitor and Remote access's re-ups catch it and skip. `test/update-lock.test.ts` (*NO APP IS STARTED, INSTALLED OR REMOVED UNDER A RESTORE OR ITS OWN UPDATE*).
- **Stats must agree with `free`, `htop` and the provider's console** (v0.50.4-dev.6), because that is what a masjid checks them against and a number that disagrees reads as the dashboard lying — which costs trust in every other figure on the page. Three fixed: (a) memory used is computed exactly as `free` does (`MemTotal − MemFree − Buffers − (Cached + SReclaimable)`) — it counted the page cache as used, so a mostly-idle box showed as nearly full. The host cgroup (`readHostCgroupMemory`) is believed only when it has a REAL limit (`realLimit` — an LXC/Proxmox container): on a bare-metal cgroup v1/hybrid host it is the machine's root cgroup, which still counts active page cache as used, so `/proc/meminfo` answers there, as `free` does. (b) The CPU sampler's baseline is module-level while its callers are not — `stats.get` plus one `stats.stream` loop **per open tab** — so whoever called last moved the baseline and the next reading averaged a few milliseconds of jiffies, i.e. noise; a sample is now only taken after `MIN_CPU_SAMPLE_MS` and callers in between get the last real value **without the baseline moving**. (c) **Storage is measured on the ONE filesystem that holds the data dir** (the most specific mount containing it — a path-boundary test, because `/` contains everything and a plain prefix test reported the wrong disk). `diskUsed` is its used space and `diskTotal` is `used + available` — what `df` divides by, so ext4's 5% root reserve is not counted as room — less a host-OS reserve of `min(HOST_OS_RESERVE_BYTES (16 GB), a quarter)`: a disk at a true 100% cannot write logs or update itself and needs someone at a terminal in the masjid, so the card counts down to "full" early; the quarter cap is why a 16 GB SD card no longer has a total of 0. `used` stays the real figure (the UI clamps the percentage). **No percentage may divide by the physical drive size** — it is the display-only `diskDeviceBytes` (every real disk in `/sys/block` added together, or null). Dividing by it read a full Ubuntu-default LVM volume (~100 GB on a 256 GB disk) as about 40%, a NAS-backed `/data` as 100% for good, and a full Proxmox LXC — whose `/sys/block` lists the NODE's disks — as 1%, so the 80% warning, "under load" and `!os stats` "nearly full" never fired. (d) **One collection is shared** (`collectStats`: callers join the one running, or one started within `SHARE_MS` = `MIN_CPU_SAMPLE_MS`, so each tab still gets a newer snapshot every tick), the slow sources — Docker, `df`, the temperature probes — are bounded (`SLOW_SOURCE_MS`, 1.5 s, then that source's last answer, and a stuck request is never joined by another, so a wedged dockerd or a dead NFS mount cannot freeze the cards), and the CPU sampler times itself with `performance.now()`, so NTP stepping the wall clock back cannot freeze the figure.
- **Reaching an app's published port goes through `system/app-host.ts` — never a hardcoded loopback address** (v0.50.4-dev.3). The core is a bridge-network container, so `127.0.0.1` inside it is *the core*; an app's published port is on the **host**, reachable only via the installer's `host.docker.internal:host-gateway` mapping. Three callers had this right and the expression was pasted into each; the WhatsApp gateway client was then written from memory with `127.0.0.1` and **could not reach OpenWA on any install**. The symptoms ("cannot reach the gateway", `fetch failed`) both pointed at the masjid's setup rather than at the platform, and this file's own §13.2b-ii and Fabric bullets described the address as `127.0.0.1` too — a wrong spec produced a wrong implementation. It is one exported helper now, `test/app-host.test.ts` fails any source file that builds `http://127.0.0.1:${…}`, and a transport failure must name a reason an admin can act on rather than surfacing undici's bare `fetch failed` (the real cause hides in `err.cause.code`).
- **The Fabric app-to-app broker (`fabric/appLink.ts`, `POST /api/fabric/app/:target/:capability/:method`) is LAN-only and least-privilege** (v0.40.0). It inherits the `/api/fabric` viaTunnel guard (`registerFabricTunnelGuard`, `system/via-tunnel.ts` — the single shared implementation), authorizes by **static manifest grants** (caller `consumes` ∧ target `provides`), builds the target URL ONLY from the registry (the app's published host port via `system/app-host.ts` — no request-controlled host/path, no SSRF), injects the **target's own** secret + a trusted `X-OpenMasjid-Caller-App` while stripping caller-supplied identity/forwarding/hop-by-hop headers, caps JSON at 256 KB each way with a 10 s timeout + per-caller rate limit, returns `{ fabric_error }` on platform failures, and **never logs bodies**. Don't weaken any of these.
- **OPEN GAP — the Fabric's least-privilege rule does NOT hold for Stripe.** `GET /api/fabric/stripe?account=<id>` (`api/fabric.ts`) takes the account id straight from the query string and returns that account's `secretKey` and `webhookSecret`; the only check is that the caller holds the `stripe` capability. Nothing binds an app to a particular account, and `/api/fabric/stripe/accounts` hands the caller the ids to ask for. **So any stripe-capable app can read every configured account's live keys** — a masjid running one Stripe account for donations and another for school fees has no separation between the two apps. It is LAN-only and capability-gated, so this is an app-vs-app boundary rather than an internet-facing hole, but it is the one place the "least privilege" claim above is not true, and it must not be written as though it were. The fix is a per-app account binding recorded at install and enforced here. Do not "improve" it unilaterally: silently narrowing this breaks a masjid's live donations page.
  - **CORRECTION: this is NOT a cross-repo change, and saying it was is what kept it open.** This bullet claimed the fix "changes the app-facing Fabric contract — so it is its own coordinated change across `OpenMasjidAPPS` and the app repos". That is true only of a **manifest-declared** binding. An **admin-recorded** binding is purely platform-side: `AppMeta.stripeAccounts`, set by a mutation mirroring `setExposed`/`setAppPath` and a per-app row in Settings → Payments. The app keeps calling `GET /api/fabric/stripe?account=<id>` byte-for-byte unchanged; only the set of ids it gets an answer for shrinks. It must **not** live in the manifest — an author cannot know a masjid's account names, and letting the app assert its own scope is the mistake `manager.ts` already calls out ("Trust is not something the subject gets to assert"). What genuinely remains Hasan's is the **default when unbound**, because that is the difference between a compatible no-op and breaking a live donations page. Three traps for whoever builds it: `getAccountFull(idOrLabel)` resolves by id **or label**, case-insensitively, so enforcement must resolve first and then compare `acc.id` — a check against the raw query string is bypassable by asking by label; `?account=` omitted silently means `accounts[0]`, so that path needs the same treatment; and `/api/fabric/stripe/accounts` must be narrowed in the same change or the enumeration survives. Note also that `type: stripe-account` (the install-time dropdown) is **optional** and independent of the `stripe` capability, so it cannot be relied on as the sole source of the binding.
- **Tunnel exposure is per-app opt-in** (v0.40.0). Whether an app is shared online is `isExposedMeta` (`InstalledApp.exposed`): the admin toggles it in Settings (default from the manifest `tunnel:true` request), and a value nobody set is grandfathered exposed for a catalog app (so pre-0.40 installs don't go dark) and private for a custom/community one. `ingress.rebuild()` used to route an app only when it was shared; since v0.51.2-dev.16 it routes every app with a web port and CARRIES `exposed` on the route, because a private app must still open for the admin from outside: through the tunnel it is served only to a browser holding that app's access token, everyone else gets the identical 404 (recorded as `app-not-shared`), and on the LAN the front door does not serve it at all (the app-opening bullet above). `isRouted` still means PUBLICLY routed (`exposed === true`), so a private app never gets a public URL: `OPENMASJID_PUBLIC_URL` is injected empty unless exposed, and `/api/fabric/site` stays the live source of truth. With every app in one table, a clash of paths can hurt now — a private app taking a shared app's path would turn a public donations page into a 404 for every donor while Settings still showed it as shared — so `placeRoute` keeps a shared app's path whatever else claims it (and logs the clash), and **`isRouted(id)` is true only for the app that actually HOLDS the route** (`r.id === appId`), or the other app's Stripe return links and QR codes would point at someone else's app. An app's own **`/fabric/*` is refused over the tunnel** on BOTH the HTTP and WebSocket ingress paths (`isFabricSubpath`), for every app and whatever token comes with it — those routes are LAN-only.
  - **No two apps on one address, and none on the platform's own** — checked when an address is set AND when an app is installed. `setAppPath` refuses a path another installed app already answers to, and one in `apps/paths.ts` `RESERVED_PATH_SEGMENTS` (`api`, and every `DASHBOARD_SEGMENTS` entry — `trpc`, `assets`, `store`, `apps`, `files`, `settings`, `design-system` — since dev.17 put the dashboard on the apps' hostname; `test/app-paths.test.ts` keeps the two in step). That is ONE list, read by the ingress (which never routes them) and by Settings: when only the ingress knew, an admin could set an app's address to `/api`, accepted without a word, after which the app had no public page and opening it from outside landed on a 404. The ingress also routes nothing but an app-path SHAPE (`isAppPathShape`; the `/_omos/open` bullet above says why). And an INSTALL (catalog, community or custom) whose id is already another app's address, or a reserved word, gets the next free `<id>-N` (`addressForNewApp`) — decided before anything is written, logged, and used in `OPENMASJID_PUBLIC_URL`; a reinstall keeps the address it had, unless the platform has since taken it. **An app already on an address the platform has since taken is moved** (`appPathOf`, v0.51.2-dev.18): dev.17 reserved the dashboard's page segments, and an app given one before was no longer routed while `OPENMASJID_PUBLIC_URL` and the Fabric still advertised it, so its links and QR codes opened the dashboard. On first read it is moved once to the address a new app would get (`freeAddress`), saved, its `OPENMASJID_PUBLIC_URL` line rewritten and logged — lazily rather than at boot, so it also catches an old backup restored later; the running container sees the new URL at its next start. Installing used to take the id unconditionally, which is the half `setAppPath` could not see: give a community app `/donations`, install the official Donations app later, and the two shared one address — the newer took the public page, Settings listed both as published there, and opening the older one from outside opened the other (`test/app-paths.test.ts`).
- **Email + alerts over the Fabric are LAN-only + least-privilege** (v0.41.0). The SMTP password / Resend API key live in `config/email.json` (chmod 600) and never leave `store/email.ts` except to the sender (`notify/email.ts`); the admin API returns only "is set" flags. `POST /api/fabric/email` (capability `email`) and `POST /api/fabric/alert` (gated on the app having declared the alert in its manifest) are under `/api/fabric`, so they inherit the viaTunnel LAN-only guard; both are rate-limited and never log bodies. Alerts are routed by the admin's per-alert × per-channel matrix (`notify/alerts.ts`, `channels` in `config/alerts.json`; §13.2c) before anything is sent. The admin email (`auth/store.ts` `getAdminEmail`) is the only address alert emails go to.
- **The File Explorer's sandbox is NOT just "inside the data dir"** (v0.47.3) [OPENMASJIDOS-004]. The data dir is also where the platform keeps its control plane, so confinement to `/data` still exposed two things to any authenticated session: (a) **every platform secret** — `config/` holds the admin password hash, the SMTP password / Resend key, the Stripe keys, the tunnel token and the TLS private key, all of which every other surface deliberately refuses to return to the client; and (b) **host root** — start/update run `docker compose -f apps/<id>/compose.yml up`, reading that file *from disk*, so rewriting it and pressing Start launches a `privileged: true` / docker.sock-mounted container **without passing `apps/compose-validate.ts`**, the sole install-time gate. `apps/<id>/meta.json` is the same class (it carries `ssoSecret` and the Fabric capability grants). `files/manager.ts` now has ONE decider, `protectedReason()`, and **every entry point asks it** — `resolve()` is the choke point, and constructed targets (rename destination, upload destination, the `writeTextFile` leaf) each call `assertAllowed` because they don't pass through `resolve()`. Protected: `config/**`, `.backup-staging/**`, a backup uploaded for restoring and its unpacked copy (`.restore.tar.gz`, `.restore-staging/**`, v0.51.2-dev.16 — each a whole backup, every password hash, key and token, possibly another box's, and both were browsable and downloadable while a restore waited or ran: *"This is a backup being restored, so it is kept private. It is removed when the restore finishes."*; `test/files-guard.test.ts`, *a backup waiting to be restored, and its unpacked copy, are private*), the core's own `docker-compose.yml`, and exactly `compose.yml` / `.env` / `meta.json` directly inside `apps/<id>/` (matched case-insensitively; deeper paths are the app's own data and stay browsable). The `apps/<id>` folder itself stays browsable but cannot be renamed or deleted, which would take those three files with it. The guard checks the **realpath as well as the requested path** — a symlink at `apps/x/data/link` → `config/stripe.json` is legitimately *inside* the sandbox, so checking one spelling isn't enough (same lesson as the raw-vs-decoded guards). **Backup and restore must stay independent of this module**: they archive `config/` and `apps/` directly and import nothing from `files/manager.ts` — `test/files-guard.test.ts` pins that structurally, because a guard that reached the backup path would silently produce backups missing every setting.
- **A damaged file in the data dir must never stop the daemon booting** (v0.47.2). The dashboard's TLS cert is the case that proved it: `ensureCert` checked only that `cert.pem`/`key.pem` *existed*, `loadCert` was a bare `readFileSync`, and Node builds the TLS context **inside the Fastify constructor** — which sits outside the try/catch that wraps reading the cert. A corrupt-but-present cert therefore exited the process, and under `restart: unless-stopped` that is a crash-loop with no dashboard left to repair it from, on hardware that may be wall-mounted. Both installer self-service paths (Update, Repair) re-read the same file, so it needed a drive to the masjid. Now: `certPairProblem` runs the checks Node does (parse cert, parse key, `checkPrivateKey` — the only thing that catches a *partial restore*, where both files are valid PEM but from different boxes — and building the secure context with `tls.createSecureContext`, which refuses a key or signature below OpenSSL's security level: a 512-bit RSA pair passed the other three, was stored, and every later boot quietly fell back to plain HTTP); a new pair (openssl's or an upload) is written as `*.pem.new`, checked, and only then renamed over the working one, so a failure part-way (a full disk) leaves the working pair alone; `ensureCert` validates **content**, quarantines the damage as `*.broken`, and regenerates; `loadCert` throws rather than returning unusable bytes; and `index.ts` rebuilds the server **without TLS** if the constructor throws anyway, which also keeps the tunnel refused. `generateSelfSigned` verifies what openssl actually wrote instead of trusting exit code 0. Two rules when touching this: **a healthy cert must be left byte-for-byte alone** (churning it re-triggers the browser warning on every device on the LAN), and **never remove the plain-HTTP fallback** — it is the last way in. `test/tls-boot.test.ts` pins all of it, including the real `ensureCert → loadCert → createServer` sequence. The same shape applies to any other boot-critical file: validate before trusting, degrade rather than exit.
- **Secrets at rest:** persist config secrets 0o600 (`writeJson` does this; `CONFIG_DIR` is 0o700; `config/email.json` too). First-run `auth.setup` uses `createAdminIfUnset` (compare-and-set, capturing email/name) — don't reintroduce an unconditional write.
- **CI:** the CLA workflow runs on `pull_request_target` — keep third-party actions pinned to a commit SHA (never a tag) and never `actions/checkout` the PR head there. It **does** need `permissions: actions: write` (the official contributor-assistant setup): after a contributor posts the sign comment, the action re-runs the PR workflow to flip the required `cla` check green — without it the signature records but the check stays red (`Resource not accessible by integration`). That's safe here specifically because the job runs ONLY the pinned action and never checks out/executes the PR's code.

---

## 16. Build & run commands (keep these working)

```bash
npm install         # install all workspaces
npm run dev         # run core + ui together with hot reload
npm run build       # bundle ui (vite) + core (esbuild) — does NOT typecheck
npm run lint        # tsc --noEmit across both workspaces — this IS the typecheck
npm run test        # tests across workspaces (node:test, in packages/core)
npm run image       # build & tag the runtime Docker image openmasjid/core:dev
```

**`npm run lint` is the only typecheck.** Neither build step typechecks — Vite and esbuild
both strip types without checking them — so a type error passes `npm run build` and fails only
under `npm run lint`. Run lint before trusting a green build.

**There is no ESLint in this repo.** `lint` is `tsc --noEmit` and nothing else. Earlier revisions
of this file and of `CONTRIBUTING.md` promised "eslint + tsc", which made the documented
definition of done unachievable as written. If a linter is wanted, adding one is a deliberate
change with its own diff — don't paper over its absence by describing it as present.

The production image is built from the three-stage `Dockerfile`: the `deps` stage installs the
core's production dependencies alone (`npm ci --omit=dev --workspace=@openmasjid/core`); the
`build` stage installs every workspace and runs `npm run build` (Vite for the UI, esbuild bundling
the core into `packages/core/dist`); the `runtime` stage copies the built output and `deps`'
`node_modules` — never the build stage's, which carries every UI dependency — and runs the Node
daemon, which serves the built UI + API as `openmasjid/core`. The core's bundle leaves every package
external, so a dependency missing from `deps` builds cleanly and fails only when node starts: CI
starts each architecture's image and waits for `/api/health` before anything is pushed
(`docker-build.yml`, *Smoke test*).

---

## 17. Definition of done (for any feature)

A change is "done" only when: it builds via `npm run build`; `npm run lint` (the `tsc --noEmit` typecheck — there is no eslint, see §16) is clean; `npm run test` passes and any new test file is listed in `packages/core/package.json`'s `test` script, which names every file explicitly — an unlisted test never runs and nothing tells you; it's covered by at least a basic test where logic is non-trivial; it works in **both** light and dark themes; it works in **both** LTR and RTL; it honors `prefers-reduced-motion`; authenticated areas stay behind login; client/server types are shared (no hand-duplicated types); all new strings are in i18next; user-facing wording is plain and friendly; and no raw technical error can reach the user un-prettified.

---

## 18. Version control policy

The canonical version lives in the **`VERSION`** file at the repository root. It is the single source of truth. The build reads `VERSION` and injects it into the app (e.g. as a build-time env var / a generated `version.ts`), and the Docker image is tagged from it. Never hardcode a version string anywhere else.

### Scheme: `MAJOR.MINOR.PATCH`

| Segment | When to bump | Example |
|---------|--------------|---------|
| **PATCH** (3rd) | Any small, backwards-compatible change — bug fixes, copy tweaks, minor UI improvements, dependency bumps. | `0.1.0` → `0.1.1` |
| **MINOR** (2nd) | A meaningful new feature or a significant change to existing behaviour — new page, new tRPC procedure, new installer capability. | `0.1.x` → `0.2.0` |
| **MAJOR** (1st) | **Reserved for the official public launch.** `1.0.0` signals production-ready, fully stable software. Do not bump to `1.x` before that milestone. | — |

**Development builds are semver PRERELEASES** — `dev/VERSION` holds `0.50.5-dev.1`, naming the release it is heading toward. See §13.4: the bump *is* the publish, and the ordering `0.50.4 < 0.50.5-dev.1 < 0.50.5` is what makes the Development channel detectable at all.

> **After a release, bump the BASE version, not just the `-dev` counter.** Once `0.50.4` is on master, dev must go to `0.50.5-dev.1` — never `0.50.4-dev.N`, because a prerelease sorts **below** its own release, so `0.50.4-dev.6 < 0.50.4`. This reached a masjid: a box on Stable `0.50.4` that switched to Development was offered nothing at all, since the channel's newest build was older than what it was already running — no banner, no alert, no error, the dashboard saying Development and running Stable indefinitely. `test/update-channel.test.ts` now compares dev's `VERSION` against `master:VERSION` and fails with that explanation.

### Where the version lives per branch

| | `master` | `dev` |
|---|---|---|
| `VERSION` | the release, `0.50.3` | a prerelease, `0.50.4-dev.1` |
| enforced by | `test/update-channel.test.ts`, keyed on the **target** branch | same test, other arm |

A release is a `dev → master` merge. `VERSION` conflicts every single time by design — resolve it to the release number, which completes the merge, so the merge and the bump are one commit.

### How to bump the version
1. Edit the `VERSION` file — change the number, nothing else.
2. Commit with message `chore: bump version to x.y.z`.
3. Push. CI reads `VERSION` and tags the image from it. The dashboard shows it in Settings → Advanced.

### A RELEASE IS NOT FINISHED UNTIL A GITHUB RELEASE IS PUBLISHED

**A tag is not a release.** Pushing `vX.Y.Z` makes CI build and publish the image; it does not
create anything a human can read. Both are required, and the release is the step that gets
forgotten — the repo sat with tags through `v0.51.0` while the newest published Release was
`v0.49.3`, so the repository front page advertised software five versions out of date as
"Latest", and six versions shipped with no readable notes anywhere on GitHub.

So a release, in full, is:

1. Merge `dev` → `master`, resolving the `VERSION` conflict to the release number (§18 above).
2. Rewrite `## Unreleased` into `## X.Y.Z` — **only what a masjid would notice** (see below).
3. Push `master`.
4. Push the `vX.Y.Z` tag. This is what publishes `:latest` and the exact version tag (§13.4).
5. **Publish the GitHub Release for that tag**, with the `## X.Y.Z` changelog section as its body:
   `gh release create vX.Y.Z --title "vX.Y.Z — <the one-line point of it>" --notes-file <file>`.
6. Bump `dev`'s `VERSION` to the NEXT base version's `-dev.1` (§18 — never the released base).

**Which of these a masjid actually sees, precisely.** The dashboard's "What's new" panel does
**NOT** read GitHub Releases: `store/changelog.ts` fetches `CHANGELOG.md` raw from the branch
matching the masjid's channel (`changelogUrl()` → `master` for Stable, `dev` for Development).
**So `CHANGELOG.md` on `master` is the text that reaches a masjid, and it is the one that must
be plain and warm.** The GitHub Release serves everyone else — someone evaluating the project,
a contributor checking what changed, anyone who lands on the repo — and it is the only place
those people look. Keeping the two in step costs one command; letting them drift means either a
masjid updates with no explanation, or the public repo looks abandoned.

### CHANGELOG.md — two audiences, two levels of detail

`CHANGELOG.md` is fetched live by the dashboard ("What's new"), **from the branch matching the masjid's channel** (`changelogUrl()`). So the same file is read by two different people and must be written for both.

**On `master` — releases only, and only what a MASJID would notice.** One `## X.Y.Z` heading per release, a handful of bullets, plain warm language for a volunteer (§14). A masjid does not care that a CI tag predicate changed; they care that updates install. Fold the internal work into one plain sentence, or leave it out. If a release contains nothing user-visible, say so in one line rather than inventing significance.

**On `dev` — an `## Unreleased` section at the top, in full detail.** Everything that has landed on `dev` since the last release goes here as it lands: fixes, internals, CI, refactors, dependency bumps. This is the working record, read by whoever is about to cut a release, so it should be complete rather than curated. Keep the released sections below it byte-identical to master's, so the two files only ever differ by `## Unreleased`.

**At release time**, `## Unreleased` is *rewritten* into a `## X.Y.Z` section holding only the major, user-visible items — not renamed wholesale. The detail has done its job by then; it stays in the git history and the commit messages.

> Why not one file for both: a masjid on Development already reads the dev changelog in the same panel a Stable masjid reads the release notes. Detail there is useful — they opted into untested software. Detail on Stable is noise that buries the one line explaining why their display restarted.

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