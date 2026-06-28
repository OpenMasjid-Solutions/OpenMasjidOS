// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Installed-app management: list, logs, and lifecycle controls. Update/repair
 * of the CORE never run here — only the installer touches the core project.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import { APP_ID_RE } from '../../util/id';
import {
  listInstalled,
  getInstalled,
  appLogs,
  startApp,
  stopApp,
  restartApp,
  removeApp,
  checkCatalogUpdate,
} from '../../apps/manager';

// App ids are used as filesystem segments + compose project names, so they are
// strictly validated to a kebab-case allowlist (no slashes/dots/traversal).
const appId = z.string().regex(APP_ID_RE, 'Invalid app id');
const idInput = z.object({ id: appId });

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: (err as Error).message });
  }
}

export const appsRouter = router({
  list: protectedProcedure.query(() => listInstalled()),

  get: protectedProcedure.input(idInput).query(({ input }) => getInstalled(input.id)),

  logs: protectedProcedure
    .input(z.object({ id: appId, tail: z.number().int().min(1).max(2000).optional() }))
    .query(({ input }) => appLogs(input.id, input.tail ?? 200)),

  /** Is a newer version of this catalog app available in the store? */
  checkUpdate: protectedProcedure.input(idInput).query(({ input }) => checkCatalogUpdate(input.id)),

  /** Every installed catalog app that has a newer version in the store — drives the
   *  dashboard "app updates available" banner, mirroring the core's update check. */
  updates: protectedProcedure.query(async () => {
    const apps = await listInstalled();
    const out: { id: string; name: string; current: string; latest: string }[] = [];
    for (const a of apps) {
      if (a.kind !== 'catalog') continue;
      const u = await checkCatalogUpdate(a.id);
      if (u.updateAvailable && u.latest) {
        out.push({ id: a.id, name: a.name, current: u.current, latest: u.latest });
      }
    }
    return out;
  }),

  start: protectedProcedure.input(idInput).mutation(({ input }) =>
    wrap(async () => {
      await startApp(input.id);
      return { ok: true };
    }),
  ),

  stop: protectedProcedure.input(idInput).mutation(({ input }) =>
    wrap(async () => {
      await stopApp(input.id);
      return { ok: true };
    }),
  ),

  restart: protectedProcedure.input(idInput).mutation(({ input }) =>
    wrap(async () => {
      await restartApp(input.id);
      return { ok: true };
    }),
  ),

  remove: protectedProcedure
    .input(z.object({ id: appId, deleteData: z.boolean().optional() }))
    .mutation(({ input }) =>
      wrap(async () => {
        await removeApp(input.id, input.deleteData ?? false);
        return { removed: input.id };
      }),
    ),
});
