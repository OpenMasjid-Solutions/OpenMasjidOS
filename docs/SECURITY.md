<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Security model & assumptions

OpenMasjidOS runs as a single-admin appliance that manages Docker on the host
(it mounts the Docker socket and runs as root). This document states the trust
assumptions and the knobs for hardening a more exposed deployment.

## Trust model

- **Designed for a trusted LAN.** The expected deployment is a mini-PC / Raspberry
  Pi / VPS on the masjid's own network, reached at `https://<server-ip>` over a
  self-signed certificate. There is no `.local` address — mDNS was never built, so
  `openmasjidos.local` does not resolve (it exists only as a certificate SAN; see
  `docs/NETWORKING.md`). Read *What "LAN-only" means, exactly* below before
  assuming the network itself keeps anyone out.
- **Reaching it from outside is opt-in.** Remote access goes through a Cloudflare
  tunnel. Apps you share online are served at your apps' address; the dashboard is
  served from outside only if you switch on remote administration — at an address
  of its own, behind your password *and* a second factor. See *Remote
  administration* below.
- **One admin account.** It is effectively host-root (it can install apps and open
  a root shell), so the admin password is the keys to the machine — use a strong
  one (the setup screen enforces ≥12 characters and shows a strength meter). From
  outside the masjid the keys are the password and the second factor together.
- **Apps run at arm's length** as separate containers and are not trusted with
  platform internals. The compose consent gate (below) vets every app's compose.

## Transport (HTTPS)

- The dashboard is **HTTPS-forced**: it serves TLS on 443 and a plain-HTTP front
  door on 80 that redirects to HTTPS (and answers the health check + the Fabric
  API, which app backends reach over HTTP).
- The front door is also where the **Cloudflare tunnel** lands. Cloudflare
  terminates TLS at its edge and passes each request to port 80, where the front
  door serves your apps by path and — only with remote administration on — hands
  the dashboard's requests, unread, to the dashboard's own routes, so they meet
  every check they meet on the LAN. A visit to the dashboard over plain `http://`
  is redirected to `https://` on the apps' address configured in Settings, never
  to one taken from the request.
- The cert is **self-signed by default** (a LAN box can't get a public CA cert);
  regenerate it or upload your own (cert + key) in **Settings → Advanced**.
- **Stripe apps** (manifest `https: true`) are served over HTTPS on a dedicated
  per-app proxy port on the masjid's network; other apps stay on plain HTTP there.

## Session cookie & the dashboard key

- On the masjid's network the session cookie is `omos_session`: `HttpOnly`,
  `SameSite=Lax`. `SameSite=Lax` (not `Strict`) is required so the cookie rides the
  cross-scheme "Open app" navigation (HTTPS dashboard → HTTP app) for SSO.
- **Replay is blocked by the origin-bound *dashboard key*, not the cookie.** Every
  cookie-authenticated admin call must also present a per-session CSRF key that
  lives only in the dashboard origin's storage — which an app on another port
  cannot read. So even a sniffed/forwarded cookie cannot drive the admin API.
  - **From outside, the key never touches storage.** A browser draws the line
    around a site's own storage by scheme + host + port, never by path, and through
    the tunnel the dashboard shares its address with your apps, so every app page
    there IS the dashboard's origin. So the remote dashboard keeps the key in the
    open tab's memory only, and the server hands it back only inside the
    dashboard's own page, when the browser itself loads that page — never to a
    background request, a frame or an embed — and that page cuts off any window an
    app opened on it. See *Remote administration* for the whole rule and what it
    costs.
- The cookie is **not `Secure` by default**, because it is forwarded to plain-HTTP
  apps for SSO and a `Secure` cookie is never sent over HTTP. The dashboard itself
  is HTTPS, so the cookie is encrypted in transit to it regardless.
  - **`OPENMASJID_SECURE_COOKIE=1`** — set the cookie `Secure`. Hardens the cookie
    on a hostile network, but **breaks SSO for plain-HTTP apps** (they no longer
    receive it). Enable only when the whole deployment is end-to-end HTTPS or you
    don't use HTTP-app SSO. *(On the masjid's network, a separate Secure dashboard
    cookie split from the cross-app SSO cookie is still a future enhancement. The
    remote dashboard already has one, whatever this is set to — next.)*
- **The remote dashboard has a cookie of its own, `__Host-omos_session`.** It is
  always `Secure`, with `Path=/` and no `Domain` — which a browser demands of any
  `__Host-` cookie — and `HttpOnly`, `SameSite=Lax`, and it is the only cookie the
  remote dashboard reads. A page on a sibling hostname could otherwise set a
  parent-domain cookie that shadowed the real one and signed you out in a loop; a
  browser lets nobody set a `__Host-` cookie with a `Domain`, so nothing on another
  hostname can plant it, and no script can overwrite it while it is set, because
  it is `HttpOnly`. The browser sends it with requests for app paths too, since
  they share the address; the platform removes it before forwarding anything to
  an app, so it is never sent to your apps.

## Login throttle

- argon2id hashing, the credential verify is **serialized** (one at a time, so a
  parallel flood can't outrun argon2's cost), and consecutive failures incur a
  growing delay (reset on success). The delay is applied outside the verify mutex,
  so a correct login is never queued behind attacker delays.
- **`OPENMASJID_LOGIN_LOCKOUT=1`** — opt-in hard cooldown after repeated failures,
  for **internet-exposed** instances. Off by default: behind Docker NAT all LAN
  clients share one source IP, so a global lockout could let an attacker deny the
  real admin on a trusted LAN. Being global, it also counts wrong passwords that
  arrive through the tunnel, so with remote administration on it would let a
  stranger keep you out a minute at a time. The tunnel already has the lockout
  below.
- **Through the tunnel, sign-in has a real per-address lockout.** Ten failed
  attempts from one address — wrong passwords and wrong second-factor codes both
  count, each within 15 minutes of the last — refuse that address for 15 minutes. A
  correct password clears the address's count: this is aimed at someone guessing the
  password, and the code step has its own limit (five wrong codes, then the sign-in
  starts again from the password). It can be per-address here and nowhere else
  because Cloudflare sets `CF-Connecting-IP` at its edge, and a visitor coming
  through the tunnel cannot forge it; on any other request the header is ignored,
  since anyone could type it. (On a host the internet can reach directly, a caller
  can type Cloudflare's headers as well and dodge the count — but a request carrying
  them is treated as tunnel traffic, so it is refused or asked for the second factor
  too.)

## What "LAN-only" means, exactly

Several routes are described in this project as LAN-only: everything under `/api/fabric/*`
(the app-to-app broker, and the email / WhatsApp / Stripe / alert endpoints apps use),
`/api/auth/session`, and the health and readiness checks (`/api/health` would otherwise tell
anyone which build this masjid runs). Remote administration does not change that: those
routes are refused over the tunnel whatever it is set to. It is worth being precise about
how that is enforced, because the honest answer is narrower than the phrase suggests.

**What it actually does.** Those routes are refused when a request *looks like it arrived
through the Cloudflare tunnel* — Cloudflare adds a `cf-ray` header at its edge and terminates
TLS, so tunnel traffic is recognisable. That check is sound in the direction that matters: a
client whose only route in is the tunnel cannot strip those headers, so it genuinely cannot
reach those routes.

**What it does not do.** It is a deny-list, not an allow-list: "refuse anything that looks
like the tunnel" is not the same as "allow only the local network". If the machine itself is
reachable from the internet — a VPS with a public IP, or a home router forwarding ports 80
and 443 — then requests arrive with no Cloudflare headers at all, and there is nothing in
them that distinguishes an attacker from a laptop in the masjid office. On such a host these
routes are internet-facing, and so is the dashboard's login page — which there asks for the
password alone, because the second factor is demanded only of requests that came through the
tunnel, and a request arriving directly looks exactly like one from the office.

