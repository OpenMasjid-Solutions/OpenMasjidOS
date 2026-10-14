<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Architecture & decisions — OpenMasjidOS

This records non-trivial architectural and naming decisions (per CLAUDE.md §19).
The authoritative product spec is `CLAUDE.md`; this is the "how + why".

## Stack (v0.2.0 — rebuilt to mirror umbrelOS)

OpenMasjidOS is a **TypeScript monorepo** (npm workspaces) shipped as **one Docker
image** that runs a Node daemon serving both the API and the built UI.

```
packages/core   Node 22 + Fastify + tRPC daemon (the "umbreld" equivalent)
packages/ui     React 18 + Vite + Tailwind v4 + Motion dashboard
```

- **API:** tRPC over HTTP for queries/mutations, and **tRPC over WebSocket** for
  live subscriptions (system stats stream every ~2s). Both share the `/trpc`
  prefix via `@trpc/server/adapters/fastify` with `useWSS: true` +
  `@fastify/websocket` — on the HTTPS dashboard listener, and only there. The
  plain-HTTP front door (port 80, where the tunnel lands) serves no dashboard of
  its own: when remote administration is on, it HANDS a permitted request for the
  dashboard to the dashboard listener, in-process and unread, as that listener's
  own `request` (or, for a dashboard socket, `upgrade`) event — so the remote
  dashboard is the LAN dashboard, every route included. The last section of this
  file, *Remote administration*, records how the dashboard shares the apps'
  hostname safely and how the hand-over works. `@fastify/websocket` must NOT
  be registered on the front door: it claims every upgrade and broke every app's
  live socket over the tunnel (CLAUDE.md §13.2e and §15).
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
  an HTTP-only, **SameSite=Lax** cookie. Sessions are **persisted**
  (`config/sessions.json`) so a restart does not sign anyone out — when they were
  in memory, every update silently invalidated the admin's cookie and apps then
  refused single sign-on. Each session is bound to a fingerprint of the password
  hash that was actually verified, so any password change or reset (even from the
  installer, a separate process the daemon notices within a second) ends every
  older session; a restore ends them all at the next boot. CLAUDE.md §9 has the
  rules and the failures behind each.
  - **Lax, not Strict, deliberately.** The dashboard is HTTPS but apps are served
    over HTTP, so clicking "Open" is a cross-scheme top-level navigation that
    browsers treat as cross-site. Strict withholds the cookie there and breaks SSO
    on the first open. Replay is blocked by the origin-bound dashboard key, not by
    SameSite.
  - **Secure is opt-in for the LAN cookie** (`OPENMASJID_SECURE_COOKIE=1`), off by
    default for the same reason: an app on a plain-HTTP port must still receive the
    forwarded cookie. Turn it on when the whole deployment is end-to-end HTTPS.
  - **The remote dashboard has a cookie of its own.** On the masjid's network the
    session lives in `omos_session`; on the remote dashboard's hostname it lives in
    `__Host-omos_session` — always `Secure`, `Path=/`, no `Domain` — and a request
    the front door handed over reads that name and nothing else. The prefix is the
    point: the dashboard's hostname is a sibling of the apps' one, a sibling may set
    a cookie for the parent domain that the browser then sends to both, and a
    planted `omos_session` would shadow the real session. A browser refuses any
    `__Host-` cookie that names a `Domain`, so nothing outside the dashboard's
    hostname can plant or overwrite this one. A session minted over the tunnel by
    `completeLogin` also records `remote: true`, `tf` — the second-factor epoch it
    proved — and `handedOver`, whether the remote dashboard itself made it (persisted
    with it; only a literal `true` in the file counts for either flag). From the tunnel
    only such a session counts, and on the remote dashboard only one it made — see
    *Remote administration*.
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
  the LAN-only Fabric routes, which app backends reach server-to-server, where a
  self-signed certificate cannot be verified. It is also where the Cloudflare tunnel
  lands: both public hostnames — the apps' and, for remote administration, the
  dashboard's — point at HTTP `localhost:80`, and the front door's gate decides
  what each may reach. Both ports are published by `docker-compose.yml`.
- **Reached at `https://<server-ip>`** on the masjid's network (from outside, only
  with remote administration on, at the dashboard's own hostname — see the last
  section). There is no `.local` name: mDNS was never implemented (see
  `docs/NETWORKING.md`). `openmasjidos.local` appears only as a certificate SAN, so
  it will work the day mDNS is added. A masjid wanting a fixed address adds a DHCP
  reservation on their router.
- Data dir **/opt/openmasjid** → mounted at `/data`. Config in `/data/config`,
  per-app state in `/data/apps/<id>/`.

## Security posture

Trust model: one trusted admin behind a login. The dashboard's UI and API share one
origin, and no app is ever served on it — on the masjid's network every app has a port
of its own, and through the tunnel the apps have a hostname of their own (*Remote
administration*, at the end of this file). Notes from the security audit (and the
hardening applied):

- **App ids are strictly validated** (`^[a-z0-9][a-z0-9-]*$`) wherever they
  become a filesystem segment or compose project name — at the API schemas, at
  catalog ingestion (untrusted external data), and defensively in the apps
  manager (a path that would escape `APPS_DIR` throws). Prevents traversal via a
  crafted/poisoned id.
- **WebSocket Origin is validated** on the terminal endpoints and the tRPC WS in
  production. SameSite alone is insufficient — the cookie is Lax, and even Strict
  would not do — because the cookie is non-Secure on plain-HTTP LAN and the
  browser "site" excludes the port (an app on another port of the same host would
  otherwise be same-site). Set
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
  `OPENMASJID_LOGIN_LOCKOUT=1`. Sign-ins through the tunnel are the one place a
  per-address limit can work: Cloudflare sets `CF-Connecting-IP` at its edge and a
  tunnel client cannot forge it, so remote sign-ins also get a real per-IP lockout
  (`auth/ip-lockout.ts`). The address is trusted only when `isViaTunnel` is
  already true — off the tunnel that header is whatever the client wrote.
- The root daemon installs `uncaughtException`/`unhandledRejection` guards and
  the terminal bridge handles stream errors, so a single failure can't crash the
  control plane.
- Supply chain: a CI `audit` job resolves the tree and fails on high/critical
  advisories. `package-lock.json` **is** committed and the image builds with
  `npm ci`, so the audit grades the tree that actually ships. The job is
  deliberately not a dependency of `build`: an advisory published overnight in a
  transitive dependency is not a reason the project cannot ship a fix.

