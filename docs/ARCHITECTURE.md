<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Architecture & decisions — OpenMasjidOS

This records non-trivial architectural and naming decisions (per CLAUDE.md §19).
The authoritative product spec is `CLAUDE.md`; this is the "how + why".

## Stack (v0.2.0 — rebuilt to mirror umbrelOS)

OpenMasjidOS is a **TypeScript monorepo** (npm workspaces) shipped as **one Docker
image** that runs a Node daemon serving both the API and the built UI.

```
packages/core   Node 20 + Fastify + tRPC daemon (the "umbreld" equivalent)
packages/ui     React 18 + Vite + Tailwind v4 + Motion dashboard
```

- **API:** tRPC over HTTP for queries/mutations, and **tRPC over WebSocket** for
  live subscriptions (system stats stream every ~2s). Both share the `/trpc`
  prefix via `@trpc/server/adapters/fastify` with `useWSS: true` +
  `@fastify/websocket`.
- **End-to-end types:** the UI imports only the `AppRouter` **type** from the
  core (`import type`). No server runtime ever reaches the browser bundle. UI
  view-models are derived with `inferRouterOutputs` — never hand-duplicated.
- **Docker control:** `dockerode` for reads (container discovery, state, ports)
  and a thin `docker compose` shell wrapper for app lifecycle. All Docker access
  funnels through `packages/core/src/docker/`.
- **System stats:** `systeminformation`. Inside the container, `/proc` reflects
  the host for CPU/memory/uptime, so values describe the machine. CPU temp is
  reported "where available" (null otherwise). Disk reports the filesystem
  backing the mounted data dir.
- **Auth:** argon2id hashing (via `@node-rs/argon2`) + a random session token in
  an HTTP-only, **SameSite=Lax** cookie. Sessions are in-memory, so a core restart
  signs everyone out.
  - **Lax, not Strict, deliberately.** The dashboard is HTTPS but apps are served
    over HTTP, so clicking "Open" is a cross-scheme top-level navigation that
    browsers treat as cross-site. Strict withholds the cookie there and breaks SSO
    on the first open. Replay is blocked by the origin-bound dashboard key, not by
    SameSite.
  - **Secure is opt-in** (`OPENMASJID_SECURE_COOKIE=1`), off by default for the same
    reason: an app on a plain-HTTP port must still receive the forwarded cookie.
    Turn it on when the whole deployment is end-to-end HTTPS.
- **UI serving:** the daemon serves `packages/ui/dist` via `@fastify/static`
  with an SPA fallback to `index.html` for client routes; `/trpc` and `/api`
  never fall back.

## Key decisions

### Build: esbuild bundles the core; Vite builds the UI
`tsc` with CommonJS output + classic Node resolution can't read the package
`exports` maps that `@trpc/server/adapters/fastify` (and the Fastify plugins)
rely on. Rather than fight `module`/`moduleResolution` tensions, the core is
**bundled with esbuild** (`--format=cjs --packages=external`): esbuild resolves
`exports` maps at build time, inlines our relative imports (so there's no Node
ESM file-extension problem), and leaves `node_modules` external (required at
runtime). `tsc --noEmit` remains the type-check (`npm run lint`). The UI is a
plain `vite build`; type-only imports of the core are erased by esbuild, so the
UI build never needs the core's types resolved.

### Password hashing: @node-rs/argon2 (not the `argon2` native module)
CLAUDE.md names the `argon2` package, but its native addon must compile under
musl for the multi-arch (amd64 + arm64) Alpine image, which is slow and brittle
under QEMU. `@node-rs/argon2` ships prebuilt musl + glibc binaries (incl.
`linux-arm64-musl`, `linux-x64-musl`), so the image builds with **no native
compilation**. Same argon2id algorithm; drop-in for our needs.

### Runtime image: Alpine + docker-cli + docker-cli-compose
Mirrors the proven base from the previous Go build. The core shells out to
`docker` / `docker compose`, so the CLI + compose plugin must be present. The
healthcheck uses busybox `wget` against `/api/health`.

### Golden rule enforcement (never touch a user's app containers)
- The installer only ever operates on the core's own compose project
  (`--project-name openmasjid`). Apps are separate projects (`omos-<id>`).
- `apps/manager.listInstalled()` merges on-disk metadata with **live Docker
  discovery**: any running `omos-*` project without metadata is recovered and
  re-shown (and its metadata re-persisted). A running app can never silently
  vanish from the dashboard after a core update.

