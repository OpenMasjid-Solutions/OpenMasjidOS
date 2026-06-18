# OpenMasjidOS — Architecture Documentation

> This document records the key architectural decisions made during the design and build of OpenMasjidOS. It is written for contributors and maintainers, not end users. When a non-trivial decision is made during development, it must be recorded here.

---

## 1. Two-Repo Strategy

OpenMasjidOS is split across two repositories with a clear contract boundary between them.

### OpenMasjidOS (this repo)
The **platform engine**. It handles everything that is not an individual masjid app:
- The installer script
- The Go backend (control plane, API, Docker lifecycle management)
- The web dashboard (SvelteKit SPA)
- Auth, sessions, masjid profile storage, settings
- App Store client (reads the catalog, installs apps)
- WebSocket hub for live status and log streaming

### OpenMasjidAPPS (separate repo)
The **app catalog**. A collection of community-maintained app definitions. Each app is a folder containing:
- `manifest.yaml` — metadata, settings schema, profile dependencies, resource hints
- `docker-compose.yml` — how the app runs
- `icon.svg` — app icon
- `screenshots/` — optional UI screenshots

A CI job in that repo aggregates all manifests into a single `catalog.json` at the repo root. OpenMasjidOS fetches only that one file to populate the App Store.

**Why split?**
- Platform releases and app releases are independent. A new prayer-times app version should not require a new OpenMasjidOS release.
- Contributors who want to add or update masjid apps never need to touch platform code.
- The platform can remain small and auditable; the app catalog can grow freely.
- OpenMasjidOS does not need to trust app code at build time — it validates and runs manifests at install time.

**Contract stability is the obligation of this repo.** The manifest spec (`docs/APP_MANIFEST_SPEC.md`) is a versioned interface. Breaking changes require a major version bump and a migration path.

---

## 2. Single Binary + Embedded UI

The entire platform ships as one Docker image containing one Go binary. The compiled SvelteKit SPA assets are embedded into that binary at build time using Go's `//go:embed` directive.

```
┌──────────────────────────────────────┐
│         openmasjid/core image         │
│                                       │
│   ┌───────────────────────────────┐   │
│   │        Go binary              │   │
│   │  ┌─────────────────────────┐  │   │
│   │  │  Embedded UI (go:embed) │  │   │
│   │  │  dist/ from SvelteKit   │  │   │
│   │  └─────────────────────────┘  │   │
│   │  API handlers                 │   │
│   │  Auth + sessions              │   │
│   │  Docker lifecycle             │   │
│   │  App Store client             │   │
│   └───────────────────────────────┘   │
└──────────────────────────────────────┘
```

**How it works:**
1. `make build` compiles the SvelteKit frontend into `frontend/dist/`
2. The Go build step picks up `frontend/dist/` via `//go:embed all:dist` in `backend/embed.go`
3. The Go binary serves the embedded static files for all non-API routes, and handles API routes itself
4. The final Docker image uses a multi-stage build: a builder stage compiles everything, and the final stage is `scratch` or `distroless` containing only the binary

**Why this approach?**
- **Operational simplicity:** one image, one container, one `docker pull`, one `docker run`. No nginx sidecar, no volume mounts for static assets, no separate frontend container to keep in sync with the backend version.
- **Version coherence:** the UI and the API it calls are always the exact same version. There is no "UI says API v2 but you're running API v1" failure mode.
- **Small image size:** `scratch` base + a statically linked Go binary + embedded assets results in an image well under 50 MB in practice.
- **Auditability:** anyone can inspect the running container and find exactly one process and one binary.

**Trade-off acknowledged:** hot-reload during development requires a separate process for frontend and backend. The `make dev` target handles this by running the SvelteKit dev server and the Go server separately, with the Go server proxying unknown routes to Vite.

---

## 3. Docker Socket Access — Core Managing Host Docker from Inside a Container

The OpenMasjidOS core container runs on the host and is given access to the host Docker daemon by mounting the Unix socket:

