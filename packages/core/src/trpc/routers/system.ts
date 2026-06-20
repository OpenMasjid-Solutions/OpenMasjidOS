/**
 * System info for Settings → Advanced: version, network details, the AGPL
 * source-code link, and the core update check (CLAUDE.md §3, §13.3).
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import { VERSION } from '../../version';
import { networkInfo, checkForUpdate, SOURCE_URL } from '../../system/system';
import { isValidSshKey, addRootSshKey } from '../../system/ssh';

export const systemRouter = router({
  info: protectedProcedure.query(() => ({
    version: VERSION,
    network: networkInfo(),
    sourceUrl: SOURCE_URL,
  })),

  checkUpdate: protectedProcedure.query(() => checkForUpdate()),

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