## Ports & data
- **HTTPS on 443** is the dashboard (`TLS_PORT`), behind a self-signed certificate
  that every device on the LAN accepts once. **80** (`PORT`) is an HTTP front door
  that 308-redirects browsers to HTTPS and carries the path-based app ingress plus
  the LAN-only Fabric routes, which app backends reach server-to-server and so
  cannot present a self-signed cert to. Both are published by `docker-compose.yml`.
- **Reached at `https://<server-ip>`.** There is no `.local` name: mDNS was never
  implemented (see `docs/NETWORKING.md`). `openmasjidos.local` appears only as a
  certificate SAN, so it will work the day mDNS is added. A masjid wanting a fixed
  address adds a DHCP reservation on their router.
- Data dir **/opt/openmasjid** → mounted at `/data`. Config in `/data/config`,
  per-app state in `/data/apps/<id>/`.

## Security posture

Trust model: one trusted admin behind a login; everything is same-origin. Notes
from the security audit (and the hardening applied):

- **App ids are strictly validated** (`^[a-z0-9][a-z0-9-]*$`) wherever they
  become a filesystem segment or compose project name — at the API schemas, at
  catalog ingestion (untrusted external data), and defensively in the apps
  manager (a path that would escape `APPS_DIR` throws). Prevents traversal via a
  crafted/poisoned id.
- **WebSocket Origin is validated** on the terminal endpoints and the tRPC WS in
  production. SameSite=Strict alone is insufficient because the cookie is
  non-Secure on plain-HTTP LAN and the browser "site" excludes the port (an app
  on another port of the same host would otherwise be same-site). Set
  `OPENMASJID_ALLOWED_ORIGINS` for reverse-proxy/HTTPS setups.
- **Compose risk-checks use ancestor matching** (not exact match): any bind under
  a sensitive root, the Docker socket, added capabilities, devices, host
  namespaces, and unconfined security opts are flagged and require an explicit
  acknowledgement before a custom/community app installs.
- **Community repo fetches are bounded**: SSRF guard (DNS-resolved private-range
  blocking, manual+revalidated redirects, http(s) only), a streamed download cap,
  a timeout, and filtered decompression — so a zip/decompression bomb can't OOM
  the root core.
- **Login is throttled globally, NOT per source IP**, and that is forced rather
  than chosen: with Docker's default `userland-proxy`, `docker-proxy` re-originates
  every inbound connection from the bridge gateway, so an app container, a laptop
  on the LAN and a client from the public internet all present the same address.
  A per-IP check would therefore answer "private" for everyone (`util/net.ts`, and
  `test/ip-private.test.ts` fails the build if `peerIsPrivate` reappears). What is
  in place: serialized verification, a growing per-attempt delay on consecutive
  failures applied outside the mutex so the admin is never queued behind an
  attacker's, and uniform-time password comparison. A hard lockout is **off by
  default** precisely because a global one would let an attacker deny the real
  admin; operators exposing the dashboard to the internet opt in with
  `OPENMASJID_LOGIN_LOCKOUT=1`.
- The root daemon installs `uncaughtException`/`unhandledRejection` guards and
  the terminal bridge handles stream errors, so a single failure can't crash the
  control plane.
- Supply chain: a CI `audit` job resolves the tree and fails on high/critical
  advisories. `package-lock.json` **is** committed and the image builds with
  `npm ci`, so the audit grades the tree that actually ships. The job is
  deliberately not a dependency of `build`: an advisory published overnight in a
  transitive dependency is not a reason the project cannot ship a fix.

Accepted tradeoffs (documented, not bugs): the session cookie is not `Secure` by
default so that HTTP-served apps still receive it for SSO (opt in with
`OPENMASJID_SECURE_COOKIE=1`); the dashboard's certificate is self-signed, so every
device meets one browser warning; and the core runs as root with the Docker socket
mounted — the standard single-host control-plane model, same as
CasaOS/Umbrel/Portainer.

### UI windows: a top-level window manager, separate from dialogs
In-dashboard windows (app shells, app logs, the root terminal, and file
viewers/editors) are owned by a **window manager** (`components/Windows.tsx` +
`WindowManager.tsx`) mounted once in `AppShell`, **above** the routed page. This
is deliberate:
- Windows survive route changes — minimizing a shell and navigating to Settings
  keeps it alive (and in the dock). Earlier these lived inside route components,
  so navigation unmounted them.
- Window content stays **mounted while minimized** (hidden with CSS), so a live
  terminal or log stream is never disconnected by minimize/restore.
- Windows are floating + draggable, stack by focus order (bounded z-index), and
  carry the macOS traffic lights (close / minimize / fullscreen).

