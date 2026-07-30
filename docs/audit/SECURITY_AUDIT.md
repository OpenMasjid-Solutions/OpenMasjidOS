<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# OpenMasjidOS — security & code-health audit

**Date:** 2026-07-30 · **Commit audited:** `cf32b878` (v0.47.1) · **Rollback tag:** `pre-audit-2026-07-30`
**Method:** 10 parallel area audits, each output then re-checked by an independent adversarial
verifier; every Critical re-proved by hand before any code changed.

---

## 0. Autonomous push was DISABLED — read this first

**Pushing to the default branch publishes a device update.** That is the stated veto condition, and
it is met with three linked pieces of evidence:

| Link | Evidence |
|---|---|
| Push → publishes an image | `.github/workflows/docker-build.yml:111,118` — `type=raw,value=latest,enable={{is_default_branch}}` plus `push: ${{ github.event_name != 'pull_request' }}` → `ghcr.io/openmasjid-solutions/openmasjid-core:latest` |
| The installer pulls that tag | `install.sh:48` `IMAGE=…:latest`, then `docker pull "${IMAGE}"` at :489, :800, :818 (install / update / repair) |
| **The dashboard's one-click update pulls that tag** | `packages/core/src/docker/update.ts:18` `DEFAULT_IMAGE = …:latest`, `docker pull image` at :78 |

So a merge to `master` is an OTA publish to every masjid box that presses **Check for updates**.
All work is therefore on `audit/security-2026-07-30` and offered as a PR. Nothing was merged.

Independently, `master` is protected with a required `cla` check and `enforce_admins: false`. A direct
push would have *succeeded by bypassing the protection rule*, which is also forbidden.

Note the default branch is **`master`**, not `main`.

---

## 1. Executive summary

**Honest posture: better than it looks from the finding count, and worse than it looks from the
commit history.**

This is a carefully-built codebase. It has a real install-time risk gate for app composes, a
per-app secret model, a LAN-only guard on its privileged routes, CSRF on cookie-authenticated
routes, atomic config writes with `fsync` and `0600`, and — genuinely unusual — a documented list of
security invariants in `CLAUDE.md §15` that the code mostly honours. Several classes I went looking
for were simply clean: no hardcoded secrets anywhere in the tree *or* in git history, no SQL (no
database), no `eval`, no `dangerouslySetInnerHTML`, no JWT to get wrong, no homegrown crypto,
argon2id with sane parameters, and every shell-out uses argv arrays rather than shell strings.

The problem is that its strongest defences each had one hole, and the holes line up.

**The single most important issue is `OPENMASJIDOS-001`.** `protectedProcedure` exempted the
WebSocket transport from the dashboard-key check, on the stated belief that WS carries only
subscriptions and is covered by the origin guard. Both halves are false: the tRPC WS transport
executes queries *and* mutations, and the origin guard returns `true` when there is no `Origin`
header — which a non-browser client simply omits. The result is that the **session cookie alone drove
the entire admin API**, and on this platform the admin API is host root, because the core runs as
root with the Docker socket mounted. An auditor proved it by reading `config/auth.json` over
`wss://` with nothing but a cookie, and by persisting `rootTerminal: true` via a mutation. The cookie
is obtainable: it is non-`Secure`, host-scoped, `path=/`, `SameSite=Lax`, and the dashboard's "Open"
button top-level-navigates to an installed app on another port over plain HTTP.

Three more Criticals, all verified by me directly rather than accepted on report:

- Two **compose-gate bypasses** (`OPENMASJIDOS-002`). The gate that `CLAUDE.md §15` designates the
  *sole* install-time check waved through `//run:/hostrun` (a duplicate slash defeated the
  string comparison; `/run` holds `docker.sock` on every systemd distro) and `~/.ssh:/x` (a leading
  tilde failed the `startsWith('/')` test and was treated as a relative in-app path — but
  `docker compose` expands `~` itself, and the core runs as root, so it resolves to `/root/.ssh`).
  Mounting `/opt` — the parent of the platform's own data dir — was likewise unflagged.
