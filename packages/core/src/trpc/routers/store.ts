// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
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
import { visibleCatalog } from '../../apps/managed';
import { getWhatsAppConfig } from '../../store/whatsapp';
import { checkCompose } from '../../apps/compose-validate';

/**
 * Hide platform-managed apps until the admin has opted into the feature that uses them.
 *
 * OpenWA is a WhatsApp engine the platform drives, not something a masjid installs and
 * opens. Listing it unconditionally would let someone install a gateway, link a phone in
 * its own UI and start sending — with none of the pacing that keeps the number unbanned,
 * and no warning that WhatsApp does not permit this at all. So it appears only after
 * Settings → WhatsApp is switched on, which is where the risk is explained and accepted.
 *
 * Filtering here rather than in the UI keeps it true for every surface at once — the
 * grid, the search, and anything added later.
 */
function visibleToAdmin(apps: Awaited<ReturnType<typeof fetchCatalog>>) {
  return visibleCatalog(apps, { whatsappEnabled: getWhatsAppConfig().provider !== 'none' });
}

export const storeRouter = router({
  catalog: protectedProcedure.query(async () => visibleToAdmin(await fetchCatalog())),

  refresh: protectedProcedure.mutation(async () => visibleToAdmin(await fetchCatalog(true))),

  install: protectedProcedure
    .input(
      z.object({
        id: z.string().regex(APP_ID_RE, 'Invalid app id'),
        settings: z.record(z.string(), z.string()).default({}),
        // Admin's consent to expose this app over the tunnel at install time
        // (defaults to not-exposed; the admin can also toggle it later in Settings).
        expose: z.boolean().optional(),
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
      let refusals: string[];
      try {
        ({ dangers, refusals } = checkCompose(app.compose));
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
      if (refusals.length > 0) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This app tries to open another app’s data, so it was blocked.',
        });
      }
      if (dangers.length > 0) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This app requests powerful system permissions and was blocked for safety.',
        });
      }
      try {
        return await installCatalogApp(app, input.settings, ctx.host, input.expose);
      } catch (err) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: (err as Error).message });
      }
    }),
});
