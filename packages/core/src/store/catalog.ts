// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * App Store catalog client. The catalog is a static catalog.json published by
 * the separate OpenMasjidAPPS repo — there is no app-store server to run. We
 * fetch it, cache it briefly, and fail soft (empty list) so a missing or
 * unreachable catalog never breaks the dashboard.
 *
 * Which catalog depends on the update channel (system/channel.ts): Stable reads
 * OpenMasjidAPPS's `main` branch, Development reads its `dev` branch. The schema is
 * identical — the dev branch simply resolves each app to its dev branch and `:dev`
 * image tags.
 */
import { log } from '../logger';
import { isValidAppId } from '../util/id';
import type { CatalogApp } from '../apps/types';
import { getSettings } from '../settings/store';
import { catalogUrl, type Channel } from '../system/channel';

const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Cache keyed BY CHANNEL, not a single slot. With one slot, switching channel and
 * reading within the TTL would hand back the other channel's entries — and the
 * install/update paths would then write the wrong channel's compose while the UI
 * said otherwise. Keying it means a switch can never serve stale cross-channel data,
 * even if nobody remembered to force a refresh.
 */
const cache = new Map<Channel, { at: number; apps: CatalogApp[] }>();

function currentChannel(): Channel {
  return getSettings().updateChannel;
}

export async function fetchCatalog(force = false, channel: Channel = currentChannel()): Promise<CatalogApp[]> {
  const hit = cache.get(channel);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.apps;
  }
  try {
    const res = await fetch(catalogUrl(channel), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`catalog HTTP ${res.status}`);
    const data = (await res.json()) as unknown;
    const apps = normalise(data);
    cache.set(channel, { at: Date.now(), apps });
    return apps;
  } catch (err) {
    log.warn(`Could not fetch the ${channel} app catalog (showing what we have).`, err);
    return hit?.apps ?? [];
  }
}

/**
 * Fetch a channel's catalog and THROW if it can't be had — for the channel switch,
 * which must refuse rather than half-switch. `fetchCatalog` deliberately fails soft
 * (a flaky uplink must not empty the App Store), but "I could not read the channel
 * you are switching to" has to be a hard error, or we would persist a channel whose
 * catalog we have never seen.
 */
export async function requireCatalog(channel: Channel): Promise<CatalogApp[]> {
  const res = await fetch(catalogUrl(channel), {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`The ${channel} catalog could not be read (HTTP ${res.status}).`);
  const apps = normalise((await res.json()) as unknown);
  if (apps.length === 0) throw new Error(`The ${channel} catalog is empty or not in the expected format.`);
  cache.set(channel, { at: Date.now(), apps });
  return apps;
}

/** Drop cached catalogs — called after a channel switch so nothing stale survives. */
export function clearCatalogCache(): void {
  cache.clear();
}

/** Keep a URL only if it is http(s) — these render as <img src>/links in the
 *  admin's browser, and the catalog is untrusted external data. */
function httpUrl(v: unknown): string | undefined {
  return typeof v === 'string' && /^https?:\/\//i.test(v) ? v : undefined;
}

/** Accept either a bare array or a { apps: [...] } envelope. */
function normalise(data: unknown): CatalogApp[] {
  const arr = Array.isArray(data)
    ? data
    : Array.isArray((data as { apps?: unknown })?.apps)
      ? (data as { apps: unknown[] }).apps
      : [];
  return arr
    .filter(
      (a): a is CatalogApp =>
        typeof a === 'object' &&
        a !== null &&
        typeof (a as CatalogApp).id === 'string' &&
        // The catalog is untrusted external data — drop any entry whose id could
        // escape the apps dir when used as a path segment (security audit).
        isValidAppId((a as CatalogApp).id),
    )
    .map((a) => ({
      ...a,
      // Scheme-validate URLs that the UI renders, like the CasaOS community path.
      icon: httpUrl(a.icon),
      screenshots: Array.isArray(a.screenshots)
        ? a.screenshots.map(httpUrl).filter((u): u is string => !!u)
        : undefined,
    }));
}

export async function findCatalogApp(id: string): Promise<CatalogApp | undefined> {
  const apps = await fetchCatalog();
  return apps.find((a) => a.id === id);
}
