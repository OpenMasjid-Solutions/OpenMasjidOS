<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Remote administration over the tunnel — design and progress

**Status: in progress.** The second factor is built and wired into sign-in (`0.51.2-dev.10`). Nothing is exposed yet — the tunnel still refuses the dashboard exactly as
before. Slices 2–4 below are not written.

---

## What this deliberately breaks

`CLAUDE.md` §15 says, as the first line of the tunnel section:

> The Cloudflare tunnel exposes ONLY app paths. The dashboard, tRPC, and the secret-gated
> Fabric routes stay LAN-only.

This feature breaks the first half of that on purpose, at the masjid's explicit request, behind
a setting that is **off by default**. The second half does not move and must not:

**`/api/fabric/*` and `/api/auth/session` stay LAN-only, always, whatever this setting says.**
They carry each app's 256-bit Fabric secret and every configured Stripe live key. Exposing the
dashboard must not drag them along, and `registerFabricTunnelGuard` keeps running on both
listeners regardless of this feature's state.

When Slice 3 lands, §15 gets rewritten to say what is actually true — the same way the
`startApp` and Stripe bullets were corrected rather than left reading well and being wrong.

## Where it lives

The tunnel hostname is the masjid's own — `omos.example.com`. Apps already live at
`omos.example.com/<app-path>`, routed by first path segment. Remote administration takes the
**root**: `omos.example.com/` serves the dashboard when the setting is on, and 404s exactly as
today when it is off.

Apps keep their paths. An app path always wins over the dashboard, so turning this on cannot
take a masjid's donations page off the air.

## What has to be true

| | |
|---|---|
| **Off by default** | A masjid that never opens Settings is never exposed. |
| **Two factors, always, when on** | Password alone never grants a session. Enrolment is required *before* the setting can be turned on, not after. |
| **Fabric stays LAN-only** | See above. Not negotiable, not conditional. |
| **Real per-IP lockout over the tunnel** | See below — this is the one thing that gets *better*. |
| **A way back in** | Backup codes, and `install.sh` → *Reset sign-in*, which needs terminal access to the box. |

## The lockout, and why the tunnel is the easy case

The login lockout is currently **off by default**, and `trpc/routers/auth.ts` explains why:

> behind Docker's port publishing every LAN client is SNATed to the bridge-gateway IP, so a
> global lockout would let an attacker deny the real admin.

That objection does not apply to tunnel traffic. **Cloudflare sets `CF-Connecting-IP` at its
edge**, and a tunnel client cannot forge it — the same reasoning that makes `cf-ray` a usable
signal for `isViaTunnel`. So remote logins can have a genuine **per-IP** lockout, which is
strictly better than the global one, while LAN logins keep the existing delay-based defence
because there the header is absent and every client really does look identical.

The rule to hold: **`CF-Connecting-IP` is trusted only when `isViaTunnel` is already true.**
On the LAN it is an attacker-supplied header and must be ignored entirely. Trusting it
unconditionally would hand any LAN client a way to evade the counter by varying one header —
and `util/net.ts` already carries the note about why a source-address check cannot work here.

## The second factor applies to OUTSIDE connections only

Hasan's call, and the right one for a masjid: a volunteer on the masjid's own network must not
be locked out of the dashboard by a phone they left at home. So  demands a second factor
when  is true, and not otherwise.

**Be honest about what that buys.**  is sound for traffic that really came through
the tunnel — Cloudflare sets  at its edge and a client cannot strip it. It **cannot**
tell the LAN from the internet on a box whose ports 80/443 are directly reachable: a public-IP
VPS, or a router forwarding them. Such a request carries no Cloudflare headers and looks exactly
like the office laptop, so it would skip the second factor entirely. §15 already says this about
the LAN-only guard and  records why a source-address check cannot fix it (Docker
SNATs everything to the bridge gateway).

So this protects **the door being deliberately opened**. It is not a substitute for a firewall
on a directly-reachable host, and  has to keep saying so.

## Second factors

Two, both implemented in Slice 1:

- **An authenticator app (TOTP).** RFC 6238, hand-written against published vectors rather than
  taken from npm — see `auth/totp.ts` for why. Enrolment is two-step: a secret is minted as
  *pending* and only becomes active once a live code proves it, so an admin who scans a QR and
  closes the tab is not locked out by a factor they never had.
- **An emailed code.** Six digits, ten-minute life, single use, five wrong guesses burns it,
  and no more than one a minute — that last one is an email-bomb guard as much as a brute-force
  one. Needs a configured mail provider, so it cannot be the only factor on a masjid that has
  not set one up.

**Backup codes** are issued once at enrolment, shown once, stored hashed. Ten of them, ~50 bits
each.

**Replay is the property that makes it a second factor.** A TOTP step is spent when it is used,
including the step that completed enrolment, so a code read off a shared screen or captured by
a phishing page is dead the moment it is used once. `test/twofactor.test.ts` pins this from
both directions — an old step is refused, and the *next* step still works so the guard cannot
freeze the account.

## Plan

| # | Slice | State |
|---|---|---|
| 1 | TOTP + emailed codes + enrolment state, with the replay guard | ✅ `dev.9` |
| 2 | The second factor wired into login, tunnel-only | ✅ `dev.10` |
| 3 | The exposure itself: serve the dashboard on the front door behind the setting, per-IP lockout, rewrite §15 | ⬜ |
| 4 | Settings UI: enrolment, backup codes, the on/off switch and its warnings | ⬜ |

Slice 3 is the one that carries the risk, and it is last on purpose: everything before it is
provable in isolation, and none of it changes what the internet can reach.

## Open decisions

- **QR codes need a dependency.** An `otpauth://` URI is a QR code in every authenticator's
  flow, and QR encoding is Reed-Solomon — not something to hand-roll next to a login. Slice 4
  can ship manual entry (the base32 key, grouped and copyable) with no dependency, or take
  `qrcode` / `qrcode.react` — already used in OpenMasjidDonations and OpenMasjidCompanion, so
  it is a known quantity in this fleet. Manual entry on a phone is poor UX; this is worth one
  small dependency, but `CLAUDE.md` §19 says ask first.
- **Does enrolled 2FA apply on the LAN too?** Current intent: yes — once enrolled it is
  required everywhere, because "the LAN session is weaker than the remote one" is a distinction
  nobody will remember at 11pm. Break-glass is the backup codes and the installer's *Reset
  sign-in*.
- **The session cookie's `Secure` flag** is opt-in and off by default, because an app served
  over plain HTTP needs the forwarded session cookie. A tunnel-origin session should set it;
  that means the flag becomes per-response rather than per-process. Slice 3.
