// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * System info for Settings → Advanced: version, network details, the AGPL
 * source-code link, and the core update check (CLAUDE.md §3, §13.3).
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import { VERSION } from '../../version';
import { networkInfo, checkForUpdate, SOURCE_URL, rebootHost } from '../../system/system';
import { certInfo, regenerateSelfSignedLive, setCustomCertLive } from '../../system/tls';
import { reloadProxyCerts } from '../../system/app-proxy';
import { isValidSshKey, addRootSshKey } from '../../system/ssh';
import { pruneUnusedImages } from '../../docker/compose';
import { fetchChangelog } from '../../store/changelog';
import { reconcileNow } from '../../system/address-monitor';
import { getSettings, updateSettings } from '../../settings/store';
import { channelSchema, channelLabel, osBranch, coreImageTag } from '../../system/channel';
import { requireCatalog, clearCatalogCache } from '../../store/catalog';
import { clearChangelogCache } from '../../store/changelog';
import { appsPendingChannel } from '../../apps/manager';
import { log } from '../../logger';

export const systemRouter = router({
  info: protectedProcedure.query(() => ({
    version: VERSION,
    network: networkInfo(),
    sourceUrl: SOURCE_URL,
  })),

  checkUpdate: protectedProcedure.query(() => checkForUpdate()),

  /** "What's new" — the project changelog, fetched server-side and cached. Fails
   *  soft: `fresh: false` with empty text means we're offline and have nothing
   *  cached yet, and the UI says so rather than showing an error. */
  changelog: protectedProcedure
    .input(z.object({ force: z.boolean().optional() }).optional())
    .query(({ input }) => fetchChangelog(input?.force === true)),

  /**
   * Re-point installed apps at this dashboard's current address, now, without
   * waiting for the background check. The button for "I moved the box and my
   * apps can't reach OpenMasjidOS."
   */
  reconnectApps: protectedProcedure.mutation(async () => {
    try {
      return await reconcileNow();
    } catch (err) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'We could not reconnect your apps just now. Please try again in a moment.',
        cause: err,
      });
    }
  }),

  /** Reboot the whole server (host machine). The dashboard goes down until it's
   *  back. Confirmed in the UI before calling. */
  reboot: protectedProcedure.mutation(() => {
    rebootHost();
    return { ok: true };
  }),

  /**
   * Which update channel this masjid is on, and what still has to move.
   * One global setting governs the OS, the catalog and every app (CLAUDE.md §13.4).
   */
  channel: protectedProcedure.query(() => {
    const channel = getSettings().updateChannel;
    return {
      channel,
      label: channelLabel(channel),
      /** The branch of THIS repo the channel tracks — 'main' maps to master. */
      branch: osBranch(channel),
      /** The channel's alias image tag. An update pulls the exact version instead. */
      imageTag: coreImageTag(channel),
      version: VERSION,
      /** Catalog apps still on the other channel, awaiting the switch. */
      pending: appsPendingChannel(),
    };
  }),

  /**
   * Switch channel. Deliberately NOT a field on `settings.update`: the order of
   * operations is the whole safety property.
   *
   * We read the TARGET channel's catalog FIRST and let a failure abort before
   * anything is persisted, so an unreachable or malformed dev catalog leaves the
   * masjid exactly where it was rather than half-switched — pointing at a channel
   * whose apps we cannot resolve. Only once we have a real catalog do we persist,
   * drop the cached catalog/changelog, and report which apps now need moving.
   */
  setUpdateChannel: protectedProcedure
    .input(z.object({ channel: channelSchema }))
    .mutation(async ({ input }) => {
      const current = getSettings().updateChannel;
      if (input.channel === current) {
        return { channel: current, changed: false, pending: appsPendingChannel() };
      }
      try {
        // Prove the channel is usable before committing to it.
        await requireCatalog(input.channel);
      } catch (err) {
        throw new TRPCError({
          code: 'SERVICE_UNAVAILABLE',
          message:
            `Could not read the ${channelLabel(input.channel)} app catalogue, so nothing was changed — ` +
            `this masjid is still on ${channelLabel(current)}. (${(err as Error).message})`,
        });
      }
      updateSettings({ updateChannel: input.channel });
      // Cached copies belong to the OLD channel; a switch must not serve them.
      clearCatalogCache();
      clearChangelogCache();
      log.warn(`Update channel switched from ${current} to ${input.channel}.`);
      return { channel: input.channel, changed: true, pending: appsPendingChannel() };
    }),

  /** Current TLS certificate details (type, subject, expiry, fingerprint). */
  tlsInfo: protectedProcedure.query(() => certInfo()),

  /** Generate a fresh self-signed cert and apply it to the live server. */
  regenerateCert: protectedProcedure.mutation(() => {
    try {
      regenerateSelfSignedLive();
      reloadProxyCerts(); // keep per-app HTTPS proxies on the new cert too
      return certInfo();
    } catch (err) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Could not generate a certificate. Is OpenSSL available on this build?',
      });
    }
  }),

  /** Install an admin-supplied certificate + private key (bring-your-own). */
  setCustomCert: protectedProcedure
    .input(z.object({ cert: z.string().min(1).max(100_000), key: z.string().min(1).max(100_000) }))
    .mutation(({ input }) => {
      try {
        setCustomCertLive(input.cert, input.key);
        reloadProxyCerts();
        return certInfo();
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
    }),

  /** Reclaim disk: remove images no app is using anymore. Returns how much
   *  space was freed (parsed from Docker's output), e.g. "1.2GB". */
  freeSpace: protectedProcedure.mutation(async () => {
    const res = await pruneUnusedImages();
    if (res.code !== 0) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Could not free up space right now. Please try again.',
      });
    }
    const m = (res.stdout + res.stderr).match(/Total reclaimed space:\s*([\d.]+\s*\w+)/i);
    return { reclaimed: m ? m[1].replace(/\s+/g, ' ').trim() : '0B' };
  }),

  /** Add an SSH public key to the host's root account (key-based login). */
  addSshKey: protectedProcedure
    .input(z.object({ publicKey: z.string().min(1) }))
    .mutation(async ({ input }) => {
      if (!isValidSshKey(input.publicKey)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: "That doesn't look like an SSH public key (e.g. starts with ssh-ed25519 or ssh-rsa).",
        });
      }
      try {
        await addRootSshKey(input.publicKey);
        return { ok: true };
      } catch (err) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: (err as Error).message });
      }
    }),
});
