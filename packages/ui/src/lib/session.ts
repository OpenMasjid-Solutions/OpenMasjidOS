/**
 * The dashboard key (CSRF token). The platform requires it on every cookie-
 * authenticated request, and it lives ONLY here — in this origin's localStorage.
 * The session cookie is shared with any installed app on another port of the
 * same host, but localStorage is scoped to the exact origin (port included), so
 * an app physically cannot read this key and therefore cannot replay the cookie
 * to act as the admin (security: Fabric/SSO session-replay).
 *
 * Delivered in the auth response body (login / first-run / change-password),
 * never in a cookie. HTTP calls send it in the `x-omos-csrf` header; raw
 * WebSocket/download URLs (which can't set headers) carry it as `?k=`.
 */
const KEY = 'omos.dashboardKey';

export function getCsrf(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function setCsrf(value: string | undefined | null): void {
  try {
    if (value) localStorage.setItem(KEY, value);
  } catch {
    /* storage unavailable — the app will fall back to re-login */
  }
}

export function clearCsrf(): void {
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
