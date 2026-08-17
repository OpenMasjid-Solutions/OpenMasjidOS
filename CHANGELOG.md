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

**Added — commands can hold a conversation**

- **An app can ask you a question or two, and you just reply.** No `!` needed while it's waiting: `!display schedule-iqamah` → "Which prayer?" → `Maghrib` → "What time?" and so on. Send `exit` to leave it, and it lapses on its own after a few minutes' silence — so an abandoned half-answered question never leaves your ordinary messages being read as commands. Starting any new `!` command abandons it too. While something is waiting, a plain `yes` or `no` is enough to confirm.
- **Asking to update an app that is already current now says so**, instead of reporting that the day's WhatsApp allowance was used up. It never checked whether there was anything to do first — technically true, useless, and it hid the actual answer.

**Fixed — an update that leaves an app broken no longer says it worked**

- **Updating an app reported "Done" even when the new version could not start.** Docker considers an app started the moment the container is created, so an app that boots, fails and restarts forever counted as a clean update — the only sign was the dashboard quietly showing it as stopped, with the reason buried in container logs you had to know to go and look for. The update now waits to see whether it stayed running, and if it didn't, says so and shows the last thing the app printed before it stopped. Same for starting or restarting an app by WhatsApp, where you cannot see the dashboard at all.
- This came from a real one: a WhatsApp gateway update added a new requirement that the existing settings didn't meet, and nothing joined up "the update worked" with "the app is off".

**Added — run things from WhatsApp**

- **An authorised phone can now run admin commands by messaging the masjid's number.** `!os stats` for how the server is doing, `!os apps` for what is running, `!os restart 2` to bring a wedged display back, `!os update 3` to update one app — and each installed app can offer its own commands under `!<app>`. The point is the wall-mounted box in a cupboard: fixing a stuck screen no longer means being on the LAN with a browser.
- **Off by default, and nobody can use it until you add them.** Settings → WhatsApp → Commands, behind a warning that says plainly what it means: whoever holds one of those phones can start, stop and update your apps, with no password step. Each person gets a tick per app, plus a separate "view" and "control" for the server itself.
- **A number that is not on your list gets no reply at all** — not even a refusal. Answering would confirm to a stranger that this number runs your server, and would spend the sending allowance your fee reminders need.
- **Ordinary conversation is completely untouched.** Every command starts with `!`; anything else is not read as a command, not logged and not replied to. Commands sent in a group never do anything.
- **Anything that changes something asks first**, with a short code read off that exact prompt rather than the word "yes" — so a stale question, or a forwarded screenshot, cannot run the wrong thing. It also emails you afterwards, under a new "Something was changed from WhatsApp" alert: there is one admin account, so that is your record of who did what.
- **Deliberately not offered:** restarting the machine, reading app logs (they contain passwords and personal details, and a chat keeps a copy forever), updating OpenMasjidOS itself, and removing an app. Updating a single app is offered, because only that app restarts.
- Apps declare their commands in their manifest, like they already declare alerts. See `docs/APP_MANIFEST_SPEC.md`; the platform decides who may run what, renders the menu and asks for confirmation, and the app is only ever asked to do the thing.
- **Fixed on the way:** updating an app wrote the new `compose.yml` to disk *before* validating the refreshed manifest, so a malformed one left the new compose beside the old metadata and the next start ran it believing it was the old version.

**Added — WhatsApp notifications (OpenWA)**

