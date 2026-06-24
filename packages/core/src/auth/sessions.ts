/**
 * Server-side sessions. Tokens are long random strings held in memory and set
 * in an HTTP-only, SameSite=Lax cookie (Lax so the cookie rides the top-level
 * "Open app" navigation, which is cross-scheme — HTTPS dashboard → HTTP app — and
 * would drop a Strict cookie). NOT Secure, so HTTP apps still receive it for SSO.
 * Sessions reset on a daemon restart — the admin simply signs in again.
 *
 * Each session also carries a CSRF token (the "dashboard key"). The cookie is
 * SHARED with any installed app on another port of the same host (cookies aren't
 * port-scoped), so a malicious app could capture and replay it. The defence: the
 * dashboard key is delivered ONLY in the auth response body and the dashboard UI
 * keeps it in its own origin's storage (localStorage / a header) — which an app
 * on a different origin (port) physically cannot read. Cookie-authenticated
 * routes require the key, so possessing the cookie alone is not enough to act as
 * the admin (security audit: Fabric/SSO session-replay).
 */
import crypto from 'node:crypto';

export const COOKIE_NAME = 'omos_session';
/** Header the dashboard sends the key in (HTTP); raw WS/download routes use ?k=. */
export const CSRF_HEADER = 'x-omos-csrf';
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface Session {
  username: string;
  csrf: string;
  expiresAt: number;
}

const sessions = new Map<string, Session>();

function sweep(): void {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (s.expiresAt <= now) sessions.delete(token);
  }
}

export interface NewSession {
  token: string;
  /** The dashboard key — returned to the UI, never set in a cookie. */
  csrf: string;
}

export function createSession(username: string): NewSession {
  sweep();
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { username, csrf, expiresAt: Date.now() + TTL_MS });
  return { token, csrf };
}

/** Resolve the username for a token, or null if missing/expired. */
export function getSessionUser(token: string | undefined | null): string | null {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return s.username;
}

/**
 * Constant-time check that `provided` matches the session's dashboard key. A
 * cookie-authenticated request that can't present the key is treated as a
 * replay (e.g. from an app that captured the shared cookie) and rejected.
 */
export function verifyCsrf(token: string | undefined | null, provided: string | undefined | null): boolean {
  if (!token || !provided) return false;
  const s = sessions.get(token);
  if (!s || s.expiresAt <= Date.now()) return false;
  const a = Buffer.from(s.csrf);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function destroySession(token: string | undefined | null): void {
  if (token) sessions.delete(token);
}

/** Drop every session — used after a password change so old cookies die. */
export function destroyAllSessions(): void {
  sessions.clear();
}

export const SESSION_TTL_MS = TTL_MS;