```yaml
# docker-compose.yml (how the core itself runs)
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

This allows the Go binary to use the Docker Engine API (via `github.com/docker/docker/client`) to:
- List containers and their state
- Start, stop, restart, and remove containers
- Stream container logs
- Listen to Docker events for real-time status changes
- Invoke `docker compose` commands for multi-container apps

**Why socket mount instead of a remote Docker API or a host agent?**
- The socket mount is the standard pattern for container management tools (Portainer, Watchtower, etc.). It is well understood and widely supported.
- A host agent would require additional installation complexity and a separate communication channel.
- A remote Docker API with TLS cert management would add significant setup burden for a non-technical installer audience.

**Security considerations for the socket mount:**
- The core container itself runs with the minimum required capabilities and a non-root user where possible.
- The Docker socket grants effectively root-equivalent access to the host. This is an unavoidable trade-off for a container management platform. It is documented clearly.
- App containers do NOT receive the socket unless their manifest explicitly declares `requires_docker_socket: true` and the admin approves this during install. This gate is enforced by the manifest validator in `internal/apps`.
- The socket path is a runtime configuration value, not hardcoded in business logic, to support environments that use a different socket path (e.g., Podman's compatibility socket).

---

## 4. App Isolation Model

Each installed app runs as its own Docker Compose project. This is the fundamental unit of isolation.

### Naming Convention
Every app's compose project is named `omos-<app-id>`, where `app-id` is the kebab-case identifier from the manifest (e.g., `omos-prayer-times-display`). This prefix ensures OpenMasjidOS-managed projects are distinguishable from any other Docker Compose projects on the host.

### Labeling
Every container, volume, and network created for an app is labeled:

```
com.openmasjid.app=<app-id>
com.openmasjid.version=<manifest-version>
```

These labels are the source of truth for which resources belong to which app. When listing installed apps, the core queries the Docker API for containers with `com.openmasjid.app` labels rather than relying on its own database, which means the state is always accurate even if the database is lost.

### Volume Layout
Per-app data volumes are bind-mounted to the host under `/opt/openmasjid/apps/<app-id>/data/`. This gives:
- Predictable backup targets (tar the directory)
- Easy manual inspection for debugging
- Clean removal: removing the directory removes all app data

Named Docker volumes are avoided for app data because bind mounts are easier to back up and inspect without Docker commands.

### Environment Injection
At install time, the core renders the app's `docker-compose.yml` with two categories of environment variables injected:
1. **Masjid profile values** declared in the manifest's `uses_profile` list (e.g., `MASJID_NAME`, `MASJID_LATITUDE`, `CALC_METHOD`)
2. **User-configured settings** from the manifest's `settings` schema, collected via the install UI

These are written to `/opt/openmasjid/apps/<app-id>/.env` and referenced by the compose file. The `.env` file is re-written on each install or update, and when the masjid profile changes, affected apps are flagged for restart.

### Port Management
The core tracks which host ports are claimed by installed apps to prevent conflicts. When an app declares a port in its manifest, the core checks availability before install and rejects the install with a clear explanation if a conflict exists.

---

## 5. Data Directory Layout at `/opt/openmasjid`

```
/opt/openmasjid/
├── config/
│   ├── profile.json          # masjid profile (name, location, prayer calc settings)
│   ├── settings.json         # platform settings (language, theme preference, update channel)
│   └── auth.json             # admin credentials (argon2id hash + salt, never plaintext)
│
├── apps/
│   ├── <app-id>/
│   │   ├── .env              # rendered env vars for this app's compose project
│   │   ├── docker-compose.yml  # the app's compose file (fetched from catalog at install)
│   │   ├── manifest.json     # the manifest at install time (locked version)
│   │   └── data/             # bind-mounted into the app's containers as persistent storage
│   └── ...
│
├── backups/
│   └── <timestamp>-<name>.tar.gz   # platform backup archives
│
└── core/
    └── docker-compose.yml    # the compose file that runs the core itself (written by installer)
