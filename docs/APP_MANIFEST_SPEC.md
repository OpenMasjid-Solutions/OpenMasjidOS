# App catalog contract (platform side)

> **Where to build an app:** the authoritative, hands-on guide lives in the **OpenMasjidAPPS** repo
> — its [`CLAUDE.md`](https://github.com/hasan-ismail/OpenMasjidAPPS/blob/main/CLAUDE.md) and
> `docs/BUILDING_AN_APP.md`. **This document is the platform side of the contract** — the exact
> `catalog.json` shape and install behaviour that OpenMasjidOS guarantees. The two must agree; if
> they ever diverge, this file and OpenMasjidAPPS's `CLAUDE.md §2` are the things to reconcile.

## The model

Apps do **not** live in this repo, and they are **not** folders inside OpenMasjidAPPS either:

```
app repos (one per app) ──listed in──▶ OpenMasjidAPPS/registry.yaml ──build──▶ catalog.json ──fetched by──▶ OpenMasjidOS
```

- **Each app** is its own public GitHub repo (`openmasjid-<id>`): a `manifest.yaml`, a
  `docker-compose.yml`, an icon, screenshots, and a **public multi-arch** image.
- **OpenMasjidAPPS** is a catalog: a `registry.yaml` of app repos + a build script that fetches each
  one and assembles a single **`catalog.json`** at its repo root.
- **OpenMasjidOS** only ever fetches that one file, from (default, `packages/core/src/config.ts`):
  ```
  https://raw.githubusercontent.com/hasan-ismail/OpenMasjidAPPS/main/catalog.json
  ```
  Overridable with `OPENMASJID_CATALOG_URL`. The catalog is cached briefly and fails soft (an
  unreachable catalog never breaks the dashboard).

## `catalog.json` shape

`{ "apps": [ CatalogApp, … ] }` — a bare top-level array is also accepted, and any extra top-level
fields are ignored. Each entry is a `CatalogApp` (`packages/core/src/apps/types.ts`):

| Field | Required | Notes |
|-------|----------|-------|
| `id` | ✅ | Unique, kebab-case, must match `^[a-z0-9][a-z0-9-]{0,79}$`. The platform **drops** any entry whose id is invalid (it's used as a path segment + compose project name). |
| `name` | ✅ | Display name. |
| `version` | ✅ | Semver string. Drives the app's "Check for update". |
| `compose` | ✅ | The app's **entire `docker-compose.yml` as a string**. This is what runs. |
| `tagline` | – | One short line on the card. |
| `category` | – | `displays` \| `donations` \| `community` \| `quran` \| `admin` \| `utilities`. |
| `author` | – | |
| `license` | – | The app author's choice (apps run at arm's length — see `CLAUDE.md §3`). |
| `icon` | – | Absolute URL. |
| `screenshots` | – | Array of absolute URLs. |
| `description` | – | Markdown, shown on the app detail page. |
| `settings` | – | Fields collected from the user before install (below). |
| `ports` | – | `{ container: number, label?: string }[]` — informational only. |
| `sso` | – | `true` to opt into single sign-on (below). The platform then issues the app a per-app secret at install and will honour its `/api/auth/session` calls. Omit/false = no SSO. |
| `notifications` | – | `true` to opt into Fabric notifications (below) — the app may POST `/api/fabric/notify` to relay messages to the masjid's configured webhook. Issues the same per-app secret. Omit/false = no notifications. |
| `https` | – | **Set ONLY by apps that use Stripe.** Stripe's in-person M2 reader (Stripe Terminal SDK) and in-page card fields (Elements) require a browser secure context (HTTPS). When `true`, the platform serves the app over HTTPS on a dedicated host port (from a pre-mapped range; TLS terminated with the dashboard's cert) and the app's "Open" URL becomes `https://`. The app stays a plain HTTP container — it handles no TLS. **Non-Stripe apps must omit this** and stay on plain HTTP; HTTPS is **not** enforced for them or for 3rd-party/custom apps. |

### `settings` fields (`SettingField`)