Accepted tradeoffs (documented, not bugs): the LAN session cookie (`omos_session`)
is not `Secure` by default so that HTTP-served apps still receive it for SSO (opt in
with `OPENMASJID_SECURE_COOKIE=1`; the remote dashboard's `__Host-omos_session`
always is); the dashboard's certificate is self-signed, so every device meets one
browser warning; and the core runs as root with the Docker socket mounted — the
standard single-host control-plane model, same as CasaOS/Umbrel/Portainer.

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
The tunnel deliberately carries only app paths, a few low-sensitivity public
presentation endpoints, the one-use address that opens an app for the remote admin
(`/_omos/open`), and — only when the admin switches remote administration on —
the dashboard, where everything past the sign-in
needs a session that passed the second factor. A route that accepts Stripe's POSTs
from anyone would weaken that, and it would still leave every masjid without remote
access getting no alerts at all. Polling is outbound-only, adds no attack surface,
and works on a box that Stripe cannot reach. The trade is latency — up to one
30-minute interval — against a dispute response window measured in days. That is a
good trade.

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
in, so it is a recovery mechanism and must not be removed. Clearing `tls` on that
path also means the core does not start the Cloudflare tunnel: without TLS the
dashboard listener itself sits on port 80, where the tunnel lands, with no front door
in front of it — and the tunnel may only ever reach the dashboard through the front
door's gate (*Remote administration*, below). Should a tunnel container already be
running (it is `restart: unless-stopped`), `registerHandoffOnlyGuard` refuses every
Cloudflare request the front door did not hand over, which in that topology is all of
them. Two constraints that are easy to break by accident: a *healthy* cert must be
left byte-for-byte alone (regenerating it re-triggers the one-time browser warning on
every device on the masjid's LAN), and openssl's exit code is not evidence the bytes
reached the disk — a full disk gives you a clean exit and an empty file.

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

**A core update, a restore and an app's update never overlap** (`EXCLUSIVE`, v0.51.2-dev.16).
The lock was per key, so different work still ran together, and a review pressed Update
300 ms into a restore: the update's helper replaced the core while the restore was still
refilling app data — the restore cut off part-way, every app left stopped, a database half
put back. `core` and `restore` each end by replacing the core, and a restore stops every app
and refills its data, so either is refused while any other key runs, and any key is refused
while either runs; two different apps' updates touch nothing in common and still run
together. Work refused for OTHER work is an `UpdateBusyError` with `clash: true` and a message
naming what is in the way ("A backup is being restored right now. Please update OpenMasjidOS
once it has finished. Nothing was changed."); the same work asked for twice keeps its own
message and `clash: false`. The windows tell the two apart: the core update closes 4001 on a
clash, because nothing is coming, but 1000 for a second request of the same update, because
that one may well restart the core and the window should watch for it as for its own; the
restore prints the clash and ends `unchanged`; an app's update ends 4001 either way (*Every
progress window is told how its work ended*, below). `test/update-lock.test.ts`.

**A core update or a restore keeps its lock until the core is replaced** (`withUpdateLock(key,
busy, fn, { holdAfter })`, `HOLD_UNTIL_REPLACED_MS`, v0.51.2-dev.16). Both end by handing the
core's replacement to a detached helper and returning, and the lock used to go with the
return. But the old core runs on for about twelve seconds after that: the helper sleeps two,
then `compose up --force-recreate` stops the old container with compose's ten-second timeout,
which the core sits out in full — it is Node as PID 1 with no SIGTERM handler, so the signal is
ignored and only the kill ends it. A review used that gap: pressing Update again launched
helper after helper (three in its probe), and a restore accepted there was cut off by the
replacement with one app's data half put back and every app left stopped. So `holdAfter(result)`
keeps the key in `inFlight` for that many milliseconds once `fn` resolves — `runUpdate` for
`restarting`, `runRestore` for `restarting` and `restarting-with-problems`, both for five
minutes — released by an unref'd timer (`__releaseHeldLocksForTests` ends it in a test).

- *Why a timer, rather than holding until the process exits?* The process exiting IS the
  release: the lock is in memory and dies with it, so for a replacement that arrives the timer
  never fires. It decides only what happens when none does — a helper whose `compose up`
  failed leaves the old core running, and nothing inside that core can tell a failed
  replacement from a slow one. Unbounded, that would refuse every update and restore — and,
  after a restore, every change on the dashboard (next section) — until someone restarted the
  box by hand. Five minutes is far past the twelve seconds and short enough that a failed
  restart costs little.
- *Why never after a failure?* A throw, `unchanged`, or a restore that ends `not-restarted` or
  `restored-not-restarted` means no helper is replacing the core. Nothing is coming, and holding
  would only refuse the retry.
- *What the hold says.* The work is done by then, so "being restored right now" would send the
  admin to wait for something that is not happening. While a key is held (`finishing(key)`),
  every refusal it causes says `finishingMessage(key)` — "OpenMasjidOS is restarting to finish
  an update." or "… to finish restoring your backup.", then "Please try again in a minute or
  two. Nothing was changed." — in place of the clash message, the same work's busy message,
  `assertAppFree`'s messages, the dashboard's restore refusal, the logo routes' and the
  restore upload's. Same work asked again is still not a clash, so the core update's window
  closes 1000 and watches for the restart that is coming. While the work is still RUNNING the
  earlier messages stand.
- Everything keyed on `isUpdating('restore')` — the dashboard's change refusal, the two-step
  refusal, the monitors standing aside (next section) — therefore lasts until the replacement
  too.

`test/update-lock.test.ts` (*A CORE UPDATE OR A RESTORE KEEPS ITS LOCK UNTIL THE CORE IS
REPLACED — not just until it hands that job over*); `test/remote-restore.test.ts` (*A RESTORE
THAT RESTARTS THE CORE KEEPS ITS LOCK UNTIL THE CORE IS REPLACED*).

**No app is started, installed or removed under a restore or its own update** (`assertAppFree(id,
'start' | 'install' | 'remove')`, thrown as `UpdateBusyError` with `clash: true`). The lock
covered updates and restores and nothing else, so an app could be started during a restore: a
review's probe had Start accepted mid-refill, its `compose up` running before that app's data
had finished going back. Worse, until the restore's last step the review verdict on a restored
app was the backup's (next section), so a compose that came in with the backup could be started
unchecked — `privileged: true`, host root — with no consent, from WhatsApp included, which must
never be able to give it. And Start during an app's own update brought up the compose the
update was about to put back. So:

- a **restore** refuses all three ("A backup is being restored right now. Your apps will start
  again on their own when it has finished. Nothing was changed." for a start; "Please install
  this app once it has finished" or "remove" for the others);
- that **app's own update** (`app:<id>`) refuses all three ("This app is being updated right
  now. Please try again once it has finished. Nothing was changed.");
- a **core update** refuses install and remove but allows a start. An install pulls images and
  writes files and a removal tears down containers, volumes and files, and either, cut off by
  the replacement, is left half done; a start is one quick `compose up` of a stack already on
  disk.

*Why in the manager, not the routers?* Every way an app is started goes through `startApp` or
`restartApp` — the dashboard, WhatsApp's `!os start` and `!os restart`, the address monitor's
restarts, Remote access's re-ups, the WhatsApp gateway's own start — exactly as every start goes
through `startBlockedReason`; a check in a router would cover the dashboard and miss the rest.
Installs go through `installCatalogApp` and `installStack`, removals through `removeApp`. It is
asked first, before anything is written, stopped or parsed (the test checks that `compose`,
`writeFile`, `saveMeta`, `stopProxy` and `parseFabric` all come after it), and `restartApp`
asks as a `'start'` because `docker compose restart` starts a stopped container. Every caller
handles the error: the apps router's `wrap` and the three install routers turn it into
CONFLICT (the WhatsApp gateway's restart passes it on as an error carrying the same message —
and during a restore the dashboard's change refusal, next section, answers first), WhatsApp's
commands reply with its message as information, and the address monitor and the Remote access
re-ups catch it and skip that app. *Why is stop never refused?* Stopping runs no compose and
writes no data; it is how an admin makes an app stop doing harm, and a restore stops every app
itself anyway.
`test/update-lock.test.ts` (*NO APP IS STARTED, INSTALLED OR REMOVED UNDER A RESTORE OR ITS OWN
UPDATE — stopping never is*).

## While a restore runs, nothing else moves (v0.51.2-dev.16)

A restore stops every app, swaps `config/` and `apps/` for the backup's, refills the apps'
volumes, starts them again and hands the core's replacement to a helper. A review raced each
step and found that everything else carried on around it. Apart from the lock and
`assertAppFree` (above):

**Every signed-in change is refused, in one place** (`noChangesDuringRestore`, `trpc/trpc.ts`;
`protectedProcedure = t.procedure.use(isAuthed).use(noChangesDuringRestore)`). A restore
replaces `config/` whole: a change made before the swap was overwritten by the backup's, and
one made after it wrote the store's pre-restore cache back over the restored file (below). The
review did both — a password changed and remote administration switched off during a restore
came back, after the restart, as the old password and an open door. So while
`isUpdating('restore')`, every protected MUTATION gets CONFLICT, "A backup is being restored
right now. Please try this again once it has finished." (the finishing message during the
hold). One middleware rather than a check per router: almost every protected mutation writes
under `config/` or acts on apps, and a list of the ones to refuse would miss the next one
added — so the list is of the two let through instead (`ALLOWED_DURING_RESTORE`, matched on
the procedure's path): `apps.stop`, because turning an app off must always work and is what
the restore does to every app anyway, and `apps.openRemote`, which only mints a one-use ticket
in memory and writes nothing. A mutation added later is refused until someone decides
otherwise, which is the failure to prefer. Queries and
subscriptions go on answering — looking changes nothing, and the dashboard keeps drawing — and
signing in and out are public procedures, not protected ones, so signing in keeps working, as
the second factor's restore rules expect (*Restore and backup from outside*, below). The logo
routes (`api/branding.ts`) write `config/branding/` outside tRPC, so their `guard` refuses the
same way: 409, the same message, after the origin, session and dashboard-key checks (a caller
who fails those learns nothing about a restore). The check is made when a call begins, so one
already running when the restore starts is not interrupted. Not covered, and accepted: the
File Explorer's writes — the masjid's own files; `config/` and each app's platform files are
refused to it anyway — and a root terminal. A backup is not among them: `backupStream` refuses
while a restore runs (`backupRefusal` — the download from outside asks before its headers go,
so the answer is still a proper 409), and a restore refuses while a backup is being made
(`BACKUP_RUNNING`, in the upload route and in `restoreOnce`), because each would otherwise copy
or replace data the other is using — and a backup taken half-way through a restore reported
success. `test/remote-restore.test.ts` (*A BACKUP AND A RESTORE NEVER OVERLAP*). `test/remote-restore.test.ts`
(*NOTHING IS CHANGED FROM THE DASHBOARD WHILE A RESTORE RUNS — looking is fine*).

**The restored settings are read again at once.** `settings/store.ts`, `store/email.ts`,
`store/stripe.ts`, `store/whatsapp.ts` and `store/commands.ts` each read their file once, when
the module loads, and serve that cache; each write persists the whole cache (`updateSettings`
writes `{ ...cache, ...patch }`). That read at boot is the hazard: after the swap the file was
the backup's and the cache the pre-restore one, so the next write from anything still running
— a theme change, an off-site backup recording its result, the WhatsApp client recording the
linked number — put the pre-restore settings back over the backup's. The review's probe changed
the theme mid-restore and got the root terminal back ON after restoring a backup where it was
off. Refusing dashboard changes (above) closes one writer, not all of them, so once `config/`
has been moved the restore calls `reloadSettings()`, `reloadEmailConfig()`,
`reloadStripeConfig()`, `reloadWhatsAppConfig()` and `reloadCommandConfig()`, and the rest of
the restore — and everything else until the core is replaced — runs on the backup's settings.
The admin store needs no reload (it notices a change made by another process, `refresh` in
`auth/store.ts`), and the second factor has its own hold and renewal (*Restore and backup from
outside*). What the daemon keeps as running state, written from memory rather than read as
settings — the WhatsApp queue, the WhatsApp health monitor's record — is not reloaded; a change
to it in the seconds before the core is replaced lands over the restored copy.
`test/remote-restore.test.ts` (*A RESTORE PUTS ITS SETTINGS IN PLACE AT ONCE — not at the next
restart*).

**Each restored app's compose is checked the moment `apps/` is in place** (`reviewEveryApp`,
straight after the swap, before `restoreVolumes`). `startBlockedReason` reads the persisted
verdict, `AppMeta.review`, and a restored `meta.json` carries the backup's — which a crafted
backup simply leaves out. `reupAllApps` re-reviewed every app, but only at the restore's last
step, so until then the backup's verdict stood. `assertAppFree` now refuses starts while the
restore runs, and this deliberately does not lean on it: a restore that fails part-way releases
its lock at once (a failure never holds), and one cut off by a power cut or a crash never
reaches `reupAllApps` — either way the backup's `apps/` stays on disk with whatever verdicts it
brought. Reviewing at the swap makes the verdict on disk this platform's own from that moment,
whatever happens next; `reupAllApps` still reviews again before it starts anything. A throw
while reviewing one app is logged and the loop goes on (`reviewCompose` itself records a
compose it cannot read as `unreadable`), and `reupAllApps` fails closed on it later.
`test/remote-restore.test.ts` (*A RESTORED APP'S COMPOSE IS CHECKED THE MOMENT IT IS IN PLACE —
not after its data is back*).

**The monitors stand aside.** `system/alert-monitor.ts`'s tick returns at once while a restore
runs: the restore pauses every app on purpose, and each pause read as an outage, so the
`app-offline` alert ("… has stopped", "Then press Start.") told the admin to start an app over
data still being put back. `stopAllApps` also marks each app it pauses with
`suppressOfflineAlert`, as an admin's own stop does. The off-site backup scheduler
(`system/backup-upload.ts`) skips its tick while a restore or a core update runs — the first
would copy data half put back, the second would be cut off by the core being replaced — and a
later tick (every 15 minutes) runs it. And the address monitor (`system/address-monitor.ts`)
skips its tick while a restore runs: it rewrites each app's `OPENMASJID_BASE_URL` in its `.env`
and restarts it, and during a restore that write lands in an `apps/` tree about to be swapped
out (its restart would be refused by `assertAppFree` anyway); the first tick after the restore
finds the difference again. `test/remote-restore.test.ts` (*NEITHER THE OFFLINE ALERTS NOR THE
OFF-SITE BACKUP RUN WHILE A RESTORE DOES*, which checks all three ticks).

**An app Docker would not stop is a problem, not a footnote** (`stopAllApps` returns the names
it could not pause). `composeStop` reports a failure in its exit code and never throws, so the
`catch` around it never fired, and a container Docker refused to stop was listed as paused
while its data was replaced under it. Now a non-zero exit prints "• <Name> (couldn't pause it —
its data may not restore cleanly)", logs a warning, counts towards `restarting-with-problems`
(close 4003), and is recorded as `appsNotPaused` in `config/restore-report.json`, which the
dashboard's reminder names ("These apps couldn't be paused for the restore, so their data may
not have been put back cleanly: … Please check them."). `test/remote-restore.test.ts` (*AN APP
THAT COULD NOT BE PAUSED IS NOT "COMPLETE" — its data may not have gone back cleanly*).

