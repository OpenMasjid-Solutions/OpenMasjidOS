<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Fabric app-to-app broker + tunnel uplink (as built, v0.40.0; tunnel routing revised in v0.51.2-dev.16)

This is the as-built record of the two platform capabilities the OpenMasjidStudents
work introduced. It reconciles the original work order with the real code (the
"verify-then-extend" pass); where the two differed, the code won and this doc reflects
the code. The app-facing contract lives in [`APP_MANIFEST_SPEC.md`](APP_MANIFEST_SPEC.md);
this doc is the platform-internal design + the decisions taken.

The tunnel half changed in v0.51.2-dev.16, when remote administration (the dashboard served
over the same tunnel, off by default) was given a hostname of its own: every app with a
published port is routed again, an app that is not shared online opens only for the admin and
only with an access token for that one app, and no app is ever served on the dashboard's
hostname. That is recorded in *Apps through the tunnel* below. The remote-administration design
itself is in [`REMOTE_ADMIN.md`](REMOTE_ADMIN.md) and the header of
`packages/core/src/system/remote-admin.ts`.

## Work Package A — app-to-app broker

`POST /api/fabric/app/:targetAppId/:capability/:method` (`packages/core/src/fabric/appLink.ts`,
registered inside `registerFabric`). Order of operations:

1. **LAN-only.** Under `/api/fabric`, so the shared `registerFabricTunnelGuard`
   (`system/via-tunnel.ts`) 404s tunnel-origin requests before the route runs (the one refusal
   every tunnel guard sends, `refuseOverTunnel`, recorded as `lan-only-route`). It is on both
   listeners and does not move with remote administration: the dashboard's tunnel allow-list
   (`DASHBOARD_API` in `system/remote-admin.ts`) never includes the Fabric.
2. **The Fabric's shared per-app budget.** `registerFabric`'s `onRequest` hook charges every Fabric
   call from an app whose secret it recognises to one counter — 120/min (`RATE_MAX_APP` in
   `api/fabric.ts`), shared with that app's email, WhatsApp sends, alerts, `site` and other Fabric
   calls; only the sign-in check (`RATE_MAX_APP_SSO`) and the WhatsApp outcome reads
   (`RATE_MAX_APP_READ`) have counters of their own. Over it the answer is
   `429 {"error": "Too many requests."}`, outside the envelope in step 10.
3. **A per-address ceiling before authentication** (default 600/min;
   `OPENMASJID_FABRIC_BROKER_IP_RATE`) → `429 rate_limited`, so a flood of wrong secrets cannot buy
   unbounded constant-time comparisons. Generous, because every app reaches the core from the same
   Docker bridge address (`util/net.ts`).
4. **Authenticate the caller** by `X-OpenMasjid-App-Secret` (constant-time `findFabricApp`).
   Unknown/missing → `401 unauthorized`. Target existence is not revealed on auth failure.
5. **Per-caller rate limit** (default 60/min; `OPENMASJID_FABRIC_BROKER_RATE`) → `429 rate_limited`.
6. **Validate** the path segments (`app-id` / kebab `capability` / kebab `method`).
7. **Authorize by static manifest grants**: caller `consumes` contains `"<target>/<capability>"`
   AND target `provides` the capability → else `403 not_granted`.
8. **Resolve the target** from the app registry: installed (`503 target_not_installed`),
   running with a published port (`503 target_unreachable`), and holding a secret.
9. **Proxy** to `http://<appHost()>:<published port>/fabric/<capability>/<method>` — where
   `appHost()` is `system/app-host.ts` (`host.docker.internal`), **never loopback**: the core is a
   bridge-network container, so `127.0.0.1` inside it is *the core*, and an app's published port is
   on the **host**. This line said `127.0.0.1` until v0.51.0, and that exact wrong spec is what
   produced a wrong implementation once already — the WhatsApp gateway client was written from it and
   could not reach OpenWA on any install. URL built ONLY
   from the registry + validated segments (no SSRF). Injects the **target's own** secret as
   `X-OpenMasjid-App-Secret` + trusted `X-OpenMasjid-Caller-App`; strips every caller-supplied
   identity/forwarding/hop-by-hop header. JSON only, ≤256 KB each way, 10 s timeout, no redirects.
10. **Pass through** the target's status + JSON on success; broker failures use the
   `{ fabric_error: { code, message } }` envelope. **Bodies are never logged.**

Any app with a `fabric` block is issued the per-app secret (extends the `sso||notify||stripe||domain`
condition via `needsFabricSecret`, in both install and the update reconcile). Grants persist in
`meta.json` as `fabricProvides` / `fabricConsumes` and surface through `fabricEntries()`/`FabricApp`.

### Divergences from the original work order (A)

- The original said "mirror in `validate-compose.mjs`". Reality: `fabric:` is a **manifest** key, not a
  compose directive — the mirror belongs in **`OpenMasjidAPPS/scripts/build-catalog.mjs`** (manifest
  shape), and `validate-compose.mjs` is unchanged. See the change list at the end.
- There was a **naming collision**: `InstalledApp.fabric` (a boolean = `sso||notify`, drives the
  appearance hand-off on Open) already existed. The broker uses distinct fields
  (`meta.fabricProvides/fabricConsumes`, `FabricApp.provides/consumes`) — the old boolean is untouched.
