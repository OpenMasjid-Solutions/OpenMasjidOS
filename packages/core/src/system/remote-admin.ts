// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Remote administration: serving the dashboard over the Cloudflare tunnel.
 *
 * This is the one place that decides whether that is allowed, and the one place
 * that says which paths the dashboard owns. Both are security decisions and this
 * codebase has twice shipped a second, subtly different copy of a check like
 * this (CLAUDE.md §15's raw-vs-decoded bullet, and the front door's own
 * hand-rolled `x-forwarded-proto` comparison). A second factor that is required
 * or not depending on which copy answered is not a second factor.
 *
 * ── WHAT THIS DELIBERATELY BREAKS ──────────────────────────────────────────
 *
 * CLAUDE.md §15 said, for a long time and as its first line on the subject:
 *
 *   > The Cloudflare tunnel exposes ONLY app paths. The dashboard, tRPC, and the
 *   > secret-gated Fabric routes stay LAN-only.
 *
 * The first half is now conditional — at the masjid's explicit request, behind a
 * switch that is off by default. **The second half does not move and must not.**
 * `/api/fabric/*` and `/api/auth/session` carry every app's 256-bit Fabric secret
 * and every configured Stripe live key; `registerFabricTunnelGuard` runs on both
 * listeners regardless of this feature's state, and `isDashboardPath` below
 * deliberately claims nothing under `/api`.
 *
 * ── FAIL CLOSED ON EVERY PRECONDITION, AT REQUEST TIME ─────────────────────
 *
 * `remoteAdminEnabled()` re-checks all three conditions on every request rather
 * than trusting that they were true when the switch was flipped. The one that
 * matters is `twoFactorActive()`: an admin who later turns two-step sign-in off
 * closes this door in the same action, automatically, without having to know
 * that the two settings are connected. Checking it only at toggle time would
 * leave a masjid with a password-only admin dashboard on the public internet and
 * nothing on screen to say so.
 *
 * It is also why `login` refuses tunnel traffic outright when no factor is
 * enrolled (`routers/auth.ts`): that is the backstop for every path that does
 * not come through here.
 */
import { getSettings } from '../settings/store';
import { twoFactorActive } from '../auth/twofactor';
import { decodedPath, resolveDotSegments } from './via-tunnel';

/**
 * May the dashboard be served over the tunnel right now?
 *
 * Three conditions, all re-read per request:
 *  - the tunnel is on at all (no point otherwise, and it keeps the two in step);
 *  - the admin switched remote administration on;
 *  - a second factor is enrolled, so a remote sign-in can actually demand one.
 */
export function remoteAdminEnabled(): boolean {
  const cf = getSettings().cloudflare;
  return Boolean(cf.enabled) && Boolean(cf.remoteAdmin) && twoFactorActive();
}

/**
 * Whether the switch COULD be turned on — surfaced to Settings so the reason is
 * visible before the admin presses something that refuses.
 */
export function remoteAdminBlockedReason(): 'no-two-factor' | 'no-tunnel' | null {
  if (!twoFactorActive()) return 'no-two-factor';
  if (!getSettings().cloudflare.enabled) return 'no-tunnel';
  return null;
}

/**
 * The first path segments the dashboard owns.
 *
 * AN ALLOW-LIST, NOT "EVERYTHING THAT IS NOT AN APP". The difference matters for
 * two reasons. It keeps the surface published to the internet to what was
 * actually decided rather than whatever happens to be registered. And it leaves
 * every other address still refused — so "Recently turned away" goes on being
 * the diagnostic it was, instead of every wrong address silently getting the
 * admin sign-in page. A donor who mistypes the donations path should see "there
 * is no page here", not a login box for the masjid's server.
 *
 * `test/remote-admin.test.ts` reads `Root.tsx` and fails if a UI route is added
 * whose segment is not here — otherwise that page would simply 404 remotely,
 * with nothing to say why.
 */
export const DASHBOARD_SEGMENTS = [
  'trpc', // the API itself (HTTP + WebSocket subscriptions)
  'assets', // Vite's fingerprinted bundles
  'store',
  'apps',
  'files',
  'settings',
  'design-system',
] as const;

/** Files the built UI serves from its root. */
const DASHBOARD_ROOT_FILES = ['/index.html', '/favicon.svg', '/ambient.mp4'];

function firstSegment(path: string): string {
  for (const part of path.split('/')) if (part) return part;
  return '';
}

/**
 * Is this a path the dashboard owns?
 *
 * Tested against the raw spelling, the decoded one AND the dot-resolved ones,
 * because the router dispatches on the decoded path and a framework downstream
 * may resolve `.`/`..`. This is the same three-spellings rule `isFabricSubpath`
 * documents, applied here — but note the direction is reversed and so is the
 * failure mode: this predicate ALLOWS, so it must be true for every spelling
 * rather than any. `/%74rpc/…` reaching the tRPC handler while this said "not a
 * dashboard path" would mean the gate never ran on it.
 *
 * Nothing under `/api` is ever a dashboard path. Those routes — health, ready,
 * the Fabric, the public appearance and logo — each own their tunnel rules, and
 * the secret-gated ones are refused by a guard that runs before this one.
 */
export function isDashboardPath(url: string): boolean {
  const raw = url.split('?')[0]!.split('#')[0]!;
  const spellings = [raw, decodedPath(url), resolveDotSegments(raw), resolveDotSegments(decodedPath(url))];
  if (spellings.some((p) => p.startsWith('/api/') || p === '/api')) return false;
  return spellings.every((p) => {
    if (p === '/' || p === '') return true;
    if (DASHBOARD_ROOT_FILES.includes(p)) return true;
    const seg = firstSegment(p);
    return (DASHBOARD_SEGMENTS as readonly string[]).includes(seg);
  });
}

/**
 * Paths that exist in the dashboard but CANNOT work over the tunnel, because the
 * routes behind them are registered on the LAN listener alone and stay there.
 *
 * Kept as data so the UI can be told rather than having to guess, and so the
 * list is somewhere a person can read. What is missing remotely, and why:
 *
 *  - **The File Explorer** browses the data directory, which is also the
 *    platform's control plane — `config/` holds the admin password hash, the
 *    Stripe keys, the tunnel token and the TLS private key, and `apps/<id>/`
 *    holds the compose file that `startApp` runs (CLAUDE.md §15). It is guarded
 *    server-side, but the guard's job is to stop an authenticated LAN session
 *    reaching those files, not to make the whole surface safe to publish.
 *  - **Terminals** are a root shell into the core, which runs as root with the
 *    Docker socket. That is not something to put on the internet behind one
 *    switch, however well authenticated.
 *  - **Backup download and restore** move an archive containing every secret the
 *    platform holds. Unencrypted, today (§15).
 *
 * None of these is a hard "never". Each is a deliberate decision to expose the
 * management surface first and revisit the rest with its own argument, rather
 * than to publish everything that happened to be registered.
 */
export const LAN_ONLY_FEATURES = ['files', 'terminals', 'backups'] as const;
export type LanOnlyFeature = (typeof LAN_ONLY_FEATURES)[number];