`Modal` is now strictly a **centered dialog** (confirmations, short forms, the
3rd-party install notice) — no traffic lights, no minimize. The split keeps the
two concepts from bleeding into each other.

### File viewing/editing (sandboxed)
The file manager can edit text files and view images/video/audio. Two new
sandboxed paths, both confined to the data dir like the rest of the manager:
- `files.read` / `files.write` tRPC procedures (2 MiB cap; binary content — any
  NUL byte — is rejected for the text editor).
- `GET /api/files/raw` streams media **inline** with `Content-Type` from a
  known-media allowlist (anything else → `application/octet-stream`), plus
  `X-Content-Type-Options: nosniff` and a strict `Content-Security-Policy:
  sandbox` so user-supplied HTML/SVG can never execute scripts same-origin.

### A declared capability must be *asked about*, never silently dropped (v0.45.0)
A manifest field that the platform parses, publishes and then ignores is worse
than one it doesn't support: the app author believes the contract holds, the
admin is never told, and the failure shows up far away (an emailed link that only
works on the LAN). `tunnel: true` was exactly that — carried into `catalog.json`,
typed on `CatalogApp`, and read by nothing. The rule we settled on:

- The **default stays private**. `installCatalogApp` requires `expose === true`;
  a manifest request never auto-exposes. That invariant is unchanged.
- But the request must **reach the admin as a question**. An app with
  `tunnel: true` always opens the install dialog — including when it declares no
  `settings:`, which is precisely the one-click path that used to swallow it —
  with one pre-ticked, plainly-worded checkbox. Pre-ticked = "the app says it
  needs this"; the tick only takes effect because the admin pressed Install.
- The **recovery path must be findable**. Per-app sharing toggles moved out of the
  collapsed setup guide in Settings → Remote access, and the same switch (with the
  live public URL) now sits on the app's own detail page.

Generalise this when adding manifest fields: parse → surface → act. If a field
can't be surfaced yet, don't ship it in the spec.

### Compose gate: refusals vs. acknowledgeable dangers (v0.45.0)
`checkCompose` used to return one list, so every finding was negotiable — the
custom/community paths install anything once the admin ticks "I understand the
risk". That is right for "this app wants a host device" and wrong for "this app
attaches to another app's database", which has no legitimate use and whose whole
point is to breach an app boundary. `ComposeCheck` therefore has two lists:

- `dangers` — powerful but plausibly intentional; catalog installs block, custom
  and community installs proceed on an explicit acknowledgement (unchanged).
- `refusals` — never acknowledgeable, refused on every path including update and
  post-restore reup. Currently: a top-level volume using `external:` or `name:` to
  attach to an `omos-*` volume (another app's data, or platform infra). Neither
  form names a host path, so the bind-mount checks never saw them.

The gate also now re-runs on **update** (`updateCatalogApp`), which previously
wrote and started a refreshed catalog compose without re-checking it — the one
lifecycle path that skipped the gate that install and restore both apply.

### Backups fail loudly rather than succeed partially (v0.45.0)
A backup is only useful if "it worked" is true. Three defects made it possible for
a masjid to lose everything while the dashboard reported success every night: a
volume that failed to archive left its truncated `.tar.gz` in staging and was
ORed away; the outer `tar`'s exit code was unreachable (`backupStream` returned
`child.stdout` and dropped the process); and the off-site retention prune ran on
that unverified result, so N torn runs evicted every good archive. Now:

- `backupStream()` returns `{ stream, done }`. `done` carries the tar exit code,
  and a failure **destroys the stream** so no consumer accepts a truncated file.
- A volume that can't be archived fails the whole backup (its partial file is
  deleted). Being unable to *ask* Docker for the volume list is also a failure,
  not "there are none".
- `runBackup` requires `upload.ok && archive.ok` before recording success or
  pruning, and deletes the remote file if the upload outlived a bad archive.
- One backup at a time (`BackupBusyError` → HTTP 409): the manual download and the
  scheduler share a single fixed staging path and would corrupt each other.
- Restore stops apps before refilling their volumes, and reports per-volume
  failures instead of calling a restore successful because `config/` moved.

**Still open, and importantly NOT covered by the above.** Volumes are tarred live,
so a SQLite-in-WAL app can be captured mid-checkpoint. The trap is that **tar
exits 0 on a torn capture** — it read every byte it was asked for and nothing
failed — so `archive.ok` is structurally blind to it. Everything above hardens
*detectable* failure; a successful backup is still not proof the databases inside
will open. Say this plainly rather than letting the new exit-code plumbing imply
a guarantee it doesn't give.

