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
  AppNeedsReviewError,
} from '../../apps/manager';
import { APP_OPEN_PATH, mintAppTicket } from '../../system/app-access';
import { appHostname, remoteAdminEnabled } from '../../system/remote-admin';

// App ids are used as filesystem segments + compose project names, so they are
// strictly validated to a kebab-case allowlist (no slashes/dots/traversal).
const appId = z.string().regex(APP_ID_RE, 'Invalid app id');
const idInput = z.object({ id: appId });

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    // A held app is not a server fault — it is the platform asking a question,
    // and it must reach the dashboard as one so the UI can offer the
    // acknowledgement instead of showing "something went wrong". A refusal is
    // FORBIDDEN because no amount of agreeing will change it; anything else is
    // PRECONDITION_FAILED, the same code the paste-a-compose installer uses for
    // exactly this consent step.
    if (err instanceof AppNeedsReviewError) {
      throw new TRPCError({
        code: err.refusal ? 'FORBIDDEN' : 'PRECONDITION_FAILED',
        message: err.message,
      });
    }
    // Refused because a restore or this app's update is under way (system/update-lock.ts
    // assertAppFree): information to say plainly, not a fault.
    if ((err as Error).name === 'UpdateBusyError') {
      throw new TRPCError({ code: 'CONFLICT', message: (err as Error).message });
    }
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: (err as Error).message });
  }
}

export const appsRouter = router({
  list: protectedProcedure.query(() => listInstalled()),

  /**
   * Open an app from OUTSIDE the masjid: a one-use address on the apps' hostname that
   * signs this browser in to this one app (system/app-access.ts says how, and why the
   * dashboard's own cookie is never what an app sees).
   *
   * Only from the remote dashboard, and only for an app with a web port — the tunnel
   * reaches an app through the same port the masjid's network does. On the masjid's
   * network an app is opened at its own port and needs none of this.
   */
  openRemote: protectedProcedure.input(idInput).mutation(async ({ input, ctx }) => {
    // The remote dashboard — a request the front door handed over — and nothing that
    // merely LOOKS remote: a reverse proxy on the masjid's own network sends
    // `X-Forwarded-Proto: https` too, and its admin opens apps at their own ports.
    if (!ctx.handedOver || !remoteAdminEnabled()) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Apps open this way only when you are managing from outside.' });
    }
    const host = appHostname();
    if (!host) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Your apps have no web address yet. Set one in Settings → Remote access.',
      });
    }
    const app = await getInstalled(input.id).catch(() => null);
    if (!app || app.openPort == null) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'That app has no page to open.' });
    }
    const ticket = mintAppTicket(ctx.sessionToken ?? '', input.id);
    if (!ticket) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Please sign in to continue.' });
    return { url: `https://${host}${APP_OPEN_PATH}?t=${encodeURIComponent(ticket)}` };
  }),

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
    // `reason` rides along so the UI can word each row honestly. Without it the
    // dashboard rendered every row as "v{current} → v{latest}", which reads as an
    // upgrade — and printed nonsense like "v0.66.1 → v0.66.0" for a channel move.
    const out: {
      id: string;
      name: string;
      current: string;
      latest: string;
      reason: 'version' | 'channel';
      appChannel: 'main' | 'dev';
      channel: 'main' | 'dev';
    }[] = [];
    for (const a of apps) {
      if (a.kind !== 'catalog') continue;
      const u = await checkCatalogUpdate(a.id);
      if (u.updateAvailable && u.latest && u.reason) {
        out.push({
          id: a.id,
          name: a.name,
          current: u.current,
          latest: u.latest,
          reason: u.reason,
          appChannel: u.appChannel,
          channel: u.channel,
        });
      }
    }
    return out;
  }),

  // `acknowledgeRisk` is the admin's explicit consent for an app being held for
  // review after a restore. Absent = no consent, which is the only safe default:
  // this is the click that runs an unvetted compose as root with the Docker socket.
  start: protectedProcedure
    .input(z.object({ id: appId, acknowledgeRisk: z.boolean().optional() }))
    .mutation(({ input }) =>
      wrap(async () => {
        await startApp(input.id, input.acknowledgeRisk ?? false);
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
