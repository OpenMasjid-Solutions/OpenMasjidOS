<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Remediation — what shipped, how it was verified, how to undo it

**Branch:** `audit/security-2026-07-30` · **Base:** `cf32b878` (`pre-audit-2026-07-30`)
**Merged to `master`:** **NO** — autonomous push disabled, see `SECURITY_AUDIT.md §0`.

## Baseline vs after

| | Before (`cf32b878`) | After (`9eef775`) |
|---|---|---|
| `npm run lint` | exit 0 | exit 0 |
| `npm test` | 107 pass / 0 fail | **124 pass / 0 fail** |
| `npm run build` | exit 0 | exit 0 |
| `npm audit --audit-level=high` | pass — 0 high / 0 critical | pass — unchanged |
| `npm audit` totals | `{info:0,low:0,moderate:5,high:0,critical:0}` | unchanged (no deps touched) |

No pre-existing failures, so nothing of mine is masked by a broken baseline.

---

## Tier 2 changes — read these first

Two shipped changes alter behaviour. If something feels off in the next few days, look here.

### `OPENMASJIDOS-001` — the dashboard key is now required on the WebSocket transport

**Commit `5957435`.** Behaviour change: a WebSocket client that presents only the session cookie is
now rejected. The dashboard itself sends the key as `?k=` on the handshake.

**Why it works.** `protectedProcedure` read `if (!ctx.isWebSocket && !verifyCsrf(...))`. Removing the
exemption makes the middleware verify the key on both transports; `context.ts` now sources the key
from the `x-omos-csrf` header *or* the `k` query parameter, because a WS handshake cannot carry a
custom header — the convention `api/ws-auth.ts` already used for every other WS route. The client's
`url` became a **callback** because the tRPC client is constructed at app start, before login: a
static string would freeze an empty key and every post-login reconnect would fail.

**What to watch:** the dashboard's live system-stats strip is the only consumer of this transport. If
stats stop updating, this is the commit.

**Verified live against a running daemon** (not just unit tests — and this is what caught a real
defect in my first attempt, see below):

```
ATTACK    query, cookie only, no ?k=  -> REFUSED (UNAUTHORIZED)
ATTACK    query, cookie + wrong ?k=   -> REFUSED (UNAUTHORIZED)
ATTACK    mutation settings.update    -> REFUSED (UNAUTHORIZED)
ATTACK    stats.stream subscription   -> REFUSED (UNAUTHORIZED)
DASHBOARD settings.get with real key  -> ALLOWED, real data
DASHBOARD stats.stream with real key  -> STATS STREAMING -> {"cpuPercent":3,"memUsed":14407995392,…}
```

The mutation line is the exact operation an auditor had used to persist `rootTerminal: true`.

**A defect in my own fix, caught by live testing.** My first version read only `req.query`. On the WS
path `req` is a raw Node `IncomingMessage` with no parsed query, so the *legitimate dashboard* was
rejected too — every case returned UNAUTHORIZED, including the one that should have worked. Had I
trusted the unit test alone I would have shipped a dashboard with no live stats. The URL is now
parsed by hand as a fallback.

**Regression test:** `packages/core/test/ws-dashboard-key.test.ts`, 7 cases through the real
middleware. Proven to fail before:

```
$ git stash push packages/core/src/trpc/trpc.ts && npx tsx --test test/ws-dashboard-key.test.ts
✖ a valid session WITHOUT the dashboard key is refused over WebSocket
✖ another session's key does not authorise this session
✖ a garbage or empty key is refused on both transports
✖ the WebSocket exemption is not reintroduced in source
ℹ tests 7 / pass 3 / fail 4
# after restoring the fix: ℹ tests 7 / pass 7 / fail 0
```

### `OPENMASJIDOS-002` — compose host paths are normalised

**Commit `16ba160`.** Behaviour change: three previously-accepted mount shapes are now flagged. Since
any danger is **hard-blocking** on the catalog path (install, update *and* post-restore reup), this
could in principle make an app uninstallable.

**Why it works.** `path.posix.normalize` runs *after* the `..` check (order matters — normalising
first would resolve an escape attempt into a clean-looking path) so `//run` collapses to `/run`,
which `SENSITIVE_ROOTS` already contains. A leading `~` is flagged rather than treated as relative,
because `docker compose` expands it before the daemon sees it. Containment is now tested in **both**
directions, so mounting a parent of the data dir (`/opt`) is caught.

**Verified against the live catalog** — the check that matters for "does this break existing users":

```
live catalog: 5 app(s)
  clean  display v0.65.0      clean  donations v0.36.0     clean  kiosk v0.9.35
  clean  students v0.43.1     clean  parking-attendant v0.2.1
RESULT: every live catalog app still installs cleanly.
```

I also proved `~` expansion rather than assuming it:

```
$ docker compose config      # source: "~/.ssh:/x"
      - type: bind
        source: C:\Users\Hasan Ismail\.ssh      # ← compose expanded it
```
On the device the core runs as root, so that is `/root/.ssh`.

