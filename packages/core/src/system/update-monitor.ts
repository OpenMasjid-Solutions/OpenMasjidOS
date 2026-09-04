// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Update-available monitor. Periodically checks for a new OpenMasjidOS core version
 * AND a newer version of any installed catalog app, and raises the OS `core-update`
 * / `app-update` alerts THE MOMENT one is first detected. Without this the alert
 * types exist in the Settings → Alerts matrix but nothing ever fires them — the
 * on-demand checks only run when the dashboard asks.
 *
 * deliverAlert() gates on the admin's per-alert × per-channel matrix, so each alert
 * goes to whichever of {email, webhook} the admin left on (both by default).
 *
 * We alert ONCE per newly-available version (tracked in memory) so a pending update
 * doesn't re-notify every cycle; if an even newer version later appears, that's a
 * new version and alerts again. When an update is applied (or disappears) the
 * tracking resets, so the next one re-alerts cleanly.
 */
import { checkForUpdate } from './system';
import { listInstalled, checkCatalogUpdate } from '../apps/manager';
import { fetchCatalog } from '../store/catalog';
import { deliverAlert } from '../notify/alerts';
import { coreUpdate, appUpdate } from '../notify/alert-copy';
import { log } from '../logger';

const CHECK_MS = 30 * 60_000; // every 30 minutes
const FIRST_CHECK_MS = 30_000; // shortly after boot (let the network/catalog settle)

let alertedCore: string | null = null; // latest core version already alerted about
const alertedApp = new Map<string, string>(); // appId -> latest version already alerted

async function checkCore(): Promise<void> {
  try {
    const u = await checkForUpdate();
    if (u.updateAvailable && u.latest) {
      if (alertedCore === u.latest) return; // already told the admin about this version
      alertedCore = u.latest;
      // Wording lives in notify/alert-copy.ts — the monitors decide WHEN to alert,
      // not what it says. `text` is the webhook channel's body, so it gets the
      // summary rather than being left empty.
      const copy = coreUpdate(u.current, u.latest);
      await deliverAlert({ source: 'os', text: copy.summary, ...copy });
    } else if (u.latest != null) {
      // Only forget the dedupe when the check actually SUCCEEDED.
      //
      // `checkForUpdate()` swallows a failed fetch and returns `latest: null` —
      // it does not throw — so the `catch` below can never see an offline check, and
      // this branch used to treat "the internet was down" as "there is no update",
      // clearing `alertedCore` and re-emailing the admin about the same version on the
      // next successful cycle. On a flaky uplink that is one email per outage.
      //
      // This is the same rule as the Stripe dispute poller and the WhatsApp health
      // monitor (CLAUDE.md §13.2d): a failure to ask records nothing and decides
      // nothing. `latest` is non-null only when a well-formed VERSION came back.
      alertedCore = null;
    }
  } catch (err) {
    log.warn(`core update check failed: ${(err as Error).message}`);
  }
}

async function checkApps(): Promise<void> {
  try {
    // Freshen the catalog first so we see versions published since the last check.
    await fetchCatalog(true).catch(() => undefined);
    const apps = await listInstalled();
    const seen = new Set<string>();
    for (const a of apps) {
      if (a.kind !== 'catalog') continue; // community/custom apps have no store source
      seen.add(a.id);
      const u = await checkCatalogUpdate(a.id);
      // What earns an email, and what does not:
      //
      //  'version'  yes — a genuinely newer version. True on Development too now that
      //             dev builds carry prerelease versions (`0.11.0-dev.2`), so a new
      //             Development build notifies exactly like a Stable release. It used
      //             to be unnotifiable: the version never moved, so the only signal
      //             was "the image MIGHT have changed", which is true on every cycle
      //             forever and is therefore nagging rather than news.
      //  'channel'  never — the admin started that switch and can see it in the
      //             dashboard. Emailing it produced nonsense like "OpenMasjid
      //             Students can be updated to version 0.45.1" sent to someone
      //             already running 0.45.1.
      const worthEmailing = u.reason === 'version';
      if (u.updateAvailable && u.latest && worthEmailing) {
        if (alertedApp.get(a.id) === u.latest) continue;
        alertedApp.set(a.id, u.latest);
        const copy = appUpdate(a.name, u.current, u.latest);
        await deliverAlert({ source: 'os', text: copy.summary, ...copy });
      } else {
        alertedApp.delete(a.id);
      }
    }
    // Forget apps that are no longer installed.
    for (const id of [...alertedApp.keys()]) if (!seen.has(id)) alertedApp.delete(id);
  } catch (err) {
    log.warn(`app update check failed: ${(err as Error).message}`);
  }
}

async function tick(): Promise<void> {
  await checkCore();
  await checkApps();
}

export function startUpdateMonitor(): void {
  const first = setTimeout(() => void tick(), FIRST_CHECK_MS);
  first.unref?.();
  const timer = setInterval(() => void tick(), CHECK_MS);
  timer.unref?.();
  log.info('Update-available alert monitor started.');
}