**Why we do not check the source IP address instead.** That would be the obvious fix, and it
does not work here. OpenMasjidOS runs in a container with published ports, and with Docker's
default settings every inbound connection is re-originated by `docker-proxy` from the bridge
gateway. Measured on a real host, an app container, the tunnel client, and a machine from
outside the network all arrive as the same address — `172.17.0.1`. A source-address check
would therefore classify the internet as "local", producing a guard that reads like an
allow-list while admitting everyone. That is worse than none, so we deliberately do not have
one. (The same fact is why sign-ins on the masjid's network cannot be locked out per address;
through the tunnel, Cloudflare's own header makes it possible — see *Login throttle*.)

**What protects you on a directly-reachable host**, in order of how much it matters:

1. **A firewall.** Allow ports 80 and 443 only from your own network. On a VPS use the
   provider's firewall or `ufw`; on a home network, simply do not forward those ports. This is
   the control that makes "local only" true, and nothing inside the application can substitute
   for it. Remote access needs no open port: the Cloudflare tunnel connects outwards.
2. **Your admin password.** No route grants a session, skips the password, or relaxes the
   dashboard key because a request looks local. What looking local *does* skip is the second
   factor, which is asked for only on traffic that came through the tunnel — so on a
   directly-reachable host the password is the whole of sign-in. Passwords are
   argon2id-hashed with a 12-character minimum, and the verify is serialised so a parallel
   flood cannot outrun it.
3. **The per-app secret.** Every `/api/fabric/*` route independently requires a 256-bit
   per-app secret *and* the specific capability the app declared. Reaching the route is not
   the same as using it.
4. **`OPENMASJID_LOGIN_LOCKOUT=1`** — worth enabling on an internet-facing instance. See
   *Login throttle* for why it is off by default, and why it does not suit remote
   administration.

**What an attacker gets if all of that holds and they simply reach the routes:** a 403 from
every Fabric route, and a login page. `/api/auth/session` says only whether a sign-in is
valid and whose it is, and says yes only to an app that presents its own secret, has asked for
single sign-on, *and* forwards a valid session cookie — or, while remote administration is on,
the access token made for that very app (see *Opening apps from outside*). No password hash, no
session token, no CSRF key. There is no route that hands out credentials to a caller because of
where they appear to be.

## Remote administration (managing from outside the masjid)

**Off by default.** Settings → Remote access → *Manage OpenMasjidOS from outside* serves the
whole dashboard through your Cloudflare tunnel: apps, files, terminals, backups, restores and
updates. Once it is on, the dashboard's sign-in page answers to anyone on the internet who
knows its address, and what keeps them out is your password **and** a second factor. The
terminals still need their own switches in Settings → Advanced, and the File Explorer still
refuses the platform's own files — from outside exactly as at the masjid. Apps you share
online do not depend on this switch: they are served at your apps' address whenever the
tunnel is on. The design record, with the history of how it got here, is
[`REMOTE_ADMIN.md`](REMOTE_ADMIN.md).

### When the door is open

The dashboard is served from outside only while **all four** of these hold. Each is checked
again on every request, never just when the switch was flipped, so undoing any one of them
shuts the door at once:

1. the Cloudflare tunnel is on;
2. the switch is on;
3. two-step sign-in is set up (Settings → Account). Turning it off shuts the door in the same
   action, rather than leaving a password-only dashboard on the internet. As a backstop, a
   sign-in that arrives through the tunnel is refused outright while no second factor exists;
4. an admin account exists. A fresh box belongs to whoever sets it up first, and that must
   only ever mean someone in the building — so first-run setup, and restoring a backup onto a
   new box, refuse tunnel traffic outright as well.

Settings says what is missing, and asks you to confirm before it switches on.

**"From outside", on this page, means handed over by the front door**: a request for the
dashboard that came through the tunnel while the door was open, which the front door
marks as it passes it on — a mark nothing in a request can imitate. That mark decides
everything the dashboard *does* differently from outside: how *Open* works, what it will not
let you change from there, which versions of OpenMasjidOS it will move the box to, the check a
restore has to pass — and that only a sign-in made there counts there. The rules about signing
in are stricter and apply to anything that merely *looks* as if it came through Cloudflare: the
second factor, the per-address lockout, and that a password-only session does not count.
*Honest limits* says what that means for a reverse proxy of your own.

### One address, and the key that keeps apps out

You add **one** public hostname to the tunnel in Cloudflare, Type HTTP pointing at
`localhost:80`: *Your apps' address* (for example `omos.example.org`). With remote
administration on, the dashboard is served at its root (`https://omos.example.org/`), beside
every app at `/<path>/`. (`0.51.2-dev.16` asked for a second hostname for the dashboard alone;
a box that kept one is served there too.)

That makes every app page the **same origin** as the dashboard: a browser draws the line
around a site's own data by scheme + host + port, never by the path. On the masjid's network
the port draws it — the dashboard is `https://<ip>`, each app `http://<ip>:<port>` — but
through the tunnel there are no ports to tell them apart. So an app's script there — from any
app the admin opened, or a cross-site-scripting bug in any public app page — can send requests
that carry the admin's own cookie and pass the origin check. What it must never get is the
**dashboard key**, without which none of those requests can change anything. **The first
version got this wrong:** `0.51.2-dev.13` to `dev.15` kept the key in the dashboard's
`localStorage`, which every app page there could read, and so drive the dashboard's whole API —
switch on the root terminal and open it (host root, since the core holds the Docker socket), or
download a backup (every secret the platform holds). So now, from outside:

- **the key is never stored** — the remote dashboard keeps it in the open tab's memory, and
  removes any left in storage from before;
- **it is handed back only inside the dashboard's own page, loaded by the browser itself.**
  After a reload the server writes the key into the page, but only when the browser says it is
  loading that page as a page in its own window (`Sec-Fetch-Dest: document` and
  `Sec-Fetch-Mode: navigate`, headers no script can set), for a live session from outside.
  A background request, a frame or an embed — anything an app page could cause — gets the page
  without it;
- **no app page can hold the dashboard's window.** Its pages send
  `Cross-Origin-Opener-Policy: same-origin`, refuse every frame, and are never cached; app
  pages never send that policy (the platform removes it from their responses), so a window an
  app page opens on the dashboard is cut off from it the moment the dashboard loads;
- **nothing else gives the key, or the admin's details, away.** No answer contains the key;
  asked without it, the dashboard's "who is signed in" answers "nobody", so an app page cannot
  read the admin's name, email or phone; and the File Explorer's inline view, whose address
  carries the key, never sends that address on to anything it loads.

A browser too old to send those headers — Safari before 16.4 — gets no key with the page, so
from outside it asks for the password and code again after every reload. *Honest limits* says
what an app page can still do on the shared address.

What the address serves through the tunnel:

| | |
|---|---|
| Apps you share online | to anyone, at `/<path>/` |
| Apps you have not shared online | only while the door is open, and only to a browser holding that app's access token (*Opening apps from outside*, below) |
| The dashboard: its pages, `/trpc`, its own `/api` routes (updates, files, terminals, backup, restore, the logo upload) and its live connections | only while the door is open; past the sign-in page, only to a session that passed the second factor and holds the key |
| `/_omos/open`, where an *Open* link is spent | only while the door is open |
| `/api/public/appearance`, `/api/public/logo`, `/favicon.ico` and the two `apple-touch-icon` files | yes — public by design |
| `/api/fabric/*`, `/api/auth/session`, `/api/health`, `/api/ready`, and every app's own `/fabric/*` | never |

Everything else is refused. (One answer is not a refusal: a background worker's script asked
for at a bare address gets a worker that removes itself, the same everywhere — see *What apps
receive through the tunnel*.) The dashboard's own pages — `/store`, `/apps`, `/files`,
`/settings`, `/design-system` — can never be an app's path.

Point the hostname at port **80**, the front door, never at the dashboard's own port (443).
The front door's gate is what makes remote administration a switch. If a hostname is pointed
at 443 by mistake, the dashboard refuses every request that arrives through Cloudflare without
having been handed over by that gate — with the ordinary 404, listed under *Recently turned
away* as reaching the dashboard's own port — rather than answering the internet with the
switch off.

**Changing the address and the tunnel token.** Settings checks the tunnel token *before*
saving anything, so a save it refuses changes nothing. It sends the address only if you edited
it, so it never puts back one that was changed from another device in the meantime. From
outside, **the tunnel token** cannot be changed at all, because the request doing it travels
through the very thing it would change: saving one restarts the tunnel your connection runs
on, and a token for another tunnel, or half of one, connects nowhere useful — your window and
every shared app would go offline until someone at the masjid fixed it. Pasting the token
already in use changes nothing, and is accepted. Change it at the masjid. (The address can be
changed from outside: Cloudflare decides which hostname reaches the box, so a typo there breaks
*Open* and your apps' public links until it is corrected, but not the dashboard.) Everywhere, a paste that is not a whole tunnel token is refused
before anything is saved: the tunnel would otherwise retry it for ever while the log said it
was running. Cloudflare's whole install command (`cloudflared … --token <token>`) is cut down
to the token in it, and a token that lost only the `=` signs at its end — a double-click leaves
them behind — has them put back, because the tunnel refuses it without them. Settings no
longer shows a tunnel stuck retrying as running, either: it says "Tunnel is turned on but
isn't connecting. Check that the tunnel token is the right one and that this machine is
online." (It used to say the tunnel was turned off.) The log now says only "Cloudflare tunnel
started." when the tunnel is started, because whether it then connects is more than the
platform can see from there.

And from outside, turning remote access off, turning *Manage OpenMasjidOS from outside* off and
removing the tunnel each ask before they act, because each ends your own connection and only
someone at the masjid can undo it. At the masjid they stay one click.

### Signing in from outside

- A sign-in through the tunnel takes the password **and** a second factor: a code from your
  authenticator app, one of your backup codes, or — if you allowed them — an emailed code. A
  sign-in waiting for its code lasts ten minutes and allows five wrong codes; after that it
  starts again from the password.
- **Only a session made that way counts from outside.** A session made on the masjid's network
  — password only — is refused from outside, and keeps working at the masjid. The reason is
  single sign-on: every app on the masjid's network receives the admin's LAN cookie, so an app
  that kept one could otherwise have used it from the internet with no second factor.
- **And only a sign-in made through the tunnel itself.** Signing in through a reverse
  proxy of your own on the masjid's network, in front of the dashboard's own port, asks for the
  second factor too (*Honest limits*), and that session goes on working through the proxy —
  but it never works on the remote dashboard, and never opens an app from outside. It lives in
  the ordinary session cookie on the proxy's address, which every app you open from that page
  receives; and an app's access token (*Opening apps from outside*) is worked out from the
  session by a formula anyone can read in the source, so any one of those apps could otherwise
  have made a token for every app — private ones included — and used it from the internet.
- The remote session lives in `__Host-omos_session` (see *Session cookie & the dashboard
  key*), and its dashboard key only in the open tab's memory.

### When a remote session ends

- When you **sign out**.
- When the **password changes** — in Settings, or with the installer's *Reset sign-in*. That
  ends every session made under the old password, at the masjid and outside; a change made in
  Settings keeps only the browser that made it signed in.
- When the **second factor changes.** Enrolling or replacing an authenticator app, replacing the
  backup codes, allowing or stopping emailed codes, and turning two-step sign-in off each start
  a new second-factor *epoch*, and every session made from outside under the old one stops
  working from outside at once — so replacing a lost phone, or backup codes someone else has
  seen, also shuts out whoever signed in with them. The one exception is the session that made
  the change from outside: it carries on, so you can still read the new backup codes, which are
  shown once (unless the change was turning two-step sign-in off, which shuts the door itself).
  Restoring a backup's settings starts a new epoch too (*Backups and restores from outside*).
  The epoch decides only what counts from outside; see *Honest limits* for what it does not do
  on the masjid's network.
- Otherwise, seven days after it was made.

Switching remote administration or the tunnel off **shuts the door** rather than signing anyone
out: every request from outside is refused at once, but the sessions themselves are kept, and
if the door opens again within their seven days, a browser that was signed in from outside is
signed in again. To shut them out for good, sign out from that browser, change the password, or
replace the backup codes.

### If the phone is lost

- **A backup code works wherever a code from the authenticator app does**: to sign in, and to
  set up a new phone (*Use a different phone* in Settings → Account), which shuts out every
  session made with the old one.
- **With neither the phone nor a backup code, use the installer's *Reset sign-in*** on the box
  itself. As well as setting a new password, signing everyone out and giving every app a new
  sign-in key (their data stays), it asks whether to turn two-step sign-in off — only while it
  is on, and the answer is no unless you say yes. The two-step settings ask for a current code
  before any change, at the masjid as well as from outside, so an admin who had lost both the
  phone and the backup codes used to have no proper way to remove or replace it. Reset sign-in
  needs a terminal on the box, so it gives nothing away. Managing from outside then stays off
  until two-step sign-in is set up again.
  (The password-only reset tool, `reset-password`, does not touch two-step sign-in; while it
  is on, that tool points at *Reset sign-in*.)

### Connections that stay open

The front door checks HTTP requests one at a time, but a WebSocket is one request that can last
for hours: the dashboard's live data, update and restore progress, terminals, and an app's own
live connections. So, from outside:

- the dashboard's connections are handed over only to a browser signed in from outside. The
  sign-in page opens none — the dashboard opens its live connection only once something on
  screen needs it — and anyone else's is closed, exactly like a connection to an address with
  nothing at it;
- every protected dashboard call checks the door and the session again, not only the first;
- a terminal checks the session, the door and its own switch in Settings → Advanced before
  every keystroke;
- every connection handed over from outside, and every connection to an app opened with your
  access token for it (*Opening apps from outside*), is looked at again every five seconds —
  and straight away when you sign out, change the password or the second factor, switch
  remote administration or the tunnel off, remove the tunnel, or save a change to the
  remote-access settings — and closed once the door has shut or the sign-in behind it has
  ended. A connection to an app is closed at both ends: the app sees it drop too, instead of
  being left holding a connection to nobody. A visitor's connection to an app you share, made
  without a token, is the public's, and is left alone;
- at most 200 such connections are open at once, and no more than 150 of them may be apps', so
  an app that keeps opening connections cannot leave the dashboard's own terminals, updates
  and restores unable to start; one more is refused.

Closing a progress window never stops the work behind it: an update or a restore runs to the
end whether anyone is watching or not. Nor is an ordinary request cut off once it has started:
only live connections (WebSockets) are watched, so a download under way — or an app's live
event stream opened with your access token — runs until it finishes or the browser leaves,
even after the sign-in behind it has ended. When the browser does leave part-way, the request
to the app ends too, instead of the app's connection being held open for nobody.

### Opening apps from outside

Apps live at your apps' address, never the dashboard's, so the dashboard's cookie never reaches
them — and an app has nothing from your browser to go on. So pressing **Open** on the remote
dashboard:

1. asks the platform for a **ticket** for that one app: single use, valid for 60 seconds,
   issued only to the remote dashboard, for a session signed in there that passed the second
   factor;
2. opens a new tab — blank at first, with its link back to the dashboard cut, so the app cannot
   reach back into the dashboard's tab — at `https://<apps' address>/_omos/open?t=<ticket>`;
3. there, spends the ticket: the browser is given that app's **access token** as a cookie for
   that app's path only (`omos_session`, `Secure`, `HttpOnly`, `SameSite=Lax`, lasting no longer
   than your session) and is sent on to `/<path>/`.

`_omos` can never be an app's path: app paths are lower-case letters, digits and hyphens, and
nothing else is ever routed to an app — not even a stack someone starts by hand. (The platform
picks up any `omos-…` stack Docker reports, and Docker allows `_` in a name, so without that
rule one started as `omos-_omos` would have been served at `/_omos`.) The route refuses on the
masjid's network and while remote administration is off; a link
that has been used or has expired, or whose session has ended since, shows a short "This link
has expired" page.

**What an app can do with its access token: sign you in to itself, and nothing else.** Its
backend forwards the token to the platform's single sign-on check (`/api/auth/session`, on the
LAN, with the app's own secret) just as it forwards the session cookie at the masjid —
OpenMasjid apps need no change for this — and the platform accepts it **for the app it was made
for and no other**. The token:

- works only while the remote session it came from does — same password, same second factor,
  not signed out — and while remote administration is on;
- cannot be turned back into your session, or into another app's token: it is an HMAC of the
  app's id, keyed by your session's own token (`appAccessToken` in
  `packages/core/src/auth/sessions.ts`);
- is not a dashboard session. No dashboard route accepts it.

**An app you have not shared online** is served through the tunnel only to a browser carrying a
valid access token for it. Anyone else gets the same 404 as an address with nothing at it
(recorded as an app you haven't shared). Opening it from outside does not publish it: it still
has no public address, and the remote dashboard loads nothing from it, not even its icon.

**No two apps on one path.** Settings refuses to give an app a path another installed app
already answers to, and a newly installed app whose id is already another app's path gets
the next free one instead (`<id>-2`, and so on), noted in the log. `/api`, `/trpc` and
`/assets` belong to the platform and can never be an app's path. Where an older install already
has two apps on one path, a private app never takes it from a shared one — the shared app keeps
it, and the clash is logged.

### What apps receive through the tunnel

- **No platform sign-in cookie reaches an app.** Every `omos_session` — whatever its value — and
  every `__Host-omos_session` is taken out of the `Cookie` header passed to an app, on page
  requests and WebSocket connections alike. The app's own valid access token, if the request
  carried one, is put back first, because OpenMasjid apps forward the first `omos_session` they
  find. So a password-only sign-in from the masjid's network can never be used through the
  tunnel to sign in to an app. Before this filtering existed the tunnel passed the header on
  unchanged, and a shared app's single sign-on would have accepted a LAN cookie presented there,
  with no second factor. (A browser never sends the LAN cookie to your apps' address by itself,
  so nothing legitimate is lost.)
- **What an app sends back is filtered too.** A `Set-Cookie` for a platform cookie name is
  dropped, so one app cannot plant one for another app's path; so is `Service-Worker-Allowed`,
  which would let an app's background worker (a *service worker*) reach beyond its own path.
- **An app's bare address cannot install a background worker.** A service worker reaches the
  folder its script is served from, and the folder of an app's bare address — `/<path>`, with
  no slash after it — is the whole hostname: every other app's pages, and the address that
  hands out access tokens. So when a browser fetches a worker's script there (the browser marks
  that request as one), it never gets the app's script. It gets a tiny worker that removes
  itself as soon as it starts, and does nothing else — it clears none of the apps' stored data.
  A 404 would stop a new worker being installed, but not get rid of one already there: a
  browser that fails to fetch a worker's script when it checks for an update keeps the old
  worker running, and every earlier version of OpenMasjidOS, Stable included, let an app's page
  install one over the whole address from there. A browser holding such a worker installs this
  one at its next check, and the old one is gone. The answer is the same whether a shared app,
  a private one or nothing at all is at that address, and on the masjid's network too, so it
  says nothing about what is installed; such requests that came through the tunnel are listed
  under *Recently turned away*, which is a list of what came in from outside. Everything else
  at the bare address still reaches the app, as it always did — a payment provider posting to
  it included — but is sent with headers that keep it out of every cache, the browser's and
  Cloudflare's, so no stored copy can stand in for a worker's script later. Under `/<path>/` a
  worker reaches only that app, which is the app's own business. (A first fix, never released,
  redirected the bare address to `/<path>/` instead; an app that sends `/<path>/` back to
  `/<path>` — Next.js with a base path does, by default — would have bounced between the two
  for ever, taking its public page down.) *Honest limits* says what this cannot reach.
- **Forwarding headers are the platform's, never the visitor's.** Whatever a visitor sent as
  `X-Forwarded-For`, `-Proto`, `-Host`, `-Port` or `-Prefix`, `Forwarded`, `X-Real-IP`,
  `True-Client-IP` or `CF-Connecting-IP` is removed, and the platform sets its own
  `X-Forwarded-For`, `-Proto` and `-Host` (passing on Cloudflare's `CF-Connecting-IP` only on a
  request from the tunnel) — on page requests and live connections, on the masjid's network
  too, and through the HTTPS proxy a Stripe app sits behind. `X-Forwarded-Prefix` is on the
  list because some app frameworks take their base path from it, and the platform never sends
  one: one that arrives was typed by the visitor, and an app trusting it would build its links
  and redirects from a stranger's choice.
- **What the platform knows is private stays out of Cloudflare's cache**, which keys on the
  address alone. A private app's page, or anything served to an access token, is sent with
  `Cache-Control: private, no-store` plus `CDN-Cache-Control` and
  `Cloudflare-CDN-Cache-Control: no-store`; so is every refusal; and every response from the
  remote dashboard carries the two CDN headers, so a file downloaded from the File Explorer is
  not handed to the next person who asks for the same address. A shared app's pages — apart
  from its bare address, above — keep the caching headers the app itself sends: what it shows
  its own signed-in visitors is the app's to mark.

### What a stranger can learn

Everything refused through the tunnel is answered by one responder, whatever the reason: a 404 —
a short "There is no page at this address" page for a browser asking for a page,
`{"error":"Not found."}` otherwise — kept out of Cloudflare's cache, carrying a random
six-character reference that encodes nothing (it is how you find that request under *Recently
turned away*; the files every browser asks for on its own, such as `/robots.txt`, are not
recorded and carry none). A WebSocket that is refused is simply closed. The reason is recorded
under *Recently turned away*, where only you can read it, and never in the answer. So, from
outside, a stranger **cannot** learn:

- **which apps are installed.** An app you have not shared online is declined first, before
  anything else can answer differently for it, so its address — any path under it, its
  `/fabric` space, a WebSocket to it, a malformed or oversized body sent to it — gets exactly
  what an address with nothing at it gets. A worker's script asked for at a bare address gets
  the same self-removing worker wherever it is asked for;
- **anything about the dashboard while the door is shut**: its pages, `/trpc` and its files get
  that same 404, apart from the public presentation files in the table above and the
  self-removing worker, which is the same answer everywhere, door open or shut. While the
  door is open, whoever opens your apps' address with nothing after it sees the sign-in page
  and nothing past it; the dashboard tells a visitor who is not signed in no more than that the
  box has been set up. Treat the address as public: a hostname is not a secret;
- **the version, from the platform.** `/api/health` and `/api/ready` are refused over the
  tunnel, and the dashboard gives the version only to a signed-in session. (While the door is
  open, the sign-in page's own script files are those of the running build, so someone set on
  fingerprinting it could compare them with the published images.)

What a stranger **can** learn:

- the pages of the apps you share, and the public presentation the platform publishes for them:
  `/api/public/appearance` (theme, wallpaper — including the web address of a custom wallpaper
  image, if you set one — accent colour, language, whether a logo is set) and the logo itself;
- **whether remote administration is on**, two ways: your apps' address with nothing after it
  shows the sign-in page while the door is open and the ordinary 404 while it is shut; and
  `/_omos/open` answers a used, expired or made-up link with its "This link has expired" page
  while the door is open, and with the ordinary 404 while it is shut;
- **which addresses are the platform's own.** A request for one of them — `/trpc` at your apps'
  address, say — is refused before its body is read, while an address with nothing at it reads
  the body first, so a deliberately malformed request body can tell the two apart. Those
  addresses are the same on every OpenMasjidOS box and are in its public source code, so this
  says nothing about your masjid.

### Limits on what a stranger can send

- A request handed to the dashboard from outside, without a session that passed the second
  factor, may carry at most **64 KB** — a sign-in and a code are a few hundred bytes. A body that
  declares itself larger is refused (`413`) at the front door without being read; one that does
  not say how large it is is counted as it arrives and stopped (`413`) at the same size. Without
  this, the dashboard's ordinary 25 MB allowance — there for wallpapers and pasted compose files —
  would be open to the internet, and a handful of concurrent posts could exhaust a Raspberry Pi's
  memory, taking every public page down with the process.
- The dashboard API (tRPC) takes request bodies only as `application/json` (anything else gets
  `415`), on every connection, not only from outside. Its adapter would also take multipart
  bodies and read them into memory with no size limit; nothing in the dashboard sends one, so
  they are refused before it sees them.
- **Live connections.** From outside, the dashboard's WebSockets are handed over only to a
  browser signed in from outside (*Connections that stay open*), so a stranger cannot hold one
  open at all. Every message on a dashboard WebSocket — from anyone, at the masjid too — is
  capped at 1 MB; the dashboard never sends more than a live update or a terminal paste that
  way, and the library's default allowed 100 MB a message. And at most 200 of the connections
  watched from outside — the dashboard's, and apps' opened with your access token — are open at
  once (*Connections that stay open*).
- A request to an app's address has at most **eight** of its `omos_session` cookie values checked
  as access tokens, so a `Cookie` header stuffed with token-shaped values cannot buy unbounded
  work per request on a daemon running as root. A browser holds a handful at most.

### Backups and restores from outside

- **A restore started from outside goes ahead only if the backup keeps your way back in.** That
  is decided once the backup has been unpacked and checked for safety, and **before** any app is
  paused or any file replaced. In the backup, remote access and *Manage OpenMasjidOS from
  outside* must both be switched on — judged by the very rule this box applies to itself, not a
  copy of it. The backup must also have the same tunnel token, an admin account with the same password,
  and the same authenticator app. "The same password" means the same stored hash, so a password
  changed since the backup was taken counts as different, even if it was set to the same words.
  "The same authenticator app" means the same secret, and both this box and the backup must have
  one: a setup whose only second factor is emailed codes cannot be restored from outside, because
  whether restored emailed codes would reach anyone depends on the address and mail account in
  the backup, and nobody outside could repair a wrong guess. Otherwise the restore stops, says
  why, and changes nothing; restore it at the masjid instead. This matters because a restore
  replaces all of your settings and signs everyone out when OpenMasjidOS restarts, so from
  outside you have to be able to sign back in with what the backup brings. A backup with no
  settings in it is never refused on these grounds, and at the masjid restores work exactly as
  before.
- **A restore brings back the backup's own backup codes**, as they stood when it was made —
  including any used or replaced since. If you replaced your backup codes because someone else
  had seen them, replace them again after restoring. That is as true at the masjid as from
  outside.
- **From the moment a restore starts putting things back — once your apps are paused — until
  it ends, the second factor is held as it was then**, so restoring from outside does not sign
  you out half-way just because the backup carries an older second-factor epoch; a sign-in
  completed during the restore is judged by the held one too. **When the backup's settings are
  put in place, the second factor gets a new epoch**, so once the restore is over no session
  counts from outside except the one that did the restore, which is moved onto the new epoch —
  not even one you had shut out since the backup was taken, which the backup's own epoch would
  otherwise have let back in. The restoring session is moved only if it still counts at that
  moment: one that was signed out, or shut out by a new password, while the restore ran stays
  out. **For the whole of a restore, from the moment it starts until OpenMasjidOS has been
  replaced, two-step sign-in cannot be changed at all** — nor can almost anything else (*While
  a restore runs*, below): setting up a phone, new backup codes, allowing or stopping emailed
  codes and turning it off are each refused before any code is used, with "A backup is being
  restored right now. Please try this again once it has finished." (or, once the restore has
  finished and OpenMasjidOS is restarting, "OpenMasjidOS is restarting to finish restoring your
  backup. Please try again in a minute or two. Nothing was changed."). Before the backup's
  settings go in, a change would simply be overwritten by them; while the hold stands, it would
  only have counted once the restore let go, and would then have signed out, from outside, the
  very admin who made it. Signing in still works. And a restore that puts settings or apps back
  signs everyone out anyway the next time OpenMasjidOS starts, which for one that completes is
  straight away.
- **A restore brings OpenMasjidOS back on exactly the build it is running.** Before it restarts,
  it tags the running build's image with that build's own version and points OpenMasjidOS's
  compose file (`/opt/openmasjid/docker-compose.yml`) at that tag. It used to restart onto the
  update channel's moving tag (`:latest` or `:dev`), which names whatever build was last
  downloaded under it — by the installer, or by a dashboard update that moved channels while
  the new channel's version could not be read; every other dashboard update pulls an exact
  version — and from outside that could be a build with no remote dashboard at all, shutting
  you out of the very address the restore check had just protected. Nor could the compose file
  be trusted to name the running build: an
  update whose last step failed had already pointed it at the new version, and the installer's
  *Update* wrote it before downloading. Both are fixed at the source as well — a failed update
  puts the file back, and *Update* downloads first. A compose file pinned to an exact image
  digest is left as you set it.
- **The restore window says how it ended**, with the reason above it: *Nothing was changed*
  when the restore stopped before replacing anything — refused, already running, an update
  under way (*Updates from outside*, below), a bad file, or a backup with nothing in it to
  restore (found now before any app is stopped; it used to stop every app and leave them
  stopped); *The restore stopped before it could finish* when it failed part-way (an unexpected
  error is reported this way even if it struck before anything was changed — the cautious
  reading); *Your backup was restored, but OpenMasjidOS couldn't restart itself to finish* when
  everything was put back but the restart could not begin — restarting the machine finishes it,
  or the installer's *Repair*; *some of your apps or their data need attention* when the rest
  was restored but some app's data could not be put back, some app did not start (one held for
  review, say), or some app could not be paused first, so its data went back underneath it —
  the dashboard names those apps again after you next sign in, until you say you have checked
  them. Otherwise it waits for OpenMasjidOS to come back, and says so after about 30 seconds if
  it has not seen a restart yet. A window that could not reach OpenMasjidOS at all says nothing
  was changed.
- **The restore window says *Restore complete.* only on evidence.** It counts OpenMasjidOS as
  having gone down only once two checks in a row have failed, so one lost answer on a busy
  network is not taken for the restart: a window that took one for it said *Restore complete.*
  while the old OpenMasjidOS was still running. And it says the restore went well only if the
  restore itself said so before OpenMasjidOS restarted. If the window lost its connection
  before the restore said how it ended — a laptop that slept, the Wi-Fi — a restart seen
  afterwards proves nothing about the restore, so it says instead: "OpenMasjidOS has restarted,
  but this window lost touch with the restore before it said how it went. Please reload, sign in
  again and check that your apps and settings look right." It used to say *Restore complete.*
- **Restoring onto a new box** (a first-run restore) is refused from outside altogether, and so
  is first-run setup.
- **A backup downloaded from outside starts at once.** Making a backup copies every app's data
  before the file begins, and Cloudflare gives up on an address that has not started answering
  within 100 seconds — so from outside the download's headers go first, and the file follows.
  If the backup then fails, the download is broken off — as it is at the masjid (*Off-site
  backups*, below) — so the browser reports a failed download instead of saving a partial file
  you might trust. If the browser leaves first — the download cancelled, or the connection
  dropped — the backup is abandoned: app data already being copied is finished first, then
  nothing more is made, so it never blocks the next one, the nightly off-site backup included.
  Cloudflare also drops a connection that stays silent for about 100 seconds, so on a very
  large install a download from outside can still fail while the app data is being copied:
  download it at the masjid, or rely on off-site backups.

### Updates from outside

- **From outside, the dashboard will not move OpenMasjidOS to a version that cannot be managed
  from outside.** The first version with everything managing from outside needs is
  `0.51.2-dev.16`, and every Stable release before `0.51.2` has no remote dashboard at all:
  moving the box onto one from outside would cut off every window out there until someone at
  the masjid moved it on again. So from the remote dashboard, updating OpenMasjidOS and
  switching the update channel each check first which version they would end up on, and
  refuse, changing nothing, when it is older than `0.51.2-dev.16` — or when it cannot be
  checked, since nobody outside could put a wrong guess right. The channel switch itself is
  refused, not only the update it leads to: refusing only the update would have let your apps
  move to the other channel while OpenMasjidOS could not follow. At the masjid both work
  exactly as before. (A root terminal, behind its own switch, can still do anything, this
  included.)
- **An OpenMasjidOS update, a restore and an app's update never run at the same time** — at the
  masjid as from outside. An OpenMasjidOS update and a restore each end by replacing
  OpenMasjidOS, and a restore stops every app and puts its data back: pressed a moment into a
  restore, an update used to replace OpenMasjidOS while the restore was still putting app data
  back, leaving every app stopped and a database half restored. Now whichever is asked for
  second is refused before it starts, saying what is in the way and that nothing was changed.
  Two different apps can still be updated together.
- **An OpenMasjidOS update or a restore counts as running until OpenMasjidOS has actually been
  replaced**, not only until it hands that job to the helper that replaces it. The old
  OpenMasjidOS goes on running for some seconds after that hand-off, and work accepted in the
  gap was cut off part-way when the replacement arrived: an adversarial review started a
  restore there that was left with one app's data half put back and every app stopped, and
  pressing Update again started yet another replacement. Anything refused in that gap is told
  so: "OpenMasjidOS is restarting to finish an update. Please try again in a minute or two.
  Nothing was changed." — or "… to finish restoring your backup. …" (Pressing Update again
  then is not an error: its window waits for the restart that is already coming.) If
  OpenMasjidOS is never replaced — the restart itself failed — this lapses on its own after
  five minutes, so a failed restart does not keep everything refused.
- **Every progress window says how its work ended**, at the masjid as from outside. When
  nothing was changed — already up to date, the newest version could not be checked, a download
  that failed, a refusal — the window says so straight away. The OpenMasjidOS update says it
  worked only once it has seen the new version answer, or OpenMasjidOS go down and come back —
  two checks in a row failing, not one lost answer; otherwise it says it has not restarted yet,
  and if OpenMasjidOS comes back still on the old version, it says so about half a minute later
  rather than waiting the full three minutes. An app's update says whether the app was updated,
  left as it was, or updated but not staying running. The OpenMasjidOS update used to wait
  minutes for a restart that was not coming and then say it had been applied, and an app's
  update said the app was up to date whatever had happened.
- **An OpenMasjidOS pinned to one exact build** — an image digest (`@sha256:…`) on its line in
  `/opt/openmasjid/docker-compose.yml`, which OpenMasjidOS never writes there itself — **is not
  updated from the dashboard.** It says "OpenMasjidOS is pinned to one exact build on this
  machine, so it can't update itself from here. Nothing was changed." Before, every press
  downloaded and restarted onto the same pinned build, for nothing. The update notice and the
  update alert still offer the newer version on such a box: to take it, change the pin
  yourself, or run the installer's *Update* with `--channel=main` or `--channel=dev`, which
  replaces it.

### Emailed codes are bound to where they go

An emailed code proves "this person can read the masjid admin's mail" only while it is sent to
the masjid admin's mail. Changing the admin's address (Settings → Account) or the mail account
codes are sent through (Settings → Email) needs only a signed-in session — on the masjid's
network, a password-only one — so without a binding, that session could quietly send the next
sign-in code somewhere else, and the factor would no longer mean what you switched on. (The
binding is not what keeps a dashboard session at the masjid from managing from outside — see
*Honest limits*.)

So emailed codes are bound to the admin's address and to the mail account: the provider, plus
the SMTP host, port, TLS setting and user, or a hash of the Resend key. Not the From address,
which changes what a recipient sees rather than who can read the mail, and not the SMTP
password, since rotating it keeps the same mailbox. Changing either **pauses** emailed codes —
none are sent or accepted, and the two-step panel in Settings → Account says so (or, if the mail
account or your address is gone, asks for that first) — and turning them back on takes your
password and a code from your authenticator app (or a backup code).
Emailed codes can be switched on only alongside an authenticator app — Settings offers them only
then, and the server refuses them otherwise — so pausing them never leaves you without a second
factor. Emailed codes that were switched on before the binding existed were bound, at the first
start of the version that added it, to wherever they were going then.

### Honest limits

- **Your apps share one origin with each other, and with the dashboard.** Through the tunnel
  every app is at `https://<apps' address>/<path>/` and the dashboard at its root, so the
  separation is weaker than on the masjid's network, where each has a port of its own. A
  malicious app's page could act within another app you have opened from outside — with your
  access to that app — and read whatever other apps keep in the browser there. Against the
  dashboard it has no key (*One address, and the key that keeps apps out*), so it cannot change
  anything there, but in the same browser it can:
  - sign the dashboard out, or make wrong sign-in attempts that lock your connection out of
    signing in from outside for fifteen minutes — a nuisance, not a way in;
  - change how the dashboard looks in that browser (theme, wallpaper, pinned apps), which is
    kept in the browser;
  - show a fake sign-in page at the same address. The real one is only ever at the address
    itself with nothing after it — never under an app's path.
  That boundary rests on two things browsers do (say which loads are their own, and cut a page
  off from a window with a different opener policy) rather than on the origin, the browser's
  oldest rule. Install only apps you trust, as always.
- **Safari before 16.4** does not say which loads are its own, so from outside it is never
  given the key with the page, and asks for the password and code again after every reload.
- **An app's WebSocket handshake reply is passed back unfiltered**, so an app could set a cookie
  there that the filtering above would have dropped — enough to sign you out of another app at
  your apps' address. It cannot make a planted value count as a sign-in, because only a valid
  access token is ever passed on to an app.
- **A background worker installed under an earlier version may outlive the fix.** Earlier
  versions also let an app install a worker over the whole apps' address from under its own
  path, by sending a `Service-Worker-Allowed` header. The platform removes that header now, so
  a browser's checks for an update to such a worker fail — and a browser keeps a worker whose
  update fails. It stays in the browsers that met it, able to act within your apps there — and,
  now that the dashboard shares the address, to see the dashboard's pages load, the key in them
  included, and so act as you there. **If an app you do not trust was ever opened through your
  apps' address in a browser, clear that browser's stored data for the address before managing
  from outside in it.**
- **On the masjid's network, a session is bound to the password alone.** Changing the second
  factor decides what counts *from outside*; it does not end a session at the masjid, where
  signing in has never needed the second factor. A session shut out from outside that way would
  still be accepted if it were ever presented on the masjid's network. To end every session
  everywhere, change the password.
- **A reverse proxy of your own** on the masjid's network that sends `X-Forwarded-Proto: https`
  is treated as the tunnel by the sign-in rules: signing in through it asks for the second
  factor, and a sign-in made on the network directly does not count through it. Pointed at the
  front door (port 80), it meets the same gate as the tunnel, so the dashboard is not served
  through it at all unless remote administration is open. Pointed at the dashboard's own port,
  nothing hands its requests over, so the dashboard behaves there as it does at the masjid: apps
  open at their own ports, the tunnel token can be changed, and neither a restore nor an update is held
  to the from-outside checks — and a sign-in made through it counts there and nowhere else:
  never on the remote dashboard, and never to open an app from outside (*Signing in from
  outside*). (It once answered "from outside" there, which sent every *Open* button down the
  from-outside path, where it was refused — at the masjid, for every app.)
- **Cloudflare limits uploads** (100 MB on its free plan), so a large restore, or a large file
  upload, has to be done at the masjid. From outside, the dashboard says so before it tries,
  and recognises Cloudflare's own refusal if one comes back.
- **An app has to work under a path** (`/<path>/`) to work from outside. Every OpenMasjid app
  does; a community or custom app may not.
- **Emailed codes as the only factor** — which Settings never offers and the server now
  refuses, but an older setup might hold — are paused by a change of address or mail account
  like any others. That leaves no second factor, so the door shuts. Emailed codes can now be
  switched back on only once an authenticator app is set up, which has to be done at the masjid.
  Such a setup also cannot be restored from outside (*Backups and restores from outside*).
- **The second factor guards the tunnel, not a machine the internet can reach directly.** A
  request that arrives without coming through Cloudflare looks like the masjid's network and is
  asked for the password alone — see *What "LAN-only" means, exactly*.
- **Two-step sign-in does not protect against someone already signed in at the masjid.** A
  dashboard session there — password only — can download a backup, which holds your
  authenticator app's secret along with every other one (*Off-site backups*), or restore one,
  which replaces two-step sign-in with the rest of your settings and asks for no code. What the
  second factor protects is managing from outside against someone who knows the password but
  cannot reach the masjid's network.

### If you used remote administration on an earlier Development build

On `0.51.2-dev.13` to `dev.15` the dashboard was at the root of your apps' address, where it is
again; after updating, sign in there once more — a sign-in made on those builds does not count as
one made from outside on this one. (Those builds cannot start an update from the remote
dashboard, so the update itself is run at the masjid or with the installer on the box.) On
`dev.16` it was at a second address of its own; it is now at your apps' address, and goes on
answering at the second one for as long as Cloudflare sends it there. Sign in once at your apps'
address, then remove the second hostname in Cloudflare when it suits you.

## App compose consent gate

Before any app's `docker-compose.yml` runs, it is parsed and risk-checked
(`packages/core/src/apps/compose-validate.ts`): privileged mode, host namespaces
(`network_mode`/`pid`/`ipc`/`userns_mode`/`cgroup`/`uts: host` **and**
`container:`/`service:` joins), Docker-socket / sensitive host bind mounts (incl.
`..` escapes and `local`-driver named-volume binds), `cap_add`, `devices`,
`security_opt: …unconfined`, `group_add` of root/docker, `extends`/`include`, and
`build:` contexts. Variables (`${VAR}`) in security-sensitive fields fail closed.
The check also flags `volumes_from` (which can inherit the core's own mounts),
`env_file` pointing outside the app's own directory, and top-level
`secrets:`/`configs:` with a host `file:` source.

The result has **two** classes, and the difference matters:

- **Dangers** — catalog and community installs are hard-blocked on any of them; the
  opt-in 3rd-party (custom) installer allows one through only with an explicit
  "I understand the risk" acknowledgement.
- **Refusals** — **never acknowledgeable, on any path.** Currently: a top-level volume
  that uses `external:` or `name:` to attach to an `omos-*` volume, i.e. **another app's
  data or the platform's own**. There is no "I understand the risk" for these, because
  there is no legitimate reason for one app to mount another's database.

The gate runs on install (catalog, community and custom), on **update** — a refreshed
catalog entry is fresh external data — and on a **restore**, since a backup file is
externally craftable. A restore puts the backup's apps on disk *before* the gate can see
them, so what makes that check hold is that its verdict is **kept** with the app: one that
fails is not started, and **Start** and **Restart** go on refusing it afterwards. A danger
can then be acknowledged on the dashboard ("I understand the risk"); a refusal never can;
and WhatsApp's `!os start` and `!os restart` cannot acknowledge anything. Each app the backup
brings is checked **the moment it is on disk**, before any app data goes back, so the
verdict kept with it is this box's own from then on — not whatever the backup said about it,
which a crafted backup simply leaves out — even if the restore never gets as far as starting
the apps; and no app can be started at all while the restore runs (*While a restore runs*,
below). The check used to come only at the restore's last step, so until then a restored app
carried the backup's verdict. (This page used to call the Start button a known gap, contained
because "every path that writes that file is gated". It was not contained: restore writes
the file before checking it, and the verdict used to be forgotten the moment the restore
finished — leaving an ordinary Start button in front of whatever the backup carried.) One
residual: an app restored by an older version of OpenMasjidOS carries no verdict, and stays
startable until the next restore reviews it. The File Explorer refuses to edit `compose.yml`
at all.

## Reaching the platform from an app

Apps talk to the platform over `/api/fabric/*` on the LAN only; those routes are refused
if the request arrived through the Cloudflare tunnel. Each app is issued its own secret
and is authorised by what its manifest declares. Through the tunnel an app never receives
your sign-in — at most, once you have opened it from the remote dashboard, an access token
that opens that one app (see *Opening apps from outside*).

**One exception you should know about if you run more than one Stripe account.** An app
holding the `stripe` capability can read **any** configured Stripe account's keys, not
only the one it was set up with — accounts are not yet bound to apps. So if you keep a
separate Stripe account for, say, school fees and general donations, treat every
Stripe-capable app you install as having access to both. This is not fixed yet. The
planned fix is on the platform's side alone — you would choose which account each app may
use, and the apps would go on asking exactly as they do now — so it needs no change to the
apps (this page used to say it did). What is still to be decided is what an app with no
account chosen gets, because the wrong default would take a live donations page down.


## Off-site backups (scheduled)

Settings → **Off-site backups** uploads the platform backup (the same gzipped tar
as the manual download: `config/` + `apps/` **plus each app's Docker volume** under
`volumes/<name>.tar.gz`, so the apps' real data — SQLite dbs, uploads — is captured
too) to Google Drive or a NAS on a schedule, via bundled `rclone`. Volume contents
are copied in/out with a throwaway `tar` container; restore recreates the volumes
before starting the apps.

- **Credentials never leave the host.** The destination's secret (NAS password,
  SFTP private key, or Google Drive token) is written only to `rclone.conf` (and
  an optional key file) under the data dir, `chmod 600`. Passwords are stored in
  rclone's obscured form, not plaintext. `settings.json` and the `backups.status`
  API hold only non-secret metadata (kind, label, remote path, schedule, last-run
  status) — a secret is never returned to the browser, even to the admin.
- The **outer archive is streamed** straight to the remote (`rclone rcat`) and is
  never written to local disk.
- Each app's Docker volume **is** staged first, though, as
  `.backup-staging/volumes/<name>.tar.gz` under the data dir: a volume's contents
  have to be pulled out through a throwaway `tar` container before they can be
  folded into the archive. So a backup needs free space of roughly the size of your
  largest app's data, not zero. (This page said backups were never staged on disk
  and so could not fill a small box — that was wrong, and running out of space
  here is a real failure mode the code explicitly handles.)
