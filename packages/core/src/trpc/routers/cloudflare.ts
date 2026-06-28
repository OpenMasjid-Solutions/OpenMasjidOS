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
} from '../../system/cloudflared';
import { listInstalled, getAppPath, setAppPath } from '../../apps/manager';
import { PORT } from '../../config';

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
        .map((a) => ({ id: a.id, name: a.name, path: `/${getAppPath(a.id)}` })),
    };
  }),

  /** Set the public path an app is served under (e.g. "donate"). Blank → app id. */
  setPath: protectedProcedure
    .input(z.object({ id: z.string().min(1), path: z.string().max(40) }))
    .mutation(({ input }) => {
      try {
        return { id: input.id, path: `/${setAppPath(input.id, input.path)}` };
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
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
      return status();
    }),

  clear: protectedProcedure.mutation(async () => {
    await clearTunnel();
    updateCloudflare({ enabled: false });
    return status();
  }),
});
