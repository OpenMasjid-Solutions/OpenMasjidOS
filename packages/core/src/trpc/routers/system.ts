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

export const systemRouter = router({
  info: protectedProcedure.query(() => ({
    version: VERSION,
    network: networkInfo(),
    sourceUrl: SOURCE_URL,
  })),

  checkUpdate: protectedProcedure.query(() => checkForUpdate()),

  /** Reboot the whole server (host machine). The dashboard goes down until it's
   *  back. Confirmed in the UI before calling. */
  reboot: protectedProcedure.mutation(() => {
    rebootHost();
    return { ok: true };
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
