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
- **Auth:** argon2id hashing + a random session token in an HTTP-only,
  SameSite=Strict cookie (not Secure — plain-HTTP LAN). Sessions are in-memory.
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

### Scope delta from the previous (Go/Svelte) build
The rewritten CLAUDE.md scope (§4, §13) does **not** include the file manager or
web terminals that the earlier build had. They are intentionally omitted here.
Backup is implemented as a streaming tar download; restore is deferred (the UI
labels it "coming soon").

## Ports & data
- Default port **8723** (`http://openmasjidos.local:8723` / `http://<ip>:8723`).
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
- **Login is throttled per source IP** with escalating backoff (a flood from one
  IP can't lock out the admin), and password verification runs in uniform time.
- The root daemon installs `uncaughtException`/`unhandledRejection` guards and
  the terminal bridge handles stream errors, so a single failure can't crash the
  control plane.
- Supply chain: a CI `audit` job resolves the tree and fails on high/critical
  advisories. The fuller fix is a committed lockfile + `npm ci` (run `npm
  install` once on a Node machine and commit `package-lock.json`).

Accepted tradeoffs (documented, not bugs): plain-HTTP on the LAN (no Secure
cookie), and the core running as root with the Docker socket mounted (the
standard single-host control-plane model, same as CasaOS/Umbrel/Portainer).

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

## Version
`VERSION` at the repo root is the single source of truth. The Docker build copies
it to `/app/VERSION`; the daemon reads it (`OPENMASJID_VERSION_FILE`). Shown in
Settings → Advanced.
