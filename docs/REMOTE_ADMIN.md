<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Remote administration over the tunnel — design and progress

**Status: shipped, off by default** (`0.51.2-dev.13`). Settings → Remote access has the switch;
it refuses to turn on until two-step sign-in is enrolled, and it stops taking effect if that is
ever removed. With it off, nothing about this platform's behaviour differs from before the feature
existed — including the refusal records that make a wrong public address diagnosable.

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

A masjid volunteer on the masjid's own network must not be locked out of the dashboard by a
phone they left at home. So `login` demands a second factor when `ctx.viaTunnel` is true, and
not otherwise.

**Be honest about what that buys, because it is weaker than it sounds.** `viaTunnel` is sound
for traffic that really came through the tunnel — Cloudflare sets `cf-ray` at its edge and a
client cannot strip it. It **cannot** tell the LAN from the internet on a box whose ports
80/443 are directly reachable: a public-IP VPS, or a router forwarding them. Such a request
carries no Cloudflare headers and looks exactly like the office laptop, so it would **skip the
second factor entirely**. `CLAUDE.md` §15 already says this about the LAN-only guard, and
`util/net.ts` records why a source-address check cannot fix it — Docker SNATs every inbound
connection to the bridge gateway, so a peer check answers "private" for the internet.

So this protects **the door being deliberately opened**. It is not a substitute for a firewall
or a bind address on a directly-reachable host, and `docs/SECURITY.md` has to keep saying so.

> If that residual bothers you, the fix is a setting — "require the second factor everywhere"
> — rather than a cleverer detector. There is no header that distinguishes a LAN client from
> the internet on this network layout; that is the finding `util/net.ts` exists to record.

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
| 4 | Settings UI: enrolment with a QR, backup codes, the sudo rule; the login screen's code step | ✅ `dev.12` |
| 3 | The exposure itself: the dashboard on the front door behind the setting, per-IP lockout, §15 rewritten | ✅ `dev.13` |

Slice 3 is the one that carries the risk, and it is last on purpose: everything before it is
provable in isolation, and none of it changes what the internet can reach. Slice 4 was taken
ahead of it so the factor can be set up, scanned and verified before anything depends on it —
the alternative is an admin meeting enrolment for the first time on the same day the dashboard
becomes reachable from the internet.

## A session is not enough to change how you sign in

Every mutation in `trpc/routers/twofactor.ts` re-proves the password, and once a factor is
active, the current second factor as well. The reasoning is worth repeating here because the
obvious threat is the wrong one.

**Turning 2FA off is not the attack.** With no factor enrolled, `login` refuses tunnel traffic
outright (it fails closed), so an attacker who switches it off has shut their own door.

**Re-enrolment is the attack.** Reach an authenticated dashboard — a stolen cookie, a borrowed
unlocked laptop, a password reused from somewhere else — mint a fresh secret into your own
authenticator, and you can now sign in from anywhere in the world, indefinitely, through the
front door. The admin's password still works. Nothing on screen looks different.

The two checks cover different halves of that, which is why neither is sufficient alone:

| | blocks |
|---|---|
| Password | a session with no password behind it (stolen cookie, XSS, an unlocked laptop) |
| Current second factor | a password with no phone behind it — the LAN case, where a password is the whole of sign-in |

A code spent this way is **spent**: `verifySecondFactor` advances the replay guard on success,
so the code that authorised a change cannot then be replayed to sign in. The way back when a
phone is genuinely lost is a backup code — accepted anywhere a TOTP code is — or `install.sh`
→ *Reset sign-in*, which needs physical access to the box.

## Where the QR is drawn, and why it is not in the browser

`auth/qr.ts` encodes the `otpauth://` URI server-side with `qrcode-generator` (MIT, no
dependencies of its own, ships its own types) and returns a **grid of bits**. The UI draws that
as a single SVG path.

Three reasons it is not a browser dependency:

- **It is testable here.** `packages/ui` has no test runner, so an encoder in the bundle could
  not be checked at all — and a QR that encodes the wrong string looks exactly like one that
  encodes the right string. `test/qr.test.ts` checks the finder patterns, the timing patterns
  and the version chosen against the spec's own capacity table, and pins the exact grid for a
  fixed input.
- **`@openmasjid/ui` is a design system other apps consume.** A QR encoder is not a design
  system, and putting it there would make every app in the fleet carry it.
- **The result is data, not markup.** No `dangerouslySetInnerHTML` anywhere near the sign-in
  flow.

Two details that are easy to get wrong and are pinned by tests: the payload must be **ASCII**
(the library's default byte conversion is Shift_JIS — UTF-8 is a separate entry point — so a
non-ASCII character would scan to mojibake, and `qrMatrix` throws rather than encoding it), and
the code is drawn **black on white in both themes**, because a QR is read by contrast and a
token-coloured one would be near-invisible to a camera on the dark theme.

