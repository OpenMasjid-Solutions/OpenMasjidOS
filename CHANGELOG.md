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

**Security — a full audit, and one serious hole closed**

- **An app could have been given complete control of the server, with no warning shown.** Before installing any app, OpenMasjidOS checks its configuration for dangerous settings — mounting the server’s own control socket, or the whole filesystem — and refuses. That check could be stepped around: writing one field as a variable instead of a fixed value made the checker skip the inspection entirely, while Docker still resolved it to the dangerous setting when the app started. An app published to the store, or added from a third-party store, could have taken over the machine on the ordinary one-click install with no risk dialog at all. Now caught, along with two related tricks — one that let an app open **another app’s database**, and one that let it join **another app’s private network** and reach services never meant to leave that app.
- **A web address written in an unusual but valid way could point the community app-store fetcher back at the server itself.** The check that blocks private addresses only recognised one spelling of them.
- Smaller fixes: the running version was readable from the internet on one of the two listeners; one app could use up the message-sending allowance belonging to all the others; and a header a caller can invent was still being trusted on one path.
- **Written down honestly, not quietly.** “Local network only” means “not reachable through the remote-access tunnel” — it does **not** mean the server cannot be reached from the internet if it has a public address. If your server has one, put a firewall in front of it;  now explains exactly what is and is not protected, and the README no longer claims the dashboard is never exposed.

**Changed — no more hourly or daily message limit**

- **The cap on how many messages you can send has been removed.** It was 12 an hour, but a newly linked number only got a quarter of that — three an hour — and replies to your own `!os` commands counted against the same allowance. In practice that meant setting WhatsApp up and then not being able to use or even test it. Messages are still spaced a random 6–20 seconds apart, and the same person is still never messaged twice within a minute, which is what makes the sending look human in the first place.
- **Group announcements keep their limits** (four an hour, ten a day). One group message reaches every member, so overdoing it costs two hundred people who did not ask for it — which is not the same as sending too many fee reminders.
- Worth knowing: nothing now stops an app sending to a very large number of people in one go, other than the spacing. WhatsApp does not officially allow this kind of connection and a blocked number cannot be recovered, so keep an eye on what your apps send.

**Fixed — WhatsApp messages that were accepted and never arrived**

- **The send queue is now saved to disk.** It only ever lived in memory, so any message the pacing held — for a rate cap, for the gentle ramp on a newly linked number, or for the old quiet-hours window — was thrown away when OpenMasjidOS restarted. Nothing said so: your app was told the message had been accepted, and there was no error anywhere to contradict it. On the Development channel, which restarts often, that is how a masjid went more than a day with every message accepted and none delivered. The pacing history is saved too, so the daily and hourly limits survive a restart instead of quietly resetting.
- **Quiet hours are gone.** There is no longer a 21:00–07:00 window that holds messages until morning. It applied to everything on the one shared queue with no way for an app to mark a message urgent — so a staff alert about a declined card was held overnight exactly like a receipt, which removes the reason anyone carries a phone for alerts. It was also being worked out in the wrong timezone: the window was really 17:00–03:00 for a masjid on US Eastern time, so an evening message was held until three in the morning. Everything else that keeps the number safe is unchanged.
- **An app can now ask what happened to a message it sent**, instead of only being told it was accepted. Anything still waiting after a day is dropped rather than released in a burst, and reported as such.
- **Sending to the number WhatsApp itself is linked to is refused**, with an explanation. It would only have gone to that phone’s own notes, which is not somewhere anyone reads alerts — previously it was accepted and then silently went nowhere.

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
