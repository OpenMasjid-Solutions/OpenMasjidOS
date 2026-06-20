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
import { settingsRouter } from './routers/settings';
import { systemRouter } from './routers/system';

export const appRouter = router({
  auth: authRouter,
  stats: statsRouter,
  apps: appsRouter,
  store: storeRouter,
  custom: customRouter,
  community: communityRouter,
  settings: settingsRouter,
  system: systemRouter,
});

export type AppRouter = typeof appRouter;
