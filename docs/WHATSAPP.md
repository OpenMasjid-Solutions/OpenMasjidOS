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

1. **Install OpenWA** from the App Store. During install you set an **API key** and a
   **session name**; keep both.
2. **Settings → WhatsApp**: choose OpenWA as the gateway, paste the same API key and
   session name. Leave *Gateway address* empty — the platform finds an App Store install
   automatically on `127.0.0.1` at its published port. Fill the address in only if OpenWA
   runs on a different machine.
3. **Link your phone.** Enter the number to send *from*, press **Get a code**, then on
   that phone open WhatsApp → *Settings → Linked devices → Link with phone number* and
   type the code. A pairing code is used rather than a QR because a masjid's server is
   usually headless and the admin is usually not standing next to it.
4. **Settings → Account**: set your own **WhatsApp number**. That is where OS alerts go
   and where **Send test message** sends. It is a destination only — never a sign-in.
5. **Settings → Alerts**: switch on the WhatsApp column for the alerts you want. It is
   **off by default** for every alert, deliberately: configuring a gateway should not
   start messaging phones on its own.

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

| What you see | What it means |
|---|---|
| *Cannot reach the gateway* | OpenWA is not installed, not running, or the address is wrong |
| *No phone is linked yet* | The gateway is up; finish step 3 |
| Messages queue but never arrive | Check quiet hours and the caps in Settings; the panel shows how many are waiting |
| *That number is not on WhatsApp* | The recipient's number has no WhatsApp account — the platform refuses rather than sending, because that is a ban signal |
| A test message works but alerts don't | The alert's WhatsApp column is off in Settings → Alerts, or your Account number is empty |
