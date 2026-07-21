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
import { getEmailConfigPublic, saveEmailConfig, isEmailConfigured } from '../../store/email';
import { sendEmail } from '../../notify/email';
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
    .mutation(({ input }) => {
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
      const r = await sendEmail(
        {
          to,
          subject: 'OpenMasjidOS test email',
          text: 'This is a test email from OpenMasjidOS. If you received it, email is set up correctly.',
        },
        'os',
      );
      if (!r.sent) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `Could not send the test email (${r.reason}). Check your settings.` });
      }
      return { sent: true, to };
    }),
});