```yaml
- key: LATITUDE          # env var name; referenced as ${LATITUDE} in the compose
  label: Latitude        # shown in the install dialog
  type: text             # text | select | number | password | boolean
  options: [A, B, C]     # required only for type: select
  default: ""            # optional pre-filled value
```

The platform collects **everything masjid-specific here** (location, calc method, madhab, timezone,
masjid name). **No platform profile is ever injected** — the platform holds no masjid data.

## Install & lifecycle behaviour (what the core guarantees)

- **Install** — writes `compose` to `compose.yml`, writes the user's `settings` answers to a `.env`,
  then `docker compose -p omos-<id> --env-file .env up -d --remove-orphans`. The compose references
  settings as `${KEY}`. Per-app files + data live under `/opt/openmasjid/apps/<id>/`.
- **Open URL** — derived from the container's **published host port**, so a compose must publish its
  web-UI port (e.g. `ports: ["8080:80"]`). The platform detects host-port conflicts before install
  and lets the user remap.
- **Discovery** — by the compose **project name** `omos-<id>` (Docker's automatic
  `com.docker.compose.project` label). Apps add **no** special labels; the platform records each
  app's kind/version in `apps/<id>/meta.json`.
- **Update** — re-fetch the catalog entry, rewrite `compose.yml` (keeping the user's `.env`), then
  `compose pull` + `up -d`. Settings and data are preserved.
- **Remove** — `compose down` (with `--rmi all -v` when the user also chooses to delete data).

## Requirements an app's compose must meet

- **Pin the image tag** (`image: ghcr.io/<owner>/<repo>:1.2.3`), to a **public, multi-arch**
  (`amd64`+`arm64`) image — the masjid's host pulls it without authentication.
- **Publish the web-UI port** with a non-privileged default host port (≥ 1024).
- **Reference settings as `${KEY}`** via an `environment:` block; use **named volumes** for data.
- **Least privilege** — no `privileged: true`, `network_mode: host`, `pid/ipc: host`, `cap_add`,
  host devices, or Docker-socket / sensitive host-path mounts. The platform risk-checks composes and
  the catalog build refuses dangerous ones.

The full per-app repo layout, image-publishing, and `registry.yaml` steps are documented in
**OpenMasjidAPPS** — start there.

## OpenMasjidOS Fabric (platform↔app integration — appearance + single sign-on)

The **OpenMasjidOS Fabric** is the platform↔app integration layer: the unified appearance + single
sign-on / API that lets an installed app inherit the dashboard's look and (opt-in) share its login.
All of it is **optional and backwards-compatible**: an app must work standalone. If these hooks are
absent or the platform is unreachable, the app uses its own appearance + its own login. **None of it
moves masjid data into the platform** — it's presentation + auth convenience only.

**Appearance inherit (so the app matches the masjid's look)**
- **On open**, the dashboard appends the viewer's presentation prefs to the app URL as a fragment:
  `#omos=<base64url(JSON)>` where the JSON is
  `{ v:1, theme, wallpaper, wallpaperImage?, accent, lang }`. The fragment is never sent to a server
  or logged. The app reads `location.hash` on load, applies + persists it, and clears the hash.
- **Live sync** (optional): `GET /api/public/appearance` returns the same payload
  (`{ v:1, theme, wallpaper, wallpaperImage, accent, lang }`). It's public and **CORS-enabled**
  (`Access-Control-Allow-Origin: *`), so an app's browser can poll it to follow theme changes.

**Single sign-on (so the app can share the dashboard login)** — opt in with `sso: true` in the
manifest. SSO is **identity-bound**: the platform issues each SSO app a per-app secret at install and
only honours session checks that present it, so the shared `omos_session` cookie can't let one
installed app validate (or impersonate) the session as another.

- On install the platform makes these available to an `sso: true` (or `notifications: true`) app.
  **Delivery is `${VAR}` substitution, not auto-set container env:** the platform writes the app's
  `.env` and runs `docker compose --env-file …` (exactly like `settings`), so the app's compose **must
  reference** them in `environment:` (`OPENMASJID_BASE_URL: ${OPENMASJID_BASE_URL:-}`, etc.) or they
  never reach the container and the Fabric silently no-ops. The vars:
  - `OPENMASJID_APP_ID` — the app's id.
  - `OPENMASJID_BASE_URL` — where the platform is reachable. **A platform-set trust input** — it is
    the address the app forwards the user's cookie to. The platform pins it to its own LAN address
    (and validates the install `Host`); override on the core with the `OPENMASJID_BASE_URL` env for
    reverse-proxy/multi-host setups. An app must not let this be set by anyone but the platform.
  - `OPENMASJID_APP_SECRET` — a random per-app secret. **Treat it as a credential** (don't log/expose
    it). Injected only for `sso: true` apps.
- The session cookie (`omos_session`, HttpOnly, SameSite=Strict) is sent by the browser to the app's
  port too (same host, different port = same-site). The app's **backend** calls
  `GET ${OPENMASJID_BASE_URL}/api/auth/session` with **two** things:
  - the user's cookie, forwarded verbatim: `Cookie: omos_session=<value>` (read it **only** from the
    incoming request's cookie — never a query/header/body), and
  - the app's own identity: header **`X-OpenMasjid-App-Secret: ${OPENMASJID_APP_SECRET}`**.
  The platform replies `{ "authenticated": true, "username": "…" }` only when the cookie is valid
  **and** the secret matches a known SSO-capable app; otherwise `{ "authenticated": false }`. Treat
  `username` as an untrusted display string (cap/escape it). If `authenticated`, treat the request as
  signed-in; otherwise fall back to the app's own login.
- This call is **server→server** (app backend → platform). `/api/auth/session` is **not** CORS-enabled
  on purpose, so a cross-origin page can't read someone's auth status. It **fails closed**: a missing/
  garbage/revoked cookie, or a missing/unknown app secret, returns `authenticated:false`. Never trust a
  browser-supplied username/header — only ever trust what `/api/auth/session` confirms for the cookie
  on that request. Cache a positive result briefly (~30–60 s) per token.
- **Revocation:** the platform flips to `authenticated:false` immediately on logout/password change, so
  keep the positive cache short (~45 s) and cap the SSO-minted session (e.g. ~1 h) so a stale session
  can't linger.
- **The session is an IDENTITY signal only — never a platform credential.** `/api/auth/session` tells
  your app *who is viewing it*; it does **not** grant your app any authority over the platform. The
  dashboard's own API now requires an origin-bound key the platform UI holds in its own browser storage
  (which your app, on a different port, can't read), so the shared cookie alone can't drive the
  platform's API — and your app must never try to. Use the SSO result to log the viewer into **your
  app**, nothing more.

> Same-host assumption: cookie-based SSO works because the dashboard and the app share a host on
> different ports. An app on a different host simply won't see the cookie and falls back to its own
> login. **Transport:** this is fine on a plain-HTTP LAN with `SameSite=Strict`; if the platform or an
> app ever runs cross-host, `/api/auth/session` must be HTTPS-only and `omos_session` must be `Secure`.

**Notifications (so an app can alert the masjid)** — opt in with `notifications: true`. The masjid
admin configures ONE webhook (Slack / Discord / generic) in **Settings → Notifications**; apps relay
through the platform and **never see the webhook URL** (the platform owns the destination, so an app
can't point it anywhere — no SSRF from apps).

- The app's **backend** posts to the platform with its per-app secret:
  ```
  POST ${OPENMASJID_BASE_URL}/api/fabric/notify
    X-OpenMasjid-App-Secret: <OPENMASJID_APP_SECRET>
    Content-Type: application/json
    { "text": "A new donation of $50 was received.", "title": "Donation", "level": "success" }
  → 200 { "delivered": true }   |   { "delivered": false, "reason": "disabled" | "rate_limited" | … }
  ```
- `text` is required; `title` and `level` (`info`|`success`|`warning`|`error`) are optional. The
  platform formats the message for the configured service and posts it server-side.
- Requires the **notifications capability** (the secret alone isn't enough — an SSO-only app can't
  send). Rate-limited per app (≈20/min) and platform-wide, so one app can't flood Slack/Discord.
- Fails soft: if the admin hasn't enabled notifications, the call returns `{delivered:false}` rather
  than an error — so the app keeps working. This is server→server and not CORS-enabled.
