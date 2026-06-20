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
        updateChannel: z.enum(['stable', 'beta']).optional(),
      }),
    )
    .mutation(({ input }) => updateSettings(input)),
});
