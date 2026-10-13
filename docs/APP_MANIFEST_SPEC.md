<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# App catalog contract (platform side)

> **Where to build an app:** the authoritative, hands-on guide lives in the **OpenMasjidAPPS** repo
> — its [`CLAUDE.md`](https://github.com/OpenMasjid-Solutions/OpenMasjidAPPS/blob/main/CLAUDE.md) and
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
  https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidAPPS/main/catalog.json
  ```
  Overridable with `OPENMASJID_CATALOG_URL`. The catalog is cached briefly and fails soft (an
  unreachable catalog never breaks the dashboard).

## `catalog.json` shape

`{ "apps": [ CatalogApp, … ] }` — a bare top-level array is also accepted, and any extra top-level
fields are ignored. Each entry is a `CatalogApp` (`packages/core/src/apps/types.ts`):

| Field | Required | Notes |
|-------|----------|-------|
| `id` | ✅ | Unique, kebab-case, must match `^[a-z0-9][a-z0-9-]{0,79}$`. The platform **drops** any entry whose id is invalid (it names the app's directory and compose project). It is also the app's default address through the tunnel — a default, not a promise: see *Tunnel uplink*. |
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
| `fabric` | – | Opt into the **app-to-app broker** (below): `{ provides: [{ capability }], consumes: ["<app-id>/<capability>"] }`. Any `fabric` block issues the app the per-app secret (like `sso`). Grants are static from the manifest. Catalog apps only. |
| `tunnel` | – | `true` = the app **requests** to be reachable from the internet through the OS's Cloudflare tunnel (below). It's only a request — the admin confirms exposure in Settings → Remote access. Not shared ⇒ the app is not public: it stays on the LAN, and from outside only the admin can open it (so it must still be base-path aware — see *Tunnel uplink*). |
| `email` | – | `true` to opt into Fabric email (below) — the app may `POST /api/fabric/email` to send mail (receipts, parent notices) via the admin's SMTP/Resend provider. Issues the per-app secret; the app never sees the credentials or the From address. |
| `alerts` | – | A list of alert types this app can raise, `{ id, label, description? }[]` (below). Each gets a granular on/off in Settings → Alerts (all on by default). The app fires one with `POST /api/fabric/alert`. Declaring alerts issues the per-app secret. |
| `whatsapp` | – | `true` to opt into Fabric WhatsApp — the app may `POST /api/fabric/whatsapp` to send through the masjid's own gateway, and never sees the gateway credentials. It **queues** (`202 {queued}`), never sends synchronously, and takes **one recipient per call**. `GET` the same path first to learn whether this masjid can send at all, and read an absent field as `false`. **Which events go out and to whom is YOUR setting** — the platform's alerts matrix has no WhatsApp column for apps, because it routes to the admin's one number. For announcements, `GET /api/fabric/whatsapp/groups` (only the groups the **admin** approved) and send `group` instead of `to`. An optional `media` sends an **image** (png/jpeg/webp, 2 MB decoded) with `text` as its caption — check `media` on the `GET` first. Never use it for anything auth-critical: it is an unofficial client and the number can be restricted. See [`WHATSAPP.md`](WHATSAPP.md). Issues the per-app secret. |
| `commands` | – | A list of commands an admin can run against this app over WhatsApp, `{ id, label, description?, argument?: { label }, confirm? }[]` (below). The platform authorises, renders the menu and asks for confirmation; the app only executes, at `POST /fabric/commands/run`. Max 12; `id` must be kebab-case, not all digits, and not `help`/`yes`/`no`/`cancel`/`stop`. `argument` must be an **object** — `argument: true` is refused rather than coerced. Declaring commands issues the per-app secret (required: the platform authenticates to you with *your* secret). **`commands` is a reserved Fabric capability** — you cannot expose this handler to other apps via `fabric.provides`. |
| `domain` | – | `true` to opt into the **domain** capability — the app may `GET /api/fabric/site` to learn its own PUBLIC URL (the apps' address from Settings → Remote access + the app's path) for building absolute links: Stripe success/cancel URLs, webhook endpoints, QR codes — and its `basePath`. Returns an empty URL when remote access is off or the app is not shared online (the admin opening it from outside does not give it one), so treat "no URL yet" as normal rather than an error. Issues the per-app secret. |
| `comingSoon` | – | `true` marks this as a **teaser** for an app that is not released yet. The entry needs no repo, no image and no `compose` — the App Store renders it with a "Coming soon" badge and no install action, and the platform **refuses to install it** (`store.ts`). Use it to reserve a listing; drop the flag and add the `compose` when the app is ready. |

### `settings` fields (`SettingField`)

```yaml
- key: LATITUDE          # env var name; referenced as ${LATITUDE} in the compose
  label: Latitude        # shown in the install dialog
  type: text             # text | select | number | password | boolean | stripe-account
  options: [A, B, C]     # required only for type: select
  default: ""            # optional pre-filled value
```

**`type: stripe-account`** is a platform-aware picker: the install dialog renders a **dropdown of the
Stripe accounts the admin configured** in Settings → Payments and passes the chosen account's id as the
value (blank → the only/first account). Use it for an app's "which Stripe account" setting so the admin
never re-types keys in the install dialog; the app then fetches that account's keys over the Fabric
(`GET /api/fabric/stripe?account=…`, with manifest `stripe: true`). Platform v0.32.2+; older platforms
fall back to a plain text box.

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
- **On open**, for an app that opts into `sso` or `notifications`, the dashboard appends the
  viewer's presentation prefs to the app URL as a fragment (no other app receives it):
  `#omos=<base64url(JSON)>` where the JSON is
  `{ v:1, theme, wallpaper, wallpaperImage?, accent, lang }`. The fragment is never sent to a server
  or logged. The app reads `location.hash` on load, applies + persists it, and clears the hash.
- **Live sync** (optional): `GET /api/public/appearance` returns the same payload plus the masjid
  logo path (`{ v:1, theme, wallpaper, wallpaperImage, accent, lang, logo }`). It's public and
  **CORS-enabled** (`Access-Control-Allow-Origin: *`), so an app's browser can poll it to follow theme
  changes. `logo` is `"/api/public/logo"` when the admin has uploaded a masjid logo (else `""`);
  resolve it against the SAME origin you fetched appearance from, and use it to brand your own pages or
  receipts (it's a raster PNG/JPG/WebP). A browser outside the masjid cannot reach the platform's LAN
  address, but both routes also answer on the apps' address itself — `/api/public/appearance` and
  `/api/public/logo` at its root — so a page served there can fetch them from its own origin.

**Single sign-on (so the app can share the dashboard login)** — opt in with `sso: true` in the
manifest. SSO is **identity-bound**: the platform issues each SSO app a per-app secret at install and
only honours session checks that present it, so the shared `omos_session` cookie can't let one
installed app validate (or impersonate) the session as another.

- On install the platform writes these into the app's `.env` — the first two for every app, the
  secret only for an app that opts into a Fabric capability (`sso`, `notifications`, `email`,
  `alerts`, … — each row of the table above says so).
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
    it). Injected only for an app that opts into a Fabric capability.
- The session cookie (`omos_session`, HttpOnly, **SameSite=Lax**, non-Secure on the LAN by default) is sent by the
  browser to the app when the admin opens it. (Through the tunnel the `omos_session` your app receives is
  a different value — an access token for your app alone; see *Single sign-on from outside the masjid*
  below.) It is `Lax` (not `Strict`) on purpose: the dashboard is HTTPS but
  most apps are HTTP, so clicking **Open** is a cross-scheme top-level navigation that browsers treat
  as cross-site — `Strict` would withhold the cookie on that first open (SSO would only work after a
  reload), whereas `Lax` rides a top-level GET navigation. **So your app must read the cookie from the
  request that loads it** (the Open navigation carries it). The app's **backend** then calls
  `GET ${OPENMASJID_BASE_URL}/api/auth/session` with **two** things:
  - the user's cookie, forwarded verbatim: `Cookie: omos_session=<value>` (read it **only** from the
    incoming request's cookie — never a query/header/body), and
  - the app's own identity: header **`X-OpenMasjid-App-Secret: ${OPENMASJID_APP_SECRET}`**.
  The platform replies `{ "authenticated": true, "username": "…" }` only when the cookie is valid — a
  dashboard session, or, from outside, the access token made for the app presenting the secret — **and**
  the secret matches a known SSO-capable app; otherwise `{ "authenticated": false }`. Treat
  `username` as an untrusted display string (cap/escape it). If `authenticated`, treat the request as
  signed-in; otherwise fall back to the app's own login.
- **A `429` means the platform could not answer — it is NOT a sign-out.** It carries
  `{ "authenticated": false, "retryable": true }` and a `Retry-After` header. `authenticated:false` is kept
  so an app that reads only that field still fails closed, which is correct and which some apps rely on for
  security (refusing a local-password claim while the platform is reachable). But an app that can tell the
  difference should show a gentle "Connecting to OpenMasjidOS…" and ask again after `Retry-After`, rather
  than "sign in through your dashboard" — that message sends the admin to do something they have already
  done. Since platform 0.51.2 the sign-in check has its own budget and should not be refused in normal use.
- **Send ONLY those two headers.** Do not relay the incoming request's headers to the platform. An app reached
  through the remote-access tunnel receives `x-forwarded-proto: https` and Cloudflare's `cf-ray`; forwarded
  to `/api/auth/session`, either one makes the platform treat the call as internet traffic and refuse it
  (that route is local-network only), which reads as "not signed in".
- **Platform sessions survive a platform restart** (since 0.51.2). Before that, every OpenMasjidOS update
  silently invalidated the admin's session while the browser kept the cookie for a week, so a fresh SSO
  check after an update could fail with the dashboard still looking signed in.
- This call is **server→server** (app backend → platform). `/api/auth/session` is **not** CORS-enabled
  on purpose, so a cross-origin page can't read someone's auth status. It **fails closed**: a missing/
  garbage/revoked cookie, or a missing/unknown app secret, returns `authenticated:false`. Never trust a
  browser-supplied username/header — only ever trust what `/api/auth/session` confirms for the cookie
  on that request. Cache a positive result briefly (~30–60 s) per token.
- **Revocation:** the platform flips to `authenticated:false` immediately on logout/password change —
  and, for an access token from outside, the moment the remote session it came from ends (sign-out,
  a password change, expiry, a backup restored) or stops counting from outside (a new authenticator
  or backup codes, or emailed codes switched on or off — unless that session made the change itself,
  from outside), or remote administration stops for any reason (switched off, the tunnel turned off,
  two-step sign-in turned off) — so keep the positive cache short (~45 s) and cap the SSO-minted
  session (e.g. ~1 h) so a stale session can't linger.
- **The session is an IDENTITY signal only — never a platform credential.** `/api/auth/session` tells
  your app *who is viewing it*; it does **not** grant your app any authority over the platform. The
  dashboard's own API now requires an origin-bound key the platform UI holds in its own browser storage
  (which your app — on a different port on the LAN, a different hostname through the tunnel — can't
  read), so the shared cookie alone can't drive the platform's API — and your app must never try to.
  Through the tunnel you never even hold a dashboard session: beyond letting the admin's browser
  through to your app, the access token is accepted by `/api/auth/session`, for your app, and by no
  other platform route. Use the SSO result to log the viewer into **your app**, nothing more.

> Same-host assumption (the LAN): cookie-based SSO works because the dashboard and the app share a
> host on different ports, and a browser does not keep cookies apart by port. **Through the tunnel your
> app never receives a platform session cookie** — the platform removes them before forwarding — so it
> hands your app its own access token instead (below). An app on any
> other host simply won't see a cookie and falls back to its own login. **Transport:** this is fine on
> a plain-HTTP LAN with `SameSite=Lax` (Lax, not Strict — the dashboard is HTTPS and apps are HTTP, so
> "Open" is a cross-scheme navigation Strict would refuse the cookie on). The access token is set
> `Secure`, because the apps' address is HTTPS. If the platform or an app ever runs the sign-in check
> cross-host, `/api/auth/session` must be HTTPS-only and `omos_session` must be `Secure`.

**Single sign-on from outside the masjid (through the tunnel)** — platform 0.51.2-dev.16+. Nothing to
opt into beyond `sso: true`, and nothing new to call: the LAN steps above work unchanged.

- **One hostname, shared with the dashboard.** When the admin manages OpenMasjidOS from outside
  (Settings → Remote access), the dashboard is served at the root of **"Your apps’ address"** (e.g.
  `https://omos.example.org/`), with every app beside it at `/<path>/` (platform 0.51.2-dev.17+;
  dev.16 used a separate "Dashboard address"). A browser draws the line around a site by scheme +
  host + port — never by path — so your app's pages are on the dashboard's own origin there. The
  platform keeps them out of the dashboard with a key no page of yours can obtain, and removes the
  dashboard's cookie (`__Host-omos_session`) from everything it forwards to you. **Never try to
  reach the dashboard from your pages** — not by `fetch`, frame, or a window you open: none of it
  works, and an app that tries is behaving like an attack. Your app may not take `store`, `apps`,
  `files`, `settings` or `design-system` as its path either: those are the dashboard's pages.
- **How the admin arrives.** Pressing **Open** asks the platform for a one-use link, good for 60
  seconds, and opens it in a new tab: `https://<apps' address>/_omos/open?t=…` — a platform route
  (`_omos` can never be your app's path). The platform spends it, sets
  `omos_session=<access token>; Path=/<path>; Max-Age=…; Secure; HttpOnly; SameSite=Lax` and answers
  `303` to `/<path>/`, with the `#omos=` appearance fragment carried through as on the LAN. A spent or
  expired link gets a short "This link has expired" page (`410`). The cookie lasts no longer than the
  admin's remote session, so a later visit in the same browser carries it too.
- **So through the tunnel, `omos_session` is an ACCESS TOKEN for your app — not the dashboard's
  session.** Forward it to `/api/auth/session` exactly as on the LAN — same two headers, same answer.
  It is accepted only from the app it was made for (the secret you present must be yours: another app
  presenting it gets `authenticated:false`), only while the admin's remote session — one made on the
  remote dashboard itself — is valid and remote administration is on, and it cannot be turned back
  into the session or into another app's token. It opens your app and nothing else: no dashboard
  route accepts it. Treat it as opaque: it starts `a1.` and contains dots, and is shaped to pass the
  cookie-value check OpenMasjid apps apply before forwarding (`^[A-Za-z0-9._~%+/=-]{1,4096}$`) — an
  app with a narrower check must accept that shape.
- **It is the only platform cookie you will ever receive through the tunnel.** The platform removes
  every `omos_session` — whatever its value, the admin's LAN session included — and every
  `__Host-omos_session` from the `Cookie` header it relays, on HTTP requests and WebSocket handshakes
  alike, and then puts your own valid access token back FIRST, if the request carried one. A member of
  the public carries none, so fall back to your own login exactly as when the platform is absent. Your
  app's own cookies pass through untouched.
- **Never set `omos_session` (or `__Host-omos_session`) yourself.** Through the tunnel the platform
  strips such a `Set-Cookie` from your HTTP responses — the apps share one hostname there, and one app
  setting it for another's path could sign the admin out of that app, or into an account of its own
  choosing. It does **not** filter a WebSocket handshake's response, and on the LAN it filters nothing
  — and there that name is the dashboard's own cookie (cookies are not kept apart by port). The name
  belongs to the platform.

**Notifications (so an app can alert the masjid)** — opt in with `notifications: true`. The masjid
admin configures ONE webhook (Slack / Discord / generic) in **Settings → Alerts**; apps relay
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

## Fabric app-to-app broker (`fabric:` — one app calling another)

The broker lets one installed catalog app call another through the platform, so apps
never learn each other's addresses or secrets. Opt in with a `fabric` block:

```yaml
fabric:
  provides:                 # capabilities THIS app serves at /fabric/<capability>/<method>
    - capability: billing   # kebab-case: ^[a-z0-9][a-z0-9-]{0,39}$
  consumes:                 # capabilities THIS app may call, "<target-app-id>/<capability>"
    - students/billing
```

- Any `fabric` block issues the app the **same per-app secret** as `sso`/`notifications`
  (`OPENMASJID_APP_ID` / `OPENMASJID_BASE_URL` / `OPENMASJID_APP_SECRET`; same `${VAR}`-in-
  `environment:` footgun — you must reference them in the compose or they never reach the container).
- **Grants are static from the manifest** (no admin approval UI in v1). Both sides must agree: the
  caller lists `consumes: ["<target>/<cap>"]` **and** the target lists `provides: [{capability}]`.
- Calls are **catalog-app ↔ catalog-app only** (custom/community apps get no secret, so they can't broker).

**Calling** (the consumer's backend):

```
POST ${OPENMASJID_BASE_URL}/api/fabric/app/<targetAppId>/<capability>/<method>
  X-OpenMasjid-App-Secret: <OPENMASJID_APP_SECRET>   (the CALLER's secret)
  Content-Type: application/json
  { …json… }
```

The platform authenticates the caller, checks the grants, resolves the target, and forwards the JSON
to `http://<target>/fabric/<capability>/<method>` — injecting the **target's own** secret as
`X-OpenMasjid-App-Secret` and the trusted caller id as `X-OpenMasjid-Caller-App`. Limits: JSON only,
≤256 KB each way, 10 s timeout, no redirects, per-caller rate limit. LAN-only (never over the tunnel).

**Providing** (the target's backend) — mount your served capabilities under `/fabric/<capability>/…`
and trust the platform-set headers only:

- Verify `X-OpenMasjid-App-Secret` equals **your own** `OPENMASJID_APP_SECRET` (that's how you know
  the call came from the platform, not directly from another container).
- Read `X-OpenMasjid-Caller-App` for the caller's id (set by the platform; a caller can't spoof it).
- Your `/fabric/*` routes are refused over the public tunnel by the platform — but enforce it yourself
  too (reject `/fabric/*` unless the request came from the platform).

**Broker error envelope.** When the platform (not the target) fails, it replies
`{ "fabric_error": { "code", "message" } }` with codes: `unauthorized` (401), `not_granted` (403),
`bad_request` (400), `target_not_installed` / `target_unreachable` (503), `timeout` (504),
`payload_too_large` (413), `response_too_large` (502), `rate_limited` (429). A success passes the
target's own status + JSON straight through. One refusal comes before the broker and so without
the envelope: your app's Fabric calls — broker calls, email, WhatsApp sends, alerts, `site`… —
share one per-app budget (120 a minute; the sign-in check and WhatsApp outcome reads have budgets
of their own), and past it the answer is `429 { "error": "Too many requests." }`. Treat any `429`
as `rate_limited`.

**Fail-soft doctrine (required of consumers).** Treat every `fabric_error` as "feature unavailable,
app still fine" — never a hard crash. E.g. hide a School-payments tab on `target_not_installed`; queue
and retry on `target_unreachable`. (Same spirit as the notify fail-soft above.)

## Tunnel uplink (`tunnel: true` — being reachable from the internet)

By default an app is not public: on the LAN it is reached at its own port, and from outside only the
admin can open it (*Opened from outside*, below). Set `tunnel: true` to **request** internet exposure
through the OS's Cloudflare tunnel. It is only a request: exposure is **off until the admin says yes**.

Where the admin answers (v0.45.0+): declaring `tunnel: true` makes the App Store show your app an
install dialog — **even if you declare no `settings:`**, so a one-click install can still ask — with a
single pre-ticked checkbox, "Share this app over the internet". Whatever they choose is applied at
install, and they can change it later per-app in Settings → Remote access or on the app's own page.
So: state the request in your manifest, and be prepared for the answer to be no.

When the admin exposes the app, the platform serves it to anyone at `https://<domain>/<path>/…` —
`<domain>` being **"Your apps’ address"** in Settings → Remote access, and `<path>` the app's
address there (*Your address*, below) — and injects:

- **`OPENMASJID_PUBLIC_URL`** — the app's public base URL (e.g. `https://omos.example.org/donations`),
  or **empty string** when the app isn't exposed / the tunnel is off. Reference it in your compose
  (`environment: { OPENMASJID_PUBLIC_URL: ${OPENMASJID_PUBLIC_URL:-} }`) and use it to build absolute
  links (Stripe success/cancel URLs, webhooks, QR codes). The **live** source of truth stays
  `GET /api/fabric/site` (requires the `domain` capability); the env var is a convenience mirror.

Your `/fabric/*` space is **never** served over the tunnel — not even to the admin's access token;
those routes are LAN-only (platform-enforced, and you should enforce it too).

**Your address — `/<path>/` on the apps' address.** Build your app to be base-path aware:

- **You are served under it, prefix and all.** The platform forwards the request's path as it
  arrived — `/<path>/…`, the prefix **not** stripped — so every route, asset, API call and WebSocket
  URL must live under it. On the masjid's network the same app is opened at its own port, at `/`, so
  it has to answer both ways. URLs relative to a page under `/<path>/` work in both places.
- **The bare `/<path>` reaches you too, and is never cached.** A request for it — no trailing slash,
  with or without a query, by any method, a WebSocket handshake included — is passed to your app
  like any other, on the same terms: to anyone if you are shared, and otherwise only to the admin's
  browser (anyone else gets the usual 404). Two things are different there. Whatever you answer —
  except to a WebSocket handshake, whose answer goes back as you send it — is made uncacheable: the
  platform sets `Cache-Control: private, no-store`, `CDN-Cache-Control: no-store` and
  `Cloudflare-CDN-Cache-Control: no-store` over your own headers and drops `Expires`. And a browser
  fetching a service worker's script there never reaches you: the platform answers it with a worker
  that removes itself (*Service workers*, below, says why). There is no redirect between `/<path>`
  and `/<path>/`, in either direction, so you may treat `/<path>` as your root — and redirect
  `/<path>/` to it, as Next.js does by default with a `basePath` — without a loop. Mind what that
  does to relative URLs: a page at `/<path>` sits in the folder `/`, so `app.js` or `./api` on it
  resolves to `/app.js` or `/api`, outside your address (*Nothing outside your path is yours*,
  below). Serve such a page with links that carry the base path (`/<path>/app.js`), as a framework
  given a base path does, or serve your pages under `/<path>/`. Open, from outside, always lands on
  `/<path>/`.
- **`<path>` is not necessarily your id.** By default it is your id, but the admin can change a
  shared app's address in Settings → Remote access, and an install whose id is already another app's
  address — or is one of the first segments the platform keeps for itself, `api`, `trpc` and
  `assets`, which are never an app's address — is given the next free one instead: `<id>-2`,
  `<id>-3`… So never build it from `OPENMASJID_APP_ID`. Take it from `basePath` in
  `GET /api/fabric/site` (the `domain` capability; set whenever remote access is on with an apps'
  address, shared or not), or from the path of `OPENMASJID_PUBLIC_URL` when you are shared — or
  avoid needing it, with relative URLs. Whatever it is, it has an id's shape — lower-case letters,
  digits and hyphens, `^[a-z0-9][a-z0-9-]{0,79}$` — because the platform routes nothing else.
- **It can change while your app runs.** `basePath` is `""` while remote access is off or has no
  apps' address, and changes when the admin gives the app another address. A shared app is
  restarted with its new `OPENMASJID_PUBLIC_URL` when that happens; an app that is not shared is
  not. So read `site` again from time to time rather than once at start-up — and cache the answer
  for a minute or so rather than asking on every request, because it counts against the same
  per-app budget as the Fabric calls that send email, WhatsApp messages and alerts.
- **No `X-Forwarded-Prefix`.** On a request that came through the platform — the tunnel, its front
  door on the masjid's network (`http://<server>/<path>/`), or the HTTPS port an `https: true` app is
  given — it sets `X-Forwarded-Proto` (`https` through the tunnel and on that HTTPS port),
  `X-Forwarded-For` and `X-Forwarded-Host` itself, replacing whatever the visitor sent under those
  names, and removes any `X-Forwarded-Prefix`, on page requests and WebSocket handshakes alike. It
  never sends one of its own, so never take your base path from it: through the platform you will
  not receive one, and a request that reaches your published port directly, on the masjid's
  network, passes through nothing, so there every header — this one included — is the visitor's
  own.

**Opened from outside — even if you never ask for `tunnel: true`** (platform 0.51.2-dev.16+). When the
admin manages OpenMasjidOS from outside the masjid, the dashboard can open EVERY app with a web page at
`https://<domain>/<path>/`, shared or not — never at the dashboard's own address, where no app is
served at all. *Single sign-on from outside the masjid*, above, says how the admin arrives, what your
`Cookie` header then carries (your own cookies, and your access token as `omos_session` — never the
dashboard's session) and what happens to a `Set-Cookie` for a platform cookie name.

- **An app that is not shared is served there to the admin alone** — to the browser holding that
  app's access token. To anyone else the address is the same 404 as an address with nothing at it,
  and the app still has no public URL: `OPENMASJID_PUBLIC_URL` and `publicUrl` stay empty, so treat
  the public URL only as "do I have a public address to put in a link". Base-path awareness
  (*Your address*, above) is therefore not optional for any app with a web page. An app that is not
  base-path aware simply breaks there — the WhatsApp gateway (OpenWA) is one, which is why Settings
  offers its screen only at the masjid.
- **Nothing outside your path is yours.** On the apps' address it is answered by the platform or
  by another app — a root-relative `/favicon.ico`, for one, gets the masjid's logo (or a 404), never
  your icon; `/api/public/appearance` and `/api/public/logo` are the platform's (*Appearance
  inherit*, above) — and your access-token cookie, scoped to `Path=/<path>`, does not go with it.
  If your app has no catalogue `icon`, the dashboard shows your `favicon.ico` while you are running:
  on the LAN from your own port, and from outside — only when you are shared — from
  `/<path>/favicon.ico`.
- **No opener policy through the tunnel.** The platform removes `Cross-Origin-Opener-Policy` from
  your responses there, because the dashboard relies on its own to cut off any window an app page
  opens on it. A page of yours that needs cross-origin isolation will not get it from outside.
- **Service workers stay inside your path.** Through the tunnel the platform removes
  `Service-Worker-Allowed` from your responses; with it, one app could register a worker over the
  whole apps' address and see every other app's pages, the address that hands out access tokens,
  and the dashboard itself. So a worker controls at most the folder its script is served from: serve the script from
  under `/<path>/` (the top of it is best), register it with a scope inside `/<path>/`, and never
  expect one beyond. The script cannot be the bare `/<path>`, whose folder is `/` — the whole apps'
  address. A browser's fetch of a worker script there, recognised by the `Service-Worker: script`
  or `Sec-Fetch-Dest: serviceworker` header a browser sends with it, never reaches you, through the
  tunnel or through the platform's front door on the masjid's network: the platform answers with a
  tiny worker of its own that unregisters itself as soon as it is activated. So a worker
  registered from there removes itself, and one an earlier platform version let a page of yours
  register there goes the next time the browser checks it for an update. And a scope can cover the
  bare `/<path>` only if the script sits in the folder `/`, so no worker of yours can control a page
  served there — a page you want a worker to control belongs under `/<path>/`.
- **Caching.** Through the tunnel the platform marks every response from an app that is not shared,
  and every response to a request carrying a valid access token, `cache-control: private, no-store`
  with `cdn-cache-control: no-store` and `cloudflare-cdn-cache-control: no-store` (and drops any
  `expires`), so Cloudflare keeps no copy of what only the admin may see; your bare `/<path>` gets
  the same treatment (*Your address*, above). Everywhere else under `/<path>/`, a shared app's
  answers to the public keep **your** headers, and Cloudflare's edge by default keeps anything whose
  path ends in `.js`, `.css`, `.png`, `.pdf`… for hours, whatever cookie the request carried. So send
  your own cache headers anyway — `cache-control: private, no-store` on anything per-person (a
  receipt, an export, a page behind your own login) — because the platform only adds its own in
  those cases.
- **On the apps' address, every app shares one origin.** On the LAN the dashboard opens each app at
  its own port, and so its own origin; here they are all `https://<domain>`, and every cookie except
  the platform's is relayed as the browser sent it. A cookie you set with `Path=/` reaches every other
  app's server too, and one with a `Domain` attribute can reach other hostnames as well, the
  dashboard's included — so scope yours to your base path with no `Domain`, as the platform does for
  the access token. A path keeps your cookie away from another app's server; it is **not** a wall
  against another app's script on the same origin, which could act within your app once the admin
  has opened it there — though never as the dashboard, which lives on its own hostname. That is the
  accepted cost of serving several apps on one hostname.
- **A socket opened with the admin's access token is cut off when that sign-in ends.** A WebSocket
  handshake through the tunnel passes the same checks as a page and carries the same rebuilt
  `Cookie` header. If it carried your valid access token, the platform keeps watching it, and once
  that token stops being honoured (*Revocation*, above) it closes the socket — at once when an
  admin's action is the reason (signing out, a new password, a change to two-step sign-in, turning
  remote access or managing from outside off), otherwise within about five seconds. **Both ends
  close**: the browser's, and the platform's connection to your app, which your app sees drop with
  no WebSocket closing handshake (most libraries report code 1006). Read it as the admin's tab
  going away, not as a fault. The two ends are tied together on every WebSocket the platform
  relays to you — through the tunnel, its front door, or the HTTPS port an `https: true` app is
  given: when one end goes, the platform closes the other, and a close you start politely still
  reaches the browser first. A socket that carried no valid token when it opened is the public's
  to the platform: it is not watched, and no sign-in ending closes it — in a shared app, that
  includes one your page opens after the token stopped counting, signed in by a session of your
  own. The platform watches no more than 150 sockets opened with an access token at once, for all
  apps together, and refuses a new one beyond that (its handshake simply fails) — so close a
  socket before you open its replacement.
- **Keep a quiet socket alive yourself.** Through the tunnel, Cloudflare closes a WebSocket that
  has carried nothing in either direction for about 100 seconds. The platform pings its own
  dashboard's sockets every 30 seconds for that reason, but never yours: your socket's bytes pass
  through it untouched. So if your socket can sit quiet — a screen waiting for its next notice,
  say — send something well inside that limit, every 30 seconds or so: a ping frame from your
  server (a browser answers one by itself) or a small message of your own. And reconnect when a
  socket drops anyway.
- **A browser that leaves part-way ends your HTTP response too.** If the browser goes in the
  middle of a Server-Sent Events stream, a long poll or a big download — or Cloudflare drops the
  connection — the platform ends its request to you as well, wherever it relays one (the tunnel,
  its front door, the HTTPS port), so your server sees the connection close instead of writing to
  nobody. Unlike a socket, though, a long-lived HTTP response opened with the token is not
  watched: it carries on after the sign-in ends, until you finish it or the browser leaves.

## Fabric email (`email: true` — sending mail)

The admin configures ONE email provider (SMTP or Resend) in Settings → Email. Set `email: true`
to opt in; the platform issues your per-app secret, and your **backend** can then send mail through
the OS — you never handle the credentials or the From address:

```
POST ${OPENMASJID_BASE_URL}/api/fabric/email
  X-OpenMasjid-App-Secret: <OPENMASJID_APP_SECRET>
  Content-Type: application/json
  { "to": "donor@example.org", "subject": "Your receipt", "text": "JazakAllah…", "html": "<p>…</p>" }
→ 200 { "sent": true }   |   { "sent": false, "reason": "not_configured" | "rate_limited" | "bad_recipient" | … }
```

`text` (or `html`) + `to` + `subject` are required. **Fail soft**: if email isn't configured you get
`{ sent:false, reason:"not_configured" }` — keep working (e.g. still record the donation; show the
receipt on screen). Rate-limited per app. Server→server, not CORS-enabled.

## Fabric alerts (`alerts:` — telling the admin something's wrong)

Declare the alert types your app can raise; the admin gets a per-channel matrix for each (Settings →
Alerts — route it to **Email**, **Webhook**, both, or off; all on by default, like UniFi's notification
controls). Fire one from your backend when the event happens (a camera/reader offline, a failed
payment). The platform delivers it to exactly the channels the admin chose for that alert.

These alerts always go to the **admin**. To email an **end user** (a donor's receipt, a parent/teacher
notice), that's your app's job — send it yourself via `POST /api/fabric/email` (below); it is not part
of this alert matrix.

```yaml
alerts:
  - id: reader-offline           # kebab-case, stable — this is what you POST
    label: Card reader offline    # shown in the Settings toggle
    description: A payment reader stopped responding.
```

```
POST ${OPENMASJID_BASE_URL}/api/fabric/alert
  X-OpenMasjid-App-Secret: <OPENMASJID_APP_SECRET>
  Content-Type: application/json
  { "alert": "reader-offline", "title": "Reader offline", "text": "Lobby reader hasn't checked in for 5 min.", "level": "error" }
→ 200 { "delivered": true, "email": true, "webhook": false }   |   { "delivered": false, "reason": "disabled_by_admin" }
```

- The `alert` id MUST be one you declared in `alerts:` (else 400). `level` is `info|success|warning|error`.
- **Fail soft**: `{ delivered:false, reason:"disabled_by_admin" }` just means the admin turned that
  alert off — not an error. Declaring `alerts:` alone issues your secret (no other capability needed).
- Alerts go to the ADMIN (email + webhook). To email an arbitrary recipient (a donor/parent), use
  `POST /api/fabric/email` above instead.

---

## Admin commands (`commands:` — things an admin can run from WhatsApp)

Declare commands an authorised admin can run against your app by sending a WhatsApp message to
the masjid's number (`!<your-app-id>`). **The platform owns everything except the doing:** it
decides who may run what, renders the numbered menu, asks for confirmation, and formats the
reply. You are asked only to execute one command you declared.

```yaml
commands:
  - id: whats-on                    # kebab-case, stable — this is what we send you
    label: What's on the screen now # shown in the menu and in Settings
    description: Reads back the current notice.
  - id: post-notice
    label: Put a message on the screen
    argument:                       # OMIT if the command takes no text
      label: message                # one or two words: "add your message after the number"
      required: false               # default true
    confirm: true                   # ask the sender to confirm first
```

Rules the catalog build enforces, so an install can never surprise you:

- At most **12** commands. A numbered menu longer than that does not fit in one message.
- `id` must be kebab-case, **not all digits** (`!display 2` must only ever mean "the second
  option"), and not one of `help`, `yes`, `no`, `cancel`, `stop`.
- `argument` must be an **object with a `label`**. `argument: true` is rejected rather than
  coerced — it reads like "takes an argument" but carries no label, and accepting it would mean
  silently discarding whatever a volunteer typed while telling them it worked.
- Set `confirm: true` for anything people will see or that cannot be undone. It also puts the
  command in the admin's audit alert.

### Serving it

```
POST /fabric/commands/run          ← on your app's own web port, like every /fabric/* route
  X-OpenMasjid-App-Secret: <your OWN OPENMASJID_APP_SECRET>
  X-OpenMasjid-Caller-App: omos:platform
  { "command": "post-notice", "text": "Jumu'ah is at 1:30", "requestId": "…", "locale": "en" }
```

Answer with HTTP 200 and JSON:

| Meaning | Body |
|---|---|
| Done | `{ "ok": true, "text": "The notice is on the screen now." }` |
| Failed, and you can say why | `{ "ok": false, "error": "The screen is switched off at the wall." }` |
| Not a command you know (HTTP 404) | `{ "ok": false, "code": "unknown_command" }` |
| Still starting up (HTTP 503) | `{ "ok": false, "code": "not_ready", "error": "…" }` |

- **Verify BOTH headers.** `X-OpenMasjid-App-Secret` must equal your own `OPENMASJID_APP_SECRET`,
  and `X-OpenMasjid-Caller-App` must be exactly `omos:platform`. That value can never be an app
  id — the colon is outside the charset every app id is validated against — so it is the platform
  and only the platform.
- Declaring `commands:` alone issues your secret; no other capability is needed.
- **`commands` is a RESERVED Fabric capability.** Putting it in `fabric.provides` is refused at
  install and by the catalog build: it would let another app reach this same handler through the
  app-to-app broker, which is a different trust boundary sharing a path prefix.
- Your `text` and `error` are plain text, ≤1000 characters. The platform strips control
  characters, collapses blank lines and trims to the message cap — you cannot make one answer
  look like three messages.
- Reply promptly: **10 second timeout**, 16 KB response cap. A command a volunteer is waiting on
  is not the place for a long job; kick it off and say you have.
- `/fabric/*` is LAN-only and never served over the tunnel, exactly as for every other Fabric
  route.

### Asking a follow-up question

A command can hold a short conversation. Return a `followUp.token` alongside your text
and the platform will treat the sender's **next message as an answer** — no `!` prefix
needed — and POST it straight back to you with that token:

```jsonc
// your reply to `!notice-board schedule`
{ "ok": true, "text": "Which prayer?", "followUp": { "token": "sched-881" } }

// the platform then sends you their answer
{ "command": "schedule", "text": "Maghrib", "followUpToken": "sched-881",
  "requestId": "…", "locale": "en" }

// keep going, or finish by simply omitting followUp
{ "ok": true, "text": "What time?", "followUp": { "token": "sched-881" } }
{ "ok": true, "text": "Done. Maghrib iqamah is 7:15pm from Friday." }
```

- **The token is yours.** The platform stores it against that one sender and hands it
  back; it holds no other state about your flow. Put whatever you need in it (a row
  id, a step name), keep it to `A-Za-z0-9._:-` and ≤128 characters — it is validated
  before being echoed, because it ends up in a later request body.
- **The exchange is bounded, and can end without you.** Three minutes idle, fifteen
  minutes total, twelve turns, the sender typing `exit` / `cancel` / `done`, or the
  sender starting any new `!` command. You will simply stop receiving answers — so
  never leave a half-applied change waiting on a reply that may not come. Apply on the
  last answer, or keep your own draft and expire it.
- **Any `ok:false` ends it**, so a failure cannot leave the sender's ordinary
  conversation being captured as input.
- **The sender is re-authorised on every turn.** A grant removed mid-conversation
  takes effect at once.
- **Ask one thing at a time.** These are WhatsApp messages, not a form.

### What the platform will never ask you to do

Commands are an ADMIN channel. There is no way for a command to name a phone number, and there
never will be — that is the line between an admin channel and a spam gateway. To message a
parent or a donor, use `POST /api/fabric/whatsapp` with your own app's settings, as before.
