// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Keeps installed apps pointed at the dashboard when the machine's address
 * changes (a new subnet, a new DHCP lease, a router swap).
 *
 * Before this existed the platform address was resolved once at install time and
 * never revisited, so moving the box to another subnet left every app calling an
 * address that no longer answered — `EHOSTUNREACH` on every Fabric call, with no
 * symptom on the dashboard itself. The repair code existed but only ran after a
 * restore.
 *
 * Restarting an app is real downtime, so this is deliberately conservative:
 *   - it only acts when the resolved address is the SAME on two consecutive
 *     ticks (a multi-NIC / VPN / Tailscale host can otherwise flap between
 *     candidates and restart apps in a loop),
 *   - it only restarts apps that are ALREADY RUNNING — never resurrects one the
 *     admin deliberately stopped. One that is not running when the address changes
 *     (a crash loop between restarts), or whose restart fails, is asked about again
 *     on every later check until it has been recreated with the new address,
 *   - it re-runs the compose risk gate first, as well as `startApp`'s own check of the
 *     persisted verdict (CLAUDE.md §15): `reupAllApps` leaves a refused, dangerous
 *     compose on disk precisely so it is NOT started, and an unattended timer must not
 *     become the thing that starts it,
 *   - it stands aside while a restore runs: the apps' files are being replaced, and a
 *     rewrite of their settings then lands in a tree about to be swapped out,
 *   - and it suppresses the offline alert around the restart, so a reconnect
 *     never emails the admin that their app went down.
 */
import fs from 'node:fs';
import { listInstalledWithHealth, reconcileBaseUrls, startApp, composePathOf } from '../apps/manager';
import { checkCompose } from '../apps/compose-validate';
import { suppressOfflineAlert } from './offline-suppress';
import { desiredAddress } from './platform-address';
import { isUpdating } from './update-lock';
import { log } from '../logger';

/** First check shortly after boot — the common case is "rebooted on a new
 *  subnet", and we want apps working before anyone notices. */
const BOOT_DELAY_MS = 20_000;
const INTERVAL_MS = 5 * 60_000;

/** The address seen on the previous tick, for the two-tick stability rule. */
let lastSeen: string | null = null;

/** Apps given the new address that have not been recreated with it yet. The .env is
 *  rewritten only once, so without this a skipped app was never looked at again. */
const awaitingRestart = new Set<string>();

/** Is this app's on-disk compose safe to start unattended? */
function safeToStart(id: string): boolean {
  const file = composePathOf(id);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false; // no compose we can vet — leave it alone
  }
  try {
    const { dangers, refusals } = checkCompose(text);
    return refusals.length === 0 && dangers.length === 0;
  } catch {
    return false;
  }
}

/**
 * Rewrite every app's platform address and restart the ones that need it.
 * Exported so the admin can trigger it from Settings without waiting for a tick.
 */
export async function reconcileNow(): Promise<{ updated: string[]; restarted: string[] }> {
  const { changed, needRestart } = reconcileBaseUrls();
  if (changed.length > 0) log.info(`Platform address changed — updated ${changed.length} app(s).`);
  for (const id of needRestart) awaitingRestart.add(id);
  if (awaitingRestart.size === 0) return { updated: changed, restarted: [] };

  // Could not ask Docker: decide nothing, and ask again next time.
  const { apps, discoveryOk } = await listInstalledWithHealth();
  if (!discoveryOk) return { updated: changed, restarted: [] };
  const installed = new Map(apps.map((a) => [a.id, a]));
  const restarted: string[] = [];
  for (const id of [...awaitingRestart]) {
    // Taken out while it is handled (so a check running alongside skips it), and put
    // back whenever it is not done.
    if (!awaitingRestart.delete(id)) continue;
    const app = installed.get(id);
    if (!app) continue; // removed meanwhile
    if (!app.running) {
      awaitingRestart.add(id); // not now, but not forgotten
      continue;
    }
    if (!safeToStart(id)) {
      // Held for review: the admin's own Start recreates it with the new address.
      log.warn(`Not restarting ${id} after an address change — its compose needs review first.`);
      continue;
    }
    try {
      suppressOfflineAlert(id);
      await startApp(id);
      restarted.push(id);
    } catch (err) {
      awaitingRestart.add(id);
      log.warn(`Could not restart ${id} after the address change; will try again.`, err);
    }
  }
  return { updated: changed, restarted };
}

async function tick(): Promise<void> {
  if (isUpdating('restore')) return;
  try {
    const addr = desiredAddress();
    if (!addr) return;
    // Require two consecutive agreeing ticks before touching anything.
    const stable = addr === lastSeen;
    lastSeen = addr;
    if (!stable) return;
    await reconcileNow();
  } catch (err) {
    log.warn('Address check failed.', err);
  }
}

export function startAddressMonitor(): void {
  const boot = setTimeout(() => {
    // Seed `lastSeen` on the first run so the second tick can confirm it.
    void tick().then(() => void tick());
  }, BOOT_DELAY_MS);
  boot.unref?.();
  const timer = setInterval(() => void tick(), INTERVAL_MS);
  timer.unref?.();
}