```

**Design decisions:**
- JSON for all config files (not YAML or TOML): JSON has no ambiguity around types, no significant whitespace rules, and is easy to read/write from Go without a third-party library for simple cases.
- All files are human-readable and human-editable in an emergency. A volunteer who can SSH should be able to fix a broken config by editing a JSON file.
- The `core/` subdirectory is separate from `config/` because it is written by the installer and should not be mixed with user-managed config.

---

## 6. API Design Principles

The backend exposes a REST+JSON API consumed exclusively by the SvelteKit frontend. No public API versioning is planned for v1 — the binary and UI are always deployed together (see Section 2).

### Consistent Response Envelope

All responses use one of two shapes:

**Success:**
```json
{
  "data": { ... }
}
```

**Error:**
```json
{
  "error": {
    "code": "APP_NOT_FOUND",
    "message": "We couldn't find that app. It may have already been removed.",
    "detail": "optional technical string, only included in development mode"
  }
}
```

Error `code` values are uppercase snake-case constants defined in `internal/api/errors.go`. The frontend maps these to user-friendly messages via the i18n layer — the `message` field in the response is a fallback for clients that don't recognize the code.

### HTTP Status Codes
- `200 OK` — success with body
- `204 No Content` — success with no body (e.g., delete)
- `400 Bad Request` — client sent malformed input
- `401 Unauthorized` — not logged in
- `403 Forbidden` — logged in but not permitted (reserved for future role system)
- `404 Not Found` — resource does not exist
- `409 Conflict` — state conflict (e.g., app already installed, port in use)
- `500 Internal Server Error` — unexpected server error (details logged, not sent to client)

### WebSocket Upgrade
Long-lived status streams (container events, install progress, log tailing) are handled over WebSocket at `/ws`. The HTTP API is used for commands (install, stop, etc.); WebSocket is used only for push notifications from server to client. This keeps the REST API stateless and the WebSocket handler simple.

### Route Structure
```
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/auth/me

GET    /api/profile
PUT    /api/profile

GET    /api/apps                    # list installed apps + status
GET    /api/apps/:id                # single installed app detail
POST   /api/apps/:id/install
POST   /api/apps/:id/start
POST   /api/apps/:id/stop
POST   /api/apps/:id/restart
POST   /api/apps/:id/update
DELETE /api/apps/:id               # remove (body: { delete_data: bool })
GET    /api/apps/:id/logs           # recent log lines (SSE or paginated)

GET    /api/store/catalog           # proxied/cached catalog from OpenMasjidAPPS
GET    /api/store/apps/:id          # single catalog entry

GET    /api/system/status           # core version, uptime, resource summary
POST   /api/system/update-check

GET    /api/backups
POST   /api/backups
GET    /api/backups/:name/download
POST   /api/backups/:name/restore
DELETE /api/backups/:name

