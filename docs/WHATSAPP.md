<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# WhatsApp notifications (OpenWA)

OpenMasjidOS can send alerts and app messages over WhatsApp, through
[OpenWA](https://github.com/rmyndharis/OpenWA) — a self-hosted, MIT-licensed WhatsApp API
gateway that the masjid installs from the App Store and runs on its own server. No message
ever leaves the masjid's network to a third-party sending service.

> ## Read this before linking a phone
>
> **WhatsApp does not officially permit this, and the number you link can be restricted or
> blocked.** OpenWA speaks to WhatsApp through a reverse-engineered client, not Meta's
> official Cloud API. OpenWA's own README states the risk plainly and so does this
> document: *there is no way to reduce it to zero.*
>
> - **Use a spare number the masjid keeps for this.** Never a volunteer's personal phone,
>   and never the masjid's main published line. If the number is blocked you must be able
>   to shrug and link another.
> - **Never make anything critical depend on it.** Email stays configured and stays the
>   fallback. Nothing that gates access — a login code, a password reset — may go this way.
> - **It is not instant.** Messages are paced to look human (below), so delivery is
>   seconds to minutes away — and if the hourly or daily cap is already spent, longer.
>   There is no time-of-day hold; see "No quiet hours" below.

## Setting it up

Everything happens in **Settings → WhatsApp**. Until you switch it on there, the gateway
app is not in the App Store and WhatsApp does not exist anywhere in OpenMasjidOS.

1. **Switch on “Send messages over WhatsApp.”** A warning appears first, explaining that
   this uses an unofficial client and that the number can be restricted. Accepting it
   turns the feature on and makes the gateway installable.
2. **Install the gateway.** The panel offers **Install the gateway**, which takes you
   straight to OpenWA's install questions. Set an **API key** there and keep it.
3. **Paste that same API key** back in Settings → WhatsApp (it is the `OPENWA_API_KEY`
   setting, which OpenWA reads as `API_MASTER_KEY`). Leave *Gateway address* empty — an
   App Store install is found automatically at its published port. Fill it in only if
   OpenWA runs on a different machine.

   > **The key is only read on OpenWA’s first boot.** Changing it here later does not
   > rotate the gateway’s key — reinstall OpenWA if you need to change it.

4. **Link your phone — here, not in OpenWA.** Choose the country, type the number to send
   *from*, press **Get a code**, then on that phone open WhatsApp → *Settings → Linked
   devices → Link with phone number* and type the code. A pairing code is used rather
   than a QR because a masjid's server is usually headless and the admin is usually not
   standing next to it.
5. **Settings → Account**: set your own **WhatsApp number**. That is where OS alerts go
   and where **Send test message** sends. It is a destination only — never a sign-in.
6. **Settings → Alerts**: switch on the WhatsApp column for the alerts you want. It is
   **off by default** for every alert, deliberately: configuring a gateway should not
   start messaging phones on its own.

   > **That column covers OpenMasjidOS's own alerts only** — an app going offline, an
   > update, a disputed payment. Each app's rows say *"Set up in the app"*, because an
   > app messaging over WhatsApp is reaching a parent or a donor, not you, and only the
   > app knows who those people are. It still sends through this gateway and this queue.

### Why OpenWA is hidden, and when to open it

OpenWA does not appear on your dashboard or in the dock, and the only button that opens
it is in Settings → WhatsApp. That is deliberate. OpenMasjidOS **owns the connection**: it
creates the session, starts it, requests the pairing code, and sends every message through
one paced queue — which is the entire defence against the number being banned.

- **Never link a phone in OpenWA's own interface.** OpenMasjidOS would not know about that
  session, and you can end up with two connections fighting over one number.
- **Never send from OpenWA directly.** It bypasses the pacing, which is the one thing
  keeping the number safe.
- **Do open it to read or reply to chats** if someone answers a message. That is what it
  is good for, and it changes nothing the platform relies on.

You never enter a session id anywhere. OpenWA mints one as a UUID and its API accepts only
a name, so OpenMasjidOS creates and starts the session for you the first time you link.

## Groups

**One message to a group reaches everyone in it.** For an announcement — "madrasa is closed
tomorrow" — that is enormously better than messaging 200 parents one at a time: it is a single
outbound message rather than 200 paced over hours, and messaging many individuals is the
riskiest thing this number can do.

**Settings → WhatsApp → Groups → Find my groups**, then approve the ones apps may post into. Give each one a **nickname** — that is the name apps see, and the only one they see. A group called "MASJID GRP 2 (new)" in WhatsApp can be "Parents — Hifz" here, and renaming it never touches the group itself. Each approved group also shows its **id**: the value apps send to, and the one that turns up in their logs.
Approval is the point: OpenWA can see *every* group the linked phone is in — personal ones
included — and apps are only ever shown the ones you approve.

Before you approve one, two things that are easy to discover the hard way:

- **Everyone in a WhatsApp group can see every other member's phone number.** For a madrasa
  that means every family's number is visible to every other family.
- **Unless the group is set to "only admins can send"** in WhatsApp, any member can reply to
  everyone. A fee notice to 200 people can turn into 200 replies. Set it in WhatsApp →
  group → *Group settings → Send messages → Only admins*. You must be an admin of the group
  to post into it once it is announcement-only.

**Never add people to a group yourself.** OpenMasjidOS will not do it, and neither should you:
adding someone who did not ask is both the fastest route to a banned number and a complaint
waiting to happen. Share a join link and let people join.

Group posts have their own, tighter budget — **4 an hour, 10 a day** by default, separate from
individual messages, so an announcement never eats the allowance fee reminders need, and neither
starves the other.

### WhatsApp Communities and Channels

- **Communities**: a Community's *announcement group* is an ordinary group, so if the masjid's
  number is an admin of it, approve it here and post to it like any other.
- **Channels (Newsletters)**: **not possible.** OpenWA can list, read, create and subscribe to
  Channels, but it has no endpoint to post a message to one. There is nothing to enable — it is
  absent from the gateway, not switched off in OpenMasjidOS.

## Running things by message (commands)

**Settings → WhatsApp → Commands**, off by default. Turn it on, add the people you trust, and
tick what each of them may do. Then they can message the masjid's number:

```
!help                 what you're allowed to do
!os stats             how the server is doing
!os apps              what's installed, and what's running
!os updates           which apps have an update waiting
!os restart 2         restart the second app in that list
!display              what the Notice Board app can do
!display 2 Jumu'ah is at 1:30    run its second command, with your message
```

Anything that changes something asks first:

```
Restart "Prayer Times"?
It will be unavailable for a moment.

Reply  !yes K7QM  to go ahead.
Ignore this to cancel. It expires in 90 seconds.
```

The code is not about proving who you are — you already had to be on the list to get here. It
is about making sure the *right* message runs: a code has to be read off that exact prompt,
where "yes" gets typed reflexively at a stale question, a forwarded screenshot, or the wrong
one of two prompts.

That is why `!yes CODE` is always accepted, and is the only thing that works when nothing
else is going on. **While the platform is actually waiting on you**, a plain `yes` or `no` is
enough as well — at that moment there is exactly one question open and you were just asked
it, so the ambiguity the code guards against cannot arise. If you ignore a prompt it lapses
after 90 seconds and your ordinary messages go back to being ordinary messages.

Some commands ask you a question or two. While one is waiting, just reply normally —
no `!` needed — and send `exit` if you change your mind:

```
!display schedule-iqamah
  Which prayer?
Maghrib
  What time, and from when?
7:15pm, starting Friday
  Done. Maghrib iqamah is 7:15pm from Fri 22 Aug.
```

That is the only time the `!` is optional, and it lapses on its own after a few
minutes' silence, so an abandoned half-answered question never leaves your ordinary
messages being read as input. Starting any new `!` command abandons it too. While
something is waiting, a plain `yes` or `no` is enough to confirm.

**Things worth knowing before you switch it on**

- **Anyone holding one of those phones can do these things.** There is no password step. If a
  phone is lost or a number changes hands, remove it here immediately.
- **Every command must start with `!`.** Ordinary conversation with the masjid's number is
  completely untouched — not read as a command, not logged, not replied to.
- **Only one-to-one chats.** A command sent in a group does nothing at all, ever. Otherwise
  every member of an announcement group would have the restart button.
- **A number that is not on the list gets no reply whatsoever.** Not even "you're not allowed".
  Answering would tell a stranger this number runs your server, and would spend the sending
  allowance your fee reminders need.
- **Anything that changes something is also emailed to you** (Settings → Alerts → "Something was
  changed from WhatsApp"). There is one admin account, so this is your record of who did what.
- Replies are in English, whatever your dashboard language — the same limitation the alert
  emails have today.

**What is deliberately not offered**, and will not be: restarting the machine itself, reading
app logs (they contain passwords and personal data, and a chat keeps a copy forever), updating
OpenMasjidOS itself (it would replace the very thing holding the conversation, so it could never
tell you it worked), and removing an app. Updating a single *app* is fine and is offered — only
that app restarts. The WhatsApp gateway app itself is refused for the same reason as the OS.

## How sending behaves, and why

Ban risk attaches to the **phone number**, not to whichever app had something to say. If
two apps each send "politely" at the same moment, the number still emits a burst — WhatsApp
sees a number, not our request boundaries. So the platform owns a **single serialised
queue** that every sender shares: OS alerts and every app's Fabric call alike. Nothing is
ever in flight concurrently.

For the same reason OpenWA's `send-bulk` is deliberately unused: it paces *within one
request*, which does nothing about two requests overlapping.

| Behaviour | Default | Why |
|---|---|---|
| Serialised sending | always | One message in flight, ever |
| Gap between messages | 6–20s, randomised | A fixed interval is itself a fingerprint |
| Typing indicator | scaled to message length | People take longer over longer messages |
| Presence | online while working, offline when idle | A permanently-online number that never reads anything looks like what it is |
| Per-recipient cooldown | 60s | One person is never hammered, even by several apps |
| Rate caps (individuals) | **none** | Removed in v0.51.1 — see below |
| Rate caps (groups) | 4/hour, 10/day | One post reaches everyone, so overuse costs the recipients, not the sender |
| Warm-up ramp | 7 days | Applies to the GROUP caps. A freshly linked number is watched hardest |
| Number validation | before first contact | Messaging numbers not on WhatsApp is a documented ban signal |

### No rate cap on individual messages (removed in v0.51.1)

There is **no hourly or daily ceiling** on messages to individuals. The brake is spacing: the
randomised 6–20s gap between sends, plus the 60-second per-recipient cooldown.

The caps were 12/hour and 60/day, but the warm-up ramp quartered them on a newly linked
number — so a masjid that had just set WhatsApp up got **3 messages an hour**, and command
replies spent the same allowance. That is not a safety margin, it is an outage: it blocked
ordinary use and even blocked testing the feature. And the pattern it was aimed at — a
masjid messaging parents one at a time — is not the pattern that gets a number banned.

**The trade-off, stated plainly because it is not the admin's mistake if it bites.** The
queue is shared by every app, so an app looping over 200 parents will now send all 200 —
spaced out, but unbounded. Ban risk attaches to the **number**, and a ban is terminal: you
do not get to be more careful afterwards. If a ceiling is ever needed again it belongs on
this shared queue, not in each app, because a per-app limiter cannot see the number's total
traffic.

**Groups keep their caps** (4/hour, 10/day, 30-minute cooldown, warm-up ramp applied). One
group message reaches every member, so overuse there costs two hundred people who did not
choose it — which is a different thing from an over-eager fee run.

### No quiet hours (removed in v0.51.1)

There used to be a 21:00–07:00 window in which the queue held everything. It is **gone**:
no window, no setting, no held-until-morning state. A message handed to the queue is paced
and sent, whatever the hour.

Two reasons, and the second is why it was actively harmful rather than merely debatable.

**It applied to every message, and the queue is shared.** The OS and every installed app
send through one queue, and there is no per-message urgency flag — so a window that holds a
parent's receipt until morning (fine) also holds a staff alert about a declined card, an
autopay that switched itself off, or a lockout (not fine). Those reach a treasurer's phone
at nine on a Sunday evening *precisely because* they will not reach their inbox. Holding
them removes the reason staff carry a number at all.

**It was evaluated in the wrong timezone.** The check used the container's local hour, and
nothing sets `TZ` — not the compose file, not the Dockerfile, not the installer — so that
hour is **UTC**. The documented "21:00–07:00" therefore fell at **17:00–03:00** for a US
Eastern masjid: an afternoon test looked fine, an evening one was held until three in the
morning. Anything else time-of-day dependent would have had the same bug, which is why the
pacer is now clock-agnostic beyond "now" as an instant, and a test fails the build if
`getHours()` reappears in it.

Rejected alternatives, so they are not re-proposed: a per-message `urgent` flag (every app
decides its own messages are urgent) and a per-recipient-kind window (the queue would have
to know what a recipient *is*, which it deliberately does not). **Quiet time belongs to the
sender**, which knows whether it is messaging a parent or a treasurer.

### The queue is durable (v0.51.1)

Queued messages, the pacing history and recent outcomes are written to
`config/whatsapp-queue.json` (0600 — a message body routinely carries a child's name and a
family's fees).

Before this, the queue was memory only. Anything the pacer was holding — for a cap, for the
warm-up ramp, or for the old quiet-hours window — was destroyed by a container restart,
**silently**: the caller had been told `202 {queued:true}`, and there was nothing anywhere
to contradict it. On a Development-channel box, which restarts often, that is how a masjid
went more than 24 hours with every message accepted and none delivered, no error in any log.

The pacing history is persisted for a second reason: it is the ban-risk budget. If the send
history emptied on every boot then the hourly and daily caps were not really caps, and a box
in a restart loop could send its daily allowance many times over.

Two bounds worth knowing: a message held longer than **24 hours** is dropped rather than
sent on load (releasing a day's backlog at once is the burst most likely to get a number
restricted, and a day-old fee reminder is not the message anyone wanted), and it is recorded
as `expired` so an app that asks gets a real answer. A damaged store file degrades to empty
rather than stopping the daemon.

The remaining limits are editable in Settings, within **hard bounds** the platform enforces.
The bounds are a range, not a one-way ratchet — group caps can be raised as well as lowered
(up to 20/hour and 50/day) but never past those ceilings; the gap can never go below
**3 seconds**, with jitter always applied; and the per-recipient cooldown can be set to zero
but the gap still separates every send. The defaults are deliberately well inside the bounds.

## For app authors

**Own your own settings.** The platform's alerts matrix has no WhatsApp column for your
app, on purpose: it routes to the admin's one number, and your messages are for parents,
donors and teachers. Which events go out over WhatsApp, and to whom, is a setting in
*your* app. What you do NOT own is the sending — that stays with the platform, so one
paced queue protects the masjid's number no matter how many apps are installed.

Declare the capability in your manifest:

```yaml
whatsapp: true
```

Then, server-to-server from your app's backend:

```http
POST /api/fabric/whatsapp
X-OpenMasjid-App-Secret: <your per-app secret>
Content-Type: application/json

{ "to": "+15550101234", "text": "Assalamu alaykum — this term's fees are now due." }
```

Response `202 Accepted`:

```json
{ "queued": true }
```

Before offering WhatsApp in your own settings, ask whether this masjid can use it —
otherwise your switch looks available on every install and fails only when a real message
was due:

```http
GET /api/fabric/whatsapp
X-OpenMasjid-App-Secret: <your per-app secret>
```

```json
{ "available": true, "reason": "ready", "media": true, "maxMediaBytes": 2097152 }
```

`reason` is one of four words, each with a different thing to tell the admin:

| `reason` | What to say |
|---|---|
| `ready` | Nothing — offer the feature |
| `not-configured` | "WhatsApp isn't set up on this server yet — an admin can add it in OpenMasjidOS → Settings → WhatsApp." |
| `not-linked` | "WhatsApp is set up but no phone is linked yet." |
| `unreachable` | "The WhatsApp gateway isn't responding." |

`media` says whether you may send an **image**; `maxMediaBytes` is the cap. **Treat both as
absent-means-no** — an older platform omits them entirely, and reading absence as "yes" means
rendering a poster and base64-ing half a megabyte into a request that was never going to work.

You never learn the gateway's address, its key, or which number is linked.

### Sending an image

Add an optional `media` to the same call. `text` becomes the image's **caption**, and may be
omitted — a poster can speak for itself.

```json
{
  "group": "120363012345678901@g.us",
  "text": "Iqāmah times are changing from Monday, 1 June.",
  "media": {
    "data": "<base64, no data: prefix>",
    "mimeType": "image/png",
    "filename": "iqamah-change.png"
  }
}
```

| | |
|---|---|
| **Formats** | `image/png`, `image/jpeg`, `image/webp`. Images only — documents, video and audio are separate routes with different rules and are not supported here. |
| **Size** | **2 MB decoded.** The whole request, base64 included, is capped at 4 MB. A 1080×1350 poster is typically 150–400 KB, so this is ample. |
| **Caption** | **1024 characters** — a quarter of the plain-text limit, because that is the gateway's own cap. |
| **`filename`** | Optional, max 255 characters. Some clients show it when the image is saved. |
| **In flight** | At most **4 images may be queued at once.** The fifth is refused with a message saying so — retry once they have gone out. Queued bytes sit in memory (and are persisted, so they also occupy the queue file); a cap can hold them for a while, and on a Raspberry Pi an unbounded queue of posters is an out-of-memory kill that takes the whole dashboard with it. |

Failures, and what they mean:

| Status | Meaning |
|---|---|
| `202` | Queued, exactly as for text. Paced the same way — an image is a *more* conspicuous event than a sentence, not less, so it waits its turn. |
| `400` | Not an image, not valid base64, caption too long, or four images already waiting. Fix and retry. |
| `413` | Too large. The message names both caps. Retrying the same bytes cannot help. |
| `403` | Unapproved group, or your app has no `whatsapp` capability. |

**An image that cannot be sent is never downgraded to its caption.** If the gateway refuses it,
nothing is delivered — you will not find that a sentence went out in place of your poster and a
masjid believed the timetable had been published. Note the flip side: like every send here, you
were told `202` before delivery was attempted, so a gateway-side failure appears in the core's
log rather than in your response. `docker logs openmasjid-core | grep -i whatsapp` shows it, and
the line for an image failure says explicitly that the caption was not sent on its own.

To post an announcement to a group, first read the groups the admin approved for you:

```http
GET /api/fabric/whatsapp/groups
X-OpenMasjid-App-Secret: <your per-app secret>
```

```json
{ "groups": [{ "id": "120363012345678901@g.us", "label": "Parents — Hifz" }] }
```

Then send to one, using `group` in place of `to`:

```json
{ "group": "120363012345678901@g.us", "text": "Madrasa is closed tomorrow, in shaa Allah." }
```

- `label` is the admin's **nickname** for the group — show it as-is. It is chosen to mean something to the masjid, and the group's real WhatsApp subject is deliberately not sent to you.
- The list contains **only** groups the admin approved. You never see the masjid's other
  groups, and an id you did not get from this list is refused with `403`.
- The admin can withdraw approval at any time — treat an empty list as "no groups available"
  and hide the feature rather than erroring.
- **A group post is for genuine announcements.** Never use one to tell a family about their own
  fees: their business is not the other 199 members'.

Rules that are not negotiable:

- **`queued` is not `sent`.** You are told the message was accepted for later delivery.
  There is no delivery receipt from WhatsApp. Never build a flow that blocks on it — but you
  can now **ask what became of it**: the `202` carries an `id`, and
  `GET /api/fabric/whatsapp/status/<id>` answers `queued` / `sent` / `failed` / `expired`
  with a reason. Scoped to your own app’s messages.
- **Never anything auth-critical.** No login codes, no password resets, no one-time
  passwords. Use email, which has a real provider behind it.
- **One recipient per call.** The API shape is deliberate: think one parent at a time. The
  queue will pace a loop correctly, but a `to: []` array would invite exactly the
  cold-blast that gets numbers banned.
- **You never see the gateway.** No URL, no API key, no session. The platform holds them
  and does the sending, which is the only way the pacing can be enforced for everyone.
- **The admin can turn you off.** WhatsApp being configured does not mean it is enabled for
  your messages.
- **Recipients must expect to hear from you.** OpenWA's single most reliable route to a ban
  is a first-ever message to someone who never opted in. Send to parents who enrolled, not
  to a purchased list.

Every call is LAN-only (it sits under `/api/fabric`, so the tunnel guard refuses it),
rate-limited, and message bodies are never logged — they routinely carry a child's name and
a family's fees.

## Troubleshooting

Everything is done in **OpenMasjidOS → Settings → WhatsApp**. You never open OpenWA's own
interface — the platform creates the session and requests the pairing code for you. OpenWA
is only the engine.

If something is wrong, the status line under the panel names the reason, and
**Settings → WhatsApp → View OpenWA logs** shows the gateway's own log — some failures
(an engine that will not start) are only visible there. The core's log has the same
reason plus the address it tried:

```bash
docker logs --tail 200 openmasjid-core | grep -i whatsapp
```

| What you see | What it means |
|---|---|
| *Cannot reach the gateway — OpenWA is not installed* | Install it from the App Store |
| *Cannot reach the gateway — OpenWA is installed but not running* | Press **Start it** in Settings → WhatsApp. The gateway is deliberately kept off your dashboard and out of the dock, so that is the only Start button for it |
| *Cannot reach the gateway — nothing is listening at the gateway address* | OpenWA is up but not answering on the port it publishes; check its own log |
| *Cannot reach the gateway — the gateway address could not be found* | Only possible with a typed-in *Gateway address*; check the hostname |
| *The gateway rejected the API key* | Re-paste the key you set when installing OpenWA. Remember it is only read on OpenWA's **first** boot — if you changed it in Settings, reinstall OpenWA instead |
| *No connection created yet* | The gateway is up but nothing exists on it; pressing **Get a code** creates and starts it |
| *The gateway is still connecting* | The session was just started and its engine is not up yet. Wait a few seconds and press **Get a code** again |
| *A phone is already linked* | Unlink the current one in OpenWA (*Sessions → Logout*) before linking a different number |
| *This version of OpenWA doesn't support linking by code* | The gateway has no pairing-code endpoint. Update OpenWA |
| *WhatsApp has placed a restriction on this number* | The risk materialised. `reachout_timelock` still allows existing chats; `tos_block` means that number is finished — link a different one and lean on email |
| *No phone is linked yet* | The session exists and is waiting to be paired; finish step 3 |
| *The phone connection needs attention* | OpenWA reports `disconnected`, `action_required` or `failed` — link it again |
| Messages queue but never arrive | Check the caps in Settings — the panel shows how many are waiting. If the count sits still, poll `/api/fabric/whatsapp/status/<id>`: `failed` names the gateway’s reason. On anything before v0.51.1 this symptom was usually the platform’s fault, not yours — see “No quiet hours” and “The queue is durable” |
| A message was delayed a long time, then arrived | The gateway rate-limited or restarted. A transient failure is retried with a widening backoff (up to 5 attempts) rather than dropped |
| *That number is not on WhatsApp* | The recipient's number has no WhatsApp account — the platform refuses rather than sending, because that is a ban signal |
| A test message works but alerts don't | The alert's WhatsApp column is off in Settings → Alerts, or your Account number is empty |
