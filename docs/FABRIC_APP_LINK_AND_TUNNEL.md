<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Fabric app-to-app broker + tunnel uplink (as built, v0.40.0)

This is the as-built record of the two platform capabilities the OpenMasjidStudents
work introduced. It reconciles the original work order with the real code (the
"verify-then-extend" pass); where the two differed, the code won and this doc reflects
the code. The app-facing contract lives in [`APP_MANIFEST_SPEC.md`](APP_MANIFEST_SPEC.md);
this doc is the platform-internal design + the decisions taken.

## Work Package A — app-to-app broker

`POST /api/fabric/app/:targetAppId/:capability/:method` (`packages/core/src/fabric/appLink.ts`,
registered inside `registerFabric`). Order of operations:

1. **LAN-only.** Under `/api/fabric`, so the shared `registerFabricTunnelGuard`
   (`system/via-tunnel.ts`) 404s tunnel-origin requests before the route runs.
2. **Authenticate the caller** by `X-OpenMasjid-App-Secret` (constant-time `findFabricApp`).
   Unknown/missing → `401 unauthorized`. Target existence is not revealed on auth failure.
3. **Per-caller rate limit** (default 60/min; `OPENMASJID_FABRIC_BROKER_RATE`) → `429 rate_limited`.
4. **Validate** the path segments (`app-id` / kebab `capability` / kebab `method`).
5. **Authorize by static manifest grants**: caller `consumes` contains `"<target>/<capability>"`
   AND target `provides` the capability → else `403 not_granted`.
6. **Resolve the target** from the app registry: installed (`503 target_not_installed`),
   running with a published port (`503 target_unreachable`), and holding a secret.
7. **Proxy** to `http://127.0.0.1:<published port>/fabric/<capability>/<method>` — URL built ONLY
   from the registry + validated segments (no SSRF). Injects the **target's own** secret as
   `X-OpenMasjid-App-Secret` + trusted `X-OpenMasjid-Caller-App`; strips every caller-supplied
   identity/forwarding/hop-by-hop header. JSON only, ≤256 KB each way, 10 s timeout, no redirects.
8. **Pass through** the target's status + JSON on success; broker failures use the
   `{ fabric_error: { code, message } }` envelope. **Bodies are never logged.**

Any app with a `fabric` block is issued the per-app secret (extends the `sso||notify||stripe||domain`
condition via `needsFabricSecret`, in both install and the update reconcile). Grants persist in
`meta.json` as `fabricProvides` / `fabricConsumes` and surface through `fabricEntries()`/`FabricApp`.

### Divergences from the original work order (A)

- The original said "mirror in `validate-compose.mjs`". Reality: `fabric:` is a **manifest** key, not a
  compose directive — the mirror belongs in **`OpenMasjidAPPS/scripts/build-catalog.mjs`** (manifest
  shape), and `validate-compose.mjs` is unchanged. See the change list at the end.
- There was a **naming collision**: `InstalledApp.fabric` (a boolean = `sso||notify`, drives the
  appearance hand-off on Open) already existed. The broker uses distinct fields
  (`meta.fabricProvides/fabricConsumes`, `FabricApp.provides/consumes`) — the old boolean is untouched.
- Broker is **catalog-app ↔ catalog-app only** in v1 (custom/community apps get no per-app secret;
  `installStack` was not changed).
- The per-caller rate limiter is new (the existing `fabricRateOk` is per-IP, not per-caller).

## Work Package B — tunnel uplink (`tunnel: true`)

- **Exposure is per-app opt-in.** Before, `ingress.rebuild()` routed **every** app with a published
  port. Now it routes an app only when `meta.exposed !== false`. `undefined` (installed before this
  feature) is **grandfathered exposed**, so upgrading to v0.40.0 doesn't take a working app offline.
