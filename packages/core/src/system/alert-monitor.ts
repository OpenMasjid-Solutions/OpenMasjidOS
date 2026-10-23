// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * App-offline monitor. Polls installed apps' running state and raises the OS
 * `app-offline` alert when an app that WAS running is now stopped — unless the
 * admin just stopped/restarted/updated it (offline-suppress). The very first poll
 * only records state (no boot-time noise). deliverAlert() gates on the admin's
 * granular on/off + sends to the admin email + webhook.
 */
import { isUpdating } from './update-lock';
import { listInstalledWithHealth } from '../apps/manager';
import { deliverAlert } from '../notify/alerts';
import { appOffline } from '../notify/alert-copy';
import { isOfflineSuppressed } from './offline-suppress';
import { log } from '../logger';

const CHECK_MS = 60_000;
const wasRunning = new Map<string, boolean>();
let primed = false;

async function tick(): Promise<void> {
  // A restore pauses every app on purpose and starts them again at its end; each looked
  // like an outage, and the alert told the admin to press Start — over data still being
  // put back. An app that does not come back is named by the restore itself — its window
  // and the report the dashboard shows after the restart (system/restore.ts) — since the
  // first check after a restart only records what it finds.
  if (isUpdating('restore')) return;
  let apps;
  try {
    const r = await listInstalledWithHealth();
    // A Docker hiccup reports EVERY app as not-running, which this loop would read as
    // every app going offline at once and email an alert for each. The catch below was
    // meant to cover that and could not: nothing throws, the list just comes back with
    // `running: false` everywhere. "Could not ask" is not "they are all down".
    if (!r.discoveryOk) return;
    apps = r.apps;
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
