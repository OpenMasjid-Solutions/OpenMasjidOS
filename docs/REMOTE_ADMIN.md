<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Managing OpenMasjidOS from outside the masjid

**Status: Development channel only, off by default.** This file describes `0.51.2-dev.16`, where
the dashboard is served from outside at an address of its own. `dev.13` to `dev.15` served it
somewhere else; if a box was managed from outside on one of those, read *Updating from
dev.13–dev.15* before updating it. Stable has never had this feature.

The switch is Settings → Remote access → *Manage OpenMasjidOS from outside*. While it is on — and
only while remote access is on, two-step sign-in is set up and the dashboard has an address of its
own — the whole dashboard works from anywhere: every app, files, terminals, backups, restores and
updates. Signing in from outside always takes your password **and** a code from your phone.

This file has three parts:

- **Part 1, the guide** — for the masjid's admin and whoever helps them set it up: what to do,
  what to expect, and what to do when something is refused.
- **Part 2, how it works** — the design, for whoever maintains it.
- **Part 3, history** — how it got here, which is most of the reasoning.

---

# Part 1 — The guide

## Two words used throughout

- **At the masjid** means using the dashboard at the box's own address on the masjid's network:
  `https://<its IP address>`, the address the installer printed. There, signing in takes your
  password, as it always has, and an app opens at its own port.
- **From outside** means using the dashboard through its *dashboard address*, for example
  `https://admin.example.org/`. That counts as outside even on the masjid's own Wi-Fi: the request
  goes out to Cloudflare and comes back in through the tunnel, and OpenMasjidOS cannot tell where
  you are sitting. From outside, signing in takes your password and a code, and apps open through
  your apps' address (*Opening your apps from outside*).

A reverse proxy the masjid runs on its own network — nginx, Caddy or Tailscale Serve in front of
the dashboard, say — is **not** outside. Most masjids have none. If yours has one and it sends
`X-Forwarded-Proto: https`, as most do, signing in through it asks for a code too, but everything
else works as it does at the masjid: apps open at their own ports, and Settings, updates and
restores behave as they do there (*Honest limits*).

## Why there are two addresses

Remote access gives the masjid two web addresses on the same Cloudflare tunnel:

| | Example | What it shows |
|---|---|---|
| **Your apps' address** | `omos.example.org` | your apps, each at its own path, such as `https://omos.example.org/donate/` |
| **Dashboard address** | `admin.example.org` | the OpenMasjidOS dashboard, and nothing else |

A browser treats everything at one web address as one site, whatever comes after the name. If the
dashboard and your apps shared an address, any app page you opened — or a flaw in any public app
page — could act as you in the dashboard: switch the root terminal on and use it, or download a
backup holding every password and key the box keeps. At the masjid the same separation comes from
each app having its own port number. Through the tunnel the only way to keep them apart is a
separate name, so:

- the dashboard is only ever shown at the dashboard address;
- no app is ever shown at the dashboard address.

Without a dashboard address there is no managing from outside at all. Sharing apps online works
exactly as before and does not need one.

## Before you start

You need:

1. **Remote access working for your apps.** In Settings → Remote access: the Cloudflare tunnel
   token saved, *Your apps’ address* filled in, and *Remote access* switched on, with that
   address added as a public hostname in Cloudflare. The guide on that page (*How to set this up
   (step by step)*) covers creating the tunnel; where it says to add **one** route, that one route
   serves all of your apps. The dashboard needs a second one, below. Opening apps from outside
   uses your apps' address, so it is needed even if no app is shared online.

   The token is the long string after `--token` in the command Cloudflare shows. Pasting that
   whole command also works: only the token is kept. A token missing only the `=` signs at its
   end — selecting it with a double-click often leaves them behind — works too: they are put back
   for you. A token that has been cut short is refused before anything is saved — *That doesn't
   look like a whole tunnel token. Please copy it again from Cloudflare — just the long part after
   “--token”.*
2. **Two-step sign-in with an authenticator app.** Settings → Account → *Set up two-step
   sign-in*. Google Authenticator, Authy, 1Password and most password managers all work. Keep the
   ten backup codes it shows somewhere safe and away from the computer: each works once, and they
   are your way in if the phone is lost.
3. **To be at the masjid** for the first setup. The dashboard address can only be set or changed
   there, and the tunnel token can only be replaced there.

## Setting it up

### 1. In Cloudflare: add the dashboard's own hostname

In the Cloudflare Zero Trust dashboard go to Networks → Tunnels → your tunnel → **Public
Hostnames** (newer versions of Cloudflare's dashboard may call this *Published application
routes*), and add a **second** hostname, set up exactly like your apps' one except for its name:

- **Subdomain + Domain:** a new name — for example `admin` + `example.org`, which makes
  `admin.example.org`. It must not be your apps' address.
- **Path:** leave empty.
- **Service → Type:** **HTTP**, not HTTPS. **URL:** `localhost:80`, the same as your apps'
  hostname. Settings shows the exact port under *Dashboard address*; on a box set up with the
  installer it is 80.

Leave *No TLS Verify* off; it is not needed. Cloudflare adds the DNS record by itself. This step
can be done from anywhere.

### 2. In Settings → Remote access, at the masjid

Type the new name into **Dashboard address** — just `admin.example.org` — and press **Save**. A
pasted `https://`, or anything after the name, is removed for you.

The same Save stores your apps' address and the tunnel token too (leave the token box empty to
keep the saved one). An address is sent only if you changed its box, so one you did not touch
keeps what is stored, even if someone changed it on another device meanwhile; after a save goes
through, both boxes show the addresses exactly as they were stored. Everything is checked before
anything is stored, so if it refuses, nothing has changed — not the addresses, not the token — and
the boxes keep what you typed, for you to correct. It refuses:

- something that is not a web name, such as an IP address: *Enter a web address like
  admin.example.org — no https:// and nothing after it.*
- the same name as your apps' address, however it is spelt (capitals, a port or a trailing dot do
  not make two names different): *The dashboard needs an address of its own — not the one your
  apps use…*
- a tunnel token that is not a whole one: *That doesn't look like a whole tunnel token…*
- from outside, any change to the *Dashboard address* or the tunnel token. Both boxes are greyed
  out there (*What only works at the masjid*).

### 3. Switch on *Manage OpenMasjidOS from outside*

It asks first — *Open your dashboard to the internet?* — because after this the sign-in page at
your dashboard address answers to anyone on the internet who knows the address. Read it, then
press **Yes, open it**. Settings then shows *Your dashboard is reachable at
https://admin.example.org/*.

If the switch is greyed out, the line under it says what is missing:

| The line under the switch says | Do this |
|---|---|
| *Set up two-step sign-in first…* | Settings → Account → *Set up two-step sign-in* (the button under the line goes there). |
| *Turn on remote access above first…* | Switch *Remote access* on, at the top of the same page. |
| *Give the dashboard an address of its own first…* | Steps 1 and 2. |

The dot beside the switch shows whether it is actually working. It stops working by itself,
without the switch moving, the moment any of those three stops being true: turn two-step sign-in
off, or remote access off, and the dashboard closes to outside straight away.

### 4. Sign in from outside

Open `https://admin.example.org/` from anywhere, sign in with your username and password, then
type the code from your authenticator app — or a backup code, or, if you allowed them, press
*Email me a code instead*. Each sign-in waits up to ten minutes for its code and allows five wrong
codes; after that it sends you back to the password step.

A phone with Wi-Fi switched off makes a good first test.

## What works from outside

Everything the dashboard does at the masjid, with the same screens and the same checks:

- **your apps** — open, start, stop, install, update (each on its own or all together), remove,
  logs — and **every app with a web page opens**, whether or not it is shared online (next section);
- **Files**, with the same platform files kept out of reach as at the masjid;
- **the app shells and the root terminal**, once switched on in Settings → Advanced (*Enable app
  shells*, *Enable root terminal*). Those switches can be changed from outside too, so what guards
  a terminal from outside is what guards everything else: your password and your code. A terminal
  left at a prompt, or in an editor while you think, stays open: OpenMasjidOS keeps the
  dashboard's connections alive, where Cloudflare would otherwise close one that had carried
  nothing for about 100 seconds;
- **Download a backup** and **Restore**, with a safety rule (*Restoring a backup from outside*);
- **updating OpenMasjidOS** and your apps, and changing the update channel — as long as the
  version it would move OpenMasjidOS to can itself be managed from outside, which today rules out
  going back to Stable (*What only works at the masjid*). Each update's window says how it ended
  (*Updating from outside*);
- the masjid logo, and every page of Settings — except changing the *Dashboard address* and
  replacing the tunnel token (*What only works at the masjid*).

## Opening your apps from outside

At the masjid an app opens at its own port, as always, and so it does when the dashboard is
reached through a reverse proxy at the masjid. From outside there is no such port, so pressing
**Open**:

1. opens a new tab straight away, so a pop-up blocker lets it through;
2. asks OpenMasjidOS for a link that opens that one app, works once and lasts one minute;
3. sends the tab there, on your **apps' address** — never the dashboard's. That signs this
   browser in to **that app only**, and shows it at `https://omos.example.org/<its path>/`.

OpenMasjid apps that sign you in through the dashboard do the same here, without asking for a
password of their own.

**Apps you have not shared online open this way too — for you, in that browser, and for nobody
else.** Anyone else asking for that address gets the same *There is no page at this address* as
an address with nothing at it. Opening an app does not share it: Settings → Remote access still
says *Not shared online — only on the masjid’s network, and for you when you manage from
outside*.

That sign-in to the app is tied to your sign-in to the dashboard from outside. When that ends —
you sign out, the password changes, a change to two-step sign-in signs it out, or seven days pass
— the app needs **Open** pressed again, and any live connection (a WebSocket) the app had open
with it is closed within seconds; an ordinary request already under way is not (*Honest
limits*). It also stops working while managing from outside is switched off.

If a tab says **This link has expired**, the link was already used, was more than a minute old,
or you were signed out in the meantime: go back to the dashboard and press Open again.

An app's path — its id, unless it was given another — can be changed in Settings → Remote access,
under *Your apps will be reachable at:*, once the app is shared online; for an app that is not,
that list shows *Not shared online…* where the address would be. Three paths belong to
OpenMasjidOS itself and are refused — `/api`, `/trpc` and `/assets` — and so is a path another
installed app already uses. A newly installed app whose usual path is already taken gets the next
free one, such as `/donations-2`.

## What only works at the masjid

- **Changing or clearing the Dashboard address.** From outside the field is greyed out and says
  *Change this at the masjid — changing it from outside would cut you off.* The server refuses the
  change too, whatever sends it.
- **Replacing the tunnel token.** From outside the token box is greyed out and says *Replace the
  tunnel token at the masjid — a token that doesn’t work would cut you off from here.* Saving a
  token restarts the tunnel, which is the very connection your window uses, and a token for
  another tunnel connects to nothing of yours: this window and every shared app would go offline
  until someone at the masjid put it right. The server refuses a different token from outside
  too, whatever sends it; the token already in use is accepted, and changes nothing.