**Regression test:** 6 cases appended to `test/compose-guard.test.ts`. Proven to fail before:
`ℹ tests 22 / pass 18 / fail 4` → after: `22/22`.

---

## Tier 1 changes

### `OPENMASJIDOS-003` — a damaged admin record fails closed

**Commit `a1bdf6f`.** `readJson` returns its fallback on *any* error, so "no admin yet" and "the
admin record is damaged" were indistinguishable — and the damaged case re-opened `auth.setup`, a
public procedure, on an established box. Now a present-but-unreadable file sets `corrupt`,
`isConfigured()` returns true, and setup stays refused with a message naming the `reset-password`
recovery path (which needs host access — that requirement *is* the control).

**A gap in my own fix, caught by my own test:** `[]` is valid JSON that spreads into the defaults
without error, producing an all-null record that reads as "no admin yet". Parsing is not enough — the
value must be a plain object, so a wrong *shape* now counts as damaged.

Deliberately asserts the two cases that must NOT lock the box: an absent file, and a well-formed
record of explicit nulls. Proven to fail before: `ℹ tests 4 / pass 0 / fail 4` → after `4/4`.

### `OPENMASJIDOS-005` / `-006` — destructive-action confirmations

**Commit `9eef775`.** Stripe account removal was `onClick={() => remove.mutate({ id: a.id })}` with
the Trash button styled identically to Edit 8px away, and the secret is unrecoverable (`toPublic`
returns only `hasSecret`). Now behind a new `ConfirmDialog` (wrapping the existing `Modal`, so it
inherits reduced-motion, both themes and logical CSS for RTL).

Separately, `AppCard`'s "also delete this app's data" checkbox was never reset on Cancel or close, so
reopening the dialog had permanent volume destruction pre-armed.

**Deliberately not added** — Start/Stop/Restart, the sharing toggles, the alert matrix, the Advanced
switches. Reversible, frequently used, and a dialog on each trains people to click through, making
the dangerous ones less safe.

Caught while wiring it: `ConfirmDialog` referenced `common.working` and `actions.remove`, neither of
which existed in `en.json` — the pending state would have shown the literal string `common.working`
to the admin. Both added. No UI test infrastructure exists to extend, so this is verified by
typecheck, build, and reading both click paths.

---

## Deferred, and why

**Excluded from autonomous shipping by the addendum** (boot path / init / update mechanism — 13
findings). Implemented nowhere; they need a separate PR with a rollback plan and a bench box:
- `OPENMASJIDOS-011` corrupt-cert boot failure (**Critical**). Fix is small — validate the PEM before
  trusting it, and fall back to plain HTTP — but it is the boot path, and getting it wrong bricks
  wall-mounted hardware. **Never remove the recovery mechanism.**
- OTA signing/verification, update rollback and known-good image retention.
- Unauthenticated restore while no admin exists; first-run claim window.

**Tier 3, report-only** (14): the unencrypted backup archive (needs `rclone crypt` — infra), per-app
Stripe scoping (cross-repo contract), secret rotation.

**Deferred as unverifiable to a shippable standard** (the rest, 71). The honest reason: I could
confirm the *code* for many of them but not that my fix wouldn't break a legitimate flow without
runtime or hardware. Shipping those unreviewed is exactly the damage this run was supposed to avoid.
Highest-value ones to pick up next, in order: the File Explorer `config/` exposure
(`OPENMASJIDOS-004` — 6 auditors, and it defeats the deliberate "never return secrets to the client"
design); `system.addSshKey` (permanent host root, no toggle, no revocation); the `/%74rpc` origin
bypass (same normalisation class as the shipped Criticals, so cheap); pinning the Actions to SHAs;
and RTL/`prefers-reduced-motion`, which `CLAUDE.md §14` promises and which do not work at all.

---

## Rollback

Revert one fix (safe in any order — each is self-contained):

```bash
git revert 9eef775   # OPENMASJIDOS-005/-006  destructive-action confirmations
git revert a1bdf6f   # OPENMASJIDOS-003       auth fails closed
git revert 5957435   # OPENMASJIDOS-001       WebSocket dashboard key   ← revert this if live stats break
git revert 16ba160   # OPENMASJIDOS-002       compose path normalisation
```

Discard the whole run. Nothing was merged, so `master` is already untouched:

```bash
git checkout master                     # master is still cf32b878
git branch -D audit/security-2026-07-30
git push origin --delete audit/security-2026-07-30   # only if the branch was pushed
```

If a future merge does land and must be undone:

```bash
git reset --hard pre-audit-2026-07-30   # local
# or, preserving history:
git revert -m 1 <merge-sha>
```

The tag `pre-audit-2026-07-30` (`cf32b8780a80f427879dd3587a0ab7faee1ce769`) is pushed to origin. It
does not match the workflow's `tags: ["v*"]` trigger, so creating it published nothing — verified
before pushing.
