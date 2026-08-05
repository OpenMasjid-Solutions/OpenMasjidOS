// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Platform settings the SERVER must own (security-relevant). Presentation prefs
 * live in the browser; this is the custom-apps gate, the terminal toggles, and
 * the update channel (CLAUDE.md §13). No masjid/prayer config ever lives here.
 */
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { getSettings, updateSettings } from '../../settings/store';

export const settingsRouter = router({
  get: protectedProcedure.query(() => getSettings()),

  update: protectedProcedure
    .input(
      z.object({
        allowCustomApps: z.boolean().optional(),
        webTerminal: z.boolean().optional(),
        rootTerminal: z.boolean().optional(),
        // The channel is NOT settable here. Switching it has side effects — the
        // catalog must be re-read before we commit, and every installed app then
        // needs moving — so it goes through system.setUpdateChannel, which does that
        // in the right order and refuses rather than half-switching. Accepting it
        // here as a plain field would let the UI persist a channel whose catalog we
        // have never successfully read.
        // Presentation mirror, synced from the dashboard so apps can inherit it.
        appearance: z
          .object({
            theme: z.enum(['system', 'dark', 'light']),
            wallpaper: z.string().max(64),
            // Served by the public appearance endpoint, so reject anything that
            // isn't an http(s) URL (no javascript:/data:/credentialed schemes).
            wallpaperImage: z
              .string()
              .max(2048)
              .refine((v) => v === '' || /^https?:\/\//i.test(v), 'Must be an http(s) URL.'),
            accent: z.string().max(32),
            lang: z.string().max(16),
          })
          .optional(),
        notifications: z
          .object({
            enabled: z.boolean(),
            type: z.enum(['slack', 'discord', 'generic']),
            // A webhook URL the platform POSTs to. http(s) only (LAN webhooks
            // are allowed); apps never see it.
            url: z
              .string()
              .max(2048)
              .refine((v) => v === '' || /^https?:\/\//i.test(v), 'Must be an http(s) URL.'),
            label: z.string().max(80),
          })
          .optional(),
      }),
    )
    .mutation(({ input }) => updateSettings(input)),
});
