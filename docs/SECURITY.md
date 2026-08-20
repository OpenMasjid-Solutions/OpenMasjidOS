<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Security model & assumptions

OpenMasjidOS runs as a single-admin appliance that manages Docker on the host
(it mounts the Docker socket and runs as root). This document states the trust
assumptions and the knobs for hardening a more exposed deployment.

## Trust model

- **Designed for a trusted LAN.** The expected deployment is a mini-PC / Raspberry
  Pi / VPS on the masjid's own network, reached at `https://openmasjidos.local`.
- **One admin account.** It is effectively host-root (it can install apps and open
  a root shell), so the admin password is the keys to the machine — use a strong
  one (the setup screen enforces ≥12 characters and shows a strength meter).
- **Apps run at arm's length** as separate containers and are not trusted with
  platform internals. The compose consent gate (below) vets every app's compose.

## Transport (HTTPS)

- The dashboard is **HTTPS-forced**: it serves TLS on 443 and a plain-HTTP front
  door on 80 that redirects to HTTPS (and answers the health check + the Fabric
  API, which app backends reach over HTTP).
- The cert is **self-signed by default** (a LAN box can't get a public CA cert);
  regenerate it or upload your own (cert + key) in **Settings → Security & SSL**.
- **Stripe apps** (manifest `https: true`) are served over HTTPS on a dedicated
  per-app proxy port; other apps stay on plain HTTP.

## Session cookie & the dashboard key

- The session cookie is `HttpOnly`, `SameSite=Lax`. `SameSite=Lax` (not `Strict`)
  is required so the cookie rides the cross-scheme "Open app" navigation (HTTPS
  dashboard → HTTP app) for SSO.
- **Replay is blocked by the origin-bound *dashboard key*, not the cookie.** Every
  cookie-authenticated admin call must also present a per-session CSRF key that
  lives only in the dashboard origin's storage — which an app on another port
  cannot read. So even a sniffed/forwarded cookie cannot drive the admin API.
- The cookie is **not `Secure` by default**, because it is forwarded to plain-HTTP
  apps for SSO and a `Secure` cookie is never sent over HTTP. The dashboard itself
  is HTTPS, so the cookie is encrypted in transit to it regardless.
  - **`OPENMASJID_SECURE_COOKIE=1`** — set the cookie `Secure`. Hardens the cookie
    on a hostile network, but **breaks SSO for plain-HTTP apps** (they no longer
    receive it). Enable only when the whole deployment is end-to-end HTTPS or you
    don't use HTTP-app SSO. *(A future enhancement is a separate Secure dashboard
    cookie split from the cross-app SSO cookie.)*

## Login throttle

- argon2id hashing, the credential verify is **serialized** (one at a time, so a
  parallel flood can't outrun argon2's cost), and consecutive failures incur a
  growing delay (reset on success). The delay is applied outside the verify mutex,
  so a correct login is never queued behind attacker delays.
- **`OPENMASJID_LOGIN_LOCKOUT=1`** — opt-in hard cooldown after repeated failures,
  for **internet-exposed** instances. Off by default: behind Docker NAT all LAN
  clients share one source IP, so a global lockout could let an attacker deny the
  real admin on a trusted LAN.

## What "LAN-only" means, exactly

Several routes are described in this project as LAN-only: everything under `/api/fabric/*`
(the app-to-app broker, and the email / WhatsApp / Stripe / alert endpoints apps use) and
`/api/auth/session`. It is worth being precise about how that is enforced, because the
honest answer is narrower than the phrase suggests.

**What it actually does.** Those routes are refused when a request *looks like it arrived
through the Cloudflare tunnel* — Cloudflare adds a `cf-ray` header at its edge and terminates
TLS, so tunnel traffic is recognisable. That check is sound in the direction that matters: a
client whose only route in is the tunnel cannot strip those headers, so it genuinely cannot
reach those routes.

**What it does not do.** It is a deny-list, not an allow-list: "refuse anything that looks
like the tunnel" is not the same as "allow only the local network". If the machine itself is
reachable from the internet — a VPS with a public IP, or a home router forwarding ports 80
and 443 — then requests arrive with no Cloudflare headers at all, and there is nothing in
them that distinguishes an attacker from a laptop in the masjid office. On such a host these
routes are internet-facing, and so is the dashboard's login page.

**Why we do not check the source IP address instead.** That would be the obvious fix, and it
does not work here. OpenMasjidOS runs in a container with published ports, and with Docker's
default settings every inbound connection is re-originated by `docker-proxy` from the bridge
gateway. Measured on a real host, an app container, the tunnel client, and a machine from
outside the network all arrive as the same address — `172.17.0.1`. A source-address check
would therefore classify the internet as "local", producing a guard that reads like an
allow-list while admitting everyone. That is worse than none, so we deliberately do not have
one. (The same fact is why the login lockout cannot be per-IP; see *Login throttle*.)

**What protects you on a directly-reachable host**, in order of how much it matters:

1. **A firewall.** Allow ports 80 and 443 only from your own network. On a VPS use the
   provider's firewall or `ufw`; on a home network, simply do not forward those ports. This is
   the control that makes "local only" true, and nothing inside the application can substitute
   for it.
2. **Your admin password.** No route grants a session, skips the password, or relaxes CSRF
   because a request looks local — being "on the LAN" buys an attacker nothing by itself.
   Passwords are argon2id-hashed with a 12-character minimum, and the verify is serialised so
   a parallel flood cannot outrun it.
3. **The per-app secret.** Every `/api/fabric/*` route independently requires a 256-bit
   per-app secret *and* the specific capability the app declared. Reaching the route is not
   the same as using it.