- A **boot brick** (`OPENMASJIDOS-011`). A corrupt-but-present TLS cert defeats the plain-HTTP
  fallback, because `loadCert()` *succeeds* and returns garbage. `Fastify({ https })` then throws
  outside the try/catch. I reproduced it: nothing listens on either port, and because the cert lives
  in the mounted data dir, **both Update and Repair re-read it** — the volunteer's two self-service
  recovery paths are useless. That means driving to the masjid.

The recurring theme worth more than any individual finding: **several defences compare raw strings
where the consumer compares something normalised.** The compose gate compared un-normalised paths.
The `/trpc` origin hook compares the raw URL and is walked past with `/%74rpc`. The Fabric tunnel
guard had the same bug (fixed earlier today, before this audit). That is a class, not three
coincidences, and it is worth a standing review rule.

**Counts:** 4 Critical · 23 High · 41 Medium · 29 Low · 8 Info (105 after deduplication; the raw
150 included the WebSocket flaw found independently by 4 of 10 auditors and the file-explorer root by
6 — corroboration, not duplication).

**Shipped this run:** 7 findings across 4 commits, every one with a regression test proven to fail
before and pass after. **Not shipped:** everything touching the boot path, init, or the update
mechanism (excluded by the addendum), everything requiring a cross-repo contract change, and a long
tail of Medium/Low items I could not verify to a standard that justifies shipping unreviewed.

---

## 2. Phase 0 — what this is, and who attacks it

**The product.** A self-hosted platform a masjid runs on its own cheap hardware (mini-PC or
Raspberry Pi) so volunteers with no technical skill can run useful software. One `curl | bash`
installer, everything in Docker, a masjid-themed dashboard behind a login. From there an admin sees
live system stats, browses an App Store, and installs apps one click at a time. Each app is a Docker
Compose project the platform starts, stops, updates and removes.

**Runtime.** Node 20 + TypeScript daemon (`packages/core`, ~10.6k lines) serving Fastify + tRPC over
HTTP and WebSocket; React 18 + Vite dashboard (`packages/ui`, ~6.5k lines) that imports only *types*
from core. Ships as one Docker image. `install.sh` is 915 lines of bash.

**The fact that sets every severity in this report: the core runs as root with
`/var/run/docker.sock` mounted.** It has to, to manage app containers. So any app-isolation gap, any
command injection, any write into a compose file, and any admin-session hijack are all the same
thing — host root.

**Entry points.** Two listeners: a TLS dashboard server (`TLS_PORT`, default 443) and a plain-HTTP
front door (`PORT`, default 80) that redirects and serves app paths. On them: `/trpc` (HTTP + WS),
`/api/health`, `/api/ready`, `/api/backup`, `/api/files/{download,raw,upload}`, `/api/terminal/*`
(WS), `/api/update` (WS), `/api/restore/*`, `/api/branding/logo`, `/api/app-update` (WS),
`/api/fabric/*` (per-app secret), `/api/public/{appearance,logo}` (intentionally public), and the
per-app reverse proxies. Plus: the installer, the `reset-password`/`reset-auth` CLIs, four
in-process timers (alerts, updates, backups, address reconciliation), and an optional Cloudflare
tunnel.

**Trust boundaries.** Untrusted → trusted crossings are: the LAN (any device on masjid wifi); the
internet, when the tunnel is on; **installed app containers**, which hold a per-app secret and talk
to `/api/fabric/*`; the fetched `catalog.json`; an admin-pasted compose or CasaOS store URL; an
uploaded backup archive; and an uploaded logo.

**Sensitive data.** The platform holds the admin credential (argon2id), live **Stripe secret and
webhook keys**, the **Cloudflare tunnel token**, **SMTP password / Resend key**, the dashboard TLS
private key, and every app's `.env` (i.e. every per-app Fabric secret). Apps handle donations,
kiosk payments, and — via the Students app, whose volume the platform backs up — **records about
children**. That raises the bar on the backup archive specifically.

**Threat model, in the order I weighted it.**
1. **Someone else on the masjid LAN** — a guest on the wifi, a compromised phone. Highest
   likelihood: the dashboard is LAN-reachable by design and the box is on a shared network.
2. **A malicious or sloppy third-party app** the admin installed. This is the most under-defended
   direction, and it is realistic: the product actively encourages installing apps.
