<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# What's new in OpenMasjidOS

Newest first. The dashboard reads this file (Settings → Advanced → **What's new**),
so keep the wording plain and friendly — a masjid volunteer is the reader, not a
sysadmin. One `## <version>` heading per release, then short bullets.

## Unreleased

> This section exists only on `dev` and is the full working record — fixes, internals, CI,
> docs, dependencies. At release time it is rewritten into a `## X.Y.Z` section holding only
> what a masjid would notice (CLAUDE.md §18).

### Managing OpenMasjidOS from outside the masjid

Manage OpenMasjidOS from anywhere, over the same secure Cloudflare tunnel your shared apps
already use. **Off by default.** Turn it on in **Settings → Remote access**, once two-step
sign-in is set up.

- **From outside, your dashboard is at your apps' address** — for example `omos.example.org`,
  with nothing after it, while each app stays at its own path such as `omos.example.org/donate/`.
  Nothing more to set up in Cloudflare: the one hostname remote access already uses is enough.
  The **Manage OpenMasjidOS from outside** switch tells you if anything is still missing.
  - **Why your apps can't use the dashboard as you:** your browser treats everything at one web
    address as one site, so an app page there sits right beside the dashboard. Every change the
    dashboard makes needs a key, and from outside the dashboard keeps that key only in the open
    tab, hands it only to its own page when your browser loads it, and cuts off any window an app
    page opens on it. At the masjid nothing changes: each app has its own port number there.
  - **On an iPhone, iPad or Mac with Safari older than 16.4**, the dashboard asks you to sign in
    again each time you reload it from outside. Newer browsers stay signed in.
  - **Development build 16 asked for a second address just for the dashboard.** That is no longer
    needed: after updating, the dashboard is at your apps' address, and keeps working at the second
    one too while Cloudflare still sends it there. Sign in once at your apps' address, then remove
    the second hostname in Cloudflare whenever it suits you.
- **With two-step sign-in set up, almost everything works from outside**, not just the dashboard's
  pages (the few exceptions are listed further down):
  - **Opening an app.** Press Open as usual: the app opens in a new tab at your apps' address, and
    apps that sign you in through OpenMasjidOS still do. If an app can't be opened, the dashboard
    says so.
  - **Apps you haven't shared online open too — for you alone.** Each Open uses a link that works
    once, within a minute; after that the app stays open in that browser only while you're signed
    in from outside. For anyone else there is no page at its address.
  - **Files, terminals, backups, restoring a backup, updating OpenMasjidOS and your apps**, and
    changing the masjid logo.
- **It will not switch on without two-step sign-in**, and if you ever remove two-step sign-in the
  dashboard closes itself to the internet again. A password on its own is not enough to put a
  masjid's server on the internet, and the screen tells you if the two ever disagree rather than
  quietly claiming to be on.
- **Signing in from outside always needs a two-step code as well as your password**, and a sign-in
  made at the masjid can't be used from outside. Anything you have open from outside closes within
  seconds when you sign out, change your password or switch remote management off — a terminal
  included, and the live connection of any app you opened from there, right through to the app.
  Only something already being sent to you, such as a download, can still finish. Changing
  two-step sign-in (a new phone, new backup codes) signs out every other sign-in from outside, but
  not the one you made the change from, so you can still write the new codes down.
- **Too many wrong sign-ins from one place lock that place out** for a while. This only works from
  outside, where we can tell one visitor from another — and it can never lock you out from
  somewhere else, which is exactly why it is safe to switch on here and not on your own network.
- **From outside, switching off anything that would cut you off asks first.** Turning remote
  access off, turning **Manage OpenMasjidOS from outside** off, or removing the tunnel ends the
  very connection you are using, and only someone at the masjid can turn it back on — so from
  outside each one asks before it happens. At the masjid they stay one click. Turning two-step
  sign-in off from outside says the same, and points you at **Use a different phone** if you are
  only changing phones, which keeps you signed in. And when switching remote access off or
  removing the tunnel takes the connection down before its answer gets back, the window says the
  change was made instead of showing an error.
- **From outside, the dashboard won't move OpenMasjidOS to a version that can't be managed from
  outside.** For now that means Stable, which doesn't have remote management yet: switching back
  to Stable from outside is refused and nothing is changed — make that switch at the masjid. If
  the dashboard can't find out which version a switch would bring, it changes nothing and asks
  you to try again later. Once a Stable release has remote management, the switch works from
  outside too. An update started from outside checks the same thing before it downloads anything.
- **Restoring a backup from outside only goes ahead if it keeps your way back in** — the same
  password, the same authenticator app and the same remote-access settings you use now. If it
  doesn't, nothing is changed: restore it at the masjid instead. That includes every backup made
  before you switched on managing from outside.
- **The restore window now says how a restore ended**, at the masjid as well as from outside. One
  that was refused, turned out to be empty or couldn't connect at all says straight away that
  nothing was changed; before, it waited four minutes and then said "Restore complete." One that
  finished but couldn't pause some apps first, couldn't put back some app data, or couldn't start
  some apps afterwards says so — the messages above it say which — and **the dashboard reminds you
  which apps need a look** after you sign in again, until you tell it you have checked them. One
  that put everything back but couldn't restart OpenMasjidOS says so, and that restarting the
  machine finishes it. If the dashboard hasn't restarted after about half a minute, the window says
  so and suggests reloading, instead of looking certain. If the window lost touch with the restore
  before hearing how it went, it says exactly that once OpenMasjidOS is back, and asks you to check
  your apps and settings, instead of "Restore complete." And a moment's hiccup in the connection is
  no longer taken for the restart.
- **The update window now says how an update ended**, at the masjid as well as from outside. When
  nothing was changed — already up to date, a download that failed, an update refused from outside,
  a newest version that couldn't be checked (which it used to call "already up to date"), a machine
  pinned to one exact build, or a window that couldn't connect at all — it says so straight away and
  lets you close it. It says the update worked only once it has seen OpenMasjidOS come back, and a
  moment's hiccup in the connection no longer counts as that: if no restart shows after about half a
  minute it says so and suggests reloading, and if OpenMasjidOS came back on the old version it says
  so about half a minute later, rather than keeping the window shut. Before, it said it was
  restarting, wouldn't close for three minutes, and then said "Update applied." whatever had
  happened.
- **Updating an app now says what really happened**, and so do **Update all apps** and the window
  that moves your apps between Stable and Development. An app update that was refused, couldn't
  download, or was put back after failing to start says "Nothing was changed"; one that updated but
  won't stay running says so; the totals count only the apps that really were updated or moved
  ("3 of 4 apps updated…"); and the channel window says when OpenMasjidOS itself was not changed.
  Before, every app was reported as updated, whatever had happened. The WhatsApp reply to
  `!os update` no longer claims an update that didn't happen, either.
- **An update and a restore can no longer run at the same time**, at the masjid as well as from
  outside, and no app can be updated during either. Whichever is started second is turned away with
  a message saying what is in the way, and nothing is changed. That now lasts until OpenMasjidOS has
  actually restarted, not just until it starts to: in the minute or so in between you are told
  "OpenMasjidOS is restarting to finish an update. Please try again in a minute or two." (or "…to
  finish restoring your backup…"). Before, pressing Update during a restore could restart
  OpenMasjidOS while your app data was still being put back, leaving every app switched off.
- **While a backup is being restored, nothing can be changed.** Settings, passwords, the logo and
  starting, installing or removing an app all wait (turning one off still works), with "A backup
  is being restored right now. Please try this again once it has finished." (and, while
  OpenMasjidOS restarts at the end,
  "OpenMasjidOS is restarting to finish restoring your backup. Please try again in a minute or
  two."). Looking around still works. The restore starts your apps again itself when it has
  finished. Before, a change made during a restore was quietly undone by it (an old password could
  work again afterwards), and an app started part-way ran over data still being put back. The alert
  that an app "has stopped" and the off-site backup wait too, while a restore has your apps paused.
- **A backup and a restore no longer run at the same time.** A backup asked for during a restore
  says "A backup is being restored right now. Please make a backup once it has finished.", and a
  restore asked for while a backup is being made says "A backup is being made right now. Please
  restore once it has finished. Nothing was changed." Before, a backup taken during a restore
  copied your data half put back and still said it had worked.
- **A restore turned away because OpenMasjidOS is being updated** says so straight away —
  "OpenMasjidOS is being updated right now. Please restore your backup once it has finished.
  Nothing was changed." — and a backup file it had already received is deleted, not left on the
  server holding every password and key in it. One left behind by a restore that never finished,
  after a power cut say, is removed the next time OpenMasjidOS starts, and **Files** keeps it
  private meanwhile.
- **Restoring a backup changes less behind your back**, at the masjid as well as from outside. A
  backup with nothing in it to restore no longer switches every app off first and leaves them off.
  And a restore now brings OpenMasjidOS back on the version you are running. It used to go back to
  whichever version the installer had last downloaded, which was usually older — and if that one
  had no remote management, a restore made from outside would have locked you out.
- **Downloading a backup from outside starts straight away**, and the file follows once the backup
  is made — Cloudflare gives up on a page that takes more than 100 seconds to start.
- **A backup that fails part-way now shows as a failed download**, at the masjid as well as from
  outside. Before, it could arrive as a file that looked complete but was missing data, and you
  would only have found out when you tried to restore it.
- **Two apps can no longer share an address.** Settings → Remote access refuses an address another
  app already uses, or one OpenMasjidOS keeps for itself (`/api`, `/trpc`, `/assets`, and the
  dashboard's own pages such as `/settings` and `/files`). Installing
  an app whose name another app's address already uses gives the new one the next free address
  (`donations-2`, say), which you can change there once that app is shared online. Before, the
  later app quietly took the address over, which could take a shared app's public page offline.
- **Pasting the tunnel token is safer**, at the masjid too. Paste Cloudflare's whole install command
  and the token is picked out of it; a token copied without the "=" signs at its end, which a
  double-click leaves behind, is put right; paste something that isn't a whole token and you are
  told so, with nothing changed. Before, a half-copied token was saved anyway and took every shared
  app offline while Settings still said the tunnel was running. And a tunnel that is switched on but
  not connecting — one that keeps restarting, say — is no longer called running or turned off:
  Settings says "Tunnel is turned on but isn't connecting. Check that the tunnel token is the right
  one."
- **A terminal opened from outside no longer closes itself in a pause.** Cloudflare drops a
  connection that carries nothing for about 100 seconds, so a terminal left at a prompt or in an
  editor was cut off, and an update's progress could drop in a quiet stretch. The dashboard now
  keeps its connections alive.
- **Still needs you at the masjid:** replacing the tunnel token (a mistake, made from outside,
  would cut you off); uploading a file or restoring a
  backup larger than 100 MB (Cloudflare's free plan refuses anything bigger, and the dashboard now
  says so before it starts); restoring a backup that would change how you get in; switching back
  to Stable, for now (above); apps from outside the OpenMasjidOS store that can't run under a
  sub-address; and OpenWA's own screen (everything WhatsApp needs is in Settings). On a very large
  install a backup download from outside can still be cut off while the app data is being copied,
  because Cloudflare also drops a connection that stays silent for about 100 seconds.
- **Getting in at the masjid doesn't change.** Same address, same sign-in, no extra code, and apps
  still open at their own port. The installer's Update and Repair now end by showing that address as
  `https://…`; they showed `http://…`, which only worked by being redirected.
- **Already managing a box from outside on Development build 13, 14 or 15?** Those builds put the
  dashboard at your apps' address too, but kept its key where a page from any app you had shared
  online could read it, so while you were signed in from outside that page could have used your
  dashboard as you. After this update the dashboard is still at that address and your bookmarks
  still work; the key is now kept out of every app page's reach. Sign in again once, with your
  password and a code. Those builds can't install updates from outside, so update at the masjid or
  with the installer.
- **If a browser ever opened an app you don't trust through your apps' address, clear that
  browser's saved data for the address before managing from outside in it.** Older versions let an
  app leave a background script there that could now see the dashboard too; newer versions stop
  apps leaving new ones, but cannot reach one already left behind.

### Two-step sign-in

- **You can set two-step sign-in up**, in Settings → Account. Scan the square code with an
  authenticator app on your phone — Google Authenticator, Authy, 1Password and most password
  managers all work — or type the key in by hand if there is no camera to hand.
- Ten one-time **backup codes** come with it, for the day the phone is lost or replaced. They are
  shown once and only once, so that window will not close until you have ticked that they are
  saved; there are Copy and Download buttons beside them.
- **A code emailed to you can be allowed as a backup to the authenticator app** — never instead of
  it. It needs an email provider set up and an email address on your account — the panel says
  which is missing — because a code that cannot be delivered is a lockout with extra steps.
- **Emailed codes pause if your email address or your email service changes** (Settings → Account,
  Settings → Email), until you turn them on again in Settings → Account, which asks for your
  password and a code from your authenticator app. Otherwise whoever made that change could have
  the next sign-in code sent to themselves. The two-step panel says when they are paused.
- Changing any of this asks for your password **and** a current code. That is not box-ticking: it
  is what stops someone who reaches an already-signed-in dashboard from quietly pointing two-step
  sign-in at their own phone. If two-step sign-in is changed somewhere else while you are
  confirming a change, you are asked to try again. And while a backup is being restored it can't
  be changed at all — you are asked to try again once the restore has finished. Signing in still
  works then.
- **Lost the phone *and* the backup codes?** Run the same install command again on the server and
  choose **Reset sign-in**. Along with the new password, it now asks whether to turn two-step
  sign-in off as well — only when two-step sign-in is on, and it stays on unless you say yes.
  Before, there was no simple way out of that: changing two-step sign-in needs a current code, at
  the masjid too. Managing OpenMasjidOS from outside stays off until you set two-step sign-in up
  again.
- A code can only be used once, even within the minute it is valid for.
- **On the masjid's own network you sign in exactly as before.** The extra code is only ever asked
  for from outside, so a volunteer who left their phone at home is never locked out of the
  dashboard in the building.

**Fixed, from a report on a real masjid's server:** signing in from outside could get stuck saying
*"That sign-in attempt has expired"* when it plainly had not.

- After five wrong codes the sign-in really was finished — but the screen kept offering **Sign in**,
  which could no longer work, and said the attempt had expired rather than saying why. It now takes
  you back to the password step and tells you what happened.
- A wrong code now says **how many tries you have left**, so running out is not a surprise.
- If a code keeps being refused because the **server's clock is wrong**, it says so, and by how
  much. A wrong clock and a mistyped code look identical while you are typing, and the fixes are
  opposite.

**Technical detail** for both sections above (for whoever cuts the release). dev.13–15 published
the first version; dev.16 is the redesign below, reworked after more than one adversarial review,
and supersedes it; dev.17 (next) replaced dev.16's second hostname and keeps the rest.

- **dev.17: back to one address, kept apart by the key.** At Hasan's request the dashboard is served
  at the root of the apps' hostname again, and dev.16's separate *Dashboard address* is gone
  (`settings.cloudflare.adminHost`; `adminHost()`, `isAdminHost()`, `validateAdminHost()`,
  `remoteDoorOpen()`, `doorClosedReason()`; the refusal reasons `no-admin-host`,
  `dashboard-elsewhere`, `app-on-admin-host`, leaving seven; the restore's address comparison; the
  socket sweep's hostname check). Nothing looks at the hostname now, so a box that kept dev.16's
  second hostname is served there too. `remoteAdminEnabled()` is four conditions again. What keeps
  app pages — now the dashboard's own origin — out is the KEY: the remote dashboard keeps it in
  memory only (`ui/src/lib/session.ts`, keyed on `<meta name="omos-key">`); `api/static-ui.ts`
  `registerRemoteDashboardPages` writes it into a handed-over dashboard page only for
  `Sec-Fetch-Dest: document` + `Sec-Fetch-Mode: navigate` and a live remote session, with COOP
  `same-origin`, `X-Frame-Options: DENY`, `frame-ancestors 'none'` and `no-store`; the ingress strips
  COOP from every app response; `auth.me` answers a handed-over call without the key as signed out
  (it had told any app page the admin's name, email and phone — caught in this change's own review);
  the File Explorer's inline view is `Referrer-Policy: no-referrer` (an SVG there could have sent
  its `?k=` address to an app's path — caught in the same review); and the dashboard's page
  segments (`store`, `apps`, `files`, `settings`, `design-system`) joined `RESERVED_PATH_SEGMENTS`,
  kept in step with `DASHBOARD_SEGMENTS` by `test/app-paths.test.ts`. The update window sends the
  key on its `auth.me` checks. New `test/remote-key.test.ts`. Accepted residuals, documented in
  CLAUDE.md §15 (*ONE ADDRESS*) and `docs/REMOTE_ADMIN.md`: the boundary rests on Sec-Fetch and COOP
  rather than the origin; an app page can sign the dashboard out, trip the per-address lockout,
  write its display preferences and phish at the same address; Safari before 16.4 signs in again
  after every reload; and a worker an older build let an app register over `/` now covers the
  dashboard. None of it was tried in a real browser.

- **Why the dashboard moved: the review.** dev.13–15 — and this build as first written, never
  published — served the remote dashboard at the root of the apps' hostname
  (`https://omos.example.org/`), with every app beside it at `/<path>/`. An adversarial review
  found that this made every app page the dashboard's ORIGIN: a browser draws that boundary by
  scheme + host + port, never by path. Script on any app page the admin opened, or a
  cross-site-scripting bug in any public one, could read the dashboard key from `localStorage`,
  send same-origin requests carrying the admin's cookie, pass the origin check (Origin and Host
  agreed) and drive the whole admin API — in the first cut, turn the root terminal on and open it
  (host root: the core holds the Docker socket) and download a backup (every secret). dev.13–15
  carried the same exposure through tRPC alone, from any shared app's page, and tRPC alone is
  enough for host root. On the LAN the boundary was always there (dashboard `https://<ip>`, each
  app `http://<ip>:<port>`); through the tunnel the only way to draw it is a different HOSTNAME.
- **Two hostnames.** Remote administration needs a second Cloudflare public hostname on the same
  tunnel — the Dashboard address, `settings.cloudflare.adminHost` (e.g. `admin.example.org`),
  Type HTTP, URL `localhost:80`, exactly like the apps' one. The dashboard (the SPA, `/trpc`,
  `DASHBOARD_API`, its sockets) is served over the tunnel ONLY on that hostname; asked for on any
  other — the apps' one above all — it gets the ordinary 404, recorded as `dashboard-elsewhere`.
  App content is never served on the admin hostname — shared or private, token or not, HTTP or
  WebSocket — and is recorded as `app-on-admin-host`. The apps' hostname
  (`settings.cloudflare.domain`, now labelled "Your apps' address") still serves the apps.
  Both are stored as bare hostnames (`hostnameOfDomain` + `normalizeHost`: scheme, path, port and
  trailing dots dropped, lower-cased) — the apps' address used to lose only its scheme and trailing
  slashes. `validateAdminHost` requires a dotted DNS name that is not an IP address and refuses the
  apps' hostname in any spelling; `cloudflare.save` refuses moving the apps' hostname onto the
  admin one too, and `remoteAdminEnabled()` re-checks that the two differ, so settings that make
  them equal some other way (a restore at the masjid, say) shut the door rather than share an
  origin.
- **The door.** `remoteAdminEnabled()` is `settingsOpenTheDoor(…)`, `twoFactorActive()` and
  `isConfigured()` together — five conditions, all re-read per request: the tunnel on, the switch
  on, a dashboard address that is set and differs from the apps' one, a second factor enrolled, and
  an admin that exists. `settingsOpenTheDoor` is the settings half as one pure function (strict
  `=== true`), so the restore check below asks the very same rule rather than a copy.
  `remoteAdminBlockedReason()` adds `'no-admin-host'`, which `cloudflare.setRemoteAdmin`
  refuses with PRECONDITION_FAILED; `cloudflare.status` returns `adminHost` and no longer
  `lanOnly`. `remoteDoorOpen(host)` — `remoteAdminEnabled()` and `isAdminHost(host)` — is the
  question every long-lived connection keeps asking. `doorClosedReason()` says why a shut door
  refused: `no-admin-host` when the tunnel and the switch are on, an admin exists, two-step
  sign-in is set up, and only the dashboard's own address is missing (or equal to the apps'),
  otherwise `lan-only-route`; only the record differs.
- **The front door decides and hands over; it serves no dashboard of its own.** It no longer
  registers tRPC or the UI (Fastify's 1 MB body limit there now covers only its own routes).
  `frontDoorDecision` — one pure function, called by `index.ts` and the tests — answers `pass` (no
  spelling is a dashboard path: the front door's own routes and the ingress), `lan-https` (308 to
  the HTTPS dashboard, as always), `refuse` (the door shut, `dashboard-elsewhere`, or
  `plain-http-no-host` — now reached only by a request target starting `//`, which cannot be put
  after a scheme and a host), `upgrade` (a plain-`http://` tunnel visit, 308 to the CONFIGURED
  admin hostname — the target never comes from the request, and with none configured nothing is
  served or upgraded) or `serve`. A served request is marked (`markHandedOver` — a `WeakSet` of
  Node requests, which no header can forge), hijacked, and emitted body-unread as a `request`
  event on the dashboard listener, so the remote dashboard IS the LAN dashboard: same routes,
  limits and checks. With no SPA served from the front door any more, `isDashboardPath` decides
  nothing at runtime: what is handed over is decided by `touchesDashboardPath` (ANY spelling), and
  the dashboard listener's own guards — request target, hand-over, Fabric, origin — run on it
  exactly as on LAN traffic. A dashboard socket is claimed only when `claimsDashboardSocket` says
  so, and that now needs EVERY spelling of the URL to be one of `DASHBOARD_SOCKETS` (`/trpc`,
  `/api/update`, `/api/apps/update`, `/api/restore/run`, `/api/terminal`) as well as the gate's
  `serve`: with `some`, `/<private app>/../trpc` was claimed and answered while `/<private app>`
  was destroyed, which told a stranger which apps were installed. It also needs a signed-in remote
  session (`hasRemoteSession`): every one of those sockets is useless without one, and handing
  over anyone's let a stranger hold any number open and push frames the dashboard had to buffer
  and parse — the attack the 64 KB body limit below exists to stop, through the one door it did
  not cover. So the dashboard's tRPC socket is now lazy (`ui/src/lib/trpcClient.ts`,
  `lazy: { enabled: true, closeMs: 10_000 }`): it opens only while something is subscribed and
  closes ten seconds after the last subscription ends, so the sign-in page holds none. A declined
  socket — an app's that the ingress would not serve, or a stranger's dashboard one — is destroyed
  exactly like one for an address with nothing at it; a claimed one is marked, tracked
  (`trackHandedOverSocket`) and emitted as an `upgrade` event. The dashboard's `/api` routes
  joined the allow-list (`DASHBOARD_API`); `LAN_ONLY_FEATURES` is gone. Nothing else under `/api`
  did: the Fabric, `/api/auth/session`, `/api/health` and `/api/ready` are refused over the tunnel
  on both listeners whatever the switch says. New on the dashboard listener, straight after the
  request-target guard: `registerHandoffOnlyGuard` refuses any request carrying `cf-ray` that the
  front door did not hand over (an upgrade is closed), recorded as `wrong-port`, so a tunnel
  pointed at port 443 by mistake cannot walk round the gate — the switch, the hostname, all of it.
- **Remote sessions.** The remote dashboard's cookie is `__Host-omos_session`
  (`REMOTE_COOKIE_NAME`: Secure, `Path=/`, no `Domain`, so a sibling hostname cannot plant or
  shadow it), set and read only for handed-over requests — i.e. on the admin hostname; the LAN
  cookie stays `omos_session`. A session minted by `completeLogin` over the tunnel records
  `remote: true`, `tf` — the second-factor epoch its code was checked against
  (`VerifyResult.epoch`) — and `handedOver` when the front door handed that sign-in over, i.e. the
  remote dashboard made it (`createSession` requires `tf` and `handedOver` with `remote: true`);
  `changePassword` carries the old session's grant over exactly (`remoteGrantOf` → `{ tf,
  handedOver }`), and `loadAtBoot` believes only a literal `true`. From the tunnel only a remote
  session whose `tf` matches `secondFactorEpoch()` counts (`getSessionUserFor`); a LAN session is
  refused there, not discarded. Everything the remote dashboard does also needs `handedOver`
  (`isRemoteSession`: its routes and sockets, the sweep, `claimsDashboardSocket`, `mintAppTicket`
  and the app access tokens). A sign-in through a reverse proxy at the masjid passes the second
  factor and keeps working through that proxy, but is never handed over, and its token lives in
  the LAN cookie, which every app opened from that page receives (cookies ignore ports): a review
  showed any one of those apps could compute an access token for EVERY app from it, by the public
  formula, and use it from the internet, private apps included. For a handed-over request, tRPC's
  context and the raw routes (`api/ws-auth.ts` `requestUser`: files, terminals, backup, restore,
  updates, the logo) also require `remoteDoorOpen(host)`, and `isAuthed` in `trpc/trpc.ts`
  re-checks door and session on EVERY protected call — a WebSocket context lives as long as its
  connection, and a review found one still able to switch remote administration back on after it
  had been turned off.
  What the dashboard does DIFFERENTLY from outside goes by the hand-over mark, never by
  `viaTunnel`: `auth.me`'s `remote` and `appOrigin` (`ctx.handedOver`), `apps.openRemote` (refused
  without it), `cloudflare.save`'s from-outside refusals, the restore's `remote` flag
  (`wasHandedOver(req.raw)`) and the update and channel-switch guards (below). A reverse proxy the
  masjid runs on its own network (nginx, Caddy, Tailscale Serve) sends `X-Forwarded-Proto: https`,
  so `viaTunnel` is true behind it — and answering "remote" there sent every Open button down the
  from-outside path, where it was refused, at the masjid. The security rules keep `viaTunnel`: the
  second factor at sign-in, the per-IP lockout, marking a session remote, the first-run refusals
  and the session rule above.
- **Long-lived connections.** A terminal checks `requestUser` and its own Advanced switch before
  every keystroke (on the LAN too). `system/remote-sockets.ts` tracks every handed-over socket and
  closes it within ~5 s (`SWEEP_MS`) of its door shutting or its session ending — and at once on
  sign-out, a password change, any second-factor change, remote administration switched off, the
  tunnel switched on or off or cleared, and any save of the tunnel settings (a changed admin
  hostname among them). An app's socket opened through the tunnel WITH the admin's access token is
  tracked too (`trackAppSocket`) and closed by the same sweep when that sign-in ends or the door
  shuts: before, the dashboard's sockets closed on all of the above while an app's stayed open,
  and a review found a private app still answering a socket opened before the admin signed out.
  A public socket, with no token, is left alone. Closing an app's socket now closes the app's end
  too (`system/socket-relay.ts` `closeTogether`, shared by the ingress and the per-app TLS proxy):
  the relay was two pipes, and a pipe passes on only an END, while a destroyed socket emits
  `close` and never `end` — so the sweep cut the browser off and the core went on holding the
  connection to the app, open, until the app noticed by itself. Now either side going takes the
  other with it, except that after a polite end the browser's side is left to finish sending. Its
  HTTP twin is new too: a browser that leaves part-way now ends the app's response
  (`res.once('close')` destroys the upstream unless the response finished, in `proxyHttp` and the
  per-app TLS proxy) — `pipe()` only paused it, so a live event stream, a long poll or a big
  download held the app's connection until the app gave up. The table is capped at 200
  (`MAX_TRACKED_SOCKETS`), because it is filled from the internet, and app sockets may hold at
  most 150 of the places (`MAX_APP_SOCKETS`), so the dashboard's own always have room: a hostile
  or leaky app's page could fill all 200, after which every terminal, update and restore from
  outside failed to start, on every device. A socket refused for either is destroyed, and the
  refusal logged at most once a minute. A sweep reads the door once per pass, and the
  second-factor epoch once for all the dashboard's sockets (`isRemoteSessionAt`), rather than once
  per open socket — a file read per socket, every five seconds, on the daemon's only thread; an
  app socket's check (`appAccessUser`) still reads the epoch for itself. An update or a restore
  keeps running when its progress socket is closed. And every dashboard WebSocket, LAN ones
  included, is pinged every 30 s (`DASHBOARD_WS_HEARTBEAT_MS`,
  `startDashboardHeartbeat(server.websocketServer)` in `index.ts`): Cloudflare closes a WebSocket
  that carries nothing either way for about 100 s, so a remote terminal at a prompt or in an
  editor printed "[Session closed]" in any pause, leaving whatever ran in it out of reach, and an
  update's progress could drop between download lines. A browser answers a ping by itself. Apps'
  own sockets are not pinged — their bytes only pass through the relay — so an app that wants a
  quiet socket to survive Cloudflare sends its own heartbeat.
- **Opening an app from outside** (`system/app-access.ts`). dev.13–15 built
  `http://<hostname>:<app port>`, a port the tunnel does not carry, so no app opened from outside.
  Now the dashboard asks `apps.openRemote` for a ticket — refused unless the front door handed the
  request over (the remote dashboard) with remote administration on, and only for an app with a
  web port while the apps' hostname is set. `mintAppTicket` mints one only for a live remote
  session the remote dashboard made: one use, `TICKET_TTL_MS` (60 s), bound to that session and
  that app, at most 200 outstanding. The dashboard opens a blank tab first (a pop-up blocker allows
  one only in direct response to the click), cuts its `opener`, and sends it with
  `location.replace` to `https://<apps' hostname>/_omos/open?t=<ticket>` (`APP_OPEN_PATH`,
  `registerAppOpen` on the HTTP front door); when no ticket can be had, the tab closes and a toast
  says so. No app is ever routed at `_omos`: the ingress routes only the shape an install or
  Settings gives an app (`apps/paths.ts` `isAppPathShape`, `^[a-z0-9][a-z0-9-]{0,79}$`). An app is
  also recovered from any `omos-*` project Docker reports, under that project's name, and Docker
  allows `_` in one, so a stack started by hand as `omos-_omos` was routed at `/_omos`:
  `sanitizePath` cleans only an address someone set, not the id an app falls back to. Spending the
  ticket sets the app's access token as `omos_session` with `Path=/<app path>`, `Secure`,
  `HttpOnly`, `SameSite=Lax` and a `Max-Age` no longer than the session, and 303s to
  `/<app path>/` — with `NO_STORE_HEADERS` (`Cache-Control: private, no-store` plus
  `CDN-Cache-Control` and `Cloudflare-CDN-Cache-Control: no-store`) and `Referrer-Policy:
  no-referrer`. It is refused with the ordinary tunnel 404 on the admin hostname and with remote
  administration off (recorded as `no-app-at-path`), and with a plain 404 on the LAN; a spent or
  expired ticket, or one whose session has ended, gets a friendly 410 page ("This link has
  expired").
- **The access token** (`auth/sessions.ts` `appAccessToken` / `appAccessUser`) is
  `a1.<session handle>.<HMAC-SHA256 keyed by the session token over the app id>`. It is valid only
  for that app, only while its remote session is (same password, same second-factor epoch, not
  signed out or expired, and made by the remote dashboard — a reverse proxy's sign-in yields none,
  Remote sessions above), and only while remote administration is on (`appAccessFromCookie`,
  `appAccessSsoUser`). It cannot be turned back into the session or into another app's token, and
  it is not a dashboard session: `getSessionUser` returns null for it, so no dashboard route
  accepts it. Session handles are memoised (`sessionHandle`, pruned to the live sessions) —
  without that, each token-shaped cookie value cost a SHA-256 per stored session, which a review
  measured at ~5 ms of the daemon's one thread per request with a 16 KB Cookie header — and at
  most eight `omos_session` values per request are checked as tokens (`MAX_TOKEN_CANDIDATES`).
- **What apps see through the tunnel** (`system/ingress.ts`, `cookieHeaderForApp`). Every
  platform session cookie — `omos_session` of any value, `__Host-omos_session` — is removed from
  the `Cookie` header relayed to an app, on the HTTP and the WebSocket path, and the app's own
  valid access token, if the request carried one, is put back FIRST (every OpenMasjid app forwards
  the first `omos_session` it finds). So a LAN, password-only cookie presented through the tunnel
  never reaches an app; before, a shared app's single sign-on would have accepted it with no
  second factor. Every app with a web port is now in the routing table, carrying `exposed`: one
  that is not shared online is served through the tunnel only with a valid token for THAT app, and
  anyone else gets the identical 404, recorded as `app-not-shared` (the LAN front door still does
  not serve it at all). Identical includes the body: such a request is declined before the
  `/fabric` refusal and before anything reads its body, so it takes the same road as an empty
  address. The first cut refused a private app's `/fabric` path before the body was read, while
  an empty address's broken or oversized POST got Fastify's 400 or 413 — which told a stranger
  which apps were installed. Single sign-on needs no app change: `GET /api/auth/session` (LAN-only,
  app secret) accepts the token for the app it was made for (`api/fabric.ts`, via
  `appAccessSsoUser`). And `X-Forwarded-Prefix` is now stripped from what reaches an app, like the
  other forwarding headers — by the ingress (HTTP and WebSocket) and by the per-app TLS proxy
  alike: some frameworks take their base path from it, and the platform never sends one, so one
  arriving was typed by the visitor.
- **What apps may send back, and what may be cached.** Through the tunnel, `Set-Cookie` for the
  platform's cookie names and `Service-Worker-Allowed` are stripped from app responses — one app
  could otherwise set `omos_session` on another's path (signing the admin out of it, or into an
  account of its choosing), or register a service worker over the whole hostname, `/_omos/open`
  included. Stripping the header only confines a worker whose script lives UNDER `/<path>/`, and a
  review found an app could serve its script at the BARE address instead — `/<path>` with nothing
  after it but a query (`isBareAppAddress`) — whose directory is `/`, the whole apps hostname. So
  at a bare address a service worker's script fetch (`isWorkerScriptFetch`:
  `Service-Worker: script` or `Sec-Fetch-Dest: serviceworker` — no page can put the latter on an
  ordinary fetch) never reaches the app: it gets a worker that removes itself
  (`SELF_REMOVING_WORKER`, sent by `answerBareWorkerFetch` as 200 `text/javascript` with
  `NO_STORE_HEADERS`), which unregisters on activation and touches nothing else — no caches, which
  belong to the apps. It is the same answer at a shared app's bare address, a private app's with
  or without its token, an address with nothing at it (the front door's not-found handler gives it
  too) and on the masjid's network, so it says nothing about what is installed. A 404, the answer
  before it, stops a NEW registration; but by the Service Workers specification an update check
  that fetches no script leaves an EXISTING registration in place, and every earlier build —
  Stable 0.51.1 included, which also passed `Service-Worker-Allowed` through — let an app's page
  register a worker over the whole apps' address from its bare one. The browser's next update
  check now installs this one instead. Everything else at the bare address is proxied to the app
  as before, with `NO_STORE_HEADERS` whatever the app says (`noStore`), so no cached copy can stand
  in for a worker fetch later — through the tunnel and on the LAN front door alike. It is recorded,
  as `worker-at-bare-address`, only when it came through the tunnel (`answerBareWorkerFetch`'s
  `record`, through `recordRefusal`, the recorder `refuseOverTunnel` uses too), because the record
  is a list of what came in from outside. Under `/<path>/` a worker is the app's own business.
  Neither the 404 nor the first fix shipped: that one 308-redirected a GET or HEAD of the bare
  address to `/<path>/` instead of proxying it, and a review found it loops for ever for an app
  that sends `/<path>/` back to `/<path>` (Next.js with a base path does, by default), taking its
  public page down.
  A private page, or anything served to a token, gets `NO_STORE_HEADERS` (Cloudflare keys its
  cache on the address alone), as does every tunnel refusal; every response the remote dashboard
  sends gets `CDN-Cache-Control` / `Cloudflare-CDN-Cache-Control: no-store`. From outside, an
  app's own favicon — the fallback when it has no catalogue icon — is loaded only for a SHARED
  app, from the apps' hostname (`lib/app-url.ts` `appBaseUrl`).
