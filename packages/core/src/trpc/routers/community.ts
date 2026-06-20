/**
 * Community app stores (CasaOS-compatible). Behind the same allowCustomApps gate
 * as the custom-compose installer (CLAUDE.md §11). Repos are validated before
 * being saved, and installs run through the same compose risk-check.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import {
  getSettings,
  addCommunityRepo,
  removeCommunityRepo,
} from '../../settings/store';
import { fetchRepoApps, fetchAllCommunityApps } from '../../store/casaos';
import { checkCompose } from '../../apps/compose-validate';
import { installCommunityApp, listInstalled } from '../../apps/manager';
import { slugify } from '../../util/slug';

function ensureEnabled() {
  if (!getSettings().allowCustomApps) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Custom apps are turned off. Enable them in Settings → Advanced first.',
    });
  }
}

export const communityRouter = router({
  repos: protectedProcedure.query(() => {
    ensureEnabled();
    return getSettings().communityRepos;
  }),

  addRepo: protectedProcedure
    .input(z.object({ url: z.string().url() }))
    .mutation(async ({ input }) => {
      ensureEnabled();
      // Validate it actually parses into apps before saving.
      try {
        await fetchRepoApps(input.url);
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
      return addCommunityRepo(input.url).communityRepos;
    }),

  removeRepo: protectedProcedure
    .input(z.object({ url: z.string() }))
    .mutation(({ input }) => {
      ensureEnabled();
      return removeCommunityRepo(input.url).communityRepos;
    }),

  apps: protectedProcedure.query(() => {
    ensureEnabled();
    return fetchAllCommunityApps(getSettings().communityRepos);
  }),

  install: protectedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(80),
        compose: z.string().min(1),
        icon: z.string().url().optional(),
        acknowledgeRisk: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      ensureEnabled();
      let dangers: string[];
      try {
        dangers = checkCompose(input.compose).dangers;
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
      if (dangers.length > 0 && !input.acknowledgeRisk) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This app needs powerful permissions. Please confirm you understand the risk.',
        });
      }

      const installed = await listInstalled();
      const taken = new Set(installed.map((a) => a.id));
      const base = `community-${slugify(input.name)}`;
      let id = base;
      let n = 2;
      while (taken.has(id)) id = `${base}-${n++}`;

      try {
        return await installCommunityApp({
          id,
          name: input.name,
          composeText: input.compose,
          env: {},
          icon: input.icon,
        });
      } catch (err) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: (err as Error).message });
      }
    }),
});
