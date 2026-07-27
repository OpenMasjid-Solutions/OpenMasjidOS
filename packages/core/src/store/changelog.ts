// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * "What's new" — fetches the project CHANGELOG.md so the dashboard can show what
 * a release contains.
 *
 * Fetched from `master` at view time rather than baked into the image, and this is
 * the whole point: a version baked in can only ever describe the version you are
 * ALREADY running, which is backwards for the question an admin actually has
 * ("what's in the update you're offering me?"). The trade is that it needs
 * internet — the same trade the existing update check already makes, and it fails
 * soft the same way.
 *
 * Fetched SERVER-side, like the catalog: the dashboard is LAN-only and must never
 * be asked to reach GitHub from the browser.
 */
import { log } from '../logger';

const CHANGELOG_URL =
  process.env.OPENMASJID_CHANGELOG_URL ??
  'https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidOS/master/CHANGELOG.md';

const CACHE_TTL_MS = 30 * 60 * 1000;
/** A changelog is prose; anything this big is not our file. */
const MAX_BYTES = 256 * 1024;

let cache: { at: number; text: string } | null = null;

export interface Changelog {
  /** The raw markdown, or '' when we have never managed to fetch it. */
  text: string;
  /** False when this came from cache after a failed refresh (UI says so). */
  fresh: boolean;
}

export async function fetchChangelog(force = false): Promise<Changelog> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return { text: cache.text, fresh: true };
  }
  try {
    const res = await fetch(CHANGELOG_URL, {
      headers: { accept: 'text/plain' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`changelog HTTP ${res.status}`);
    const text = (await res.text()).slice(0, MAX_BYTES);
    cache = { at: Date.now(), text };
    return { text, fresh: true };
  } catch (err) {
    // Offline is the normal case on a masjid LAN with a flaky uplink, so this is
    // a warning, not an error, and we serve whatever we last had.
    log.warn('Could not fetch the changelog (offline?).', err);
    return { text: cache?.text ?? '', fresh: false };
  }
}
