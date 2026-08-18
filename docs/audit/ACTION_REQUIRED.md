<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Action required — only you can do these

From the 2026-07-30 audit of `cf32b878`. Ordered by urgency.

> **Re-checked 2026-08-18 for the v0.51.0 release sweep.** Item **1's Stripe finding is STILL
> OPEN** and is now recorded as a known gap in `CLAUDE.md §15` and `docs/SECURITY.md` so it is
> visible outside this file. **All of §6's doc corrections have been made** (see the notes
> against each). Items 2–5 are unchanged historical record. Nothing else in this file became
> true or untrue since 2026-08-14.

---

## 1. Credentials to rotate

**Nothing in this repository leaked a credential.** I searched the working tree and git history
across `--all` for key-shaped material and found none: the three pattern hits are a UI placeholder
(`Settings.tsx:1911` `placeholder='sk_live_…'`), i18n help copy, and a textarea placeholder. There is
no committed `.env`, `.pem`, dump or service-account JSON in any reachable commit. **So there is no
rotation forced by a leak.**

> **Status re-verified 2026-08-14 (v0.50.4-dev.1).** This file is the July audit's
> snapshot; the notes below say what is still true in the code TODAY, so it stops reading as
> a to-do list that may already be done.
>
> - **STILL OPEN — Stripe cross-account read.** `GET /api/fabric/stripe?account=<id>`
>   (`packages/core/src/api/fabric.ts`) takes the account id straight from the query string and
>   returns that account's `secretKey` and `webhookSecret`. The only check is that the caller
>   holds the `stripe` capability — nothing binds an app to a particular account, and
>   `/api/fabric/stripe/accounts` hands the caller the ids to ask for. So any stripe-capable
>   app can read every account's keys, which is the one place the Fabric's least-privilege
>   rule does not hold. Fixing it needs a per-app account binding (recorded at install,
>   enforced here); that changes the app-facing Fabric contract, so it is its own change,
>   coordinated with OpenMasjidAPPS. The rotation advice below stands until then.
> - **FIXED — dashboard file access to platform secrets** (`OPENMASJIDOS-004`, v0.47.3):
>   `files/manager.ts` refuses `config/**`, `.backup-staging/**` and each app's
>   `compose.yml` / `.env` / `meta.json`, checking the realpath as well as the requested path.
> - **FIXED — corrupt TLS cert bricking boot** (`OPENMASJIDOS-011`, v0.47.2): the cert is
>   validated by content, damage is quarantined and regenerated, and the server falls back to
>   plain HTTP rather than exiting.

Rotate only if either of these is true for your live box:

| Priority | Credential | Rotate if | Why |
|---|---|---|---|
| **1** | **Stripe secret + webhook signing keys** (all accounts) | any third-party app was ever installed, **or** the dashboard was ever open on a shared/untrusted machine | `OPENMASJIDOS-001` meant a captured session cookie read `config/stripe.json`. `/api/fabric/stripe?account=` *still* lets any stripe-capable app read every account's keys. Rotate in the Stripe dashboard, then re-enter here. |
| **2** | **Cloudflare tunnel token** | as above, and remote access is enabled | Same exposure. A stolen token lets someone route your public domain. Recreate the tunnel in Cloudflare Zero Trust. |
| **3** | **SMTP password / Resend API key** | as above | Same exposure, plus `email.save` could send the stored password to an attacker-chosen host. |
| **4** | **Admin password** | as above | The argon2id hash was readable. Hash, not plaintext — so this is precaution, not emergency. |

If no third-party app was ever installed and the dashboard has only been used from trusted machines
on a trusted LAN, I would not rotate. I am not going to manufacture urgency.

**I did not and cannot rotate any of these**, and note that removing a secret from code would not
un-leak it anyway.

---

## 2. Git history

**No action needed.** I found nothing warranting `filter-repo` or BFG. I am recording the negative
result explicitly so nobody re-litigates it: the tree and history are clean of real secrets, so
history rewriting — which is disruptive and breaks every clone — is **not** recommended.

---

## 3. Cross-repo — required, and I deliberately did not do it

### `OpenMasjidAPPS` — mirror the compose-gate checks

`CLAUDE.md §15` requires that every check in `apps/compose-validate.ts` be mirrored in
`OpenMasjidAPPS/scripts/validate-compose.mjs`, so that "passes the catalog build == safe to install"
stays true. **I changed the gate (`OPENMASJIDOS-002`), so the mirror is now behind.** Until it
catches up, the catalog build will accept a compose the platform then refuses at install — which
presents to an app author as a mysteriously failing install.

