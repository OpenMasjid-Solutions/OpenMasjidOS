// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The dashboard key (CSRF token). The platform requires it on every cookie-
 * authenticated request, and it lives ONLY here — on the masjid's network, in this
 * origin's localStorage. The session cookie is shared with any installed app on another port of the
 * same host, but localStorage is scoped to the exact origin (port included), so
 * an app physically cannot read this key and therefore cannot replay the cookie
 * to act as the admin (security: Fabric/SSO session-replay).
 *
 * Delivered in the auth response body (login / first-run / change-password),
 * never in a cookie. HTTP calls send it in the `x-omos-csrf` header; raw
 * WebSocket/download URLs (which can't set headers) carry it as `?k=`.
 *
 * FROM OUTSIDE IT IS NEVER STORED. There the dashboard shares its address — and so
 * this origin's storage — with every app page, so the key lives in this page's
 * memory only. The server marks every remote dashboard page with
 * `<meta name="omos-key">`, holding the key when the browser loaded the page itself
 * (core api/static-ui.ts `registerRemoteDashboardPages`), so a reload keeps the
 * admin signed in without the key ever touching storage.
 */
const KEY = 'omos.dashboardKey';

const remoteMeta = typeof document === 'undefined' ? null : document.querySelector('meta[name="omos-key"]');
/** The key, in memory, on the remote dashboard; null on the masjid's network. */
let memoryKey: string | null = remoteMeta ? (remoteMeta.getAttribute('content') ?? '') : null;
if (memoryKey !== null) {
  try {
    localStorage.removeItem(KEY); // anything left from before has no business here
  } catch {
    /* ignore */
  }
}

export function getCsrf(): string {
  if (memoryKey !== null) return memoryKey;
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function setCsrf(value: string | undefined | null): void {
  if (memoryKey !== null) {
    if (value) memoryKey = value;
    return;
  }
  try {
    if (value) localStorage.setItem(KEY, value);
  } catch {
    /* storage unavailable — the app will fall back to re-login */
  }
}

export function clearCsrf(): void {
  if (memoryKey !== null) {
    memoryKey = '';
    return;
  }
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Append the dashboard key as `?k=`/`&k=` to a same-origin URL/path that can't
 *  carry a header (a WebSocket handshake, an <a href> download, an <img src>). */
export function withKey(pathOrUrl: string): string {
  const key = getCsrf();
  if (!key) return pathOrUrl;
  const sep = pathOrUrl.includes('?') ? '&' : '?';
  return `${pathOrUrl}${sep}k=${encodeURIComponent(key)}`;
}
