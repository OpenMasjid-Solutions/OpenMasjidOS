// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * A progress window (an update, a restore) shows plain lines only: a tool's own output
 * goes to the server log, never to a volunteer (CLAUDE.md §14). So a step that takes a
 * while — a download, starting an app — would leave the window still for minutes, which
 * reads as "it has frozen". This puts a plain line in it every 30 s until the step
 * settles, however it settles.
 *
 * No wait is promised: a real build once took nearly two hours to publish.
 */
export const STILL_DOWNLOADING = 'Still downloading — this can take a while on a slow connection.';
export const STILL_WORKING = 'Still working on it…';

export async function withHeartbeat<T>(onLine: (s: string) => void, line: string, work: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => onLine(line), 30_000);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}
