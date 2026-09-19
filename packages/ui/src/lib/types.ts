// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * UI-side types derived from the tRPC router — never hand-duplicated
 * (CLAUDE.md §6, §15). If the server changes shape, these follow automatically.
 */
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@openmasjid/core';

export type RouterOutputs = inferRouterOutputs<AppRouter>;

export type InstalledApp = RouterOutputs['apps']['list'][number];
/** Why an app is held for review (null on the row when it is free to start). */
export type AppReview = NonNullable<InstalledApp['review']>;
export type CatalogApp = RouterOutputs['store']['catalog'][number];
export type CommunityApp = RouterOutputs['community']['apps'][number];
export type StatsSnapshot = RouterOutputs['stats']['get'];
export type SystemInfo = RouterOutputs['system']['info'];
export type UpdateInfo = RouterOutputs['system']['checkUpdate'];
export type PlatformSettings = RouterOutputs['settings']['get'];
