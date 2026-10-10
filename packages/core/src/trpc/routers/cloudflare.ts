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
import { recentRefusals } from '../../system/tunnel-refusals';
import { getSettings, updateCloudflare } from '../../settings/store';
import {
  hasToken,
  isCurrentTunnelToken,
  normalizeTunnelToken,
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
import {
  adminHost,
  hostnameOfDomain,
  remoteAdminEnabled,
  remoteAdminBlockedReason,
  validateAdminHost,
} from '../../system/remote-admin';
import { sweepHandedOverSockets } from '../../system/remote-sockets';
import { twoFactorActive } from '../../auth/twofactor';
import { clearAllIpFailures } from '../../auth/ip-lockout';
import { log } from '../../logger';

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
  return {
    enabled: cf.enabled,
    domain: cf.domain,
    hasToken: hasToken(),
    running: await cloudflaredRunning(),
    /** The admin's setting. NOT the same as whether it is in effect — see below. */
    remoteAdmin: Boolean(cf.remoteAdmin),
    /**
     * Whether the dashboard is ACTUALLY being served over the tunnel right now.
     *
     * Reported separately from the switch because they can disagree, and the one
     * case where they do is the one worth showing: turning two-step sign-in off
     * closes this door automatically (`remoteAdminEnabled` re-reads it per
     * request). Showing only the switch would tell a masjid their dashboard is
     * published when it is not, which is the less alarming of the two directions
     * but still a screen that lies.
     */
    remoteAdminActive: remoteAdminEnabled(),
    /** Why it cannot be switched on, so Settings can say so before it is pressed. */
    remoteAdminBlocked: remoteAdminBlockedReason(),
    /**
     * The dashboard's own address from outside — never the apps' one
     * (system/remote-admin.ts says why it must be separate). '' until set.
     */
    adminHost: adminHost(),
    twoFactor: twoFactorActive(),
  };
}