- A backup that cannot capture everything **fails** rather than uploading a
  silently incomplete archive: a volume that won't archive fails the whole run, its
  partial file is deleted, and nothing is recorded as successful or pruned until
  both the archive and the upload have succeeded. Old backups are never pruned on
  the strength of a run that didn't verify.
- **A backup you download from the dashboard is held to the same rule**, at the
  masjid and from outside: the download ends cleanly only once `tar` has reported
  that the backup succeeded, and is otherwise broken off, so the browser reports a
  failed download. `tar` finishes writing its output before it reports how it went,
  and a download that simply ended with the output used to arrive complete-looking
  for a backup that had failed — the log said "Backup failed", and you found out at
  the restore.
- **Known limitation:** volumes are archived while the apps are running, so a
  database being written to at that moment can be captured mid-write. The archive
  will restore, but such a database may not open. The real fix is app-side
  (snapshotting before the backup); don't read `ok: true` as proof every database
  inside will open.
- **The archive is not encrypted.** It contains the platform's secrets — the admin
  password's hash, your authenticator app's secret, the tunnel token, the Stripe
  keys, and the credential for the backup destination itself — so the destination
  must be treated as trusted. Prefer one that encrypts at rest. With remote
  administration on, that means whoever holds a backup holds your second factor, and
  is one password away from managing the box from outside. (Sign-in sessions are the
  one thing every backup leaves out.)