4. **`OPENMASJID_LOGIN_LOCKOUT=1`** — worth enabling on an internet-facing instance. See
   *Login throttle* for why it is off by default.

**What an attacker gets if all of that holds and they simply reach the routes:** a 403 from
every Fabric route, and a login page. `/api/auth/session` returns only
`{authenticated, username}` and requires both a valid session cookie of its own *and* an app
secret — no password hash, no session token, no CSRF key. There is no route that hands out
credentials to a caller because of where they appear to be.

## App compose consent gate

Before any app's `docker-compose.yml` runs, it is parsed and risk-checked
(`packages/core/src/apps/compose-validate.ts`): privileged mode, host namespaces
(`network_mode`/`pid`/`ipc`/`userns_mode`/`cgroup`/`uts: host` **and**
`container:`/`service:` joins), Docker-socket / sensitive host bind mounts (incl.
`..` escapes and `local`-driver named-volume binds), `cap_add`, `devices`,
`security_opt: …unconfined`, `group_add` of root/docker, `extends`/`include`, and
`build:` contexts. Variables (`${VAR}`) in security-sensitive fields fail closed.
The check also flags `volumes_from` (which can inherit the core's own mounts),
`env_file` pointing outside the app's own directory, and top-level
`secrets:`/`configs:` with a host `file:` source.

The result has **two** classes, and the difference matters:

- **Dangers** — catalog and community installs are hard-blocked on any of them; the
  opt-in 3rd-party (custom) installer allows one through only with an explicit
  "I understand the risk" acknowledgement.
- **Refusals** — **never acknowledgeable, on any path.** Currently: a top-level volume
  that uses `external:` or `name:` to attach to an `omos-*` volume, i.e. **another app's
  data or the platform's own**. There is no "I understand the risk" for these, because
  there is no legitimate reason for one app to mount another's database.

The gate runs on install (catalog, community and custom), on **update** — a refreshed
catalog entry is fresh external data — and after a **restore**, since a backup file is
externally craftable. One known gap: pressing **Start** on an already-installed app runs
the compose that is on disk without re-checking it. Every path that *writes* that file is
gated, and the File Explorer refuses to edit `compose.yml` at all, so there is no
supported way to get an unchecked compose onto disk — but the start path itself is not a
second wall.

## Reaching the platform from an app

Apps talk to the platform over `/api/fabric/*` on the LAN only; those routes are refused
if the request arrived through the Cloudflare tunnel. Each app is issued its own secret
and is authorised by what its manifest declares.

**One exception you should know about if you run more than one Stripe account.** An app
holding the `stripe` capability can read **any** configured Stripe account's keys, not
only the one it was set up with — accounts are not yet bound to apps. So if you keep a
separate Stripe account for, say, school fees and general donations, treat every
Stripe-capable app you install as having access to both. This is being fixed, and the fix
changes the app-facing contract, so it needs the apps updated in step.


## Off-site backups (scheduled)

Settings → **Off-site backups** uploads the platform backup (the same gzipped tar
as the manual download: `config/` + `apps/` **plus each app's Docker volume** under
`volumes/<name>.tar.gz`, so the apps' real data — SQLite dbs, uploads — is captured
too) to Google Drive or a NAS on a schedule, via bundled `rclone`. Volume contents
are copied in/out with a throwaway `tar` container; restore recreates the volumes
before starting the apps.

- **Credentials never leave the host.** The destination's secret (NAS password,
  SFTP private key, or Google Drive token) is written only to `rclone.conf` (and
  an optional key file) under the data dir, `chmod 600`. Passwords are stored in
  rclone's obscured form, not plaintext. `settings.json` and the `backups.status`
  API hold only non-secret metadata (kind, label, remote path, schedule, last-run
  status) — a secret is never returned to the browser, even to the admin.
- The **outer archive is streamed** straight to the remote (`rclone rcat`) and is
  never written to local disk.
- Each app's Docker volume **is** staged first, though, as
  `.backup-staging/volumes/<name>.tar.gz` under the data dir: a volume's contents
  have to be pulled out through a throwaway `tar` container before they can be
  folded into the archive. So a backup needs free space of roughly the size of your
  largest app's data, not zero. (This page said backups were never staged on disk
  and so could not fill a small box — that was wrong, and running out of space
  here is a real failure mode the code explicitly handles.)
- A backup that cannot capture everything **fails** rather than uploading a
  silently incomplete archive: a volume that won't archive fails the whole run, its
  partial file is deleted, and nothing is recorded as successful or pruned until
  both the archive and the upload have succeeded. Old backups are never pruned on
  the strength of a run that didn't verify.
- **Known limitation:** volumes are archived while the apps are running, so a
  database being written to at that moment can be captured mid-write. The archive
  will restore, but such a database may not open. The real fix is app-side
  (snapshotting before the backup); don't read `ok: true` as proof every database
  inside will open.
- **The archive is not encrypted.** It contains every platform secret — including
  the credential for the backup destination itself — so the destination must be
  treated as trusted. Prefer one that encrypts at rest.
- Retention prunes the remote to the newest N backups (default 7).
- Backups capture data **as-is**; if an app stores its own secrets (e.g. Stripe
  keys) in its data dir, those travel inside the tar too — one more reason the
  destination has to be a trusted one (see the encryption note above).

## Reporting

OpenMasjidOS is licensed **AGPL-3.0-only** ([`LICENSE`](../LICENSE)); the dashboard
links to its source (Settings → Advanced) per AGPL §13. To report a vulnerability,
open a security advisory on the repository.
