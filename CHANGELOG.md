<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# What's new in OpenMasjidOS

Newest first. The dashboard reads this file (Settings → Advanced → **What's new**),
so keep the wording plain and friendly — a masjid volunteer is the reader, not a
sysadmin. One `## <version>` heading per release, then short bullets.

## Unreleased

**Added — WhatsApp notifications (OpenWA)**

- A third notification channel beside email and the webhook, sending through **OpenWA** — a self-hosted, MIT-licensed WhatsApp gateway the masjid installs from the App Store. Nothing leaves the masjid's network to a third-party sending service. The catalogue entry itself belongs to OpenMasjidAPPS (§4/§19); this is the platform half.
- `store/whatsapp.ts` — gateway vault, chmod 600, API key never returned to the UI (an "is set" flag only), mirroring `store/email.ts`. The gateway is resolved automatically at `127.0.0.1:<published port>` from the app registry, the same no-SSRF rule the Fabric broker follows; a typed `baseUrl` remains as the override for a gateway elsewhere.
- **Admin WhatsApp number** on the admin record (`auth/store.ts` `phone`, `getAdminPhone()`) and in Settings → Account beside the email. A destination only, never a login identifier, stored as digits so one number has one representation. `updateProfile` sends it even when blank, so clearing the field genuinely removes it rather than silently leaving alerts pointed at the old phone.
- `AlertChannels.whatsapp`, defaulting **OFF** while email and webhook stay on — it runs through an unofficial client whose number can be restricted, so it is opted into. An `alerts.json` written before this existed has no `whatsapp` key, so absence reads as off and upgrading never starts messaging a phone.
- `POST /api/fabric/whatsapp`, gated on a new manifest `whatsapp: true`. Returns **202 `{queued}`** — the honest word, since pacing puts delivery seconds to hours away. One recipient per call by design. LAN-only, rate-limited, bodies never logged.
- Settings → WhatsApp: gateway config, pairing-code linking (no QR — a masjid's server is headless and the admin is rarely beside it), a live status dot that separates "gateway down" from "phone not linked", the queue depth, and a **Send test message** button that bypasses the queue because a test the admin is watching needs an answer on screen.
- `docs/WHATSAPP.md` — setup, the pacing table, the app-author contract, and the residual ban risk stated plainly rather than buried.

**Why one queue owns all sending.** Ban risk attaches to the phone *number*, not to whichever app had something to say, so it cannot be enforced per app: two apps each sending politely at the same moment still make the number burst. Every message goes through one serialised queue. OpenWA's own `send-bulk` is deliberately unused — it paces within a single request, which does nothing about two requests overlapping. Human behaviour: randomised 6–20s gaps (a fixed interval is itself a fingerprint), a typing indicator scaled to message length, presence online-while-working, a per-recipient cooldown, rolling hour/day caps, a warm-up ramp for a freshly linked number, quiet hours that queue rather than drop, and `contacts/check` before first contact. `clampLimits` means an admin can only make the policy stricter.

**Fixed**

- `settings.reconnectDone` was referenced but missing from the locale file, so refreshing network settings showed a raw key instead of a message. It now also uses the count it was already being passed.
- 10 orphaned translation strings removed in the previous sweep are joined by the addition of the WhatsApp strings; every `t()` key in Settings is now verified to resolve.


> This section exists only on `dev` and is the full working record — fixes, internals, CI,
> docs, dependencies. At release time it is rewritten into a `## X.Y.Z` section holding only
> what a masjid would notice (CLAUDE.md §18).

**Fixed**

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
