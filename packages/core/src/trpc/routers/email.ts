// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Email provider config (Settings → Email). Admin-only. The SMTP password /
 * Resend API key are secrets (config/email.json, chmod 600) and never returned
 * here — `get` is a sanitized view (provider + from + host/port/user + "is set"
 * flags). `test` sends a one-off email to prove the settings work.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import { getEmailConfigPublic, saveEmailConfig, previewConfig, isEmailConfigured } from '../../store/email';
import { sendBrandedEmail, verifyEmailConfig, isValidEmail } from '../../notify/email';
import { getAdminEmail } from '../../auth/store';

export const emailRouter = router({
  get: protectedProcedure.query(() => getEmailConfigPublic()),

  /** For the green/red dot in Settings — is a usable provider configured? */
  status: protectedProcedure.query(() => ({
    configured: isEmailConfigured(),
    provider: getEmailConfigPublic().provider,
  })),

  save: protectedProcedure
    .input(
      z.object({
        provider: z.enum(['none', 'smtp', 'resend']).optional(),
        fromEmail: z.string().trim().max(254).optional(),
        fromName: z.string().trim().max(80).optional(),
        smtp: z
          .object({
            host: z.string().trim().max(255).optional(),
            port: z.number().int().min(1).max(65535).optional(),
            secure: z.boolean().optional(),
            user: z.string().trim().max(255).optional(),
            // Blank = keep the existing password.
            pass: z.string().max(2048).optional(),
          })
          .optional(),
        // Blank apiKey = keep the existing one.
        resend: z.object({ apiKey: z.string().max(2048).optional() }).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      // Compute what WOULD be saved (merging the kept-secret), then validate +
      // verify it BEFORE persisting — so a bad From address or a broken API key /
      // SMTP login is refused instead of silently stored.
      const next = previewConfig(input);
      if (next.provider !== 'none') {
        if (!isValidEmail(next.fromEmail)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Enter a valid From address, e.g. no-reply@yourmasjid.org.',
          });
        }
        const v = await verifyEmailConfig(next);
        if (!v.ok) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              next.provider === 'resend'
                ? `Couldn't verify Resend: ${v.error ?? 'check the API key.'}`
                : `Couldn't connect to the SMTP server: ${v.error ?? 'check the host, port, and login.'}`,
          });
        }
      }
      try {
        return saveEmailConfig(input);
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
    }),

  /** Send a one-off test email (to the given address, or the admin email). */
  test: protectedProcedure
    .input(z.object({ to: z.string().trim().email().optional() }))
    .mutation(async ({ input }) => {
      const to = input.to || getAdminEmail() || '';
      if (!to) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'No recipient — set your admin email first (Settings → Account).' });
      }
      const r = await sendBrandedEmail(
        {
          to,
          subject: 'Your OpenMasjidOS email is working',
          title: 'Email is working',
          summary: 'Email is set up correctly — this message came from your masjid’s OpenMasjidOS.',
          // No longer claims the logo is "shown above": it only appears in email
          // when remote access is set up, because a mail client fetches images
          // from its own network and cannot reach a LAN address.
          detail:
            'Alerts about your apps and updates will arrive here. You can choose which ones in Settings, under Alerts.',
          action: { label: 'Open OpenMasjidOS', note: 'Then go to Settings to choose your alerts.', path: '/settings' },
        },
        'os',
      );
      if (!r.sent) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `Could not send the test email (${r.reason}). Check your settings.` });
      }
      return { sent: true, to };
    }),
});
