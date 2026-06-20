/**
 * UI-side types derived from the tRPC router — never hand-duplicated
 * (CLAUDE.md §6, §15). If the server changes shape, these follow automatically.
 */
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@openmasjid/core';

export type RouterOutputs = inferRouterOutputs<AppRouter>;

export type InstalledApp = RouterOutputs['apps']['list'][number];
export type CatalogApp = RouterOutputs['store']['catalog'][number];
export type CommunityApp = RouterOutputs['community']['apps'][number];
export type StatsSnapshot = RouterOutputs['stats']['get'];
export type SystemInfo = RouterOutputs['system']['info'];
export type UpdateInfo = RouterOutputs['system']['checkUpdate'];
export type PlatformSettings = RouterOutputs['settings']['get'];
