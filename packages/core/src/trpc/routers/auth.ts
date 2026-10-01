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
  credentialFingerprint,
  freshCredential,
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
  attemptsLeft,
  clearChallenges,
} from '../../auth/login-challenge';
import { twoFactorRouter } from './twofactor';
import {
  clearIpFailures,
  ipLockedOut,
  ipLockoutRemaining,
  noteIpFailure,
} from '../../auth/ip-lockout';

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

/**
 * Check a username + password, and report WHICH password hash it was checked
 * against. The caller must confirm that hash is still current before minting a
 * session (see `freshCredential` in auth/sessions.ts): argon2 is awaited, and a
 * password change landing during that await would otherwise mint a session bound
 * to the NEW password for someone who only knew the old one.
 */
async function verifyCredentials(username: string, password: string): Promise<{ ok: boolean; cred: string }> {
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
    // Read FRESH, and captured before the await: this is the hash the password is
    // being checked against, and the one the resulting session must be bound to.
    const hash = getPasswordHash({ fresh: true });
    const okPass = await verifyPassword(hash ?? '', password);
    return { ok: okUser && okPass, cred: credentialFingerprint(hash) };
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
    /**
     * Is this session being used from OUTSIDE the masjid?
     *
     * The UI needs it because some of the dashboard genuinely is not there over
     * the tunnel: the File Explorer, the terminals and backup/restore are
     * registered on the LAN listener alone and stay that way
     * (`system/remote-admin.ts` LAN_ONLY_FEATURES says why for each). Without
     * this the remote dashboard would show those buttons and then fail on them,
     * which reads as "the masjid's server is broken" rather than "that one is
     * only available on site".
     *
     * Presentation only. Nothing is authorised on the strength of it — every
     * one of those features is refused server-side by not being routed here at
     * all, which is a far stronger guarantee than a hidden button.
     */
    remote: ctx.viaTunnel,
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
    const { token, csrf } = createSession(input.name, credentialFingerprint(hash));
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
      // PER-IP lockout, for tunnel traffic only. This is the one place the
      // platform can tell clients apart: Cloudflare sets CF-Connecting-IP at its
      // edge and a tunnel client cannot forge it, whereas on the LAN every
      // client is SNATed to the bridge gateway and they all look identical
      // (auth/ip-lockout.ts, util/net.ts). Checked FIRST, so a guesser is
      // refused without occupying the verify mutex or spending an argon2 hash.
      if (ctx.viaTunnel && ipLockedOut(ctx.remoteIp)) {
        const mins = Math.ceil(ipLockoutRemaining(ctx.remoteIp) / 60_000);
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: `Too many attempts from this connection. Please try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
        });
      }
      // Opt-in hard cooldown (exposed instances): reject fast without occupying
      // the verify mutex or spending an argon2 hash.
      if (LOCKOUT_ENABLED && Date.now() < cooldownUntil) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many attempts. Please wait a minute and try again.',
        });
      }
      const verified = await verifyCredentials(input.username, input.password);
      // A password that was right when checked but has been CHANGED since (during
      // argon2) is not a valid sign-in now. Treated exactly as a wrong password.
      // Read FRESH: the throttled copy can still be the old hash for a second after
      // the installer's Reset sign-in replaced it from another process.
      const ok = verified.ok && verified.cred === freshCredential();
      if (!ok) {
        noteIpFailure(ctx.remoteIp);
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
      // A correct password clears the address's history. The second factor still
      // has to pass, and its failures are counted separately below — but someone
      // who knows the password is not who this counter is aimed at.
      clearIpFailures(ctx.remoteIp);

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
        // The challenge carries the credential the password was verified against,
        // so completing it after a password change cannot mint a session bound to
        // the NEW password (completeLogin checks it).
        const challenge = createChallenge(input.username, {
          cred: verified.cred,
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

      // Bound to the hash that was VERIFIED, not re-read: see createSession.
      const { token, csrf } = createSession(input.username, verified.cred);
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
      // The second factor is six digits, so it is the CHEAPER target of the two
      // and must not be the one left uncounted. Same per-IP bound as the
      // password step, checked before the challenge is even looked up.
      if (ctx.viaTunnel && ipLockedOut(ctx.remoteIp)) {
        const mins = Math.ceil(ipLockoutRemaining(ctx.remoteIp) / 60_000);
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: `Too many attempts from this connection. Please try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
        });
      }
      const origin = { viaTunnel: ctx.viaTunnel, remoteIp: ctx.remoteIp };
      const claim = claimChallenge(input.challenge, origin);
      if (!claim.ok) {
        /**
         * THE CHALLENGE IS GONE, SO SAY SO AS A STATE CHANGE RATHER THAN AN ERROR.
         *
         * This used to throw "That sign-in attempt has expired. Please start
         * again." for all four reasons, and it produced a genuine dead end that
         * reached a masjid. Five wrong codes destroyed the challenge; every
         * attempt afterwards said "expired" — seconds after starting, which the
         * admin knew was untrue — while the primary button on screen stayed
         * "Sign in", an action that could never again succeed. They pressed it
         * repeatedly, which is exactly what the screen invited.
         *
         * So `restart` is returned rather than thrown: the UI can act on it and
         * take them back to the password step, instead of parsing a sentence.
         * "Too many tries" is told apart from the rest because it is the one the
         * admin can do something about, and it discloses nothing — reaching here
         * at all required holding a challenge, which required the password. The
         * other three stay merged on the original reasoning: an unknown id, a
         * genuinely expired one and one being moved between origins have nothing
         * useful to tell them apart for whoever is asking.
         */
        const tooMany = claim.reason === 'too-many-attempts';
        log.warn(`Two-step sign-in could not be completed: ${claim.reason}.`);
        return {
          authenticated: false as const,
          restart: true as const,
          username: null,
          csrf: null,
          triesLeft: 0,
          message: tooMany
            ? 'Too many wrong codes. Start again and sign in from the beginning.'
            : 'That sign-in attempt is no longer valid. Please start again.',
        };
      }

      const result = verifySecondFactor(input.code);
      if (!result.ok) {
        noteFailedAttempt(input.challenge);
        noteIpFailure(ctx.remoteIp);
        // A replay is logged distinctly — an operator reading this can tell
        // "they typed it twice" from "someone is working through codes" — but
        // the admin sees one message either way.
        if (result.reason === 'replayed') {
          log.warn('Two-step sign-in: a code was re-used. Refused.');
        }
        const left = attemptsLeft(input.challenge);
        /**
         * A DRIFTED SERVER CLOCK AND A MISTYPED CODE LOOK IDENTICAL, and they
         * have opposite fixes. `clockSkewSteps` searches a far wider window than
         * we accept and reports what it finds — the code is still refused — so
         * an admin whose box drifted is told the one thing that explains it
         * rather than watching five correct codes be rejected. The HTTP Date
         * header already states this server's clock, so this discloses nothing.
         */
        let skewNote = '';
        if (result.skewSteps != null && Math.abs(result.skewSteps) >= 2) {
          const mins = Math.round((Math.abs(result.skewSteps) * 30) / 60);
          const dir = result.skewSteps < 0 ? 'fast' : 'slow';
          skewNote =
            mins >= 1
              ? ` That code would have been right if this server's clock were correct — it looks about ${mins} minute${mins === 1 ? '' : 's'} ${dir}.`
              : ` That code would have been right if this server's clock were correct — it is about half a minute ${dir}.`;
          log.warn(
            `Two-step sign-in: a code was refused, but it matches ${result.skewSteps} step(s) away. This server's clock is probably wrong.`,
          );
        }
        await wait(Math.min(CHALLENGE_MAX_ATTEMPTS * FAIL_DELAY_STEP_MS, FAIL_DELAY_MAX_MS));
        if (left <= 0) {
          // The attempt that used up the last try. Send them back now rather
          // than letting the NEXT press discover it — that press is the one
          // that used to report "expired" and strand them.
          return {
            authenticated: false as const,
            restart: true as const,
            username: null,
            csrf: null,
            triesLeft: 0,
            message: `That code is not right, and that was the last try.${skewNote} Start again and sign in from the beginning.`,
          };
        }
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: `That code is not right — ${left} ${left === 1 ? 'try' : 'tries'} left.${skewNote}`,
        });
      }

      // The password changed while this sign-in waited for its second factor (up to
      // ten minutes). The password it proved is no longer the password: start again.
      if (claim.cred !== freshCredential()) {
        consumeChallenge(input.challenge);
        log.warn('Two-step sign-in could not be completed: the password changed while it was waiting.');
        return {
          authenticated: false as const,
          restart: true as const,
          username: null,
          csrf: null,
          triesLeft: 0,
          message: 'Your password was changed while you were signing in. Please start again.',
        };
      }
      consumeChallenge(input.challenge);
      clearIpFailures(ctx.remoteIp);
      const { token, csrf } = createSession(claim.username, claim.cred);
      ctx.setSessionCookie?.(token);
      log.info(`Two-step sign-in completed using ${result.used}.`);
      return {
        authenticated: true as const,
        restart: false as const,
        username: claim.username,
        csrf,
        triesLeft: CHALLENGE_MAX_ATTEMPTS,
        message: null,
      };
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
      // Captured before the await, and compared again after it: two changes racing
      // (or a reset made by the installer meanwhile) must not both go through.
      const hash = getPasswordHash({ fresh: true });
      const ok = await verifyPassword(hash ?? '', input.currentPassword);
      if (!ok) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Your current password is incorrect.' });
      }
      const nextHash = await hashPassword(input.newPassword);
      if (getPasswordHash({ fresh: true }) !== hash) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Your password was changed somewhere else a moment ago. Please sign in again.',
        });
      }
      updatePasswordHash(nextHash);
      destroyAllSessions();
      // A remote sign-in waiting for its second factor proved the OLD password.
      // completeLogin would refuse it anyway (the credential no longer matches);
      // clearing it here means it is gone rather than merely refused.
      clearChallenges();
      const { token, csrf } = createSession(ctx.username, credentialFingerprint(nextHash));
      ctx.setSessionCookie?.(token);
      return { ok: true, csrf };
    }),

  /**
   * Managing the second factor (Settings → Account). Nested here because it is
   * part of signing in; its own file because every mutation in it re-proves the
   * admin, and that argument is long enough to want room to state.
   */
  twoFactor: twoFactorRouter,
});
