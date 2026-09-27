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
  isAuthStoreDamaged,
  getUsername,
  getPasswordHash,
  getAdminEmail,
  getAdminPhone,
  getAdminName,
  createAdminIfUnset,
  setProfile,
  updatePasswordHash,
} from '../../auth/store';
import {
  createSession,
  destroySession,
  destroyAllSessions,
} from '../../auth/sessions';
import { toDigits } from '../../notify/whatsapp';
import { sendEmail } from '../../notify/email';
import { log } from '../../logger';
import {
  availableFactors,
  issueEmailCode,
  twoFactorActive,
  verifySecondFactor,
  type SecondFactorKind,
} from '../../auth/twofactor';
import {
  CHALLENGE_MAX_ATTEMPTS,
  claimChallenge,
  consumeChallenge,
  createChallenge,
  noteFailedAttempt,
} from '../../auth/login-challenge';

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
    // The login identifier matches EITHER the stored username (older installs used a
    // plain username; new installs set it = the email) OR the admin email (so once an
    // older install sets an email in Settings → Account, they can use that too).
    const id = username.trim();
    const adminEmail = getAdminEmail();
    const okUser =
      id === getUsername() ||
      (adminEmail != null && adminEmail !== '' && id.toLowerCase() === adminEmail.toLowerCase());
    // Always run argon2 verify (even for a wrong identifier) so response timing
    // doesn't reveal whether it was correct.
    const okPass = await verifyPassword(getPasswordHash() ?? '', password);
    return okUser && okPass;
  } finally {
    release();
  }
}

const emailField = z.string().trim().max(254).email('Please enter a valid email address.');