GET    /ws                          # WebSocket upgrade
```

---

## 7. Auth Model

OpenMasjidOS v1 supports a single administrator account. There is no multi-user system.

### First-Run Setup
On first boot, no credentials exist. The dashboard detects this via a `GET /api/auth/me` returning `{ "setup_required": true }` and routes the user to the setup wizard. The wizard collects:
1. Admin username and password (with strength feedback)
2. Masjid profile (name, location, calculation method, timezone, language)

Until setup is complete, all API routes except `/api/auth/setup` return `403`.

### Password Hashing
Passwords are hashed with **argon2id** using the parameters recommended in the OWASP Password Storage Cheat Sheet (memory: 64 MB, iterations: 3, parallelism: 2 at minimum — tuned up if the hardware supports it). The hash, salt, and parameters are stored in `/opt/openmasjid/config/auth.json`. Plaintext passwords never touch disk or logs.

argon2id was chosen over bcrypt because:
- It is the winner of the Password Hashing Competition and the current OWASP recommendation
- It is memory-hard, defeating GPU-based offline attacks
- Go's `golang.org/x/crypto/argon2` implementation is stable and well-maintained

### Sessions
Authentication produces a session token stored in a **secure, HTTP-only, SameSite=Strict cookie**. Sessions are stored in memory (a simple map guarded by a mutex) and optionally persisted to disk on graceful shutdown so they survive container restarts. Session expiry defaults to 24 hours of inactivity.

Why cookies over JWT?
- HTTP-only cookies are not accessible to JavaScript, eliminating an entire class of XSS token-theft attacks
- SameSite=Strict provides strong CSRF protection without a separate CSRF token for same-origin API calls
- The backend is stateful anyway (it manages Docker state), so the complexity benefit of stateless JWT tokens does not apply here

---

## 8. WebSocket Event Model

The WebSocket connection at `/ws` is a push channel from the server to the browser. The client sends only a single message type (a subscription filter); all data flows server-to-client.

### Connection Flow
1. Client connects after successful auth. The server verifies the session cookie on the HTTP upgrade request. Unauthenticated connections are rejected with `401`.
2. Client optionally sends a subscribe message to filter event types or app IDs.
3. Server streams events until the connection closes.

### Event Schema
```json
{
  "type": "app.status",
  "app_id": "prayer-times-display",
  "payload": {
    "status": "running",
    "cpu_percent": 0.4,
    "memory_mb": 38
  },
  "ts": "2026-06-18T14:23:01Z"
}
```

### Event Types
| Type | When | Payload |
|------|------|---------|
| `app.status` | Docker event received (start/stop/die/etc.) | app_id, new status string, resource snapshot |
| `app.install.progress` | During install | app_id, stage (pulling/starting/ready/failed), message |
| `app.log` | When a log subscription is active | app_id, stream (stdout/stderr), line |
| `system.update` | Update check result | version, changelog_url, is_urgent |
| `catalog.refreshed` | Catalog re-fetched | count of apps |

### Backend Architecture
The WebSocket hub (`internal/ws`) runs a single goroutine that:
1. Subscribes to Docker events via the Docker SDK's `Events()` method
2. Maintains a registry of connected WebSocket clients
3. Fans out events to all connected clients (filtered by subscription if set)
4. Handles client connect/disconnect safely with a sync.RWMutex

Install progress events are produced by the install goroutine in `internal/apps` and sent to the hub via an internal channel.

---

## 9. Catalog Fetch Strategy

The App Store is populated by fetching a static `catalog.json` file from the `OpenMasjidAPPS` GitHub repository. No custom backend is involved.

### Fetch URL
```
https://raw.githubusercontent.com/OpenMasjidOS/OpenMasjidAPPS/main/catalog.json
```

For resilience, the URL is configurable in platform settings so it can point to a mirror, a pinned commit, or a local file during development.

### Caching
The catalog is cached locally at `/opt/openmasjid/config/catalog-cache.json` with an ETag or Last-Modified header stored alongside it. Subsequent fetches use conditional HTTP requests (`If-None-Match` / `If-Modified-Since`). The cache TTL is 1 hour by default; the admin can trigger a manual refresh from the App Store UI.

If the remote fetch fails (network unavailable), the cached catalog is served with a "last updated X ago" notice in the UI. The App Store remains fully functional with stale catalog data — the platform never becomes unusable due to a catalog fetch failure.

### Individual App Manifests
`catalog.json` contains a summary of each app (name, tagline, category, version, icon URL, screenshot URLs). When a user opens an app detail page or initiates an install, the full manifest is fetched individually:

```
https://raw.githubusercontent.com/OpenMasjidOS/OpenMasjidAPPS/main/apps/<app-id>/manifest.yaml
```

The compose file is fetched at install time:
```
https://raw.githubusercontent.com/OpenMasjidOS/OpenMasjidAPPS/main/apps/<app-id>/docker-compose.yml
```

Both are validated before use (see `internal/apps/validator.go`).

---

## 10. Key Architectural Decisions

This section records decisions that were non-obvious or where alternatives were seriously considered.

### Router: `chi` over `gin` or `echo`
`chi` was chosen because it uses standard `net/http` handlers with no magic. Any middleware written for `chi` is portable to plain `net/http`. `gin` and `echo` offer more convenience but add more abstraction and a larger dependency footprint, which conflicts with the "lightweight and auditable" value. `chi`'s interface is also more idiomatic Go.

### Frontend: SvelteKit with `adapter-static` (SPA mode)
SvelteKit was chosen over React/Next.js or Vue because:
- Compiled components produce the smallest bundles of any major framework
- Built-in transition and animation primitives match the project's motion design requirements
- `adapter-static` with `ssr = false` in `svelte.config.js` produces a pure client-side SPA: a single `index.html` + JS/CSS bundle that the Go server can serve from `go:embed` without any Node.js runtime
- The SPA model matches the use case: the Go server is an API, and all routing is client-side

Server-side rendering was explicitly not used because it would require a Node.js runtime inside the container, defeating the single-binary goal.

### Go embed (`//go:embed`) over a volume-mounted `dist/`
Mounting the built frontend as a volume would require the build pipeline to produce the assets separately and the deployment to include them. `go:embed` ensures the binary is self-contained and version-coherent. The only trade-off is that a frontend-only change requires rebuilding the binary, but since both are in the same repo and the CI pipeline handles this, it is not a practical problem.