- Broker is **catalog-app ↔ catalog-app only** in v1 (custom/community apps get no per-app secret;
  `installStack` was not changed).
- The per-caller rate limiter is new (the existing `fabricRateOk` is per-IP, not per-caller).

## Work Package B — tunnel uplink (`tunnel: true`)

- **Exposure is per-app opt-in.** Before v0.40.0, `ingress.rebuild()` routed **every** app with a
  published port, to anyone; v0.40.0 routed an app only when `meta.exposed !== false`. `undefined`
  (installed before this feature) is **grandfathered exposed**, so upgrading to v0.40.0 didn't take a
  working app offline — for **catalog** apps only since v0.46.0: a custom or community app whose flag
  was never written is private (`isExposedMeta` in `apps/manager.ts`, the single source of truth for
  "is this app shared?" — `InstalledApp.exposed` comes from it). Since v0.51.2-dev.16 exposure
  decides who an app is served **to**, not whether it has a route: every app with a published port
  is in the table again, and one that is not shared is served only with its access token (*Apps
  through the tunnel*, below).
- **Admin consent = the Settings → Remote access per-app toggle** (`cloudflare.setExposed`), which
  defaults from the manifest `tunnel:true` request. New installs default **not exposed** (`store.install`
  accepts an `expose` flag; the manifest request is surfaced in the UI). *(Decision 1c + grandfather —
  chosen over a bespoke install-dialog toggle; nothing is public without the admin's explicit toggle.)*
- **Correction (v0.45.0): the manifest request was never actually surfaced.** Decision 1c was only
  half-built — `store.install` accepted `expose`, but no UI ever sent it and nothing read `app.tunnel`,
  so `installCatalogApp` always saw `undefined` and a `tunnel:true` app installed silently un-exposed
  with an empty `OPENMASJID_PUBLIC_URL`. An app whose whole purpose needs absolute public links (e.g.
  emailed parent-portal invites) therefore broke with no signal to the admin. Fixed by making the
  Store **ask**: an app with `tunnel:true` always opens the install dialog — even with no `settings:`,
  which is exactly the one-click path that used to drop the request — and shows a single pre-ticked
  checkbox ("Share this app over the internet"), warning when Remote access isn't configured yet.
  The default stays *the app's stated need, shown and confirmable*, not a silent auto-expose:
  `installCatalogApp` still requires `expose === true`, so the invariant "nothing is public without
  the admin's explicit toggle" is unchanged — the admin is now simply *asked*.
- **Discoverability of the recovery path (v0.45.0).** The per-app "Shared online" toggles used to sit
  inside the collapsed "How to set this up" `<details>` in Settings → Remote access — i.e. the fix for
  a declined/missed install-time question was hidden behind a setup guide. They are now always visible
  in that panel, and the same switch (plus the app's live public URL) appears on the app's own detail
  page, which is where an admin wondering "why can't parents reach this?" actually looks.
- **An app that is NOT exposed still has a route** (v0.51.2-dev.16): the admin can open it from the
  remote dashboard, whose Open button gets the browser an access token for that one app, and to
  everyone else it is the same 404 as an empty address. It still has no public URL. The version of
  this rule first written for dev.16 served a private app to any request carrying a remote dashboard
  session (`privateAppAllowed`), beside a dashboard served at the root of the same hostname; it was
  withdrawn before it was published, and *Apps through the tunnel* below says why.
- **`/fabric/*` is refused over the tunnel** on BOTH the HTTP and WebSocket ingress paths
  (`isFabricSubpath`, matched on the app-relative path after the segment, in its raw, decoded and
  dot-resolved spellings) — LAN-only, for every app, shared or not. An access token does not open it.
- **`OPENMASJID_PUBLIC_URL`** is injected into the app's `.env` (empty when not exposed / tunnel off),
  reconciled on a catalog install, update, `setExposed`, and any tunnel enable/disable/domain/path
  change (`reconcilePublicUrls` → reup); a custom or community install writes none, and gets one the
  next time the URLs are reconciled. The **live** source of truth stays `GET /api/fabric/site`
  (`appPublicUrl`, gated on `isRouted`); the env var is a convenience mirror computed from the
  *intended* exposure (`intendedPublicUrl`) so a freshly-exposed app has a stable value immediately.
  Both stay empty for an app that is not shared, however often the admin opens it from outside:
  `isRouted` means **publicly** routed, and a private app's route is not public. Both carry the
  app's ADDRESS (`getAppPath`), which is not always its id: an install whose id is taken gets
  `<id>-2`, `<id>-3`…, and a catalog install shared from the start has that address in its very
  first `.env` (`intendedPublicUrl(id, exposed, path)` — the address is decided before `meta.json`
  exists to read it from; *Every app with a port has a route*, below).

### Divergences from the original work order (B)

- The work order framed a "confirm at install" dialog toggle; we chose the **Settings per-app toggle
  defaulting from the manifest** (decision 1c) + grandfathering, so existing installs keep working.
- `OPENMASJID_PUBLIC_URL` did not exist and there was no expose/un-expose lifecycle — both are new.

## Apps through the tunnel (v0.51.2-dev.16)

Remote administration serves the dashboard over the same tunnel, behind a switch that is off by
default. Giving the dashboard a safe place to live changed what an app is served, to whom, and with
what. All of it is in `system/ingress.ts`, `system/app-access.ts` and, for sockets,
`system/remote-sockets.ts` and `system/socket-relay.ts`, pinned by `test/remote-apps.test.ts`
(HTTP) and `test/front-door-websocket.test.ts` (WebSocket).

### Two hostnames, and why

On v0.51.2-dev.13–dev.15 the remote dashboard was served at the root of the apps' hostname
(`https://omos.example.org/`), beside every shared app at `/<path>/`, and no app opened from it at
all: Open built `http(s)://<hostname>:<app port>`, a port the tunnel does not carry. As first
written, dev.16 fixed that by opening every app at `https://<domain>/<path>/`, private ones included.
An adversarial review found what one hostname for both meant: a browser draws the line around "this
site's own data" by scheme + host + port, **never by path**, so every app page was the dashboard's
ORIGIN. An app's script — from any app the admin opened, or a cross-site-scripting bug in any public
app page — could read the dashboard key from `localStorage` and send same-origin requests carrying
the admin's cookie: turn the root terminal on and open it (host root — the core holds the Docker
socket), or download a backup (every secret). On the masjid's network that line has always been
there: the dashboard is `https://<ip>`, each app `http://<ip>:<port>`, and a different port is a
different origin. Through the tunnel the only way to draw it is a different HOSTNAME.

So the tunnel carries two Cloudflare public hostnames, both Type HTTP to the core's front door
(`localhost:80` on an installed box — the core's `PORT`, which Settings → Remote access shows):

- **The apps' hostname** (`cloudflare.domain`; "Your apps’ address" in Settings → Remote access)
  is where the apps are served, as before. Strictly, the ingress serves app paths on any hostname
  except the admin one, as it always served them on any. The dashboard is never served there: while
  remote administration is on, asking for it on any hostname but its own gets the ordinary 404,
  recorded as `dashboard-elsewhere`. With it off — and it is off until a Dashboard address is set —
  the dashboard is refused everywhere over the tunnel, recorded as `lan-only-route`, or as
  `no-admin-host` when the tunnel and the switch are on, an admin account exists, two-step
  sign-in is set up, and only the Dashboard address is missing or is the apps' own
  (`doorClosedReason`).
- **The admin hostname** (`cloudflare.adminHost`; "Dashboard address") serves the remote dashboard
  and **no app content at all** — shared or private, with an access token or without, on the HTTP
  and the WebSocket path. The ingress declines any app path there and the request gets the ordinary
  404, recorded as `app-on-admin-host` (or, for a worker's script fetch at the bare address, the
  platform's self-removing worker, as elsewhere) — unless the path is also one of the dashboard's
  own (an app whose address is `settings`, say). The ingress hook runs before the front-door gate,
  so such a request goes on to the gate like any dashboard path: the dashboard answers it while the
  door is open, and it is refused as a dashboard path while it is shut. The test is `isAdminHost`, on
  `normalizeHost` (lower-case, no port, no trailing dot), so `ADMIN.EXAMPLE.ORG`,
  `admin.example.org.` and `admin.example.org:443` are all the admin hostname. `validateAdminHost`
  refuses a name that is not a DNS name, or that equals the apps' hostname in any spelling, and
  `remoteAdminEnabled()` is false while the two match.

For the public, a shared app is still served on the apps' hostname, to anyone, with the app's own
cache headers. What dev.16 changed for them is small and is all below: at an app's bare address
(`/<path>`, no trailing slash) nothing the app answers may be cached and a service worker's script
fetch gets a worker that removes itself instead of the app's, and some headers are removed in each
direction (*What an app receives through the tunnel*).

A box managed remotely on dev.13–dev.15 had its dashboard on the apps' hostname. After updating,
that address answers with the ordinary 404 (recorded as `no-admin-host`), and remote administration
stays off until a second public hostname exists in Cloudflare and has been entered as the Dashboard
address. The Cloudflare half can be done from anywhere, before or after the update. Entering the
address can only be done after it, on the masjid's network: no earlier build has the field, and
until it is set there is no remote dashboard to enter it in. Settings shows the Cloudflare steps
beside the field and, under the switch, that the dashboard needs an address of its own, and
"Recently turned away" labels visits to the old address accordingly; no alert or notice outside
Settings says so ([`REMOTE_ADMIN.md`](REMOTE_ADMIN.md), *Updating from dev.13–dev.15*).

### Every app with a port has a route; `exposed` says who it is served to

`rebuild()` (every 10 s) puts **every** app with a published port into the routing table — not only
the shared ones — keyed by its path (`getAppPath`) and carrying the app's id and `exposed`. The
first segments the platform keeps for itself — `api`, `trpc` and `assets`,
`RESERVED_PATH_SEGMENTS` in `apps/paths.ts` — are never routed. That is ONE list: `setAppPath`
refuses them ("/api is used by OpenMasjidOS itself. Choose a different address for this app.") and
an install never takes one (below), so only an older install, a restored backup or an app found
running in Docker with no record of its own can still hold one. Nor is a path routed that does not
have an app path's shape, `^[a-z0-9][a-z0-9-]{0,79}$` (`isAppPathShape`, same file). Every address
an install or Settings gives has that shape already; the check is for the app found running in
Docker, which is recovered from any `omos-*` compose project under the project's own name — and
Docker allows `_` in one, so a stack started by hand as `omos-_omos` would otherwise have been
routed at `/_omos`, the platform's own address for opening an app from outside.

Who is answered, and how, over HTTP:

- **Through the tunnel, on any hostname but the admin one:** a shared app is served to anyone. An app
  that is not shared online is served only to a request carrying a valid access token for **that**
  app; anyone else gets the 404 an empty address gets, recorded as `app-not-shared`.
- **Through the tunnel, on the admin hostname:** no app, shared or not, with a token or without — the
  404, recorded as `app-on-admin-host` — unless the path is also the dashboard's (above).
- **An app's own `/<path>/fabric/*`, through the tunnel:** refused to everyone, recorded as
  `app-fabric-lan-only`; an access token does not open it. For an app that is not shared, a request
  without its token is declined first, like any other request for it (`app-not-shared`).
- **The bare address `/<path>`** (no trailing slash, any query): answered like every other address
  of the app, to the same people and whatever the method, with two exceptions — a service worker's
  script fetch never reaches the app but gets a worker that removes itself (recorded as
  `worker-at-bare-address` when it came through the tunnel), and whatever the app answers there is
  made uncacheable (both in *What goes back*, below). There is no redirect between `/<path>` and
  `/<path>/` in either direction, so an app may treat either one as its root.
- **On the masjid's network, through the front door** (`http://<server>/<path>/`): a shared app is
  proxied as before, the two bare-address rules included — though a worker fetch answered there is
  not recorded, because "Recently turned away" lists what came in from outside
  (`answerBareWorkerFetch` records only a request that looks like the tunnel's). The tunnel's cookie
  and response filtering below does not apply. An app that is not shared is not served there: the
  front door redirects the request to the HTTPS dashboard, as it does any address it does not
  serve, and the app is reached at its own port.

A WebSocket handshake goes through the same checks, and one that is not served is closed rather than
answered (`system/ingress.ts` says why). A declined app socket is recorded with the same reason
(`app-not-shared`, `app-on-admin-host`) when it came through the tunnel; a socket for an address
with nothing at it is not recorded, and neither is one for the `/fabric` of an app the request
could otherwise open, which is closed at once. A handshake at the bare address is proxied like one
anywhere else under the app: it cannot fetch a worker's script.

A private app asked for without its token is declined FIRST, before the `/fabric` refusal and the
bare-address checks are looked at, so neither can answer an installed private app differently
from an empty address; a worker's script fetch at its bare address is then answered exactly as at
an empty address (the self-removing worker, *What goes back*, below). A review found
the `/fabric` refusal answering before the body was read, while an empty address went on to the
not-found route, where Fastify parses the body first: a malformed or oversized POST then got a 404
at a private app's path and a 400 or 413 at an empty one.

"Anyone else" means nobody signed in, a LAN session, the remote dashboard's own session (under
either cookie name), another app's token, a token whose session was signed out or no longer counts
from outside (*the access token*, below), a forged one, and the app's own token while remote
administration is off. Over HTTP the 404 differs from an empty address's only by its six-character
reference, so a stranger cannot tell an installed private app from nothing. The reason exists only
on the inside: in the record ("Recently turned away" in Settings → Remote access, which the
not-found handler fills through `declinedReason` → `notFoundReason`) and in the core's log line for
it. The WebSocket path keeps the same parity, and two review findings are why: a declined app
socket is now offered to `claimUpgrade` exactly as an address with nothing at it is, instead of
being destroyed on the spot; and `claimsDashboardSocket` requires EVERY spelling of the URL to be
one of the dashboard's sockets (it was `some`, so a dot-segment spelling such as
`/<private app>/../trpc` was claimed and answered by the dashboard). Either difference told a
stranger which apps were installed.

**A shared app keeps its path** (`placeRoute`). Two apps can end up with one path: nothing used to
stop it, and an app that stops being shared keeps the path it had. While private apps were left out
of the table, that could never hurt a shared one. With every app in it, a private app taking a shared
app's path would turn a masjid's public donations page into a 404 for every donor and stop the
shared app advertising its public address, while Settings went on showing it as shared. So a
private app never displaces a shared one; in every other clash the later app wins, as the table
always did. A clash is logged when the set of clashes changes, not on every rebuild
(`Ingress: more than one app uses the same address: …`). `setAppPath` (behind `cloudflare.setPath`)
now refuses a path another installed app already has: "Another app already uses /<path>. Choose a
different address for this one."

**Installing is checked too** (`addressForNewApp` in `apps/manager.ts`, for catalog, community and
custom installs alike). Installing used to take the app's id as its address unconditionally — the
half `setAppPath` could not see: give a community app the address `/donations`, install the official
Donations app later, and the two shared one address, the newer one serving the public page while
Settings listed both as published there. Now an install whose id is already another app's address,
or is one of the reserved segments, gets the first free `<id>-2`, `<id>-3`… (the id cut to 34
characters first, so the stored path survives `sanitizePath`'s 40). It is decided before anything is
written, so a refused install leaves nothing behind; it is logged, as
`"kiosk" cannot use /kiosk (the app "display" already does), so it gets /kiosk-2. Change either in Settings → Remote access.`;
and a reinstall over an app that is still there keeps the address it had. An app whose id is free
stores no path at all and goes on following its id. So a clash can now come only from an install
or a backup made before these checks, or from an app found running in Docker with no record of its
own (it is recovered following its id, with no check against other apps' addresses); `placeRoute`
decides those. The consequence for app authors — an app's address is not necessarily its id — is in
[`APP_MANIFEST_SPEC.md`](APP_MANIFEST_SPEC.md), *Tunnel uplink*.

### Opening an app from outside: a one-use ticket, then the app's access token

The remote dashboard's session cookie, `__Host-omos_session`, lives on the admin hostname, so it
never reaches an app — which is the point. An app is then left with nothing from the admin's
browser to go on: a private one cannot tell the admin from a stranger, and one that signs the admin
in through the platform has no cookie to forward. So Open, from outside (`openFromOutside` in
`packages/ui/src/lib/apps.ts`):

1. **asks `apps.openRemote` for a ticket** for that one app. It answers `FORBIDDEN` unless the call
   came from the remote dashboard — a request the front door handed over (`ctx.handedOver`), not one
   that merely looks remote: a reverse proxy on the masjid's own network sends
   `X-Forwarded-Proto: https` too, and its admin opens apps at their own ports — with remote
   administration on; `PRECONDITION_FAILED` while the apps' hostname is unset; and `NOT_FOUND` for
   an app that is not installed or has no web port. A ticket is 32 random bytes, **single use**
   (spent whether or not it was still valid), lives `TICKET_TTL_MS` (60 s), is bound to the
   remote session and the app, and is minted only for a live session the remote dashboard itself
   made (`isRemoteSession`; *the access token*, below, says why); no more than 200 are outstanding
   (the oldest goes first). The answer is `https://<apps' hostname>/_omos/open?t=<ticket>`.
2. **opens the new tab first, blank**, while the click is still a click — a pop-up blocker allows a
   new tab only then, and the ticket takes a round trip — and cuts its `opener`, so the app it ends
   up showing cannot reach back into the dashboard. Then it sends the tab to that address. The
   `#omos=` appearance fragment rides along for an app that gets it on the masjid's network too (one
   with `sso` or `notifications`, `InstalledApp.fabric`); a fragment survives the `303` below.
3. **`GET /_omos/open`** (`registerAppOpen`, on the HTTP front door) spends the ticket, sets
   `omos_session=<access token>; Path=/<app path>; Max-Age=<what is left of the session>; Secure; HttpOnly; SameSite=Lax`
   and answers `303` to `/<app path>/`. That cookie path covers the bare `/<app path>` as well as
   everything under it. Every answer it gives carries the three no-store headers below and
   `Referrer-Policy: no-referrer`. Off the tunnel it is a plain 404; on the admin hostname, or with
   remote administration off, the ordinary tunnel refusal (`no-app-at-path`); a spent, expired or
   unknown ticket, or one whose session has since ended, gets a `410` page ("This link has
   expired") telling the admin to press Open again. So a made-up ticket tells a stranger whether
   remote administration is on — the 410 while it is, the 404 while it is not — and nothing else, a
   known residual. The route does not check that it was asked for on the apps' hostname — any
   hostname routed to the tunnel but the admin one will do — but the dashboard only ever builds the
   link there. `_omos` can never be an app's address: an install or Settings gives only lower-case
   letters, digits and hyphens, and the ingress routes no other shape (*Every app with a port has a
   route*, above). And this is a REGISTERED route on the front door, so it skips the not-found
   handler and is reachable over the tunnel by construction; that is why it makes its own tunnel,
   hostname and switch checks.

On the masjid's network Open is unchanged: the app's own port at the address the dashboard was
opened at (`appOpenUrl` in `packages/ui/src/lib/app-url.ts`). From outside, the dashboard learns the
apps' origin from `auth.me` (`appOrigin`, given only to a signed-in session on the remote dashboard,
i.e. on a request the front door handed over; `remote` is simply whether the request was handed
over, signed in or not). An app's own `favicon.ico` — what the dashboard shows for a running app
with no icon of its own — is loaded from there only for a **shared** app (`appBaseUrl`); a private
app's is served only to a browser holding that app's token, so the dashboard does not ask for it.

The **access token** (`appAccessToken` in `auth/sessions.ts`) is
`a1.<session handle>.<HMAC-SHA256, keyed by the session token, over the app id>`. The handle is a
truncated SHA-256 that names the session without being usable as it. `appAccessUser` honours a token
only for the app it was made for, and only while its remote session is valid: same password, same
second factor, not signed out, not expired. And only a session the remote dashboard itself made
counts (`Session.handedOver`; `appAccessToken` makes no token from any other). A sign-in through a
reverse proxy on the masjid's own network passes the second factor too, and goes on working
through that proxy, but its session lives in the LAN cookie `omos_session`, which every app opened
from that page receives — and the formula above is public, so any of those apps could have
computed a token for every app and used it from the internet, private apps included. A review
proved it. The remote dashboard's own session lives only in `__Host-omos_session` on the admin
hostname, where no app can read it.

A change to what counts as a second factor (a new authenticator, new backup codes, emailed codes
switched on or off, two-step turned off — the `epoch` in `auth/twofactor.ts`) ends every token
whose remote session was made under the old one, except the tokens of the remote session that made
the change from outside, which is moved onto the new factor (`rebindRemoteSession`). A restore that
puts a backup's settings in place renews the epoch the same way, moving only the restoring admin's
session onto it (and only if it still counts at that moment), and every session ends when the core
next starts (`system/restore.ts`).
`appAccessFromCookie` and `appAccessSsoUser` add the last condition: remote administration is on
(`remoteAdminEnabled()`). So turning two-step sign-in off ends every token, that session's
included: with no second factor, remote administration is off. A token cannot be turned back into
its session or into another app's token, and it is **not a dashboard session**: no dashboard route
accepts it. An app that keeps one holds a key to itself and nothing more. It is shaped to pass the
cookie-value check every OpenMasjid app applies before forwarding a cookie
(`^[A-Za-z0-9._~%+/=-]{1,4096}$`).

### What an app receives through the tunnel

**The Cookie header is rebuilt**, on the HTTP and the WebSocket path alike (`cookieHeaderForApp`).
Every platform session cookie is removed — `omos_session` whatever its value, and
`__Host-omos_session` — and the app's own valid access token, if the request carried one, is put
back **first** as `omos_session=<token>`, because every OpenMasjid app forwards the first
`omos_session` it finds and nothing else. Up to eight `omos_session` values in the request are
tried, not only the first (`appAccessFromCookie`, `MAX_TOKEN_CANDIDATES`). A browser sends every
cookie of that name whose path covers the address — the app's own, and any scoped to the whole
hostname, such as a stale one — and the apps share an origin, so another app's page can plant one
for this path too, and a browser lists the cookie with the longer path first. A planted value must
not shadow the real one. Eight because a browser sends a handful at most, and looking at more would
let a stranger buy work on the daemon with a Cookie header full of token-shaped values; for the
same reason the session handles a token is matched against are memoised
(`sessionHandle` in `auth/sessions.ts` — without it a review measured ~5 ms of the daemon's one
thread per request with a 16 KB Cookie header). A token for a different app is removed like any
other platform cookie. The app's own cookies pass through untouched.

Removing them all is what makes "a password-only sign-in cannot be used from outside" true for apps
as well as for the dashboard. Every app on the masjid's network receives the admin's LAN cookie —
that is how single sign-on works there — so an app that kept one could otherwise present it through
the tunnel to a SHARED app, whose single sign-on would accept it with no second factor. A browser
never sends the LAN cookie to the apps' hostname by itself, so nothing legitimate is lost. On the
masjid's network the front door relays a shared app's Cookie header as it always did.

**Forwarding headers** follow the rule they always did (CLAUDE.md §15, "The reverse proxies are a
hostile boundary"), with one name added: the client's `X-Forwarded-For`, `X-Forwarded-Proto`,
`X-Forwarded-Host`, `X-Forwarded-Port` and `X-Forwarded-Prefix`, `Forwarded`, `X-Real-IP`,
`True-Client-IP` and `CF-Connecting-IP` are dropped (on HTTP, `Connection`, `Keep-Alive`,
`Transfer-Encoding`, `Upgrade` and `Proxy-Authorization` too) and trusted values set —
`X-Forwarded-Proto: https` through the tunnel, `X-Forwarded-For` (with `CF-Connecting-IP`) from
Cloudflare's client IP, and `X-Forwarded-Host` from the Host header. `X-Forwarded-Prefix` is the one
added: some frameworks take their base path from it, and the platform never sends one, so one that
arrives was written by the visitor. It was relayed until dev.16; now it is dropped on the HTTP and
the WebSocket path alike, and by the per-app HTTPS proxy on the masjid's network
(`system/app-proxy.ts`) too. Everything else but the Cookie header above is relayed as the client
sent it. The request path is forwarded verbatim, the app's own segment included.

**What goes back** through the tunnel (HTTP; `responseHeadersForTunnel`):

- A `Set-Cookie` for `omos_session` or `__Host-omos_session` is removed; the app's own cookies stay.
  The apps share a hostname, and one app setting `omos_session` for another's path is how it would
  sign the admin out of that app, or into an account of its own choosing.
- `Service-Worker-Allowed` is removed. Without it a service worker is confined to the directory its
  script is served from; with it, one app could register a worker over the whole hostname and see
  every other app's pages — and `/_omos/open`, which hands a browser an app's access token.
  Removing the header is only half of it, and a review found the other half: the directory of the
  bare address `/<path>` is `/`, so an app could serve its worker script THERE and claim the whole
  hostname with no header at all. So at the bare address (`isBareAppAddress`) a service worker's
  script fetch never reaches the app. Either mark a browser puts on that fetch is enough —
  `Service-Worker: script` or `Sec-Fetch-Dest: serviceworker` (`isWorkerScriptFetch`) — and a page
  cannot put the second on an ordinary fetch. It is answered with `SELF_REMOVING_WORKER`
  (`answerBareWorkerFetch`): a 200 `text/javascript` script, with the three no-store headers, that
  skips waiting when it is installed and unregisters itself when it is activated, and does nothing
  else — it clears no caches, which belong to the apps. The front door's not-found handler gives
  the same answer, so a shared app's bare address, a private app's (with its token or without) and
  an empty one answer alike and say nothing about what is installed. (Not at an address that is
  also one of the dashboard's own, `settings` say: there the front-door gate answers an empty or
  declined request first, as it does any dashboard path — the ordinary 404 through the tunnel,
  the dashboard itself on its own address while remote administration is on, the redirect to it
  on the masjid's network — and only a served app gets the worker.) It is recorded as
  `worker-at-bare-address` only when it came through the tunnel. The answer was the ordinary 404 at
  first, replaced before it was published because that is not enough: it stops a new registration,
  but by the Service Workers specification an update check that fetches no script leaves an
  existing registration in place, its worker still in charge — and every earlier build, Stable
  included, let an app's page register one from its bare address. The browser's next update check
  of such a registration now installs the self-removing worker, and the registration goes.
  Every other request there reaches the app as it always did, whatever the method, but what the app
  answers is never cacheable (`noStore`, the next point), so no copy in the browser or at
  Cloudflare's edge can later stand in for a worker's script. Every script of an app's that a
  browser can register therefore lives under `/<path>/`. The bare-address rules hold on the
  masjid's network too, through the front door — the worker answer at any bare address, no-store
  wherever it proxies an app — though nothing there is recorded; the header removal is the
  tunnel's alone. Every spelling counts — `/%73hared` is `/shared` to the router — which is why the
  test asks of the raw path only "one segment, no trailing slash". The first fix redirected a GET
  or HEAD of the bare address to `/<path>/` instead, and it was withdrawn before it was published:
  an app that sends `/<path>/` back to `/<path>` — Next.js with a base path does, by default — then
  bounced between the two for ever, and its public page was gone.
- A private app's response, any response to a request that carried the app's access token, and any
  response at an app's bare address (above) gets `Cache-Control: private, no-store`,
  `CDN-Cache-Control: no-store` and `Cloudflare-CDN-Cache-Control: no-store` over whatever the app
  sent, and loses its `Expires`. Cloudflare keys its cache on the address alone and by default keeps
  anything ending in `.js`, `.css`, `.png`, `.pdf`… whatever cookie the request carried, so a cached
  copy would go to whoever asks next. A shared app's public pages under `/<path>/` keep the app's
  own cache headers.
- Every tunnel refusal carries the same three no-store headers (`refuseOverTunnel`), so a cached 404
  is never served to the admin. The remote dashboard's own responses get the two CDN headers too
  (`index.ts`, for every request the front door handed over).

### Single sign-on with an access token

`GET /api/auth/session` keeps its shape and stays LAN-only, behind the app's own secret. It reads the
`omos_session` the app forwards and accepts either a session (`getSessionUser` — the masjid's
network) or, failing that, an access token **for the app presenting its secret**, while remote
administration is on (`appAccessSsoUser(cookie, app.id)` in `api/fabric.ts`). The same token
presented by any other app answers `authenticated:false`, and the app still needs the `sso`
capability. An OpenMasjid app needs no change: it forwards the `omos_session` cookie it receives, as
it does on the masjid's network, so the admin who presses Open from outside is signed in to that app
by the platform.

What ends with the token is the platform's yes. An app that turned a `true` into a session of its
own keeps that session by its own rules: an app that is not shared stays unreachable from outside
without a valid token, whatever the app thinks, but a shared app is served to anyone, so its own
session cookie goes on working there until the app ends it.

### Limits, stated plainly

- **Apps share ONE origin with each other** on the apps' hostname, where on the masjid's network each
  has its own port and so its own origin. A cookie's `Path` is not a boundary inside an origin, so a
  malicious app's page could act within another app the admin has opened there. It cannot act as
  the dashboard, which is on another hostname, and it cannot read the other app's token
  (`HttpOnly`), which opens only that app anyway.
- **A WebSocket's `101` response is relayed byte for byte**, so a `Set-Cookie` on it is not filtered.
- **An app's socket is watched only if it opened with the admin's access token, and when that
  sign-in is over it is closed at both ends.** Such a socket is recorded (`trackAppSocket` in
  `system/remote-sockets.ts`, in the same table as the dashboard's own sockets: 200 places, of which
  apps may hold at most 150, `MAX_APP_SOCKETS`, so the dashboard's always have room — in a review
  one app's page filled the whole table, after which no terminal, update or restore from outside
  could start; a socket that does not fit is refused) and closed once its token stops being
  honoured (*the access token*, above): at once when an admin's action in the dashboard is the
  reason — a sign-out, a new password, a change to the second factor, a change in Settings → Remote
  access that shuts remote administration — and otherwise at the next five-second sweep. A review
  found a private app still answering a socket opened before the admin signed out; that is what
  this closes. The sweep destroys the browser-facing socket, and the relay takes the connection to
  the app with it: `closeTogether` (`system/socket-relay.ts`, shared by the ingress and the per-app
  HTTPS proxy) destroys either side when the other errors or closes, so the app sees its connection
  drop, with no WebSocket closing handshake. A polite close from the app still reaches the browser first: the
  browser's side is destroyed only if it was not already ended. The first version cut the browser
  off and nothing more, and the next review found why: the relay was two pipes, a pipe passes on
  an END and nothing else, and a destroyed socket never ends — so the app's connection stayed open,
  held by the core, until the app noticed by itself. A socket opened with no valid token is the
  public's: it is not tracked, and no sign-in ending closes it (its two ends are still tied
  together, like every relayed socket's). Only WebSockets are tracked: a long-lived HTTP response
  opened with the token — Server-Sent Events, a long poll, a slow download — runs to its end
  whatever happens to the sign-in.
- **A browser that leaves part-way ends the app's HTTP response too** (`proxyHttp`, and the per-app
  HTTPS proxy): when the browser's response closes before it has finished, the request to the app
  is destroyed. `pipe()` only paused the app's response, so the core held the app's connection — a
  live event stream, a long poll, a big download — until the app gave up by itself. It is the HTTP
  half of what `closeTogether` does for sockets; nothing tracks such a response for the sign-in
  (the bullet above).
- **The platform keeps only the dashboard's own sockets alive.** Cloudflare closes a WebSocket that
  carries nothing in either direction for about 100 seconds, so the dashboard listener pings every
  socket it holds every 30 s (`startDashboardHeartbeat`, `DASHBOARD_WS_HEARTBEAT_MS` in
  `system/remote-admin.ts`). An app's socket is relayed byte for byte by the front door and never
  pinged, so an app whose socket can sit quiet must send its own heartbeat
  ([`APP_MANIFEST_SPEC.md`](APP_MANIFEST_SPEC.md) tells app authors so).
- **A worker an earlier build let an app register over the whole hostname from under its own path
  is not removed.** Every build before dev.16 passed `Service-Worker-Allowed` through the tunnel,
  so an app could serve its worker's script under `/<path>/` with that header and register it with
  the scope `/`. The self-removing worker answers only at a bare address. Such a registration's update check
  now gets its script without the header (or a 404, if the app is gone or no longer shared), and
  either way the browser refuses the update — which leaves the registration and its worker where
  they were, in the browser of anyone who opened that app through the internet address. Clearing
  that browser's data for the apps' hostname removes it.
- **A masjid's own reverse proxy on the LAN** that sends `x-forwarded-proto: https` looks like the
  tunnel (`isViaTunnelHeaders` reads `cf-ray` or that header): the ingress strips platform cookies
  from its requests and refuses private apps to it, as it does to the internet, and a worker fetch
  at a bare address through it is recorded as though it came from outside. The dashboard behind
  such a proxy is taken in only by its sign-in rules, which ask more of a request, never less:
  signing in through it needs the second factor, and a password-only session reads as signed out.
  The session such a sign-in makes yields no access token (*the access token*, above). What the
  dashboard does differently from outside (`apps.openRemote`, `auth.me` → `remote` and
  `appOrigin`) follows the front door's hand-over, not a header, so an admin there opens apps at
  their own ports, as on the masjid's network.
- **An app must be base-path aware** to work under `/<path>/` — now for every app opened from
  outside, shared or not, because that is the only way in from there — and must not assume its path
  is its id (`addressForNewApp`, `setAppPath`). `GET /api/fabric/site` returns the `basePath` (the
  `domain` capability), and so, for a shared app, does the path of `OPENMASJID_PUBLIC_URL`. A private
  app is not restarted when its `basePath` changes (remote access switched on or off, for one),
  because its `OPENMASJID_PUBLIC_URL` stays empty: `reconcilePublicUrls` lists only the apps whose
  value changed, and those are the ones the Remote access router restarts (`reconcileAndReup`). A
  community or custom app may simply not work under a path. OpenWA's own screen does not, so its
  Open button in Settings → WhatsApp is disabled from outside.
- **Cloudflare's free plan refuses request bodies over 100 MB**, for an app's uploads as for
  anything else through the tunnel.

## Non-goals (unchanged)

No durable event bus/queue in the core; no app-to-app calls that bypass the broker; no service
discovery exposed to apps; no changes to SSO/notify/appearance/Stripe beyond docs cross-references.
Those were the v0.40.0 work's non-goals. Single sign-on did change later, in v0.51.2-dev.16: it also
accepts an app's own access token from outside (*Apps through the tunnel*, above).

## OpenMasjidAPPS mirror (separate repo — copy-ready)

`validate-compose.mjs` needs **no** change. In `scripts/build-catalog.mjs`, after the existing
category check and before `apps.push({...})`:

1. **Validate `m.fabric`** (if present): must be an object; `provides` (if present) an array of
   `{ capability }` where `capability` matches `^[a-z0-9][a-z0-9-]{0,39}$`; `consumes` (if present) an
   array of strings matching `^<APP_ID_RE>/<capability>$` — else `fail()` with a friendly message.
   (Do **not** copy the `=== true ? true : undefined` idiom — that silently drops malformed shapes.)
2. **Validate `m.tunnel`** (if present): `typeof === 'boolean'` else `fail()`.
3. **Emit both keys** into the `apps.push({...})` object: `fabric: <validated>` and
   `tunnel: m.tunnel === true ? true : undefined` (the clean pass drops `undefined`).
4. Document `fabric:`/`tunnel:` in `docs/BUILDING_AN_APP.md` (currently silent on both).