**A backup waiting to be restored never outlives its restore** (`RESTORE_PATH`,
`.restore.tar.gz`, and `.restore-staging`). Each holds a whole backup, unencrypted: every
password hash, key and token, possibly another box's. `restoreOnce`'s `finally` removes both,
but a restore refused by `withUpdateLock` never reaches `restoreOnce`, and the uploaded file
stayed in the data folder. Now `runRestore` removes it when the refusal is a clash with other
work, or comes while a finished restore is held (`err.clash || finishing('restore')`: that one
removed its own file on the way out, so the file is the refused request's) — but not while
another restore is still RUNNING, which is reading it. The upload route asks before
`req.file()`: while a restore runs or is held it answers 409 ("A restore is already running.
Please wait for it to finish.", or the finishing message), and while an update is in the way it
answers 409 with `clashFor('restore')` — so nothing is stored for a restore that would be
refused. A restore that never reached its `finally` (a power cut, a crash) left both for good,
so `removeRestoreLeftovers()` deletes them at boot, in `main()` once the data dir exists, when
no restore can be running, and logs "Removed <name> left behind by a restore that did not
finish." Meanwhile `files/manager.ts` refuses both to the File Explorer, like `.backup-staging`
("This is a backup being restored, so it is kept private. It is removed when the restore
finishes."), naming the paths rather than importing them so that backup and restore stay
independent of that module (CLAUDE.md §15). Left: a file uploaded and then never restored —
the window closed between the upload and the run — stays until the next restore or the next
boot. `test/remote-restore.test.ts` (*A RESTORE REFUSED FOR AN UPDATE IN ITS WAY SAYS SO, AND
LEAVES NO BACKUP BEHIND*, *WHAT AN UNFINISHED RESTORE LEFT BEHIND IS REMOVED AT BOOT*);
`test/files-guard.test.ts` (*a backup waiting to be restored, and its unpacked copy, are
private*).

## Path comparisons in security checks (v0.46.0, v0.51.0, v0.51.2)

Fastify dispatches on the percent-**decoded** path, so any guard that compares `req.url`
verbatim can be walked past with an escaped spelling. This has now happened twice —
`/api/%66abric/…` past the Fabric LAN-only guard, and `/%74rpc/…` past the tRPC
cross-origin check — and a third variant needed dot segments resolved
(`/donate/./fabric/x` past the ingress refusal that keeps an app's own `/fabric` routes
off the public tunnel).

The rule: **compare every spelling the far end might resolve to, and fail closed.**
`system/via-tunnel.ts` owns `decodedPath`, `matchesSecretRoute` and `urlHasPrefix` so
there is one implementation; `test/path-spelling.test.ts` fails any source file that
calls `req.url.startsWith(` in a check, except the one raw comparison it allows by name
— the request-target guard's `startsWith('/')`, which asks whether the raw target is a
path at all.

**"Fail closed" points in a different direction for each question, and remote
administration got both directions wrong once.** A predicate that ALLOWS — serve the
dashboard's pages (`isDashboardPath`), hand a socket to the dashboard
(`claimsDashboardSocket`) — must hold for EVERY spelling. A predicate that decides
whether a GATE applies at all (`touchesDashboardPath`) must trigger on ANY. With `every`
deciding whether the front-door gate looked at a request, `/%74rpc/auth.me` (raw first
segment `%74rpc`) was "not a dashboard path", passed straight through, and the router —
matching the decoded path — handed it to tRPC: the dashboard API over the tunnel with
remote administration switched OFF (found and fixed in dev.15). And with `some`
deciding whether to claim a socket, `/<private app>/../trpc` resolved to `/trpc` and was
claimed and answered by the dashboard while the private app's own path was destroyed on
the spot — so the difference told a stranger which apps were installed. A declined app's
socket now takes the same path as an address with nothing at it, and the claim needs
every spelling. Before reusing a spelling-aware predicate, check which way it has to
fail.

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

## Remote administration: one address, kept apart by the key (v0.51.2-dev.16, dev.17)

Remote administration serves the dashboard over the Cloudflare tunnel, behind a switch
that is off by default. CLAUDE.md §13.2e and §15 hold the rules and `docs/REMOTE_ADMIN.md`
the design history; this records the shape it settled on, because the first shape had a
flaw that no check inside the dashboard, as it then was, could have closed. dev.16 closed it
with a second hostname; dev.17, at the masjid's request, went back to one and closed it with
the key rule instead.

### A browser's boundary is the origin, never the path

The first versions (dev.13–dev.15, and dev.16 as first written) served the remote
dashboard at the root of the hostname the apps are published on —
`https://omos.example.org/` — with every app beside it at `/<path>/`. An adversarial
review showed what that meant. A browser draws the line around "this site's own data" by
scheme + host + port, and the path is not part of it, so every app page was the
dashboard's own ORIGIN. A script on one — in any app the admin opened, or injected through
a cross-site-scripting bug in any public app page — could read the dashboard key out of
`localStorage`, send same-origin requests that carried the admin's cookie, pass the origin
check (Origin and Host agreed) and drive the whole admin API — and, in the dev.16 draft,
which had just made them reachable from outside, switch the root terminal on and open it
(host root — the core holds the Docker socket), or download a backup (every secret on the
box). dev.13–dev.15 kept those two on the LAN, but the tRPC API alone reached host root
there too: switch custom apps on, then install a privileged compose with the risk
acknowledged.

The dashboard key's defence (*replay is blocked by the origin-bound dashboard key*, under
Stack) rested on no app being able to READ the key. On the masjid's network that holds
without anyone arranging it: the dashboard is `https://<ip>`, each app
`http://<ip>:<port>`, and a different port is a different origin, whose storage an app
cannot read. Through the tunnel there are no ports to tell them apart.

### dev.16: a second hostname (superseded)

dev.16 drew the line with a second Cloudflare public hostname for the dashboard alone, the
*Dashboard address* (`settings.cloudflare.adminHost`, e.g. `admin.example.org`): the
dashboard was served only there, no app ever was, the two had to differ in every spelling,
and without one there was no remote administration. It was sound, and the masjid rejected it
as one more thing to set up in Cloudflare, remember and manage. All of it is deleted in
dev.17 — the setting, `adminHost()`, `isAdminHost()`, `validateAdminHost()`,
`remoteDoorOpen()`, `doorClosedReason()`, and the refusal reasons `no-admin-host`,
`dashboard-elsewhere` and `app-on-admin-host`. A box that kept the second hostname in
Cloudflare is still served there: nothing looks at the hostname now.

### The decision (dev.17): one hostname, and a key no page there can reach

The dashboard is served at the root of the apps' hostname (`settings.cloudflare.domain`,
*Your apps’ address*) again, so every app page IS its origin and can send requests carrying
the admin's cookie that pass the origin check. dev.13–dev.15's hole was not the shared
origin by itself but that the KEY sat in that origin's `localStorage`. So, for a request the
front door handed over (`wasHandedOver`):

- **the remote dashboard never stores the key** (`ui/src/lib/session.ts`: in memory whenever
  the page carries `<meta name="omos-key">`, and an old stored key is removed);
- **a reload gets it back from the page itself, only for a load the browser marks as its
  own** (`api/static-ui.ts` `registerRemoteDashboardPages`: the key is written into
  `index.html` only with `Sec-Fetch-Dest: document` + `Sec-Fetch-Mode: navigate` and a live
  remote session through an open door — never to a fetch, a frame or an embed);
- **nothing can hold that page**: COOP `same-origin`, `X-Frame-Options: DENY`,
  `frame-ancestors 'none'`, `no-store`; and the ingress strips COOP from every app response
  (`responseHeadersForTunnel`), so an app page can never share a browsing context group with
  it and loses any window it opened on it;
- **nothing else hands it out**: `auth.me` never returns it and, from outside, answers a call
  without it as signed out (an app page could otherwise read the admin's profile); the File
  Explorer's inline view is `Referrer-Policy: no-referrer` (its address carries `?k=`); and
  the dashboard's page segments joined the reserved app paths, so no app can stand at
  `/settings`.

`remoteAdminEnabled()` is four conditions again, all re-read on every request — the tunnel
on, the switch on, a second factor, an admin — and it is the question every long-lived
connection keeps asking (below). Safari before 16.4 sends no `Sec-Fetch-Dest`, so it gets no
key with the page and signs in again after every reload from outside.

What it costs, against dev.16 (*Accepted residuals* has the list): the boundary rests on
browser behaviour (Sec-Fetch metadata, COOP) rather than the origin; an app page can call
the dashboard's PUBLIC procedures as the admin's browser (`auth.logout`; failed logins that
trip the per-address lockout), write the dashboard's display preferences, and phish at the
same address; and a worker an older build let an app register over `/` now covers the
dashboard.

**Rejected alternatives.**

- *One hostname, the dashboard under a path, the key in storage* (dev.13–dev.15). A path is
  not a boundary.
- *A second hostname* (dev.16). Sound, and rejected by the masjid as one address too many.
- *One hostname, every proxied app page sandboxed* (a Content-Security-Policy `sandbox`
  directive). The opaque origin that would cut a page off from the dashboard cuts it off
  from its own storage and cookies too — which breaks the apps.
- *A hostname per app* (each app at a subdomain of its own). It would isolate the apps
  from each other as well, which this design does not (see the residuals), but it needs
  wildcard DNS and certificates, and it changes every public app address a masjid has
  already printed and shared.
- *One session cookie for the parent domain* (a `Domain` naming the masjid's domain), so a
  sign-in reaches both hostnames. It would go to every hostname under that domain — their
  website and anything else they run there — and to every app again. (This is the
  alternative to the per-app tokens below.)

**Saving the address: check everything, then write** (`cloudflare.save`). It works out the
final apps' address, checks the tunnel token (next paragraph), and only then writes the token
and one `updateCloudflare` patch, so a refused save changes nothing. (dev.16's version also
validated the dashboard address; its first cut wrote the apps' address before refusing the
dashboard one, which three reviewers found separately.) The apps' address may be changed from
outside: Cloudflare, not this setting, decides which hostname reaches the box, so a typo breaks
*Open* and the apps' public links until it is put right, never the dashboard. The panel sends
the address only when it was edited (sending whatever the field held put back a value from
when the page loaded, undoing a change made on another device — every shared app's public
links with it), refills it from what the server stored after a successful save, and after a
refused one re-reads the status while leaving what was typed in the field. Three of the actions that shut
the door from outside — remote access off, managing from outside off, removing the tunnel — ask
first there (`ConfirmDialog`), because only someone at the masjid can undo them; at the masjid
they stay one click, since the control that undoes each is beside it. Two of them — remote
access off and removing the tunnel — usually never get their answer when confirmed from
outside: they take down the tunnel the answer would travel on, and Cloudflare sends its own
error page instead. So for those two a failure that is not the server's own tRPC error is
taken as the action having worked ("Done — this window can't reach the dashboard any more…"),
where it used to be shown as a raw error with the dialog still armed to do it again.
(Switching managing from outside off closes the open sockets, not the request that asked, so
its answer arrives.) Turning two-step sign-in off has a dialog of its own, which takes the
password and a current code; from outside it says the window is shut out at once, points
someone changing phones at *Use a different phone* (which keeps them signed in), and says only
someone at the masjid can turn it back on.
`test/remote-settings.test.ts` pins the save.

**The tunnel token: from outside only the one in use, and everywhere only a whole one.**
Saving a token recreates the `cloudflared` container — from outside, the very connection the
request came through — and a token for another tunnel, a stale one or half of one connects
nowhere useful while the platform logged "Cloudflare tunnel is running." (now "started", with
Settings saying it isn't connecting — below): the container is up,
and under `restart: unless-stopped` it retries for ever. Done from outside, that took the
admin's window and every shared app offline until someone at the masjid put the right one
back, and the first cut listed it as an accepted residual. Now, from outside
(`ctx.handedOver`), any token but the current one is FORBIDDEN — re-pasting the current one
changes nothing — and the panel disables the field there with a hint. Everywhere,
`normalizeTunnelToken` (`system/cloudflared.ts`) refuses anything that is not a whole token
(base64 of JSON with `a`, `t` — a UUID — and `s`) before a byte is written, and reduces
Cloudflare's whole install command (`… --token X`, `--token=X`, `service install X`), which is
what its page shows, to the token in it. It REPAIRS one thing: a token whose `=` padding was
left behind. cloudflared decodes tokens with Go's padded standard base64, which refuses a final
block without its padding (or with too much), while Node's decoder accepts both — so the shape
check passed tokens cloudflared then refused, and a double-click selection, which takes letters
and digits only, takes all of a token but its padding. So trailing `=` are stripped and put
back by length (two short → `==`, one short → `=`; a length of 4n+1 cannot be base64 at all
and is refused) — which repairs too many `=` the same way — and `isTunnelToken` accepts only
the canonical form: a whole number of four-character blocks that encodes back to exactly
itself. From outside, the token in use re-pasted without its padding is that same token:
accepted, and nothing changes. And `cloudflaredRunning` asks `tunnelContainerUp(state)` —
`Running` and not `Restarting` — because a refused token is precisely a container in its
restart loop, which Docker reports as Running too: Settings showed a green "Tunnel is running."
over a tunnel that never connected. Correcting that left the other half of the hint wrong: a
tunnel switched on but not up fell through to "Tunnel is set up but turned off." beside a
switch that was on. It now says "Tunnel is turned on but isn't connecting. Check that the
tunnel token is the right one." (`settings.cfNotConnecting`);
"turned off" is kept for a tunnel that is. The red dot was already right. And the daemon's own
line on starting the container says "Cloudflare tunnel started." (`ensureCloudflared`): it was
"Cloudflare tunnel is running.", which a refused token got too, and the daemon knows only that
it started the container, not whether it connected. `test/remote-settings.test.ts` covers the
token checks, and pins `tunnelContainerUp` and which hint a tunnel that is on but not up gets
(*a tunnel stuck restarting on a refused token is not shown as running*); the log line is not
pinned.

### The front door decides, and hands over

The front door registers no dashboard routes. Its gate is one pure function,
`frontDoorDecision`, called by index.ts and by the tests alike: `pass` (not a dashboard
path under any spelling — `touchesDashboardPath`), `lan-https` (LAN traffic: 308 to the
HTTPS dashboard, as always), `refuse`, `upgrade` (a plain `http://` tunnel visit: 308 to the
same path on the CONFIGURED apps' hostname, never one taken from the request), or `serve` —
on whatever hostname the tunnel delivered. A refusal while the door is shut is recorded as
`lan-only-route`; `plain-http-no-host` is a plain-`http://` visit with no apps' hostname to
upgrade to, or a request target that cannot safely follow one (beginning `//`). (dev.16 also
had `no-admin-host` and `dashboard-elsewhere`, both gone with its second hostname.)
Every dashboard path is answered by the gate itself rather than left to fall through, because
a registered route skips the not-found handler — which is how the very first cut served the
dashboard over plain HTTP on the LAN (CLAUDE.md §15). Every refused tunnel request is answered
by one responder, `refuseOverTunnel`: there were five copies, and they had drifted — the
not-found handler gave a browser an HTML page while the gate and the Fabric guard gave it
JSON, which told a visitor what kind of address they had hit. Its recording half is a function
of its own, `recordRefusal`, because one answer is recorded without being a refusal: a
worker-script fetch at a bare address, which gets the self-removing worker (*What an app
sees*, below) from `answerBareWorkerFetch(req, reply, { record })`. Both its callers — the
ingress for a routed app, the not-found handler for everything else — pass whether the request
came through the tunnel, so one from the office gets the same answer but is not written into
*Recently turned away*: Settings presents that list as what arrived through the internet link.
(An earlier cut gave `refuseOverTunnel` itself a `record` option for this one caller; once the
answer stopped being a 404, the option went.)

A served request is **marked** (`markHandedOver`) and emitted, body unread, as the
dashboard listener's own `request` event. Its hooks run there exactly as on the LAN — the
request-target guard, the Fabric guard, the origin check — and since it still carries
Cloudflare's headers, every route behind them applies the tunnel's session rule. A
dashboard socket (`DASHBOARD_SOCKETS`) is claimed by the ingress's upgrade handler only
when `claimsDashboardSocket` says so — it asks `frontDoorDecision` itself, needs EVERY
spelling of the URL to be a dashboard socket (*Path comparisons*, above), and needs a live
remote session (*Connections that outlive the check*, below) — and is then marked, tracked
and emitted as an `upgrade` event. On dev.13–dev.15 the front door
registered tRPC and the built UI itself instead: a second copy of the dashboard, and only
part of one, since everything under `/api` stayed on the LAN listener — the remote admin
could look at the dashboard but not update an app or open a file.

**The mark is the one signal nobody can send.** It is a `WeakSet` of Node requests that
only the front door adds to, and only for what its gate decided to serve. Headers say
"this came through Cloudflare", and anyone on the LAN can send headers; the mark says "the
remote-administration gate let this in". Everything remote-specific on the dashboard
listener keys off it (`wasHandedOver`): which cookie is read, which sessions count (only one
the remote dashboard made — `Session.handedOver`, under *Remote sessions*), the door re-check
on every protected call, the anonymous body limit, the CDN `no-store` headers, and the backup
download that starts answering before the backup exists.

**"From outside" is the hand-over, never a header.** Everything the dashboard DOES
differently for a remote admin keys off the mark as well: `auth.me`'s `remote` and
`appOrigin` (`ctx.handedOver`), which decide how Open works and whether the upload screens
warn about Cloudflare's 100 MB limit; `apps.openRemote`, which refuses a request that was not
handed over; `cloudflare.save`'s refusal to replace the tunnel token; the key rule's page
(`registerRemoteDashboardPages`) and `auth.me`'s answer without the key; and the restore's
from-outside check (`wasHandedOver(req.raw)` in `api/restore.ts`).
They used to read `viaTunnel`, which is also true behind a reverse proxy the masjid runs on
its own network — nginx, Caddy and Tailscale Serve all send `X-Forwarded-Proto: https` — and
answering "remote" there sent every Open button down the from-outside path, where it was
refused: at the masjid, for every app. The refusal to move the box to a version that cannot be
managed from outside was keyed on the mark from the start, in the core update
(`wasHandedOver(req.raw)` in `api/update.ts`) and the channel switch (`ctx.handedOver`;
*Updates from outside*, below). The SECURITY rules keep `viaTunnel` on purpose,
because there "looks like the tunnel" has to mean "demand more": the second factor at
sign-in, the per-address lockout, marking a session remote, the first-run refusals and the
session rule (`getSessionUserFor`). So a request that only looks remote — one reaching the
dashboard's own port through such a proxy — meets the stricter rules and none of the remote
behaviour. The two signals meet in the session rule: `viaTunnel` demands a session that
passed the second factor, and the mark demands, on top, one the remote dashboard made.

**The handoff-only guard** (`registerHandoffOnlyGuard`, on the dashboard listener) refuses
any request carrying `cf-ray` that the front door did not hand over, and closes such an
upgrade rather than answering it. The tunnel is meant to point at port 80. Pointed at the
dashboard's own port instead — one wrong field in Cloudflare — every dashboard route would
answer the internet directly, switch off and the key rule's page unserved; sessions would still
need the second factor, but "off by default" would be a sentence in Settings rather than a
fact. `cf-ray` is set at Cloudflare's edge and never sent by a browser on the masjid's
network, so this refuses exactly the misrouted traffic. It is the second hook on that
listener, straight after the request-target guard and before any plugin, and it records the
refusal as `wrong-port`, so *Recently turned away* names the misconfiguration (a Cloudflare
hostname pointed at 443) rather than calling it "Local network only".

### Remote sessions, and a second factor that can be replaced

From the tunnel only a REMOTE session counts: one minted by `completeLogin`, the second
factor passing over the tunnel, which records `remote: true`; `tf` — the epoch of the factor
configuration the code was checked against, taken from the verification (`VerifyResult`'s
`epoch`) rather than read when the session is written, the same rule as the password binding
(CLAUDE.md §9); and `handedOver` — whether the front door handed that sign-in over, i.e. the
remote dashboard made it. The one other remote session is the replacement a password change
made from outside mints for its caller, which carries exactly what the OLD session was granted
(`remoteGrantOf` → `{ tf, handedOver }`), never what is current at that moment. Every
dashboard route asks through `getSessionUserFor(token, { viaTunnel, handedOver })`, which reads
a LAN session as signed out from the tunnel, and leaves it working on the LAN; for a
handed-over request it also refuses a remote session the remote dashboard did not make, and the
tRPC context and the raw routes (`api/ws-auth.ts` `requestUser`) also require
`remoteAdminEnabled()`.

**A sign-in through a reverse proxy at the masjid is never usable from outside**
(`Session.handedOver`). Such a proxy sends `X-Forwarded-Proto: https`, so `viaTunnel` is true
behind it, its sign-in demands the second factor, and the session is `remote` — it goes on
working through that proxy. But it lives in the LAN cookie, `omos_session`, on the proxy's
hostname, and every app opened from that page receives it, since cookies ignore ports. An
access token is computed from the session token by a public formula (*Opening an app from
outside*, below), so any of those apps could make a token for EVERY app and present it through
the tunnel, private apps included — a review proved exactly that. So `isRemoteSession` — the
question behind the remote dashboard's routes and sockets, the sweep, `claimsDashboardSocket`
and `mintAppTicket` — and `appAccessToken` / `appAccessUser` honour only a session with
`handedOver`. `createSession` requires the flag beside `remote: true` and `tf`, so no caller
can forget to decide. `test/remote-apps.test.ts` (*A SIGN-IN THROUGH A REVERSE PROXY AT THE
MASJID IS NEVER USABLE FROM OUTSIDE*).

**The second factor has an epoch** (`secondFactorEpoch()`), re-randomised whenever what
counts as a second factor changes: an authenticator enrolled, backup codes replaced,
emailed codes switched on or off, two-step sign-in turned off — and when a restore puts a
backup's settings in place (*Restore and backup from outside*, below). A remote session is honoured
from the tunnel only while its `tf` matches, so replacing a lost phone, or burning backup
codes someone found, shuts every remote session made with the old ones out at once — they
used to run their full seven days, files and terminals included. The admin who makes the
change from outside keeps theirs (`rebindRemoteSession`), because they are usually reading
its result: backup codes, shown once. Random rather than a counter, so a restored file can
never collide with a value a later change produced.

**The epoch ends remote use, not the session.** `getSessionUserFor` consults `tf` only for a
request from the tunnel; on the masjid's network a session is bound to the password alone
(`cred`), because signing in there has never needed the second factor. So a session shut out
by a factor change is still honoured if it is ever presented on the LAN, and a password
change remains the one thing that ends sessions everywhere. Deliberate, and listed under the
residuals below rather than left implied.

**A change to the second factor re-proves the admin against the factor as it stood when the
change began** (`requireSudo`, `trpc/routers/twofactor.ts`). It captures the epoch and
whether two-step sign-in is active BEFORE the argon2 verify, and refuses with CONFLICT if
either moved meanwhile. Before it did, an admin turning two-step sign-in off to evict someone
could lose a race to that someone — holding a remote session and the password — whose own
change, begun a moment earlier, then found nothing enrolled, skipped the code, switched
emailed codes back on and kept their session under the new epoch: the door open again with
them inside, and the admin told it was shut. A review reproduced it three times out of three.
(That exact route is now shut a second way, because emailed codes need an authenticator —
below; the check stays, since it is what keeps any factor change honest about the factor it
was proved against.) The password half was already read fresh and compared again after
argon2, the same rule as signing in. And while a restore runs, `requireSudo` refuses before it
starts and again once the password has been checked (*Restore and backup from outside*,
below).

**An emailed code is bound to where it goes**: the admin's address and the mail account it
is sent through (`emailDeliveryFingerprint` — the provider plus the SMTP host, port, TLS
setting and user, or a hash of the Resend key; not the From address, not the SMTP
password). Either can be changed by any signed-in session, and on the LAN that is a
password-only one — so without the binding it could quietly redirect the next sign-in code,
and the factor would no longer mean what the admin switched on. Be exact about what that
buys: the binding is not what keeps a dashboard session at the masjid from reaching remote
access, because such a session can download a backup, which holds the authenticator's secret
along with every other one. What two-step sign-in protects is remote access from someone who
knows the password but cannot reach the masjid's network (`emailBinding` in
`auth/twofactor.ts` says the same). A change PAUSES emailed codes (`emailPaused`, which the
two-step panel shows); switching them back on takes the password and a current code. When they
cannot be switched on at all, the status says which half is missing (`emailMissing`: the mail
provider or the admin's address), so the panel asks for the right one — it used to send an
admin with a provider but no address off to set up a provider.
Configurations from before the binding are bound where they stand at boot
(`adoptLegacyEmailBinding`) — never from a read, because a status check must not change
security state.

**Emailed codes are a backup to an authenticator, never the only factor — and the server
says so, not just the screen.** `setEmailFactor` refuses to switch them on (PRECONDITION_FAILED)
unless an authenticator is enrolled. Settings had only ever offered them that way, but nothing
enforced it, and as the only factor they undo the binding above: a change of address pauses
them, nothing is then enrolled, the next change to the factor needs only the password
(`requireSudo` has no code to ask for), and that change could switch them back on bound to the
new address. With an authenticator always present, turning them back on always needs a
current code, and a pause never leaves the admin without a factor.

**When the phone AND the backup codes are gone, the way back is the installer's Reset
sign-in** (`reset-auth.ts`). Every change made in the two-step settings asks for a current
code once one is enrolled (`requireSudo`), on the LAN as well as from outside — that is what
stops a borrowed session or a known password re-enrolling the factor into someone else's
phone there — so an admin with neither had no proper way to remove or replace it. (A restore
at the masjid replaces the factor with the rest of `config/` and asks for no code; see the
residuals.) Reset sign-in now asks,
only while two-step sign-in is active and defaulting to no, whether to turn it off as well
(`disableTwoFactor`, which also starts a new epoch). It is safe to offer there and nowhere
else: whoever runs it has a terminal on the box. The password-only `reset-password.ts` still
leaves the factor as it is, and when one is active says to use the full reset.

### Opening an app from outside: a ticket, then a token for one app

The dashboard's cookie never reaches an app — the ingress removes it (*What an app sees*,
below) — and so an app has nothing from the admin's browser to go on: one that is not shared
online cannot tell the admin from a stranger, and one that signs the admin in through the
platform has no cookie to forward. So (`system/app-access.ts`):

1. Open, on the remote dashboard, asks `apps.openRemote` for a TICKET for that one app
   (`mintAppTicket`): 32 random bytes, single use, `TICKET_TTL_MS` (60 s), at most 200
   outstanding, and only for a request the front door handed over (`ctx.handedOver`), from
   a live remote session the remote dashboard made, with remote administration on and an
   apps' address set, for an installed app with a web port.
2. The dashboard opens a new tab FIRST, blank, while the click is still a click (a pop-up
   blocker allows a new tab only then), cuts its `opener`, and sends it to
   `https://<apps' hostname>/_omos/open?t=<ticket>` (`lib/apps.ts`).
3. `registerAppOpen`, a platform route on the front door, spends the ticket — gone whether
   or not it was still valid — sets
   `omos_session=<access token>; Path=/<app path>; Max-Age=<…>; Secure; HttpOnly; SameSite=Lax`
   (`Max-Age` no longer than the session it came from) and 303s to `/<app path>/`. Off the
   tunnel it is a plain 404; with remote administration off, it is the ordinary tunnel
   refusal; a spent, expired or unknown ticket — or one whose session
   has ended since — gets a plain 410 page saying to press Open again. (That 410 is only ever
   given while the door is open, so it tells a stranger whether remote administration is on;
   see the residuals.) `_omos` can never be an app path: only the shape of an app path is
   ever routed (*App addresses*, below).

**The access token** (`auth/sessions.ts` `appAccessToken`, `appAccessUser`) is
`a1.<session handle>.<MAC>`. The handle is a truncated SHA-256 of the session token, which
names the session without being able to use it; the MAC is HMAC-SHA256 keyed by the
session token over the app's id. The construction is the design:

- **One app.** The MAC covers the app id and is compared in constant time, so a token
  opens the app it was made for and no other. It cannot be turned into another app's
  token, or back into the session.
- **No longer than its remote session.** It is checked against the live session it names —
  the same password, the same second factor, not signed out, not expired, made by the
  remote dashboard — so whatever ends that session ends every token derived from it, with
  no table of tokens to store, persist or revoke. Remote administration must be on as well
  (`appAccessFromCookie`, `appAccessSsoUser`).
- **Not a dashboard session.** No dashboard route accepts it.
- **Cheap to refuse.** Finding the session a token names used to cost a SHA-256 per stored
  session for every token-shaped value, and a review measured ~5 ms of the daemon's single
  thread for one request carrying a 16 KB Cookie header of them. Now handles are memoised per
  token (`sessionHandle`, pruned to the live sessions whenever the memo outgrows them), and
  `appAccessFromCookie` tries at most eight `omos_session` values per request
  (`MAX_TOKEN_CANDIDATES`) — after the cheap tests, so a request with no such cookie, or with
  remote administration off, pays nothing at all.

*Why not give apps the dashboard's session, as the LAN does?* Through the tunnel that
session opens files, terminals and backups from the internet, and every app shares one
origin on the apps' hostname: handing it to them would put the admin's remote access in
every app, and in any script injected into any of them. An app that holds an access token
holds a key to itself and nothing more. *Why `Path=/<app path>`?* The apps share a
hostname, so a cookie for `/` would go to every one of them; scoped to its path, the
browser sends each app only its own token, and `HttpOnly` keeps it away from every page's
script. Single sign-on needs no app change: `GET /api/auth/session` (LAN-only, app secret)
accepts the token for the app it was made for (`api/fabric.ts`), and every OpenMasjid app
already forwards the first `omos_session` it finds.

### What an app sees through the tunnel

- **Requests, on the HTTP and the WebSocket path alike** (`cookieHeaderForApp`): every
  platform session cookie — `omos_session` of any value, and `__Host-omos_session` — is
  removed from the Cookie header, and the app's own valid access token, if the request
  carried one, is put back FIRST, because OpenMasjid apps forward the first `omos_session`
  they find. Before, the header went through as sent: every app on the masjid's network
  receives the admin's LAN (password-only) cookie — that is how single sign-on works
  there — so an app that kept one could present it through the tunnel to a shared app's
  sign-on and be signed in with no second factor.
- **An app not shared online** is in the routing table (every app with a web port is,
  carrying `exposed`), but through the tunnel it is served only to a request carrying a
  valid access token for THAT app; anyone else gets the same 404 as an empty address,
  recorded as `app-not-shared`. On the masjid's network the front door still does not
  serve it, and `isRouted` still means PUBLICLY routed, so it never gets a public address.
  The first draft served a private app to any request carrying a remote dashboard
  session — on one hostname, the dashboard's own cookie.
- **Responses** (`responseHeadersForTunnel`): `set-cookie` for a platform cookie name is
  dropped (an app setting `omos_session` on another's path could sign the admin out of it;
  the request filter above is what stops a planted value ever counting as a sign-in, since
  only a valid token for that very app is passed on), and so is `service-worker-allowed`
  (with it, one app could register a worker over the whole hostname and see every other
  app's pages, the address that hands out access tokens, and since dev.17 the dashboard), and
  so is `cross-origin-opener-policy` (dev.17: the dashboard's own policy is what cuts an app
  page off from a window it opened on the dashboard, and only a page with the SAME policy
  would keep its hold). A private app's page, or
  anything served to a request that carried a token, gets `NO_STORE_HEADERS` —
  `cache-control` set to `private, no-store`, and `cdn-cache-control` and
  `cloudflare-cdn-cache-control` set to `no-store` — because Cloudflare's edge caches by
  address alone, so a cached copy would go to whoever asks next. Every `refuseOverTunnel`
  answer carries the same three, and every response the remote dashboard sends carries the
  CDN pair, File Explorer downloads among them, whatever the edge's own caching rules would
  make of their addresses. A shared app's own responses keep the caching headers the app
  sent.
- **An app's bare address never serves the app's service-worker script** (`isBareAppAddress`,
  `isWorkerScriptFetch`, `answerBareWorkerFetch`). A worker's reach is the directory of its
  script's address, and the directory of `/<path>` — no trailing slash — is `/`: the whole
  apps' hostname, every other app's pages, `/_omos/open` and the dashboard included. Dropping
  `service-worker-allowed` only confines a script that lives UNDER `/<path>/`; a review found
  an app could serve its worker at the bare address instead. So a browser's worker-script fetch
  there — which it marks with `Service-Worker: script` or `Sec-Fetch-Dest: serviceworker` —
  gets `SELF_REMOVING_WORKER`: a 200 `text/javascript` with `NO_STORE_HEADERS` that calls
  `skipWaiting()` on install and `registration.unregister()` on activate, and nothing else (it
  clears no caches; they are the apps'). Not a 404, as the cut before this one had it: a 404
  stops NEW registrations, but by the Service Workers specification an update check that
  fetches no script leaves an EXISTING registration in place, its old worker still running —
  and every published build let an app's page register a worker over the whole apps' hostname
  from its bare address. Such a worker goes on answering every page there, the one-use Open
  address now among them, even after its app is gone, until the browser's next update check
  replaces it with this one, which unregisters. The answer is identical at a shared app's bare
  address, a private one's with or without its token, an empty one and on the LAN front door —
  the ingress gives it for a routed app, the front door's not-found handler for whatever falls
  through — so it says nothing about what is installed; it is recorded as
  `worker-at-bare-address` only when it came through the tunnel. Everything else at the bare
  address is proxied as it always was, but with `NO_STORE_HEADERS` whatever the app sent
  (`noStore`), so no cached copy, the browser's or Cloudflare's, can later stand in for a
  worker fetch. The first fix of all 308-redirected a `GET` or `HEAD` of the bare address to
  `/<path>/` instead, which a worker's script fetch refuses to follow; a later review found
  that it loops for ever for an app that redirects `/<path>/` back to `/<path>` — Next.js with
  a base path does, by default — taking its public page down. Proxying stays right for
  everything but the worker fetch: a payment provider posting a webhook to the bare address,
  say. The test is on the raw path's shape (one segment, no trailing slash) because every
  spelling counts: `/%73hared` is `/shared` to the router. What this cannot reach — a worker
  an earlier build let an app register over `/` from UNDER its path — is in the residuals.
- **Forwarding headers are the platform's** (`STRIP_HEADERS` in `system/ingress.ts` and
  `system/app-proxy.ts`, and the WebSocket path's own list): whatever a visitor sent as
  `X-Forwarded-*`, `Forwarded`, `X-Real-IP`, `True-Client-IP` or `CF-Connecting-IP` is removed
  before the platform sets its own, on the LAN as well as through the tunnel.
  `X-Forwarded-Prefix` joined the list late: some frameworks (Spring, ASP.NET, Next.js behind
  a proxy) take their base path from it, and the platform never sends one, so one arriving
  was typed by the visitor — and an app that trusted it would build its links and redirects
  from a stranger's choice.

### App addresses: one reserved list, and no two apps on one address

Once every app with a web port is in the routing table — private ones included, so the
admin can open them from outside — an address that two apps answer to, or that the platform
answers to, stops being harmless.

- **One list of first segments the platform keeps for itself**: `apps/paths.ts`
  `RESERVED_PATH_SEGMENTS` — `api`, and since dev.17 every one of the dashboard's
  `DASHBOARD_SEGMENTS` (`trpc`, `assets`, `store`, `apps`, `files`, `settings`,
  `design-system`), because the dashboard shares the apps' hostname and the ingress takes app
  paths first — read by both sides. The ingress never
  routes them, and `setAppPath` refuses them ("/api is used by OpenMasjidOS itself…"). When
  only the ingress knew, an admin could set an app's address to `/api`: accepted without a
  word, after which the app had no public page and opening it from outside landed on a 404.
  It is a module of its own because the ingress imports the manager, and the manager
  importing the ingress would be a cycle.
- **`setAppPath` refuses an address another installed app already answers to.**
- **An install chooses its address before it writes anything** (`addressForNewApp`, on the
  catalog, community and custom paths alike): the app's own id when that is free — stored as
  nothing, so it keeps following the id — and otherwise the first free `<id>-2`, `<id>-3`, …,
  kept inside the 40-character limit `sanitizePath` applies, so what is stored is what
  `getAppPath` reads back. The choice is logged (`noteDisplacedAddress`), a catalog install's
  `OPENMASJID_PUBLIC_URL` is built from it, and a reinstall keeps the address it had.
  Installing used to take the id unconditionally, which is the half of "no two apps on one
  address" `setAppPath` could not see: give a community app the address `/donations`, install
  the official Donations app later, and the newer one took the public page while Settings
  listed both as published there, and opening the older one from outside opened the other. An
  id that is itself a reserved segment is moved the same way.
- **Only an app-path shape is ever routed** (`apps/paths.ts` `isAppPathShape`,
  `^[a-z0-9][a-z0-9-]{0,79}$`, asked by the ingress's `rebuild`). Install and Settings only
  ever give an app such a path, but the manager also recovers an app from any `omos-*` project
  Docker reports, under whatever name that project has — and Docker allows `_` in one. A stack
  started by hand as `omos-_omos` would have been routed at `/_omos`, the platform's own
  address for opening an app from outside. Checking the shape where routes are made keeps out
  every recovered name, whatever it is.
- **For installs that already hold a clash**, `placeRoute` lets a shared app keep its path
  (and logs the clash) — a private app taking it would turn a public donations page into a 404
  for every donor while Settings still showed it as shared — and `isRouted` is true only for
  the app that actually holds the route AND is shared, so the other is never told it is
  published at an address that serves someone else's app (its Stripe return links and QR codes
  would point there).

`test/app-paths.test.ts` pins the first four, `test/remote-apps.test.ts` the last.

### Connections that outlive the check

The gate decides once per HTTP request. A WebSocket is one request that can last all day —
the dashboard's live data, an update's progress, a root terminal, an app's own live
connection — and a review found each outliving the very actions an admin takes to shut the
door: a live terminal went on taking keystrokes after remote administration or two-step
sign-in was switched off, after signing out, after a password change, and a live tRPC socket
could switch remote administration straight back on. Four layers now:

- **Only a signed-in remote session is handed a socket at all** (`claimsDashboardSocket`
  ends with `hasRemoteSession`). Every dashboard socket is useless without a session, and
  handing over anyone's let a stranger hold any number open and push frames the dashboard had
  to buffer and parse — the attack the anonymous body limit (next section) exists to stop,
  through the one door it did not cover. A stranger's socket is destroyed exactly like one
  for an address with nothing at it. That needed the dashboard's own socket to wait for a
  session, so its tRPC WebSocket is LAZY now (`ui/src/lib/trpcClient.ts`,
  `lazy: { enabled: true, closeMs: 10_000 }`): it opens only while something is subscribed,
  which takes a session, so the sign-in page holds none.
- **Every protected call re-checks.** For a handed-over context, `isAuthed`
  (`trpc/trpc.ts`) requires `remoteAdminEnabled()` and a live remote session on every
  call, because a WebSocket's context is built once for the whole connection.
- **A terminal re-checks before every keystroke** (`api/terminals.ts`: `requestUser`, and
  the terminal's own switch in Settings → Advanced).
- **A registry closes the idle ones** (`system/remote-sockets.ts`). Each handed-over socket
  is recorded with the remote session it came with (`trackHandedOverSocket`), and
  so is every app socket the ingress opens through the tunnel with that app's access token
  (`trackAppSocket`) — the admin, inside an app. Without that half, the dashboard's sockets
  closed on every action above and the app's stayed open: a review found a private app still
  answering a socket opened before the admin signed out. A socket with no token is the
  public's and is never recorded. `sweepHandedOverSockets` destroys any whose door has shut,
  or whose session — or the session behind its token — has ended or no longer holds the
  second factor it proved: every `SWEEP_MS` (5 s) while any are open, and at once on
  sign-out, a password change, a second-factor change, remote administration switched off,
  the tunnel switched on or off or cleared, and a save of the Remote access settings (which
  may change either hostname). It reads the door and the second-factor epoch once per pass
  and judges the dashboard's sockets against those (`isRemoteSessionAt`), not once per socket
  as it first did — a file read per open socket every five seconds, on the daemon's only
  thread. An app socket's token is still checked one by one (`appAccessUser`, which reads the
  epoch for itself). And the table holds at most `MAX_TRACKED_SOCKETS` (200): every entry
  belongs to a signed-in admin, but it is filled from the internet, and a map keyed by what
  the internet chooses gets a bound (as `auth/ip-lockout.ts`'s does). Of those, apps' sockets
  may hold at most `MAX_APP_SOCKETS` (150), so the dashboard's own always have room: an app's
  page opens a socket with the admin's token whenever it likes, and a hostile or merely leaky
  one (a reconnect loop that never closes the old socket) filled the whole table in review,
  after which every terminal, update and restore from outside failed to start, on every
  device, for as long as that tab stayed open. A socket refused for either bound is destroyed,
  and the refusal is logged at most once a minute: a reconnect loop would otherwise write a
  line per attempt into a log that is not rotated.

**Closing an app socket closes both ends** (`system/socket-relay.ts` `closeTogether`). The
relay to an app was two pipes, browser to app and back, and a pipe passes on an END — one side
closing politely — and nothing else. A socket that is DESTROYED emits `close` but never `end`,
so when the sweep destroyed the browser's side of the admin's app socket, the connection to
the app stayed open, held by the core until the app noticed by itself, which an idle socket
may never do; the review that found it watched the browser's side close and the app's see
neither `end` nor `close`. `closeTogether(client, upstream)` destroys each side when the other
errors or closes — except that the app's `close` leaves a browser socket that has already been
ended alone, so a polite end still delivers what is on its way. It is attached the moment both
sockets exist, before the connection to the app has even been made, so a browser that leaves
mid-dial cancels the dial. One function, used by the tunnel ingress and the per-app HTTPS
proxy alike, because the same relay written twice is how one copy gets fixed and the other
does not. The app now sees the admin's socket drop (a close with no close frame, which a
WebSocket library reports as 1006), and the sweep leaves a public socket alone at both ends
(`test/front-door-websocket.test.ts` checks both).

**A browser that leaves part-way ends the app's HTTP response too** (`proxyHttp` in
`system/ingress.ts`, and the request handler in `system/app-proxy.ts`): a `close` on the
response destroys the request to the app unless the response had finished. The HTTP relay had
the same shape — `upRes.pipe(res)` — and a response closed early only paused it, so a live
event stream, a long poll or a big download held the app's connection until the app gave up by
itself. What HTTP still does not get is the sweep: a long-lived response opened through the
tunnel with the admin's access token is not tracked, and runs on after that sign-in ends (a
residual, below). `test/remote-apps.test.ts` (*A BROWSER THAT LEAVES PART-WAY ENDS THE APP'S
RESPONSE TOO*).

**A quiet dashboard socket is kept alive** (`DASHBOARD_WS_HEARTBEAT_MS`, 30 s;
`startDashboardHeartbeat(server.websocketServer)` in index.ts). Cloudflare closes a WebSocket
that carries nothing either way for about 100 seconds, and nothing else speaks on these
sockets while the admin is reading: a remote terminal at a prompt or in an editor printed
"[Session closed]" in any pause, leaving whatever ran inside — an editor with unsaved changes
included — where nobody could get back to it, and an update's progress window could drop
during a long download. So every open socket on the dashboard listener is pinged every 30
seconds. A browser answers a ping by itself, so the page needs nothing, and on the LAN it costs
nothing. Apps' own sockets are not pinged — their bytes pass through the relay untouched — so
an app that wants a long-quiet socket to survive Cloudflare sends a heartbeat of its own.
`test/front-door-websocket.test.ts` (*A QUIET DASHBOARD SOCKET IS PINGED*).

Closing a socket never stops what it was reporting on: an update or a restore runs to the
end whether or not anyone is watching.

### What a stranger can make the daemon read

The dashboard listener accepts bodies up to 25 MB, because a signed-in admin uploads
wallpapers and pastes compose files. Handing it the internet's requests unread made that
reachable by anyone who can load the sign-in page, and a handful of concurrent 25 MB posts
is a memory-exhaustion attack on a Raspberry Pi running as root — taking every public app
page down with the process. So:

- A handed-over request with no remote session may carry at most `ANONYMOUS_BODY_LIMIT`
  (64 KB); a sign-in and a code are a few hundred bytes. A body that DECLARES more, or
  declares a length that is not a number, is refused 413 at the front door without a byte
  read (`anonymousBodyRefusal`). One that declares nothing (chunked) cannot be refused up
  front without refusing real sign-ins too, so a `preParsing` hook
  (`registerDashboardRequestLimits`) counts it as it arrives and stops it at the same
  limit, with 413.
- Anything but a GET, HEAD or OPTIONS to `/trpc` must be `application/json`, or it gets
  415 — from everyone, on the LAN too. tRPC's adapter also accepts multipart bodies and
  reads them with no size limit; nothing in the dashboard uses that.
- Every WebSocket message on the dashboard listener is capped at 1 MiB
  (`DASHBOARD_WS_MAX_PAYLOAD`, the `maxPayload` given to `@fastify/websocket`) — from
  everyone, on the LAN too. The library's default is 100 MB, which let any socket make the
  daemon buffer, stringify and parse that much per message; the dashboard never sends more
  than a subscription message or a terminal's keystrokes and pastes that way, since uploads
  go over HTTP. From outside, a stranger cannot open one of these sockets at all (*Connections
  that outlive the check*).

### Restore and backup from outside

**A restore started from outside is refused unless the backup keeps the way back in**
(`system/restore.ts` `remoteRestoreProblem`). A restore replaces `config/` whole, and a backup
taken before remote administration was set up — most of them, the feature being new — would
turn the door off behind the admin, with only someone in the building able to open it again.
So from outside — handed over by the front door, not merely looking remote
(`runRestore(…, { remote: wasHandedOver(req.raw), callerToken })` in `api/restore.ts`) — the
staged `config/` must:

- open the door by **the same rule the live box uses**. `settingsOpenTheDoor(cf)` is the
  settings half of `remoteAdminEnabled()` — tunnel on, switch on, each `=== true` — as a pure
  function of a `cloudflare` settings object, so the restore asks it of the staged
  `settings.json`; `remoteAdminEnabled()` is that plus `twoFactorActive()` and
  `isConfigured()`. The restore's first check was a hand-written copy, and it missed a
  condition dev.16 had ("the admin hostname equals the apps' hostname"): a restore it waved
  through shut the remote dashboard behind the admin. One rule, two callers — the lesson of
  `frontDoorDecision` and its drifted test copy, again;
- carry the **same tunnel token**
  (`tunnelTokenMatches`), and have a **username** and the **same password hash** as
  `getPasswordHash({ fresh: true })` — `isConfigured` needs both;
- have the **same authenticator** (`sameSecondFactorAs`: the secret itself, compared in
  constant time, and both sides must have one). An emailed-only configuration is refused:
  whether a restored emailed factor would deliver depends on the restored address and mail
  account (`emailBoundTo`), and a wrong guess cannot be repaired from outside.

The check runs once the archive is extracted and validated and before `stopAllApps`, so a
refusal changes nothing. A backup with no `config/` is never refused here, at the masjid
restores are unchanged, and first-run setup and first-run restore refuse the tunnel outright.
Backup codes are not compared: a restore brings back the backup's own set, used and replaced
codes included, which `docs/SECURITY.md` tells the operator.
`test/remote-restore.test.ts` covers each refusal.

**The second-factor epoch is held while a restore puts things back, and renewed once the
backup's settings are in place** (`holdSecondFactorEpoch` and `renewSecondFactorEpoch`,
`auth/twofactor.ts`). The hold is taken beside `holdForRestore` once the apps are stopped,
immediately before the synchronous swap of `config/` and `apps/`, owned the same way, and
released in the same `finally`. The restored `twofactor.json` carries an older epoch whenever
the factor changed since the backup, and a remote session is honoured only under the epoch it
signed in with — so the restoring admin was signed out mid-restore, the sweep closed their
progress socket, and every line after that was lost. A sign-in completed during the hold is
bound to the HELD epoch (`verifySecondFactor` reads the hold), not to the restored file's,
under which it was refused the moment it was made. The hold alone
left the release wrong: it handed the box the BACKUP's epoch, under which every remote session
made under the factor as it stood when the backup was taken counted again — one the admin had
since shut out by replacing the factor included — while the restoring admin, signed in under a
newer epoch, was shut out. So once `config/` has been moved into place the restore gives the
factor a NEW epoch, which counts for nobody, and in its `finally`, just before the holds are
released, moves the caller onto it (`rebindRemoteSession`, with the session token
`api/restore.ts` passes from `requestSessionToken`) — but only if that session still counts
at that moment (`remoteGrantOf(callerToken) !== null`, judged against the held epoch). The
first cut moved it unconditionally, and `rebindRemoteSession` checks only that a session is
remote and live under the password, so a session shut out from outside while the restore was
unpacking — by new backup codes, say — was carried back in with it. (That particular change is
now refused for the whole restore, below; the check stays, because the rebind must never be
what lets a session back in.) Under the new epoch every other remote session, one made during
the restore included, stops counting from outside at release, and a restore that completes
ends every session at the next boot anyway (`endAllSessionsAtNextBoot`).

**Nothing about the second factor can be CHANGED while a restore runs** (`refuseDuringRestore`
in `trpc/routers/twofactor.ts`: `secondFactorHeld() || isUpdating('restore')`). It answers
CONFLICT, "A backup is being restored right now. Please try this again once it has finished.",
at the start of `requireSudo`, again once the password has been checked — a restore can begin
while argon2 runs — and at the start of `confirm`. So `begin`, `confirm`, `disable`,
`regenerateBackupCodes` and `setEmailFactor` are all refused before any code is spent, much as
the account store refuses a password change while a restore holds it. Signing in still works:
the code is judged, and the session bound, against the held epoch. It covers the whole restore,
from the moment the `restore` lock is taken, because each half had its own trap. During the
hold, the first cut let a change through: written to the file while `secondFactorEpoch()` went
on answering the held value, it counted only at the release — and the admin who made it from
outside, moved by `rebindRemoteSession` onto the epoch that counted then (the held one), was
signed out from outside the moment the restore let go. Before the hold — while the archive is
unpacked and checked and the apps are stopped — a change was written as normal and then
silently overwritten by the backup's own `twofactor.json`. `test/twofactor-router.test.ts`
pins both, and the refusal after argon2. Every protected mutation is now refused while a
restore runs (`noChangesDuringRestore`, *While a restore runs*, above), these five among
them, and that refusal comes first, when the call begins; `refuseDuringRestore` is still what
catches a restore that begins while `requireSudo`'s argon2 runs. And since the `restore` lock
is now kept until the core is replaced, both last until then, not just until the restore
returns.

**A restore brings the core back on the build it is running** (`docker/update.ts`
`recreateCore` with no tag, which calls `pinComposeToRunningBuild`). Before the helper runs,
the running container's image — by ID, from `inspect` — is tagged with the running `VERSION`
under the repository the compose file names (`docker tag`), and the compose file's image line
is pointed at that tag (`alignComposeImage(VERSION)`). The helper itself runs from the running
image by ID (`inspectSelfAsIs`; failing that, the compose file's reference, and the channel's
alias only as a last resort, when there is neither). Nothing is pinned when the compose line or
the running reference is pinned to a digest — the operator's choice — or when the container
cannot be inspected (no Docker API: local development). Two earlier answers were wrong. The
published one aimed the recreate at the channel's alias (`:latest`, `:dev`) without pulling
it, and the alias names whatever build was last pulled under it — by the installer, or by a
dashboard channel move whose target version could not be read; every other dashboard update
pulls an exact version (CLAUDE.md §13.4) — so a restore could quietly put the box back on an
older build: from outside, onto one with no remote dashboard, locking the admin out of the very
address the restore check had just protected. The next one left the compose file's line as it
was, reasoning that only the installer and an update's `recreateCore` write it, so it names the
build the core last started from. It does not: an update that pointed it at a new version and
then could not start its helper left it naming a build the core never ran, and the installer's
*Update* wrote it before downloading, so a failed download (the script stops under `set -e`)
left it naming the new image. Both are fixed at the source as well: `recreateCore(onLine, tag)`
puts the compose file back when its helper cannot be started, so "Nothing was changed" stays
true, and `install.sh` `do_update` resolves the image, downloads it, and only then writes the
compose file. The dashboard update still passes the exact version it has just pulled.
`test/remote-update.test.ts` pins all three.

**The restore says how it ended.** `runRestore` returns a `RestoreOutcome`, and
`/api/restore/run` closes its socket with one code per outcome (`api/restore.ts`
`RESTORE_CLOSE`): 1000 `restarting`; 4003 `restarting-with-problems` — restarting, but some
app's data could not be put back, some app could not be started (`reupAllApps` returns the
names of those it held for review or Docker refused) or some app could not be paused first
(`stopAllApps`, *While a restore runs*, above); 4001 `unchanged` — it stopped before
touching anything (refused, already running, a clash with an update, a bad or oversized file,
nothing in it to restore); 4002 `not-restarted` — it stopped part-way (a thrown error, for
which this is also the default); 4004 `restored-not-restarted` — everything was put back, but
the helper that restarts the core could not be started. 4002 and 4004 are told apart because
the advice is opposite: someone told "it stopped" would restore again, stopping every app again
for nothing, where restarting the machine — or the installer's Repair — is what finishes a
restore that only failed to restart. A backup with nothing usable in it — no `config/`, no
`apps/`, and no app-volume archive a restore would put back (`stagedVolumeArchives`, one list
for that check and for the work, so the two cannot disagree) — is now found BEFORE
`stopAllApps`, and says "That backup had nothing to restore. Nothing has been changed." It
used to be found after: every app was stopped and left stopped (a container stopped by hand
does not even come back after a reboot) by a restore that changed nothing else. `RestoreModal`
reads the code: 4002 → "stopped before it could finish"; 4004 → "Your backup was restored, but
OpenMasjidOS couldn't restart itself to finish…"; 4003 → wait for the restart, then "The
restore finished, but some of your apps or their data need attention…" rather than "Restore
complete."; any other 4xxx, the route's own 4401/4403 refusals included → "Nothing was
changed" — and each of those refusals now sends its reason as a line before closing, because
the window said "the messages above say why" over an empty log; a stream that never opened →
"Couldn't connect to OpenMasjidOS, so nothing was changed." (`LogStream` reports whether it
did); 1000, or a stream that simply dropped → wait for the restart, polling `/trpc/auth.me`,
and say after ~30 s that none has been seen yet while it goes on waiting (up to four minutes).
It used to assume every ending was a restart: a refused restore — the usual result from
outside — sat on "reconnecting" for four minutes and then announced "Restore complete.", and
so did one whose app data had all failed to come back. `test/remote-restore.test.ts` reads
`RestoreModal.tsx` to keep the two sides' codes in step.

**"Restore complete." needs two pieces of evidence** (`RestoreModal`, v0.51.2-dev.16): that the
core went down and came back, and that the restore said it went well before it did. The core
counts as down only after TWO failed polls in a row, a good answer resetting the count: on one
failure — a 502, the Wi-Fi — the window took a blip for the restart and said "Restore
complete." while the old core was still about to be replaced. (The update window has the same
rule, next section.) And only a 1000 or a 4003 (`heard`) is the server saying how the restore
ended; any other code that reaches the wait — 1006 from a laptop that slept, say — means the
stream dropped first, and a restart seen afterwards proves the core restarted, not that the
restore worked. That ends on `restore.lost`: "OpenMasjidOS has restarted, but this window couldn't
see how the restore ended. Please reload, sign in again and check that your apps and settings
look right." It used to say "Restore complete."
`test/remote-update.test.ts` (*the update window is told whether anything changed — and waits
only for a restart*) pins the two-failure rule in both windows and this ending.

**What went wrong outlives the window** (`RestoreReport`, `config/restore-report.json`). The
window that names the apps needing a look is unmounted within a minute of the core restarting
— every session ends then, and the dashboard returns to its sign-in — and nothing recorded
which apps had come back empty. So when app data could not be put back, apps did not start or
apps could not be paused, the restore writes `{ at, appsWithoutData, appsNotStarted,
appsNotPaused }` — app NAMES, a volume `omos-<id>_…` mapped to its app — into `config/` after
the swap, where the new core finds it (0600, through `writeJson`), and logs each failure with
`log.warn`. A restore with nothing to
report removes any older report, including one that came back inside the backup's own
`config/`. The dashboard shows it after the next sign-in (`backups.restoreReport`) until the
admin dismisses it (`backups.dismissRestoreReport`), both protected procedures. The window's
"Affected:" line names apps too, not Docker volumes.

**A backup download from outside answers before the backup exists, and ends the backup if the
browser leaves** (`api/backup-download.ts` `remoteBackupDownload`, which the `/api/backup`
route in index.ts uses for a handed-over request). Making a backup copies every app's data
before the archive's first byte, and Cloudflare gives up on an origin that has not started
answering within 100 seconds — so on any box whose data took that long, every remote download
failed.
`remoteBackupDownload` answers "a backup is already running" with a proper 409
(`backupInProgress()`, known before anything is sent), then hijacks the reply, and
`sendBackupEarly` writes and flushes the headers — with `NO_STORE_HEADERS`, since a hijacked
reply skips the listener's `onSend` — before it calls `backupStream()`. A failure after that
cannot be a tidy message: the response is destroyed, which the browser reports as a failed
download rather than a partial file the admin would trust. The second half came from a
review. The first cut noticed the browser leaving only once the backup existed, through a
listener attached then — but `close` had already fired during the minutes spent copying app
data, and it fires once. The archive was piped into a dead response, the pipe paused for
ever, `tar` blocked on a full pipe and never exited, and the one-backup-at-a-time flag it
clears on exit stayed set: every later backup, the nightly off-site one included, was refused
as "already running" until a restart, with a copy of every app's data left in staging. Now
the `close` listener is attached before the backup starts, a backup that arrives after the
browser left is destroyed at once, and the hand-off (`sendBackup`, below) tears the source
down when the response closes and the response down when the source fails — ending `tar`,
which is what clears the flag. (Nothing interrupts the copy of app data itself: a browser that
leaves during it is noticed when the copy finishes and the archive would start.)
`test/remote-backup.test.ts`.

**Every backup download ends only when `tar` has said it succeeded** (`sendBackup`, used by
the LAN route and the remote one alike). `tar` finishes writing its output BEFORE it exits
with its verdict, so a response ended with the output — by a pipe, or by Fastify's
`reply.send(stream)`, which is what the LAN route used — was delivered whole and clean for a
backup `tar` had FAILED: a file it could not read left out, an archive cut short. The browser
said "done", the log said "Backup failed", and the admin found out at the restore. Now the
bytes go as they come, and the end waits for both the output to finish AND `done.ok`;
anything else destroys the response, which a browser reports as a failed download. The LAN
route hijacks its reply to do that, so it sets its own `cache-control: private, no-store`.

### Updates from outside: never to a version that cannot be managed from there

`FIRST_REMOTE_ADMIN_VERSION` (`system/remote-admin.ts`) is `0.51.2-dev.16`, the first build
with everything managing from outside needs (the hand-over, remote sessions, *Open*; dev.16
itself wanted a second hostname, but no update from dev.17 can land on it — updates only go
forward, and Stable is older), and `managesFromOutside(version)` is a
semver `>=` against it (`util/version.ts`, so a release outranks its own prereleases and
`0.51.2` passes). From outside, neither the dashboard's update nor its channel switch may move
the box below it (a root terminal, behind its own switch, can do anything, this included).
Before this, an admin managing from outside could switch back to Stable — `0.51.1`, with no
remote dashboard at all — and let the dashboard move OpenMasjidOS across: the core came back
without a remote dashboard, and every window from outside was cut off until someone at the
masjid moved the box on again. Two places ask, both keyed on the hand-over:

- **The core update** (`docker/update.ts` `runUpdate(onLine, { remote })`; `api/update.ts`
  passes `remote: wasHandedOver(req.raw)`). After the checks for "already up to date" and for a
  newest version that could not be read on the same channel (both stop at the masjid too —
  *Every progress window is told how its work ended*, below) and before anything is pulled, it
  looks at the target (`checkForUpdate().latest`). One that still could not be read — in
  practice a channel move whose target was unreadable — is refused ("Couldn't check which
  version this would install, so it can't be done from outside right now."), and so is one
  below the first remote-admin build ("Version X can't be managed from outside the masjid, so
  installing it from here would cut you off."), both ending "Nothing was changed." An unknown
  target is refused rather than guessed at, because from outside nobody could put a wrong
  guess right.
- **The channel switch** (`system.setUpdateChannel`, `ctx.handedOver`). Before anything else
  it reads the TARGET channel's published version — `publishedVersion(channel)` in
  `system/system.ts`, factored out of `checkForUpdate` so the two cannot read it differently —
  and refuses an unreadable one (SERVICE_UNAVAILABLE) or one below the first remote-admin build
  (FORBIDDEN), writing nothing. The switch itself is refused, not only the update it leads to:
  refusing just that last step would leave the apps on one channel and the platform on the
  other, the mixed state a channel switch exists to prevent.

At the masjid both behave as they always did, and once Stable carries a version that has
remote administration, switching to it from outside goes through. `test/remote-update.test.ts`
pins both, the allowed switch included.

### Every progress window is told how its work ended

The update windows used to read every ending as success. The core update's sat locked on
"restarting…" for three minutes after an update that had changed nothing, then said "Update
applied." — which the refusals from outside above would have made routine; an app's said
"<app> is up to date now." over an update that was refused, put back after a failed download,
or never began; "Update all" said "All 4 apps updated." over a run in which one had not come
back. Each stream now closes with a code that says how its work ended, as the restore's does,
and each window reads it. `LogStream` also reports whether the socket ever OPENED: one that
never connected began nothing, so the core update, app update and restore windows say
"Couldn't connect to OpenMasjidOS, so nothing was changed." rather than waiting for a restart
or calling it lost.

- **The core update** (`runUpdate` → `UpdateOutcome`; `api/update.ts` `UPDATE_CLOSE`): 1000
  `restarting` — the helper is replacing the core; 4001 `unchanged` — already up to date, a
  newest version that could not be read, a download that failed, an updater that could not
  start, a refusal from outside, a core pinned to a digest (below), a clash with a restore or
  an app's update, or an error. A version that could not be read on the same channel used to
  be reported as "already up to date", which the platform cannot know; it now says "Couldn't
  check for the latest version just now, so nothing was changed." and pulls nothing, as
  before. A refusal before the update starts (4401 signed out, 4403 a bad origin or dashboard
  key) sends its reason as a line first, as the restore's do. `UpdateModal` reads any 4000–4999
  close as `unchanged` —
  unlocked, "Nothing was changed. The messages above say why." On 1000, or a stream that
  dropped, it waits with the dialog locked, polling `/trpc/auth.me`, and says the update worked
  only on EVIDENCE: a new version answering, or the core seen to go down and come back (with no
  version visible to it). After ~30 s with no sign of a restart it unlocks and says
  "OpenMasjidOS hasn't restarted yet…" while it goes on watching; after ~3 minutes it ends
  there. The same update asked for twice still closes 1000, so its window watches for the
  first run's restart; if that run never restarts the core, the window ends on "hasn't
  restarted yet", never "Update applied."
- **The update window's two-failure rule, and coming back unchanged** (v0.51.2-dev.16). "Gone
  down" means TWO failed polls in a row, a good answer starting the count again. A single
  failure used to be enough, and a blip — a 502, the Wi-Fi — then kept the dialog locked for
  the full three minutes and could end on a restart that never happened. And once the core is
  back on the SAME version after going down, the window waits 15 more polls (~30 s, the
  `POLLS_BEFORE_UNSURE` it already used) for a restart still to come, then ends on `same` —
  unlocked, "OpenMasjidOS restarted, but it is still on v…. Reload this page, then try the
  update again." — rather than holding the dialog shut for the
  rest of the three minutes. The restore window counts failures the same way (*Restore and
  backup from outside*, above). `test/remote-update.test.ts` (*the update window is told
  whether anything changed — and waits only for a restart*).
- **A core pinned to a digest is not "updated" onto itself** (`runUpdateInner`). A digest on
  the core's compose line (`composeImageRef()` containing `@`) is the operator's choice, which
  `alignComposeImage` and `pinComposeToRunningBuild` leave alone — so every press of Update
  downloaded, recreated the core from a compose file still naming the digest, and came back on
  the same build, every window and live connection closed for nothing, while the update notice
  went on offering it. Now it refuses before anything is downloaded — "OpenMasjidOS is pinned
  to one exact build on this machine, so it can't update itself from here. Nothing was
  changed." — closing 4001. It sits after the up-to-date and from-outside checks, so a pinned
  box with nothing newer is still told it is up to date, and a refusal from outside still gives
  its own reason. Residual: `checkForUpdate` was not changed, so the dashboard's notice and the
  `core-update` alert still offer the update on such a box. `test/remote-update.test.ts` (*A
  CORE PINNED TO ONE EXACT BUILD IS NOT "UPDATED" ONTO THAT SAME BUILD, AGAIN AND AGAIN*).
- **An app's update** (`updateCatalogApp` → `AppUpdateOutcome`; `api/app-update.ts`
  `APP_UPDATE_CLOSE`): 1000 updated; 4001 nothing was changed (refused, already current, put
  back after a failed download or start, busy or a clash); 4003 updated, but the new version
  does not stay up; 4002 stopped part-way (an exception). The route's own refusals — 4400 an
  impossible app id ("That app could not be found."), 4401, 4403 — say why as a line first. It
  used to close with no code at all. `ui/src/lib/update-endings.ts` maps a close, and whether
  the stream ever opened, to an ending for the three windows that stream an app's update —
  `AppUpdate`, `UpdateAllApps` and `ChannelMigrate`. It is React-free so that a core test can
  hold it to the server's codes: `test/remote-update.test.ts` imports it beside
  `APP_UPDATE_CLOSE` and checks every code, the refusals, a dropped stream ("lost": it may still
  be finishing) and one that never connected. `UpdateAllApps` counts the apps that really
  updated ("All 4 apps updated." only when all four did, otherwise "3 of 4 apps updated…");
  `ChannelMigrate` counts the apps that really moved, and its OS step reads its own close —
  any 4xxx, or a stream that never connected, says OpenMasjidOS itself was not changed.
  WhatsApp's `!os update <app>` reads the outcome too, and answers "<app> wasn't updated, so
  nothing was changed." instead of reporting an update that was put back.

`test/remote-update.test.ts` also reads `UpdateModal.tsx` and `api/update.ts` to keep the core
update's two sides in step.

### The dashboard's side

`lib/app-url.ts` gives two answers, and which one applies is `auth.me`'s `remote` — the
hand-over, as above. At the masjid an app is at its own port. From outside there is no address
to build for OPENING an app — `lib/apps.ts` asks `apps.openRemote` — and only a SHARED app's
public files, its icon, are addressed, on the apps' hostname (`auth.me` returns `appOrigin` to
a signed-in session the front door handed over). OpenWA's Open button is disabled from
outside, because its own screen does not work under a path. The update and restore dialogs
watch `/trpc/auth.me` rather than `/api/health`, which stays refused over the tunnel, and
`auth.me` returns `version` to a signed-in session so the update dialog can see the new build
arrive. From outside, the restore upload and the File Explorer's upload refuse a file over
100 MB before sending it (`REMOTE_UPLOAD_LIMIT`, `lib/files.ts`) — Cloudflare's free plan
refuses larger request bodies with an error page of its own — and recognise that page's 413
if one comes back, so the admin reads "restore/upload it at the masjid" rather than
"Something went wrong". The restore dialog's warning from outside names the limit too.

### Moving off the earlier designs (Development builds only)

Neither earlier design reached Stable, and neither needs a visit to the masjid to move off.
dev.13–dev.15 had the dashboard at the root of the apps' hostname, where dev.17 puts it again;
their sessions carry no `remote` mark, so the admin signs in once more. (Those builds could not
start a core update from the remote dashboard — `/api/update` was on the LAN listener alone —
so the update itself happens at the masjid or through the installer.) dev.16 had it on a
second hostname; that hostname goes on being served while Cloudflare routes it, its sessions
go on working there (the `__Host-` cookie is per hostname, so the admin signs in once at the
apps' address), and the stored `adminHost` is simply no longer read.

### Accepted residuals

- **The apps share one origin with each other** on the apps' hostname, so app-vs-app
  isolation is weaker there than on the LAN, where every app has its own port. A malicious
  app's page could act within another app the admin has opened there — the browser
  attaches that app's token to a same-origin request for its path. A hostname per app would
  close it, at the cost above.
- **They share it with the dashboard too** (dev.17), held apart by the key rule alone, which
  rests on browser behaviour (Sec-Fetch metadata, COOP) rather than the origin. An app page
  can still call the dashboard's PUBLIC procedures as the admin's browser — `auth.logout`, and
  failed `auth.login` calls that count toward the per-address lockout — write the dashboard's
  display preferences in `localStorage`, and show a fake sign-in at the same address. Safari
  before 16.4 sends no `Sec-Fetch-Dest`, so it signs in again after every reload from outside.
- **A WebSocket's `101` response is relayed as the app sent it**, so a `set-cookie` on it
  is not filtered.
- **A long-lived HTTP response opened with an access token is not revoked.** The sweep closes
  WebSockets; an event stream, a long poll or a download opened through the tunnel with the
  admin's token runs until it ends or the browser leaves, even after that sign-in has ended.
  (When the browser leaves, the request to the app now ends with it — *Connections that
  outlive the check*, above.)
- **A service worker an earlier build let an app register over the whole apps' hostname from
  UNDER its path is not removed.** Published builds passed `Service-Worker-Allowed` through, so
  an app could serve its worker at `/<path>/sw.js` with `Service-Worker-Allowed: /` and register
  it over `/`. `SELF_REMOVING_WORKER` replaces only a worker whose script sits at a bare
  address. This one's update checks fetch `/<path>/sw.js`, which now comes back without the
  header, so the scope check fails (or not at all, if the app is gone), and by the same
  specification a browser keeps a registration whose update fails. It stays in the browsers
  that met it, within the apps' hostname — the shared-origin residual above, but persistent —
  until their site data for that hostname is cleared; `docs/SECURITY.md` tells the operator.
  Since dev.17 it is the worst residual here: such a worker sees the dashboard's page loads
  too, the key in them included.
- **A masjid's own LAN reverse proxy that sends `x-forwarded-proto: https` is treated as
  tunnel traffic by the security rules** (`isViaTunnel` cannot tell the two apart), so
  signing in through it needs the second factor and a LAN session does not count there. What
  the dashboard does differently from outside follows the hand-over instead, so through a
  proxy pointed at the dashboard's own port it behaves as at the masjid (*"From outside" is
  the hand-over*, above), and a session made there never counts on the remote dashboard or
  for an access token (`Session.handedOver`, *Remote sessions*, above).
- **Cloudflare's free plan refuses request bodies over 100 MB**, so a large restore or
  upload has to be done at the masjid; the dashboard says so before it tries. And Cloudflare
  drops a connection that stays silent for about 100 seconds, so on a very large install a
  backup download from outside can still fail while app data is copied — sending the headers
  early removes the wait for the first answer, not the silence that follows it.
- **An app must be base-path aware** to work under `/<path>/`. Every OpenMasjid app is; a
  community or custom app may not be.
- **Emailed codes as the ONLY factor** — never offered by Settings and now refused by the
  server, but an older configuration may hold it — pause on an address or mail change with no
  factor left, so the door shuts; switching them back on now needs an authenticator first,
  which means the masjid. Such a configuration cannot be restored from outside either.
- **The epoch ends remote use only.** A session shut out by a factor change is still honoured
  on the LAN, where sessions are bound to the password alone; a password change is what ends
  sessions everywhere (*Remote sessions*, above).
- **A dashboard session at the masjid can reach the second factor.** It can download a backup,
  which holds the authenticator's secret, unencrypted — or restore one, which replaces the
  factor with the rest of `config/` and asks for no code (only a restore from outside is held
  to `remoteRestoreProblem`). Two-step sign-in guards remote
  access against someone who knows the password but cannot reach the masjid's network, not
  against someone already signed in there (*An emailed code is bound to where it goes*, above).
- **A restore brings back the backup's own backup codes**, used and replaced ones included;
  only the authenticator is compared. The renewed epoch ends every remote session from before
  the restore; the codes themselves come back usable.
- **`/_omos/open` tells a stranger whether remote administration is on**: a used, expired or
  made-up ticket gets the 410 page while the door is open and the ordinary 404 while it is
  shut — and so does the apps' address with nothing after it, which shows the sign-in page
  while the door is open. It does not check that it was asked for on the apps' hostname, so
  the same answer comes back on any hostname the tunnel carries; the dashboard only ever
  builds the link on the apps' hostname, so nothing depends on it.
- **A whole token for the wrong tunnel is still accepted at the masjid.** `normalizeTunnelToken`
  checks a token's shape, not that it belongs to this masjid's tunnel, and the platform cannot
  tell a tunnel connected to the wrong place from a working one: `cloudflaredRunning` reports
  the container — up, and not in its restart loop — not where it connected. A token
  cloudflared refuses now reads as not running while it restarts; a whole token for another
  tunnel connects and reads as running. At the masjid that is put right on the spot, which is
  why only the remote dashboard is refused a new token (*The tunnel token*, above).
- **The platform's own addresses are refused before a request body is read** — the front-door
  gate and the Fabric guard refuse in `onRequest` hooks — while an address with nothing at it
  goes to the not-found route, where Fastify parses the body first. So a malformed or
  oversized body tells a platform address from an empty one. Those addresses are the same on
  every box and in the public source; what the identical answer exists to hide — which apps
  are installed — is unaffected, because the ingress declines an app that is not shared before
  anything else answers, and it then takes the empty address's road (`system/ingress.ts`).
- And the limit every tunnel check shares (`docs/SECURITY.md`): on a box whose ports 80/443
  are directly reachable, a request carries no Cloudflare headers and is treated as LAN.
