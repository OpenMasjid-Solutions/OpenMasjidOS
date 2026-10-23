// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The first path segments the platform keeps for itself on the apps' address, and
 * so can never be an app's public path.
 *
 * ONE list, read by both sides. The ingress refuses to route these (they are the
 * platform's own endpoints), and Settings refuses to give one to an app. When only
 * the ingress knew, an admin could set an app's address to `/api`: accepted without
 * a word, after which the app had no public page at all and opening it from outside
 * landed on a 404.
 *
 * Kept apart from apps/manager.ts and system/ingress.ts because the ingress already
 * imports the manager, and the manager importing the ingress would be a cycle.
 *
 * From outside the dashboard shares the apps' address, so its own pages are here too
 * (system/remote-admin.ts `DASHBOARD_SEGMENTS`; test/app-paths.test.ts keeps the two in
 * step): an app at `/settings` would have taken the dashboard's Settings page on reload.
 */
export const RESERVED_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  'api',
  'trpc',
  'assets',
  'store',
  'apps',
  'files',
  'settings',
  'design-system',
]);

export function isReservedPathSegment(seg: string): boolean {
  return RESERVED_PATH_SEGMENTS.has(seg);
}

/**
 * The shape every app path has: a lower-case letter or digit, then letters, digits and
 * hyphens — what an install or Settings gives an app. The ingress routes nothing else.
 * An app is also recovered from any `omos-*` project Docker reports, under whatever name
 * that project has, and Docker allows `_` in one: a stack started by hand as `omos-_omos`
 * would otherwise have been routed at `/_omos`, the platform's own address for opening an
 * app from outside (system/app-access.ts).
 */
export function isAppPathShape(seg: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,79}$/.test(seg);
}
