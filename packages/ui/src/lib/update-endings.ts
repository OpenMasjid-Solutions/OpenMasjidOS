// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * What the close of an app's update stream means — for the windows that stream one
 * (AppUpdate, UpdateAllApps, ChannelMigrate). React-free, so a core test can hold it to
 * the server's codes (packages/core/src/api/app-update.ts `APP_UPDATE_CLOSE`).
 *
 * The windows used to read every close as success: "<app> is up to date now." over an
 * update that was refused, put back after a failed download, or never even began — and
 * "All 4 apps updated." over a run in which one did not come back.
 */
export type AppUpdateEnding = 'updated' | 'unchanged' | 'notRunning' | 'stopped' | 'lost' | 'unreachable';

/** The server's codes (APP_UPDATE_CLOSE); any other 4xxx means nothing was changed. */
export const APP_UPDATE_CODES = { updated: 1000, stopped: 4002, notRunning: 4003 } as const;

export function appUpdateEnding(code: number, opened: boolean): AppUpdateEnding {
  if (!opened) return 'unreachable'; // never connected: the update never began
  if (code === APP_UPDATE_CODES.updated) return 'updated';
  if (code === APP_UPDATE_CODES.notRunning) return 'notRunning';
  if (code === APP_UPDATE_CODES.stopped) return 'stopped';
  if (code >= 4000 && code <= 4999) return 'unchanged';
  return 'lost'; // dropped part-way: it may still be finishing on the server
}
