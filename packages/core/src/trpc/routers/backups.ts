// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Scheduled off-site backups (Settings → Advanced). Configures where the
 * platform uploads its config + app-data backup (Google Drive or a NAS over
 * SFTP/SMB/WebDAV) and how often. Credentials are written to the rclone config
 * (system/backup-upload.ts) and never returned here — `status` is non-secret.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import { getSettings, updateBackups } from '../../settings/store';
import {
  setDestination,
  clearDestination,
  testRemote,
  runBackup,
} from '../../system/backup-upload';

export const backupsRouter = router({
  /** Non-secret backup config + last-run status. */
  status: protectedProcedure.query(() => getSettings().backups),

  /** Save a destination (writes rclone config from guided fields; no secrets returned). */
  setDestination: protectedProcedure
    .input(
      z.object({
        kind: z.enum(['drive', 'sftp', 'smb', 'webdav']),
        host: z.string().max(255).optional(),
        port: z.number().int().min(1).max(65535).optional(),
        user: z.string().max(255).optional(),
        password: z.string().max(1024).optional(),
        keyPem: z.string().max(100_000).optional(),
        share: z.string().max(255).optional(),
        url: z.string().max(2048).optional(),
        vendor: z.string().max(64).optional(),
        driveToken: z.string().max(100_000).optional(),
        folder: z.string().max(255).optional(),
      }),
    )
    .mutation(({ input }) => {
      try {
        const meta = setDestination(input);
        updateBackups({ ...meta, configured: true });
        return getSettings().backups;
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
    }),

  /** Forget the destination (deletes the rclone config + any key file). */
  clearDestination: protectedProcedure.mutation(() => {
    clearDestination();
    updateBackups({ configured: false, destKind: 'none', destLabel: '' });
    return getSettings().backups;
  }),

  /** Enable/disable, schedule, retention. */
  update: protectedProcedure
    .input(
      z.object({
        enabled: z.boolean().optional(),
        schedule: z.enum(['daily', 'weekly']).optional(),
        retention: z.number().int().min(1).max(365).optional(),
      }),
    )
    .mutation(({ input }) => {
      if (input.enabled && !getSettings().backups.configured) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Choose a backup destination before turning scheduled backups on.',
        });
      }
      updateBackups(input);
      return getSettings().backups;
    }),

  /** Verify the configured destination is reachable. */
  test: protectedProcedure.mutation(() => testRemote()),

  /** Run a backup right now (also used as a "test the whole pipeline" action). */
  runNow: protectedProcedure.mutation(async () => {
    const res = await runBackup();
    if (!res.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: res.message });
    return { name: res.name };
  }),
});
