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
import { getSettings } from '../settings/store';
import { changelogUrl, osBranch, type Channel } from '../system/channel';

// Which branch depends on the channel: Stable reads master, Development reads dev.
// (system/channel.ts owns the mapping — the channel value is not the branch name.)

const CACHE_TTL_MS = 30 * 60 * 1000;
/** A changelog is prose; anything this big is not our file. */
const MAX_BYTES = 256 * 1024;

// Keyed by channel: switching must not hand back the other channel's notes.
const cache = new Map<Channel, { at: number; text: string }>();

export interface Changelog {
  /** The raw markdown, or '' when we have never managed to fetch it. */
  text: string;
  /** False when this came from cache after a failed refresh (UI says so). */
  fresh: boolean;
  /** Which channel's notes these are, so the UI can say so. */
  channel: Channel;
}

export async function fetchChangelog(force = false): Promise<Changelog> {
  const channel = getSettings().updateChannel;
  const hit = cache.get(channel);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { text: hit.text, fresh: true, channel };
  }
  try {
    const res = await fetch(changelogUrl(channel), {
      headers: { accept: 'text/plain' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`changelog HTTP ${res.status}`);
    const text = (await res.text()).slice(0, MAX_BYTES);
    cache.set(channel, { at: Date.now(), text });
    return { text, fresh: true, channel };
  } catch (err) {
    // Offline is the normal case on a masjid LAN with a flaky uplink, so this is
    // a warning, not an error, and we serve whatever we last had.
    log.warn(`Could not fetch the changelog from ${osBranch(channel)} (offline?).`, err);
    return { text: hit?.text ?? '', fresh: false, channel };
  }
}

/** Drop cached changelogs — called after a channel switch. */
export function clearChangelogCache(): void {
  cache.clear();
}