const setupInput = z.object({
  name: z.string().trim().min(1, 'Please enter your name.').max(80),
  email: emailField,
  password: z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`),
});

export const authRouter = router({
  /** Drives first-run vs login, and reports who is signed in. */
  me: publicProcedure.query(({ ctx }) => ({
    setupRequired: !isConfigured(),
    authenticated: Boolean(ctx.username),
    username: ctx.username,
    // Only surface the admin's profile to an authenticated session (never leak the
    // admin email to an unauthenticated visitor).
    name: ctx.username ? getAdminName() : null,
    email: ctx.username ? getAdminEmail() : null,
    // Same rule as the email: a phone number is personal data, so it is surfaced only
    // to a signed-in session, never to a visitor sitting on the login screen.
    phone: ctx.username ? getAdminPhone() : null,
  })),

  /**
   * First-run only: create the admin account (name + email + password) and start a
   * session.
   *
   * The NAME is the login username; the email is stored so OS alerts have somewhere
   * to go, and is accepted as an alternative login id by `verifyCredentials`
   * (CLAUDE.md §9). This used to say the email WAS the identifier, contradicting a
   * comment eighteen lines below in the same procedure.
   */
  setup: publicProcedure.input(setupInput).mutation(async ({ input, ctx }) => {
    if (isAuthStoreDamaged()) {
      // Fail closed, but say something a volunteer can act on rather than the
      // misleading "an account already exists". Recovery needs host access on
      // purpose — that is what stops a passer-by claiming a damaged box.
      throw new TRPCError({
        code: 'CONFLICT',
        message:
          "This server's admin account file can't be read, so a new account can't be created here — that would let anyone take over. Ask whoever set this up to run the OpenMasjidOS password reset on the machine itself.",
      });
    }
    if (isConfigured()) {
      throw new TRPCError({ code: 'CONFLICT', message: 'An account already exists. Please sign in.' });
    }
    const hash = await hashPassword(input.password);
    // Compare-and-set: if a concurrent first-run request won the race while we were
    // hashing (argon2 awaits above), don't clobber the admin it created. The NAME is
    // the login username; the email is stored ONLY for sending OS alerts (not the
    // login identifier) — matching pre-email installs, which log in by username.
    if (!createAdminIfUnset({ username: input.name, email: input.email, name: input.name, passwordHash: hash })) {
      throw new TRPCError({ code: 'CONFLICT', message: 'An account already exists. Please sign in.' });
    }
    const { token, csrf } = createSession(input.name);
    ctx.setSessionCookie?.(token);
    return { authenticated: true, username: input.name, csrf };
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

      /**
       * THE SECOND FACTOR IS REQUIRED ON TUNNEL TRAFFIC ONLY, at Hasan's
       * direction: a volunteer on the masjid's own network should not be locked
       * out of the dashboard by a phone they left at home.
       *
       * Be clear about what that does and does not buy, because the honest
       * statement is weaker than it sounds. `viaTunnel` is a deny-list on a
       * header Cloudflare sets at its edge; it is sound for traffic that really
       * came through the tunnel. It cannot tell the LAN from the internet on a
       * box whose ports 80/443 are directly reachable — a public-IP VPS, or a
       * router forwarding them — because such a request carries no Cloudflare
       * headers and looks exactly like the office laptop. CLAUDE.md §15 already
       * says this about the LAN-only guard, and `util/net.ts` records why a
       * source-address check cannot fix it (Docker SNATs everything to the
       * bridge gateway).
       *
       * So: this protects the tunnel, which is the door being deliberately
       * opened. It is not a substitute for a firewall on a directly-reachable
       * host, and docs/SECURITY.md must keep saying so.
       */
      if (ctx.viaTunnel) {
        // Fail CLOSED. If a tunnel request reaches the login at all and no second
        // factor is enrolled, refuse — rather than handing out a session because
        // the feature that was supposed to gate this is half-configured. The
        // setting that opens the door will require enrolment first (Slice 3);
        // this is the backstop for every path that does not go through it.
        if (!twoFactorActive()) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Signing in from outside the masjid needs two-step sign-in set up first.',
          });
        }
        const challenge = createChallenge(input.username, {
          viaTunnel: true,
          remoteIp: ctx.remoteIp,
        });
        // No session, no cookie. The caller holds an opaque id, not credentials.
        return {
          authenticated: false as const,
          username: input.username,
          csrf: null,
          needsSecondFactor: true as const,
          challenge,
          factors: availableFactors(),
        };
      }

      const { token, csrf } = createSession(input.username);
      ctx.setSessionCookie?.(token);
      return {
        authenticated: true as const,
        username: input.username,
        csrf,
        needsSecondFactor: false as const,
        challenge: null,
        factors: [] as SecondFactorKind[],
      };
    }),

  /**
   * Finish a sign-in that was held for a second factor.
   *
   * Deliberately a `publicProcedure`: there is no session yet, that is the whole
   * point. What stands in for one is the challenge — single-use, ten minutes,
   * five attempts, and bound to the origin it was issued to so a sign-in cannot
   * be started on one side of the boundary and finished on the other.
   */
  completeLogin: publicProcedure
    .input(z.object({ challenge: z.string().min(1), code: z.string().trim().min(1).max(32) }))
    .mutation(async ({ input, ctx }) => {
      const origin = { viaTunnel: ctx.viaTunnel, remoteIp: ctx.remoteIp };
      const claim = claimChallenge(input.challenge, origin);
      if (!claim.ok) {
        // One message for every reason. An unknown id, an expired one and one
        // being moved between origins are the same sentence to the caller —
        // there is nothing useful to learn from the difference.
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'That sign-in attempt has expired. Please start again.',
        });
      }

      const result = verifySecondFactor(input.code);
      if (!result.ok) {
        noteFailedAttempt(input.challenge);
        // A replay is logged distinctly — an operator reading this can tell
        // "they typed it twice" from "someone is working through codes" — but
        // the admin sees one message either way.
        if (result.reason === 'replayed') {
          log.warn('Two-step sign-in: a code was re-used. Refused.');
        }
        await wait(Math.min(CHALLENGE_MAX_ATTEMPTS * FAIL_DELAY_STEP_MS, FAIL_DELAY_MAX_MS));
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'That code is not right. Please try again.' });
      }

      consumeChallenge(input.challenge);
      const { token, csrf } = createSession(claim.username);
      ctx.setSessionCookie?.(token);
      log.info(`Two-step sign-in completed using ${result.used}.`);
      return { authenticated: true as const, username: claim.username, csrf };
    }),

  /**
   * Send the emailed code for a held sign-in.
   *
   * The challenge must already exist, so this cannot be used to make the server
   * send mail to the admin without first knowing the password. The per-minute
   * limit lives in `auth/twofactor.ts` and is an email-bomb guard as much as a
   * brute-force one.
   */
  sendLoginEmailCode: publicProcedure
    .input(z.object({ challenge: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const claim = claimChallenge(input.challenge, { viaTunnel: ctx.viaTunnel, remoteIp: ctx.remoteIp });
      if (!claim.ok) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'That sign-in attempt has expired. Please start again.',
        });
      }
      if (!availableFactors().includes('email')) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Emailed codes are not switched on.' });
      }
      const to = getAdminEmail();
      if (!to) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'There is no email address on the account.' });
      }
      const issued = issueEmailCode();
      if ('retryAfterMs' in issued) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'A code was just sent. Please check your email, or wait a moment before asking for another.',
        });
      }
      const sent = await sendEmail(
        {
          to,
          subject: 'Your OpenMasjidOS sign-in code',
          text: `Your sign-in code is ${issued.code}. It expires in 10 minutes.\n\nIf you did not try to sign in, someone has your password — change it as soon as you can.`,
        },
        'omos:platform',
      );
      if (!sent.sent) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: "We couldn't send that code. Please try the authenticator app instead." });
      }
      return { sent: true as const };
    }),

  /** Sign out: drop this session and clear the cookie. */
  logout: publicProcedure.mutation(({ ctx }) => {
    destroySession(ctx.sessionToken);
    ctx.clearSessionCookie?.();
    return { authenticated: false };
  }),

  /** Update the admin's display name, email and/or WhatsApp number (Settings →
   *  Account). The email is where OS alerts are sent; a pre-email install sets it
   *  here. The phone is the same idea for the WhatsApp channel — a destination only,
   *  never a login identifier. Does NOT change the login username (existing sessions
   *  keep working). */
  updateProfile: protectedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(80).optional(),
        email: emailField.optional(),
        /**
         * Stored as digits, so a number typed as "+1 (555) 010-1234" and the same
         * number typed as "15550101234" are one value rather than two that look
         * different to every comparison. An empty string clears it, which is how the
         * admin turns the WhatsApp destination off without touching the channel
         * toggles. A country code is required — `toDigits` refuses fewer than 8
         * digits rather than guessing one, because guessing sends a masjid's message
         * to a stranger.
         */
        phone: z
          .string()
          .trim()
          .max(24)
          .transform((v) => (v === '' ? '' : (toDigits(v) ?? '')))
          .refine((v) => v === '' || v.length >= 8, {
            message: 'That phone number needs a country code, e.g. +1 555 010 1234.',
          })
          .optional(),
      }),
    )
    .mutation(({ input }) => {
      setProfile(input);
      return { name: getAdminName(), email: getAdminEmail(), phone: getAdminPhone() };
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
