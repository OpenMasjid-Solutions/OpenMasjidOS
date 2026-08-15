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
>   seconds to minutes away, and inside quiet hours it is hours away.

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

**Settings → WhatsApp → Groups → Find my groups**, then approve the ones apps may post into.
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
starves the other. Quiet hours apply to groups too (more so: a 03:00 post wakes everyone).

### WhatsApp Communities and Channels

- **Communities**: a Community's *announcement group* is an ordinary group, so if the masjid's
  number is an admin of it, approve it here and post to it like any other.
- **Channels (Newsletters)**: **not possible.** OpenWA can list, read, create and subscribe to
  Channels, but it has no endpoint to post a message to one. There is nothing to enable — it is
  absent from the gateway, not switched off in OpenMasjidOS.

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
| Rate caps | 12/hour, 60/day | OpenWA calls "a few a minute" sustainable; a masjid needs far less |
| Warm-up ramp | 7 days | A freshly linked number is watched hardest |
| Quiet hours | 21:00–07:00 | Queued, never dropped. Also: a fee reminder at 03:00 is a complaint |
| Number validation | before first contact | Messaging numbers not on WhatsApp is a documented ban signal |

Limits are editable in Settings, and **clamped** so they can only be made stricter — a
config pasted from a bulk-sending tutorial cannot turn this into a blaster. The floor is a
3-second gap and some jitter, always.

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
{ "available": true, "reason": "ready" }
```

`reason` is one of four words, each with a different thing to tell the admin:

| `reason` | What to say |
|---|---|
| `ready` | Nothing — offer the feature |
| `not-configured` | "WhatsApp isn't set up on this server yet — an admin can add it in OpenMasjidOS → Settings → WhatsApp." |
| `not-linked` | "WhatsApp is set up but no phone is linked yet." |
| `unreachable` | "The WhatsApp gateway isn't responding." |

You never learn the gateway's address, its key, or which number is linked.

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

- The list contains **only** groups the admin approved. You never see the masjid's other
  groups, and an id you did not get from this list is refused with `403`.
- The admin can withdraw approval at any time — treat an empty list as "no groups available"
  and hide the feature rather than erroring.
- **A group post is for genuine announcements.** Never use one to tell a family about their own
  fees: their business is not the other 199 members'.

Rules that are not negotiable:

- **`queued` is not `sent`.** You are told the message was accepted for later delivery.
  There is no delivery receipt, and there may be hours of quiet hours in between. Never
  build a flow that blocks on it.
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
| *Cannot reach the gateway — OpenWA is installed but not running* | Start it from the dashboard |
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
| Messages queue but never arrive | Check quiet hours and the caps in Settings; the panel shows how many are waiting |
| A message was delayed a long time, then arrived | The gateway rate-limited or restarted. A transient failure is retried with a widening backoff (up to 5 attempts) rather than dropped |
| *That number is not on WhatsApp* | The recipient's number has no WhatsApp account — the platform refuses rather than sending, because that is a ban signal |
| A test message works but alerts don't | The alert's WhatsApp column is off in Settings → Alerts, or your Account number is empty |