- A third notification channel beside email and the webhook, sending through **OpenWA** — a self-hosted, MIT-licensed WhatsApp gateway the masjid installs from the App Store. Nothing leaves the masjid's network to a third-party sending service. The catalogue entry itself belongs to OpenMasjidAPPS (§4/§19); this is the platform half.
- `store/whatsapp.ts` — gateway vault, chmod 600, API key never returned to the UI (an "is set" flag only), mirroring `store/email.ts`. The gateway is resolved automatically from the app registry at its published host port, the same no-SSRF rule the Fabric broker follows; a typed `baseUrl` remains as the override for a gateway elsewhere.
- **Admin WhatsApp number** on the admin record (`auth/store.ts` `phone`, `getAdminPhone()`) and in Settings → Account beside the email. A destination only, never a login identifier, stored as digits so one number has one representation. `updateProfile` sends it even when blank, so clearing the field genuinely removes it rather than silently leaving alerts pointed at the old phone.
- `AlertChannels.whatsapp`, defaulting **OFF** while email and webhook stay on — it runs through an unofficial client whose number can be restricted, so it is opted into. An `alerts.json` written before this existed has no `whatsapp` key, so absence reads as off and upgrading never starts messaging a phone.
- `POST /api/fabric/whatsapp`, gated on a new manifest `whatsapp: true`. Returns **202 `{queued}`** — the honest word, since pacing puts delivery seconds to hours away. One recipient per call by design. LAN-only, rate-limited, bodies never logged.
- Settings → WhatsApp: gateway config, pairing-code linking (no QR — a masjid's server is headless and the admin is rarely beside it), a live status dot that separates "gateway down" from "phone not linked", the queue depth, and a **Send test message** button that bypasses the queue because a test the admin is watching needs an answer on screen.
- `docs/WHATSAPP.md` — setup, the pacing table, the app-author contract, and the residual ban risk stated plainly rather than buried.

**Why one queue owns all sending.** Ban risk attaches to the phone *number*, not to whichever app had something to say, so it cannot be enforced per app: two apps each sending politely at the same moment still make the number burst. Every message goes through one serialised queue. OpenWA's own `send-bulk` is deliberately unused — it paces within a single request, which does nothing about two requests overlapping. Human behaviour: randomised 6–20s gaps (a fixed interval is itself a fingerprint), a typing indicator scaled to message length, presence online-while-working, a per-recipient cooldown, rolling hour/day caps, a warm-up ramp for a freshly linked number, quiet hours that queue rather than drop, and `contacts/check` before first contact. `clampLimits` means an admin can only make the policy stricter.

**WhatsApp — corrections after OpenMasjidAPPS reviewed the platform half**

- **A rate-limited message is no longer lost.** Every non-2xx was treated alike and the queue dropped the item regardless, so a `429` silently discarded a message. Failures are now classified: `429`, `5xx` and network errors are retried with a widening backoff (bounded at 5 attempts); `4xx` refusals are permanent and are not retried, since repeating them only burns the number’s allowance.
- **`qr_ready` no longer reports as connected.** The status check was a substring regex, and `qr_ready` contains `ready` — so a session merely waiting to be paired read as linked, which is the state a fresh install sits in longest. Statuses now match OpenWA’s enum exactly.
- **“No session yet” is distinguished from “gateway unreachable.”** They have opposite fixes, and conflating them sent the admin looking for a network fault that was not there. A session deleted at the gateway is also recoverable rather than fatal.
- **The session id is machine-managed.** OpenWA mints a UUID and `POST /api/sessions` takes only a name, so there was no value an admin could type and no env var an app entry could seed. The platform now creates the session itself on first link (idempotently — a name clash adopts the existing one), which removes the only manual step: no volunteer has to open OpenWA’s admin panel to copy a UUID back.
- The API-key hint now says it is the same key entered when installing OpenWA, and warns that OpenWA reads it only on first boot — so changing it here does not rotate the gateway’s key.

**WhatsApp — the gateway was unreachable on every install (found in real testing)**

- **The platform was looking for OpenWA in the wrong place.** The core runs in its own bridge-network container, so `127.0.0.1` inside it is *the core* — an app's published port is on the **host**, reachable only through the installer's `host.docker.internal:host-gateway` mapping. Three callers had this right (the Fabric broker, the per-app TLS proxy, the tunnel ingress) and the expression had been pasted into each; the WhatsApp client was then written from memory with `127.0.0.1`, so a correctly installed and linked OpenWA could never be reached. Worse, both symptoms — *"Cannot reach the gateway. Is OpenWA installed and running?"* and a bare `fetch failed` — blamed the masjid's setup. This repo's own CLAUDE.md described the address as `127.0.0.1` in two places, so the wrong spec produced the wrong implementation; both are corrected.
- `system/app-host.ts` is now the single definition, used by all four callers, and `test/app-host.test.ts` fails any source file that builds an app address from a loopback literal.
- **A failure now names a reason the admin can act on.** undici collapses every transport failure into `TypeError: fetch failed` and hides the real cause in `err.cause.code`, which is exactly the useless string a masjid saw. "OpenWA is not installed", "installed but not running", "running but publishing no port", "nothing is listening at that address" and "the address could not be found" are distinguished and shown, and the core logs the same reason *with the address it tried* — so `docker logs openmasjid-core` is now enough to diagnose this class of problem.
- **A wrong API key has its own state.** Previously a rejected key read as "cannot reach the gateway", sending the admin to check the network instead of re-pasting the key.
- **Reachability now means "something answered", not "the request succeeded".** Requiring a `200` from the session-list endpoint made the status depend on OpenWA's exact routes — a renamed endpoint would have reported a perfectly healthy gateway as down. Only a transport failure counts as unreachable.
- `docs/WHATSAPP.md` gains the log command, states that linking happens entirely in OpenMasjidOS (OpenWA's own interface is never opened), and lists each reason with its fix.

**WhatsApp — linking now works, and the feature hides itself until it is wanted**

- **Linking always failed with "the gateway returned 400."** OpenWA's lifecycle is create → **start** → pair, and the platform never started the session — so it had no engine, and every engine route answers `400 Session is not started`. The status panel said "gateway running, no phone linked yet", which was true and pointed nowhere. Starting is now part of linking, idempotently: an already-`ready` session is left alone (and says "a phone is already linked" instead of erroring), a live engine is not restarted, and the `409` that OpenWA returns for the second or two while the engine comes up is waited out rather than shown as a failure.
- **A message queued before a phone is linked now waits instead of burning its retries.** The same readiness check runs in the send queue, so a gateway restart or an early message is a delay, not five failed attempts and a dropped message.
- **A WhatsApp-imposed restriction on the number is surfaced.** The gateway reports one; the platform was ignoring it. This is the risk the whole feature is hedged against actually happening, so it now appears in Settings rather than leaving a masjid wondering why messages stopped.
- **WhatsApp is one switch, off by default, and OpenWA is invisible until it is on.** Turning it on shows the ban-risk warning; accepting it makes the gateway installable and takes you straight to its install questions. Turning it off is immediate.
- **OpenWA no longer appears on the dashboard, in the dock, or in the App Store** unless WhatsApp is switched on — and even then only in the store. It is opened from Settings alone, with the copy stating plainly that linking happens in OpenMasjidOS and OpenWA is for reading and replying to chats. The platform owns the session (creating, starting, pairing, pacing), and every one of those guarantees breaks if a second phone is linked in OpenWA's own UI or a message is sent from there, outside the queue.
- **Phone numbers are a proper field now** — pick the country, type the rest. "Enter your number in international format" was a guessing game where three of the four plausible answers were wrong. No phone-number library was added (libphonenumber is ~150 KB gzipped for depth this does not need); the server still refuses anything without a country code and still never guesses one.

**Added — post to a WhatsApp group**

- **Apps can now send an announcement to a group, so one message reaches everyone.** Telling 200 parents something one at a time costs 200 messages paced over hours — and messaging many people individually is the riskiest thing a WhatsApp number can do. A group post is a single message.
- **You approve which groups apps may use**, in Settings → WhatsApp → Groups → *Find my groups*. This is the safeguard, not a formality: the gateway can see every group your phone is in, including personal ones, and apps are only ever shown the ones you approve. Withdraw approval at any time and it stops immediately.
- Two warnings appear before you approve one, because both are easy to learn the hard way: **everyone in a WhatsApp group can see every other member's phone number**, and unless the group is set to "only admins can send", any member can reply to all 200.
- **OpenMasjidOS will never add anyone to a group.** Adding people who did not ask is the fastest route to a blocked number and a complaint; share a join link instead.
- Group posts have their own tighter allowance — **4 an hour, 10 a day** — kept separate in both directions, so an announcement never eats the allowance fee reminders need and neither starves the other. Quiet hours still apply, and everything still goes through the one paced queue.
- **Send a test message to any approved group**, so you can see it arrive before an app ever posts something real. It asks you to confirm first — everyone in the group receives it, and a message cannot be unsent from two hundred phones — and the message says plainly that it is a test and needs no reply.
- The **Get a code** button now sits on the same line as the phone number instead of drifting below it.
- **A Community's announcement group works** — it is an ordinary group. **WhatsApp Channels do not**: the gateway has no way to post to a Channel at all, so there is nothing to switch on. Stated plainly in `docs/WHATSAPP.md` so nobody plans around it.

**Internal — the tests are typechecked now**

- `npm run lint` only typechecked `src/`, so a change to a function signature broke two tests silently: the lint was clean and the failure appeared only when the suite ran. It happened twice while building the group support. Tests are now included (`tsconfig.test.json`), and the two latent type errors this uncovered are fixed. Verified by planting the old broken call and confirming the lint catches it.

**Added — send an image over WhatsApp**

- Apps can attach an **image** to a WhatsApp message — a poster, a timetable, a notice — with the text becoming its caption. Built for OpenMasjidDisplay's "Iqāmah times are changing" poster.
- PNG, JPEG or WebP, up to **2 MB**. An image that is too large is refused with a message saying both the limit and how big yours was, rather than a bare failure.
- **It waits its turn like everything else.** An image is a more noticeable thing to receive than a sentence, so it goes through the same paced queue, the same quiet hours and the same daily limits.
- **If an image cannot be sent, nothing is sent.** The caption never goes out on its own — otherwise an app would report that a poster had been published when only a sentence had.
- At most four images wait in the queue at a time; a fifth is refused until they have gone. Waiting images are held in memory, and on a Raspberry Pi an unlimited queue of posters is how a dashboard runs out of it.
- Fixed while building this: the send route was subject to a **1 MB request limit on the HTTP front door** — the very address apps use — while the dashboard allowed 25 MB. The two never agreed, and a slightly larger poster would have failed on one and not the other. The limit is now set on the route itself.

**Changed — group nicknames, group ids, and a storage total that matches the machine**

- **Each approved WhatsApp group can be given a nickname**, and that is the name apps use. A group called "MASJID GRP 2 (new)" in WhatsApp can be "Parents — Hifz" in OpenMasjidOS; renaming here never renames the group itself, and its real WhatsApp name is shown underneath so you can tell which is which.
- **The group's id is shown as well**, because that is the value which appears in an app's own settings and its logs — matching one up otherwise meant guessing.
- **Storage now reports the machine's actual disk.** It was reading the size of whichever filesystem the masjid's data happened to land on, which inside a container can be far smaller than the real drive — so the card showed a total nowhere near the disk you bought. It reads the device itself now, still holding back 16 GB for the host operating system. Virtual and stacked devices (loop mounts, LVM, RAID) are excluded so nothing is counted twice, and a plugged-in USB stick is not counted as the masjid's storage.

**Changed — WhatsApp alerts are the platform's, app messages are the app's**

- **The WhatsApp column in Settings → Alerts now covers OpenMasjidOS's own alerts only.** Each app's rows read *"Set up in the app"* instead. The matrix sends to *you*, the admin, and the platform knows exactly one phone number — yours. An app that messages over WhatsApp is almost always reaching a parent about fees or a donor about a receipt, so who it messages and what it says belong in that app's own settings. A toggle here promised something the platform could not do.
- Nothing changes about how apps send: they still go through OpenMasjidOS, using the gateway you configured, the credentials they never see, and the one paced queue that protects your number. Only the choice of what to send moved.
- Apps keep their Email and Webhook columns, because those really are "tell the admin something happened".
- Apps can now ask the platform whether this masjid can send WhatsApp at all, so an app offering "WhatsApp reminders" can say "not set up on this server yet" instead of looking available everywhere and failing only when a real reminder was due. It learns nothing else — not the gateway, not the key, not which number is linked.
- **The pairing code is now big enough to read from across the room**, with a note that it expires — you are typing it into a phone in your other hand.
- **Once linked, the panel shows which number is sending**, so "connected" is something you can verify rather than take on trust.

**Fixed — a Development machine that was never offered anything**

- **`dev/VERSION` was numbered below the release it followed.** After `0.50.4` shipped, dev kept counting `0.50.4-dev.5`, `-dev.6` — and by semver a prerelease sorts *below* its own release, so `0.50.4-dev.6` is **older** than `0.50.4`. A machine on Stable that switched to Development was therefore correctly told there was nothing newer: no banner, no alert, no error, the dashboard saying Development while running Stable indefinitely. Dev now heads toward the *next* release (`0.50.5-dev.1`), and a test compares the two branches' versions and fails with that explanation, so it cannot recur.
- **A machine running the other channel's build is now told so.** The updater always knew how to fix this; the thing that *detects* updates only compared version numbers, so nobody was ever informed. This is how a machine got stuck: an interrupted update, repaired with the installer, which pulled the Stable image while Settings still said Development. The banner now names it for what it is — "this machine isn't running Development yet" — rather than calling it a new version, because switching back to Stable legitimately means installing an older number.

**Fixed — updates that could run twice, and stats that disagreed with the machine**

- **An update can no longer be started twice, which is what broke a box that then wouldn't come back.** Nothing stopped two updates of the same thing running at once: closing the progress window and pressing the button again started a second update on top of the first — two `docker compose up --force-recreate` runs racing for the same container, with two writers rewriting the same compose file underneath them. There is now one update at a time, **enforced on the server**, per app and for the platform itself. A second request is told an update is already running, which is information rather than a failure — calling it a failure is what pushes someone into retrying.
- **The update dialog and the app-update window cannot be dismissed while an update runs** — no backdrop click, no Escape, no close button. The server-side lock is the real guarantee (a browser can be closed, a laptop can sleep); this stops an admin reaching for the thing that caused the damage. Minimizing an app update still works: the update is unaffected and the dock brings it back.
- **Memory was counting the page cache as used.** Linux fills otherwise-idle memory with cache on purpose, so a box with plenty free showed as nearly full. Used is now computed exactly as `free` computes it, because `free` and `htop` are what the number gets compared against.
- **The CPU figure jumped around.** The sampler kept one baseline but had many callers — the live stream, the plain query, and one stream per open browser tab — so whichever called last moved the baseline and the next reading averaged a few milliseconds of activity, which is close to random. It now samples on a fixed minimum interval and hands every caller the same honest value.
- **Storage now holds back 16 GB for the host operating system.** A machine at a genuine 100% cannot write logs or update itself, and getting it back needs someone at a terminal in the masjid — so the card counts down to full early and the low-storage warning arrives while there is still room to fix things.
- The storage card also picks the right disk now: it matches the most specific mount containing your data rather than any mount whose name happens to be a prefix, so a machine with a separate data volume no longer reported the system disk's figures.

**Fixed — the installer no longer moves a machine between update channels**

- **A Development machine that ran the one-liner to repair a broken update was silently put back on Stable.** Update and Repair both rewrite the core's compose file, and both wrote `:latest` unconditionally — so repairing a broken Development box was impossible from the installer, because the repair itself changed the channel. The installer now keeps the machine on whatever channel it is already on. **Repair** keeps the exact version already installed (repair means "make this work again", not "move it"), while **Update** goes to the newest build on the machine's own channel. A digest-pinned image is left alone in both.
- **`--channel=dev` installs the Development channel on a fresh machine**, and the README documents it. On a machine that is already installed, switching in Settings → Advanced remains the right way, because that checks the Development catalogue is reachable first — something the installer cannot do.
- **The installer no longer mistakes a damaged install for an empty machine.** It now also recognises your `config/` and `apps/` folders, so a missing or half-written compose file — the likeliest casualty of an interrupted update — cannot make it offer a fresh install to a masjid whose data is sitting right there.

**Fixed — dialogs, phone fields, and a session that outlived itself**

- **Every dialog in OpenMasjidOS was being clipped to the page behind it.** `position: fixed; inset: 0` does not mean "the viewport" when an ancestor has a transform — that ancestor becomes the containing block, and every route is wrapped in a `motion.div` that animates `y`. So a dialog opened from Settings was sized and positioned inside the settings content box: backdrop over part of the screen, dialog off-centre and half behind the panels. Modals now render through a portal to `document.body`, which fixes every dialog at once and does not depend on knowing which ancestors animate.
- **Phone numbers start on +1**, and the grouping no longer puts a space after the ninth digit: a US number reads `555 010 1234` rather than `555 010 123 4`. Grouping is from the left so the digits stay still while typing, with a trailing single digit merged into the group before it. "Other country" covers anywhere not in the list.
- **A recorded session that no longer exists at the gateway now heals itself.** If OpenWA's volume is wiped, its session deleted, or the gateway reinstalled, the stored id names nothing — and every call afterwards returned `404` for ever, with nothing on screen to press. The id is the platform's to manage, so it is now also the platform's to re-mint: a `404` clears it and a fresh session is created and started.
- A `404` from the pairing route itself is now reported as "this version of OpenWA doesn't support linking by code" rather than a bare status.
- **Settings → WhatsApp → View OpenWA logs.** Hiding the gateway from the dashboard took its logs with it, and the gateway's own log is the only place some failures show up — an engine that won't start says nothing over the API.
- The risk dialog said the same thing twice: the body and the highlighted line both told you to use a spare number.

**Fixed**

- `settings.reconnectDone` was referenced but missing from the locale file, so refreshing network settings showed a raw key instead of a message. It now also uses the count it was already being passed.
- Every `t()` key in Settings is verified to resolve, after the WhatsApp strings were added and 10 orphans removed.
- **Returning to Stable no longer loops for ever.** Updating the OS restarts the core, which drops every in-memory session; the dashboard falls back to the sign-in screen, unmounting `AppShell` — and the window layer renders inside the `Dock`, so the migration window's subtree unmounted while the window itself survived in `WindowsProvider` above the router. Signing back in remounted `ChannelMigrate` with `index` reset to 0 and its original prop list, so it re-updated every app and then the OS again, signing you out again. Escapable only by closing the window in the seconds before the restart landed. Two independent fixes:
  - `runUpdate` refuses to "update" to the version already running — the guard `updateCatalogApp` has always had for apps, which the core's own update never got. A channel move still proceeds, decided by whether the running version is a prerelease (`isPrerelease`), because `main → dev` is release → prerelease and semver alone would call that a downgrade and refuse.
  - `ChannelMigrate` reads what is still pending from `system.channel` and snapshots it once, instead of trusting a prop captured when the window opened. A remount after a completed migration now sees nothing pending. Snapshotting (rather than reading live every render) keeps an invalidation mid-run from shifting the list under the index.

**Removed (dead code)**

- Exports nothing referenced: `composeConfig` (`docker/compose.ts`), `appTlsPortRange` (`system/app-proxy.ts`), `ALLOWED_LOGO_MIME` (`store/branding.ts` — `isAllowedLogoMime` reads `MIME_EXT` directly), `parentPath` (`ui/lib/files.ts`), `springSnappy` (`ui/lib/motion.ts`).
- Un-exported, used only inside their own module: `extractPublishedPorts` and `portsInUse` (`apps/ports.ts`, both called by `findPortConflicts`), `resolveUploadDir` (`files/manager.ts`), `appUrl` (`ui/lib/apps.ts`).
- 10 orphaned translation strings: `auth.emailOrUsername`, `dashboard.statusError`, `custom.desc`, `custom.enableFirst`, `community.reposHint`, `settings.channelPullOs`, `settings.channelOn`, `settings.channelPendingTag`, `settings.backupDriveToken`, `errors.viewDetails`.

**Documentation**

- CLAUDE.md §18 rewritten: it still said "Current version: `0.1.0`". Now records the per-branch `VERSION` rule and the two-audience CHANGELOG policy.
- `docs/audit/ACTION_REQUIRED.md` carries a re-verified status block, so a July snapshot no longer reads as a live to-do list.

**Security**

- Audit re-run. No `eval`, no `new Function`, no `shell: true`, no `innerHTML`; every `spawn` passes an argument array, so no shell interpolation; nothing logs a secret value. `dangerouslySetInnerHTML` appears twice — both in comments stating the repo does not use it.
- **One finding confirmed still open**: `GET /api/fabric/stripe?account=` lets any stripe-capable app read *every* Stripe account's `secretKey`/`webhookSecret`, because the account id comes from the query string with nothing binding an app to an account. Recorded in `docs/audit/ACTION_REQUIRED.md`; the fix needs a per-app binding and a coordinated OpenMasjidAPPS change, so it is deliberately not in this release.
- `npm audit` clean at the `high` gate. Two moderates remain and are deliberate: `esbuild` (dev-server advisory, devDependency, absent from the shipped image) and `uuid` via `dockerode` (needs dockerode 4 → 5, a major bump of the dependency that manages every container).

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
