// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Managing the second factor from Settings → Account.
 *
 * Nested under `auth` (`trpc.auth.twoFactor.*`) rather than made a top-level
 * router: it is part of signing in, and the namespace is where an admin would
 * look for it. Its own file because `routers/auth.ts` is long enough, and
 * because nothing here may import from that file — `auth.ts` imports this one.
 *
 * ── THE RULE THIS FILE EXISTS TO ENFORCE ──────────────────────────────────
 *
 * EVERY MUTATION RE-PROVES THE PASSWORD, AND — ONCE A FACTOR IS ACTIVE — THE
 * CURRENT SECOND FACTOR TOO. A session is not enough.
 *
 * The attack this stops is not "turn 2FA off". Turning it off makes remote
 * sign-in fail CLOSED (`routers/auth.ts` refuses a tunnel login with no factor
 * enrolled), so it costs an attacker their own way in. The attack is the
 * opposite one: RE-ENROL. Someone who reaches an authenticated dashboard — a
 * stolen cookie, a borrowed unlocked laptop, a LAN password — mints a fresh
 * secret into *their* authenticator, and now they can sign in from anywhere in
 * the world, indefinitely, through the front door, while the admin's password
 * still works and nothing looks wrong.
 *
 * So the password check blocks the stolen-session case, and the current-factor
 * check blocks the stolen-password case. Neither alone covers both, which is
 * why both are here. The way back when the phone is genuinely lost is a backup
 * code — `verifySecondFactor` accepts one anywhere a TOTP code is accepted —
 * or `install.sh` → Reset sign-in, which needs physical access to the box.
 *
 * A code spent here is SPENT. `verifySecondFactor` advances the replay guard on
 * success, so the code that authorised a change cannot then be replayed to sign
 * in. That is the same property that makes it a second factor at all.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import { verifyPassword } from '../../auth/passwords';
import { getPasswordHash, getAdminEmail, getAdminName, getUsername } from '../../auth/store';
import { qrMatrix } from '../../auth/qr';
import { clearChallenges } from '../../auth/login-challenge';
import { isEmailConfigured } from '../../store/email';
import { log } from '../../logger';
import {
  BACKUP_CODE_COUNT,
  beginEnrolment,
  confirmEnrolment,
  disableTwoFactor,
  regenerateBackupCodes,
  setEmailFactor,
  twoFactorActive,
  twoFactorStatus,
  verifySecondFactor,
} from '../../auth/twofactor';

/** Password + (when one is enrolled) a current second factor. */
const sudo = z.object({
  password: z.string().min(1, 'Please enter your password.'),
  /** A TOTP code or a backup code. Required only when a factor is already active. */
  code: z.string().trim().max(32).optional(),
});

const BAD_PASSWORD = 'That password is not right.';

/**
 * Re-prove the admin before a change to how they sign in.
 *
 * No serialising mutex here, unlike `login`. That one guards an UNAUTHENTICATED
 * endpoint where parallel argon2 verifies are a free CPU-exhaustion lever; this
 * one is behind a session and the dashboard key, so the caller has already
 * proved a great deal more than a guesser has.
 */
async function requireSudo(input: { password: string; code?: string }): Promise<void> {
  // FRESH, and compared again after argon2 — the same rule as signing in. A reset
  // made by the installer a moment ago must already refuse the old password here,
  // and a change landing during the verify must not let the old one through.
  const hash = getPasswordHash({ fresh: true });
  const ok = await verifyPassword(hash ?? '', input.password);
  if (!ok || getPasswordHash({ fresh: true }) !== hash) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: BAD_PASSWORD });
  }

  if (!twoFactorActive()) return; // nothing enrolled yet — there is no code to ask for
  if (!input.code) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Enter a code from your authenticator app (or one of your backup codes) to make this change.',
    });
  }
  const res = verifySecondFactor(input.code);
  if (!res.ok) {
    if (res.reason === 'replayed') log.warn('Two-step sign-in: a code was re-used to authorise a change. Refused.');
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'That code is not right. Please try again.' });
  }
}

/** What an authenticator app should call this account. */
function accountLabel(): string {
  return getAdminEmail() || getAdminName() || getUsername() || 'admin';
}

