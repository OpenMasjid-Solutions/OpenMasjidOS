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

**Changed — Settings is no longer one long page**

- **Settings now has sections down the side** — Appearance, Account, Email, WhatsApp, Alerts, Payments, Remote access, Advanced — and shows one at a time instead of stacking all eleven panels on a single page you had to scroll through to find anything. Each section has its own address, so a link can now take you straight to the right place rather than to the top of the page. On a phone or a small screen the list becomes a strip across the top that you can swipe.
- **WhatsApp is split into Setup, Groups and Commands**, since it had grown to about a third of the whole Settings page on its own. The tabs only appear once a phone is linked, because groups and commands do not exist before that.

**Added — update all your apps at once**

- **When more than one app has an update waiting, there is now an "Update all" button** on the dashboard. It updates them one after another in a single window, showing progress for each, rather than making you open and watch each one in turn. They are done one at a time on purpose: updating them all at once would take your prayer display, your donations page and your kiosk down in the same moment, and pulling several downloads over one connection is not faster anyway.
- **It checks each app actually came back**, the same as a single update does — an app that starts and then stops again is reported with the reason, instead of being counted as updated.

**Changed — turning WhatsApp off, and the number you linked**

- **Turning WhatsApp off now asks what you actually want.** Before, the switch just went off and quietly kept everything — your gateway key, the linked number, your approved groups and the list of people allowed to send commands all stayed on the server with nothing saying so. If you only wanted a pause, you had no way to know your setup was safe; if you thought you had removed WhatsApp, you hadn't. The switch now asks: turn it off and keep everything (so switching back on picks up exactly where you left off), or **remove the gateway and delete all of it**.
- **Deleting really deletes.** It unlinks your phone from WhatsApp first — while the gateway is still there to do it — then removes the OpenWA app with its data and erases the gateway key, the session, your approved groups, the saved messages, the WhatsApp setting on every alert, and the list of people who could send commands. If WhatsApp can't confirm your phone was released, it says so and tells you to remove it on the phone, rather than showing a tick it can't stand behind.
- **When a phone is linked, the panel now says so.** It used to keep showing an empty "Link your phone" box and a "Get a code" button even when a number was connected and working — which reads as though nothing happened, and invites linking a second phone over a working one. Now the linked number is shown clearly, with an **Unlink this number** button next to it for when the masjid changes handsets. Unlinking keeps your key and your groups, so linking a different phone is just one new code.

**Fixed — phone numbers are readable now**

- **The country list was cut off.** It showed full country names in a box too narrow for them, so anything longer than a few letters was clipped mid-word. It now shows a short country code with the dialling code — `US/CA (+1)`, `UK (+44)`, `PK (+92)` — and the full country name still appears if you hover over it.
- **Numbers are written the way you'd write them.** A number now appears as `+1 (555) 010-1234` rather than a run of digits, everywhere the dashboard shows one back to you — the linked number, and the list of people who can send commands. Numbers outside North America keep sensible spacing rather than a made-up format, because guessing at each country's layout would make correct numbers look wrong.

**Fixed — WhatsApp messages arrive promptly, and predictably**

- **One message that could not go yet was stopping all the others.** The sending queue always looked at the first message in the line; if that one had to wait, it waited with it and looked again — at the same message. So a single message that was held up blocked everything behind it, from every app. Worse, a message that failed and needed retrying paused the whole queue for its retry delay — up to fifteen minutes at a time, five times over. This is why one app’s picture would never arrive while another app’s later messages did. The queue now sends the first message that *can* go, and a message that needs retrying steps aside instead of holding up the rest.
- **All the remaining waiting has been removed.** There was a random six-to-twenty second pause between every message, a one-minute wait before the same person could be messaged again, and a **thirty-minute** wait before the same group could be posted to again — plus hourly and daily limits on group posts that a newly linked number had only a quarter of. Together those meant an announcement might arrive in an hour, or might not, with nothing telling you which. All gone.
- **What still happens before each message:** the typing indicator, sized to the length of what is being sent. That is the only pause now, it is a few seconds, and the person receiving it can see it.
- **Worth knowing:** nothing in OpenMasjidOS now limits how much an app sends. WhatsApp does not officially allow this kind of connection and a blocked number cannot be recovered, so what your apps send is now their responsibility rather than the platform’s.

**Fixed — one app's messages no longer hide another app's**

- **Asking "what happened to my message?" now works even when another app is busy.** The platform remembers the outcome of recent messages so an app can check on one it sent. That memory was a single shared list of 200, so an app sending to a large family list filled it on its own and wiped every other app's records — a donation refund, a card-reader alert — and the app that asked got "no such message" back. Each app now has its own space for its most recent 500, kept for a day, so no app can push out another's.
- **Checking on messages no longer uses up an app's sending allowance.** Looking up an outcome costs nothing to send, but it was counted against the same per-app limit as actually messaging a phone — so an app reconciling a few hundred fee reminders ran out part-way through and stopped being able to send. Lookups now have their own separate, larger allowance.

**Security — a full audit, and one serious hole closed**

- **An app could have been given complete control of the server, with no warning shown.** Before installing any app, OpenMasjidOS checks its configuration for dangerous settings — mounting the server’s own control socket, or the whole filesystem — and refuses. That check could be stepped around: writing one field as a variable instead of a fixed value made the checker skip the inspection entirely, while Docker still resolved it to the dangerous setting when the app started. An app published to the store, or added from a third-party store, could have taken over the machine on the ordinary one-click install with no risk dialog at all. Now caught, along with two related tricks — one that let an app open **another app’s database**, and one that let it join **another app’s private network** and reach services never meant to leave that app.
- **A web address written in an unusual but valid way could point the community app-store fetcher back at the server itself.** The check that blocks private addresses only recognised one spelling of them.
- Smaller fixes: the running version was readable from the internet on one of the two listeners; one app could use up the message-sending allowance belonging to all the others; and a header a caller can invent was still being trusted on one path.
- **Written down honestly, not quietly.** “Local network only” means “not reachable through the remote-access tunnel” — it does **not** mean the server cannot be reached from the internet if it has a public address. If your server has one, put a firewall in front of it;  now explains exactly what is and is not protected, and the README no longer claims the dashboard is never exposed.

**Changed — no more hourly or daily message limit**

- **The cap on how many messages you can send has been removed.** It was 12 an hour, but a newly linked number only got a quarter of that — three an hour — and replies to your own `!os` commands counted against the same allowance. In practice that meant setting WhatsApp up and then not being able to use or even test it.
- *(Superseded later in this same cycle: the 6–20 second gap, the per-person wait and the group limits described here were removed too — see the top of this section. Kept as a record of the order things happened, not as a description of how it behaves now.)*

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