- **Body limits.** A handed-over request without a live remote session (`hasRemoteSession`) may
  carry at most 64 KB (`ANONYMOUS_BODY_LIMIT`) — a stranger only ever needs to send a sign-in and
  a code. A larger, or unreadable, declared `Content-Length` is refused 413 at the front door,
  unread (`anonymousBodyRefusal`); an undeclared (chunked) body is counted as it arrives by a
  `preParsing` hook and stopped at 413 (`registerDashboardRequestLimits`). Without this, the
  dashboard listener's 25 MB limit was open to anyone who could reach the sign-in page. And any
  `/trpc` request other than GET, HEAD or OPTIONS must be `application/json` or gets 415, whoever
  sends it: tRPC's multipart path read bodies of any size into memory, and nothing in the
  dashboard uses it. Every message on a dashboard WebSocket is capped at 1 MiB
  (`DASHBOARD_WS_MAX_PAYLOAD`, the dashboard listener's `maxPayload`), whoever sends it: the
  dashboard only sends small frames over a socket, and the library's default let any socket make
  the daemon buffer and parse 100 MB a message.
- **The second factor has an epoch** (`TwoFactorConfig.epoch`, `secondFactorEpoch()`),
  re-randomised on enrolling an authenticator (first or replacement), replacing backup codes,
  switching emailed codes on or off, and turning two-step sign-in off — never by using a factor.
  Every remote session made under the old epoch, and every app token derived from one, stops
  working from outside; before, a session made with a lost phone or with backup codes someone had
  found ran its full seven days. On the masjid's network such a session goes on working, as every
  session does there: LAN validity is bound to the password alone, and a password change is what
  ends a session everywhere. The admin who made the change FROM OUTSIDE keeps theirs
  (`rebindRemoteSession`), or the backup codes shown once would be unmounted before they were
  written down.
- **Emailed codes are bound to where they go**: the admin's address and the mail account they are
  sent through (`emailBoundTo`; `emailDeliveryFingerprint` — provider plus SMTP host/port/TLS/user,
  or a hash of the Resend key; not the From address, not the SMTP password). Changing either needs
  only a signed-in session — a password-only one, on the LAN — which could otherwise quietly
  redirect the next sign-in code, so the factor would no longer mean what the admin switched on.
  (That is all the binding does: it is not what stands between a dashboard session at the masjid
  and signing in from outside, since such a session can download a backup, which holds the
  authenticator's secret.) Either change now PAUSES emailed codes (`emailUsable`;
  `twoFactorStatus().emailPaused`), and turning them on again asks for the password and an
  authenticator or backup code. Configurations from before the binding are adopted at boot
  (`adoptLegacyEmailBinding`), so the upgrade pauses nothing. And `setEmailFactor`
  now refuses to switch them on without an enrolled authenticator (PRECONDITION_FAILED). The screen
  only ever offered them alongside one, but the API did not check, and as the ONLY factor they are
  pausable: after a pause nothing is enrolled, the next change needs only the password, and that
  change could point the codes somewhere else.
- **A factor change that lands while `requireSudo` checks the password is refused.** It captures
  `secondFactorEpoch()` and `twoFactorActive()` before argon2 and throws CONFLICT ("Two-step
  sign-in was changed somewhere else a moment ago. Please try again.") if either has moved. Without
  it, an admin turning two-step sign-in OFF to evict someone who held a remote session and the
  password could lose the race to that person's own change, begun a moment earlier: it then found
  nothing enrolled, skipped the code, switched emailed codes back on and kept its session under the
  new epoch — the door reopened with them inside while the admin was told it was shut. The review
  reproduced it three times out of three.
- **The installer's Reset sign-in can turn two-step sign-in off** (`reset-auth.ts`). It asks only
  when two-step sign-in is on, and the answer is no unless the admin answers yes: "Turn off two-step
  sign-in as well? Choose this if the phone with your authenticator app is lost and you have no
  backup codes." That situation had no proper way out: the dashboard asks for a current code to
  change two-step sign-in, on the LAN as well, so an admin who had lost the phone AND the backup
  codes could never remove or replace it there. Whoever runs the reset already has the server
  itself, so it gives nothing away. `disableTwoFactor()` leaves nothing but a new epoch, so remote
  administration stays shut until two-step sign-in is set up again (the tool says so), and the
  reset signs every session out as before. `reset-password.ts`, the password-only tool, leaves the
  second factor as it is and now says where the full reset is when two-step sign-in is on.
- **Settings → Remote access checks everything, then writes once.** `cloudflare.save` works out the
  final apps' address and dashboard address, validates the dashboard address against the apps'
  address as it will END UP (`validateAdminHost(input, appsHost)`), and only then calls `setToken`
  and one `updateCloudflare` — so a refused save changes nothing: not the addresses, not the token,
  not the door. It used to write the apps' address first and refuse the dashboard address
  afterwards; a save reported as refused had already put the apps on the dashboard's hostname, which
  switches remote administration off, and from outside only someone at the masjid could undo it.
  Three reviewers found it separately. From OUTSIDE the dashboard address cannot be moved or cleared
  at all (FORBIDDEN: "Change the dashboard address at the masjid — changing it from here would cut
  you off."); sending it unchanged, or not at all, is not a move. The tunnel token is checked the
  same way, because saving one recreates the cloudflared container — the connection a request from
  outside came through. Everywhere, a paste that is not a whole token is refused before anything is
  written (`system/cloudflared.ts` `normalizeTunnelToken`: base64 of a JSON object `{a, t, s}`, `t`
  a UUID), and Cloudflare's whole install command — `… --token X`, `--token=X` or `service install
  X` — is reduced to its token: cloudflared refuses anything else and, under `restart:
  unless-stopped`, retries for ever, so a half-copied token took every shared app offline while the
  platform logged "Cloudflare tunnel is running." Only the canonical form passes (`isTunnelToken`:
  whole four-character blocks that encode back to exactly the same string), because cloudflared
  decodes with Go's padded standard base64, which refuses a last block without its "=" padding or
  with too much, while Node's decoder takes both — so the check passed tokens cloudflared then
  refused. And a token whose padding was left behind (a double-click selects letters and digits
  only) is repaired rather than refused: trailing "=" are dropped and put back by length — two
  characters short gets "==", one short "=", and a length of 4n+1 cannot be base64 at all — so an
  extra "=" is put right too. `cloudflaredRunning()` now asks `tunnelContainerUp` (`Running` and not
  `Restarting`): Docker reports a container in its restart loop — a refused token's — as running, so
  Settings said "Tunnel is running." over a tunnel that never connected. That fixed, it said "Tunnel
  is set up but turned off." over a tunnel switched on, so one that is on but not up now says
  "Tunnel is turned on but isn't connecting. Check that the tunnel token is the right one."
  (`settings.cfNotConnecting`; the red dot was already right). And starting
  the tunnel logs "Cloudflare tunnel started." (`ensureCloudflared`), not "Cloudflare tunnel is
  running.", which a refused token got too. From outside only the token already in use is accepted
  (`isCurrentTunnelToken`; re-pasting it, with or without its padding, changes nothing), and a
  different one is FORBIDDEN ("Replace the tunnel token at the masjid — if the new one didn't work,
  this window and every shared app would go offline until someone there fixed it.").
- **A restore started from outside is refused before anything is stopped or replaced** unless the
  backup keeps the way back in (`system/restore.ts` `remoteRestoreProblem`, run when `runRestore`
  gets `remote: wasHandedOver(req.raw)` — the front door's hand-over, so a restore through the
  masjid's own reverse proxy counts as the restore at the masjid that it is). The staged settings
  must pass `settingsOpenTheDoor`, the very rule the live box applies, and name the same admin
  hostname — the first cut's hand-written copy of the rule missed "dashboard address equals apps'
  address", and a restore it allowed shut the remote dashboard behind the admin. Then the same
  tunnel token (`tunnelTokenMatches`); a username AND the same password hash (a backup with no
  username restores a box nobody can sign in to); and the same authenticator
  (`sameSecondFactorAs`, which requires one on BOTH sides — an emailed-codes-only configuration is
  refused, since whether a restored emailed factor would deliver depends on the restored address
  and mail account, and nobody could repair a wrong guess from outside). Backup codes are not
  compared: they come back with the backup (see the residuals below). A restore replaces `config/`
  whole and most backups predate remote administration, so restoring one from outside would switch
  the door off behind the admin. A backup with no `config/` is not affected; at the masjid this
  check does not apply.
- **During a restore the second-factor epoch is held** (`holdSecondFactorEpoch`, taken beside
  `holdForRestore` once the apps are stopped, just before `config/` is replaced, and released in
  the same `finally`). The restored `twofactor.json` can carry an older epoch, and the restoring
  admin was being signed out mid-restore — the sweep closed their progress window and every line
  after it was lost. A sign-in completed during the restore is bound to the HELD epoch too
  (`verifySecondFactor` reports it), not the restored file's, or its session was refused from its
  first request. Once a backup's `config/` is in place the epoch is RENEWED
  (`renewSecondFactorEpoch`), at the masjid as well, and the restoring admin's remote session is
  moved onto it (`rebindRemoteSession`, in the `finally` while both holds still stand, with the
  caller's token passed from `api/restore.ts` via `requestSessionToken`) — but only if that
  session still counts at that moment (`remoteGrantOf(callerToken) !== null`, judged against the
  held epoch), so one shut out while the restore ran stays out instead of being carried onto the
  new epoch with it. Releasing the hold would otherwise have handed the box the backup's epoch:
  every remote session made under the factor as it stood when the backup was taken — one the admin
  had since shut out by replacing the factor included — would have counted from outside again,
  while the admin restoring was shut out. **Nothing about the second factor can be CHANGED for the
  whole restore**, not only while the epoch is held (`secondFactorHeld() ||
  isUpdating('restore')`): before the swap a change would simply be overwritten by the backup's
  factor. `refuseDuringRestore` in `trpc/routers/twofactor.ts` throws CONFLICT ("A backup is being
  restored right now. Please try this again once it has finished.") at the start of
  `requireSudo`, again once the password has been checked (a restore can begin while argon2
  runs), and at the start of `confirm` — so enrolling, confirming, turning two-step sign-in off,
  new backup codes and switching emailed codes are all refused before any code is spent. The
  first cut let such a change through: written during the hold, it did not count until the
  release, and the admin who made it — moved onto the held epoch — was signed out from outside
  the moment the restore let go. Signing in still works during a restore.
- **A restore brings the core back on the build it is running** (`docker/update.ts` `recreateCore`
  with no tag), whatever the core's compose file says. That file is not a record of what runs: an
  update whose helper could not start had already pointed it at the version it was going to, and
  the installer's Update wrote it before downloading. So `pinComposeToRunningBuild` tags the
  running container's image, by ID, as `<the compose file's repo>:<running VERSION>` (`docker
  tag`) and points the compose line at that tag (`alignComposeImage(VERSION)`), and the helper runs
  from that same image ID (else the compose file's reference, `composeImageRef`; the channel alias
  only as a last resort, when there is neither). A reference pinned to a digest, or a container
  that cannot be inspected, is left alone. It used to aim at the channel's alias (`:latest`,
  `:dev`) WITHOUT pulling it, and dashboard updates pull exact versions (the alias only for a
  channel move whose version could not be read), so that tag named whatever build the installer
  had last fetched — and every restore quietly put the box back on it: often an older one, and
  from outside usually one with no remote dashboard at all. A dashboard update still passes its
  exact version, and now puts the compose file back as it was if its helper cannot be started, so
  "nothing was changed" stays true. And the installer's Update (`install.sh` `do_update`) now
  decides the image (`resolve_image`), downloads it, and only then writes the compose file: under
  `set -e`, a failed download used to leave the file naming the new image, for the core's next
  restart to come back on.
- **A restore says how it ended** (`RestoreOutcome`; the close codes are `RESTORE_CLOSE` in
  `api/restore.ts`): 1000 `restarting`; 4003 `restarting-with-problems` — the same, but some app
  could not be paused first (below), some app data could not be put back, or some app could not be
  started afterwards (held for review, or `compose up` failed: `reupAllApps` now returns their
  names); 4001 `unchanged` — refused, busy (another restore, or an update in the way: below), or an
  unreadable, invalid or empty file, each found before anything is touched; 4002 `not-restarted` —
  it stopped on an error part-way; 4004 `restored-not-restarted` — everything was put back, but the
  helper that restarts the core could not be started. The first cut of these codes gave that last
  one 4002 too, so the window said the restore had stopped, inviting a second restore that stops
  every app again when only a restart was missing. A backup with nothing usable in it is now found
  BEFORE any app is stopped ("That backup had nothing to restore. Nothing has been changed."); it
  used to be found only afterwards, so a `volumes/`-only backup with nothing restorable stopped
  every app and left them stopped. One list of volume archives (`stagedVolumeArchives`) serves that
  check and the work, so the two cannot disagree about what a backup holds. Every refusal made
  before a restore starts (4401, 4403) now sends its reason as a line before closing ("… Nothing has
  been changed."), because the window shows what the stream sent. `RestoreModal` reads the code: a
  stream that never connected (`LogStream` now says whether it ever opened) says it couldn't
  connect, so nothing was changed; 4002 says the restore stopped before it could finish; 4004 says
  the backup was restored but OpenMasjidOS couldn't restart itself, and that restarting the machine
  — or the installer's Repair — finishes it; any other 4xxx but 4003 (a sign-in or origin refusal
  included) says nothing was changed; a normal close, a 4003 or a dropped stream waits for the
  restart — saying after ~30 s that the dashboard hasn't restarted yet and to reload if nothing
  changes, while it goes on waiting. The core counts as down only after TWO failed checks of
  `/trpc/auth.me` in a row, a good answer starting the count again: one failed check used to count,
  so a single blip read as the restart and the window said "Restore complete." while the old core
  was still about to be replaced. Once it has seen the restart, a 1000 ends on "Restore complete.",
  a 4003 on "The restore finished, but some of your apps or their data need attention — the messages
  above say which. Please check them before relying on this restore. The dashboard will remind you
  after you sign in again.", and a dropped stream — a close other than 1000 outside 4000–4999, so
  the window never heard how the restore ended — on a new neutral ending, `restore.lost`:
  "OpenMasjidOS has restarted, but this window lost touch with the restore before it said how it
  went. Please reload, sign in again and check that your apps and settings look right." That one
  used to say "Restore complete." too. It never says any of them without having seen the restart. It
  used to treat every ending as a restart and announce "Restore complete." after four minutes,
  refused restores included, on the LAN as well. `LogStream` passes the close code on and no longer
  reports its own unmount as the stream ending, and a wait left over from an earlier run cannot
  write into a new one. The "Affected:" line names apps, not Docker volumes.
- **The dashboard remembers what a restore could not do.** The window naming the apps is gone within
  a minute of the core restarting — every session ends then — and nothing recorded which apps came
  back empty. So when apps could not be paused, app data could not be put back or apps did not
  start, the restore writes `config/restore-report.json` (0600; `{at, appsWithoutData,
  appsNotStarted, appsNotPaused}`, app names — the first mapped from their `omos-<id>_…` volumes)
  and logs each failure with `log.warn`; a restore with nothing to report removes any older report,
  including one that came back inside the backup's own `config/`. `backups.restoreReport` /
  `backups.dismissRestoreReport` (both protected) feed a warning banner on the dashboard after the
  next sign-in — "Your last restore needs a look", naming the apps — until the admin presses "I've
  checked them". Its no-data line reads "These apps' data couldn't be put back, so they have
  whatever was already on this machine: …" — the first cut said they "started with" it, which was
  false for an app that also failed to start.
- **An app that could not be paused is a problem, not a footnote.** `stopAllApps` never read
  `composeStop`'s exit code (it reports a failure there and never throws), so a container Docker
  refused to stop was listed as paused and had its data refilled under it. It now checks the code,
  prints "• <Name> (couldn't pause it — its data may not restore cleanly)", logs a warning and
  returns the names; they count towards `restarting-with-problems` (4003), go into the report as
  `appsNotPaused`, and the banner adds "These apps couldn't be paused for the restore, so their data
  may not have been put back cleanly: … Please check them." (`dashboard.restoreReportNotPaused`).
- **An update or a channel switch made from outside may not move the box to a version that
  cannot be managed from outside** (`system/remote-admin.ts` `FIRST_REMOTE_ADMIN_VERSION` =
  `0.51.2-dev.16`, the first build with a dashboard address of its own, and `managesFromOutside`,
  a semver `>=`). Stable is 0.51.1, which has no remote dashboard at all, so an admin managing from
  outside who switched back to Stable and let the dashboard move the OS across would have brought
  the core back without one — every window from outside cut off until someone at the masjid moved
  the box on again. `runUpdate(onLine, { remote })` — the core update route passes
  `remote: wasHandedOver(req.raw)` — checks the version it would install
  (`checkForUpdate().latest`) after the "already up to date" and "couldn't check" stops (next
  bullet) and BEFORE anything is pulled: unknown (by then, in practice, a channel move whose
  target could not be read), it says "Couldn't check which version this would install, so it
  can't be done from outside right now."; older, "Version X can't be managed from outside the
  masjid, so installing it from here would cut you off." — each followed by a line ending
  "Nothing was changed." And
  `system.setUpdateChannel` from outside (`ctx.handedOver`) first reads the TARGET channel's
  published version (`system/system.ts` `publishedVersion`, factored out of `checkForUpdate`):
  unreadable is SERVICE_UNAVAILABLE, older is FORBIDDEN ("Stable (version 0.51.1) can't be
  managed from outside the masjid, so switching to it from here would cut you off. Please make
  this change at the masjid. Nothing was changed."). Refusing the switch itself, rather than only
  the OS step at its end, keeps the apps and the platform on one channel. At the masjid both go
  ahead as before, and once Stable is 0.51.2 or later the switch is allowed from outside too.
- **An update says how it ended** (`docker/update.ts` `UpdateOutcome`; the close codes are
  `UPDATE_CLOSE` in `api/update.ts`): 1000 `restarting` — the helper is replacing the core — or 4001
  `unchanged`: already up to date, a download that failed, an updater that could not start, a
  refusal from outside, a core pinned to a digest (below), a restore or an app's update in the way
  (below), or an error. A newest version that could not be read, on the same channel, is no longer
  "already up to date": it says "Couldn't check for the latest version just now, so nothing was
  changed." and nothing is pulled, as before (a channel move still goes, to the channel's alias).
  The same update asked for twice closes with 1000, since that other update may restart the core —
  "An update is already running. It will finish on its own." while it runs, and "OpenMasjidOS is
  restarting to finish an update. Please try again in a minute or two. Nothing was changed." once it
  has handed the core to its helper (the lock is held until the core is replaced, below). The
  route's refusals before it starts (4401, 4403) now send their reason as a line first ("Please sign
  in again, then start the update once more. Nothing was changed."). `UpdateModal` reads the code: a
  stream that never connected says it couldn't connect, so nothing was changed; any 4xxx ends in a
  new `unchanged` phase — unlocked, "Nothing was changed. The messages above say why." and a Close
  button — and 1000 or a dropped stream waits for the restart, saying the update worked only on
  EVIDENCE: a new version answering `auth.me`, or the core seen to go down and come back — down
  meaning TWO failed checks in a row, a good answer starting the count again; one used to be enough,
  so a single 502 or Wi-Fi blip kept the dialog locked for three minutes and could claim a restart
  that never happened. With no sign of a restart after ~30 s it says, unlocked and still watching,
  that OpenMasjidOS hasn't restarted yet and to reload if nothing changes; after ~3 min it ends
  there. Once the core is back on the SAME version it watches ~30 s more (15 polls) for another
  restart and then ends, unlocked, on "OpenMasjidOS restarted, but it is still on v… Reload this
  page, then try the update again." — it used to hold the dialog for the rest of the three minutes
  first. It used to treat every ending as a restart, so an update that changed nothing held the
  dialog locked on "restarting" for three minutes and then said "Update applied.", at the masjid too
  — and said the same over an update still downloading, or one that had failed. The channel switch's
  window (`ChannelMigrate`) now reads its OS step's close too: any 4xxx, or a stream that never
  connected, says "OpenMasjidOS itself was not changed — the messages above say why."
- **An app's update says how it ended**, too. `apps/manager.ts` `updateCatalogApp` returns
  `AppUpdateOutcome` (`updated`, `unchanged`, `not-running`), and `api/app-update.ts` closes with
  `APP_UPDATE_CLOSE`: 1000 updated; 4001 nothing was changed (refused, already current, put back
  after a failed download or start, already being updated, or a core update or restore under way);
  4003 updated but not staying up; 4002 stopped part-way, on an error. Its refusals before it
  starts say why as a line and close 4401 or 4403, and an impossible app id 4400 ("That app could
  not be found. Nothing was changed."). It used to close with no code, and the window said "<app>
  is up to date now." whatever had happened. `ui/src/lib/update-endings.ts` (React-free, so a core
  test holds it to the server's codes) turns a close into an ending for the three windows that
  stream app updates: the app's own (`AppUpdate`) says it is up to date, that nothing was changed,
  that it updated but isn't staying running, that the update stopped part-way, that the window
  lost touch with it ("it may still be finishing"), or that it couldn't connect; **Update all apps**
  (`UpdateAllApps`) counts the apps that really updated — "All N apps updated." only when all did,
  otherwise "N of M apps updated. The messages above say what happened to the others." with a
  warning icon — and the channel switch (`ChannelMigrate`) counts the apps that really moved the
  same way. The WhatsApp `!os update` command reports it too: "<app> wasn't updated, so nothing
  was changed. Have a look on the dashboard to see why." where it used to say the app was updated.
- **A core update, a restore and an app's update never overlap** (`system/update-lock.ts`). The keys
  `core` and `restore` are now EXCLUSIVE: either is refused while anything else runs, and anything
  is refused while either runs; two different apps' updates may still run together. The refusal is
  an `UpdateBusyError` with `clash: true` and a message naming what is in the way — "A backup is
  being restored right now. Please update OpenMasjidOS once it has finished. Nothing was changed.",
  and likewise for each pair — while the same work asked for twice is still "An update is already
  running. It will finish on its own." (both give way to the "restarting to finish" message once the
  work is done, next bullet). Why: a review pressed Update 300 ms into a restore, and the update's
  helper replaced the core while the restore was still refilling app data — cut off part-way, every
  app left stopped, a database half put back. A clash closes the core update window 4001; the
  restore says the clash, removes the backup it was given (below) and ends `unchanged`; an app's
  update ends `unchanged` too.
- **A core update or a restore keeps its lock until the core is replaced** — not until it hands that
  job to the helper. `withUpdateLock(key, busy, fn, { holdAfter })` keeps the key held for
  `holdAfter(result)` ms once `fn` resolves, released by an unref'd timer; a throw never holds.
  `runUpdate` holds for `restarting`, `runRestore` for `restarting` and `restarting-with-problems`,
  each for `HOLD_UNTIL_REPLACED_MS` (5 minutes). The old core goes on running ~12 s after handing
  its replacement over (the helper's `sleep 2`, then compose's 10 s stop timeout, because the core
  is `node` as PID 1 and ignores SIGTERM), and releasing at the hand-off accepted a restore, an app
  update or a second core update in that gap, which the replacement then killed part-way: a review
  launched three helpers, and cut a restore off with one app's data half put back and every app left
  stopped. During the hold the work is DONE and only waits for the core to be replaced, and the
  refusals say so (`finishing(key)`, `finishingMessage(key)`): "OpenMasjidOS is restarting to finish
  an update. Please try again in a minute or two. Nothing was changed." or "OpenMasjidOS is
  restarting to finish restoring your backup. …". In the hold only, that replaces the clash message,
  the same-work one (still not a clash, so the update window waits for the restart, close 1000),
  `assertAppFree`'s, the restore's dashboard refusal and the logo routes' (below), and the restore
  upload's "A restore is already running" (409); while the work is still RUNNING the earlier
  messages stand ("A backup is being restored right now…", "OpenMasjidOS is being updated right
  now…") — "being restored right now" over a restore that had finished sent the admin to wait for
  something that was not happening. The timer means a helper that never replaces the core cannot
  wedge the box — though until it fires, updates and restores stay refused, and after a restore so
  does every change from the dashboard. The header of `system/update-lock.ts`, which said the lock
  died with the process at the hand-off, is corrected.
- **No app is started, restarted, installed or removed under a restore or under its own update.**
  `assertAppFree(id, 'start' | 'install' | 'remove')` throws a clashing `UpdateBusyError` and is
  called FIRST in `startApp` and `restartApp` (both `'start'`: a restart starts a stopped app),
  `removeApp`, `installCatalogApp` and `installStack`; `stopApp` is never refused. During a restore
  a start gets "A backup is being restored right now. Your apps will start again on their own when
  it has finished. Nothing was changed." and an install or a removal "A backup is being restored
  right now. Please install (remove) this app once it has finished. Nothing was changed."; during
  that app's own update (`app:<id>`) anything gets "This app is being updated right now. Please try
  again once it has finished. Nothing was changed."; and during a core update an install or a
  removal — not a start — gets "OpenMasjidOS is being updated right now. Please install (remove)
  this app once it has finished. Nothing was changed." Once the restore or the core update is done
  and only waiting for the core to be replaced, each of those becomes the "restarting to finish"
  message above (a start is still allowed in a core update's hold). Every caller already handled it:
  tRPC's `wrap` makes it CONFLICT, `!os start` and `!os restart` reply with the message, and the
  address monitor and the Remote access re-ups catch it and skip. Why: a restore stops every app and
  refills its data — a review's Start, accepted mid-refill, ran `compose up` before the refill had
  finished — and, worse, a compose that came in with the backup and had not been checked yet could
  be started with no consent (`privileged: true`, host root), from WhatsApp too, which must never be
  able to consent; and Start during an app's own update brought up the compose that update was about
  to put back. On the dashboard, during a restore, the next bullet's refusal answers first.
- **Nothing is changed from the dashboard while a restore runs.** `protectedProcedure` is now
  `t.procedure.use(isAuthed).use(noChangesDuringRestore)` (`trpc/trpc.ts`): while
  `isUpdating('restore')` every protected MUTATION gets CONFLICT "A backup is being restored right
  now. Please try this again once it has finished." — or, in the hold after it, "OpenMasjidOS is
  restarting to finish restoring your backup. Please try again in a minute or two. Nothing was
  changed." Queries still answer, and signing in and out (public procedures) still work. That covers
  the dashboard's Start, Install and Remove. Two mutations change nothing a restore replaces and go
  ahead (`ALLOWED_DURING_RESTORE`): `apps.stop`, because turning an app off must always work, and
  `apps.openRemote`, which only mints a one-use ticket in memory. The logo routes
  (`api/branding.ts`, outside tRPC, writing
  `config/branding/`) refuse the same way, 409 with the same messages, after their origin, session
  and key checks. Why: a restore replaces `config/` whole, and a password, a setting or
  `setRemoteAdmin(false)` made during it was accepted and then silently undone — in the review the
  old password worked again after the restart, and remote administration came back on.
- **The restored settings are put in place at once.** The stores read their file once at boot and
  kept a copy, so a write after the swap put the PRE-restore settings back over the restored file —
  in the review the root terminal came back ON after restoring a backup in which it was off, because
  someone changed the theme mid-restore. Straight after the swap, when `config/` was moved, the
  restore calls `reloadSettings()`, `reloadEmailConfig()`, `reloadStripeConfig()`,
  `reloadWhatsAppConfig()` and `reloadCommandConfig()` (the admin store already re-reads by itself;
  the second factor has its own hold and renewal, above).
- **A restored app's compose is checked the moment `apps/` is in place**, not after its data is
  back: `reviewEveryApp()` (`apps/manager.ts`, a failure logged) runs `reviewCompose` for every app
  with a compose file straight after the `config/` + `apps/` rename, before `restoreVolumes`, so the
  persisted verdict (`AppMeta.review`) is this platform's own from that moment rather than the
  backup's. `reupAllApps` still reviews again at the end.
- **The monitors stand aside during a restore.** The offline-alert check (`system/alert-monitor.ts`)
  returns at once while a restore runs — a restore pauses every app on purpose, and the
  `app-offline` alert ("… has stopped", "Then press Start.") told the admin to start an app over
  data being put back — and `stopAllApps` also suppresses that alert for each app it pauses. The
  off-site backup scheduler (`system/backup-upload.ts`) skips its tick while a restore or a core
  update runs; the next tick runs it. And the address monitor (`system/address-monitor.ts`) skips
  its tick during a restore: it rewrites apps' settings, which would land in a tree about to be
  swapped out.
- **A backup and a restore never overlap.** `backupStream` refuses while a restore runs
  (`backupRefusal`: "A backup is being restored right now. Please make a backup once it has
  finished.", or the restarting-to-finish sentence in the hold) — the download from outside asks
  before its headers go, so it is still a proper 409 — and a restore refuses while a backup is
  being made (`BACKUP_RUNNING`, in the upload route and first thing in `restoreOnce`, which then
  removes the upload). A backup taken during a restore copied data half put back and reported
  success; a restore during a backup replaced what it was copying. `test/remote-restore.test.ts`
  (*A BACKUP AND A RESTORE NEVER OVERLAP*). The store, custom and community install routes and
  the WhatsApp gateway's restart now turn a refusal from the update lock into CONFLICT, not
  INTERNAL_SERVER_ERROR (`test/update-lock.test.ts`).
- **A refused restore leaves no backup behind.** Refused because OTHER work is in the way, or in the
  hold after a restore that has finished (`err.clash || finishing('restore')` — that restore removed
  its own file on the way out, so anything at the path is the refused request's), `runRestore` now
  removes the uploaded `.restore.tar.gz` — every secret on the box, unencrypted — but not when
  another restore is still RUNNING, which is reading it. The upload route refuses up front, 409,
  while an update is in the way (`clashFor('restore')`, with the clash message, checked before the
  file is read), and in a restore's hold says the "restarting to finish" message instead of "A
  restore is already running". At boot (`index.ts` `main`, once the data folders exist)
  `removeRestoreLeftovers()` deletes a `.restore.tar.gz` and a `.restore-staging` that a restore
  never got to remove (a power cut, say), logging "Removed <name> left behind by a restore that did
  not finish." And the File Explorer (`files/manager.ts`) keeps both private, like
  `.backup-staging`: "This is a backup being restored, so it is kept private. It is removed when the
  restore finishes." Each holds a whole backup: every password hash, key and token, possibly another
  box's.
- **A core pinned to a digest is not "updated" onto itself.** When the core's compose line names a
  digest (`composeImageRef()` contains `@`), `runUpdateInner` refuses before anything is downloaded
  — after the up-to-date and from-outside checks — with "OpenMasjidOS is pinned to one exact build
  on this machine, so it can't update itself from here. Nothing was changed." (4001). Before, every
  press pulled that same build and restarted the dashboard onto it, signing everyone out, while the
  banner went on offering the update (it still does: residuals below).
- **The installer's Update and Repair print the dashboard's real address**: "Open it at:
  https://<ip>" (`TLS_PORT`, with a port only when it is not 443). They printed `http://` on `PORT`,
  which reached the dashboard only through the port-80 redirect.
- **Downloading a backup from outside sends its headers before the backup is made**
  (`api/backup-download.ts` `remoteBackupDownload` / `sendBackupEarly`, which the `/api/backup`
  route uses for a handed-over request): copying every app's data can outlast the 100 seconds
  Cloudflare gives an origin to start answering, after which it shows its own error page. "Already
  running" is still a proper 409, because `backupInProgress()` (new in `system/backup.ts`) is asked
  before anything is sent; a failure after the headers breaks the download off (`res.destroy()`)
  rather than saving a partial file the admin would trust. A browser that leaves at any point now
  ends the backup: the `close` listener goes on before the backup starts, and the archive is handed
  to `sendBackup`, which tears tar down whichever side fails. The first cut noticed leaving only
  once the backup existed — by then the one `close` had already fired — so tar blocked on a full
  pipe for ever and the one-backup-at-a-time flag stayed set: every later backup, the nightly
  off-site one included, was refused as "already running" until a restart, with a staged copy of
  every app's data left on disk. Cancelling a download stuck at 0 bytes was enough, and so was
  Cloudflare dropping a silent connection. **And a download now ends only once tar has said it
  succeeded**, on the LAN as well (`sendBackup`, used by both). tar's output ends BEFORE tar
  exits, so a response ended with the output — by a pipe, or by Fastify's `reply.send(stream)` on
  the LAN — was delivered whole and clean for a backup tar had FAILED: a file it could not read
  left out, an archive cut short. The browser said "done", the log said "Backup failed", and the
  admin found out at the restore. Now the end waits for the output to finish AND `done.ok`, and
  anything else breaks the download off, which a browser reports as failed. The LAN route hijacks
  the reply instead of `reply.send(stream)`, with `cache-control: private, no-store`.
- **App addresses.** ONE list of reserved first segments, `RESERVED_PATH_SEGMENTS` in
  `apps/paths.ts` (`api`, `trpc`, `assets`), read by the ingress (which never routes them) and by
  `setAppPath`, which now refuses them ("/api is used by OpenMasjidOS itself…") — before, only the
  ingress knew, so an app could be given `/api` and then had no public page at all. `setAppPath`
  also refuses an address another installed app answers to. An install (catalog, community or
  custom) whose id is another app's address, or a reserved word, gets the next free `<id>-N`
  (`addressForNewApp`) — decided before anything is written, logged (`noteDisplacedAddress`), and,
  for a catalogue app (the only kind given `OPENMASJID_PUBLIC_URL` at install), used in it
  (`intendedPublicUrl` now takes the path, because the app's `meta.json` does not exist yet); a
  reinstall keeps its address. Installs used to take their id regardless: give a community app
  `/donations`, install the official Donations app later, and the two shared one address. With
  every app in the routing table, `placeRoute` keeps a shared app's path whatever the order
  (otherwise the later app wins, as before) and logs a clash once.
  `isRouted(appId)` is true only for the app that actually HOLDS the route and is shared: a private
  app has no public URL even when opened remotely, and when two apps answer to one path only the
  holder is told it is published there — the other's Stripe return links and QR codes would
  otherwise point at someone else's app. `InstalledApp.path` (new) carries each app's address to
  the dashboard.
- **Refusals.** Every tunnel refusal answers through one responder (`refuseOverTunnel`), so a
  browser gets the same page from every guard — before, the gate and the Fabric guard answered JSON
  while the not-found handler answered HTML, which told a visitor which kind of address they had
  hit. It also sends `NO_STORE_HEADERS`, so Cloudflare never keeps a 404 to hand the admin later.
  The not-found handler takes its reason from `notFoundReason`, which the tests call too. Six
  reasons are new, ten in all: `app-not-shared`, `dashboard-elsewhere`, `app-on-admin-host`,
  `no-admin-host` (`doorClosedReason`, above), `wrong-port` (`registerHandoffOnlyGuard`: a
  Cloudflare hostname pointed at the HTTPS port) and `worker-at-bare-address` (above: the one
  recorded reason not answered with the 404 — it gets the worker that removes itself — and the one
  that can also happen on the masjid's network, where it is not recorded). Each has its own words in
  "Recently turned away" — in the first cut two of them fell back to "Local network only", which
  said nothing about what to fix — and the `wrong-port` label names the fix: Type HTTP, URL
  `localhost:<port>`. The `worker-at-bare-address` label reads "A background worker asked for at an
  app's bare address — answered with one that removes itself, as it could reach every app"; the
  first cut said an app had tried to install one and been refused, which is no longer what happens.
  `plain-http-no-host` is now reached only by a request target starting `//`, and its label was
  rewritten to match ("Opened over http:// at an address that couldn't be moved to https:// — use
  the https:// address"); it used to tell the admin to set a domain. The record is shown to any
  signed-in admin — on the masjid's network, or from outside behind the second factor.
- **UI.** Settings → Remote access: "Your domain" is now **Your apps' address**; a new **Dashboard
  address** field comes with the Cloudflare steps and is disabled from outside with the reason
  beside it, as is the tunnel-token field. Each address is sent to the server only when it was
  edited (sending the value the page loaded with undid a change made on another device — for the
  apps' address, every shared app's public links with it); a successful save refills both fields
  from what the server stored, and a refused one re-reads the stored status, though the fields keep
  what was typed. From outside, switching remote access off, switching **Manage OpenMasjidOS from
  outside** off and **Remove tunnel** each open a confirmation first (`ConfirmDialog`: this window's
  connection ends, and only the masjid can undo it); at the masjid they stay one click. When
  switching remote access off or removing the tunnel takes the connection down before the answer
  arrives — Cloudflare sends its own page instead — the panel says it is done ("Done — this window
  can't reach the dashboard any more…") rather than showing a parse error with the dialog still
  armed. The switch says why it is blocked, `'no-admin-host'` included; the address it shows is
  `https://<admin hostname>/`; the turn-on dialog says nearly everything works from outside — apps,
  files, terminals, backups and updates — that an update to a version that can't be managed from
  outside has to be done at the masjid, and that apps open at the apps' address only
  (`settings.cfRemoteAdminAsk3`); the per-app wording says a private app still opens for the admin
  from outside, and in the routes table that sentence now wraps instead of making the table scroll
  sideways on a phone. Remote Open goes through `apps.openRemote` (`lib/apps.ts`, wired in
  `Root.tsx`, whose toast shows the server's own message when there is one and "That app couldn't be
  opened" otherwise). The new `lib/app-url.ts` builds only LAN addresses and a shared app's public
  base. The File Explorer, terminals and backup/restore are no longer hidden or disabled remotely
  (`settings.remoteOnlyLan` and `remoteOnlyLanHint` are gone). From outside, the File Explorer
  upload and the restore upload refuse a file over 100 MB before sending it (`REMOTE_UPLOAD_LIMIT`,
  Cloudflare's free-plan limit) and recognise Cloudflare's own 413 page, each saying to do it at the
  masjid rather than showing a generic error; the restore dialog's warning from outside
  (`restoreConfirmRemote`) mentions the limit. OpenWA's Open button is disabled from outside, with
  the reason — its own screen does not work under a path. The update and restore dialogs poll
  `/trpc/auth.me` instead of `/api/health`, which stays refused over the tunnel; `auth.me` now
  returns `version` to a signed-in session (the update dialog reads it from tRPC's `result.data`
  envelope — the first cut read the top level, found nothing, and never showed the new version) and
  `appOrigin` to a remote one. The update dialog is locked only while the update runs and while the
  core restarts, and ends on "Nothing was changed" with a Close button when the server says so
  (above). The two-step panel shows its "paused" hint only when emailed codes are possible —
  otherwise it names what is missing, an email provider or an email address on the account
  (`auth.twoFactor.status` `emailMissing`; it used to ask for a provider even when only the address
  was missing) — and its status refreshes after a profile or email-provider save; from outside, its
  turn-off dialog says that turning two-step sign-in off shuts this window out at once, points a
  phone change at **Use a different phone**, and adds "Only someone at the masjid can turn it back
  on." A tunnel request no longer feeds `observeDashboardHost`.
- `auth.setup` and the first-run restore routes refuse tunnel traffic outright. The second factor
  lives in its own file, so a box whose admin record went missing would otherwise have offered
  first-run setup — reachable over the tunnel since dev.13 — and now first-run restore to the
  internet; `remoteAdminEnabled()` requiring an admin (`isConfigured`) closes the same gap from
  the other side.
- **Migration — Development only; none of this reached Stable.** dev.13–15 served the remote
  dashboard at the apps' hostname. After updating to dev.16, every dashboard path there answers the
  ordinary 404 — recorded as `no-admin-host` while no Dashboard address is set (the tunnel, the
  switch and two-step sign-in are all still on; `doorClosedReason`), with a label saying to set it,
  and as `dashboard-elsewhere` once one is. There is no remote dashboard anywhere until the admin
  creates the second Cloudflare hostname and enters it under Dashboard address. Settings says the
  same under the switch ("Give the dashboard an address of its own first"). Only the masjid's
  network can do that: `adminHost` is written by `cloudflare.save` (and by a restore), both
  reached from outside only through the remote dashboard, which stays off until it is set — and
  `cloudflare.save` refuses to change it from outside anyway; a tunnel pointed at the dashboard's
  own port is refused by `registerHandoffOnlyGuard`; no WhatsApp command, installer option or other
  route sets it; and the field does not exist before this build, so it cannot be filled in ahead of
  the update either.
  dev.13–15 could not run an update from outside (`/api/update` was on the LAN listener alone), so
  in practice this update is started at the masjid — but one started another way (the installer
  over a remote shell) leaves a remotely-managed box unreachable from outside until someone at the
  masjid enters the address. **Not implemented:** an alert, a dashboard notice or an installer
  option for this move, so whoever updates such a box has to be told. The switch is left on, so
  entering the address is all it takes; sessions from those builds carry no `remote` flag, so a
  fresh sign-in is needed anyway.
- Comments that no longer matched the code were corrected, with no change in behaviour: the refusal
  record and `cloudflare.refusals` are for any signed-in admin, not the LAN alone; the logo routes
  are reachable from outside only through the hand-over; the comment on starting the tunnel says the
  tunnel-facing port hands the dashboard over through the gate, rather than serving app paths alone;
  `/api/fabric/site`'s `basePath` can be `<id>-N`; and the `emailBinding` comment no longer claims
  the binding stops a dashboard session at the masjid from reaching remote access — such a session
  can download a backup, which holds the authenticator's secret, and what two-step sign-in protects
  is remote access from someone who knows the password but cannot reach the masjid's network. Later,
  likewise: three doc comments that had slipped above the wrong function are back above their own
  (`isBareAppAddress` in `system/ingress.ts`, `holdSecondFactorEpoch` in `auth/twofactor.ts`,
  `requestUser` in `api/ws-auth.ts`); `responseHeadersForTunnel` no longer says an app's bare
  address is redirected; the `routes` comment in `trpc/routers/cloudflare.ts` names the second
  hostname, for the dashboard; the `system/cloudflared.ts` header no longer calls path-based routing
  a planned enhancement; `Tracked.token` in `system/remote-sockets.ts` and the `claimUpgrade`
  comment in `index.ts` say a dashboard socket is handed over only to a signed-in remote session;
  `Viewpoint.remote` in `ui/src/lib/app-url.ts` says it follows the hand-over; the Settings
  `TunnelRefusals` comment no longer puts the list behind a LAN-only dashboard; and a test title in
  `tunnel-refusals.test.ts` now says the record is readable by a signed-in admin, not over the LAN
  alone. And last: the `api/branding.ts` header says the same of the logo routes as `index.ts` does;
  the `index.ts` header describes two listeners, not one server on one port; the
  `stripe/disputes.ts` header counts `/_omos/open` among the public routes;
  `FIRST_REMOTE_ADMIN_VERSION`'s says dev.13–15 served the dashboard beside the apps (not that they
  could not be managed from outside) and that its guard covers the dashboard's update and channel
  switch, not a root terminal; the `trpc/routers/twofactor.ts` header names `confirm` as the one
  change without `requireSudo`, by design; and the `CloudflarePanel` comment says a refused save
  refreshes the status while the fields keep what was typed. After a further review: comments that
  had drifted away from their code in `Dashboard.tsx` and in `index.ts`'s not-found handler are back
  beside it; the Dashboard's comments say "Settings → Advanced", not a "Settings → Updates" that
  does not exist; `recreateCore`'s comment no longer claims dashboard updates never pull the
  channel's alias; `system/restore.ts`'s comment on keeping the restoring admin signed in no longer
  gives a wrong example; and the `SELF_REMOVING_WORKER` comment in `system/ingress.ts` states its
  residual (below).
- **Accepted residuals and honest limits.** The apps share ONE origin with each other on the apps'
  hostname, so isolation between apps is weaker than on the LAN, where each has its own port: a
  malicious app's page could act within another app the admin has opened there — never as the
  dashboard. A WebSocket's `101` response is relayed verbatim, so its `Set-Cookie` is not filtered.
  Only sockets are closed when a sign-in ends: a long-lived HTTP response — an app's event stream
  opened with the admin's token, or a download from the dashboard — runs on until it ends. A
  masjid's own LAN reverse proxy sending `x-forwarded-proto: https` is still treated as tunnel
  traffic by the security rules — signing in through it asks for the second factor (and is refused
  while none is enrolled), and a password-only session presented through it reads as signed out —
  though no longer by what the dashboard does differently from outside (Remote sessions, above).
  `/_omos/open` does not check that it was asked for on the apps' hostname, so a ticket spends just
  as well on any other hostname routed to the tunnel but the admin one (the dashboard only ever
  builds the link on the apps' one); and while the door is open a bad ticket gets the 410 page where
  a shut door gives the ordinary 404, so a stranger can tell whether remote administration is
  switched on. A restore brings back the backup codes as they were when the backup was made, so
  codes used or replaced since then work again; a restore from outside compares only the
  authenticator, so it does not stop for that. Cloudflare's free plan refuses request bodies over
  100 MB, and Cloudflare drops a connection that stays silent for about 100 seconds, which a large
  install's backup download from outside can still hit while the app data is being copied. Apps that
  are not base-path aware break under `/<path>/`. An older configuration with emailed codes as its
  ONLY factor (Settings never offered it, but the API allowed it before this round) keeps working
  until the admin's address or mail account changes; then it pauses, remote administration closes,
  and turning it back on now needs an authenticator first — enrolled at the masjid. The worker that
  removes itself reaches only a worker whose script is AT a bare address: one an older build let an
  app register over the whole apps' address from a script under its own path (with
  `Service-Worker-Allowed: /`) now fails its update check, which leaves it running in the browsers
  that hold it until their data for the apps' address is cleared. A core pinned to a digest is still
  offered an update by the banner and the alert (`checkForUpdate` did not change); only the update
  itself refuses. A helper that never replaces the core leaves updates and restores refused — and,
  after a restore, every change from the dashboard — until the five-minute hold runs out. The File
  Explorer's own writes (uploading, renaming or deleting the masjid's files) are not refused during
  a restore; `config/` and the platform's per-app files are protected from it anyway. And
  `api/restore.ts` still closes 4002 ("stopped before it could finish") on an unexpected exception
  even when nothing had been changed yet — the cautious reading.
- **Tests.** New: `remote-apps.test.ts` (private apps and what apps receive, access tokens, tickets
  and `/_omos/open`, single sign-on with a token, caching, a private app's address answering exactly
  as an empty one — `/fabric`, broken and oversized bodies included — the bare app address (a
  worker's script answered there by one that removes itself, the same at a shared, a private and an
  empty address and on the masjid's network, and recorded only when it came from outside; nothing
  answered there cached; `isWorkerScriptFetch` and `isBareAppAddress` spelling by spelling),
  `isRouted` naming the holder, the eight-token cap, the session rule in tRPC and the raw routes,
  the per-call and per-keystroke re-checks, a reverse proxy on the masjid's own network not counting
  as outside, a sign-in made through one never usable from outside, and a browser that leaves
  part-way ending the app's response), `remote-restore.test.ts` (`remoteRestoreProblem` against real
  files — the live rule, the username, an authenticator on both sides — that it runs before anything
  is stopped or replaced, the epoch hold, a sign-in during a restore bound to the held epoch, how a
  restore ends and is reported, a backup with nothing to restore stopping no app, a restore whose
  app data did not all come back ending as `restarting-with-problems` with the core recreated on the
  build it was running, the epoch renewed and only the restoring admin moved onto it, an app that
  did not start reported to the dashboard until a clean restore clears it, "restored but not
  restarted" told apart from "stopped part-way", a caller shut out while it ran not carried back in,
  and — after a further review — a restore that restarts the core keeping its lock until the core is
  replaced, one refused for an update in its way saying so and leaving no backup behind, nothing
  changed from the dashboard while a restore runs, its settings put in place at once, an app that
  could not be paused not "complete", an unfinished restore's leftovers removed at boot, neither the
  offline alerts nor the off-site backup running during a restore, and a restored app's compose
  checked the moment it is in place), `remote-backup.test.ts` (headers first, a browser that leaves
  before or part-way ends the backup, one case with the real backup and real tar, and a backup tar
  failed never delivered as a whole file), `remote-settings.test.ts` (a refused save changes
  nothing, the dashboard address locked from outside, a dev.13–15 box recorded as `no-admin-host`,
  one rule for the live box and a restore, `normalizeTunnelToken` — a token missing its "=" padding
  repaired, the same bytes spelt any other way refused — a paste that is not a whole token refused
  at the masjid and a different token refused from outside, a tunnel stuck restarting shown as
  neither running nor turned off but "isn't connecting", "from outside" meaning the hand-over, and
  the panel sending each address only when edited), `remote-update.test.ts` (`managesFromOutside`;
  from outside, an update and a channel switch to a version that cannot be managed from outside — or
  whose version cannot be read — refused before anything is downloaded or saved, while at the masjid
  both go ahead; the update window's close codes; a version that cannot be read never "already up to
  date"; an app's update window reading the server's codes; a restore coming back on the running
  build whatever the compose file says; an update whose helper could not start putting the compose
  file back; the installer's Update downloading before it writes the compose file; a core pinned to
  one exact build not "updated" onto that same build; and both windows counting the core as down
  only after two failed checks, the restore window ending on `lost` when its stream dropped) and
  `app-paths.test.ts` (`setAppPath`'s refusals, reserved words, the address an install is given, and
  only an app path's shape ever routed). Updated: `front-door-websocket.test.ts` (two hostnames, the
  progress streams handed over, a private app's socket with its token, the cookies an app receives,
  sockets closed when the door shuts or the session ends, dot-segment spellings that must not tell a
  private app from nothing, no dashboard socket for a stranger, the 1 MiB message cap, the bounded
  socket table and the apps' share of it, an app socket opened with the admin's token closed at both
  ends when that sign-in ends while a public socket's app end is left open, and a quiet dashboard
  socket pinged), `remote-admin.test.ts` (the five conditions, `isAdminHost` / `validateAdminHost`,
  the dashboard never on the apps' hostname, the hand-over, `registerHandoffOnlyGuard`, the body
  limits and the 415, the lazy dashboard socket), `twofactor.test.ts` (the epoch, the emailed-code
  binding, `sameSecondFactorAs`), `twofactor-router.test.ts` (the caller keeps their session through
  a factor change, the race in `requireSudo`, emailed codes never the only factor, the panel told
  which is missing — the mail account or the address — and nothing about the factor changing during
  a restore, before it holds the epoch as well as while it does — no code spent, and one that begins
  while the password is checked caught after it), `tunnel-refusals.test.ts` (one page from every
  refusal; all ten reasons, read from the type, each with its own words), `remote-login.test.ts`
  (first-run setup and restore refused from outside), `credential-binding.test.ts` (re-anchored to
  `createSession`'s third parameter, and the full sign-in reset turning two-step sign-in off, driven
  through the real tool's prompts), `audit-hardening.test.ts` (re-anchored to the new WebSocket
  branch, and `X-Forwarded-Prefix` stripped on every proxy path), `update-lock.test.ts` (the update
  dialog locked only while it runs and while the core restarts, a core update, a restore and an
  app's update never overlapping, a core update or a restore keeping its lock until the core is
  replaced — refusals meanwhile saying it is restarting to finish — and no app started, installed or
  removed under a restore or its own update, while stopping never is), `files-guard.test.ts` (a
  backup waiting to be restored, and its unpacked copy, private), `update-idempotent.test.ts` (an
  unreadable version pulls nothing on the same channel and is never "up to date"),
  `update-channel.test.ts` (re-anchored to `publishedVersion`), and `update-rollback.test.ts` and
  `app-stayed-up.test.ts` (re-anchored to the update's new return values). All are registered in
  `packages/core/package.json`; the cases that need GNU tar or a POSIX shell skip on Windows and run
  in WSL. The fixes from that further review were mutation-checked — all 51 deliberate breakages of
  them caught, each test file passing first — and a run of the real built daemon, against a stand-in
  Docker that refills a volume slowly and refuses to stop one app, showed them end to end: the
  pinned core's update refused with nothing asked of Docker; mid-restore, Start, a setting, a new
  password, removing the logo and a second upload all refused while `auth.me` still answered and
  nothing was started; the restore closing 4003, the report naming the app it could not pause; the
  restored setting in use at once; no `.restore*` file left; after the hand-off, an update, Start
  and a new upload each answered with the "restarting to finish" message; and leftovers planted
  before a restart removed at boot.

### Signing in to apps

- **Opening an app from the dashboard signs you in reliably now.** Sometimes an app would ask for
  a password instead, tell you to "press the app from the OS" — which you just had — and then refuse
  its own password too, leaving no way in. There were four separate reasons, all fixed:
  - **Updating or restarting OpenMasjidOS signed you out without telling you.** Your browser kept
    you signed in for a week, but the server forgot you on every restart, so the next app you
    opened was handed a sign-in that no longer worked. You now stay signed in across updates.
  - **A busy app could block the sign-in check.** If an app had just sent a lot of messages, or
    another app was busy, the check that signs you in could be turned away for up to a minute.
    It now has room of its own, so nothing else can crowd it out.
  - **The dashboard didn't notice when you had been signed out**, so pressing Open again just
    repeated the problem. It now checks whenever you come back to it, and asks you to sign in
    again if you need to — after which opening the app works.
  - **After restoring a backup**, apps could fail to sign in until something else was changed.
- When a sign-in check does fail, OpenMasjidOS now writes down why, so it can be looked into
  instead of guessed at.
- **Signing in from outside the masjid over a plain address** (`http://`) now switches to the
  secure `https://` address automatically. Before, your password could travel unencrypted, and
  the sign-in would not stick anyway.
- **Resetting your password with the installer now takes effect straight away.** Before, the old
  password kept working — and anyone already signed in stayed signed in — until the dashboard
  restarted at the very end of the reset, after every app had been reinstalled. That gap was the
  one moment a reset exists to close.
- **Changing your password now also cancels any sign-in that was half-way through.** A sign-in
  waiting for its two-step code, or one being checked at the instant the password changed, used to
  be allowed to finish with the old password.
- **Two password changes at the same moment** no longer both go through. The second is told the
  password was just changed somewhere else, instead of quietly replacing the first.
- **Restoring a backup no longer signs you out part-way through**, which used to close the window
  showing whether the restore worked. You are asked to sign in again once it has finished.
- **Only one restore can run at a time**, and its window stays open until it has finished.
  Closing it and choosing a file again used to start a second restore over the first, which
  could leave every app switched off.
- **If the disk is full when you change your password, nothing changes.** Before, the change
  failed but half-happened: you were signed out, your old password was refused, and the new one
  stopped working after a restart.
- **Remote access fixes for Development builds 13 and 14:**
  - With **Manage OpenMasjidOS from outside** switched off, parts of the dashboard could still be
    reached from the internet by writing its address in an unusual way. They can't any more.
  - Apps that keep a live connection open (live displays, anything that updates without
    refreshing) stopped working over your public address. They work again.

**Technical detail** (for whoever cuts the release):

- Sessions are bound to the password that was **proved**, not the password current when the
  session is written: `verifyCredentials` captures the hash before argon2 and returns its
  fingerprint, `login` refuses if it no longer matches, a tunnel challenge carries it and
  `completeLogin` refuses a stale one with `restart: true`. `changePassword` re-reads after
  hashing (CONFLICT on a concurrent change) and clears pending challenges.
- `auth/store.ts` re-reads `auth.json` when its inode/mtime/size changes — at most once a second,
  and always before a password check or a write. Only a good read is adopted; a missing or damaged
  file never re-opens first-run setup. A restore holds the store and refuses account writes.
- A restore leaves `config/sessions.reset`; the next boot starts with no sessions.
- The front-door gate decides whether to look at a request with `touchesDashboardPath` (ANY
  spelling); serving the SPA from the front door needed `isDashboardPath` (EVERY spelling) until
  dev.16 stopped the front door serving one (see the technical detail above). `/%74rpc/auth.me`
  reached tRPC over the tunnel with the feature off, because one predicate answered both questions.
- `@fastify/websocket` is no longer registered on the HTTP front door; it routed every upgrade
  through Fastify, so app sockets were handled twice. The ingress listener is the one upgrade
  owner and claims the dashboard socket via `claimsDashboardSocket`, which asks the same
  `frontDoorDecision` the HTTP gate does.
- A third review: `createSession(username, cred)` now takes the fingerprint of the hash that was
  verified (or just set) instead of reading the current one, and the checks after argon2 and
  after a second factor read FRESH (`freshCredential`) — the throttled copy could be a second
  stale after a reset written by another process. `requireSudo` (the two-step settings'
  password re-check) reads fresh and re-compares after argon2, like sign-in.
- `auth/store.ts` writes first and only then updates memory, so a failed write (ENOSPC) leaves
  memory and disk agreeing; a read that failed at boot is retried rather than trusted for the
  life of the process; the restore hold is owned per restore (`holdForRestore` returns its
  release) instead of one shared flag.
- Restore is single-flight on the server (`withUpdateLock('restore')`), the upload refuses with
  409 while one runs, the restore dialog is locked while streaming, and a volume archive that
  cannot be read now fails that volume instead of hanging the restore.
- Both listeners refuse a request target that is not a path (`registerOriginFormGuard`).
  `GET http://host/trpc/x` was routed to `/trpc/x` while every guard read its first segment as
  `http:`. Not reachable through the tunnel; closed because every guard assumes a path.
- The ingress test pin is re-checked after rebuild's await. On CI, where Docker answers, a
  rebuild already in flight replaced the pinned routes and the WebSocket test failed.
- A fourth review: the request-target guard CLOSES a refused WebSocket upgrade instead of
  answering 400 — on the dashboard listener `@fastify/websocket` only destroys the socket from
  its own hook, so the 400 left it open for good; a password file that cannot be read is no
  longer treated as a password change (sessions are held, not honoured and not discarded, until
  it reads again, and the boot load retries the read first); an unreadable volume archive ends
  tar's input (`docker run -i` forwards SIGTERM to a PID-1 tar that ignores it);
  `createSession`'s credential is a required parameter; the WebSocket test measures the server
  side with a raw socket rather than the `ws` client, which hides a server that answers and
  leaves the connection open.
- New tests: `credential-binding.test.ts` (which now drives the real `reset-password` tool
  through its prompts), `front-door-websocket.test.ts`.

### Security and dependencies

- Updated bundled libraries to pick up security fixes — among them the web server itself, the part
  that sends your email and the part that reads uploaded files. Nothing about how OpenMasjidOS
  works changes.

**Technical detail** (for whoever cuts the release):

- dev.11 (`c19ccec`): nodemailer 9.0.3 → 9.1.1, fast-uri 3.1.5 → 3.1.8, browserslist 4.28.2 →
  4.29.1 and baseline-browser-mapping 2.10.38 → 2.11.26, which cleared every high advisory at the
  time.
- dev.16: `fastify` `^5.1.0` → `^5.12.5` (lockfile 5.8.5 → 5.12.5, bringing its own fast-uri
  4.2.1 and fast-json-stringify 7.0.1, and moving process-warning 5.0.0 → 5.1.0) and `nodemailer`
  `^9.0.3` → `^10.0.15` (lockfile 9.1.1 → 10.0.15, a major version; it needs Node 20, which the
  image runs; `notify/email.ts` did not change, and `test/email-render.test.ts` is the test that
  drives nodemailer directly). A root `overrides` entry for `concurrently` moves `shell-quote` from
  1.9.0 to 1.12.0: concurrently 9.2.4 pins it exactly, so an override is the only way to move it,
  and it is development tooling (`npm run dev`) that never reaches the image. The lockfile also
  moved @fastify/busboy 3.2.0 → 3.2.2 (multipart uploads, through @fastify/multipart),
  @grpc/grpc-js 1.14.4 → 1.14.5 (through dockerode), brace-expansion 5.0.9 → 5.0.12 (through
  @fastify/static's glob, so it ships) and source-map-js 1.2.1 → 1.2.2 (the UI build only).
- `npm audit --package-lock-only`, run on 2026-10-06: dev.15's lockfile has 11 vulnerable
  packages — two critical (shell-quote, and concurrently through it), six high (fastify,
  nodemailer, @fastify/busboy, @grpc/grpc-js, brace-expansion, source-map-js) and three moderate
  (uuid, dockerode through it, and esbuild). This round's has only those three moderate ones. They
  are below CI's `--audit-level=high`, and dev.11 recorded why they are inert here: dockerode
  imports only `uuid.v4`, and the esbuild one concerns `esbuild serve`, which nothing here runs.
- **Never run `npm audit fix` in this repo.** At dev.11 its dry-run downgraded dockerode 4.0.12 →
  4.0.2 and tar-fs 2.1.4 → 2.0.1, landing three HIGH tar path-traversal advisories on the
  container-archive path of a daemon that runs as root with the Docker socket.

### Design system (in progress)

- The ⋮ menu on an app card and the account menu got their spacing and edges back — they had
  picked up the component toolkit's own look when they moved onto it, so the rows sat tighter
  and there was a faint double edge around the panel.
- A shell window now fills its window properly instead of leaving a band of empty space when
  you make it bigger.

Groundwork for one shared look across every OpenMasjid app. Almost none of it is visible yet,
which is deliberate: the foundations and the safety checks go in before anything is restyled.

- **One thing you will see:** in dark mode, red buttons — Remove app, and "Start anyway" on a
  held app — now have **dark text instead of white**. White on that red measured 2.77:1, well
  below the accessibility standard, on two of the most consequential buttons in the dashboard.
- Everything else so far is plumbing: the component toolkit's setup, the design tokens wired
  to it, and a shared package the other OpenMasjid apps will be able to use.
- Automatic checks now guard the things that break quietly — right-to-left layout, colours only
  ever coming from the one theme file, and text staying readable on every background.

- There is now a **Design system** page at `/design-system` showing every shared control in
  dark and light and in both left-to-right and right-to-left, so a layout problem can be seen
  in one place instead of hunted through the app.
- The first shared controls are in place (a switch, a checkbox, a label and a menu).
- **Every tickbox in the dashboard now matches the rest of it** — they were the browser's own
  grey-and-white boxes before, which looked different on every computer. The two that matter
  most are the ones confirming you want to delete an app's data or remove WhatsApp entirely.
- Fixed a bug where closing a dialog did not put the keyboard back on the button you opened
  it from — it looked right in the code and did nothing at all.
- Fixed a switch that slid out of its own track in a right-to-left layout. Every switch in Settings
  had it; with English the only language, only the Design system page shows anything right to left
  today.
- **Every dialog now keeps the keyboard inside it.** This matters most during an update: the
  dialog that says "do not interrupt" could be tabbed out of, and pressing Enter on something
  behind it navigated away and dismissed it mid-update. It cannot be now. Closing a dialog
  also puts the keyboard back on whatever opened it.
- **The two menus in the dashboard now work properly with a keyboard** — the ⋮ on each app card
  and the account menu at the top right. Arrow keys move between items, Escape closes,
  and the focus ring comes back to the button you opened it from. Screen readers announce them
  correctly for the first time. They should look the same as before.

*Full detail in `docs/design-system/MIGRATION.md`.*

### Security

- **An app restored from a backup can no longer be started without someone agreeing to it.**
  A restore writes `apps/` straight to disk **without** passing the install-time risk gate
  (`system/restore.ts` `rmSync` + `renameSync`). The gate ran afterwards in `reupAllApps`,
  which correctly refused to auto-start a dangerous stack — and then threw the verdict away,
  leaving an ordinary Stopped card whose Start button ran the unvetted compose. The core runs
  as root with the Docker socket, so a `privileged: true` smuggled into a handed-over backup
  was host root, with no warning at the moment of the click. The same ungated entry was
  reachable from `!os start` over WhatsApp and from the exposure toggle.
  - The verdict is now **persisted** (`AppMeta.review` = `{kind, reasons[], at}`) and cleared
    again whenever a compose passes, so a legitimate update or a corrected file is a way out
    rather than a dead end.
  - `startApp` **and `restartApp`** consult the guard themselves rather than each of their
    callers. Both, because `docker compose restart` starts a *stopped* container — so
    "restart" is a start path, and guarding only `startApp` left `!os restart` as a way round
    `!os start`. `stopApp` is deliberately not guarded.
  - Refusals (reaching into another app's `omos-*` volume) stay **never acknowledgeable**;
    a `danger` an app was legitimately installed with stays startable, as before.
  - **WhatsApp cannot acknowledge.** Possession of a phone must not be enough to consent to a
    root-capable compose, so `!os start` reports the hold and points at the dashboard.
  - **The check now runs the moment the backup's `apps/` is in place** (`reviewEveryApp`, before any
    app data is refilled), so the verdict on disk is this platform's from then on, not the backup's
    — and no app can be started at all while a restore runs, from the dashboard or over WhatsApp
    (`assertAppFree`; on the dashboard every change waits for the restore anyway).
  - Honest residual: an app restored by an **older** build carries no marker and stays
    startable; it gains one the next time a restore runs.
- New `test/app-review-gate.test.ts` (21 tests, registered, all eight defects below
  mutation-checked — each bug reintroduced, the test confirmed failing, then restored).

### Fixed during review of the above

An adversarial review of the first cut found four real defects in it, including one that made
things **worse** than the bug being fixed. Recorded because they are the interesting part:

- **The gate could be switched off by the attacker.** `reviewCompose` began with
  `loadMeta(id); if (!meta) return null` — and `meta.json` arrives in the *same* backup as the
  compose. One unparseable byte therefore produced "no finding", and the restore went on to
  **auto-start** the privileged stack, needing no click at all. The compose is now checked
  first and independently; `startBlockedReason` fails closed on the same input.
- **A pre-seeded verdict could downgrade a refusal to a tickbox.** The write was skipped when
  the reason *text* matched, so a crafted `kind: 'danger'` survived a real refusal. The
  computed verdict now always wins (kind and every reason compared).
- **`restartApp` was an unguarded start path** (above).
- **A throw in the review loop disarmed the gate for every later app.** Each app's review is
  now its own try/catch, failing closed.
- Also: only the first finding was persisted, so "I understand the risk" collected consent for
  a fraction of it; the dialog offered a tickbox for refusals, which the server always
  refuses, leaving the admin in a loop; and the body text claimed an app "asks for powerful
  permissions" even when the truth was that we could not parse the file at all.
- One of the *tests* had the same flaw it was written to catch: it matched
  `startApp(target.id)` as a substring of `restartApp(target.id)`, so it could never fire.

### Docs

- **Remote administration is written down** — as of dev.17, on one address with the key rule —
  in CLAUDE.md, `docs/REMOTE_ADMIN.md` (with the operator's steps and a section on moving a box
  from dev.13–dev.16), `docs/SECURITY.md`, `docs/ARCHITECTURE.md`, `docs/NETWORKING.md` (its
  remote-access section no longer says the dashboard is never exposed through the tunnel),
  `docs/FABRIC_APP_LINK_AND_TUNNEL.md` and `docs/APP_MANIFEST_SPEC.md` (which now tells app authors
  that their pages share the dashboard's origin, lose any opener policy, and may not take the
  dashboard's page paths).
- **`CLAUDE.md` §15: three claims corrected.** Each asserted a containment that does not hold,
  which is worse than a documented gap because it is what stops anyone re-examining it.
  - The `startApp` bullet said restore passes the compose gate. It does not (above).
  - The "could not ask Docker" bullet said the lossy `listInstalled()` feeds only display
    paths. `system/address-monitor.ts` and `restoreAppProxies` both still **decide** from it —
    now recorded as open, rather than implied fixed by a count.
  - The Stripe bullet said a per-app account binding "changes the app-facing Fabric contract"
    and needs a coordinated cross-repo change. An **admin-recorded** binding is purely
    platform-side and changes nothing an app calls; only a manifest-declared one would.
    That framing is what has deferred the gap since 2026-07-30.

### UI

- Apps held for review carry a tag on the card and a panel on their page listing **every**
  thing the app asked for, in the gate's own words. Start opens a confirmation that has to be
  ticked — one shared `AppReviewDialog`, because a consent step that differed between the two
  Start buttons would be a security difference decided by which one the admin happened to press.
- An app that can **never** start (it reaches into another app's data) says so instead: the
  tag reads "Can't be started", the action reads "Why it can't start", and the dialog explains
  and offers only Close. There is no tickbox, because ticking it could never have worked.
- New `--color-danger-subtle` and `--color-danger-ink` tokens in both themes. The ink is
  separate because the themes need different answers: on the wash, dark's `#F87171` measures
  4.99–6.19:1 but light's `#DC2626` only 3.84–4.19:1, under AA for the tag's small bold text.
  Light now uses `#B91C1C` (5.14–5.61:1).

### Full audit: bugs, stale code, readability and speed (dev.18)

A sweep of the whole platform, area by area. Every fix came with a test that fails without it
(each one checked by putting the bug back), and nothing that worked changed behaviour.

#### Managing from outside, and the front door

- **From outside, an address the dashboard doesn't know is a plain 404 — never the plain
  dashboard page.** A missing `/assets` file, or an address like `/x/../settings`, got
  `index.html` without the headers that stop an app page framing it, and signing in on such a
  framed page stored the dashboard key where that app could read it.
- **A missing bundle is a 404 everywhere**, so a tab left open across an update fails cleanly
  instead of loading the page as if it were JavaScript.
- The remote dashboard's pages keep `X-Frame-Options: DENY`; the listener's catch-all header
  overwrote it with `SAMEORIGIN`.
- **Terminals keep what you type while the shell starts** (the first resize was dropped), and a
  shell whose browser left in the meantime is closed instead of left running.
- **One request carries at most 40 calls** (the dashboard splits at 20). A single batched request
  could carry hundreds of sign-in attempts past every per-request check, each an argon2 run.
- A socket from outside is tracked only with a live remote session, and a multipart upload from
  a stranger is refused before anything reads it.
- The front door asks whether managing from outside is on only for a tunnel request to a
  dashboard address, not for every app page and Fabric call.

#### Signing in

- **The per-address lockout really bounds guessing from outside now.** A right password cleared
  the address's failures, wrong codes included, so anyone holding the password could alternate
  and guess codes without limit; and the lockout was asked only on arrival, so a batch of
  sign-ins all got past it before any had failed. Failures are cleared only once the code is
  right, and the lockout is asked again when each attempt's turn comes.
- **The clock-skew note can't be used to find a working code.** When a wrong code matched a step
  still to come, the note said so and the same code was accepted when that step came round. Such
  a step is now refused as replayed; the note stays, because a drifted clock is why it exists.
- A sign-in whose password changed while it waited for its code no longer spends the code first.
- A backup code typed without its dash, or with a space, matches.
- When an emailed code couldn't be sent, asking again no longer says "a code was just sent".
- Signing in with an unreadable admin record says so, instead of "username or password is
  incorrect" to an admin retyping the right one.
- A WhatsApp number that isn't a whole number is refused, instead of silently clearing the stored
  one.
- The two-step settings are read again only when their file changes; they were read and parsed
  several times on every request from outside.

#### WhatsApp commands

- **A trustee added in Settings no longer vanishes at the next restart.** People are added with
  nothing ticked, and such a person was dropped on every load. They are kept, and until something
  is granted their messages get the same silence as a stranger's (new drop reason `no-grants`).
- Re-adding a listed number keeps their permissions. The list is written before it is believed,
  and a full disk no longer costs a command its answer.
- **A held confirmation answers its own question only.** Any other command abandons it, so a
  reflexive "ok" later can't stop the app asked about earlier, and a confirmation re-checks the
  sender's permission before it runs.
- `!os updates` numbers what it showed, so `!os update 1` means that row. An app the store can't
  answer for is never called up to date. `!os update` says when an app updated but isn't staying
  running, and its "finished" reply is no longer dropped after a long update.
- Read-only trustees aren't invited to send control commands; a command that exists but isn't
  granted is "not allowed", not "no such command"; naming the WhatsApp gateway gets its own
  refusal instead of "can't find it".
- "stop" or "cancel" said to a confirmation reads as cancelled, `!yes` with no code asks for it,
  `!exit` mid-exchange says the exchange ended, and a question that reaches the turn limit says
  to finish on the dashboard.
- A command behind a zero-width space (some phone keyboards add one) is no longer dropped; the
  rate limit keeps part-waited refill time; a long list keeps its closing line.
- Every app's commands are read once per message instead of once per step.

#### Fabric, email, alerts and payments

- **An app-to-app call always settles.** A reply over the size cap that arrived in several reads,
  or one trickled a byte at a time, hung for ever — leaking a socket, and leaving a WhatsApp
  command with no answer.
- **Apps no longer share one request budget.** Every app reaches the core from the same address,
  so one busy app emptied the per-address bucket and every app's email, WhatsApp, alerts and
  Stripe calls were refused for the rest of the minute. Only a caller with no valid secret pays it.
- **Email Save checks what sending will really do.** Resend sending-only keys (the least-privilege
  kind) now pass and invalid ones are refused; SMTP Save logs in with the same TLS rule as sending.
- App mail over 100 KB is refused (`too_large`), instead of being cut off mid-tag and reported
  sent.
- **An app's alert emails have their own budget**, so a burst from one app can't drop the
  platform's own — a chargeback alert is never retried. A restore's alert routing is used at once.
- Replacing a Stripe account's key starts a first check, instead of alerting every past dispute
  of the new account as new; a reply with no dispute list is "couldn't ask"; Settings → Payments'
  status dot follows a save.
- The address monitor keeps retrying apps it couldn't recreate when the machine's address changed.

#### Settings, stats, certificate and logo

- **A setting is believed only once it is on disk.** A failed write (a full SD card) showed an
  error but kept the change until the next restart.
- **Storage is measured on the filesystem holding the data**, as `df` does, instead of against
  every disk added together. On Ubuntu Server's default LVM a full volume read about 40%, so the
  low-storage warnings never fired. The host-OS reserve is 16 GB, or a quarter under 64 GB (a
  16 GB SD card read "6 GB / 0 B").
- Memory matches `free` on a bare-metal host, and the CPU figure no longer freezes when the clock
  is stepped back.
- **One stats collection is shared by every open tab**, and a stuck Docker, `df` or temperature
  probe can no longer freeze the cards.
- A certificate Node won't serve (a weak key) is refused, or replaced when found at boot; a new
  pair is checked before it replaces the working one; the self-signed certificate names the
  machine's LAN address.
- The logo: plain errors on upload, the old logo kept until the new one is in, and served from
  memory instead of read from disk on every request.

#### Installer, image and CI

- **Docker installs on Fedora 41+ and on Rocky, Alma and RHEL**, and a Docker that is installed
  but stopped is started rather than reinstalled.
- **32-bit ARM is refused before anything is installed**, with a pointer to the 64-bit OS.
- **The installer keeps the machine's channel and registry** even when its compose file is
  missing, and a fresh `--channel=dev` install is set up as Development.
- **Repair no longer moves the machine to a newer build**: it downloads only an image it doesn't
  have. **Reset sign-in works under `curl … | sudo bash`** (it reads the terminal). An unknown
  option is refused instead of ignored.
- **Remove turns the tunnel off**, and DELETE removes app data left behind by an earlier removal.
- After a slow start the installer stops with an error instead of announcing success, and it now
  says that apps' data lives in Docker volumes, so a backup is how to move machines.
- **The image runs on Node 22 LTS** (Node 20 is end-of-life). CI's token is read-only by default
  and the Docker actions are pinned to commits; the lockfile workflow, which committed straight to
  the stable branch, is gone.
- **A smaller download.** The image carries only the core's own dependencies, not the dashboard's
  (React and the rest are built into its static files): about 80 MB less on disk and 11 MB less to
  download. CI now starts each architecture's image and waits for `/api/health` before publishing
  anything, so a dependency missing from the image fails the build instead of reaching a masjid.

#### Backups, restores and the File Explorer

- **Every backup keeps every app's data.** A volume that an earlier restore created carried no
  Docker label, and backups picked volumes by that label, so every later backup left that app's
  data out while saying it had worked. Volumes are picked by name now, and a restore labels the
  volumes it creates.
- **A restore swaps each app's data in whole.** It used to unpack over what was there, which
  kept a newer SQLite `-wal` file beside the restored database (a corrupted database) and, on a
  failure part-way, left old and new mixed. Each volume is unpacked into a fresh folder and
  swapped in only once complete; one that fails is left exactly as it was.
- **A restore whose app data would fill the disk is refused before any app is stopped.** The
  data is measured unpacked, against the space left once the backup itself is unpacked.
- **An off-site backup can no longer hang everything after it.** When the destination stopped
  reading (a wrong password, a NAS gone offline) the backup waited for ever, and every later
  backup and restore was refused as "already running" until a restart. A run refused because
  another was running is no longer recorded as a failure, and whatever a failed run left on the
  destination is removed.
- **Updating OpenMasjidOS waits for a backup being made**, instead of cutting it off half
  written. A backup cut off by a restart leaves no copy of the apps' data behind.
- **File Explorer:** app folders open again (they were drawn as locked); the editor never writes
  through a link (a dangling one created its target wherever it pointed, `config/` included); an
  upload replaces a file only once it has all arrived (a cancelled one used to leave half a
  file); a download keeps its real name ("Jumuah notes.pdf", not "Jumuah%20notes.pdf"); and a
  folder of thousands of photos no longer stalls the dashboard while it is listed.
- Settings → Advanced shows the machine's address on the masjid's network; it showed the
  container's internal address and a `.local` name nothing answers to.

#### Apps

- **A setting reaches the app exactly as typed.** Values went into the app's settings file
  unquoted, where Docker Compose reads `$` and `#` specially: a password `pa$$w0rd` arrived as
  `pa$w0rd`. Such values are quoted now (plain ones are written as before), and the platform's
  own rewrites of that file change only their own lines.
- **When Docker refuses to start, stop or restart an app, you are told** — on the dashboard and
  over WhatsApp — instead of being told it worked; an app that is down is never reported as
  having stayed up; removing an app no longer emails "has stopped".
- **An app whose address the dashboard has since taken** (`store`, `apps`, `files`, `settings`,
  `design-system`) is moved to a free one, so its links and QR codes stop opening the dashboard.
- **After a reboot, apps' HTTPS addresses come back even when Docker answers late.**
- **An app whose record can't be read is held for review**, instead of a fresh record being
  written over it — which let a crafted backup start a privileged app with no warning.

#### The dashboard and Settings

- **Errors follow one rule**: the server's own message, or a plain fallback — never a dropped
  connection's or Cloudflare's own error text.
- A refused webhook save no longer goes on to test the old webhook and say "sent"; the Advanced
  switches say when they were refused; Account shows what was actually stored; regenerating the
  certificate and removing the backup destination ask first.
- Forms send only what was edited, so a change made on another device is not put back.
- Every Settings label is tied to its box, and selection buttons say which one is chosen.
- Escape no longer closes a window when a menu or a text box used it (unsaved file text, a live
  terminal); a saved file shows its new text when opened again; windows end with the sign-in.
- **If OpenMasjidOS can't be reached when the dashboard opens**, it says so and keeps trying,
  instead of showing the create-the-admin-account screen; a page left open across an update
  offers to reload instead of going blank.
- A community app is no longer labelled Official on its own page, and its install lists the
  risks before asking you to accept them.
- **A 0 typed at the start of a phone number after its country code is left off** (Italy keeps
  it): +44 07700 900123 was stored as a number WhatsApp doesn't know, so alerts to it vanished.
- Storage names the disk's size when it is clearly bigger than the usable total, and Stop and
  Restart say when Docker refused them.
- Window title bars drag by touch, the background video stands still under reduced motion, and
  arrows point the right way in right-to-left languages.
- Settings is one file per panel now (`routes/settings/`), with nothing changed in what it does.

#### WhatsApp

- **Discarding held messages while one was sending dropped a different, newer message** unsent;
  only the discarded ones go now.
- **A send that times out is never repeated.** It was retried up to five times, which could put
  five copies into a group; sends now get two minutes, and one that still times out is reported
  as possibly delivered.
- The 24-hour limit on a held message applies all the time, not only at start-up, so a long
  gateway outage no longer ends with the whole backlog sent back to back.
- Turning WhatsApp off clears a "WhatsApp is down" banner that otherwise stayed for ever, and
  deleting everything also forgets the pause (the first message after setting up again was held).
- "N may not have arrived" no longer reads 0 after a weekend outage.
- **A number starting with 0 is refused at the door** ("needs a country code") instead of being
  accepted and never delivered.
- The commands connection respects a rejected key or an unlinked phone between checks, and a
  trustee writing from a privacy id is no longer ignored until a restart after one failed lookup.
- "Send test" before a phone is linked says to link one; "a phone is already linked" points at
  Settings → WhatsApp → Unlink.
- A full SD card no longer stops the health monitor between pausing the queue and telling you.
- The WhatsApp gateway client is its own file now (`notify/whatsapp-gateway.ts`), apart from
  the queue, with nothing changed in what it does.

#### Plain words

- **The dashboard says what to do, not how it works inside.** 71 messages and hints were
  rewritten — about sessions, gateways, routes, tokens and how a backup is checked — keeping
  every warning. The WhatsApp gateway is called OpenWA everywhere, the name you install.
- The update, app-update and restore windows show plain progress instead of Docker's own
  output, with a "still working" line every 30 seconds during a long download. That output
  goes to the server log, where whoever helps you can still read it.
- The File Explorer and the off-site backup's Test say what to check instead of showing
  the system's or rclone's own error text.

#### After the final review

- A phone number pasted with `+44 (0)…` or typed as `0044 …` is stored correctly; both used
  to give a number WhatsApp does not know.
- Moving between Settings sections no longer reloads Settings, which could drop a restore
  upload part-way.
- Stop and Restart on an app's own page say why when they are refused.
- The Storage card no longer adds "of disk": inside a container it named the host's disks.
- Installing a community app waits for its safety check, and a check that fails can be retried.
- A backup asked for during an OpenMasjidOS update is refused with a reason, rather than cut
  off when the update restarts the dashboard.
- Moving an app off an address OpenMasjidOS took for itself writes nothing while a restore runs.

#### Speed

- The dashboard's bundles are compressed when it is built and sent compressed to browsers on
  the masjid's network.
- The logo image went from 146 KB to 18 KB and the favicon from 196 KB to 2.4 KB; live stats
  pause in a hidden tab; the dashboard prefetches less; the saved theme is applied before the
  first paint.
- Queued WhatsApp images are written once, to `config/whatsapp-media/`, instead of being written
  again — up to 11 MB, onto the SD card — with every message sent.
- A backup's outer archive uses fast compression (the app data in it is compressed already),
  and Docker no longer logs every volume archive.
- Stats, the two-step settings, the logo and one app's row are no longer re-collected or
  re-read on every request (above).

#### Removed

- Unused dependencies `qrcode`, `@types/qrcode` and `class-variance-authority`; the
  `CATALOG_URL` and `MACHINE_HOSTNAME` constants; the commands routes `renamePerson` and
  `preview`; the WhatsApp router's `save.limits`, `get.defaults` and `recheck`; the network
  info's `hostname` and `port` and the channel's `branch` and `imageTag`; the parser's
  unreachable `too-long` branch; unused styles, strings and types; test hooks nothing used;
  copies of the cookie parser, the path-spelling helper and the app-listing loop; and comments
  still describing the two-hostname design, removed WhatsApp limits, or features that had since
  changed.

## 0.51.1

A maintenance release. Most of it is work you will not see — a full review of the
whole project turned up a set of problems before any masjid ran into them — but a
few of the fixes are things you would have noticed.

**Things you may have run into**

- **Buttons showed no icon until you hovered over them.** The "Update now" icon was
  being drawn in exactly the button's own colour. Choosing any accent other than the
  default also made light mode's buttons hard to read, because the accent changed the
  button but not the writing on it.
- **Dialogs could open behind a window.** If you had a log, terminal or file window
  open and then confirmed something, the dialog appeared behind it — the screen
  dimmed and nothing else happened, which looked like a freeze. One press of Escape
  also used to close two things at once.
- **Renaming a file needed a mouse.** The rename box could not be reached with the
  keyboard. Escape now cancels a rename.
- **WhatsApp could not be told it was working again.** After OpenMasjidOS detected
  that your WhatsApp link had dropped, releasing your held messages simply had them
  held again a few minutes later, with nothing on screen explaining why.
- **Update emails could repeat.** If your internet was down when OpenMasjidOS checked
  for an update, it treated that as "nothing new" and forgot it had already told you
  — so the same update was emailed again once the connection returned.
- **A phone number that was not on WhatsApp when first checked stayed refused**, even
  after it joined.

**Keeping your server safe**

Several ways in were closed before anyone found them. In plain terms: the file
browser could reach the file that defines OpenMasjidOS itself, and could delete an
app's folder wholesale; an app could describe itself as official and be published to
the internet without being asked; and a stranger could hold connections open through
your remote-access link. None of this was reported by a masjid — it came out of a
review — and none of it needs anything from you beyond updating.

**Reading the documentation**

If you or a volunteer has ever read the project's own documentation, parts of it
described software that was never built — wrong colours, wrong addresses, features
listed as missing that have shipped for months, and settings that do not exist. It
has been checked line by line against the code and corrected.

## 0.51.0

**Run your masjid's server from WhatsApp**

- **An authorised phone can now do things by sending a message.** `!os stats` for how the
  server is doing, `!os apps` for what is running, `!os restart 2` to bring a stuck display
  back, `!os update 3` to update one app — and each app can offer its own commands under
  `!<app>`. This is for the box in the cupboard: fixing a wedged screen no longer means being
  at the masjid with a laptop.
- **Off until you turn it on, and nobody can use it until you add them.** Settings → WhatsApp →
  Commands. The warning there says it plainly: whoever holds one of those phones can start,
  stop and update your apps, with no password step. Each person gets a tick per app, plus a
  separate "view" and "control" for the server itself.
- **A number that is not on your list gets no reply at all** — not even a refusal. Answering
  would confirm to a stranger that this number runs your server.
- **Ordinary conversation is untouched.** Every command starts with `!`; anything else is not
  read as a command, not logged and not replied to. Commands sent in a group do nothing.
- **An app can ask you a question and you just reply.** `!display schedule-iqamah` → "Which
  prayer?" → `Maghrib` → "What time?". Send `exit` to leave it, or ignore it and it lapses on
  its own. Every mutating command also emails you, so you find out even if it wasn't you.

**Fixed — light mode is readable again**

- **Light mode was putting dark text on a dark background, whichever wallpaper you picked.**
  The light theme had its own pale backdrop all along, but every wallpaper was defined as a
  dark one and quietly overrode it. Each wallpaper now has a light version that keeps its
  colour — Ocean is still blue, Forest still green — so the picker means the same thing in
  either theme.

**Fixed — being told the truth about updates**

- **Updating an app said "Done" even when the new version could not start.** Docker counts an
  app as started the moment its container is created, so an app that boots, fails, and
  restarts for ever looked like a clean update. It now waits to see whether the app stayed
  running, and if it didn't, says so and shows the last thing the app printed.
- **Returning to Stable no longer says your apps are "moving to the Development version"** —
  the exact opposite of what it was about to do.
- **`!os update` no longer refuses with "I've hit today's WhatsApp limit".** It was checking a
  sending allowance that replies never use, which blocked real work for no benefit. Asking to
  update an app that is already current now simply says so.
- **After typing a pairing code, the page tells you the moment your phone links** — with a
  confirmation, instead of leaving you to reload and guess.

**Fixed — accessibility**

- **"Reduce motion" is now honoured everywhere.** Panels, dialogs and the opening animation
  respected the setting in some places and ignored it in others; if you have asked your phone
  or computer for less movement, the dashboard now listens throughout.

**Security**

- A full audit of the whole project. Nothing here was known to have been used against a
  masjid, and none of it was reachable from the internet without remote access switched on —
  but four ways of slipping past a check have been closed, including one that let a specially
  written web address skip the dashboard's protection against requests from other sites, and
  one that let anything on your network choose the visitor address your apps recorded.
- **Worth knowing if you use more than one Stripe account:** an app you install can currently
  read the keys for *all* of them, not only its own. Everything involved stays on your local
  network, but if you keep separate accounts for, say, school fees and general donations,
  treat each Stripe app as having access to both. Fixing it properly needs the apps updated at
  the same time, so it is deliberately not in this release.

**Documentation**

- A sweep of every page. Several described things that were never built — the setup guide
  promised an `openmasjidos.local` address and an installer that configures a fixed IP, and
  the networking page gave the wrong address for the dashboard entirely. All corrected to what
  actually ships, and the 0.50.4 release notes, which were missing from the Development
  channel, are back.

## 0.50.4

- **Coming back to Stable now finishes.** Returning from Development builds could get stuck in a loop: your apps and OpenMasjidOS would update, the dashboard would restart, and after signing in the whole thing would start over. It now runs once and stops.
- **OpenMasjidOS no longer reinstalls the version it is already running.** Asking it to update when there is nothing new tells you so instead of restarting the dashboard for no reason.

## 0.50.3

- **Fixed a fault that could stop a new version from being published at all.** The build for Raspberry Pi hardware could stall indefinitely, so an update could be announced and then fail to download. Both kinds of hardware are now built directly, and a stalled build fails quickly instead of hanging.
- **Security updates to two libraries OpenMasjidOS is built on** — the dashboard's page router and an internal id generator. Neither problem could be reached the way OpenMasjidOS uses them, but we keep these current rather than waiting until one can be.

## 0.50.2

- **Updates now install the exact version they told you about.** OpenMasjidOS was fetching whichever build was newest at that moment, which on rare occasions was a different one — so an update could appear to succeed while leaving you on the previous version, and keep offering itself. It now downloads the precise version named in the update, and says plainly if that build is still being prepared.

## 0.50.1

- **The "no apps yet" panel now shows the OpenMasjidOS logo** instead of a generic masjid drawing, so it matches the mark on your dock, login screen and splash.
- Behind the scenes: a build fix so a released version number always points at the exact build that was published. Nothing you'll notice.

## 0.50.0

- **Development builds now have version numbers, and updates work exactly like Stable.** Before this, a Development build carried the same version number as the Stable release it came from, so there was nothing to compare and nothing to tell you about — no notification, and an update button with nowhere to go. Development builds are now numbered (like the `0.50.0-dev.1` above), so you get the same "a new version is available" message, the same email, and the same one-click update as on Stable.
- **You are told when a new Development build is ready.** Properly, and only when there genuinely is one.
- **An update installs the exact version you were told about.** Previously it fetched whichever Development build happened to be newest at that moment, which could be a different one from the version in the message.
- **If a build is still being prepared, it now says so** instead of blaming your internet connection.

## 0.49.3

- **Development mode now actually runs Development builds.** Switching to Development downloaded the new version but then started the old one again, so the box stayed on Stable while the dashboard said Development — which meant none of the Development fixes could ever reach you, including the one that makes app updates work.
- **App updates on Development work again.** They were reporting "nothing was changed" even when a new build was waiting.

## 0.49.2

- **You are told when a new Development build is ready** — but only when there genuinely is one, not on a guess. On Development the version number never changes, so OpenMasjidOS compares the actual app image instead.
- **App update messages now say what they actually mean.** Moving an app to another channel was being shown as a version upgrade with an arrow, which produced nonsense like "v0.66.1 → v0.66.0". A channel move now says it is a channel move, and a Development build check says that, instead of pretending a version changed.
- **No more emails about updates that are not updates.** You are only emailed when an app genuinely has a newer version. Switching channel, and the constant "there might be a new Development build", are shown in the dashboard where they belong rather than sent to your inbox.

## 0.49.1

- **Switching to Development no longer means deleting and reinstalling your apps.** Each app now offers an Update that moves it to the Development version, keeping all its data and settings. Before this, because both versions carry the same number, the app said it was already up to date and there was no way across.
- **You choose which apps come with you.** Nothing moves until you press Update, so an app you would rather leave alone stays exactly as it is.
- **Coming back to Stable now puts everything back on its own.** Your apps are returned to their Stable versions one at a time, keeping their data, and OpenMasjidOS follows them back — no checklist to work through.
- **No more pestering about updates on Development.** There is no release to install on Development, so the dashboard now simply tells you that is where you are, and Settings offers to pull the newest build when you actually want it.

## 0.49.0

- **You can now choose between Stable and Development versions.** In Settings, under Advanced, pick which version of OpenMasjidOS and your apps this masjid runs. **Stable** is tested and is what we recommend — it is what you are on unless you change it.
- **Development** is what we are still building. It changes every day, it is not tested, and it can stop your apps working. We ask you to confirm before switching, and we tell you plainly what can go wrong.
- The choice covers everything together — OpenMasjidOS, the App Store and every app — so you are never running a mix.
- After switching, your apps stay as they are until you press update. Nothing restarts behind your back, so a prayer times screen will not go blank while you are reading the page.
- Coming back to Stable puts your apps back to their Stable versions and keeps their data. We warn you first: a Development version can change things in ways that do not go backwards cleanly, so restore a backup if something looks wrong afterwards.
- If we cannot reach the Development app list, nothing changes and you stay where you are.

## 0.48.1

- You can now open "What's new" straight from the account menu in the top-right, instead of going into Settings to find it.
- Added the release notes for everything since 0.47.1 — the last few updates shipped without an entry here.

## 0.48.0

- **OpenMasjidOS now tells you when someone disputes a card payment.** If a donor asks their bank to reverse a payment (a chargeback), you get an email and, if you use one, a message in Slack or Discord. It says how much, why, and the date the bank needs a reply by — because if nobody replies, the money is lost automatically.
- You choose how you hear about it, like every other alert: email, your chat app, both, or not at all, under Settings → Alerts.
- Nothing to set up. It works with whatever donation app you already have, and does nothing until you've added your Stripe details in Settings.
- Amounts are shown correctly for every currency, including ones without pence, like the Japanese yen, and ones with three decimal places, like the Kuwaiti dinar.
- If several disputes arrive at once — which can happen when a stolen card is used repeatedly — you get one message about all of them rather than a flooded inbox.

## 0.47.5

- The "What's new" panel has been redesigned to match the one in OpenMasjid Kiosk, so it looks and reads the same in both. It now opens in a window you can move and keep open beside the page.

## 0.47.4

- Updated two building blocks of the software to close published security problems. Nothing about how OpenMasjidOS looks or behaves changes.

## 0.47.3

- **The Files app no longer shows OpenMasjidOS's own private files.** The folder holding your password, your email and Stripe keys, and the certificate for this dashboard is now kept private, and the file that describes how each app runs can no longer be edited there. Your own files, and everything belonging to your apps, are untouched and work exactly as before.
- This closed a way for anyone already signed in to read those keys, or to change how an app starts up.
- Your backups still include all of it, and restoring still puts everything back — that was checked carefully, because a backup missing your settings would be far worse than the problem being fixed.

## 0.47.2

- **A damaged security certificate no longer stops OpenMasjidOS from starting.** If the file that secures this dashboard gets corrupted — after a power cut, or on a tired SD card — OpenMasjidOS now replaces it and carries on, instead of failing to start and leaving you with no dashboard to fix it from.
- If the certificate you uploaded yourself was the one that broke, Settings → Security now tells you so and asks you to add it again, rather than leaving you wondering why your browser started complaining.
- A healthy certificate is never touched, so your devices won't be asked to trust it again for no reason.

## 0.47.1

- Your logo is no longer squashed in emails. It now keeps its proper shape whether it's square, wide, or tall.

## 0.47.0

- Emails from OpenMasjidOS look properly designed now, and no longer arrive with your logo as a file attached to them.
- Alert emails say what happened in one clear line, show the details at a glance, and give you a button that opens the right page — instead of asking you to hunt through menus.
- Subject lines are plain English. They no longer start with "[OpenMasjidOS]", and the same words are no longer repeated three times in one email.
- Your masjid's logo appears in emails when remote access is set up. Without it, your masjid's name appears instead — email programs can only load pictures from the internet, not from your own network.

## 0.46.0

- Apps now find the dashboard again after you move the box to a different network. Before this, an app kept trying the old address forever and quietly stopped talking to OpenMasjidOS.
- Third-party apps are no longer shared over the internet unless you ask. Community and Docker Compose apps now have the same "share this online" question that App Store apps have, and it starts switched off.
- Apps can no longer reach into another app's private network. This joins the existing protection that stops them reaching another app's data.
- Fixed a case where a backup could report success even though part of it failed to save — for example when the disk filled up.
- Closed a gap where a specially written web address could reach parts of OpenMasjidOS that are meant to stay on your network only.
- Added this "What's new" page.

## 0.45.0

- Apps that need a public web address now ask you during install instead of silently going without one, and the "Shared online" switch is easier to find — it's on the app's own page and always visible in Settings.
- Backups are now honest: if any part of a backup can't be saved, the whole backup fails instead of quietly leaving something out. Older backups are no longer deleted after a failed run.
- Restoring a backup now pauses your apps first, so their data can't be damaged while it's being put back, and tells you if any app's data couldn't be restored.
- Apps can no longer be installed, updated, or restored if they try to open another app's data.
- App updates are now safety-checked the same way installs are.

## 0.44.0

- You now get an alert when a new version of OpenMasjidOS or one of your apps is available.

## 0.43.0

- You can upload your masjid's logo in Settings → Customize. It appears on emails OpenMasjidOS sends and on your notification messages.

## 0.42.0

- Alerts can now be sent to email, to your webhook, or both — choose per alert in Settings → Alerts.

## 0.41.0

- OpenMasjidOS can send email. Set up SMTP or Resend in Settings → Email, send yourself a test, and apps can send mail through it without ever handling your password.
- Alerts let you know when something needs attention, such as an app going offline.

## 0.40.0

- Apps can now securely ask each other for information, and you choose which apps are shared over the internet.
