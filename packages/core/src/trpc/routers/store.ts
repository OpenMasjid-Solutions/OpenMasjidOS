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
import { checkCompose } from '../../apps/compose-validate';

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
    .mutation(async ({ input, ctx }) => {
      const app = await findCatalogApp(input.id);
      if (!app) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That app is no longer in the store.' });
      }
      // The catalog is external data — never trust its id as a path segment.
      if (!isValidAppId(app.id)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'That app has an invalid id.' });
      }
      if (app.comingSoon) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'That app is coming soon — it isn\'t available to install yet.' });
      }
      if (!app.compose) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'That app is missing its setup file.' });
      }
      // Defense-in-depth: catalog apps are vetted by the OpenMasjidAPPS build, but
      // the catalog is still external data — never auto-run a store entry that
      // requests powerful permissions (a compromised/spoofed catalog).
      let dangers: string[];
      try {
        dangers = checkCompose(app.compose).dangers;
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
      if (dangers.length > 0) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This app requests powerful system permissions and was blocked for safety.',
        });
      }
      try {
        return await installCatalogApp(app, input.settings, ctx.host);
      } catch (err) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: (err as Error).message });
      }
    }),
});
