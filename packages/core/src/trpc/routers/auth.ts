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

// Login throttle. A hard per-IP LOCKOUT is the wrong tool here: behind Docker's
// default port publishing every LAN client is SNATed to the bridge-gateway IP,
// so a lockout keyed on req.ip collapses to a single bucket an attacker can
// weaponise to deny the real admin (security audit). Instead we apply a growing
// per-attempt DELAY on consecutive FAILURES (global, reset on success): a wrong
// password just gets slower, while a correct password always succeeds with no
// delay — so brute-force is bounded (on top of argon2) but the admin can never
// be locked out.
const FAIL_DELAY_STEP_MS = 400;
const FAIL_DELAY_MAX_MS = 4_000;
let consecutiveFailures = 0;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
      const okUser = input.username === getUsername();
      // Always run argon2 verify (even for a wrong username) so response timing
      // doesn't reveal whether the username is correct.
      const okPass = await verifyPassword(getPasswordHash() ?? '', input.password);
      if (!okUser || !okPass) {
        consecutiveFailures += 1;
        // Slow down repeated failures without ever denying the real admin.
        await wait(Math.min(consecutiveFailures * FAIL_DELAY_STEP_MS, FAIL_DELAY_MAX_MS));
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'That username or password is incorrect.' });
      }
      consecutiveFailures = 0;
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
