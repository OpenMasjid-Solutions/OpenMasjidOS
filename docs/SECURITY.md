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

## App compose consent gate

Before any app's `docker-compose.yml` runs, it is parsed and risk-checked
(`packages/core/src/apps/compose-validate.ts`): privileged mode, host namespaces
(`network_mode`/`pid`/`ipc`/`userns_mode`/`cgroup`/`uts: host` **and**
`container:`/`service:` joins), Docker-socket / sensitive host bind mounts (incl.
`..` escapes and `local`-driver named-volume binds), `cap_add`, `devices`,
`security_opt: …unconfined`, `group_add` of root/docker, `extends`/`include`, and
`build:` contexts. Variables (`${VAR}`) in security-sensitive fields fail closed.
Catalog installs are hard-blocked on any danger; the opt-in 3rd-party (custom)
installer requires an explicit "I understand the risk" acknowledgement.

## Off-site backups (scheduled)

Settings → **Off-site backups** uploads the platform backup (the same gzipped tar
of `config/` + `apps/` as the manual download) to Google Drive or a NAS on a
schedule, via bundled `rclone`.

- **Credentials never leave the host.** The destination's secret (NAS password,
  SFTP private key, or Google Drive token) is written only to `rclone.conf` (and
  an optional key file) under the data dir, `chmod 600`. Passwords are stored in
  rclone's obscured form, not plaintext. `settings.json` and the `backups.status`
  API hold only non-secret metadata (kind, label, remote path, schedule, last-run
  status) — a secret is never returned to the browser, even to the admin.
- The backup tar is **streamed** straight to the remote (`rclone rcat`) — it is
  not staged on local disk, so a small box won't fill up.
- Retention prunes the remote to the newest N backups (default 7).
- Backups capture data **as-is**; if an app stores its own secrets (e.g. Stripe
  keys) in its data dir, those travel inside the tar — so treat the destination as
  trusted and prefer one that encrypts at rest.

## Reporting

OpenMasjidOS is licensed **AGPL-3.0-only** ([`LICENSE`](../LICENSE)); the dashboard
links to its source (Settings → Advanced) per AGPL §13. To report a vulnerability,
open a security advisory on the repository.
