// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The half-authenticated state between "the password was right" and "the second
 * factor was right".
 *
 * The password is verified once and then thrown away; what the client holds
 * afterwards is an opaque challenge id, not the credentials. That matters for
 * three reasons: the browser never has to keep the password around to re-send
 * with the code, a second argon2 verify is not spent on every code attempt (which
 * would be a free CPU-exhaustion lever on an internet-facing login), and the
 * challenge can carry constraints the password never could — see `viaTunnel`.
 *
 * DELIBERATELY IN MEMORY, NOT ON DISK. A restart invalidating a sign-in that is
 * halfway through is the correct outcome: it costs an admin one retry and it
 * means a half-authenticated token can never outlive the process that issued it,
 * or be recovered from a backup archive. Nothing here is worth persisting.
 *
 * BOUND TO ITS ORIGIN. A challenge issued to a tunnel request can only be
 * completed by a tunnel request, and vice versa. Without that the two paths are
 * one: start a sign-in from the LAN (where the second factor is not required, by
 * design) and finish it over the tunnel, or start it over the tunnel and
 * complete it from a LAN foothold that never had to prove anything.
 */
import crypto from 'node:crypto';
import { timingSafeEqualString } from './totp';

/**
 * How long an admin has to fetch a code and type it. Long enough for an email to
 * arrive on a slow provider, short enough that a challenge left open on a shared
 * machine is not a standing invitation.
 */
export const CHALLENGE_TTL_MS = 10 * 60 * 1000;
/** Wrong second factors against ONE challenge before it is destroyed. */
export const CHALLENGE_MAX_ATTEMPTS = 5;

interface Challenge {
  id: string;
  username: string;
  /** The origin this challenge was issued to. Completion must match. */
  viaTunnel: boolean;
  /** Cloudflare's client IP when over the tunnel; null otherwise. */
  remoteIp: string | null;
  /** Fingerprint of the password hash the password was verified against. */
  cred: string;
  expiresAt: number;
  attempts: number;
}

const pending = new Map<string, Challenge>();

function sweep(now: number): void {
  for (const [id, c] of pending) if (now > c.expiresAt) pending.delete(id);
}

/** Mint a challenge for a username whose password has just been verified. */
export function createChallenge(
  username: string,
  origin: { viaTunnel: boolean; remoteIp: string | null; cred?: string },
  nowMs: number = Date.now(),
): string {
  sweep(nowMs);
  const id = crypto.randomBytes(32).toString('base64url');
  pending.set(id, {
    id,
    username,
    viaTunnel: origin.viaTunnel,
    remoteIp: origin.remoteIp,
    // Absent only for direct callers (tests). An empty credential never matches a
    // real fingerprint, so such a challenge can never complete into a session.
    cred: origin.cred ?? '',
    expiresAt: nowMs + CHALLENGE_TTL_MS,
    attempts: 0,
  });
  return id;
}

export type ClaimResult =
  | { ok: true; username: string; cred: string }
  | { ok: false; reason: 'unknown' | 'expired' | 'wrong-origin' | 'too-many-attempts' };

/**
 * Look a challenge up for a completion attempt, checking everything except the
 * code itself. Does NOT consume it — the caller spends it with `consume` only
 * once the second factor has actually verified, so a wrong code costs an attempt
 * rather than the whole challenge.
 *
 * An unknown id and an expired one answer identically to the caller. There is
 * nothing to learn from the difference and it is one fewer oracle.
 */
export function claimChallenge(
  id: string,
  origin: { viaTunnel: boolean; remoteIp: string | null },
  nowMs: number = Date.now(),
): ClaimResult {
  // Look up BEFORE sweeping. Sweeping first deletes the very challenge we are
  // about to report on, so a genuinely expired one came back as "unknown" —
  // identical to the caller, but it costs an operator reading the log the
  // difference between "they were too slow" and "that id was never ours".
  // Constant-time lookup is pointless here — the id is a 256-bit random value
  // and Map lookup is the same shape for hit and miss — but the COMPARISON of a
  // found id is done safely anyway, so a future change to a shorter id does not
  // quietly introduce a timing oracle.
  const c = pending.get(id);
  sweep(nowMs);
  if (!c || !timingSafeEqualString(c.id, id)) return { ok: false, reason: 'unknown' };
  if (nowMs > c.expiresAt) {
    pending.delete(id);
    return { ok: false, reason: 'expired' };
  }
  if (c.viaTunnel !== origin.viaTunnel) {
    // Not merely refused — destroyed. A challenge someone is trying to move
    // between origins is not one to leave lying around for another attempt.
    pending.delete(id);
    return { ok: false, reason: 'wrong-origin' };
  }
  if (c.attempts >= CHALLENGE_MAX_ATTEMPTS) {
    pending.delete(id);
    return { ok: false, reason: 'too-many-attempts' };
  }
  return { ok: true, username: c.username, cred: c.cred };
}

/**
 * Record a wrong second factor.
 *
 * DELIBERATELY DOES NOT DELETE at the cap, and that is a fix rather than an
 * oversight. It used to, which made `claimChallenge`'s `too-many-attempts`
 * branch dead code: the entry was already gone, so the next attempt came back
 * `unknown` and the admin was told their sign-in had "expired" seconds after
 * starting it. Keeping the spent challenge until `claimChallenge` sees it means
 * they get told what actually happened. It grants nothing — a claim with the
 * attempts spent is refused — and `claimChallenge` deletes it at that point, so
 * nothing lingers beyond one more request or the TTL sweep, whichever is first.
 */
export function noteFailedAttempt(id: string): void {
  const c = pending.get(id);
  if (!c) return;
  c.attempts += 1;
}

/**
 * Wrong codes still allowed against this challenge. 0 when it is spent or gone.
 *
 * Surfaced to the admin, because "that code is not right" with no sense of how
 * much rope is left is what let someone walk into the wall above without ever
 * seeing it coming.
 */
export function attemptsLeft(id: string): number {
  const c = pending.get(id);
  if (!c) return 0;
  return Math.max(0, CHALLENGE_MAX_ATTEMPTS - c.attempts);
}

/** Spend a challenge. Single use — a completed sign-in cannot be replayed. */
export function consumeChallenge(id: string): void {
  pending.delete(id);
}

/** Drop every pending challenge. Used when 2FA is reconfigured, and by tests. */
export function clearChallenges(): void {
  pending.clear();
}

/** How many are outstanding — for tests and diagnostics only. */
export function pendingCount(): number {
  return pending.size;
}
