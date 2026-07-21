// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Granular alert controls (Settings → Alerts) — a per-alert × per-channel matrix.
 * Lists every alert type (OS built-ins + each installed app's declared alerts) with
 * its Email/Webhook routing; all default to both channels ON. Admin-only.
 */
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { listAlertTypes, setAlertChannel } from '../../notify/alerts';

export const alertsRouter = router({
  list: protectedProcedure.query(() => listAlertTypes()),

  /** Turn one channel (email | webhook) on/off for one alert type. */
  setChannel: protectedProcedure
    .input(
      z.object({
        source: z.string().min(1).max(80),
        id: z.string().min(1).max(60),
        channel: z.enum(['email', 'webhook']),
        enabled: z.boolean(),
      }),
    )
    .mutation(({ input }) => {
      setAlertChannel(input.source, input.id, input.channel, input.enabled);
      return { ok: true };
    }),
});