export const twoFactorRouter = router({
  /**
   * What is set up. Returns NO secret, no codes and no QR — the enrolment
   * exchange is the only place a secret ever leaves this server, and it happens
   * once, behind `requireSudo`.
   */
  status: protectedProcedure.query(() => ({
    ...twoFactorStatus(),
    /** Whether emailed codes COULD be switched on (they need a mail provider). */
    emailPossible: isEmailConfigured() && Boolean(getAdminEmail()),
    backupCodeCount: BACKUP_CODE_COUNT,
  })),

  /**
   * Start enrolling an authenticator app: mint a pending secret and return it
   * with the QR to scan.
   *
   * Nothing about signing in changes until `confirm` sees a working code. An
   * admin who scans this and then closes the tab has lost nothing.
   */
  begin: protectedProcedure.input(sudo).mutation(async ({ input }) => {
    await requireSudo(input);
    const account = accountLabel();
    const { secret, uri } = beginEnrolment(account);
    return {
      /** Shown for manual entry when a camera is not an option. */
      secret,
      uri,
      account,
      qr: qrMatrix(uri),
    };
  }),

  /**
   * Prove the pending secret and activate it. Returns the backup codes ONCE —
   * they are stored hashed, so this response is the only time they exist in
   * readable form and the UI has to say so before the admin navigates away.
   *
   * No password here: the pending secret was minted behind `requireSudo` moments
   * ago and is worthless to anyone who did not receive it. Asking twice inside
   * one flow buys nothing and costs an admin a retype with their phone in hand.
   */
  confirm: protectedProcedure
    .input(z.object({ code: z.string().trim().min(1).max(16) }))
    .mutation(({ input }) => {
      const codes = confirmEnrolment(input.code);
      if (!codes) {
        // One message for "wrong code", "you have tried too many times" and
        // "this setup has expired", because after a few wrong tries the advice
        // is the same either way and the pending secret is gone. The cap and
        // the TTL are what stop this being a search for six digits that returns
        // ten backup codes — `auth/twofactor.ts` PENDING_TTL_MS has the detail.
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message:
            "That code didn't match. Check your phone's clock is right and try the next one — " +
            'after a few wrong tries you will need to start the setup again.',
        });
      }
      log.info('Two-step sign-in: an authenticator app was enrolled.');
      return { backupCodes: codes };
    }),

  /**
   * Turn the second factor off completely.
   *
   * Every pending sign-in is destroyed too: a challenge issued moments ago names
   * factors that no longer exist, and leaving half-authenticated state behind
   * after changing the rules it was issued under is how a guard quietly stops
   * guarding.
   */
  disable: protectedProcedure.input(sudo).mutation(async ({ input }) => {
    await requireSudo(input);
    disableTwoFactor();
    clearChallenges();
    log.warn('Two-step sign-in has been turned OFF. Signing in from outside the masjid will be refused.');
    return { active: false as const };
  }),

  /** Issue a fresh set of backup codes, invalidating every old one. Shown once. */
  regenerateBackupCodes: protectedProcedure.input(sudo).mutation(async ({ input }) => {
    await requireSudo(input);
    if (!twoFactorActive()) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Set up an authenticator app first — backup codes are a way back in when it is unavailable.',
      });
    }
    log.info('Two-step sign-in: backup codes were replaced.');
    return { backupCodes: regenerateBackupCodes() };
  }),

  /**
   * Allow (or stop allowing) a code emailed to the admin as a second factor.
   *
   * Weaker than an authenticator app — it is only as strong as the mailbox — so
   * it is a supplement, offered because a masjid whose one admin loses their
   * phone should not need someone at a terminal in the building. It cannot be
   * switched on without a working mail provider and an address to send to,
   * because a factor that cannot be delivered is a lockout with extra steps.
   */
  setEmailFactor: protectedProcedure
    .input(sudo.extend({ enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      await requireSudo(input);
      if (input.enabled && !isEmailConfigured()) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Set up an email provider in Settings → Email first, so codes can actually reach you.',
        });
      }
      if (input.enabled && !getAdminEmail()) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Add an email address to your account first, so codes have somewhere to go.',
        });
      }
      setEmailFactor(input.enabled);
      return { email: input.enabled };
    }),
});