The fix belongs to the apps, not the platform: each app snapshots its own SQLite
with `VACUUM INTO` so the volume always holds a byte-consistent copy whenever tar
runs (in progress for Students; Donations and Kiosk have identical exposure). The
core cannot do this on an app's behalf — it doesn't know which files in a volume
are databases, and has no safe way to open them. Resist adding a platform-side
check that *looks* like it covers this.

Also open: the archive is unencrypted while containing personal data, payment
keys, the tunnel token and the backup destination's own credentials. The UI now
says so at destination-choice time; `rclone crypt` is the real fix.

## Chargeback alerts: why the platform polls Stripe
A chargeback belongs to a Stripe **account**, and the Stripe vault exists precisely
so several apps can share one account. That settles two questions at once.

*Why not the donations app?* Whichever app raised the alert would be guessing on
behalf of the others — two apps on one account either double-notify or, if the one
that "owns" it happens to be stopped, nobody is told. Disputes also land days or
weeks after the payment, which is exactly when an app is most likely to be off. And
doing it in an app would mean a cross-repo contract change for something the platform
already has the credentials for.

*Why not a webhook?* Stripe would need a publicly reachable route on the platform.
The tunnel deliberately exposes only app paths plus two low-sensitivity public
endpoints (`/api/public/appearance`, `/api/public/logo`); a third would weaken that
invariant, and it would still leave every masjid without remote access getting no
alerts at all. Polling is outbound-only, adds no attack surface, and works on a box
that Stripe cannot reach. The trade is latency — up to one 30-minute interval —
against a dispute response window measured in days. That is a good trade.

This is monitoring, not payment processing, so it stays within the "payment-agnostic"
scope rule: no charges are created and no money moves. It reads dispute status using
credentials the platform already stores, the same way the Stripe status dot already
calls `/v1/balance`.

Two failure modes shaped the design. A failed poll records **nothing** — treating
"couldn't reach Stripe" as "no disputes" would mark unseen chargebacks as seen and
lose them for good. And state is **persisted**, unlike the update monitor's in-memory
tracking: "an update is pending" stays true and is safe to recompute, whereas a
chargeback is a one-shot event that would re-alert on every restart.

## Boot must degrade, never exit
The daemon runs under `restart: unless-stopped` on hardware that may be mounted on a
wall, so a boot failure is not a crash — it is a crash-*loop*, with no dashboard
left to repair the box from and no self-service installer path that helps (Update
and Repair both re-read the data dir that caused it). The TLS cert taught us this:
a corrupt-but-present `cert.pem` exited the process, because Node builds the TLS
context inside the Fastify constructor, outside the try/catch that wrapped reading
the file.