## Settled

- **The session cookie's `Secure` flag is decided per response.** On for a session issued to an
  HTTPS tunnel visitor (`cf-ray` present AND `visitorScheme` says `https`), off on the LAN, where
  an app served over plain HTTP needs the forwarded cookie for single sign-on. "Came through the
  tunnel" is NOT the condition: Cloudflare stamps `cf-ray` on a plain `http://` visit too, a
  browser throws away a `Secure` cookie delivered over plain HTTP, and one build that keyed it on
  `isViaTunnel` bounced every remote sign-in back to the sign-in screen. A plain `http://` tunnel
  visit to the dashboard is now 308'd to `https://` on the configured hostname instead of served.

- **Does enrolled 2FA apply on the LAN too? No** — Hasan's call, and the reason is the right
  one: a volunteer on the masjid's own network must not be locked out of the dashboard by a
  phone they left at home. So `login` demands the second factor when `ctx.viaTunnel` is true
  and not otherwise, and the honest limits of that signal are set out above.
- **QR codes: yes, and server-side.** See the section above.


## What Slice 3 actually changed, and the one thing it broke on the way

`system/remote-admin.ts` is the single decider (`remoteAdminEnabled()`) and the single statement of
which paths the dashboard owns (`isDashboardPath`). Both are security decisions, and this codebase
has twice shipped a second, subtly different copy of a check like that.

The front door now registers tRPC and the built UI, behind an `onRequest` gate that runs after the
Fabric guard. Three cases, and two of them are "exactly as before":

| | before | now |
|---|---|---|
| LAN, plain HTTP | 308 → HTTPS | 308 → HTTPS |
| tunnel, feature off | 404 + refusal recorded | 404 + refusal recorded |
| tunnel, feature on | 404 | the dashboard |

**The regression, worth recording because the unit tests could not see it.** The front door's
`notFoundHandler` was what redirected plain-HTTP LAN traffic to HTTPS. The moment `@fastify/static`
was registered on that listener, `GET /` matched a real route, skipped the handler, and served the
dashboard **unencrypted on the masjid's own LAN**. The gate redirects LAN traffic itself now. The
tests missed it because the front door they build to exercise the gate had no static route, so the
fall-through still reached the handler there; a smoke test against the real daemon found it in one
line. `test/remote-admin.test.ts` now registers `/` and `/assets/index.js` in its mirror, and
mutation-checking confirms removing the redirect fails it.

### Verified against the real daemon, not only the mirror

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

## What the second review found (dev.15), and both were shipped in dev.13–14

**1. With the feature OFF, the dashboard API answered over the tunnel to an encoded address.**
The gate asked `isDashboardPath`, which needs EVERY spelling of the path to be a dashboard path.
That is the right rule for deciding to *serve* — and the wrong one for deciding whether the gate
*looks at all*. `/%74rpc/auth.me` has the raw first segment `%74rpc`, so the gate said "not mine"
and let it through, and Fastify, which routes on the decoded path, delivered it to tRPC. The gate
now asks `touchesDashboardPath` (ANY spelling); serving still requires `isDashboardPath`.
`/%74rpc/auth.me` answered 200 with the feature off before the fix. Measured against the real
built daemon after it:

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

Every refusal above was recorded for "Recently turned away".

**2. Every app's live connection over the tunnel was broken.** `@fastify/websocket` had been
registered on the front door to carry the dashboard's socket. It routes *every* upgrade through
Fastify, so an app's socket was piped to the app by the ingress AND proxied as an ordinary HTTP
request by the ingress's hook — the browser got an HTTP response inside its WebSocket stream and
the connection died. The plugin is gone from that listener; the ingress is the one upgrade owner
and hands the dashboard's socket to tRPC's own handler when `claimsDashboardSocket` agrees, which
asks the same `frontDoorDecision` the HTTP gate does. `test/front-door-websocket.test.ts` drives
real sockets through the real ingress against a real upstream app. **The app-socket half was not
re-run against the real daemon**: the test machine has no Docker, so the daemon's ingress has no
app routes to send a socket to. The behavioural test is the evidence for that half.

The same review found three ways a sign-in could outlive a password change; those are recorded in
CLAUDE.md §9 (*the binding comes from the password that was proved*), not here.

## Still true, and still the honest limit

`viaTunnel` is sound for traffic that really came through Cloudflare. It **cannot** tell the LAN
from the internet on a box whose ports 80/443 are directly reachable — a public-IP VPS, or a
router forwarding them. Such a request carries no Cloudflare headers, so it is treated as LAN: it
would be 308'd to the HTTPS dashboard and would **not** be asked for a second factor. That is the
same residual `docs/SECURITY.md` records for the LAN-only guard, and the mitigations are the same
ones: a firewall and a bind address. A source-address check cannot fix it (`util/net.ts`).