- Retention prunes the remote to the newest N backups (default 7).
- Backups capture data **as-is**; if an app stores its own secrets (e.g. Stripe
  keys) in its data dir, those travel inside the tar too — one more reason the
  destination has to be a trusted one (see the encryption note above).

## While a restore runs

A restore pauses every app, puts the backup's settings, apps and app data in place of
yours, starts the apps again and restarts OpenMasjidOS — at the masjid, or from outside if
the backup passes the check in *Backups and restores from outside*. Until OpenMasjidOS has
been replaced, nothing else is allowed to move underneath it:

- **No OpenMasjidOS update, app update or second restore** — see *Updates from outside*,
  which also says why the claim lasts until OpenMasjidOS has been replaced, and why it
  lapses after five minutes if that never happens.
- **No app is started, restarted, installed or removed** — not from the dashboard (where it is
  one of the changes refused below), and not by anything else: `!os start` and `!os restart`
  over WhatsApp are answered "A backup is being restored right now. Your apps will start again
  on their own when it has finished. Nothing was changed.", and a restart OpenMasjidOS would
  make of its own accord (after the machine's address changes, below) waits too. There are two
  reasons. The restore is replacing every app's data, and an app started meanwhile runs
  over a database half put back: an adversarial review had an app started before its data had
  finished going back. And a backup is a file anyone can craft: an app that comes in with one
  has not yet been through the consent gate (*App compose consent gate*), so starting it then
  could have run, say, a `privileged: true` container — root on the host — that nobody agreed
  to, from WhatsApp included, which can never agree to one. **Stopping an app is never
  refused.** The same refusals apply to one app while that app is being updated, because a
  Start in the middle of it brought up a version the update might still put back; and while
  OpenMasjidOS itself is being updated, installing or removing an app is refused, because the
  update would cut it off part-way — starting one is not.
- **Nothing is changed from the dashboard.** Every change made while signed in — a password,
  a setting, switching remote administration off, the masjid logo, two-step sign-in — is
  refused with "A backup is being restored right now. Please try this again once it has
  finished." Looking still works, and so do signing in and signing out, turning an app off
  (stopping always works, and is what the restore does to every app anyway) and, from
  outside, opening an app (that only hands your browser a one-use link). A restore replaces
  all of your settings at once, and a change made during one used to be accepted and then
  silently undone: in an adversarial review, a password changed and remote administration
  switched off while a restore ran came back after the restart as the old password, with
  remote administration on. Make the change once the restore has finished. Not held back: the
  File Explorer's own changes to your files (the platform's settings, and the files
  OpenMasjidOS keeps for each app, are out of its reach anyway). A backup cannot be made while
  a restore runs — it would copy data half put back and still say it worked — and a restore
  waits for a backup being made: *"A backup is being made right now. Please restore once it
  has finished. Nothing was changed."*
