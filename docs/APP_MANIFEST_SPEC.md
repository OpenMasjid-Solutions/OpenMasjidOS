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
| `fabric` | – | Opt into the **app-to-app broker** (below): `{ provides: [{ capability }], consumes: ["<app-id>/<capability>"] }`. Any `fabric` block issues the app the per-app secret (like `sso`). Grants are static from the manifest. Catalog apps only. |
| `tunnel` | – | `true` = the app **requests** to be reachable from the internet through the OS's Cloudflare tunnel (below). It's only a request — the admin confirms exposure in Settings → Remote access. Off ⇒ the app stays on the LAN. |
| `email` | – | `true` to opt into Fabric email (below) — the app may `POST /api/fabric/email` to send mail (receipts, parent notices) via the admin's SMTP/Resend provider. Issues the per-app secret; the app never sees the credentials or the From address. |
| `alerts` | – | A list of alert types this app can raise, `{ id, label, description? }[]` (below). Each gets a granular on/off in Settings → Alerts (all on by default). The app fires one with `POST /api/fabric/alert`. Declaring alerts issues the per-app secret. |

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
- **On open**, the dashboard appends the viewer's presentation prefs to the app URL as a fragment:
  `#omos=<base64url(JSON)>` where the JSON is
  `{ v:1, theme, wallpaper, wallpaperImage?, accent, lang }`. The fragment is never sent to a server
  or logged. The app reads `location.hash` on load, applies + persists it, and clears the hash.
- **Live sync** (optional): `GET /api/public/appearance` returns the same payload plus the masjid
  logo path (`{ v:1, theme, wallpaper, wallpaperImage, accent, lang, logo }`). It's public and
  **CORS-enabled** (`Access-Control-Allow-Origin: *`), so an app's browser can poll it to follow theme
  changes. `logo` is `"/api/public/logo"` when the admin has uploaded a masjid logo (else `""`);
  resolve it against the SAME origin you fetched appearance from, and use it to brand your own pages or
  receipts (it's a raster PNG/JPG/WebP).

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
- The session cookie (`omos_session`, HttpOnly, **SameSite=Lax**, non-Secure) is sent by the browser to
  the app when the admin opens it. It is `Lax` (not `Strict`) on purpose: the dashboard is HTTPS but
  most apps are HTTP, so clicking **Open** is a cross-scheme top-level navigation that browsers treat
  as cross-site — `Strict` would withhold the cookie on that first open (SSO would only work after a
  reload), whereas `Lax` rides a top-level GET navigation. **So your app must read the cookie from the
  request that loads it** (the Open navigation carries it). The app's **backend** then calls
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
target's own status + JSON straight through.

**Fail-soft doctrine (required of consumers).** Treat every `fabric_error` as "feature unavailable,
app still fine" — never a hard crash. E.g. hide a School-payments tab on `target_not_installed`; queue
and retry on `target_unreachable`. (Same spirit as the notify fail-soft above.)

## Tunnel uplink (`tunnel: true` — being reachable from the internet)

By default an app is served only on the LAN. Set `tunnel: true` to **request** internet exposure
through the OS's Cloudflare tunnel. It is only a request: exposure is **off until the admin says yes**.

Where the admin answers (v0.45.0+): declaring `tunnel: true` makes the App Store show your app an
install dialog — **even if you declare no `settings:`**, so a one-click install can still ask — with a
single pre-ticked checkbox, "Share this app over the internet". Whatever they choose is applied at
install, and they can change it later per-app in Settings → Remote access or on the app's own page.
So: state the request in your manifest, and be prepared for the answer to be no.

When the admin exposes the app, the platform serves it at `https://<domain>/<path>/…` and injects:

- **`OPENMASJID_PUBLIC_URL`** — the app's public base URL (e.g. `https://omos.example.org/donations`),
  or **empty string** when the app isn't exposed / the tunnel is off. Reference it in your compose
  (`environment: { OPENMASJID_PUBLIC_URL: ${OPENMASJID_PUBLIC_URL:-} }`) and use it to build absolute
  links (Stripe success/cancel URLs, webhooks, QR codes). The **live** source of truth stays
  `GET /api/fabric/site` (requires the `domain` capability); the env var is a convenience mirror.

Your `/fabric/*` space is **never** served over the tunnel — those routes are LAN-only (platform-
enforced, and you should enforce it too). Build your app to be base-path aware (it is served under
`/<path>`); `GET /api/fabric/site` returns the `basePath` to mount under.

## Fabric email (`email: true` — sending mail)
whatsapp: true                    # OPTIONAL - may POST /api/fabric/whatsapp. QUEUES (202), never
                                  # sends synchronously; one recipient per call; never use for
                                  # anything auth-critical. GET the same path first to learn
                                  # whether this masjid can send at all. Which events go out and
                                  # to whom is YOUR setting - the platform's alerts matrix has no
                                  # WhatsApp column for apps. For announcements, GET
                                  # /api/fabric/whatsapp/groups (only the groups the ADMIN
                                  # approved) and send `group` instead of `to`. An optional
                                  # `media` sends an IMAGE (png/jpeg/webp, 2 MB decoded) with
                                  # `text` as its caption; check `media` on the GET first, and
                                  # read an absent field as false. See docs/WHATSAPP.md.

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

### What the platform will never ask you to do

Commands are an ADMIN channel. There is no way for a command to name a phone number, and there
never will be — that is the line between an admin channel and a spam gateway. To message a
parent or a donor, use `POST /api/fabric/whatsapp` with your own app's settings, as before.