- **Moving OpenMasjidOS to a version that cannot be managed from outside.** Today that means
  going back to Stable, which has not had this feature yet: OpenMasjidOS would come back with
  nothing at your dashboard address, and only someone at the masjid could reach it again. So from
  outside, choosing Stable as the update channel is refused before anything changes — *Stable
  (version …) can't be managed from outside the masjid, so switching to it from here would cut
  you off. Please make this change at the masjid. Nothing was changed.* — and so is installing
  any such version: the update window says *Version … can't be managed from outside the masjid,
  so installing it from here would cut you off.* and *Please do this at the masjid. Nothing was
  changed.* If OpenMasjidOS cannot find out which version it would move to, it refuses from
  outside too (*Couldn't check which version …*): try again in a little while. Once Stable has
  this feature, switching to it works from outside like everything else.
- **Setting up a new box** — creating the admin account, or restoring a backup onto a box that has
  none. Both are refused from outside.
- **A restore that would lock you out** (*Restoring a backup from outside*).
- **Anything bigger than Cloudflare accepts in one upload** — 100 MB on its free plan — so a large
  restore or a large file upload is a job for the masjid. The dashboard says so before it tries:
  *That backup is larger than 100 MB, which is more than can be sent over your internet link.
  Restore it at the masjid instead.*, and the same for a file in Files (*…Upload it at the masjid
  instead.*).
- **OpenWA's own screen.** The WhatsApp gateway's *Open OpenWA* button is greyed out from outside:
  that screen does not work under a path, which is how the tunnel reaches an app. Everything
  WhatsApp needs is in Settings → WhatsApp, which does work from outside.
- **Signing in with a password alone.** From outside a code is always needed.

Some addresses are never served from outside, whatever is switched on: the connections your apps
use to talk to OpenMasjidOS (`/api/fabric/…`, which carry every app's key and your Stripe keys),
the single sign-on check apps make (`/api/auth/session`), the health checks (`/api/health`,
`/api/ready`), and each app's own `/fabric/…` area. Nothing you do in the dashboard needs them from
outside.

## When the dashboard asks first, from outside

From outside, a few controls would cut off the very connection you are using, and only someone at
the masjid could switch them back on. So from outside they ask first. At the masjid they act
straight away, as they always have: there, none of them cuts you off.

| You press | It asks | What happens |
|---|---|---|
| *Remote access* off | *Turn off remote access?* | The tunnel stops: this window loses its connection and every shared app goes offline. |
| *Manage OpenMasjidOS from outside* off | *Stop managing from outside?* | The dashboard closes to outside, this window included. Shared apps stay online. |
| *Remove tunnel* | *Remove the tunnel?* | Remote access goes off and the tunnel's key is deleted: this window stops working and every shared app goes offline. It also switches *Manage OpenMasjidOS from outside* off, so with the next tunnel it has to be switched on again. |

Each one ends: *Only someone at the masjid can turn it back on.* After turning remote access off
or removing the tunnel, the answer cannot come back — it would come through the tunnel you have
just stopped — so the dashboard says *Done — this window can’t reach the dashboard any more.
Someone at the masjid can turn it back on.* That is the switch having worked.

**Turning two-step sign-in off** (Settings → Account) asks for your password and a code wherever
you are. From outside, its dialog says what it does there — *You’re using the dashboard from
outside the masjid. Turning two-step sign-in off closes it to outside straight away — this window
too. Changing phones? Use “Use a different phone” instead; that keeps you signed in.* — and ends
with the same line about the masjid.

Two changes that would cut you off are not offered from outside at all — the *Dashboard address*
and the tunnel token — and a third, moving OpenMasjidOS to a version that cannot be managed from
outside, is refused when you try (*What only works at the masjid*).

Switching remote access or managing from outside **off** shuts the door; it does not sign anyone
out. If it is switched on again before that sign-in's seven days are up, a browser that was
signed in from outside is signed in again. To end those sign-ins for good, change the password or
make new backup codes; signing out in that browser also works, while it can still reach the
dashboard.

## Two-step sign-in, from outside

- **Changing it signs out everyone else who is signed in from outside.** Setting up a different
  phone (*Use a different phone*), making new backup codes, allowing or stopping emailed codes, and
  turning two-step sign-in off each end, at once, every session that was signed in from outside:
  whoever was using one is signed out — anything they had open, a terminal included, is closed —
  and the apps they opened lose the sign-in that *Open* gave them. If you make the change from
  outside, **your own session carries on**, so you can still read new backup codes, which are
  shown only once — except when the change is turning two-step sign-in off, which closes the
  dashboard to outside altogether, your window included. Using a code to sign in signs nobody
  out. Sessions at the masjid are not affected — they never needed a code. A password change is
  what ends those.
- **Changing your password** signs out every session, at the masjid and outside, except the
  browser you changed it in.
- **While a backup is being restored, two-step sign-in cannot be changed**, at the masjid or from
  outside — hardly anything can (*Restoring a backup from outside*). From the moment a restore
  starts until OpenMasjidOS has restarted at its end, setting up a phone, making new backup codes,
  allowing or stopping emailed codes and turning it off each say *A backup is being restored right
  now. Please try this again once it has finished.* — or, once the restore is done and
  OpenMasjidOS is restarting, *OpenMasjidOS is restarting to finish restoring your backup. Please
  try again in a minute or two. Nothing was changed.* — before any code is used up. Signing in
  still works.
- **Emailed codes are a backup to an authenticator app, never a replacement.** They can be allowed
  only once an authenticator app is set up, an email provider is set up in Settings → Email, and
  your account has an email address. A code is good for ten minutes, a new one can be asked for
  once a minute, and five wrong tries use it up.
- **Emailed codes pause when their destination changes:** the email address on your account
  (Settings → Account), or the email provider settings (Settings → Email) — the provider; the SMTP
  server, port, security setting or username; or the Resend key. Changing only the *From* address
  or the SMTP password does not pause them. While paused, none are sent or accepted, and the
  two-step panel says *Paused: …* — or, if there is no email provider or no email address on your
  account any more, which of the two to set up first. Switch them on again there: it asks for your
  password and a code from your authenticator app (or a backup code). This is on purpose:
  otherwise someone signed in at the masjid with only your password could send the next code to
  themselves.
- **If a code is refused at sign-in because the server's clock is wrong**, the message says so —
  *That code would have been right if this server's clock were correct…* — and someone with access
  to the machine needs to correct its clock. Backup codes do not depend on the clock, so they
  still work.

### If you lose your phone

- **From outside:** sign in with your password and a backup code (or an emailed code, if you
  allowed them). Then go to Settings → Account → *Use a different phone*, which asks for your
  password and a code: use another backup code (each works once). Setting up the new phone gives
  you a fresh set of backup codes and signs out every other session from outside, including any
  made with the lost phone. Use that button, not *Turn off two-step sign-in*: turning it off from
  outside shuts your own window out at once.
- **At the masjid:** sign in with your password alone, then do the same. Replacing the phone still
  asks for a code, so you need a backup code here too.
- **With no phone and no backup codes**, the dashboard offers no way to replace or remove two-step
  sign-in — not even at the masjid: each of those changes asks for a code from the authenticator
  app or a backup code, and an emailed code is only ever sent while signing in from outside. The
  dashboard keeps working at the masjid with your password, and from outside emailed codes still
  sign you in if you allowed them. The way out is the installer's **Reset sign-in**, run on the
  machine itself, at it or over SSH:
  1. Run the installer's one-line command again and choose *Reset sign-in*. Type `RESET` to
     confirm, then give a username and a new password.
  2. It then asks *Turn off two-step sign-in as well? Choose this if the phone with your
     authenticator app is lost and you have no backup codes.* Answer `y`. It asks only while
     two-step sign-in is on, and anything but a yes leaves it on.
  3. It also signs everyone out, everywhere, and gives every app a new sign-in key before
     restarting OpenMasjidOS. Your apps and their data are kept; open each app once afterwards to
     re-link it.
  4. At the masjid, sign in with the new password and set two-step sign-in up again in Settings →
     Account. Managing from outside stays off until you do, and comes back by itself when you do:
     the switch in Settings → Remote access is left as it was.

  This is the only supported way to remove two-step sign-in without a current code. It gives
  nothing away, because whoever runs it already has the machine. The *Forgot your password?*
  command on the sign-in screen resets the password only; while two-step sign-in is on, it says
  to use *Reset sign-in* for a lost phone.

Keep the backup codes safe, and make a new set when the two-step panel says few are left.

## Restoring a backup from outside

A restore replaces every setting, including the ones that let you in from outside: the address,
the tunnel, the password and two-step sign-in. At the masjid that is simply what restoring means.
From outside, a backup made before you set this up would lock you out, and only someone at the
masjid could let you back in. So from outside the confirmation adds *You’re managing from outside
the masjid, so this only goes ahead if the backup keeps your way back in…*, and a restore goes
ahead only if the backup has:

- remote access and *Manage OpenMasjidOS from outside* both on, with the **same dashboard
  address** as now, and an apps' address that is not that one;
- the **same tunnel token**;
- the **same password** — the same stored password, so one changed since the backup was made counts
  as different, even if it was set back to the same words;
- the **same authenticator app**. Backup codes do not matter for this check. A setup with emailed
  codes and no authenticator app is always refused from outside.

Otherwise it stops after reading the file and **before** anything is stopped or replaced, with
one of these:

- *This backup would switch off managing OpenMasjidOS from outside, so restoring it from here would
  lock you out. Nothing has been changed. Restore it at the masjid instead.*
- *This backup has a different password or two-step sign-in from the ones you use now, so restoring
  it from here could lock you out. Nothing has been changed. Restore it at the masjid instead.*

The restore window says how it ended:

| It says | It means |
|---|---|
| *Nothing was changed. The messages above say why.* | It stopped before changing anything, and before stopping any app: refused as above; another restore, an update of OpenMasjidOS or an app's update already under way (*OpenMasjidOS is being updated right now. Please restore your backup once it has finished. Nothing was changed.*); a file it could not read, would not trust or could not unpack without filling the disk; a sign-in that had ended; or a backup with nothing in it to put back (*That backup had nothing to restore. Nothing has been changed.*). The line above says which. The box is as it was. |
| *Couldn't connect to OpenMasjidOS, so nothing was changed. Please try again.* | The window never reached OpenMasjidOS, so the restore never started. |
| *Restarting OpenMasjidOS — reconnecting…*, then *Restore complete.* | It ran, and OpenMasjidOS restarted. Press *Reload dashboard*. |
| *Restarting OpenMasjidOS — reconnecting…*, then *The restore finished, but some of your apps or their data need attention — the messages above say which. Please check them before relying on this restore. The dashboard will remind you after you sign in again.* | It ran and OpenMasjidOS restarted, but some apps' data did not come back, some apps did not start, or some apps could not be paused before their data was put back. The lines above name them: *Affected: …* for data; *(not started — …)* or *(couldn't start — …)* under an app that did not start; and *(couldn't pause it — its data may not restore cleanly)* beside an app Docker would not pause, whose data was put back while it went on running. An app without its data starts with whatever was already on this machine. Check each before relying on it. |
| *Restarting OpenMasjidOS — reconnecting…*, then *OpenMasjidOS has restarted, but this window lost touch with the restore before it said how it went. Please reload, sign in again and check that your apps and settings look right.* | The window's connection dropped before the restore said how it ended — a laptop that went to sleep, a moment without Wi-Fi — and OpenMasjidOS has restarted since. The restore may have gone well or not. Reload, sign in, and look over your apps and settings; if the restore knew of a problem, the dashboard says so (*Your last restore needs a look*, below). |
| *The dashboard hasn’t restarted yet. If nothing changes in a minute or two, reload this page.* | No restart seen after about half a minute. It goes on waiting, for about four minutes in all; a slow restart still ends on one of the endings above. |
| *Your backup was restored, but OpenMasjidOS couldn't restart itself to finish. Restarting the machine finishes it — or someone at the masjid can run the install command again and choose Repair.* | Everything was put back, but OpenMasjidOS could not start the restart that finishes a restore. Either way of finishing it needs someone with access to the machine. There is no need to restore again: that would only stop every app again. |
| *The restore stopped before it could finish. The messages above say what happened — reload to see where things stand.* | Something went wrong part-way, after it had begun changing things. Read the lines above it, reload, and check your apps: any it had stopped for the restore may still be stopped. If the dashboard itself does not come back properly, someone with access to the machine can run the installer's *Repair*. |

The window counts OpenMasjidOS as restarted only once it has failed to answer twice in a row and
then answered again, so a single blip in the connection is not taken for the restart.

While an update of OpenMasjidOS is under way, a restore is refused before the backup is read or
saved, with the message above, and the restore window does not open (your browser may still send
the file first). So is one asked for while another restore
runs (*A restore is already running. Please wait for it to finish.*), and in the moments after an
update or a restore has finished, while OpenMasjidOS restarts (*OpenMasjidOS is restarting to
finish an update. Please try again in a minute or two. Nothing was changed.*, or *… to finish
restoring your backup. …*). Nor can a restore start while a backup is being made (*A backup is being
made right now. Please restore once it has finished. Nothing was changed.*), and a backup asked
for during a restore is refused (*A backup is being restored right now. Please make a backup
once it has finished.*): either way one would copy or replace data the other is using. A backup
refused because something else was under way is not kept on
the box: it holds every password and key the box has. Nor is one a restore never finished with,
after a power cut, say: it is removed the next time OpenMasjidOS starts.

**While a restore runs, almost nothing can be changed** — at the masjid or from outside — until
OpenMasjidOS has restarted at its end. A restore replaces every setting, so a change made meanwhile
used to be quietly undone: a new password, or managing from outside switched off, both back as they
were after the restart. Now the buttons that change things — a setting, your password, two-step
sign-in, the logo, starting, installing or removing an app — say *A backup is being restored right
now. Please try this again once it has finished.* Once the restore itself is done and OpenMasjidOS
is restarting to finish it, the same buttons say *OpenMasjidOS is restarting to finish restoring
your backup. Please try again in a minute or two. Nothing was changed.* Looking around still works,
and so do signing in and out. Turning an app off still works too — the restore pauses every app
anyway — and so does **Open** from outside, which changes nothing. Over WhatsApp, `!os start` and
`!os restart` answer *A backup is being restored right now. Your apps will start again on their own
when it has finished. Nothing was changed.* (or, in those last moments, the *restarting to finish*
sentence). The restore pauses your apps and starts them again at its end, so no alert says an app
has stopped meanwhile, and a scheduled off-site backup waits for its next turn. (Files and the
terminals are the exception — *Honest limits*.)

After a restore, **sign in again**, with your password and a code: a restore ends every sign-in
when OpenMasjidOS restarts. OpenMasjidOS comes back on the same version it was running before the
restore. Your backup codes are now the ones in the backup — codes made since stop working, and
codes used since work again — so make a new set if that matters to you.

By then the restore window is gone, so if some apps' data could not be put back, some apps did not
start, or some could not be paused, the dashboard says so again after you sign in — *Your last
restore needs a look*, with whichever of these apply: *These apps' data couldn't be put back, so
they have whatever was already on this machine: …*, *These apps didn't start after the restore: …
Open each one to see why.* and *These apps couldn't be paused for the restore, so their data may
not have been put back cleanly: …. Please check them.* It stays until you press *I've checked
them*.

## Downloading a backup from outside

**Download a backup** works from outside, a little differently. At the masjid the browser waits
while OpenMasjidOS copies every app's data, then the file arrives. Cloudflare gives up on an
address that has not started answering within 100 seconds, so from outside the download starts
straight away — it may sit at 0 bytes for a while — and the file follows once it is made.

- If something goes wrong after it has started, the download is broken off and your browser shows
  it as failed. The file is finished only once the backup has reported success — at the masjid as
  well — so you are never left with a partial file that looks complete.
- If you cancel it, or the connection drops, the backup is stopped cleanly — once it has finished
  copying your apps' data, if it was in the middle of that — and the next one, a scheduled
  off-site backup included, can run.
- One backup runs at a time. If one is already running, your browser shows a short message
  instead of saving a file — *A backup is already running. Please wait for it to finish and try
  again.* — so go back to the dashboard and try a little later.
- **Limit:** Cloudflare may still drop a download that stays silent for around 100 seconds while a
  large install's data is copied. If that happens, download it at the masjid, or use *Off-site
  backups* (Settings → Advanced), which run on the box itself and do not go through the tunnel.

A backup holds everything — the details your apps keep about people, your payment keys, your email
password and your tunnel token — and the file is not password-protected. From outside, the copy
lands wherever your browser saves it, so keep it somewhere only you can reach.

## Updating from outside

Updating OpenMasjidOS and your apps works from outside as it does at the masjid — the same
buttons, the same windows — with one rule of its own: never to a version that cannot be managed
from outside (*What only works at the masjid*). From outside you cannot see the machine restart,
so two more things are worth knowing.

**One at a time.** An update of OpenMasjidOS and a restore each end by restarting OpenMasjidOS,
and a restore stops every app while it puts their data back, so neither runs alongside the other
or alongside an app's update. Whichever is started second changes nothing and says what is in the
way — for example *A backup is being restored right now. Please update OpenMasjidOS once it has
finished. Nothing was changed.*, or *OpenMasjidOS is being updated right now. Please update this
app once it has finished. Nothing was changed.* Two different apps can still be updated at once.

Each counts as under way **until OpenMasjidOS has actually restarted**, not just until it has
handed the restart over: the old OpenMasjidOS goes on running for about twelve seconds after that,
and work started in those seconds used to be cut off by the restart. In those last moments,
whatever is held back says so plainly — *OpenMasjidOS is restarting to finish an update. Please
try again in a minute or two. Nothing was changed.*, or *OpenMasjidOS is restarting to finish
restoring your backup. Please try again in a minute or two. Nothing was changed.* — and trying
again once the dashboard is back works. If the restart never comes, the rule lets go by itself
five minutes after the hand-over, so it cannot leave the box stuck.

Apps wait too:

- while a restore runs, no app can be started, restarted, installed or removed — from the
  dashboard almost nothing can be changed then (*Restoring a backup from outside*);
- while an app is being updated, that app cannot be started, restarted or removed: *This app is
  being updated right now. Please try again once it has finished. Nothing was changed.*;
- while OpenMasjidOS itself is being updated, apps cannot be installed or removed — *OpenMasjidOS
  is being updated right now. Please install this app once it has finished. Nothing was
  changed.* (or *remove*) — but they can still be started and stopped.

**Every window says how its update ended.** The OpenMasjidOS update window:

| It says | It means |
|---|---|
| *Applying the update and restarting — reconnecting…*, then *Updated to v…* | It worked: the new version is answering. Press *Reload dashboard*. (*Update applied.* means it saw OpenMasjidOS go down and come back without being able to see the version.) |
| *Nothing was changed. The messages above say why.* | Nothing was touched — already up to date, the newest version could not be checked, the download failed, something else was under way, that version cannot be managed from outside, or this machine is pinned to one exact build (*OpenMasjidOS is pinned to one exact build on this machine, so it can't update itself from here. Nothing was changed.*). The lines above say which. |
| *OpenMasjidOS hasn't restarted yet. If nothing changes in a minute or two, reload this page to see which version is running.* | About half a minute with no sign of the restart. The window can be closed now; it goes on watching for about three minutes in all, and a restart that is merely slow still ends on *Updated to v…*. |
| *OpenMasjidOS restarted, but it is still on v…. Reload this page, then try the update again.* | It came back still on the version it had before, and about half a minute later had not restarted again: the update did not take. |
| *Couldn't connect to OpenMasjidOS, so nothing was changed. Please try again.* | The window never reached OpenMasjidOS, so the update never started. |

As in the restore window, OpenMasjidOS counts as having restarted only once it has failed to
answer twice in a row and then answered again: a single blip is not taken for the restart.

An app's update window says *Donations is up to date now.* only when it is. Otherwise it ends on
one of these:

- *Nothing was changed. The messages above say why.* — already up to date, refused, or put back
  as it was after a download or a start that failed;
- *Donations was updated, but it isn't staying running — the messages above say why.*;
- *The update stopped before it could finish. The messages above say what happened — check
  Donations in a minute.*;
- *We lost touch with this update. Check Donations in a minute — it may still be finishing.* —
  the window's connection dropped part-way; the update itself carries on;
- *Couldn't connect to OpenMasjidOS, so nothing was changed. Please try again.*

Updating every app at once (*Update all 4 apps*, on the dashboard) counts only the apps that
really were updated — *All 4 apps updated.*, or *3 of 4 apps updated. The messages above say what
happened to the others.* The window that moves your apps to another update channel counts the
same way (*3 of 4 apps are now on Stable — the messages above say what happened to the
others.*), and when it goes on to move OpenMasjidOS itself and that does not happen, it says
*OpenMasjidOS itself was not changed — the messages above say why.*

## Updating from dev.13–dev.15

If this box was managed from outside on `0.51.2-dev.13`, `dev.14` or `dev.15`: those builds showed
the dashboard at the root of your **apps'** address, `https://omos.example.org/`. This build does
not, on purpose (*Why there are two addresses*), and there is no dashboard address set yet. So
straight after updating:

- **managing from outside is off** until a dashboard address is set, and that can only be done at
  the masjid;
- the old address shows *There is no page at this address*;
- in Settings → Remote access the switch is still on, with the line under it saying *Give the
  dashboard an address of its own first — see “Dashboard address” above.* *Recently turned away*
  lists visits to the old address as *The dashboard, from outside — but it has no address of its
  own yet…*;
- your apps are not affected: shared apps stay at your apps' address.

To bring it back:

1. **In Cloudflare** — before or after the update, from anywhere — add the second public hostname
   (*Setting it up*, step 1).
2. **Update.** Those builds could not start an OpenMasjidOS update from the remote dashboard
   anyway, so the update is started at the masjid or with the installer.
3. **At the masjid**, on any device on the masjid's network, open `https://<the box's IP
   address>`, go to Settings → Remote access, type the name into *Dashboard address* and press
   **Save**. The switch takes effect at once; there is no need to turn it off and on.
4. **Sign in at the new address**, `https://admin.example.org/`, with your password and a code.
   Sign-ins made on those builds do not carry over. Update your bookmarks: the old address now
   refuses the dashboard, and *Recently turned away* lists it as *The dashboard, asked for at an
   address that isn’t its own…*.

Step 3 cannot be skipped or done in advance. The dashboard address can be set only from the
dashboard, at the masjid; those builds do not have the field; and nothing else sets it — no
WhatsApp command, no installer option. OpenMasjidOS does not raise an alert or show a notice about
it after the update either: on the dashboard, only Settings → Remote access says so, once someone
opens it, and otherwise only this file and the Development release notes (*What's new*) mention
it. So **only update a box you manage from outside when someone can reach the dashboard at the
masjid afterwards**, and tell them before you start.

## Troubleshooting

### *Recently turned away*

A request that came through the tunnel and was not served gets the same answer whatever the reason
— the page *There is no page at this address*, or the same short error for a request that was not
a page — so a stranger learns nothing about what is installed. The page shows a six-character
**Reference**. (One kind of request is answered differently, and also the same way whatever is
installed: a background worker asked for at an app's bare address — the last row below.)

Settings → Remote access → *Recently turned away* lists the same requests with the real reason:
the address asked for (hostname included), the reference, whether it was a page or data,
Cloudflare's own request id, the browser that asked, and how many times (`×3`). Ask whoever saw
the error for the reference, and find it there. Only you see this list, at the masjid or signed in
from outside, and it appears only once something has been turned away. It holds the 25 most recent
different refusals, refreshes every 15 seconds while it is open, and is emptied when OpenMasjidOS
restarts. Requests browsers make on their own, such as `/robots.txt`, are not listed.

There are ten reasons. Each is shown in its own words:

| Shown as | Reason | What it means | What to do |
|---|---|---|---|
| *No app is published at that address* | `no-app-at-path` | Nothing is served at that path on your apps' address: a typing mistake, an app that is stopped, removed or has no web page, or a path that has changed. Also an *Open* link used at the dashboard address, or while managing from outside is off. | Check the path under *Your apps will be reachable at:*, and that the app is running. |
| *An app you haven’t shared online (it opens for you from the dashboard when you manage from outside)* | `app-not-shared` | An app that is not shared online, asked for without the sign-in that *Open* gives — by someone else, or by you after that sign-in ended. | You: press **Open** on the dashboard again. If the public should reach it, switch *Shared online* on for it. |
| *The app's private area* | `app-fabric-lan-only` | An app's own `/fabric/…` address, which apps use on the masjid's network only. Never served from outside, not even after *Open*. | Usually nothing. If an app's feature needs it from outside, that is a problem in the app. |
| *Local network only* | `lan-only-route` | One of OpenMasjidOS's own `/api/…` addresses that are never served from outside (the ones apps use to talk to it, the single sign-on check, the health checks); or the dashboard, asked for while managing from outside is not in effect because the switch is off or two-step sign-in is not set up. | If it was you trying to reach the dashboard: at the masjid, check the switch and Settings → Account. Otherwise nothing; these are meant for the masjid's network. |
| *The dashboard, from outside — but it has no address of its own yet. Set “Dashboard address” above, at the masjid* | `no-admin-host` | The dashboard, asked for from outside while remote access and managing from outside are both switched on and two-step sign-in is set up, but there is no dashboard address (or it is the same as your apps' address). A box updated from dev.13–dev.15 looks exactly like this. | At the masjid, set *Dashboard address* (*Updating from dev.13–dev.15*). |
| *The dashboard, asked for at an address that isn’t its own (from outside it is only at your dashboard address)* | `dashboard-elsewhere` | The dashboard, asked for at another address — usually your apps' address, where dev.13–dev.15 kept it. | Use your dashboard address, and update old bookmarks. |
| *An app, asked for at the dashboard’s address (apps are only at your apps’ address)* | `app-on-admin-host` | An app's path, asked for at the dashboard address. Apps are only ever at your apps' address. | Use `https://<your apps' address>/<its path>/`, or press **Open**. |
| *Reached the dashboard’s own secure port directly. In Cloudflare, set this hostname to Type HTTP and URL localhost:80* | `wrong-port` | A Cloudflare hostname points at the dashboard's own HTTPS port (443) instead of `localhost:80`. The dashboard answers nothing from Cloudflare that did not come through the front door on port 80, so the switch and the address rules cannot be walked round. (Such a hostname usually gets this far only with *No TLS Verify* switched on; without it Cloudflare shows its own error page and nothing reaches OpenMasjidOS.) The port on screen is your box's; on a box set up with the installer it is 80. | In Cloudflare, set that hostname to Type **HTTP** and URL **`localhost:80`**. |
| *Opened over http:// at an address that couldn’t be moved to https:// — use the https:// address* | `plain-http-no-host` | A plain `http://` visit to the dashboard address that could not safely be sent on to `https://`. Every ordinary `http://` visit is sent on by itself; this happens only for a malformed address, one beginning with two slashes (`//`). | Open `https://<your dashboard address>/` directly. |
| *A background worker asked for at an app’s bare address — answered with one that removes itself, as it could reach every app* | `worker-at-bare-address` | A browser asked for a background script (a *service worker*, which goes on running and sees every page under its address) at an app's bare address — `/<its path>` with no `/` at the end. From there it would have covered your whole apps' address: every other app, and the links *Open* uses. Instead of the app's script it is given a tiny one that removes itself — which also clears such a worker away if an older version of OpenMasjidOS let an app install one there. Everything else at the bare address still reaches the app. (Made at the masjid through OpenMasjidOS's own address, rather than the app's own port, the same request gets the same answer but is not listed: this list holds only what came in through your internet link.) | Nothing to fix on your side. If that app seems to miss it, tell whoever made the app: a worker belongs under `/<its path>/`. |

### Other problems

- **Cloudflare's own error page instead of OpenMasjidOS** (for example *502 Bad Gateway*). The
  tunnel did not reach OpenMasjidOS. In Cloudflare, check the hostname: Type **HTTP** — Type
  HTTPS against port 80 gives exactly this 502 — URL `localhost:80`, Path empty. At the masjid,
  look at the line under *Remote access* in Settings → Remote access. *Tunnel is turned on but
  isn't connecting. Check that the tunnel token is the right one and that this machine is
  online.*, beside a red dot, means the tunnel's program on the box is not staying up — most often
  because Cloudflare will not accept its token: paste the token again. *Tunnel is running.* only
  says that program is up: with a token for a different tunnel it runs and still reaches nothing
  of yours, so also check in Cloudflare that your tunnel shows as connected. The error page also
  shows for a minute or so while OpenMasjidOS restarts after an update or a restore.
- **The tunnel token box, or the Dashboard address box, is greyed out.** You are using the
  dashboard from outside; change them at the masjid (*What only works at the masjid*).
- ***That doesn't look like a whole tunnel token…*** Part of the token was missed when it was
  copied. Copy it again from Cloudflare — the long string after `--token`, or the whole command
  around it. Nothing was saved. (A token missing only the `=` signs at its end is not refused:
  they are put back for you.)
- ***There is no page at this address* instead of the sign-in page.** Find its reference in
  *Recently turned away* (above).
- **The switch is greyed out.** The line under it says why (*Setting it up*, step 3).
- **Open does nothing** (or, from an app's card, shows that app's details instead). Your browser
  blocked the new tab: allow pop-ups for your dashboard address.
- ***That app couldn’t be opened. Please try again.*** The dashboard could not reach OpenMasjidOS
  just then — it may be restarting, or managing from outside was just switched off. If it says
  *Your apps have no web address yet…* instead, fill in *Your apps’ address* in Settings → Remote
  access.
- **An app opens from outside but looks broken** — no styling, a blank page, links that go
  nowhere. The app is not built to live under a path. Every OpenMasjid app is; an app from a
  community store or a pasted compose file may not be. Use it at the masjid.
- ***Too many attempts from this connection. Please try again in … minutes.*** Ten wrong passwords
  or codes from one internet connection, with no more than fifteen minutes between one and the
  next, lock that connection out for fifteen minutes; a correct password starts the count again.
  It does not lock you out anywhere else.
- ***That code is not right — 3 tries left.*** Each sign-in allows five wrong codes. After the
  last one you start again from the password.
- **Signed out after a restore**, or after the password or two-step sign-in changed — expected
  (*Two-step sign-in, from outside*).
- **Every app you opened from outside wants opening again** — your dashboard sign-in ended. Press
  Open.
- ***That file is larger than 100 MB…*** or ***That backup is larger than 100 MB…*** — more than
  Cloudflare carries in one upload on its free plan. Upload or restore it at the masjid.
- ***Done — this window can’t reach the dashboard any more…*** after turning remote access off or
  removing the tunnel from outside — expected (*When the dashboard asks first, from outside*).
- ***Nothing was changed. The messages above say why.*** at the end of an update — the update did
  not happen, and nothing needs undoing. The lines above it say why (*Updating from outside*). If
  they say *Please sign in again, then start the update once more.*, your sign-in had ended:
  reload the page, sign in and try again.
- ***OpenMasjidOS is being updated right now…***, ***A backup is being restored right now…***,
  ***An app is being updated right now…*** or ***This app is being updated right now…***, ending
  *… once it has finished. Nothing was changed.* — something else was already under way, and these
  run one at a time (*Updating from outside*). Wait for it to finish, then try again.
- ***OpenMasjidOS is restarting to finish an update…*** or ***OpenMasjidOS is restarting to
  finish restoring your backup…***, ending *Please try again in a minute or two. Nothing was
  changed.* — the update or the restore is done, and OpenMasjidOS is restarting to finish it;
  until it has, the same things are held back. Wait for the dashboard to come back, then try again.
  Even if the restart never comes, this stops by itself five minutes after the hand-over.
- ***A backup is being restored right now. Please try this again once it has finished.*** —
  almost nothing can be changed during a restore, until OpenMasjidOS has restarted (*Restoring a
  backup from outside*). Over WhatsApp the same rule answers *A backup is being restored right
  now. Your apps will start again on their own when it has finished. Nothing was changed.*
- ***OpenMasjidOS is pinned to one exact build on this machine, so it can't update itself from
  here.*** — someone set this machine up to run one particular build, on purpose, in its own
  `docker-compose.yml` (in `/opt/openmasjid`). Updating means changing that, on the machine:
  whoever pinned it edits the line, or runs the installer with `--update` and the box's channel —
  `--channel=main` for Stable, `--channel=dev` for Development — which replaces the pin with that
  channel's newest build. Until then the dashboard goes on offering the update (*Honest limits*).
- ***Tunnel is turned on but isn't connecting…*** in Settings → Remote access — see *Cloudflare's
  own error page* above.
- ***We lost touch with this update…*** — the window's connection dropped while an app was being
  updated; the update itself carries on. Look at the app in a minute.
- ***OpenMasjidOS has restarted, but this window lost touch with the restore…*** — the restore
  window's connection dropped before the restore said how it went. Reload, sign in, and look over
  your apps and settings.
- ***Your last restore needs a look*** on the dashboard — the apps it names did not get their data
  back, did not start, or could not be paused, in the last restore. Check each one, then press
  *I've checked them*.

## Honest limits

These are known and accepted, not overlooked.

- **The second factor guards the tunnel, not a machine the internet can reach directly.** If the
  box's ports 80 and 443 can be reached from the internet without Cloudflare — a server with a
  public IP address, or a router forwarding those ports — such a request looks exactly like the
  masjid's network, and the dashboard answers it with the password alone, whatever the switch
  says. The dashboard address changes nothing here: it is a name Cloudflare answers for, and a
  machine reachable directly is reachable without it. The fix is a firewall or a bind address
  (`docs/SECURITY.md`, *What "LAN-only" means, exactly*). Checking the visitor's network address
  cannot fix it: Docker makes every connection appear to come from the same internal address
  (`util/net.ts`).
- **Two-step sign-in keeps out someone who knows your password but cannot reach the masjid's
  network** — not someone using the dashboard there. Signed in at the masjid, with the password
  alone, they can download a backup, and a backup holds every secret the box keeps, your
  authenticator's among them. Treat the dashboard at the masjid, and every backup file, with that
  in mind.
- **A reverse proxy of the masjid's own** that sends `X-Forwarded-Proto: https` is treated as the
  tunnel when it comes to signing in: signing in through it asks for a code (and is refused while
  two-step sign-in is not set up), and a sign-in made without a code does not count through it. In
  everything else it is the masjid: apps open at their own ports, Settings locks nothing and asks
  nothing extra, and neither a restore nor an update is held to the from-outside rules. A sign-in
  made through it works only through it — never at your dashboard address, and never to open an
  app from outside — because it is kept in a cookie that every app opened from that page receives
  too.
- **Your apps share one address with each other from outside.** At the masjid each app has its
  own port; through the tunnel they are all on your apps' address, told apart only by path. A
  malicious app's page, or a flaw in one, can act within another app you have opened from outside,
  with your access to that app — never in the dashboard, which no app shares. OpenMasjidOS keeps
  its own sign-in cookies away from apps in both directions, and stops an app taking over the
  whole address with a background script (a service worker); install only apps you trust, as
  always. Versions before this one did not stop it. Where an app did it then from its bare
  address, the browser concerned is handed a script that removes itself the next time it checks
  for a new one; where it did it another way, the script stays until that browser's saved data for
  your apps' address is cleared.
- **An app's first reply when it opens a live connection (a WebSocket) is passed back as it is.**
  Everything else an app sends back has OpenMasjidOS's cookie names filtered out; this reply does
  not, so an app could sign you out of another app there. It cannot sign anyone in: only a valid
  access token ever reaches an app.
- **A request already under way to an app is not cut off when your sign-in ends.** OpenMasjidOS
  closes an app's live connections (WebSockets) opened with your sign-in within seconds of it
  ending, but not an ordinary request still in progress — a large download, or a stream of
  updates an app sends over one. That carries on until it finishes.
- **Cloudflare drops a live connection that stays silent** for about 100 seconds. OpenMasjidOS
  keeps the dashboard's own connections alive; each app has to keep its own alive.
- **Cloudflare limits uploads** (100 MB on its free plan) and may drop a long-silent download
  (*Downloading a backup from outside*).
- **An app has to work under a path** to work from outside.
- **OpenWA's own screen** cannot be opened from outside.
- **Losing both the phone and every backup code** leaves no way to replace two-step sign-in from
  the dashboard. The installer's *Reset sign-in*, run on the machine itself, can turn it off
  (*If you lose your phone*).
- **A move to Stable can be left half done from outside.** If Stable was chosen as the update
  channel at the masjid and *Update all to Stable* is then run from outside, your apps move across
  but OpenMasjidOS itself does not: that last step is refused, like any move to a version that
  cannot be managed from outside (*What only works at the masjid*), and the window ends with
  *OpenMasjidOS itself was not changed — the messages above say why.* Until the move is finished
  at the masjid, your apps and OpenMasjidOS are on different channels.
- **A stranger can tell whether managing from outside is switched on**, by asking your apps'
  address for an *Open* link with a made-up code: while it is on they get *This link has expired*,
  and while it is off, *There is no page at this address*. It tells them nothing about what is
  installed.
- **An older setup with emailed codes as its only second factor** — which Settings never offered,
  but an older configuration might hold — loses its second factor when the codes pause. Managing
  from outside then closes until an authenticator app is set up, which has to be done at the
  masjid; emailed codes can be switched back on after that.
- **Nothing tells a box updated from dev.13–dev.15 that managing from outside has switched off** —
  no alert, no notice (*Updating from dev.13–dev.15*).
- ***Recently turned away* lives in memory**: the 25 most recent different refusals, emptied when
  OpenMasjidOS restarts.
- **Files and the terminals are not held back during a restore.** Everything else that changes
  something waits for the restore to finish, but an upload, a rename or a deletion in Files, and
  anything typed into a terminal, still goes ahead. OpenMasjidOS's own settings and app files are
  out of Files' reach anyway; the masjid's own files are not, so leave them alone until the
  restore is over.
- **If OpenMasjidOS does not restart after handing over an update or a restore**, what is held
  back meanwhile — another update or restore, installing or removing apps, and after a restore
  every change in the dashboard — goes on saying *OpenMasjidOS is restarting to finish …* for up
  to five minutes from the hand-over, and then works again.
- **A machine pinned to one exact build is still offered updates.** The banner and the alert go
  on offering the newest version; pressing *Update* says it can't, and changes nothing.
- **A restore that fails in an unexpected way says it stopped part-way** (*The restore stopped
  before it could finish…*), even if it had not yet changed anything. That is the careful reading:
  rather than say nothing was changed when that is not certain, it sends you to check.
- **The runs against the real daemon recorded in Part 3 had no real Docker, Cloudflare or
  browser.** In the first, a stand-in reported two apps, with small app servers behind them, and
  requests carried the headers Cloudflare adds. It shows the platform's side — signing in, the two
  addresses, *Open*, the refusals, the version rule — not what a real app, Cloudflare's edge or a
  browser does with it: that a browser really removes an old background worker, for one, is
  untested. The second, after the last review's fixes (Part 3, *The review after that run*), used
  a stand-in `docker` command too, and was made at the masjid's own address only, with nothing
  sent through the tunnel. The rest of the evidence is the tests in `packages/core/test/`:
  `remote-admin`, `remote-apps`, `remote-settings`, `remote-restore`, `remote-backup`,
  `remote-update`, `front-door-websocket`, `app-paths`, `tunnel-refusals`, `remote-login`,
  `credential-binding`, `twofactor`, `twofactor-router`, `update-lock`, `files-guard` and
  `audit-hardening`.

---

# Part 2 — How it works

## What this deliberately breaks

`CLAUDE.md` §15 said, for a long time and as the first line of the tunnel section:

> The Cloudflare tunnel exposes ONLY app paths. The dashboard, tRPC, and the secret-gated
> Fabric routes stay LAN-only.

This feature breaks the first half of that on purpose, at the masjid's explicit request, behind a
setting that is **off by default**. The second half does not move and must not:

**`/api/fabric/*` and `/api/auth/session` stay LAN-only, always, whatever this setting says.**
They carry each app's 256-bit Fabric secret and every configured Stripe live key. Exposing the
dashboard must not drag them along: `registerFabricTunnelGuard` keeps running on both listeners
regardless of this feature's state, including on everything the front door hands to the dashboard
listener, and the dashboard's allow-list claims nothing under `/api` except its own routes
(`DASHBOARD_API`: update progress, the File Explorer's transfers, terminals, backup, restore, the
logo upload) — never the Fabric, the session check, health or readiness.

Slice 3 rewrote §15 to say what is actually true — the dashboard is exposed only when the admin
switches it on — the same way the `startApp` and Stripe bullets were corrected rather than left
reading well and being wrong.

## Where it lives: two addresses, never one

| Address | Serves | Never serves |
|---|---|---|
| **Your apps' address** — `settings.cloudflare.domain`, e.g. `omos.example.org` | each app at `/<its path>/`, and `/_omos/open` | the dashboard, at any path, in any spelling |
| **Dashboard address** — `settings.cloudflare.adminHost`, e.g. `admin.example.org` | the dashboard: the UI, `/trpc`, the dashboard's own `/api` routes, its sockets | any app, shared or not, with an access token or without; `/_omos/open` |

Both are public hostnames on the **same** tunnel, both pointed at the HTTP front door
(`localhost:80`, `PORT`; cloudflared runs on the host network). Both are kept as bare hostnames:
`hostnameOfDomain` strips a scheme and anything after the first `/`, and `normalizeHost`
lower-cases and drops a port and trailing dots. The gate serves the dashboard only on the admin
hostname (`frontDoorDecision`; asked for anywhere else while remote administration is on, it is
refused as `dashboard-elsewhere`), and the ingress declines every app path there
(`system/ingress.ts`, recorded as `app-on-admin-host`). Each is half of one rule: **no origin ever
holds both an app page and the dashboard.** Turning remote administration on changes nothing on
the apps' hostname, so it cannot take a masjid's donations page off the air.

The app half is an exclusion, not an inclusion: the ingress and `/_omos/open` refuse the admin
hostname rather than requiring the apps' one, so a third public hostname pointed at the same tunnel
would serve the apps as well. Only the admin hostname ever serves the dashboard.

### Why two

**A browser draws the line around "this site's own data" by scheme, host and port — never by
path.** The two things that keep another page from acting as the admin both sit behind that line:
the dashboard key in `localStorage` (`omos.dashboardKey`), which every protected call must
present, and the origin check, under which a cookie-carrying request must come from a page whose
Origin names the host it arrived on (`util/origin.ts`). The session cookie is not one of them — a
cookie ignores ports, which is how single sign-on reaches apps on the LAN — so those two are what
count.

On the masjid's network the line has always been there. The dashboard is `https://<ip>` and each
app `http://<ip>:<port>`, and a different port is a different origin: an app's page receives the
admin's cookie but cannot read the dashboard key, and its requests fail the origin check.

dev.13 to dev.15 served the remote dashboard at the root of the apps' hostname, and every app page
was the dashboard's own origin (Part 3 has that history). Through the tunnel the only way to draw
the line is a different **hostname**. Hence:

- **No admin hostname, no remote administration** — rather than an unsafe one.
  `remoteAdminEnabled()` is false while `adminHost` is empty or names the apps' hostname in any
  spelling, and `remoteAdminBlockedReason()` then says `no-admin-host` (it reports a missing
  second factor, then a tunnel that is off, before that).
- **`validateAdminHost` decides what may be saved:** a DNS name with at least one dot, not an IP
  address, not the apps' hostname; a pasted `https://` or trailing path is stripped.
  `normalizeHost` makes spellings comparable, so `ADMIN.example.org.:443` is the admin hostname and
  `omos.example.org.` is still the apps'. The same check refuses moving the apps' hostname onto the
  admin one, because it judges the admin hostname against the apps' hostname as the save will
  leave it.
- **`remoteDoorOpen(host)`** — `remoteAdminEnabled()` and `isAdminHost(host)` together — is the
  question every remote request and every long-lived remote connection keeps asking (*The session
  rule*).

The two hostnames are usually the same *site* (`example.org`), and a browser sends `SameSite=Lax`
cookies on same-site requests, so an app's page can make the browser send the dashboard's cookie
to the admin hostname. That is the position the LAN has always been in (one host, different
ports), and it is held the same way: the request carries no dashboard key, which an app's page
cannot read from another origin, and it fails the origin check.

### The cookies

A remote session lives in its own cookie, `__Host-omos_session` (`REMOTE_COOKIE_NAME`): `Secure`,
`HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`, set and read only for a request the front door
handed over (`trpc/context.ts`, `api/ws-auth.ts`). The LAN cookie stays `omos_session`
(`COOKIE_NAME`). A different name, and a `__Host-` one, because the admin hostname is a sibling of
the apps' hostname: a page or backend on a sibling may set a cookie for the parent domain, which
the browser then sends to the admin hostname too, and a planted `omos_session` would shadow the
real session on every request it covered — signing the admin out in a loop. A browser refuses a
`__Host-` cookie that names a `Domain`, so nothing outside the admin hostname can plant or
overwrite this one. It is always `Secure` because a plain-`http://` visit to the admin hostname is
upgraded before it can reach a sign-in.

The LAN cookie stays off `Secure`, so an app served over plain HTTP still gets it for single
sign-on (`OPENMASJID_SECURE_COOKIE=1` turns it on). `cookieOptsFor` still sets `Secure` on it only
with `cf-ray` present **and** `visitorScheme` saying `https`. That rule is no longer the path a
remote sign-in takes, but its lesson stands: "came through the tunnel" is NOT "the browser is on
HTTPS". Cloudflare stamps `cf-ray` on a plain `http://` visit too, a browser throws away a `Secure`
cookie delivered over plain HTTP, and one build that keyed the flag on `isViaTunnel` bounced every
remote sign-in back to the sign-in screen. `visitorScheme` reads Cloudflare's `cf-visitor` first and
`x-forwarded-proto` only as a fallback, because a reverse proxy rewrites the latter with its own
scheme.

## What has to be true

| | |
|---|---|
| **Off by default** | A masjid that never opens Settings is never exposed. A `settings.json` written before the feature existed reads as off (`remoteAdmin: false`, `adminHost: ''`). |
| **Two factors, always, from outside** | A password alone never grants a session from outside. Enrolment is required *before* the setting can be turned on, not after, and removing it closes the door. |
| **An address of its own** | The dashboard is served only at the *Dashboard address*, and no app is ever served there. Without one there is no remote administration. |
| **From outside, only a session that passed the second factor counts** | For the dashboard *and* for apps: a password-only session's cookie never reaches an app through the tunnel, and a sign-in made through a reverse proxy at the masjid works only through that proxy. |
| **Fabric stays LAN-only** | See above. Not negotiable, not conditional. |
| **An admin must exist** | First-run setup and first-run restore are open by design; that may only ever mean "open to someone in the building". Remote administration is off with no admin, and both refuse tunnel traffic regardless. |
| **Real per-IP lockout over the tunnel** | The one thing that gets *better* (*The lockout*, below). |
| **A way back in** | From outside, a backup code (or an emailed code, where they are on). At the masjid, the password alone — signing in there never asks for the second factor — and the installer's *Reset sign-in* for a lost password. Reset sign-in also offers to turn two-step sign-in off, for a lost phone with no backup codes: the one supported way to remove it without a current code. |

## How a request from outside is decided

Cloudflare's tunnel lands on the HTTP **front door** (port 80, `PORT`). The dashboard is served by
the HTTPS **dashboard listener** (port 443, `TLS_PORT`) — the one the LAN uses. On the front door,
in order:

1. **`registerOriginFormGuard`**, the first hook on both listeners: a request target that is not a
   path is refused before any guard reads it as one.
2. **The ingress** (`attachIngress`) takes app paths first — never on the admin hostname (*What an
   app receives through the tunnel*).
3. **`registerFabricTunnelGuard`** refuses the Fabric and the session check over the tunnel
   (`lan-only-route`); `/api/health` and `/api/ready` refuse it themselves.
4. **The gate**, `frontDoorDecision` — one pure function, called by `index.ts` and by the tests,
   with `remoteAdminEnabled()`, `adminHost()` and `doorClosedReason()` read afresh for every
   request:

   | Request | Decision |
   |---|---|
   | no spelling of it is a dashboard path (`touchesDashboardPath`) | `pass` — the front door's own routes (the Fabric, the public appearance and logo, `/_omos/open`), then its not-found handler |
   | not through the tunnel | `lan-https` — 308 to the HTTPS dashboard, as always |
   | through the tunnel, remote administration not in effect | `refuse` — recorded as `no-admin-host` when the tunnel and the switch are on, an admin account exists, a second factor is enrolled and only the dashboard address is missing or equal to the apps' one (`doorClosedReason`); otherwise `lan-only-route` |
   | through the tunnel, any hostname but the admin one | `refuse`, `dashboard-elsewhere` |
   | the admin hostname, an explicit `http` scheme, a target starting `//` | `refuse`, `plain-http-no-host` |
   | the admin hostname, an explicit `http` scheme | `upgrade` — 308 to `https://<the configured admin hostname><path>` |
   | the admin hostname, otherwise | `serve` |

5. **`serve` means handed over, unread.** A request with no live remote session whose declared
   body is over `ANONYMOUS_BODY_LIMIT` is refused first (*What a stranger can make the box read*).
   Otherwise the front door serves no dashboard of its own: it marks the request
   (`markHandedOver`), `reply.hijack()`s it and emits it as a `request` event on the dashboard
   listener, so the remote dashboard *is* the LAN dashboard — every route, limit and check, with no
   second copy to drift — and that listener's own guards (the request target, the Fabric, the
   origin check) run on it again. A dashboard socket goes the same way, as an `upgrade` event, only
   when `claimsDashboardSocket` agrees: through the tunnel, **every** spelling of the URL one of
   the dashboard's own sockets (`/trpc`, `/api/update`, `/api/apps/update`, `/api/restore/run`,
   `/api/terminal/…`), `frontDoorDecision` would serve the same request, **and** the request
   carries a live remote session (`hasRemoteSession`). It is then tracked
   (`trackHandedOverSocket`), and a socket the full table refuses is destroyed. Every other non-app
   upgrade is destroyed, never left hanging — a stranger's dashboard socket exactly like an address
   with nothing at it.
6. **On the dashboard listener, `registerHandoffOnlyGuard`** — straight after the request-target
   guard — answers a request carrying `cf-ray` only if the front door handed it over. Anything else
   is refused and recorded as `wrong-port`; an upgrade is closed. `cf-ray` is Cloudflare's own
   header, set at its edge, so this refuses exactly the misrouted case: a tunnel hostname pointed at
   port 443 would otherwise reach every dashboard route directly, with the switch off and the admin
   hostname ignored. The hand-over mark is a `WeakSet` that only the front door adds to — the one
   signal nobody can type. Every response to a handed-over request also carries
   `CDN-Cache-Control` and `Cloudflare-CDN-Cache-Control: no-store`, because Cloudflare's edge
   caches by address alone and a File Explorer download can end in `.pdf`.

The upgrade's hostname never comes from the request — it is the configured admin hostname, and a
target starting `//` is refused rather than joined to it — so it cannot be an open redirect. Only an
explicit `http` redirects — `cf-visitor` first, `x-forwarded-proto` only as a fallback — so a proxy
that strips or rewrites the scheme cannot cause a loop.

**To the dashboard, *from outside* is the hand-over, never a header.** Everything it does
differently from outside reads the mark: `auth.me` → `remote` and `appOrigin` (`ctx.handedOver`),
`apps.openRemote`, `cloudflare.save`'s refusals, the version rule on updates and on the channel
switch (*Updates from outside*), and the restore's rule (`wasHandedOver`). A reverse proxy the
masjid runs on its own network — nginx, Caddy, Tailscale Serve — sends `X-Forwarded-Proto:
https`, so `isViaTunnel` is true behind it, and answering "remote" there sent every *Open* down the
from-outside path, where it was refused: at the masjid, for every app. The security rules keep
`isViaTunnel`, because they only ever ask more of a request: the second factor at sign-in, the
per-address lockout, which sessions are made remote, the first-run refusals and the session rule
below. `test/remote-settings.test.ts` and `test/remote-apps.test.ts` pin both halves.

## The session rule

**From the tunnel, only a session that passed the second factor counts — and only while that
factor is unchanged.**

- A session records `remote: true` in exactly one place that can mint one over the tunnel —
  `completeLogin`, i.e. the second factor passing — together with `tf`, the second-factor epoch the
  code was checked against (*Second factors*), and `handedOver`: whether the front door handed
  that sign-in over, i.e. whether the remote dashboard itself made it. `createSession` requires
  both with `remote: true`, so no caller can forget to decide. `changePassword` carries the old
  session's grant over exactly (`remoteGrantOf` → `{ tf, handedOver }`), so changing the password
  from outside does not strand the admin. All of it is saved in `config/sessions.json`, and only
  a literal `true` counts.
- Every dashboard route asks `getSessionUserFor(token, { viaTunnel, handedOver })` — the tRPC
  context, and `requestUser` in `api/ws-auth.ts` for the raw routes (files, terminals, backup,
  restore, updates, the logo). From the tunnel it accepts only a live remote session whose `tf`
  matches the current epoch, and for a request the front door handed over, only one the remote
  dashboard made. A LAN session — password only — is refused there **and kept**: it still works on
  the LAN. That matters more than it looks, because every app on the masjid's network receives the
  admin's LAN cookie (that is how single sign-on works), so without the rule any app that kept one
  could have used it from the internet with no second factor.
- **A sign-in through a reverse proxy at the masjid works only through that proxy.** The proxy
  sends `X-Forwarded-Proto: https`, so signing in through it demands the second factor and makes a
  `remote` session — but one the front door never handed over, kept in the LAN cookie on the
  proxy's hostname, which every app opened from that page receives (a cookie ignores ports). The
  access-token formula is public, so any of those apps could have worked out a token for every
  app, private ones included, and used it from the internet; a review proved it. So
  `isRemoteSession` — asked by the remote dashboard's routes and sockets, the sweep,
  `claimsDashboardSocket` and `mintAppTicket` — and the access tokens honour only a session the
  remote dashboard made. Through the proxy itself (not handed over) the session goes on working.
- A handed-over request also needs `remoteDoorOpen(host)`, in the same two places.
- The terminals keep their off-by-default switches in Settings → Advanced, and the File Explorer
  its protected paths (`protectedReason`); both apply from outside too.
- Switching remote administration or the tunnel off **closes the door without discarding a
  session**: `isRemoteSession` does not look at the door, so a remote session made before is
  honoured again if the door reopens within its seven days. Sign-out, a password change or a new
  epoch is what ends it.

**A connection is checked for as long as it lasts, not only when it opens.** The gate decides once
per HTTP request; a WebSocket — live data, an update's progress, a terminal — is one request that
lasts for hours, and a review found all of them outliving the actions an admin takes to shut the
door: a live terminal went on taking keystrokes, and a live tRPC socket could switch remote
administration straight back on. So:

- `isAuthed` (`trpc/trpc.ts`) re-checks the door and the session on **every** protected call from a
  handed-over context;
- a terminal re-checks before **every** keystroke reaches the shell (`api/terminals.ts`), its
  Advanced switch included;
- `system/remote-sockets.ts` records every handed-over socket with its hostname and session and
  closes it when either stops qualifying — on a sweep every 5 seconds (`SWEEP_MS`), and at once
  (`sweepHandedOverSockets`) on sign-out, a password change, any change to the second factor,
  switching remote administration off, switching remote access on or off or removing it, and every
  save in Settings → Remote access. It records an app's socket opened through the tunnel with
  that app's access token too (`trackAppSocket`), and closes it once the token stops being valid
  — its session signed out, its password or second factor changed — or the door shuts: a review
  found a private app still answering a socket opened before the admin signed out. Closing one
  closes both ends, the browser's and the connection to the app (`closeTogether` in
  `system/socket-relay.ts`, which the per-app HTTPS proxy shares). A destroyed socket never emits
  `end`, so with pipes alone the app's connection stayed open, held by the core until the app
  noticed by itself; now the app sees it drop. A socket opened with no token is the public's, and
  nothing here ends it. The door and the second-factor epoch are read once per sweep for the
  dashboard's sockets (`isRemoteSessionAt`); an app socket is still judged by `appAccessUser`,
  which reads the epoch for each one. At most `MAX_TRACKED_SOCKETS` (200) are recorded at once —
  the table is filled from the internet, so it is bounded, and a socket it refuses is destroyed —
  and apps' sockets may hold at most `MAX_APP_SOCKETS` (150) of those places, so the dashboard's
  own always have room. An app's page opens a socket with the admin's token whenever it likes, and
  a hostile or merely leaky app (a reconnect loop that never closes the old one) filled all 200:
  from then on every terminal, update and restore from outside failed to start, on every device.
  A refusal is logged at most once a minute.

**And kept alive while it is quiet.** Cloudflare closes a WebSocket that carries nothing either
way for about 100 seconds, and nothing speaks on the dashboard's sockets while the admin is
reading: a remote terminal at a prompt or in an editor printed *[Session closed]* in any pause,
leaving whatever ran in it where nobody could get back to it, and an update's progress window
could drop during a long download. So every socket on the dashboard listener is pinged every 30
seconds (`DASHBOARD_WS_HEARTBEAT_MS`, `startDashboardHeartbeat` in `index.ts`); a browser answers
a ping by itself, and pinging the masjid's own sockets too costs nothing. An app's sockets are not
pinged — their bytes pass straight through the relay — so an app that wants a quiet socket to
survive Cloudflare sends its own heartbeat.

Closing a progress socket never stops the work: an update or a restore runs to the end whether
anyone is watching or not. An HTTP download already under way is not a tracked socket and is not
cut off — and neither is a long-lived HTTP response an app sends to a request carrying the
admin's access token (an event stream, say): only WebSockets are tracked, an accepted residual.

## Opening an app from outside: one-use tickets and per-app tokens

The dashboard's cookie never reaches an app — that is the point of the second address — so an app
has nothing from the admin's browser to go on: one that is not shared online cannot tell the admin
from a stranger, and one that signs the admin in through the platform has no cookie to forward.
*Open* gives it something that opens that one app and nothing else.

1. **`apps.openRemote`** is a protected mutation, refused unless the front door handed the request
   over (`ctx.handedOver`) and `remoteAdminEnabled()` (FORBIDDEN) — a request that only looks
   remote, through a reverse proxy at the masjid, opens apps at their own ports instead — unless
   the apps' hostname is set (PRECONDITION_FAILED), and for an app with no web port (NOT_FOUND). It
   calls `mintAppTicket`: 32 random bytes, bound to the caller's remote session and the app, good
   for `TICKET_TTL_MS` (60 seconds), at most 200 outstanding (the oldest goes first). It returns
   `https://<apps' hostname>/_omos/open?t=<ticket>`.
2. **The dashboard** (`ui/src/lib/apps.ts`) opened a blank tab during the click — a pop-up blocker
   allows one only then — cut its `opener`, and now sends it there with `location.replace`, adding
   the `#omos=` appearance fragment for an app on the Fabric; a fragment survives the redirect. On
   the LAN nothing changes: `appOpenUrl` (`ui/src/lib/app-url.ts`) builds the app's own port and
   returns null from outside (`auth.me` → `remote`), where no URL is ever built. If asking fails,
   the blank tab is closed and a toast says so: the platform's own message when the platform
   answered, and *That app couldn’t be opened. Please try again.* when it did not (`Root.tsx`).
3. **`registerAppOpen`** serves `APP_OPEN_PATH` (`/_omos/open`) on the front door. `_omos` can never
   be an app path: only lower-case letters, digits and hyphens are ever routed (*App addresses*,
   below). It answers only through the tunnel (a plain 404 on the LAN), never on the admin
   hostname and never with remote administration off (both refused, recorded as
   `no-app-at-path`). It spends the ticket — gone whether it was valid or not — and, if the
   session it was minted for is still a live remote session, sets
   `omos_session=<access token>; Path=/<app path>; Max-Age=<what is left of that session>; Secure; HttpOnly; SameSite=Lax`
   and answers 303 to `/<app path>/`. Otherwise it answers 410 with *This link has expired*. Every
   answer carries the no-store headers and `Referrer-Policy: no-referrer`, and the refusal record
   never keeps the query string the ticket travels in.

Two residuals, accepted. Like the ingress, `/_omos/open` refuses the admin hostname rather than
requiring the apps' one (*Where it lives*). And a made-up ticket gets the 410 page while remote
administration is on and the ordinary 404 while it is off, so the answer tells a stranger whether
it is switched on — nothing about what is installed.

**The access token** (`appAccessToken`, `auth/sessions.ts`) is
`a1.<session handle>.<HMAC-SHA256 keyed by the session token over omos-app-access:v1:<app id>>`; the
handle is a hash that names the session without being able to use it. `appAccessUser` honours it
only for the app it was made for, only while its session is a live remote session that the remote
dashboard made (same password, same second-factor epoch, `handedOver`, not signed out), and
compares the MAC in constant time; `appAccessFromCookie` and `appAccessSsoUser` add "remote
administration is on". It cannot be turned back into the session or into another app's token; one
worked out from any other session — a LAN one, or one made through a reverse proxy at the masjid
(*The session rule*) — is never honoured; and **it is not a dashboard session** — no dashboard
route accepts it. An app that keeps one holds a key to itself and nothing more. It is shaped to
pass the check every OpenMasjid app applies to a cookie value before forwarding it
(`^[A-Za-z0-9._~%+/=-]{1,4096}$`).

Checking tokens is bounded, because the requests that carry them come from the internet: at most
`MAX_TOKEN_CANDIDATES` (8) `omos_session` values per request are tried, and each session's handle
is memoised (pruned to the live sessions as it grows). A review measured about 5 ms of the daemon's
single thread per request for a 16 KB Cookie header of token-shaped values before the memo.

## What an app receives through the tunnel

`system/ingress.ts`, on the HTTP and the WebSocket path alike unless noted:

- **No platform session cookie, ever.** Every `omos_session`, whatever its value, and every
  `__Host-omos_session` is removed from the `Cookie` header relayed to the app; the app's own valid
  access token, if the request carried one, is put back **first**, because every OpenMasjid app
  forwards the first `omos_session` it finds (`cookieHeaderForApp`). A browser never sends the LAN
  cookie to the apps' hostname by itself, so nothing legitimate is lost. Until dev.16 the ingress
  relayed the `Cookie` header as it came, so a LAN session cookie presented through the tunnel —
  and any app on the masjid's network could have kept one — was accepted by a shared app's single
  sign-on: a password-only sign-in, used from the internet, with no second factor.
- **An app that is not shared online** (`exposed: false`) is served only to a request carrying a
  valid access token for **that** app. Anyone else falls through to the not-found handler and gets
  exactly the 404 an empty address gets, recorded as `app-not-shared`. It is declined before
  anything else can answer for it — a review found the `/fabric` refusal answering a private app's
  path before the body was read, while an empty address had its body parsed first, so a malformed
  or oversized POST told a stranger which apps were installed. On the LAN the front door still does
  not serve it; it is reached at its own port, as always.
- **Nothing on the admin hostname**: any app path asked for there is declined
  (`app-on-admin-host`).
- **An app's own `/fabric/*`** stays refused to everyone, an access token included
  (`app-fabric-lan-only`).
- **At an app's bare address, `/<path>` with no final slash, the app's worker script is never
  served and nothing is cacheable** (`isBareAppAddress`, `isWorkerScriptFetch`; HTTP path). A
  service worker's reach is the directory of its script's address, and the directory of `/<path>`
  is `/` — the whole apps hostname, every other app and `/_omos/open` included. Stripping
  `Service-Worker-Allowed` only confines a script served under `/<path>/`; a review found an app
  could serve its worker at the bare address instead. A browser marks the fetch of a worker's
  script twice — `Service-Worker: script` and `Sec-Fetch-Dest: serviceworker`, the second of which
  a page cannot set on an ordinary fetch — and a request carrying either gets
  `SELF_REMOVING_WORKER` (`answerBareWorkerFetch`): 200, `text/javascript`, no-store, a worker that
  skips waiting and unregisters itself as it activates. Not a 404, because a 404 stops only new
  registrations: by the Service Workers specification an update check that fails leaves an
  existing registration running, and every published build let an app's page install a worker
  over the whole apps hostname from its bare address. The browser's next update check of such a
  worker now installs this one, which removes itself; it clears no caches, which belong to the
  apps. The answer is the same at a shared app's bare address, a private app's with or without
  its token, an empty address (the front door's not-found handler gives it too) and on the
  masjid's network, so it says nothing about what is installed; it is recorded as
  `worker-at-bare-address` only when it came through the tunnel (`recordRefusal`). Everything
  else at the bare address is proxied to the app as before, with `Cache-Control: private,
  no-store` and the two CDN no-store headers — through the tunnel and on the front door at the
  masjid alike — so that no cached copy, the browser's or Cloudflare's, can later stand in for a
  worker's script. Under `/<path>/` a worker is the app's own business. Accepted residual: a worker
  a published build let an app install from under its own path, with a `Service-Worker-Allowed`
  header those builds passed through, is not reached by this — its update check fetches that
  script, now without the header, fails, and leaves it running until the browser's data for the
  apps hostname is cleared. The first fix was a 308 from `/<path>` to `/<path>/` for GET and HEAD;
  a later review found it looping for ever for an app that sends `/<path>/` back to `/<path>` —
  Next.js with a base path does, by default — which took that app's public page down.
- **A browser that leaves part-way ends the app's response too** (`proxyHttp`, and the per-app
  HTTPS proxy on the masjid's network): a live event stream, a long poll or a big download used
  to hold the app's connection open until the app gave up by itself, because a pipe only pauses
  the app's side. It is the HTTP twin of `closeTogether`.
- **No `X-Forwarded-Prefix`.** It is stripped like the other forwarding headers a visitor can type,
  on the HTTP and WebSocket paths — and in the per-app HTTPS proxy on the masjid's network
  (`system/app-proxy.ts`) — because some frameworks take their base path from it, and the platform
  never sends one.
- **Single sign-on needs no app change.** `GET /api/auth/session` (LAN-only, behind the app's
  secret) accepts the access token for the app it was made for (`appAccessSsoUser`, in
  `api/fabric.ts`) while remote administration is on, and OpenMasjid apps already forward
  `omos_session`.
- **What the app sends back** (HTTP path): `Set-Cookie` for a platform cookie name, and
  `Service-Worker-Allowed`, are stripped (`responseHeadersForTunnel`) — one app must not set
  `omos_session` for another app's path, nor register a worker over the whole hostname. A page of a
  private app, or anything served to a request carrying the app's access token, also gets
  `Cache-Control: private, no-store`, `CDN-Cache-Control: no-store` and
  `Cloudflare-CDN-Cache-Control: no-store` (`NO_STORE_HEADERS`), because Cloudflare keys its cache
  on the address alone. Every tunnel refusal carries the same three.

For an app with no icon of its own, the dashboard borrows its page's favicon. From outside it does
that only for a **shared** app, loaded from the apps' hostname (`auth.me` → `appOrigin`, given only
to a signed-in request the front door handed over); a private one shows its initial, because
loading its page from the dashboard would only be refused.

## App addresses

- **One list of reserved first segments**, `RESERVED_PATH_SEGMENTS` in `apps/paths.ts`: `api`,
  `trpc`, `assets`. The ingress never routes them and `setAppPath` refuses them (*"/api is used by
  OpenMasjidOS itself. Choose a different address for this app."*). One list for both sides
  because, when only the ingress knew, an admin could give an app `/api`: accepted without a word,
  after which the app had no public page and opening it from outside landed on a 404.
- **`setAppPath` refuses a path another installed app already answers to** (*"Another app already
  uses /<path>. Choose a different address for this one."*).
- **An install takes the next free address** when its id is already another app's address or a
  reserved word: `<id>-2`, `<id>-3`… (`addressForNewApp`), for catalog, community and custom apps
  alike, decided before anything is written, logged, and used in `OPENMASJID_PUBLIC_URL`. A
  reinstall keeps the address it had. Installing used to take the id unconditionally, so a
  community app given `/donations` and the official Donations app installed later shared one
  address.
- **Only an address shaped like an app's path is ever routed** (`isAppPathShape`: a lower-case
  letter or digit, then up to 79 more letters, digits and hyphens — what an install or Settings
  gives an app). An app is also recovered from any `omos-*` project Docker reports, under whatever
  name that project has, and Docker allows `_` in one: a stack started by hand as `omos-_omos` was
  routed at `/_omos`, the platform's own address for *Open*.
- **Every app with a web port is in the routing table**, private ones included, so a clash matters:
  `placeRoute` never lets a private app take a shared app's path, and logs the clash.
- **`isRouted(appId)`** is true only for the app that actually holds the route **and** is shared, so
  `/api/fabric/site` never advertises a public address that serves another app, and opening a
  private app from outside never gives it one.

## What a stranger can make the box read

The dashboard listener accepts 25 MB of JSON, because a signed-in admin uploads wallpapers and
pastes compose files. Handing it the internet's requests unread made that available to anyone who
could reach the sign-in page — a handful of concurrent 25 MB posts is a memory-exhaustion attack on
a Raspberry Pi running as root, and when that process dies so does every public page the masjid
serves. A stranger needs to send a sign-in and a code: a few hundred bytes. So:

- a handed-over request with no live remote session (`hasRemoteSession`) may carry at most
  `ANONYMOUS_BODY_LIMIT` (64 KB). One that **declares** more, or declares a length that is not a
  number, is refused with 413 at the front door, unread (`anonymousBodyRefusal`). One that declares
  nothing — `transfer-encoding: chunked`, which a tunnel may use even for a browser's fixed-size
  request — is counted as it arrives by a `preParsing` hook and stopped at 413
  (`registerDashboardRequestLimits`); refusing it up front would refuse real sign-ins.
- **tRPC takes JSON and nothing else.** Anything but a GET, HEAD or OPTIONS to `/trpc`, in any
  spelling, must be `application/json` or gets 415. Its adapter also accepted multipart bodies and
  read them with no size limit; nothing in the dashboard uses them (its uploads have their own
  `/api` routes). This one applies on the LAN as well.
- **No dashboard socket for a stranger.** The front door hands a dashboard WebSocket over only to
  a request carrying a live remote session (`claimsDashboardSocket`, *How a request from outside
  is decided*); anyone else's is destroyed. Handing over anyone's let a stranger hold any number
  open and push frames the dashboard had to buffer and parse — the attack the body limit exists
  to stop, through the one door it did not cover. The dashboard opens its live socket only while
  something is subscribed (`lazy` in `ui/src/lib/trpcClient.ts`), so the sign-in page holds none.
  Every WebSocket message to the dashboard listener is capped at 1 MiB, from anyone
  (`DASHBOARD_WS_MAX_PAYLOAD`; the library's default was 100 MB): the dashboard only ever sends
  small frames over a socket.

## Restores and backup downloads from outside

**The restore rule.** `api/restore.ts` runs
`runRestore(send, { remote: wasHandedOver(req.raw), callerToken: requestSessionToken(req) })` —
*from outside* meaning the front door's hand-over, because a reverse proxy at the masjid is at the
masjid. With `remote`, `remoteRestoreProblem(STAGING_DIR)` reads the extracted, validated backup,
once it is known to hold something to restore, and **before** `stopAllApps` and before anything is
replaced. The conditions in Part 1 (*Restoring a backup from outside*) are, in code:

- the staged `settings.json`'s `cloudflare` block passes `settingsOpenTheDoor` — the same pure
  function `remoteAdminEnabled()` applies to the live box — and names the same admin hostname in any
  spelling. A hand-written copy of that rule here once missed "the dashboard address equals the
  apps' address", and a restore it waved through shut the door behind the admin;
- `tunnelTokenMatches(staged cloudflare/.env)`, which answers without handing the token to anyone;
- the staged `auth.json` has a username and the same password hash as the current one, read fresh;
- `sameSecondFactorAs(staged twofactor.json)`: an authenticator on **both** sides with the same
  secret, compared in constant time. Emailed codes alone are refused, because whether a restored
  emailed factor would deliver depends on the restored address and mail account — not something to
  guess for a restore that nobody can repair from outside if the guess is wrong.

A backup with no `config/` touches none of this and is never refused here. A first-run restore
(no admin yet) refuses tunnel traffic outright — 403 on the upload, close 4403 on the stream — as
does `auth.setup`.

**The second-factor epoch around a restore.** `holdSecondFactorEpoch` — taken beside
`holdForRestore` once the apps are stopped, just before `config/` is replaced, and released with
it in the `finally` — keeps `secondFactorEpoch()` at the value it had then, and a sign-in
completed during the restore is bound to that held value (`verifySecondFactor`), not to the
restored file's. Without the hold the restoring admin was signed out mid-restore: the restored
`twofactor.json` can carry an older epoch, a remote session is honoured only under the epoch it
signed in with, and the sweep closed their progress window, losing every line after it. Once a
backup's `config/` is in place the epoch is **renewed** (`renewSecondFactorEpoch`), and the admin
doing the restore is moved onto it (`rebindRemoteSession`, with the token `api/restore.ts` passes
as `callerToken`) while both holds still stand — but only if that session still counts at that
moment (`remoteGrantOf`, judged against the held epoch). It used to be moved regardless, which
carried back in from outside a session shut out while the restore ran — by new backup codes, say,
the way an admin gets rid of a copied cookie. Releasing the hold would otherwise hand the box the
backup's epoch, and every remote session made under the factor as it stood when the backup was
taken would count from outside again — one the admin had shut out since, by replacing the factor,
included. A new epoch counts for nobody but the restorer, until the restart ends every session
anyway (`endAllSessionsAtNextBoot`). A restore that stops part-way releases both holds at once.
Backup codes come back with the backup: only the authenticator is compared before a restore from
outside.

**Nothing about the factor can be changed while a restore runs** — not only while it holds the
epoch (`refuseDuringRestore`: `secondFactorHeld() || isUpdating('restore')`). The two-step
router answers CONFLICT — *"A backup is being restored right now. Please try this again once it
has finished."* — at the start of `requireSudo`, again once the password has been checked (a
restore can begin while argon2 runs), and at the start of `confirm`: `begin`, `confirm`,
`disable`, `regenerateBackupCodes` and `setEmailFactor` are all refused before any code is spent.
A change made before the swap would simply be overwritten by the backup's factor; one written
during the hold counted only from the release, and its maker, moved onto the held epoch, was
signed out from outside the moment the restore let go. Signing in still works throughout.

**Nothing else is changed from the dashboard while a restore runs either** (`trpc/trpc.ts`
`noChangesDuringRestore`). `protectedProcedure` is
`t.procedure.use(isAuthed).use(noChangesDuringRestore)`: while `isUpdating('restore')` — which
includes the hold until the core is replaced (*Updates from outside*, *One at a time*) — every
protected **mutation** answers CONFLICT, *"A backup is being restored right now. Please try this
again once it has finished."*, or during the hold `finishingMessage('restore')`, *"OpenMasjidOS is
restarting to finish restoring your backup. Please try again in a minute or two. Nothing was
changed."* Two mutations are let through, by path (`ALLOWED_DURING_RESTORE`): `apps.stop` —
turning an app off must always work, and is what the restore does to every app anyway — and
`apps.openRemote`, which only mints a one-use ticket and writes nothing a restore replaces.
Queries still answer, and `login`, `completeLogin` and `logout` are public procedures, untouched.
The logo routes (`api/branding.ts`, outside tRPC, writing `config/branding/`) refuse the same way
— 409, the same sentences — after their origin, session and key checks. A restore replaces
`config/` whole: a change made before the swap was overwritten by the backup's, and the review
behind this changed the password and switched remote administration off during a restore — after
the restart the old password worked again and remote administration was back on. The middleware
runs before any procedure, so a two-step change now meets it first; the router's own
`refuseDuringRestore` still matters for a restore that begins while the password is being
checked. Residual: the File Explorer's transfers (`api/files.ts`) and the terminals are raw routes
with no such check, so an upload, rename or deletion among the masjid's own files, or anything
typed into a terminal, still goes ahead during a restore; `config/` and the platform's per-app
files are out of the File Explorer's reach anyway (`protectedReason`).
`test/remote-restore.test.ts` (*NOTHING IS CHANGED FROM THE DASHBOARD WHILE A RESTORE RUNS —
looking is fine*).

**The restored settings are this process's at once.** The settings, email, Stripe, WhatsApp and
commands stores each read their file once and keep a copy in memory, so a write after the swap — a
monitor, a scheduled job, a change accepted mid-restore — put the pre-restore copy back over the
restored file: a review saw the root terminal come back on after restoring a backup in which it
was off, because the theme had been changed during the restore. So when `config/` has been moved
into place, `runRestore` calls `reloadSettings`, `reloadEmailConfig`, `reloadStripeConfig`,
`reloadWhatsAppConfig` and `reloadCommandConfig` straight away. The admin store re-reads by itself
(`refresh`), and the second factor has its hold and renewal (above).
`test/remote-restore.test.ts` (*A RESTORE PUTS ITS SETTINGS IN PLACE AT ONCE — not at the next
restart*).

**Every restored compose is checked the moment it is in place** (`reviewEveryApp`,
`apps/manager.ts`). Straight after `config/` and `apps/` are moved — before any volume is refilled
— `reviewCompose` runs for every app with a compose file, so the verdict on disk
(`AppMeta.review`) is this platform's own from that moment rather than the one that came in with
the backup; one that cannot be read is logged and left to `reupAllApps`, which reviews every app
again at the end and holds what it should. It does not depend on starts being refused during a
restore (`assertAppFree`, *One at a time*), and that does not depend on it.
`test/remote-restore.test.ts` (*A RESTORED APP'S COMPOSE IS CHECKED THE MOMENT IT IS IN PLACE —
not after its data is back*).

**The monitors stand aside.** `system/alert-monitor.ts` returns at once while a restore runs: the
restore pauses every app on purpose, and the app-offline alert told the admin to press Start over
data still being put back. `stopAllApps` also calls `suppressOfflineAlert` for each app it pauses.
The address monitor (`system/address-monitor.ts`), which restarts running apps when the
machine's own address changes, skips its tick too: the apps' files are being replaced, and a
rewrite of their settings would land in a tree about to be swapped out. The off-site backup
scheduler (`system/backup-upload.ts`) skips its tick while a restore or a core update runs; the
next tick runs it. `test/remote-restore.test.ts` (*NEITHER THE OFFLINE ALERTS
NOR THE OFF-SITE BACKUP RUN WHILE A RESTORE DOES*).

**An app that could not be paused is a problem** (`stopAllApps` → `notPaused`). `composeStop`
reports a failure in its exit code and never throws, so the old `catch` never fired: a container
Docker refused to stop was listed as paused, and its data refilled under it. Now a non-zero exit
prints `• <Name> (couldn't pause it — its data may not restore cleanly)`, logs a warning and is
returned by name; it makes the ending `restarting-with-problems` and goes into the report as
`appsNotPaused`. `test/remote-restore.test.ts` (*AN APP THAT COULD NOT BE PAUSED IS NOT
"COMPLETE" — its data may not have gone back cleanly*).

**No backup is left behind.** An uploaded `.restore.tar.gz` holds every secret on the box,
unencrypted, possibly another box's:

- `runRestore` deletes it when the restore is refused because OTHER work is in the way
  (`UpdateBusyError` with `clash`), or while the last restore is in its hold
  (`finishing('restore')`: that one removed its own file on the way out, so anything at the path
  is the refused request's) — not when a restore is still running, which is reading it;
- the upload route (`api/restore.ts`) refuses up front, before the file is read or saved (the
  browser may still send it): 409 *"A restore is already running. Please wait for it to
  finish."* while one runs (`restoreInProgress`), the
  *restarting to finish* sentence while one is in its hold, then the clash sentence while an update
  is in the way (`clashFor('restore')`, which also gives the *restarting to finish* sentence while
  a core update is in its hold), and `BACKUP_RUNNING` while a backup is being made — which
  `restoreOnce` also checks, first thing, so a backup and a restore never overlap; a backup in
  turn refuses while a restore runs (`backupRefusal`, asked before a download from outside
  sends its headers);
- at boot, once the data folders exist, `removeRestoreLeftovers()` (`index.ts` `main`) deletes a
  `.restore.tar.gz` and a `.restore-staging` left by a restore that never reached its `finally` —
  a power cut, say — logging *Removed <name> left behind by a restore that did not finish.*;
- the File Explorer (`files/manager.ts`) treats both as private, like `.backup-staging`: *"This is
  a backup being restored, so it is kept private. It is removed when the restore finishes."*

`test/remote-restore.test.ts` (*A RESTORE REFUSED FOR AN UPDATE IN ITS WAY SAYS SO, AND LEAVES NO
BACKUP BEHIND*, *WHAT AN UNFINISHED RESTORE LEFT BEHIND IS REMOVED AT BOOT*) and
`test/files-guard.test.ts` (*a backup waiting to be restored, and its unpacked copy, are
private*).

**The restore says how it ended** (`RestoreOutcome`, sent as the WebSocket close code,
`RESTORE_CLOSE`): 1000 `restarting`; 4003 `restarting-with-problems` — it ran and the core is
being replaced, but some app data could not be put back, some app could not be started (held for
review, or `compose up` failed: `reupAllApps` now returns their names), or some app could not be
paused (`stopAllApps` returns their names, above); 4004
`restored-not-restarted` — everything was put back, but the helper that restarts the core could
not be started; 4002 `not-restarted` — it stopped part-way, after things had begun to change;
4001 `unchanged` — refused, busy or in the way of an update (*Updates from outside*, below),
unreadable, too large to unpack, or holding nothing to restore, before anything was touched and
before any app was stopped. 4004 is told apart from 4002 because the advice is opposite: restart
the machine or repair it, rather than restore again, which would stop every app again for
nothing. A backup with nothing usable is noticed **before** `stopAllApps`, from one list of volume
archives (`stagedVolumeArchives`) that serves the check and the work alike. It used to be noticed
only afterwards, so a hand-built "app data only" folder stopped every app, left them stopped — a
manually stopped container does not even come back after a reboot — and was reported as "Nothing
was changed". The refusals made before the restore starts — signed out (4401), an unexpected
origin (4403) — now send their reason as a line before closing, ending *Nothing has been
changed.*, so "the messages above say why" is true for them too. `RestoreModal` treats every other
4xxx as unchanged, and a stream that never opened (`LogStream` reports whether it did) as one
that began nothing (*"Couldn't connect to OpenMasjidOS, so nothing was changed. Please try
again."*). On 1000 and 4003 it waits for the restart and then shows *Restore complete.* or *"The
restore finished, but some of your apps or their data need attention — …"*, watching
`/trpc/auth.me` rather than the health check (refused from outside) to see the core come back; it
says it has not seen a restart after about 30 seconds while it goes on waiting, and stops waiting
after four minutes. It used to assume every ending was a restart, and announced *Restore
complete.* after four minutes even for a refused restore — the common case from outside — and
over lines saying that none of the app data had come back, or that an app had not started.

**It waits for evidence.** The core counts as down only after **two** failed checks of
`/trpc/auth.me` in a row, a good answer resetting the count, and as restarted only when it answers
again after that. One blip — a 502, the Wi-Fi — used to read as the restart, so the window said
*Restore complete.* while the old core was still about to be replaced. And when the stream ended
any other way than 1000 or 4003 — after the refusals and 4002/4004 are handled, that means it
**dropped** before the server said how the restore ended — the restore window does not know how it
went, so a restart seen afterwards ends on a neutral `restore.lost`: *"OpenMasjidOS has restarted,
but this window lost touch with the restore before it said how it went. Please reload, sign in
again and check that your apps and settings look right."* It used to say *Restore complete.*
`test/remote-update.test.ts` (*the update window is told whether anything changed — and waits only
for a restart*) reads both windows to pin the two-failure rule and this ending.

**The restore remembers what went wrong.** The window naming the apps that need a look is gone
soon after the core restarts — every session ends then, and the dashboard returns to its sign-in
— and nothing recorded which apps had come back empty. So when app data could not be put back,
apps did not start or apps could not be paused, the restore writes `config/restore-report.json`
(0600; `{at, appsWithoutData, appsNotStarted, appsNotPaused}`: app names — for data, mapped from
each volume's `omos-<id>_…` name, as the window's *Affected:* line now shows them too) and logs
each failure. `backups.restoreReport` and `backups.dismissRestoreReport` (both protected) let the
dashboard show it after the next sign-in until the admin dismisses it, one line per list that is
not empty. The first reads *"These apps' data couldn't be put back, so they have whatever was
already on this machine: …"* — it said "they started with", which was false for an app that had
not started either. A restore with nothing to report removes any older report, including one that
came back inside the backup's own `config/`.

**The core comes back on the build it is running** (`docker/update.ts` `recreateCore`, called with
no tag). The helper runs from the running container's own image, by ID — present locally for as
long as the container exists, whatever has happened to the tags since — and, because the helper's
`docker compose up` reads the core's compose file, `pinComposeToRunningBuild` first tags that
image `<the file's repository>:<the running VERSION>` (`docker tag`) and points the file's image
line at the tag (`alignComposeImage`). The file is left alone when the line, or the running
reference, is pinned to a digest (the operator's choice), or when it names no core image. If the
container cannot be inspected at all, nothing is pinned and the helper runs from the reference the
file names — or, only if that names nothing either, from the channel's alias, as a last resort
(`inspectSelfAsIs`). The file is pinned rather than trusted because it is not a reliable record of
the running build: an update whose helper failed to start had already pointed it at the new
version, and the installer's Update wrote it before downloading. Both are fixed as well —
`recreateCore` puts the file back when an update's helper cannot be started, so *Nothing was
changed* stays true, and `install.sh` `do_update` now decides the image, downloads it, and only
then writes the file. A restore used to aim at the channel's alias (`:latest`, `:dev`) without
pulling it, and the alias names whatever build the installer last fetched — dashboard updates pull
exact versions — so every restore could quietly put the box back on an older build: from outside,
onto one with no remote dashboard, locking the admin out of the very address the restore had
promised to keep. The dashboard's update still passes the exact version it has pulled.

**The backup download** (`api/backup-download.ts`). From outside, for a handed-over request
(`remoteBackupDownload`): headers first — with the no-store headers — and the file when it is made,
because Cloudflare gives up on an origin that has not started answering in 100 seconds and a backup
copies every app's data before its first byte. "Already running" is still a proper 409, known
before anything is sent. The `close` listener is attached **before** the backup starts
(`sendBackupEarly`). Before that, a browser leaving while app data was still being copied fired
`close` before anything listened for it, the archive was then piped into a dead response, tar
blocked on a full pipe for ever, and the one-backup-at-a-time flag stayed set — so every later
backup, the nightly off-site one included, was refused as "already running" until a restart.

**Both downloads**, from outside and at the masjid, then go through `sendBackup`: a browser leaving
ends tar, which clears that flag; and the response ends only when tar's output has finished
**and** tar has reported success (`done.ok`) — anything else breaks it off (`res.destroy()`), so
the browser reports a failure rather than saving a partial file. tar's output ends before tar
exits, so a download ended with the output — by a pipe, or by Fastify's `reply.send(stream)`,
which the download at the masjid used — arrived whole and clean for a backup tar had failed.
`test/remote-backup.test.ts` pins both.

## Updates from outside

**Nothing done from outside may move the box to a version that cannot be managed from outside.**
`FIRST_REMOTE_ADMIN_VERSION` (`0.51.2-dev.16`, `system/remote-admin.ts`) is the first build that
serves the dashboard on an address of its own, and `managesFromOutside(version)` compares against
it by semver. On anything older the core would come back with nothing at the dashboard address —
Stable has never had the feature, and dev.13–dev.15 kept the dashboard beside the apps — and every
window from outside would stay cut off until someone at the masjid moved the box on again. Two
places ask, both only for a request the front door handed over:

- **The core update** (`api/update.ts` → `runUpdate(onLine, { remote: wasHandedOver(req.raw) })`).
  After the "already up to date" check and before anything is pulled, it refuses a target
  (`checkForUpdate().latest`) older than that build — *"Version … can't be managed from outside
  the masjid, so installing it from here would cut you off."* then *"Please do this at the masjid.
  Nothing was changed."* — and a target it could not read at all (*"Couldn't check which version
  this would install, so it can't be done from outside right now."*), because from out there
  nobody could put a wrong guess right. On the box's own channel an unreadable version never gets
  that far, anywhere: it stops with *"Couldn't check for the latest version just now, so nothing
  was changed."* and pulls nothing, where it used to say the box was already up to date — which
  nobody knew. So the from-outside refusal is met on a channel move whose target could not be
  read, or when the check itself failed.
- **The channel switch** (`system.setUpdateChannel`, `ctx.handedOver`). Before anything else it
  reads the target channel's published VERSION (`publishedVersion`, `system/system.ts`):
  unreadable is SERVICE_UNAVAILABLE (*"Couldn't check which version Stable would install, so this
  can't be changed from outside right now. …"*), too old is FORBIDDEN (*"Stable (version …) can't
  be managed from outside the masjid, so switching to it from here would cut you off. Please make
  this change at the masjid. Nothing was changed."*). The switch itself is refused, not only its
  last step, so the apps and the platform stay on one channel. A switch made at the masjid and
  finished from outside still moves the apps and then stops at OpenMasjidOS (Part 1, *Honest
  limits*). Once Stable reaches that build, the switch is allowed from outside.

At the masjid, and behind a reverse proxy there, both behave as they always have.

**A core pinned to one exact build is not "updated" onto itself** (`runUpdateInner`, everywhere,
not only from outside). When the core's compose line names a digest (`composeImageRef()` contains
`@` — the operator's choice, which `alignComposeImage` leaves alone), the update stops after the
up-to-date and from-outside checks and before anything is downloaded: *"OpenMasjidOS is pinned to
one exact build on this machine, so it can't update itself from here. Nothing was changed."*,
closing 4001. Before, every press pulled that same build and restarted the dashboard onto it,
signing everyone out, while the banner went on offering the update. It still does:
`checkForUpdate` was not changed, so the banner and the `core-update` alert keep offering a version
this machine will not move to — a residual. `test/remote-update.test.ts` (*A CORE PINNED TO ONE
EXACT BUILD IS NOT "UPDATED" ONTO THAT SAME BUILD, AGAIN AND AGAIN*).

**One at a time** (`system/update-lock.ts`). A core update and a restore are `EXCLUSIVE`: either
is refused while any other work runs, and nothing else starts while either runs — each ends by
replacing the core, and a restore stops every app and refills its data. Two different apps'
updates may still run together. A refusal because OTHER work is in the way is an
`UpdateBusyError` with `clash: true`, and says what is in the way: *"A backup is being restored
right now. Please update OpenMasjidOS once it has finished. Nothing was changed."*, *"OpenMasjidOS
is being updated right now. Please restore your backup once it has finished. …"*, *"An app is
being updated right now. Please update OpenMasjidOS once it has finished. …"*, *"… Please update
this app once it has finished. …"*. Every window that meets one closes as unchanged (4001). The
same work asked for twice is not a clash: a second core update says *"An update is already
running. It will finish on its own."* and closes 1000, because that update may well restart the
core and the window watches for it as for its own. A review pressed Update 300 ms into a restore:
the update's helper replaced the core while the restore was still refilling app data, which cut
the restore off part-way and left every app stopped.

**The lock lasts until the core is replaced, not until it hands that job over.**
`withUpdateLock(key, busy, fn, { holdAfter })`: once `fn` has resolved, `holdAfter(result)`
milliseconds more keep the key held, released by an `unref`'d timer; a failure (a throw) never
holds. `runUpdate` holds for `restarting`, `runRestore` for `restarting` and
`restarting-with-problems`, each for `HOLD_UNTIL_REPLACED_MS` (5 minutes). The old core goes on
running for about 12 seconds after handing its replacement to the helper — the helper's
`sleep 2`, then compose's 10-second stop timeout, because the core runs `node` as PID 1 (the
image's entrypoint) with no SIGTERM handler, so the signal is ignored — and releasing the lock at
the hand-off accepted a restore, an app update or a second core update in that gap, which the
replacement then killed part-way: a review launched three helpers at once, and cut a restore off
with one app's data half put back and every app left stopped. The new core starts with no locks,
so in practice the hold ends with the restart; the timer exists so that a helper which never
replaces the core cannot wedge the box. A restore's hold also keeps `noChangesDuringRestore`,
`refuseDuringRestore`, `assertAppFree` and the monitors' pause in force until the restart.

**During the hold the work is done, and every refusal says so** (`finishing(key)`,
`finishingMessage(key)`): *"OpenMasjidOS is restarting to finish an update. Please try again in a
minute or two. Nothing was changed."* or *"OpenMasjidOS is restarting to finish restoring your
backup. Please try again in a minute or two. Nothing was changed."* It stands in, during the hold
only, for the clash sentence, the same-work "already running" sentence (still not a clash, so the
core's update window, closed 1000, waits for the restart), `assertAppFree`'s sentences,
`noChangesDuringRestore`'s and the logo routes', and the restore upload's *"A restore is already
running…"*. "Being restored right now" over a restore that had finished sent the admin to wait for
something that was not happening. While the work is still running, the earlier sentences stand.
`test/update-lock.test.ts` (*A CORE UPDATE OR A RESTORE KEEPS ITS LOCK UNTIL THE CORE IS REPLACED
— not just until it hands that job over*) and `test/remote-restore.test.ts` (*A RESTORE THAT
RESTARTS THE CORE KEEPS ITS LOCK UNTIL THE CORE IS REPLACED*).

**No app is started, restarted, installed or removed under a restore or its own update**
(`assertAppFree(id, action)`, thrown as `UpdateBusyError` with `clash: true`). It is the first
thing `startApp` and `restartApp` do (`'start'` — `docker compose restart` starts a stopped
container), and `removeApp` (`'remove'`), `installCatalogApp` and `installStack` (`'install'`);
`stopApp` is never refused. In order:

| While | Refused | Says |
|---|---|---|
| a restore or a core update is in its hold | a restore's: every action; a core update's: install and remove | the *restarting to finish* sentence |
| a restore runs | every action | start: *"A backup is being restored right now. Your apps will start again on their own when it has finished. Nothing was changed."*; install, remove: *"A backup is being restored right now. Please install this app once it has finished. Nothing was changed."* (or *remove*) |
| that app's own update runs (`app:<id>`) | every action | *"This app is being updated right now. Please try again once it has finished. Nothing was changed."* |
| a core update runs | install and remove — a start is allowed | *"OpenMasjidOS is being updated right now. Please install this app once it has finished. Nothing was changed."* (or *remove*) |

A restore stops every app and refills its data: an app started meanwhile ran over a database
being replaced — a review's Start, accepted mid-refill, ran `compose up` before the refill
finished — and, worse, a compose that came in with the backup and had not been checked yet could
be started with nobody agreeing to it (`privileged: true` is host root), from WhatsApp too, which
must never be able to agree. A start during the app's own update brought up the compose the update
was about to put back. Every caller treats the error as information: the apps router's `wrap` →
CONFLICT; WhatsApp's `!os start` and `!os restart` reply with the sentence; the address monitor
and Settings → Remote access's re-ups catch it and move on. The store, custom and community
install routes and the WhatsApp gateway's restart turn it into CONFLICT as well, with the same
sentence. From the dashboard during a restore, `noChangesDuringRestore` answers before any of this.
`test/update-lock.test.ts` (*NO APP IS STARTED, INSTALLED OR REMOVED UNDER A RESTORE OR ITS OWN
UPDATE — stopping never is*).

**The update window is told how the update ended — and says "updated" only on evidence.**
`runUpdate` returns an `UpdateOutcome`, and `api/update.ts` closes the socket with `UPDATE_CLOSE`:
1000 `restarting` (the helper is replacing the core) or 4001 `unchanged` — already up to date, a
version that could not be read, a download that failed, an updater that could not start (the compose
file is put back then, above), a refusal from outside, a core pinned to one build, a clash, an
exception. The refusals made before the update starts — signed out (4401), an unexpected origin
(4403) — send their reason as a line before closing, ending *Nothing was changed.*, so "the messages
above say why" is true for them too, as it is for a restore. `UpdateModal` treats any 4000–4999
close as unchanged: unlocked at once, *"Nothing was changed. The messages above say why."* and a
Close button. A stream that never opened began nothing (*"Couldn't connect to OpenMasjidOS, so
nothing was changed. Please try again."*). A 1000, or a stream that dropped part-way, waits for the
restart, watching `/trpc/auth.me`, and ends on *Updated to v…* only when a new version answers — or
on *Update applied.* when the core was seen to go down and come back with no version visible. After
about 30 seconds with no sign of a restart it says so, unlocked and still watching (*"OpenMasjidOS
hasn't restarted yet. If nothing changes in a minute or two, reload this page to see which version
is running."*); after about three minutes it ends there. Every ending used to be taken for a
restart, so an update that changed nothing held the dialog shut on "restarting…" for three minutes
and then said *Update applied.* — over an update still downloading, or one that had failed, and,
once refusals from outside existed, as the usual case.

The evidence rules are the restore window's: the core counts as down only after **two** failed
checks in a row, a good answer resetting the count — one blip used to keep the dialog locked for
three minutes and then claim a restart that never happened. And once the core has been seen down
and is back on the **same** version, the window watches about 30 seconds more (15 polls) for a
further restart, then ends, unlocked, on *"OpenMasjidOS restarted, but it is still on v…. Reload
this page, then try the update again."* — rather than holding the dialog for the rest of the three
minutes.

**So are the app windows.** `updateCatalogApp` returns an `AppUpdateOutcome` — `updated`;
`unchanged`, when it was refused, already current, or put back after a download or a start that
failed; `not-running`, when the new version does not stay up — and `api/app-update.ts` closes
with `APP_UPDATE_CLOSE`: 1000 updated, 4001 nothing changed, 4003 updated but not staying up,
4002 stopped part-way (an exception). Its refusals before starting send their line and close
4401 or 4403, and an impossible app id 4400 (*"That app could not be found. Nothing was
changed."*). `ui/src/lib/update-endings.ts` turns a close into an ending for the three windows
that stream an app's update — `AppUpdate`; `UpdateAllApps`, which counts the apps that really
updated; and `ChannelMigrate`, which counts the apps that really moved and reads its OS step's
close too (any 4xxx, or a stream that never connected, says OpenMasjidOS itself was not changed).
It is React-free so that a core test can hold it to the server's codes. The windows used to say
*"… is up to date now."* and *"All 4 apps updated."* however the streams had ended — and the
channel switch said *"Now updating OpenMasjidOS itself"* over an OS step that changed nothing.
`test/remote-update.test.ts` pins the version rule, the refusals and every close code;
`test/update-lock.test.ts` the one-at-a-time rule.

## Settings → Remote access

- **`cloudflare.save` checks everything, then writes once.** It computes the final apps' hostname
  and admin hostname, validates the admin hostname against the apps' hostname **as it will end up**
  (`validateAdminHost(input, appsHost)`), checks the token, and only then writes the token
  (`setToken`) and one `updateCloudflare`. It used to write the apps' address first and refuse the
  dashboard address afterwards, so a save that said "refused" had already moved the apps onto the
  dashboard's hostname — which switches remote administration off, and done from outside left only
  the masjid able to undo it. Three reviewers found it separately.
- **From outside — a request the front door handed over (`ctx.handedOver`), not a header — two
  changes are refused (FORBIDDEN):** moving or clearing the admin hostname (*"Change the dashboard
  address at the masjid — changing it from here would cut you off."*), and any tunnel token but the
  one in use (*"Replace the tunnel token at the masjid — if the new one didn't work, this window
  and every shared app would go offline until someone there fixed it."*). Sending what is stored
  already — the token in use, with its `=` padding or without — changes nothing and is accepted.
  Saving a token recreates the cloudflared container, which is the connection a remote request
  came through, and a token for another tunnel, or a stale one, connects nowhere useful, with no
  way back but the masjid. A reverse proxy at the masjid is at the masjid, so its admin can change
  both.
- **Everywhere, a token has to be a whole one** (`system/cloudflared.ts` `normalizeTunnelToken`):
  base64 of a small JSON object holding the account (`a`), the tunnel's id (`t`, a UUID) and its
  secret (`s`). Cloudflare's whole install command — `… --token X`, `--token=X` or
  `service install X` — is reduced to its token. A token whose `=` padding was left behind — a
  double-click selects all of a token but that — is repaired, because the padding is fixed by the
  length: two characters short takes `==`, one takes `=`, and a length no base64 can have is
  refused. Anything else is refused (BAD_REQUEST, *"That doesn't look like a whole tunnel
  token…"*) before anything is written, and only the canonical form is kept (`isTunnelToken`:
  whole four-character blocks that encode back to exactly the same string). cloudflared reads a
  token with Go's padded base64, which refuses a missing or extra `=` that Node's decoder accepts,
  so tokens used to pass here that cloudflared then refused — and under `restart: unless-stopped`
  it retries for ever: a half-copied token took the dashboard's address and every shared app
  offline while the platform logged *Cloudflare tunnel is running.* — the container was up, it
  never connected. That log line now says *Cloudflare tunnel started.* (`ensureCloudflared`),
  which is all it knows. Docker reports a container in that restart loop as `Running` too, so
  `cloudflaredRunning` now also asks that it is not restarting (`tunnelContainerUp`), and Settings
  no longer says *Tunnel is running.* over a tunnel that keeps failing. With remote access switched
  on and the tunnel not up, the line under the switch says *"Tunnel is turned on but isn't
  connecting. Check that the tunnel token is the right one."*
  (`settings.cfNotConnecting`), beside the red dot it already had; it used to fall through to
  *"Tunnel is set up but turned off."* `test/remote-settings.test.ts` (*a tunnel stuck restarting
  on a refused token is not shown as running*) pins both.
- **The UI sends each address only when its field was edited** — sending whatever a field held put
  back a value from when the page loaded, undoing a change made on another device. After a save
  that goes through, both fields refill from what the server stored. From outside the
  dashboard-address and token fields are disabled, each with its hint. After a refused save the
  panel's status is refreshed, so the switch and the lines around it show what is stored; the
  text boxes keep what was typed, to be corrected.
- **From outside**, turning remote access off, turning remote administration off and removing the
  tunnel go through a `ConfirmDialog` (`isRemoteSession()`, from `auth.me` → `remote`); on the LAN
  they stay one click, because there none of them cuts off the connection in use. Turning remote
  access off and removing the tunnel stop cloudflared, so their answer never comes back — the
  browser gets Cloudflare's own error page instead — and an error with no tRPC code there is shown
  as done (*"Done — this window can’t reach the dashboard any more…"*) rather than as a raw error
  with the dialog still armed. Turning remote administration on is always the explanatory dialog.
- **`setRemoteAdmin`** refuses to switch on without a second factor, the tunnel, or an admin
  hostname of its own (PRECONDITION_FAILED). Switching it off clears the per-address lockout records
  and sweeps the sockets. **`clear`** turns both `enabled` and `remoteAdmin` off, so the setting
  cannot lie dormant and switch itself back on with the next tunnel.
- **`cloudflare.status`** reports the switch (`remoteAdmin`), whether it is in effect
  (`remoteAdminActive`, i.e. `remoteAdminEnabled()`), why it could not be switched on
  (`remoteAdminBlocked`, i.e. `remoteAdminBlockedReason()`: `no-two-factor`, `no-tunnel` or
  `no-admin-host`) and `adminHost`. Showing only the switch would be a screen that lies.
- **`doorClosedReason()`** changes only what *Recently turned away* records for a shut door:
  `no-admin-host` when the tunnel and the switch are on, an admin account exists, a second factor
  is enrolled and only the dashboard address is missing or equal to the apps' one — exactly what a
  box managed remotely on dev.13–dev.15 looks like after updating; otherwise `lan-only-route`.
  `registerHandoffOnlyGuard` records `wrong-port`, and the ingress and the front door's not-found
  handler `worker-at-bare-address` (through the tunnel only — judged by `isViaTunnel`, the header
  test, not the hand-over, so one asked for through a reverse proxy at the masjid that sends
  `X-Forwarded-Proto: https` is listed too; accepted, since the list is only a diagnostic). Each
  of the ten reasons has its own words on screen, and the response stays identical whatever the
  reason — the 404, or for a worker's script at a bare address the self-removing worker:
  `test/tunnel-refusals.test.ts` reads the reasons from the type itself and fails if one has no
  label, or if any refusal's 404 names its guard.

## The lockout, and why the tunnel is the easy case

The hard login lockout is **off by default** (`OPENMASJID_LOGIN_LOCKOUT=1` turns it on), and
`trpc/routers/auth.ts` explains why:

> behind Docker's port publishing every LAN client is SNATed to the bridge-gateway IP, so a
> global lockout would let an attacker deny the real admin.

That objection does not apply to tunnel traffic. **Cloudflare sets `CF-Connecting-IP` at its
edge**, and a tunnel client cannot forge it — the same reasoning that makes `cf-ray` a usable
signal for `isViaTunnel`. So remote sign-ins have a genuine **per-IP** lockout
(`auth/ip-lockout.ts`): `IP_MAX_FAILURES` (10) wrong passwords or codes from one address, with no
more than `IP_WINDOW_MS` (15 minutes) between one and the next, refuse that address for
`IP_LOCKOUT_MS` (15 minutes). It is checked before the password or the code is even looked at, a
correct password clears the address's record, and at most `IP_MAX_TRACKED` (1,000) addresses are
tracked at once. LAN sign-ins keep the delay-based defence, because there the header is absent and
every client really does look identical.

The rule to hold: **`CF-Connecting-IP` is trusted only when `isViaTunnel` is already true.** On the
LAN it is an attacker-supplied header and must be ignored entirely; `trpc/context.ts` passes `null`
there. Trusting it unconditionally would hand any LAN client a way to evade the counter by varying
one header — and `util/net.ts` already carries the note about why a source-address check cannot
work here.

## The second factor applies to OUTSIDE connections only

A masjid volunteer on the masjid's own network must not be locked out of the dashboard by a phone
they left at home — Hasan's call. So `login` demands a second factor when `ctx.viaTunnel` is true,
and not otherwise; and with no factor enrolled it refuses tunnel traffic outright (it fails
closed).

**Be honest about what that buys, because it is weaker than it sounds.** `viaTunnel` is sound for
traffic that really came through the tunnel — Cloudflare sets `cf-ray` at its edge and a client
cannot strip it. It **cannot** tell the LAN from the internet on a box whose ports 80/443 are
directly reachable: a public-IP VPS, or a router forwarding them. Such a request carries no
Cloudflare headers and looks exactly like the office laptop, so it **skips the second factor
entirely**. `CLAUDE.md` §15 says this about the LAN-only guard, and `util/net.ts` records why a
source-address check cannot fix it — Docker SNATs every inbound connection to the bridge gateway, so
a peer check answers "private" for the internet. So this protects **the door being deliberately
opened**; it is not a substitute for a firewall or a bind address on a directly reachable host, and
`docs/SECURITY.md` keeps saying so.

> If that residual bothers you, the fix is a setting — "require the second factor everywhere" —
> rather than a cleverer detector. There is no header that distinguishes a LAN client from the
> internet on this network layout; that is the finding `util/net.ts` exists to record.

## Second factors

Two, both implemented in Slice 1:

- **An authenticator app (TOTP).** RFC 6238, hand-written against published vectors rather than
  taken from npm — see `auth/totp.ts` for why. Enrolment is two-step: a secret is minted as
  *pending* and only becomes active once a live code proves it, so an admin who scans a QR and
  closes the tab is not locked out by a factor they never had.
- **An emailed code.** Six digits, ten-minute life, single use, five wrong guesses burns it, and no
  more than one a minute — that last one is an email-bomb guard as much as a brute-force one. It
  needs a configured mail provider and an address on the account, **and an authenticator**:
  `setEmailFactor` refuses to switch emailed codes on without one (PRECONDITION_FAILED, *"Set up an
  authenticator app first — emailed codes are a backup to it, not a replacement."*). The screen had
  only ever offered them that way, but nothing enforced it, and as the only factor they are
  pausable (below) — after which nothing is enrolled, the next change needs only the password, and
  that change could point the codes somewhere else. With an authenticator always present, turning
  them back on always needs a current code.

**Backup codes** are issued once at enrolment, shown once, stored hashed. Ten of them, ~50 bits
each.

**Replay is the property that makes it a second factor.** A TOTP step is spent when it is used,
including the step that completed enrolment, so a code read off a shared screen or captured by a
phishing page is dead the moment it is used once. `test/twofactor.test.ts` pins this from both
directions — an old step is refused, and the *next* step still works so the guard cannot freeze the
account. A refused code that would have been right with the server's clock some steps off says so
(`clockSkewSteps`); the code is still refused.

**Emailed codes are bound to where they go.** An emailed code proves "this person can read the
masjid admin's mail" only while it is sent to the masjid admin's mail. Changing the address
(Settings → Account) or pointing mail at another relay (Settings → Email) needs nothing but a
signed-in session — a password-only one, on the masjid's network — so without a binding that
session could quietly send the next sign-in code to itself, and the factor would no longer mean
what the admin switched on. Be exact about what the binding does not do: it is not what stands
between a full dashboard session at the masjid and signing in from outside. Such a session can
download a backup, and a backup holds the authenticator's secret along with every other one.
What two-step sign-in protects is remote access from someone who knows the password but cannot
reach the masjid's network. So switching emailed codes on records `emailBoundTo`:
a hash of the admin's address and of `emailDeliveryFingerprint()`, which is the provider and the
account mail goes through (SMTP host, port, TLS setting and user, or a hash of the Resend key). Not
the From address — that changes what a recipient sees, not who can read what was sent — and not the
SMTP password, since rotating it keeps the same mailbox. If either changes, emailed codes are
**paused** (`emailUsable` false, `twoFactorStatus().emailPaused`): none are sent or accepted, the
two-step panel says so — only when emailed codes are possible at all; otherwise it names what is
missing first, an email provider or an address on the account (`emailMissing`) — and switching
them on again asks for the password and a current authenticator or backup code. A configuration
that had them on before the binding existed is bound to where codes go now, once, at boot
(`adoptLegacyEmailBinding`) — the same trust the old code extended — rather than paused by an
upgrade.

**Changing the factor ends the remote sessions made with the old one.** `twofactor.json` carries a
random `epoch`, given a new value whenever what counts as a second factor changes: an authenticator
enrolled or replaced (`confirmEnrolment`), backup codes replaced (`regenerateBackupCodes`), emailed
codes switched on or off (`setEmailFactor`), two-step sign-in turned off (`disableTwoFactor`, which
keeps nothing but a new epoch, so a session made under the removed factor cannot come back if it is
switched on again). Using a code does not change it — signing in must not sign everyone else out. A
remote session records the epoch its code was checked against (`VerifyResult.epoch`), bound at the
moment of proof exactly as the password binding is, and counts from outside only while that is
still current. So replacing a lost phone, or burning backup codes someone found, ends every remote
session made with the old ones — files and terminals included — instead of leaving them their seven
days. On the LAN such a session goes on working, because signing in there has only ever taken the
password; a password change is what ends a session everywhere. Random rather than a counter, so a
restored `twofactor.json` can never collide with a value a later change produced. One session is
kept: the admin who made the change from outside (`rebindRemoteSession`, from `afterFactorChange`)
has just proved the password and a current code, and is often reading something shown once — a
fresh set of backup codes — which signing them out would take off the screen before it was written
down. (Turning two-step sign-in off closes the door from outside anyway.) `afterFactorChange` asks
`ctx.viaTunnel` rather than the hand-over, deliberately: `rebindRemoteSession` only ever moves a
session that is already `remote`, so the one other case it covers is a sign-in made through a
reverse proxy at the masjid, second factor and all, which goes on working through that proxy
rather than being signed out by its own change.

## A session is not enough to change how you sign in

Every mutation in `trpc/routers/twofactor.ts` re-proves the password and, once a factor is active,
the current second factor as well (`requireSudo`) — except `confirm`, which only finishes an
enrolment that `begin` started behind that check. The reasoning is worth repeating, because the
obvious threat is the wrong one.

**Turning 2FA off is not the attack.** With no factor enrolled, `login` refuses tunnel traffic
outright, so an attacker who switches it off has shut their own door.

**Re-enrolment is the attack.** Reach an authenticated dashboard — a stolen cookie, a borrowed
unlocked laptop, a password reused from somewhere else — mint a fresh secret into your own
authenticator, and you can now sign in from anywhere in the world, indefinitely, through the front
door. The admin's password still works. Nothing on screen looks different.

The two checks cover different halves of that, which is why neither is sufficient alone:

| | blocks |
|---|---|
| Password | a session with no password behind it (stolen cookie, XSS, an unlocked laptop) |
| Current second factor | a password with no phone behind it — the LAN case, where a password is the whole of sign-in |

A code spent this way is **spent**: `verifySecondFactor` advances the replay guard on success, so
the code that authorised a change cannot then be replayed to sign in.

**`requireSudo` reads the second factor before the password check and compares after it.** It
captures the epoch and whether two-step sign-in is active before argon2 runs, and refuses with
CONFLICT (*"Two-step sign-in was changed somewhere else a moment ago. Please try again."*) if either
changed meanwhile. Without that, an admin turning two-step sign-in **off** to evict someone could
lose the race to that someone — holding a remote session and the password — whose own change, begun
a moment earlier, found "nothing enrolled", skipped the code, switched emailed codes back on and
kept its session under the new epoch: the door reopened with them inside and the admin told it was
shut. A review reproduced it three times out of three. It also refuses every change while a
restore runs, before the password check and again after it (*Restores and backup downloads from
outside*).

**The way back when a phone is lost is a backup code**, accepted anywhere a TOTP code is — from
outside to sign in, and at the masjid or outside to replace the authenticator. `requireSudo` asks
for a code whenever a factor is active, on the LAN as well, so with neither phone nor backup code
the dashboard offers no way to replace or remove the factor. (`verifySecondFactor` would also take
a pending emailed code there, but one is only ever sent by a sign-in from outside, never for a
change.) **The one supported way out then is the installer's *Reset sign-in*** (`reset-auth.ts`,
run inside the core container on the machine itself). Besides a new password, ended sessions and
new app keys, it asks — only while a factor is active, and no unless told yes — whether to turn
two-step sign-in off as well (`disableTwoFactor`, which also gives the factor a new epoch). It
used to leave `twofactor.json` alone, and that was the gap: an admin who lost the phone and the
backup codes had no supported way to remove or replace two-step sign-in, short of working on the
server's files by hand. It gives nothing away, because whoever runs it already has the machine.
`reset-password.ts`, the command the sign-in screen's *Forgot your password?* shows, still
changes only the password, and while a factor is active it says where the full reset is (Part 1,
*If you lose your phone*).

A change that takes effect — a new authenticator, new backup codes, emailed codes on or off,
two-step sign-in off — also gives the factor a new epoch (*Second factors*) and at once closes every
connection from outside whose session that ended (`sweepHandedOverSockets`).

## Where the QR is drawn, and why it is not in the browser

`auth/qr.ts` encodes the `otpauth://` URI server-side with `qrcode-generator` (MIT, no
dependencies of its own, ships its own types) and returns a **grid of bits**. The UI draws that as
a single SVG path.

Three reasons it is not a browser dependency:

- **It is testable here.** `packages/ui` has no test runner, so an encoder in the bundle could not
  be checked at all — and a QR that encodes the wrong string looks exactly like one that encodes
  the right string. `test/qr.test.ts` checks the finder patterns, the timing patterns and the
  version chosen against the spec's own capacity table, and pins the exact grid for a fixed input.
- **`@openmasjid/ui` is a design system other apps consume.** A QR encoder is not a design system,
  and putting it there would make every app in the fleet carry it.
- **The result is data, not markup.** No `dangerouslySetInnerHTML` anywhere near the sign-in flow.

Two details that are easy to get wrong and are pinned by tests: the payload must be **ASCII** (the
library's default byte conversion is Shift_JIS — UTF-8 is a separate entry point — so a non-ASCII
character would scan to mojibake, and `qrMatrix` throws rather than encoding it), and the code is
drawn **black on white in both themes**, because a QR is read by contrast and a token-coloured one
would be near-invisible to a camera on the dark theme.

---

# Part 3 — History

## Plan

| # | Slice | State |
|---|---|---|
| 1 | TOTP + emailed codes + enrolment state, with the replay guard | ✅ `dev.9` |
| 2 | The second factor wired into login, tunnel-only | ✅ `dev.10` |
| 4 | Settings UI: enrolment with a QR, backup codes, the sudo rule; the login screen's code step | ✅ `dev.12` |
| 3 | The exposure itself: the dashboard on the front door behind the setting, per-IP lockout, §15 rewritten | ✅ `dev.13` |
| 5 | Everything from outside, on an address of its own: the hand-over, remote sessions, one-use *Open* tickets and per-app tokens, the second-factor epoch and email binding, the remote-restore rule | ✅ `dev.16` |

Slice 3 is the one that carried the risk, and it went last on purpose: everything before it is
provable in isolation, and none of it changes what the internet can reach. Slice 4 was taken ahead
of it so the factor could be set up, scanned and verified before anything depended on it — the
alternative was an admin meeting enrolment for the first time on the same day the dashboard became
reachable from the internet.

Slice 5 is where the risk turned out to be. Putting the dashboard and the apps on one hostname
looked like a routing detail and was an origin decision (Part 2, *Why two*), and it had been true
since Slice 3.

## What Slice 3 changed (dev.13), and the one thing it broke on the way

`system/remote-admin.ts` is the single decider (`remoteAdminEnabled()`), the single statement of
which paths the dashboard owns (`isDashboardPath`, and `touchesDashboardPath` for the gate) and,
since dev.16, of which hostname it lives on. All of them are security decisions, and this codebase
has twice shipped a second, subtly different copy of a check like that.

dev.13 registered tRPC and the built UI on the front door itself, behind an `onRequest` gate that
runs after the Fabric guard, and served the dashboard at the **root of the one tunnel hostname** —
`https://omos.example.org/` — beside the apps, on the reasoning that apps are routed by first path
segment and the root was free. Both were replaced in dev.16: the second copy of the dashboard by the
hand-over, the shared hostname by the dashboard address. The gate stayed. Its cases, then and now:

| | before dev.13 | dev.13–dev.15 | now |
|---|---|---|---|
| LAN, plain HTTP | 308 → HTTPS | 308 → HTTPS | 308 → HTTPS |
| tunnel, feature off | 404 + refusal recorded | 404 + refusal recorded | 404 + refusal recorded |
| tunnel, feature on, the root of the apps' hostname | 404 | the dashboard | 404, recorded as `dashboard-elsewhere` |
| tunnel, feature on, the *Dashboard address* | — | — | the dashboard |

**The regression, worth recording because the unit tests could not see it.** The front door's
`notFoundHandler` was what redirected plain-HTTP LAN traffic to HTTPS. The moment `@fastify/static`
was registered on that listener, `GET /` matched a real route, skipped the handler, and served the
dashboard **unencrypted on the masjid's own LAN**. The gate redirects LAN traffic itself now. The
tests missed it because the front door they build to exercise the gate had no static route, so the
fall-through still reached the handler there; a smoke test against the real daemon found it in one
line. `test/remote-admin.test.ts`'s mirror has `/` and `/assets/index.js` registered behind the
gate and asserts that a LAN request for either is redirected, never handed over; at the time,
mutation-checking confirmed that removing the redirect failed it.

### Verified against the real daemon (dev.13)

Measured on dev.13, when the dashboard was at the root of the one tunnel hostname. The *feature
OFF* column and the `LAN` rows still hold. The *feature ON* `TUN` rows that answered are history:
today they answer only on the *Dashboard address*, and are refused as `dashboard-elsewhere`
anywhere else.

```
=== feature OFF (the default) ===        === feature ON ===
LAN  /                 308               LAN  /                 308
LAN  /api/health       200               TUN  /                 200
TUN  /                 404               TUN  /settings/account 200
TUN  /trpc/auth.me     404               TUN  /trpc/auth.me     200
TUN  /api/health       404               TUN  /api/health       404
TUN  /api/fabric/site  404               TUN  /api/fabric/site  404
                                         TUN  /api/auth/session 404
                                         TUN  /nosuchapp        404
```

WebSocket upgrades, which curl cannot distinguish from a destroyed socket:

```
feature ON   TUN ws /trpc         HTTP/1.1 101 Switching Protocols
feature ON   LAN ws /trpc         destroyed
feature ON   TUN ws /nosuchthing  destroyed
feature OFF  TUN ws /trpc         destroyed
```

Every refused upgrade is **closed**, never abandoned — an abandoned one holds a file descriptor
until the peer gives up, which is an unauthenticated resource lever on a root daemon.

## What the second review found (dev.15): two bugs that shipped in dev.13–dev.14

**1. With the feature OFF, the dashboard API answered over the tunnel to an encoded address.** The
gate asked `isDashboardPath`, which needs EVERY spelling of the path to be a dashboard path. That is
the right rule for deciding to *serve* — and the wrong one for deciding whether the gate *looks at
all*. `/%74rpc/auth.me` has the raw first segment `%74rpc`, so the gate said "not mine" and let it
through, and Fastify, which routes on the decoded path, delivered it to tRPC. The gate now asks
`touchesDashboardPath` (ANY spelling). In dev.15 serving still required `isDashboardPath`; since
dev.16 the front door serves nothing of the dashboard itself — a request the gate lets through is
handed whole to the dashboard listener, whose own routes and guards (the Fabric guard among them)
decide what it gets. `/%74rpc/auth.me` answered 200 with the feature off before the fix. Measured
against the real built daemon after it — on dev.15, with the dashboard still on the one tunnel
hostname. The *feature OFF* column still holds. The *feature ON* column is history: those requests
are now served, and upgraded, only on the *Dashboard address*, and an encoded socket such as
`ws /%74rpc` is no longer claimed at all, because `claimsDashboardSocket` now needs every spelling to
be a dashboard socket (*The first cut of dev.16*, below):

```
feature OFF                                 feature ON
TUN  /trpc/auth.me           404            TUN        /%74rpc/auth.me     200
TUN  /%74rpc/auth.me         404            TUN (http) /%74rpc/auth.me     308 → https://omos.example.org/…
TUN  /tr%70c/auth.me         404            TUN        /api/%66abric/site  404
TUN  /%74rpc%2Fauth.me       404            LAN        /trpc/auth.me       308 → https://<lan>/…
TUN  /api/../trpc/auth.me    404
TUN  /x/../trpc/auth.me      404            sockets, feature ON
TUN  /as%73ets/x.js          404            TUN        ws /trpc     101, and a real tRPC query answered
TUN  /%73ettings             404            TUN        ws /%74rpc   101
LAN  /%74rpc/auth.me         308 → https    TUN (http) ws /trpc     destroyed
                                            LAN        ws /trpc     destroyed
sockets, feature OFF                        TUN        ws /trpcx    destroyed
TUN  ws /trpc                destroyed      TUN        ws /settings destroyed
TUN  ws /%74rpc              destroyed
```

Every refusal above was recorded for *Recently turned away*.

**2. Every app's live connection over the tunnel was broken.** `@fastify/websocket` had been
registered on the front door to carry the dashboard's socket. It routes *every* upgrade through
Fastify, so an app's socket was piped to the app by the ingress AND proxied as an ordinary HTTP
request by the ingress's hook — the browser got an HTTP response inside its WebSocket stream and the
connection died. The plugin is gone from that listener; the ingress is the one upgrade owner. In
dev.15 it handed the dashboard's socket to tRPC's own handler on the front door; since dev.16 it
hands a claimed socket to the dashboard listener, as that listener's own `upgrade` event, when
`claimsDashboardSocket` agrees — which asks the same `frontDoorDecision` the HTTP gate does.
`test/front-door-websocket.test.ts` drives real sockets through the real ingress against a real
upstream app. **The app-socket half was not re-run against the real daemon** at the time: the test
machine had no Docker, so the daemon's ingress had no app routes to send a socket to, and the
behavioural test was the evidence for that half. That test now stubs Docker to answer the way a
reachable daemon does, because on CI, where Docker answers, a rebuild that finished after the test
pinned its routes replaced them with nothing.

The same review found three ways a sign-in could outlive a password change; those are recorded in
CLAUDE.md §9 (*the binding comes from the password that was proved*), not here.

## The first cut of dev.16, and the review that redrew it

The masjid asked for the whole dashboard to work from outside once two-step sign-in is set up — not
just its pages. Until dev.16 it did not:

- **No app opened.** Open built `http://<hostname>:<app port>`, and the tunnel carries one hostname
  to one port. Every app failed remotely, shared or not.
- **Apps not shared online did not exist at the tunnel hostname at all.**
- **Files, terminals and backup/restore** were kept on the LAN on purpose (`LAN_ONLY_FEATURES`) —
  and **core and app updates and the logo upload** by accident, because each is an `/api` route on
  the dashboard listener, which the tunnel never reached. That is why an OpenMasjidOS update could
  not be started from the remote dashboard on dev.13–dev.15.

The first cut of dev.16 fixed all of that and left the dashboard where dev.13 had put it, at the
root of the one tunnel hostname. It brought the hand-over to the dashboard listener,
`DASHBOARD_API`, the end of `LAN_ONLY_FEATURES` and sessions that record `remote: true` — all kept
— and opened every app at `https://<tunnel host>/<path>/`, a private one for a remote session
(`privateAppAllowed` in the ingress). An adversarial review showed that the dashboard and every app
page were one origin: an app's script — from any app the admin opened, or a cross-site-scripting
bug in any public app page — could read the dashboard key, send requests carrying the admin's cookie
that passed the origin check (Origin and Host agreed, because they were the same site), and drive
the whole admin API — turn the root terminal on and open it, which is host root since the core holds
the Docker socket, or download a backup, which is every secret. The same was true of dev.13–dev.15
as published, for everything the remote dashboard offered then. The first cut was redesigned before
it was published. Besides the second address, the redesign added:

- **`__Host-omos_session`** for the remote dashboard, read only for a handed-over request;
- **per-app access tokens from one-use tickets**, so that what opens an app is a key to that app,
  never the dashboard's session (`system/app-access.ts`);
- **no platform cookie relayed to or set by an app** through the tunnel, `Service-Worker-Allowed`
  stripped, and nothing private left in Cloudflare's cache;
- **re-checks for connections that outlive their first check** — every protected tRPC call, every
  terminal keystroke, and `system/remote-sockets.ts`;
- **`claimsDashboardSocket` requiring every spelling** rather than any. A review found the cost of
  *any*: `/<private app>/../trpc` resolved to `/trpc` and was claimed and answered, while
  `/<private app>` with no such suffix was destroyed — so the answer told a stranger which apps
  were installed. A declined app socket now also takes the same path as an address with nothing at
  it;
- **`registerHandoffOnlyGuard`**, so a tunnel pointed at port 443 cannot walk round the gate;
- **the body limits** (Part 2, *What a stranger can make the box read*);
- **the remote-restore rule** and **the early backup headers**;
- **the second-factor epoch** and **the emailed-code binding**;
- **`placeRoute` and the `setAppPath` check**, now that private apps are in the routing table too.

## What changed in the redesign before it was published

These were found in the two-hostname design and fixed in the same build, before dev.16 was
published:

- **A refused save had already changed things.** `cloudflare.save` wrote the apps' address before
  checking the dashboard address; it now checks everything, then writes once, and refuses any
  change to the dashboard address from outside. The UI disables that field from outside, sends it
  only when edited, and refreshes its status after a refusal. Turning remote access off, turning
  remote administration off and removing the tunnel ask first when done from outside.
- **A restore check that disagreed with the box.** The restore's hand-written copy of the "door
  open" rule missed the equal-hostnames case; `settingsOpenTheDoor` is now the one rule, used by
  both. `sameSecondFactorAs` now requires an authenticator on both sides.
- **The restoring admin was signed out mid-restore** by a backup holding an older epoch — hence
  `holdSecondFactorEpoch`. And the restore window claimed *Restore complete.* even for a refused
  restore — hence `RestoreOutcome` and its close codes.
- **A cancelled remote backup download blocked every later backup** until a restart — hence the
  early `close` listener, and a leaving browser ending tar.
- **A race could reopen the door behind an admin turning two-step sign-in off** — hence the
  CONFLICT check in `requireSudo`. **Emailed codes could be the only factor** — `setEmailFactor` now
  requires an authenticator.
- **An app could claim the whole apps hostname** with a service worker served at its bare address —
  hence, first, a 308 to `/<path>/` (see the next list for what replaced it). **A private app's
  path answered differently from an empty one** to a malformed POST — hence declining it first.
  **Token checks could be bought per request** — hence `MAX_TOKEN_CANDIDATES` and the memoised
  handle.
- **Two apps could share an address**: an app could be given `/api`, and an install could take an
  address another app already had — hence `RESERVED_PATH_SEGMENTS` and `addressForNewApp`.
- ***Recently turned away* said "Local network only" for two things an admin can fix** — a box
  with no dashboard address yet, and a tunnel hostname pointed at port 443. They are now
  `no-admin-host` and `wrong-port`, each with its own words.

A further review of the same build, still before it was published, found these:

- **"From outside" was read off a header.** Behind a reverse proxy at the masjid, which sends
  `X-Forwarded-Proto: https`, the dashboard called itself remote and sent every *Open* down the
  from-outside path, where it was refused. The dashboard's from-outside behaviour now follows the
  front door's hand-over, and only the security rules keep the header (Part 2, *How a request from
  outside is decided*).
- **The tunnel token could be replaced from outside, or saved half-copied**, though saving one
  recreates the connection a remote request came through and a bad one connected nowhere while
  the log said the tunnel was running. A different token is now refused from outside, and a paste
  that is not a whole token everywhere.
- **The redirect at an app's bare address looped for ever** for an app that sends `/<path>/` back
  to `/<path>` — Next.js with a base path does, by default — taking its public page down. Now only
  a worker's script is refused there, and nothing answered there is cacheable.
- **A stranger could hold dashboard sockets open** and send them messages of up to 100 MB, because
  the sign-in page opened one and the front door handed one over to anybody. The dashboard's
  socket now opens only while something is subscribed, the front door hands one over only to a
  signed-in remote session, messages are capped at 1 MiB, and at most 200 sockets are tracked.
- **An app's live connection outlived the sign-in that opened it**: it is now tracked and closed
  with the rest.
- **Every restore put the box back on whatever build the installer had last pulled** — usually
  the one it was first installed with, and from outside one with no remote dashboard. It now comes
  back on the build it is running.
- **A backup with nothing usable in it stopped every app** and was reported as "Nothing was
  changed"; it is now noticed before any app is stopped. **A restore that lost app data said
  *Restore complete.***; it now says otherwise (`restarting-with-problems`).
- **A sign-in completed during a restore was bound to the restored file's epoch** and refused at
  once, and **releasing the hold handed back the backup's epoch**, bringing back sessions shut out
  since. Sign-ins during a restore are now bound to the held epoch, and the restore renews it and
  keeps only its own admin.
- **A backup that tar had failed downloaded as a whole, clean file**, at the masjid and from
  outside alike. The download now ends only on tar's success.
- **Losing the phone and the backup codes left no way to remove two-step sign-in**, short of
  working on the server's files by hand. The installer's *Reset sign-in* can now turn it off.
- **`X-Forwarded-Prefix` reached apps as the visitor typed it**; it is stripped now.
- **A claim was stronger than the code.** The emailed-code binding was described as what keeps a
  password-only session at the masjid from becoming a remote one. It never was: such a session
  could always download a backup, which holds the authenticator's secret. The binding keeps
  emailed codes going where the admin switched them on, and the text now says only that (Part 2,
  *Second factors*; Part 1, *Honest limits*).
- Smaller: uploads over 100 MB from outside are refused up front with a sentence instead of
  failing on Cloudflare's own page, and turning two-step sign-in off from outside now says that it
  shuts that window out.

A review of those fixes, still before the build was published, found five more:

- **Closing an app's live connection closed only the browser's end.** The connection to the app
  stayed open, held by the core, until the app noticed for itself. Both ends close now
  (`closeTogether`, shared by the ingress and the per-app HTTPS proxy).
- **A worker's script refused at the masjid was listed in *Recently turned away*** as though it
  had come in from outside. It is still refused there, but the list keeps only what came through
  the tunnel.
- **A change to two-step sign-in made during a restore signed its maker out** from outside the
  moment the restore let go of the epoch. Nothing about the factor can be changed during a restore
  now.
- **Going back to Stable from outside cut the admin off.** Stable has no remote dashboard, so the
  update that follows the switch brought the core back without one, and every window from outside
  stayed dead until someone at the masjid moved the box on. From outside, the switch and any
  update to such a version are now refused (Part 2, *Updates from outside*).
- **The update window waited for a restart that was not coming.** An update that changed nothing
  — already up to date, a failed download, a refusal — sat on "restarting…" for three minutes and
  then said *Update applied.* It is now told how the update ended, and a refusal says why.

A third review, of the whole build and still before it was published, found these:

- **A tunnel token copied without its final `=` was saved as it was**, and the tunnel never came
  back: cloudflared refuses such a token, and a double-click selects all of a token but that. The
  padding is now put back, only a token cloudflared will read is kept, and a tunnel stuck
  restarting no longer shows as *Tunnel is running.*
- **An update pressed during a restore cut the restore off.** Its helper replaced OpenMasjidOS
  while the restore was still putting app data back, and every app was left stopped. An update of
  OpenMasjidOS, a restore and app updates now never overlap.
- **The windows still guessed.** An app's update window said it was up to date however the update
  had ended; *Update all* and the channel switch counted every app as done, and the channel switch
  said OpenMasjidOS was being updated after that step had been refused; and the OpenMasjidOS update
  window said *Update applied.* after three minutes over an update still downloading or one that
  had failed. Each window now says how its work ended, and the update window says "updated" only
  when it has seen the restart.
- **What a restore could not do was forgotten** soon after, when the restart signed everyone out
  — and apps it could not start counted as success. A restore now says which apps did not start
  as well as which lost their data, keeps the list, and the dashboard shows it after the next
  sign-in. A restore whose last restart could not be started is told apart from one that stopped
  part-way.
- **A restore could still come back on another build**, because the compose file it restarts from
  could name one OpenMasjidOS had never run — after an update whose helper did not start, or after
  the installer's Update had written it before a download that failed. The restore now pins that
  file to the running build; a failed update puts the file back; the installer downloads first.
- **Two-step sign-in could still be changed early in a restore**, only to be overwritten by the
  backup's a moment later, and **the restorer's session was carried onto the renewed epoch even
  when it had been shut out meanwhile**. Nothing about two-step sign-in can be changed while a
  restore runs now, and only a session that still counts is carried.
- **A remote terminal closed itself in any pause**, because Cloudflare drops a connection that
  carries nothing for about 100 seconds; whatever was running in it was left where nobody could get
  back to it. Every dashboard connection is now pinged every 30 seconds.
- **A sign-in through a reverse proxy at the masjid could be used from the internet** — not by the
  admin, but by any app opened from that page, which receives the cookie it is kept in and can work
  out an access token for every app from it. Such a sign-in now works only through that proxy.
- **One app could fill the table of connections from outside**, after which no terminal, update
  or restore could start from outside, on any device. Apps may now hold at most 150 of its 200
  places.
- **Refusing a worker's script at a bare address did not remove one already installed**: a browser
  keeps a worker whose update check fails, and every published build let an app install one over
  the whole apps' address. A worker's script asked for at a bare address now gets one that removes
  itself.
- Smaller: a browser leaving part-way now ends the app's HTTP response too, rather than holding the
  app's connection open; only an address shaped like an app's path is ever routed, so a stack
  started by hand as `omos-_omos` can no longer take `/_omos`, the address *Open* uses; and the
  two-step panel says when emailed codes are waiting for an email address on the account rather
  than for an email provider.

### Verified against the real daemon (dev.16)

Measured on dev.16 before it was published, against the real built daemon, with a stand-in for
Docker reporting two apps — `notes`, not shared online, and `board`, shared — small app servers
behind them, requests carrying the headers Cloudflare adds, and a real sign-in from outside with a
real authenticator code:

```
sign-in on the apps' address                  404
sign-in on the dashboard address              password, then a code: __Host-omos_session,
                                              Secure, Path=/, no Domain
that session's auth.me: dashboard | apps'     signed in | 404
the LAN session at the dashboard address      signed out
the dashboard's own port, with cf-ray         404
notes/: no token | the dashboard's cookie     404 | 404
board/ | board/ at the dashboard address      200 | 404
a LAN cookie sent to board/                   removed: board received only theme=dark
bare /board?x=1                               200, cache-control: private, no-store
notes vs an empty address                     404 vs 404; broken POST 400 vs 400; 1.2 MB 413 vs 413
Open notes                                    303 to /notes/ with omos_session=a1.…; Path=/notes;
                                              Secure; HttpOnly
  the same link again | spent at dashboard    410 | 404
  the notes token at board/                   board received no cookie
  notes setting omos_session, and             both removed; its own cookie kept
    Service-Worker-Allowed: /
  single sign-on on it: notes | board         signed in | not
  WebSocket to notes/: token | none           relayed with the token | ended
a stranger's 100 KB body: declared | chunked  413 | 413
multipart to /trpc                            415
restore from outside, an older backup         closed 4001, "This backup would switch off …"
backup download from outside                  200 application/gzip at once
from outside: moving the dashboard address    FORBIDDEN, nothing written
  …or clearing it                             FORBIDDEN, nothing written
from outside: a new tunnel token              FORBIDDEN, nothing written
a reverse proxy at the masjid                 asks for a code; auth.me not remote; Open FORBIDDEN
  its session at the dashboard address        signed out; a token worked out from it: 404
remote administration off, at the masjid      a live socket from outside closed in 1.5 s
update from outside, Stable's newest 0.51.1   closed 4001, "Version 0.51.1 can't be managed …"
switch to Stable from outside                 FORBIDDEN; once Stable was 0.51.2, allowed
a worker's script at a bare address           the same self-removing worker: shared, private,
                                              empty, at the masjid
a quiet remote socket                         pinged after 17 s
a token pasted without its "="                saved with it
new backup codes, at the masjid               remote session and notes token refused; LAN
                                              session kept; the admin's notes/ socket closed
                                              at both ends in 1.5 s; board/'s left open
```

## The review after that run

A review of the build after the run above, still before it was published, found nine more
problems, all around updates and restores. Each was fixed in the same build:

- **An app could be started during a restore** — from the dashboard, over WhatsApp (`!os start`,
  `!os restart`) or by the platform's own re-ups — over a database still being put back, and with
  a compose that had come in with the backup and not yet been checked: a `privileged: true` stack
  in a backup could have run with nobody agreeing to it. And starting an app during its own update
  brought up the compose the update was about to put back. Now no app is started, restarted,
  installed or removed under a restore or its own update, and every restored compose is checked
  the moment it is in place.
- **Changes made during a restore were undone.** A new password, or managing from outside switched
  off, came back as they had been after the restart; a theme changed mid-restore brought the root
  terminal back on. Now nothing but turning an app off, or opening one from outside, can be done
  from the dashboard while a restore runs, and the restored settings are put in place at once.
- **A dropped connection read as a finished restore**: the restore window said *Restore complete.*
  after a restart it had lost touch with. It now says it lost touch.
- **An app Docker would not pause was reported as paused**, and its data put back under it. It is
  now named in the window and on the dashboard.
- **A restore refused because an update was under way left the uploaded backup on the box** —
  every secret, unencrypted. It is deleted now; the upload is refused before it is read; what a
  power cut leaves behind is removed at the next start; and the File Explorer keeps both private.
- **"Has stopped" alerts for the apps a restore had paused**, telling the admin to press Start over
  data still being put back. The alerts stand aside during a restore, and so does the off-site
  backup.
- **The one-at-a-time rule ended about 12 seconds early**: at the hand-off, not at the restart, and
  work accepted in that gap was cut off by the restart — three updaters at once, or a restore cut
  off with one app's data half put back and every app left stopped. It now lasts until the restart
  (five minutes at most), and says *OpenMasjidOS is restarting to finish …* meanwhile.
- **One failed check read as a restart** in the update and restore windows — the update window
  could stay locked for three minutes and then claim a restart that never happened — and **a core
  pinned to one exact build was "updated" onto that same build** at every press, signing everyone
  out. Both windows now wait for two failures in a row, and the pinned core is refused.
- Smaller: Settings → Remote access says *Tunnel is turned on but isn't connecting…* rather than
  *Tunnel is set up but turned off.* for a tunnel that is on but not up, and the log says
  *Cloudflare tunnel started.* rather than claiming it is running; the installer's Update and
  Repair end with an `https://` address, where the `http://` one worked only through the redirect;
  the dashboard's restore report no longer says apps "started with" what was on the machine; and
  *Recently turned away* says what is done with a worker asked for at a bare address.

Each fix has a test in `packages/core/test/` — in `update-lock`, *A CORE UPDATE OR A RESTORE KEEPS
ITS LOCK UNTIL THE CORE IS REPLACED — not just until it hands that job over* and *NO APP IS STARTED,
INSTALLED OR REMOVED UNDER A RESTORE OR ITS OWN UPDATE — stopping never is*; in `remote-restore`,
*A RESTORE THAT RESTARTS THE CORE KEEPS ITS LOCK UNTIL THE CORE IS REPLACED*, *A RESTORE REFUSED FOR
AN UPDATE IN ITS WAY SAYS SO, AND LEAVES NO BACKUP BEHIND*, *NOTHING IS CHANGED FROM THE DASHBOARD
WHILE A RESTORE RUNS — looking is fine*, *A RESTORE PUTS ITS SETTINGS IN PLACE AT ONCE — not at the
next restart*, *AN APP THAT COULD NOT BE PAUSED IS NOT "COMPLETE" — its data may not have gone back
cleanly*, *WHAT AN UNFINISHED RESTORE LEFT BEHIND IS REMOVED AT BOOT*, *NEITHER THE OFFLINE ALERTS
NOR THE OFF-SITE BACKUP RUN WHILE A RESTORE DOES* and *A RESTORED APP'S COMPOSE IS CHECKED THE
MOMENT IT IS IN PLACE — not after its data is back*; in `remote-update`, *A CORE PINNED TO ONE
EXACT BUILD IS NOT "UPDATED" ONTO THAT SAME BUILD, AGAIN AND AGAIN*, with *the update window is told
whether anything changed — and waits only for a restart* extended to the two-failure rule in both
windows and the restore window's lost-touch ending; in `files-guard`, *a backup waiting to be
restored, and its unpacked copy, are private*; and in `remote-settings`, *a tunnel stuck restarting
on a refused token is not shown as running*, extended to the line Settings shows. A mutation run
then broke these fixes one at a time, 51 ways, each test file passing first: a test failed for
all 51.

### Verified against the real daemon (after that review)

Measured against the real built daemon, at the masjid's own address only — no request through the
tunnel — with a stand-in for Docker's API reporting two apps, `notes` and `board`, and a stand-in
`docker` command whose refill of an app's data takes 8 seconds and which refuses to stop `board`.
There was no real Docker, Cloudflare or browser. The run was made after the *restarting to
finish* wording was added:

```
a core pinned to a digest: update, a newer        closed 4001, "OpenMasjidOS is pinned to one
  build out                                       exact build …"; nothing asked of docker
mid-restore, while data is being put back:
  Start notes | a setting | a new password        CONFLICT, "A backup is being restored right
                                                  now. Please try this again …"
  remove the logo | upload a second backup        409, the same | 409, "A restore is already
                                                  running. …"
  auth.me                                         answered: signed in
  compose up, restart or start                    none ran
the restore, with board refusing to pause         closed 4003; "Board (couldn't pause it — its
                                                  data may not restore cleanly)"
  the report after sign-in                        appsNotPaused: ["Board"]
  the setting the backup holds                    in use at once, and on disk
  the password refused mid-restore                the one from before still signs in
  .restore* files left                            none
after the hand-off, before the restart:
  an OpenMasjidOS update | Start notes |          4001 | CONFLICT | 409, each "OpenMasjidOS is
  the next upload                                 restarting to finish restoring your backup. …"
a .restore.tar.gz and .restore-staging, then      both removed at boot, each with "Removed …
  a restart                                       left behind by a restore that did not finish."
```
