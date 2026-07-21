// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Granular alert controls (Settings → Alerts) — UniFi-style. Lists every alert type
 * (OS built-ins + each installed app's declared alerts) with an on/off; all default
 * ON. Toggling off adds it to the persisted disabled set so that alert is never
 * delivered (email/webhook). Admin-only.
 */
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { listAlertTypes, setAlertEnabled } from '../../notify/alerts';

export const alertsRouter = router({
  list: protectedProcedure.query(() => listAlertTypes()),

  setEnabled: protectedProcedure
    .input(z.object({ source: z.string().min(1).max(80), id: z.string().min(1).max(60), enabled: z.boolean() }))
    .mutation(({ input }) => {
      setAlertEnabled(input.source, input.id, input.enabled);
      return { ok: true };
    }),
});