- **Once the restore has finished and OpenMasjidOS is restarting**, every refusal above says
  so instead: "OpenMasjidOS is restarting to finish restoring your backup. Please try again in
  a minute or two. Nothing was changed." In the seconds after an OpenMasjidOS update hands
  over its restart, what is refused then — a restore, another update, an app's update, and
  installing or removing an app — is told "OpenMasjidOS is restarting to finish an update." in
  the same way.
- **The restored settings are in use at once.** OpenMasjidOS kept its own copy of its settings
  from when it started, and anything written after the swap — a theme change, the result of a
  scheduled backup — put that whole copy back over the backup's: a review changed the theme
  while restoring a backup in which the root terminal was switched off, and the root terminal
  came back on. The backup's settings, mail, payment, WhatsApp and command settings are now
  read again the moment they are in place.
- **Alerts, scheduled backups and address changes stand aside.** The restore pauses every app
  on purpose, and the "has stopped" alert used to fire for each one, telling you to press Start
  over data still being put back; no such alert is sent while a restore runs. The scheduled
  off-site backup waits for its next check, a quarter of an hour later, rather than copy data
  half put back — and does the same while OpenMasjidOS is being updated. And if the machine's
  address changes, OpenMasjidOS waits until the restore is over before it updates your apps
  with the new one, since what it would write then lands among files the restore is about to
  replace.