export const cloudflareRouter = router({
  /**
   * Why recent requests through the tunnel were refused.
   *
   * Safe to be specific HERE and nowhere else: this is the signed-in dashboard — on the
   * masjid's network, or from outside behind the second factor. The 404 the internet
   * gets stays deliberately identical for every reason, so a stranger cannot map which
   * paths are real routes on this platform.
   */
  refusals: protectedProcedure.query(() => recentRefusals()),

  status: protectedProcedure.query(() => status()),

  /** Remote-access routing info for the guided setup. For the apps the admin adds ONE
   *  Cloudflare Public Hostname (omos.<domain> → HTTP localhost:<ingressPort>) and the
   *  OS reverse-proxies each app by path; managing OpenMasjidOS from outside needs a
   *  second, the dashboard address, pointed at the same place (docs/REMOTE_ADMIN.md).
   *  `apps` lists where each app will live. */
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
        /** The dashboard's own hostname (remote administration). '' clears it. */
        adminHost: z.string().trim().max(253).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // CHECK EVERYTHING, THEN WRITE. This wrote the apps' address first and refused the
      // dashboard address afterwards — so a save that said "refused" had already put the
      // apps on the dashboard's hostname, which switches remote administration off. Done
      // from outside, the admin's next request was refused and only someone at the
      // masjid could undo it. Three reviewers found it separately.
      const current = getSettings().cloudflare;
      const nextDomain = input.domain !== undefined ? hostnameOfDomain(input.domain) : current.domain;
      let nextAdmin = adminHost();
      try {
        // Judged against the apps' address as it will END UP, whichever field changed.
        nextAdmin = validateAdminHost(input.adminHost !== undefined ? input.adminHost : nextAdmin, hostnameOfDomain(nextDomain));
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
      // From OUTSIDE, the dashboard's own address cannot be moved or cleared. The
      // request doing it arrived through that address: the change would close the door
      // behind it, with nothing left to say where the dashboard went — a typo is a
      // drive to the masjid. At the masjid it can be changed freely. "From outside" is
      // the front door's hand-over, not a header: a reverse proxy the masjid runs on its
      // own network sends `X-Forwarded-Proto: https` too, and its admin IS at the masjid.
      if (ctx.handedOver && nextAdmin !== adminHost()) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Change the dashboard address at the masjid — changing it from here would cut you off.',
        });
      }
      // The tunnel token, checked the same way and for the same reason. Saving one
      // recreates the cloudflared container — the very connection this request came
      // through from outside — and a token for another tunnel, or a stale one, connects
      // nowhere useful, with no way back but the masjid. So from outside only the token
      // already in use is accepted (re-pasting it changes nothing); everywhere, a paste
      // that is not a whole token is refused before anything is written.
      let newToken: string | null = null;
      if (input.token && !isCurrentTunnelToken(input.token.trim())) {
        let token: string;
        try {
          token = normalizeTunnelToken(input.token);
        } catch (err) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
        }
        if (!isCurrentTunnelToken(token)) {
          if (ctx.handedOver) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message:
                "Replace the tunnel token at the masjid — if the new one didn't work, this window and every shared app would go offline until someone there fixed it.",
            });
          }
          newToken = token;
        }
      }
      if (newToken) setToken(newToken);
      const patch: { domain?: string; adminHost?: string } = {};
      if (input.domain !== undefined) patch.domain = nextDomain;
      if (nextAdmin !== adminHost()) {
        patch.adminHost = nextAdmin;
        log.warn(
          nextAdmin
            ? `Remote administration address set to ${nextAdmin}.`
            : 'Remote administration address cleared — the dashboard is not served from outside.',
        );
      }
      if (Object.keys(patch).length > 0) updateCloudflare(patch);
      // A changed address closes anything open on the old one.
      sweepHandedOverSockets();
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
      sweepHandedOverSockets();
      await ensureCloudflared();
      await reconcileAndReup(); // enabling/disabling flips every exposed app's public URL
      return status();
    }),

  /**
   * Publish the DASHBOARD over the tunnel, not just app paths.
   *
   * Refused unless two-step sign-in is enrolled. That is not a nicety: with no
   * second factor this would be a password-only admin dashboard on the public
   * internet, and `login` already fails closed on tunnel traffic in that state —
   * so allowing the switch would produce a published address that refuses every
   * sign-in, which looks like a broken masjid rather than a refused one.
   *
   * The check is repeated at REQUEST time in `remoteAdminEnabled()`, so removing
   * the second factor later closes this door in the same action rather than
   * leaving the switch on and unenforced.
   */
  setRemoteAdmin: protectedProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      if (input.enabled) {
        if (!twoFactorActive()) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Set up two-step sign-in first, in Settings → Account. Signing in from outside needs it.',
          });
        }
        if (!getSettings().cloudflare.enabled) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Turn remote access on first, so there is an internet link to reach the dashboard through.',
          });
        }
        if (remoteAdminBlockedReason() === 'no-admin-host') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message:
              'Give the dashboard an address of its own first — not the one your apps use. See "Dashboard address" above.',
          });
        }
      }
      updateCloudflare({ remoteAdmin: input.enabled });
      // Switching it off drops the per-address failure history with it: those
      // records exist only for tunnel sign-ins, and keeping them would mean an
      // address stayed locked out of a door that no longer exists.
      if (!input.enabled) clearAllIpFailures();
      // And closes what is open through it now, terminals included, rather than at
      // the next sweep (system/remote-sockets.ts).
      if (!input.enabled) sweepHandedOverSockets();
      log.warn(
        input.enabled
          ? 'Remote administration is ON — the dashboard is now served over the Cloudflare tunnel.'
          : 'Remote administration is OFF — the dashboard is LAN-only again.',
      );
      return status();
    }),

  clear: protectedProcedure.mutation(async () => {
    await clearTunnel();
    // Removing the tunnel removes the only way in from outside, so the setting
    // goes with it rather than lying dormant and switching itself back on with
    // the next tunnel the masjid configures.
    updateCloudflare({ enabled: false, remoteAdmin: false });
    clearAllIpFailures();
    sweepHandedOverSockets();
    await reconcileAndReup(); // remote access off → clear every app's public URL
    return status();
  }),
});