Add to `validate-compose.mjs`, matching `checkHostPath`:
1. `path.posix.normalize` the host path **after** the `..` check, so `//run` and `/var/./run` collapse.
2. Flag a leading `~` (compose expands it; the core runs as root, so it resolves to `/root/…`).
3. Test sensitive-root containment in **both** directions, so mounting a parent of the data dir
   (`/opt`) is flagged.

I did not touch that repo: it is being audited in parallel by a session that cannot see my changes,
and this rule does not bend.

### All five app repos — the Stripe scoping change will be a breaking contract change

`/api/fabric/stripe?account=` currently lets **any** stripe-capable app read **every** configured
account's live keys (confirmed independently by 7 auditors). The right fix is to scope each app to the
accounts it is granted — but that changes the Fabric contract, so it needs coordinating across
`OpenMasjidDonations`, `OpenMasjidKiosk`, `OpenMasjidStudentManager` and the catalog. **Decide the
grant model first**, then change platform and apps together.

---

## 4. Infra / provider decisions

- **Backup encryption.** The archive contains every platform secret *including the credential for the
  backup destination itself*, unencrypted — and it contradicts a guarantee already written in
  `docs/SECURITY.md`. The fix is `rclone crypt` (a provider/config change) plus correcting that doc.
- **OTA signing.** The update is `docker pull :latest` with TLS as the only integrity control. No
  signature is produced at publish or verified at pull. Adding cosign signing to the publish workflow
  and verification before recreate is an infra decision.
- **`:latest` as the update channel.** Because both the installer and the dashboard pull `:latest`,
  the image is a rolling target with no pinning and no rollback. Consider publishing immutable
  version tags and having the updater move between them — that is what makes rollback possible at all.

---

## 5. Assumptions I made

1. **`master` is the branch you meant** — you said `main`; this repo's default is `master`. I branched
   from and target `master`.
2. **Publishing `:latest` counts as "shipping to production."** It is what devices pull, so I treated
   a merge as an OTA publish and disabled autonomous push. If you consider that acceptable, the PR is
   ready to merge as-is.
3. **`enforce_admins: false` is not permission to bypass.** I could have pushed directly to `master`
   using admin bypass — my earlier pushes today did exactly that. I did not during this run.
4. **The admin is not an attacker.** Several candidate findings assumed otherwise; I rejected them
   rather than inflate the count. Where an admin session already grants equivalent power, I capped
   severity or dropped the finding.
5. **Confirmation dialogs are for misclicks, not authorization.** So I added them only where the
   action is instant *and* hard to undo, and left the frequently-used reversible controls alone.
6. **`CLAUDE.md` is authoritative on intent**, so where code and doc disagreed I treated the code as
   the bug — except where the doc is simply stale, which I listed as Info findings.

---

## 6. Doc corrections you should make (I did not, to keep the diff reviewable)

**All four were made in v0.51.0.** Kept here as the record of what was wrong and for how long —
each had survived several releases, which is the actual lesson.

- ~~`CLAUDE.md:537` — "The gate runs on EVERY path that starts a compose" is still **not true**:
  `startApp` runs `docker compose up` on the on-disk compose with no gate.~~ **DONE** — the
  sentence now says "every path that introduces or refreshes a compose" and names `startApp` as
  an explicit, reasoned exception (every *write* vector into that file is gated, and
  `files/manager.ts` refuses `compose.yml`, so the gap costs defence in depth rather than a
  supported attack path). It also records that gating it should refuse only on `refusals`, or a
  running app could become unstartable.
- ~~`CLAUDE.md §16/§17` — describe `npm run lint` as "eslint + tsc". **There is no eslint in this
  repo**~~ **DONE** — §16, §17 and `CONTRIBUTING.md` now state that `npm run lint` is
  `tsc --noEmit` and that there is no ESLint, plus the fact that neither build step typechecks at
  all, so a green `npm run build` is not evidence.
- ~~`CLAUDE.md §18` — "Current version: 0.1.0" while `VERSION` says 0.47.1.~~ **DONE** — §18 no
  longer restates the version; `VERSION` is the single source of truth, as it always claimed.
- ~~`docs/SECURITY.md:86` — claims the backup "is not staged on local disk" … Also still describes
  the compose gate as one acknowledgeable list, with no mention of `refusals`.~~ **DONE** — both.
  The backup section now says the outer archive is streamed but each volume **is** staged under the
  data dir, and states the free-space requirement; the gate section now describes **dangers** vs
  **refusals** and says plainly that refusals are never acknowledgeable.
