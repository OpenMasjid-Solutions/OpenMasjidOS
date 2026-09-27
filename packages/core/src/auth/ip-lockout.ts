// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Per-IP sign-in lockout, for tunnel traffic only.
 *
 * ── WHY THIS CAN EXIST HERE AND NOWHERE ELSE ────────────────────────────────
 *
 * The dashboard's existing lockout is GLOBAL and off by default, and
 * `trpc/routers/auth.ts` explains why: behind Docker's port publishing every LAN
 * client is SNATed to the bridge-gateway IP, so the platform cannot tell them
 * apart and a global lockout would let anyone on the network deny the real
 * admin. `util/net.ts` carries the measurement — an app container, host-network
 * cloudflared, and a client from outside the host entirely all presented as
 * `172.17.0.1` — and `test/ip-private.test.ts` fails the build if a peer check
 * comes back.
 *
 * Tunnel traffic is the one case where that does not apply. **Cloudflare sets
 * `CF-Connecting-IP` at its edge and a tunnel client cannot forge it** — the
 * same property that makes `cf-ray` usable for `isViaTunnel`. So remote sign-ins
 * can have a real per-IP lockout, which is strictly better than the global one:
 * it stops a guesser without giving them a way to lock the admin out.
 *
 * ── THE RULE THAT MAKES IT SAFE ─────────────────────────────────────────────
 *
 * **The address is only ever trusted when `isViaTunnel` is already true.** That
 * is enforced upstream, in `trpc/context.ts`, which sets `remoteIp` to null off
 * the tunnel rather than reading the header. On the LAN it is attacker-supplied:
 * honouring it would hand any client a way to walk past this counter by varying
 * one header, and — worse — a way to lock out an arbitrary address by failing
 * ten sign-ins while claiming to be it. Nothing in this file reads a header; it
 * takes an address the caller has already decided to trust, and does nothing at
 * all with `null`.
 */

/** Consecutive failures from one address before it is refused. */
export const IP_MAX_FAILURES = 10;
/** How long a locked-out address stays refused. */
export const IP_LOCKOUT_MS = 15 * 60 * 1000;
/** Failures older than this stop counting, so a slow typist never accumulates. */
export const IP_WINDOW_MS = 15 * 60 * 1000;
/**
 * Most addresses tracked at once.
 *
 * Bounded because this is a map keyed by something the internet chooses. Without
 * a cap, a spray from many addresses is an unauthenticated memory-growth lever
 * against a daemon running as root — the same shape as the abandoned-socket leak
 * `system/ingress.ts` destroys upgrades to avoid. When full, the least recently
 * seen entry is dropped: an attacker can therefore evict their own record, which
 * costs them nothing they did not already have (they could simply use a new
 * address), and cannot evict anyone else's in a way that matters, because an
 * evicted entry means "not locked out", which is where everyone starts.
 */
export const IP_MAX_TRACKED = 1000;

interface Entry {
  failures: number;
  /** When the most recent failure was seen — also the LRU key. */
  lastAt: number;
  /** Set once the threshold is crossed; refusals last until this passes. */
  lockedUntil: number;
}

const seen = new Map<string, Entry>();

function sweep(now: number): void {
  for (const [ip, e] of seen) {
    if (now > e.lockedUntil && now - e.lastAt > IP_WINDOW_MS) seen.delete(ip);
  }
  if (seen.size <= IP_MAX_TRACKED) return;
  // Still over the cap after sweeping: drop least-recently-seen first.
  const byAge = [...seen.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt);
  for (const [ip] of byAge.slice(0, seen.size - IP_MAX_TRACKED)) seen.delete(ip);
}

/** Is this address currently refused? `null` (off-tunnel) is never locked out. */
export function ipLockedOut(ip: string | null, nowMs: number = Date.now()): boolean {
  if (!ip) return false;
  const e = seen.get(ip);
  if (!e) return false;
  if (nowMs > e.lockedUntil) return false;
  return true;
}

/** How long until this address may try again, in ms. 0 when it is not locked. */
export function ipLockoutRemaining(ip: string | null, nowMs: number = Date.now()): number {
  if (!ip) return 0;
  const e = seen.get(ip);
  if (!e || nowMs > e.lockedUntil) return 0;
  return e.lockedUntil - nowMs;
}

/**
 * Record a failed sign-in from this address.
 *
 * Counts BOTH a wrong password and a wrong second factor: the whole point is to
 * bound guessing, and a second factor is six digits — far more guessable than a
 * password — so leaving it uncounted would put the cheaper target behind no
 * counter at all.
 */
export function noteIpFailure(ip: string | null, nowMs: number = Date.now()): void {
  if (!ip) return;
  const prev = seen.get(ip);
  // A stale run of failures does not carry forward: outside the window we start
  // again, so ten typos spread over a day never lock a real admin out.
  const failures = prev && nowMs - prev.lastAt <= IP_WINDOW_MS ? prev.failures + 1 : 1;
  seen.set(ip, {
    failures,
    lastAt: nowMs,
    lockedUntil: failures >= IP_MAX_FAILURES ? nowMs + IP_LOCKOUT_MS : (prev?.lockedUntil ?? 0),
  });
  // Bound AFTER inserting, not before. Sweeping first checks a size the new
  // entry is not in yet, so the map settles at the cap PLUS one for ever — an
  // off-by-one that a "roughly bounded" reading of the test would have missed.
  // The entry just written has the newest `lastAt`, so LRU eviction never drops
  // the one we are recording.
  sweep(nowMs);
}

/** A successful sign-in clears the address's history. */
export function clearIpFailures(ip: string | null): void {
  if (ip) seen.delete(ip);
}

/** Drop everything. Tests, and whenever remote administration is switched off. */
export function clearAllIpFailures(): void {
  seen.clear();
}

/** How many addresses are being tracked — for tests and diagnostics. */
export function trackedIpCount(): number {
  return seen.size;
}
