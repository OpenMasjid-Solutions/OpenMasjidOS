// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * WhatsApp gateway config (Settings → WhatsApp). Admin-only, and deliberately shaped
 * like the email router: the OpenWA API key is a secret (config/whatsapp.json, chmod
 * 600) and is never returned here — `get` is a sanitized view with an "is set" flag.
 *
 * `link` issues a pairing code so the admin links the phone by typing a code into
 * WhatsApp, rather than photographing a QR off a headless server.
 *
 * `test` sends one real message to the admin's own number and WAITS for the answer,
 * because a test the admin is watching needs a result on screen — so it bypasses the
 * paced queue (see notify/whatsapp.ts `sendTestMessage`). Every other send goes
 * through the queue.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import {
  getWhatsAppConfigPublic,
  saveWhatsAppConfig,
  isWhatsAppConfigured,
  markLinked,
  DEFAULT_LIMITS,
} from '../../store/whatsapp';
import {
  gatewayStatus,
  requestPairingCode,
  sendTestMessage,
  queueDepth,
  toDigits,
} from '../../notify/whatsapp';
import { getAdminPhone } from '../../auth/store';

/** Bounds mirror `clampLimits` in the store, which is the real enforcement — this is
 *  only so the UI gets a friendly error instead of a silent clamp. */
const limitsInput = z
  .object({
    perHour: z.number().int().min(1).max(60),
    perDay: z.number().int().min(1).max(500),
    minGapSeconds: z.number().int().min(3).max(600),
    jitterSeconds: z.number().int().min(1).max(600),
    perRecipientCooldownSeconds: z.number().int().min(0).max(86_400),
    quietStartHour: z.number().int().min(0).max(23),
    quietEndHour: z.number().int().min(0).max(23),
    warmupDays: z.number().int().min(0).max(90),
  })
  .partial();

export const whatsappRouter = router({
  get: protectedProcedure.query(() => ({
    ...getWhatsAppConfigPublic(),
    /** The conservative starting point, so the UI can offer "restore defaults". */
    defaults: DEFAULT_LIMITS,
    queued: queueDepth(),
  })),

  /**
   * Live status for the panel's dot. Deliberately reports reachable and connected
   * SEPARATELY: "the gateway is up but the phone isn't linked" is a completely
   * different problem from "the gateway is down", and collapsing them into one
   * boolean sends the admin looking in the wrong place.
   */
  status: protectedProcedure.query(async () => {
    const s = await gatewayStatus();
    return { ...s, configured: isWhatsAppConfigured(), queued: queueDepth() };
  }),

  save: protectedProcedure
    .input(
      z.object({
        provider: z.enum(['none', 'openwa']).optional(),
        /** Blank = discover an OpenWA installed from the App Store (the normal path). */
        baseUrl: z.string().trim().max(300).optional(),
        /** Blank = keep the stored key, so changing a limit never re-pastes a secret. */
        apiKey: z.string().max(300).optional(),
        sessionId: z.string().trim().max(120).optional(),
        limits: limitsInput.optional(),
      }),
    )
    .mutation(({ input }) => {
      try {
        return saveWhatsAppConfig(input);
      } catch (err) {
        // normaliseBaseUrl throws a human message for a malformed address.
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
    }),

  /**
   * Ask the gateway for a pairing code, and restart the warm-up ramp.
   *
   * The ramp restart is the important part: a freshly linked number is the one
   * WhatsApp watches hardest, so it must not inherit the allowance an older number
   * earned. Linking is exactly when that happens.
   */
  link: protectedProcedure
    .input(z.object({ phone: z.string().trim().min(6).max(24) }))
    .mutation(async ({ input }) => {
      const digits = toDigits(input.phone);
      if (!digits) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'That phone number needs a country code, e.g. +1 555 010 1234.',
        });
      }
      const r = await requestPairingCode(digits);
      if (!r.ok) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: r.error ?? "Couldn't reach the WhatsApp gateway.",
        });
      }
      markLinked(new Date().toISOString());
      return { code: r.code ?? null };
    }),

  /** Send one real message to the admin's own number to prove the setup works. */
  test: protectedProcedure
    .input(z.object({ to: z.string().trim().max(24).optional() }))
    .mutation(async ({ input }) => {
      const to = input.to?.trim() || getAdminPhone();
      if (!to) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Add your WhatsApp number in Settings → Account first, so there is somewhere to send it.',
        });
      }
      const r = await sendTestMessage(
        to,
        'This is a test message from OpenMasjidOS. If you can read this, WhatsApp alerts are working.',
      );
      if (!r.ok) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: r.error ?? "The message couldn't be sent." });
      }
      return { sent: true };
    }),
});
