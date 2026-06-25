// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The root tRPC router. Its TYPE is the single contract the UI consumes
 * (`import type { AppRouter }`) — client and server can never drift (CLAUDE.md
 * §6). Never export runtime code from here into the browser bundle.
 */
import { router } from './trpc';
import { authRouter } from './routers/auth';
import { statsRouter } from './routers/stats';
import { appsRouter } from './routers/apps';
import { storeRouter } from './routers/store';
import { customRouter } from './routers/custom';
import { communityRouter } from './routers/community';
import { filesRouter } from './routers/files';
import { settingsRouter } from './routers/settings';
import { systemRouter } from './routers/system';
import { notificationsRouter } from './routers/notifications';
import { backupsRouter } from './routers/backups';

export const appRouter = router({
  auth: authRouter,
  stats: statsRouter,
  apps: appsRouter,
  store: storeRouter,
  custom: customRouter,
  community: communityRouter,
  files: filesRouter,
  settings: settingsRouter,
  system: systemRouter,
  notifications: notificationsRouter,
  backups: backupsRouter,
});

export type AppRouter = typeof appRouter;
