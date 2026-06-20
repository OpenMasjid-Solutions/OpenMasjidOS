/**
 * App Store: read the OpenMasjidAPPS catalog and one-click install. The app's
 * settings (collected in the UI before install) are passed straight through as
 * the app's env — the platform injects no masjid data of its own.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import { APP_ID_RE, isValidAppId } from '../../util/id';
import { fetchCatalog, findCatalogApp } from '../../store/catalog';
import { installCatalogApp } from '../../apps/manager';

export const storeRouter = router({
  catalog: protectedProcedure.query(() => fetchCatalog()),

  refresh: protectedProcedure.mutation(() => fetchCatalog(true)),

  install: protectedProcedure
    .input(
      z.object({
        id: z.string().regex(APP_ID_RE, 'Invalid app id'),
        settings: z.record(z.string(), z.string()).default({}),
      }),
    )
    .mutation(async ({ input }) => {
      const app = await findCatalogApp(input.id);
      if (!app) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That app is no longer in the store.' });
      }
      // The catalog is external data — never trust its id as a path segment.
      if (!isValidAppId(app.id)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'That app has an invalid id.' });
      }
      if (!app.compose) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'That app is missing its setup file.' });
      }
      try {
        return await installCatalogApp(app, input.settings);
      } catch (err) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: (err as Error).message });
      }
    }),
});
