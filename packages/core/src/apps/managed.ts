// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Platform-managed apps: catalog apps the OS itself drives, rather than ones a masjid
 * uses directly.
 *
 * OpenWA is the first. It is a WhatsApp *engine*, not a destination — the platform owns
 * its session, creates it, starts it, requests the pairing code and does every send
 * through one paced queue (`notify/whatsapp.ts`). Presenting it as an ordinary app card
 * invites exactly the actions that break that: linking a second phone in its own web UI,
 * or sending from there and bypassing the pacing that keeps the number unbanned. So it is
 * hidden from the dashboard grid, and hidden from the App Store until the admin turns
 * WhatsApp on in Settings and accepts the risk warning.
 *
 * Distinct from `RESERVED_APP_IDS`, which is OS infrastructure that is never an app at
 * all (the tunnel container). A managed app IS a real installed app with real data — it
 * is just reached through Settings instead of the dashboard.
 *
 * Deliberately a platform-side list rather than a manifest flag: the catalog is owned by
 * OpenMasjidAPPS, and which apps this OS drives itself is this repo's business, not the
 * catalog's. If a second one ever appears, that is the moment to reconsider.
 */

/** Catalog id of the WhatsApp gateway the platform drives. */
export const OPENWA_APP_ID = 'openwa';

const MANAGED = new Set<string>([OPENWA_APP_ID]);

export function isPlatformManaged(id: string): boolean {
  return MANAGED.has(id);
}

/**
 * The catalog as an admin should see it.
 *
 * A managed app is listed only once the feature that drives it is switched on, because
 * installing it on its own does nothing useful and quite a lot that is harmful: OpenWA
 * links a phone to an unofficial WhatsApp client, and the warning explaining that lives
 * on the switch. Off, the app simply is not offered.
 *
 * Pure, so the rule is testable without a catalog fetch or a config file.
 */
export function visibleCatalog<T extends { id: string }>(apps: T[], opts: { whatsappEnabled: boolean }): T[] {
  return apps.filter((a) => {
    if (!isPlatformManaged(a.id)) return true;
    if (a.id === OPENWA_APP_ID) return opts.whatsappEnabled;
    // A managed app nobody has wired a gate to stays hidden — fail closed, so adding an
    // id to MANAGED can never accidentally leave it visible.
    return false;
  });
}
