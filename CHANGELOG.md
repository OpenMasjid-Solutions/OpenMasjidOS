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
  - With remote access switched **off**, parts of the dashboard could still be reached from the
    internet by writing its address in an unusual way. They can't any more.
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
  spelling); serving still needs `isDashboardPath` (EVERY spelling). `/%74rpc/auth.me` reached
  tRPC over the tunnel with the feature off, because one predicate answered both questions.
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

- Updated four bundled libraries to pick up security fixes, including the one that sends your
  email. Nothing about how OpenMasjidOS works changes.

### Remote administration

Manage OpenMasjidOS from outside the masjid, over the same secure tunnel your apps already use.
**Off by default.** Turn it on in Settings → Remote access, once two-step sign-in is set up.

- **Your dashboard can now be opened from anywhere**, at the same web address your apps use —
  `https://your-domain/`. You do not add anything in Cloudflare: the route you already have
  covers it.
- **It will not switch on without two-step sign-in**, and it switches itself back off if you ever
  remove it. A password on its own is not enough to put a masjid's server on the internet, and the
  screen tells you if the two ever disagree rather than quietly claiming to be on.
- **Too many wrong sign-ins from one place lock that place out** for a while. This only works from
  outside, where we can tell one visitor from another — and it can never lock you out from
  somewhere else, which is exactly why it is safe to switch on here and not on your own network.
- **Files, terminals and backups stay at the masjid.** They are not available from outside at all,
  on purpose: between them they reach every password and key the server holds. The dashboard hides
  them when you are away rather than offering a button that fails.
- **Nothing changes for anyone at the masjid.** Same address, same sign-in, no extra code.

**Fixed, from a report on a real masjid's server:** signing in from outside could get stuck saying
*"That sign-in attempt has expired"* when it plainly had not.

- After five wrong codes the sign-in really was finished — but the screen kept offering **Sign in**,
  which could no longer work, and said the attempt had expired rather than saying why. It now takes
  you back to the password step and tells you what happened.
- A wrong code now says **how many tries you have left**, so running out is not a surprise.
- If a code keeps being refused because the **server's clock is wrong**, it says so, and by how much.
  A wrong clock and a mistyped code look identical while you are typing, and the fixes are opposite.
- **You can set two-step sign-in up now**, in Settings → Account. Scan the square code with
  an authenticator app on your phone — Google Authenticator, Authy, 1Password and most
  password managers all work — or type the key in by hand if there is no camera to hand.
- Ten one-time **backup codes** come with it, for the day the phone is lost or replaced. They
  are shown once and only once, so that window will not close until you have ticked that they
  are saved; there are Copy and Download buttons beside them.
- A code emailed to you can be allowed as a second way in. It needs an email provider set up
  first, because a code that cannot be delivered is a lockout with extra steps.
- Changing any of this asks for your password **and** a current code. That is not box-ticking:
  it is what stops someone who reaches an already-signed-in dashboard from quietly pointing
  two-step sign-in at their own phone and keeping a way in from anywhere.
- A code can only be used once, even within the minute it is valid for.
- **Nothing about signing in changes today.** On the masjid's own network you sign in exactly
  as before, and that stays true after this feature is finished — the extra code is only ever
  asked for on connections from outside, so a volunteer who left their phone at home is never
  locked out of the dashboard in the building.

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
- Automatic checks now guard the things that break quietly — right-to-left layout (so Arabic
  and Urdu keep working), colours only ever coming from the one theme file, and text staying
  readable on every background.

- There is now a **Design system** page at `/design-system` showing every shared control in
  dark and light and in both left-to-right and right-to-left, so a layout problem can be seen
  in one place instead of hunted through the app.
- The first shared controls are in place (a switch, a checkbox, a label and a menu).
- **Every tickbox in the dashboard now matches the rest of it** — they were the browser's own
  grey-and-white boxes before, which looked different on every computer. The two that matter
  most are the ones confirming you want to delete an app's data or remove WhatsApp entirely.
- Fixed a bug where closing a dialog did not put the keyboard back on the button you opened
  it from — it looked right in the code and did nothing at all.
- Fixed a switch that slid out of its own track when the dashboard is set to a right-to-left
  language. It affected every switch in Settings.
- **Every dialog now keeps the keyboard inside it.** This matters most during an update: the
  dialog that says "do not interrupt" could be tabbed out of, and pressing Enter on something
  behind it navigated away and dismissed it mid-update. It cannot be now. Closing a dialog
  also puts the keyboard back on whatever opened it.
- **The two menus in the dashboard — the ⋮ on each app card and the account menu at the top
  right — now work properly with a keyboard.** Arrow keys move between items, Escape closes,
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
