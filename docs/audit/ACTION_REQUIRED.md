<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Action required — only you can do these

From the 2026-07-30 audit of `cf32b878`. Ordered by urgency.

---

## 1. Credentials to rotate

**Nothing in this repository leaked a credential.** I searched the working tree and git history
across `--all` for key-shaped material and found none: the three pattern hits are a UI placeholder
(`Settings.tsx:1911` `placeholder='sk_live_…'`), i18n help copy, and a textarea placeholder. There is
no committed `.env`, `.pem`, dump or service-account JSON in any reachable commit. **So there is no
rotation forced by a leak.**

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

- `CLAUDE.md:537` — "The gate runs on EVERY path that starts a compose" is still **not true**:
  `startApp` (`apps/manager.ts:880`) runs `docker compose up` on the on-disk compose with no gate.
  Either narrow the sentence or gate `startApp`.
- `CLAUDE.md §16/§17` — describe `npm run lint` as "eslint + tsc". **There is no eslint in this
  repo**, so the documented definition of done is unachievable as written.
- `CLAUDE.md §18` — "Current version: 0.1.0" while `VERSION` says 0.47.1.
- `docs/SECURITY.md:86` — claims the backup "is not staged on local disk"; per-volume tars are staged
  at `DATA_DIR/.backup-staging`. Also still describes the compose gate as one acknowledgeable list,
  with no mention of `refusals`.