3. **The internet**, when the Cloudflare tunnel is enabled.
4. **A compromised or spoofed catalog** — the platform runs what it publishes.
5. **Brief physical access** to a box mounted on a wall in a semi-public building.
6. **A curious volunteer** with dashboard access but no business reading payment keys.

Not in scope as an attacker: the admin themselves. Several "findings" die on that distinction, and I
rejected them rather than pad the count.

---

## 3. Findings

Full machine-readable list in [`findings.json`](findings.json) (105 entries, identical schema across
the six repos). Status values: `fixed` · `deferred` · `deferred-separate-pr` (boot/update path) ·
`report-only` (Tier 3).

### Critical

| ID | Title | Conf. | File:line | Status |
|---|---|---|---|---|
| OPENMASJIDOS-001 | tRPC WebSocket transport exempt from the dashboard-key check — session cookie alone is full admin, i.e. host root | confirmed | `packages/core/src/trpc/trpc.ts:40` | **fixed** `5957435` |
| OPENMASJIDOS-002 | Compose gate compares un-normalised host paths — `//run` mounts the Docker socket's directory unflagged | confirmed | `packages/core/src/apps/compose-validate.ts:119` | **fixed** `16ba160` |
| OPENMASJIDOS-002 | A leading `~` is never expanded, so `~/.ssh:/x` reaches root's home past the `/root` check | confirmed | `packages/core/src/apps/compose-validate.ts:124` | **fixed** `16ba160` |
| OPENMASJIDOS-011 | A corrupt/truncated TLS cert or key puts the core in a permanent boot failure that neither Update nor Repair fixes | confirmed | `packages/core/src/index.ts:76` | **separate PR** (boot path) |

### High (selected — full list in `findings.json`)

| ID | Title | Conf. | File:line | Status |
|---|---|---|---|---|
| OPENMASJIDOS-003 | A damaged `auth.json` fails OPEN, re-opening first-run claim on an established box | confirmed | `packages/core/src/util/json-store.ts:14` | **fixed** `a1bdf6f` |
| OPENMASJIDOS-005 | Stripe account removal fires on one click; the secret key is unrecoverable | confirmed | `packages/ui/src/routes/Settings.tsx:1670` | **fixed** `9eef775` |
| OPENMASJIDOS-006 | "Also delete this app's data" stays ticked after Cancel | confirmed | `packages/ui/src/components/AppCard.tsx:55` | **fixed** `9eef775` |
| OPENMASJIDOS-004 | File Explorer's sandbox root is the data dir, so any session reads `stripe.json`, `email.json`, the tunnel token and the TLS key — and rewrites any app's compose | confirmed (6 auditors) | `packages/core/src/files/manager.ts:36` | deferred |
| — | `system.addSshKey` turns any dashboard session into permanent host root: no Advanced toggle, no key list, no revocation, survives password reset and uninstall | confirmed | `packages/core/src/trpc/routers/system.ts:104` | deferred |
| — | Every platform secret rides in the backup tarball **unencrypted**, including the credential for the backup destination itself — contradicting a documented guarantee in `docs/SECURITY.md` | confirmed (4 auditors) | `packages/core/src/system/backup.ts:218` | report-only |
| — | `/api/fabric/stripe?account=` lets any stripe-capable app read **every** configured Stripe account's live keys | confirmed (7 auditors) | `packages/core/src/api/fabric.ts:132` | report-only (cross-repo) |
| — | OTA payload is neither signed at publish nor verified at pull; TLS to GHCR is the only integrity control | confirmed | `packages/core/src/docker/update.ts:78` | separate PR |
| — | Update has no rollback and keeps no known-good image; a bad `:latest` bricks the dashboard, and "Free up space" deletes the only local rollback candidate | confirmed | `packages/core/src/docker/update.ts:87` | separate PR |
| — | Five third-party GitHub Actions pinned to mutable major tags in the job that publishes the root-privileged image | confirmed | `.github/workflows/docker-build.yml:96` | deferred |
| — | `auth.login` has no arrival cap and a FIFO verify mutex — an unauthenticated LAN flood locks the real admin out | confirmed | `packages/core/src/trpc/routers/auth.ts:129` | deferred |
| — | Abandoned WebSocket upgrades on the HTTP front door leak sockets forever (unauthenticated resource exhaustion) | confirmed | `packages/core/src/system/ingress.ts:165` | deferred |
| — | Session cookie is non-`Secure` by design and broadcast in cleartext to app ports on every "Open app" click; no HSTS anywhere | confirmed | `packages/core/src/trpc/context.ts:41` | deferred |