### JSON config files over SQLite
For the small amount of structured data in this platform (one profile, one settings object, one auth record, a handful of installed-app records), SQLite would add schema migration complexity without meaningful benefit. JSON files are human-readable, human-editable in an emergency, trivial to back up with `cp`, and trivially parsed in Go. If query complexity grows in a future version, SQLite can be introduced for specific data types without replacing the simple config files.

### No ORM
The Go backend does not use an ORM. Data access is via direct JSON marshal/unmarshal from disk files for config data, and the Docker SDK for container state. This keeps the codebase readable to contributors who are not Go experts.

### `argon2id` over `bcrypt`
Covered in Section 7. Short answer: current OWASP recommendation, memory-hard, well-supported in the Go standard library ecosystem.

### HTTP-only cookies over JWT
Covered in Section 7. Short answer: better XSS resistance, simpler implementation for a single-admin system.

### `docker compose` plugin invocation over Docker SDK for multi-container apps
The Docker Go SDK supports direct container management but not Docker Compose semantics. Rather than re-implement compose dependency ordering, health checks, and network creation, the core shells out to `docker compose` (the v2 plugin) for install/update/remove operations. Single-container operations (start, stop, restart, log streaming) use the SDK directly for better error handling and streaming support. All `docker compose` invocations are wrapped in `internal/docker/compose.go` — no `os/exec` outside that file.

### Port 8723 as default
A non-standard port was chosen to avoid conflicts with common development tools (8080, 3000, 4000, etc.) and common masjid AV/streaming software. 8723 has no known conflicts with common software as of the time of writing. It is configurable via the installer.

---

## 11. What Is Deliberately Not Built (v1)

These are in-scope concepts that were scoped out to keep v1 shippable:

| Feature | Why deferred | Notes |
|---------|-------------|-------|
| HTTPS / TLS termination | Adds cert management complexity. v1 assumes the platform runs on a trusted LAN. | A Caddy sidecar or Cloudflare Tunnel helper is the planned v1.1 path |
| Multiple admin users with roles | Adds auth complexity. One volunteer per masjid is the primary use case. | Schema is designed to allow extension |
| Remote access wizard (Tailscale, etc.) | Important UX but not core platform. | Deferred to v1.1 |
| App signature verification | Requires a signing infrastructure in OpenMasjidAPPS. Plan to add before catalog opens to community submissions. | The manifest validator provides a partial safety net |
| Per-app resource limits (cgroups) | `resources.memory_hint` in manifest is advisory in v1; enforcement deferred. | Docker resource limits can be added to compose rendering in a follow-up |