- **Admin consent = the Settings → Remote access per-app toggle** (`cloudflare.setExposed`), which
  defaults from the manifest `tunnel:true` request. New installs default **not exposed** (`store.install`
  accepts an `expose` flag; the manifest request is surfaced in the UI). *(Decision 1c + grandfather —
  chosen over a bespoke install-dialog toggle; nothing is public without the admin's explicit toggle.)*
- **Correction (v0.45.0): the manifest request was never actually surfaced.** Decision 1c was only
  half-built — `store.install` accepted `expose`, but no UI ever sent it and nothing read `app.tunnel`,
  so `installCatalogApp` always saw `undefined` and a `tunnel:true` app installed silently un-exposed
  with an empty `OPENMASJID_PUBLIC_URL`. An app whose whole purpose needs absolute public links (e.g.
  emailed parent-portal invites) therefore broke with no signal to the admin. Fixed by making the
  Store **ask**: an app with `tunnel:true` always opens the install dialog — even with no `settings:`,
  which is exactly the one-click path that used to drop the request — and shows a single pre-ticked
  checkbox ("Share this app over the internet"), warning when Remote access isn't configured yet.
  The default stays *the app's stated need, shown and confirmable*, not a silent auto-expose:
  `installCatalogApp` still requires `expose === true`, so the invariant "nothing is public without
  the admin's explicit toggle" is unchanged — the admin is now simply *asked*.
- **Discoverability of the recovery path (v0.45.0).** The per-app "Shared online" toggles used to sit
  inside the collapsed "How to set this up" `<details>` in Settings → Remote access — i.e. the fix for
  a declined/missed install-time question was hidden behind a setup guide. They are now always visible
  in that panel, and the same switch (plus the app's live public URL) appears on the app's own detail
  page, which is where an admin wondering "why can't parents reach this?" actually looks.
- **`/fabric/*` is refused over the tunnel** on BOTH the HTTP and WebSocket ingress paths
  (`isFabricSubpath`, matched on the app-relative path after the segment) — LAN-only.
- **`OPENMASJID_PUBLIC_URL`** is injected into the app's `.env` (empty when not exposed / tunnel off),
  reconciled on install, update, `setExposed`, and any tunnel enable/disable/domain/path change
  (`reconcilePublicUrls` → reup). The **live** source of truth stays `GET /api/fabric/site`
  (`appPublicUrl`, gated on `isRouted`); the env var is a convenience mirror computed from the
  *intended* exposure (`intendedPublicUrl`) so a freshly-exposed app has a stable value immediately.

### Divergences from the original work order (B)

- The work order framed a "confirm at install" dialog toggle; we chose the **Settings per-app toggle
  defaulting from the manifest** (decision 1c) + grandfathering, so existing installs keep working.
- `OPENMASJID_PUBLIC_URL` did not exist and there was no expose/un-expose lifecycle — both are new.

## Non-goals (unchanged)

No durable event bus/queue in the core; no app-to-app calls that bypass the broker; no service
discovery exposed to apps; no changes to SSO/notify/appearance/Stripe beyond docs cross-references.

## OpenMasjidAPPS mirror (separate repo — copy-ready)

`validate-compose.mjs` needs **no** change. In `scripts/build-catalog.mjs`, after the existing
category check and before `apps.push({...})`:

1. **Validate `m.fabric`** (if present): must be an object; `provides` (if present) an array of
   `{ capability }` where `capability` matches `^[a-z0-9][a-z0-9-]{0,39}$`; `consumes` (if present) an
   array of strings matching `^<APP_ID_RE>/<capability>$` — else `fail()` with a friendly message.
   (Do **not** copy the `=== true ? true : undefined` idiom — that silently drops malformed shapes.)
2. **Validate `m.tunnel`** (if present): `typeof === 'boolean'` else `fail()`.
3. **Emit both keys** into the `apps.push({...})` object: `fabric: <validated>` and
   `tunnel: m.tunnel === true ? true : undefined` (the clean pass drops `undefined`).
4. Document `fabric:`/`tunnel:` in `docs/BUILDING_AN_APP.md` (currently silent on both).
