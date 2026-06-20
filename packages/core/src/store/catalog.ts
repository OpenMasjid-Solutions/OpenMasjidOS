/**
 * App Store catalog client. The catalog is a static catalog.json published by
 * the separate OpenMasjidAPPS repo — there is no app-store server to run. We
 * fetch it, cache it briefly, and fail soft (empty list) so a missing or
 * unreachable catalog never breaks the dashboard.
 */
import { CATALOG_URL } from '../config';
import { log } from '../logger';
import { isValidAppId } from '../util/id';
import type { CatalogApp } from '../apps/types';

const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: { at: number; apps: CatalogApp[] } | null = null;

export async function fetchCatalog(force = false): Promise<CatalogApp[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.apps;
  }
  try {
    const res = await fetch(CATALOG_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`catalog HTTP ${res.status}`);
    const data = (await res.json()) as unknown;
    const apps = normalise(data);
    cache = { at: Date.now(), apps };
    return apps;
  } catch (err) {
    log.warn('Could not fetch app catalog (showing what we have).', err);
    return cache?.apps ?? [];
  }
}

/** Accept either a bare array or a { apps: [...] } envelope. */
function normalise(data: unknown): CatalogApp[] {
  const arr = Array.isArray(data)
    ? data
    : Array.isArray((data as { apps?: unknown })?.apps)
      ? (data as { apps: unknown[] }).apps
      : [];
  return arr.filter(
    (a): a is CatalogApp =>
      typeof a === 'object' &&
      a !== null &&
      typeof (a as CatalogApp).id === 'string' &&
      // The catalog is untrusted external data — drop any entry whose id could
      // escape the apps dir when used as a path segment (security audit).
      isValidAppId((a as CatalogApp).id),
  );
}

export async function findCatalogApp(id: string): Promise<CatalogApp | undefined> {
  const apps = await fetchCatalog();
  return apps.find((a) => a.id === id);
}
