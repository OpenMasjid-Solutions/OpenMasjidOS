// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * App-offline monitor. Polls installed apps' running state and raises the OS
 * `app-offline` alert when an app that WAS running is now stopped — unless the
 * admin just stopped/restarted/updated it (offline-suppress). The very first poll
 * only records state (no boot-time noise). deliverAlert() gates on the admin's
 * granular on/off + sends to the admin email + webhook.
 */
import { listInstalled } from '../apps/manager';
import { deliverAlert } from '../notify/alerts';
import { appOffline } from '../notify/alert-copy';
import { isOfflineSuppressed } from './offline-suppress';
import { log } from '../logger';

const CHECK_MS = 60_000;
const wasRunning = new Map<string, boolean>();
let primed = false;

async function tick(): Promise<void> {
  let apps;
  try {
    apps = await listInstalled();
  } catch {
    return; // Docker hiccup — try again next tick
  }
  const seen = new Set<string>();
  for (const a of apps) {
    seen.add(a.id);
    const prev = wasRunning.get(a.id);
    if (primed && prev === true && !a.running && !isOfflineSuppressed(a.id)) {
      // Wording lives in notify/alert-copy.ts; `text` is the webhook body.
      const copy = appOffline(a.name, a.id);
      deliverAlert({ source: 'os', text: copy.summary, ...copy }).catch((err) =>
        log.warn(`app-offline alert failed: ${(err as Error).message}`),
      );
    }
    wasRunning.set(a.id, a.running);
  }
  // Forget apps that are no longer installed (removal isn't an "offline" event).
  for (const id of [...wasRunning.keys()]) if (!seen.has(id)) wasRunning.delete(id);
  primed = true;
}

export function startAlertMonitor(): void {
  void tick();
  const timer = setInterval(() => void tick(), CHECK_MS);
  timer.unref?.();
  log.info('App-offline alert monitor started.');
}
