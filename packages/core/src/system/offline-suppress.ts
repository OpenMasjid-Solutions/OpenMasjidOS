// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Suppression window for the "app offline" alert. When the ADMIN stops / restarts /
 * updates an app, we don't want the offline monitor to fire a false alarm for the
 * brief (or intended) downtime. The lifecycle code marks the app here; the monitor
 * skips an offline alert for it while the window is open. A genuine crash isn't
 * marked, so it still alerts. Standalone (no imports) to avoid a manager↔monitor
 * import cycle.
 */
const suppressedUntil = new Map<string, number>();

/** Suppress the offline alert for this app for `ms` (default 2 min). */
export function suppressOfflineAlert(id: string, ms = 120_000): void {
  suppressedUntil.set(id, Date.now() + ms);
}

/** Is the offline alert currently suppressed for this app? (Self-expiring.) */
export function isOfflineSuppressed(id: string): boolean {
  const t = suppressedUntil.get(id);
  if (t == null) return false;
  if (Date.now() > t) {
    suppressedUntil.delete(id);
    return false;
  }
  return true;
}
