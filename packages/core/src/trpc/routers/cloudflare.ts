// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Cloudflare Tunnel (Settings → Remote access). Admin-only. The token is a secret
 * written to config/cloudflare/.env (chmod 600, system/cloudflared.ts) and never
 * returned here — `status` reports only whether one is set + the live run state.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import { getSettings, updateCloudflare } from '../../settings/store';
import {
  hasToken,
  setToken,
  clearTunnel,
  ensureCloudflared,
  cloudflaredRunning,
  publicHost,
  appPublicUrl,
} from '../../system/cloudflared';
import {
  listInstalled,
  getAppPath,
  setAppPath,
  setExposed,
  reconcilePublicUrls,
  startApp,
} from '../../apps/manager';
import { PORT } from '../../config';

/** After a tunnel/domain/path/exposure change, refresh each app's
 *  OPENMASJID_PUBLIC_URL and reup the ones that changed so the container + ingress
 *  route map pick it up. Reup failures are non-fatal (a stopped app still gets the
 *  updated .env for its next start). */
async function reconcileAndReup(): Promise<void> {
  const changed = reconcilePublicUrls();
  await Promise.all(changed.map((id) => startApp(id).catch(() => {})));
}

async function status() {
  const cf = getSettings().cloudflare;
  return { enabled: cf.enabled, domain: cf.domain, hasToken: hasToken(), running: await cloudflaredRunning() };
}

export const cloudflareRouter = router({
  status: protectedProcedure.query(() => status()),

  /** Remote-access routing info for the guided setup. The admin adds ONE Cloudflare
   *  Public Hostname (omos.<domain> → HTTP localhost:<ingressPort>); the OS then
   *  reverse-proxies each app by path. `apps` lists where each app will live. */
  routes: protectedProcedure.query(async () => {
    const apps = await listInstalled();
    return {
      host: publicHost(), // e.g. "omos.example.org" (empty until a domain is set)
      ingressPort: PORT, // the OS HTTP front door the single tunnel route points at
      apps: apps
        .filter((a) => a.openPort != null)
        .map((a) => ({
          id: a.id,
          name: a.name,
          path: `/${getAppPath(a.id)}`,
          // Per-app exposure (admin toggle) + the live public URL ('' until routed).
          exposed: a.exposed,
          publicUrl: appPublicUrl(a.id),
        })),
    };
  }),

  /** Set the public path an app is served under (e.g. "donate"). Blank → app id. */
  setPath: protectedProcedure
    .input(z.object({ id: z.string().min(1), path: z.string().max(40) }))
    .mutation(async ({ input }) => {
      try {
        const path = `/${setAppPath(input.id, input.path)}`;
        await reconcileAndReup(); // the path changed → the app's public URL changed
        return { id: input.id, path };
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
    }),

  /** Turn an app's internet exposure on/off (the admin's per-app consent). */
  setExposed: protectedProcedure
    .input(z.object({ id: z.string().min(1), exposed: z.boolean() }))
    .mutation(async ({ input }) => {
      try {
        setExposed(input.id, input.exposed);
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
      // Reup so the container gets OPENMASJID_PUBLIC_URL and the ingress route map
      // rebuilds to add/remove the app's public path.
      await startApp(input.id).catch(() => {});
      return { id: input.id, exposed: input.exposed };
    }),

  save: protectedProcedure
    .input(
      z.object({
        domain: z.string().trim().max(253).optional(),
        token: z.string().trim().max(8192).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      if (input.domain !== undefined) {
        updateCloudflare({ domain: input.domain.replace(/^https?:\/\//, '').replace(/\/+$/, '') });
      }
      if (input.token) {
        try {
          setToken(input.token);
        } catch (err) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
        }
      }
      await ensureCloudflared(); // restart with the new token if remote access is on
      await reconcileAndReup(); // a new domain changes every exposed app's public URL
      return status();
    }),

  setEnabled: protectedProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      if (input.enabled && !hasToken()) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Add your Cloudflare tunnel token first.' });
      }
      updateCloudflare({ enabled: input.enabled });
      await ensureCloudflared();
      await reconcileAndReup(); // enabling/disabling flips every exposed app's public URL
      return status();
    }),

  clear: protectedProcedure.mutation(async () => {
    await clearTunnel();
    updateCloudflare({ enabled: false });
    await reconcileAndReup(); // remote access off → clear every app's public URL
    return status();
  }),
});