The rule we settled on: **anything boot-critical is validated before it is trusted,
and a failure degrades instead of exiting.** For TLS that means three layers —
`certPairProblem()` runs the same checks Node does, `ensureCert()` repairs damage
(quarantining it as `*.broken`) rather than passing it along, and `index.ts` rebuilds
the server without TLS if the constructor throws anyway. Plain HTTP is the last way
in, so it is a recovery mechanism and must not be removed; clearing `tls` on that
path also keeps the Cloudflare tunnel refused, since the tunnel must never carry the
dashboard. Two constraints that are easy to break by accident: a *healthy* cert must
be left byte-for-byte alone (regenerating it re-triggers the one-time browser warning
on every device on the masjid's LAN), and openssl's exit code is not evidence the
bytes reached the disk — a full disk gives you a clean exit and an empty file.

## Version
`VERSION` at the repo root is the single source of truth. The Docker build copies
it to `/app/VERSION`; the daemon reads it (`OPENMASJID_VERSION_FILE`). Shown in
Settings → Advanced.

---

## WhatsApp inbound: a Socket.IO client, not a webhook (v0.51.0)

Reading messages needs a connection to the gateway. We open one **outbound**, core →
OpenWA (`notify/whatsapp-inbound.ts`), in the same direction the send path already
runs. So the feature adds **no inbound route and no new attack surface**, and it works
on an install that predates it.

A webhook was the alternative and is worse *here*: it needs the core's LAN address baked
into the gateway's config, raw-body HMAC handling, a new public-ish route, and OpenWA's
own SSRF guard relaxed inside the masjid's compose file — four moving parts, each of
which a volunteer would have to get right.

**New dependency:** `socket.io-client` (MIT, AGPL-compatible). It is loaded with a
dynamic `import()` so a masjid with commands switched off pays nothing at boot.

The wire protocol is not in OpenWA's public docs, so it was read from its source:
namespace `/events`, one Socket.IO channel `'message'` carrying every frame, the
WhatsApp event name inside `payload.event`, and room-scoped delivery — you receive
nothing until you send `{type:'subscribe', sessionId, events}`. That frame's
acknowledgement is *returned* from the handler, which means a plain `emit` silently
discards it; it has to be read with `.timeout().emit(channel, payload, cb)`. Getting
any of that wrong looks identical to "connected and idle", which is why `onAny()` is
kept purely as a diagnostic listing what the gateway has actually sent.

## commands/: one direction of flow, each stage pure where it can be (v0.51.0)

The inbound path is deliberately a pipeline of small modules rather than one handler:

```
normalise → gate → parse → registry → execute → reply
```

`normalise` reads an unknown payload shape defensively and fails closed. `gate` is the
security boundary and is an ordered list of checks with `now` injected, so every step is
testable without a clock. `parse` returns intent and touches no I/O. `registry` answers
"what may this sender run". `execute` is the only stage with side effects, and `reply` is
pure string-building.

The split exists because the security properties live in the *order* of the gate and in
the purity of what surrounds it — both of which are easy to erode inside one large
function, and both of which are cheap to pin with tests when they are separate.

## fabric/proxy.ts: one HTTP client to apps (v0.51.0)

`proxyToTarget` was extracted from the app-to-app broker so the broker and the new
command dispatcher share a single outbound implementation — one place that sets
`X-OpenMasjid-App-Secret`, strips caller-supplied identity headers, caps the body, sets
the timeout, and refuses redirects. Two clients would eventually disagree about one of
those, and the disagreement would be a security bug rather than an inconsistency.

`PLATFORM_CALLER_ID = 'omos:platform'` lives here and is unforgeable **by construction**:
every app id is validated against `APP_ID_RE`, whose charset contains no colon, so no app
can ever present this value.

## system/app-host.ts: never loopback (v0.50.4-dev.3)

The core is a bridge-network container, so `127.0.0.1` inside it is *the core*. An app's
published port is on the **host**, reachable only through the installer's
`host.docker.internal:host-gateway` mapping. Three callers had this right and the
expression had been pasted into each; a fourth was later written from memory with
`127.0.0.1` and could not reach its target on any install. It is one exported helper now,
and `test/app-host.test.ts` fails any source file that builds a loopback URL to an app.

## system/update-lock.ts: one update at a time, enforced server-side (v0.50.4-dev.6)

Every WebSocket connection to the update endpoints used to start a *fresh* update, so
closing the progress window and pressing the button again ran a second update over the
first — two `compose up --force-recreate` racing for one container, two writers on one
compose file. The lock is on the server because the client-side guard (a locked dialog)
cannot survive a closed browser or a sleeping laptop. A refused second run is reported as
information, never as "Update failed": calling it a failure is what pushes an admin into
retrying.

## Path comparisons in security checks (v0.46.0, v0.51.0)

Fastify dispatches on the percent-**decoded** path, so any guard that compares `req.url`
verbatim can be walked past with an escaped spelling. This has now happened twice —
`/api/%66abric/…` past the Fabric LAN-only guard, and `/%74rpc/…` past the tRPC
cross-origin check — and a third variant needed dot segments resolved
(`/donate/./fabric/x` past the ingress refusal that keeps an app's own `/fabric` routes
off the public tunnel).

The rule: **compare every spelling the far end might resolve to, and fail closed.**
`system/via-tunnel.ts` owns `decodedPath`, `matchesSecretRoute` and `urlHasPrefix` so
there is one implementation; `test/path-spelling.test.ts` fails any source file that
calls `req.url.startsWith(` in a check.

## Light mode needs its own wallpapers (v0.51.0)

Nine `[data-wallpaper="…"]` blocks each set a dark scene, they sit after
`[data-theme="light"]` with equal specificity, and `data-wallpaper` is always set
(`prefs.ts` defaults it to `aurora`). So light mode never received a light scene: white
glass at 55% alpha over a near-black gradient composited to grey, with dark ink on top.
Nothing in the light palette was wrong — the cascade simply overrode it.

Each wallpaper now has a `[data-theme="light"][data-wallpaper="…"]` counterpart that wins
on **specificity rather than file order**, keeping the wallpaper's hue and inverting its
lightness so the picker means the same thing in both themes.
`test/theme-tokens.test.ts` fails if a wallpaper is added without one.