### Notable Medium

- `/trpc` origin (CSRF) hook compares the **raw** URL — walked past with `/%74rpc`
  (`index.ts:120`). Same normalisation class as the two Criticals above.
- Backup restore is **completely unauthenticated while no admin exists** (`api/restore.ts:43`) —
  root-level write into `config/` and `apps/`. Chains with OPENMASJIDOS-003.
- `startApp` runs `docker compose up` on the on-disk compose with **no risk gate**
  (`apps/manager.ts:880`), so a writable compose is host root. Known-accepted; independently
  reconfirmed. `CLAUDE.md:537`'s claim that the gate runs on *every* path that starts a compose is
  therefore still inaccurate.
- `email.save` re-uses the stored SMTP password against a caller-chosen host, turning a write-only
  secret into a readable one (`store/email.ts:124` + `routers/email.ts:49`).
- Outbound SMTP never requires TLS — a STARTTLS-stripping MITM gets the mail credential
  (`notify/email.ts:139`).
- **RTL and translation are unreachable at runtime**: there is no language selector and the strings
  for one are orphaned (`Settings.tsx:280`); no Arabic/Naskh font is bundled and the font stack has
  no Arabic fallback (`tokens.css:180`). `CLAUDE.md §14` promises both. For a product aimed at
  masjids this is a substantive gap, not cosmetic.
- `prefers-reduced-motion` is not honoured for **any** JS-driven animation — Motion defaults to
  "never" (`main.tsx:22`). `CLAUDE.md §14` calls this non-negotiable.

### Domain correctness

**Checked and clean, correctly.** No prayer-time, Hijri, Qibla or Zakat arithmetic exists anywhere in
this repo — which is right: `CLAUDE.md §4` places all of it in the apps. I verified there is no
half-implemented prayer or money logic hiding in the platform. The platform touches money only as
opaque Stripe key plumbing (no amounts, no arithmetic). The one real domain-adjacent risk is the
timezone/time-format display preference, which is presentation-only and correctly scoped.

---

## 4. Coverage, and what I could not assess

**Specifically checked and found nothing** (recorded so absence of a finding is not mistaken for
absence of a check): hardcoded secrets in the tree; secrets in git history across `--all` (the three
pattern hits are UI placeholders and help copy — `Settings.tsx:1911` `placeholder='sk_live_…'`);
committed `.env`/`.pem`/dumps; SQL injection (no SQL); `eval`/`new Function`;
`dangerouslySetInnerHTML` (none in the repo); JWT problems (no JWT); homegrown crypto; MD5/SHA1 for
anything security-bearing; `Math.random()` for tokens; shell-string command execution (all argv
arrays); TLS verification disabled anywhere; prototype-pollution via a deep merge.

**Could not assess without runtime, hardware, or network access I did not have:**
- Whether the Cloudflare edge normalises `%66`-style escapes before the origin — so the *real-world*
  exploitability of the percent-encoding class over a tunnel is unproven, though the broken invariant
  is proven.
- Real device behaviour on unclean power loss (SD-card corruption patterns, filesystem journal
  recovery). I proved the *software* consequence of a corrupt cert; I could not measure how often
  corruption actually happens.
- Physical-access attacks (single-user mode, disk removal, serial/USB) — no hardware.
- Whether an actual Resend send inlines `content_id`, and whether real mail clients still draw an
  attachment chip after this week's email change.
- The live `npm audit` advisory state at any future moment; I recorded it at audit time only.
- Anything about the five sibling repos. `OpenMasjidAPPS/scripts/validate-compose.mjs` is *required*
  by `CLAUDE.md §15` to mirror the compose gate, and I changed the gate — the mirror is now behind.
  That is in `ACTION_REQUIRED.md`.
- Multi-admin and role escalation: v1.0 is single-admin by design, so object-level authorization
  between *users* does not exist to test. I audited the app-to-app dimension instead.
