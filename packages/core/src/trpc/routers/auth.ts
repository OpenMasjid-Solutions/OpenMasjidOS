// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Auth & first-run. The very first visit creates the single admin account;
 * thereafter it's a plain login. Wrong credentials get a friendly, throttled
 * error (CLAUDE.md §9). No masjid/prayer details are collected here.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, publicProcedure, protectedProcedure } from '../trpc';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from '../../auth/passwords';
import {
  isConfigured,
  getUsername,
  getPasswordHash,
  setCredentials,
  updatePasswordHash,
} from '../../auth/store';
import {
  createSession,
  destroySession,
  destroyAllSessions,
} from '../../auth/sessions';

// Login throttle. Brute-force is bounded three ways:
//   1. argon2id's per-verify cost;
//   2. the verify is SERIALIZED (one credential check at a time) so a parallel
//      flood can't multiply throughput past that cost — the real rate cap;
//   3. a growing per-attempt DELAY on consecutive failures (reset on success).
// A hard lockout stays OFF by default: behind Docker's port publishing every LAN
// client is SNATed to the bridge-gateway IP, so a global lockout would let an
// attacker deny the real admin. Operators who expose the dashboard to the
// internet can opt in with OPENMASJID_LOGIN_LOCKOUT=1 (a strong setup password is
// still the primary defence). The delay is applied OUTSIDE the serialization
// mutex, so the admin's correct attempt is never queued behind attacker delays.
const FAIL_DELAY_STEP_MS = 500;
const FAIL_DELAY_MAX_MS = 5_000;
const LOCKOUT_ENABLED = process.env.OPENMASJID_LOGIN_LOCKOUT === '1';
const LOCKOUT_THRESHOLD = 10; // consecutive failures before the opt-in cooldown
const LOCKOUT_MS = 60_000;
let consecutiveFailures = 0;
let cooldownUntil = 0;
// Mutex chain: each credential check awaits the previous, so verifies run
// strictly one-at-a-time regardless of request concurrency.
let verifyGate: Promise<void> = Promise.resolve();

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function verifyCredentials(username: string, password: string): Promise<boolean> {
  let release!: () => void;
  const prev = verifyGate;
  verifyGate = new Promise<void>((r) => (release = r));
  await prev;
  try {
    const okUser = username === getUsername();
    // Always run argon2 verify (even for a wrong username) so response timing
    // doesn't reveal whether the username is correct.
    const okPass = await verifyPassword(getPasswordHash() ?? '', password);
    return okUser && okPass;
  } finally {
    release();
  }
}

const credentials = z.object({
  username: z.string().trim().min(1, 'Please enter a username.').max(64),
  password: z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`),
});

export const authRouter = router({
  /** Drives first-run vs login, and reports who is signed in. */
  me: publicProcedure.query(({ ctx }) => ({
    setupRequired: !isConfigured(),
    authenticated: Boolean(ctx.username),
    username: ctx.username,
  })),

  /** First-run only: create the admin account and start a session. */
  setup: publicProcedure.input(credentials).mutation(async ({ input, ctx }) => {
    if (isConfigured()) {
      throw new TRPCError({ code: 'CONFLICT', message: 'An account already exists. Please sign in.' });
    }
    const hash = await hashPassword(input.password);
    setCredentials(input.username, hash);
    const { token, csrf } = createSession(input.username);
    ctx.setSessionCookie?.(token);
    return { authenticated: true, username: input.username, csrf };
  }),

  /** Sign in with the admin credentials. */
  login: publicProcedure
    .input(z.object({ username: z.string().trim().min(1), password: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      if (!isConfigured()) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'No account yet — please set one up.' });
      }
      // Opt-in hard cooldown (exposed instances): reject fast without occupying
      // the verify mutex or spending an argon2 hash.
      if (LOCKOUT_ENABLED && Date.now() < cooldownUntil) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many attempts. Please wait a minute and try again.',
        });
      }
      const ok = await verifyCredentials(input.username, input.password);
      if (!ok) {
        consecutiveFailures += 1;
        if (LOCKOUT_ENABLED && consecutiveFailures >= LOCKOUT_THRESHOLD) {
          cooldownUntil = Date.now() + LOCKOUT_MS;
        }
        // Slow the failing response (outside the mutex, so a correct attempt is
        // never queued behind these delays).
        await wait(Math.min(consecutiveFailures * FAIL_DELAY_STEP_MS, FAIL_DELAY_MAX_MS));
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'That username or password is incorrect.' });
      }
      consecutiveFailures = 0;
      cooldownUntil = 0;
      const { token, csrf } = createSession(input.username);
      ctx.setSessionCookie?.(token);
      return { authenticated: true, username: input.username, csrf };
    }),

  /** Sign out: drop this session and clear the cookie. */
  logout: publicProcedure.mutation(({ ctx }) => {
    destroySession(ctx.sessionToken);
    ctx.clearSessionCookie?.();
    return { authenticated: false };
  }),

  /** Change the admin password; every existing session is invalidated. */
  changePassword: protectedProcedure
    .input(
      z.object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const ok = await verifyPassword(getPasswordHash() ?? '', input.currentPassword);
      if (!ok) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Your current password is incorrect.' });
      }
      updatePasswordHash(await hashPassword(input.newPassword));
      destroyAllSessions();
      const { token, csrf } = createSession(ctx.username);
      ctx.setSessionCookie?.(token);
      return { ok: true, csrf };
    }),
});