- **An app that could not be paused is reported.** If Docker will not stop an app, its data is
  put back underneath it while it runs. The restore window shows "<name> (couldn't pause it —
  its data may not restore cleanly)", the restore ends as needing attention, and after you next
  sign in the dashboard says "These apps couldn't be paused for the restore, so their data may
  not have been put back cleanly: … Please check them." Before, Docker's refusal went unnoticed
  and the app was listed as paused.
- **A backup uploaded for restoring does not linger.** It holds a whole backup, unencrypted —
  every password hash, key and token, perhaps another box's — and so does the folder it is
  unpacked into. A restore refused because an update was in its way used to leave the uploaded
  file in the data folder; it is removed now, as it is when a restore is refused while
  OpenMasjidOS is restarting to finish one, and while an update is in the way the upload is
  refused before the file is stored at all. If a restore never finishes — the power goes, say
  — both are deleted the next time OpenMasjidOS starts, and its log says "Removed
  .restore.tar.gz left behind by a restore that did not finish." Until then the File Explorer
  keeps both private: "This is a backup being restored, so it is kept private. It is removed
  when the restore finishes." A file uploaded and then never restored — the window closed in
  between — stays until the next restore or the next time OpenMasjidOS starts.

## Reporting

OpenMasjidOS is licensed **AGPL-3.0-only** ([`LICENSE`](../LICENSE)); the dashboard
links to its source (Settings → Advanced) per AGPL §13. To report a vulnerability,
open a security advisory on the repository.
