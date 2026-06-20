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

// Per-source login throttle. Keyed by client IP so a flood from one source can
// never lock out the legitimate admin (the previous global counter could).
// Backoff escalates with repeated failures and resets on success.
const MAX_ATTEMPTS = 5;
const BASE_COOLDOWN_MS = 30_000;
interface Attempt {
  failures: number;
  cooldownUntil: number;
}
const attempts = new Map<string, Attempt>();

function getAttempt(ip: string): Attempt {
  let a = attempts.get(ip);
  if (!a) {
    a = { failures: 0, cooldownUntil: 0 };
    attempts.set(ip, a);
  }
  return a;
}

function pruneAttempts(): void {
  if (attempts.size < 2000) return;
  const now = Date.now();
  for (const [ip, a] of attempts) {
    if (a.failures === 0 && a.cooldownUntil < now) attempts.delete(ip);
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
    const token = createSession(input.username);
    ctx.setSessionCookie?.(token);
    return { authenticated: true, username: input.username };
  }),

  /** Sign in with the admin credentials. */
  login: publicProcedure
    .input(z.object({ username: z.string().trim().min(1), password: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      if (!isConfigured()) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'No account yet — please set one up.' });
      }
      const attempt = getAttempt(ctx.ip);
      if (Date.now() < attempt.cooldownUntil) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many attempts. Please wait a moment and try again.',
        });
      }
      const okUser = input.username === getUsername();
      // Always run argon2 verify (even for a wrong username) so response timing
      // doesn't reveal whether the username is correct.
      const okPass = await verifyPassword(getPasswordHash() ?? '', input.password);
      if (!okUser || !okPass) {
        attempt.failures += 1;
        if (attempt.failures >= MAX_ATTEMPTS) {
          const steps = Math.min(8, attempt.failures - MAX_ATTEMPTS + 1);
          attempt.cooldownUntil = Date.now() + BASE_COOLDOWN_MS * steps;
        }
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'That username or password is incorrect.' });
      }
      attempt.failures = 0;
      attempt.cooldownUntil = 0;
      pruneAttempts();
      const token = createSession(input.username);
      ctx.setSessionCookie?.(token);
      return { authenticated: true, username: input.username };
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
      const token = createSession(ctx.username);
      ctx.setSessionCookie?.(token);
      return { ok: true };
    }),
});
