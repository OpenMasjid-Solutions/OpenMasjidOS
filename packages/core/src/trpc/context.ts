/**
 * tRPC request context. Resolves the signed-in admin from the session cookie
 * for BOTH HTTP requests and the WebSocket upgrade request (we parse the raw
 * Cookie header so it works in either case). Cookie mutation helpers are only
 * present for HTTP, where a Fastify reply exists.
 */
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';
import { TRPCError } from '@trpc/server';
import { COOKIE_NAME, CSRF_HEADER, getSessionUser, SESSION_TTL_MS } from '../auth/sessions';
import { isAllowedWsOrigin, isWebSocketUpgrade } from '../util/origin';

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'strict' as const,
  path: '/',
  // Not Secure: the dashboard is served over plain HTTP on the LAN (CLAUDE.md §9).
  maxAge: Math.floor(SESSION_TTL_MS / 1000),
};

export interface Context {
  username: string | null;
  sessionToken: string | null;
  /** The dashboard key presented on this request (CSRF_HEADER) — checked against
   *  the session for cookie-authenticated HTTP calls (protectedProcedure). */
  csrf: string | null;
  /** True for the WebSocket-transport context (live subscriptions). WS upgrades
   *  can't carry custom headers, so the dashboard key is enforced on the raw WS
   *  routes via a query param instead; tRPC subscriptions stay origin-guarded. */
  isWebSocket: boolean;
  /** Client IP, used for login-failure backoff. */
  ip: string;
  /** Host header (how the client reached the platform) — used to derive the
   *  base URL injected into installed apps for the OpenMasjidOS Fabric (SSO). */
  host: string | null;
  setSessionCookie?: (token: string) => void;
  clearSessionCookie?: () => void;
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      const raw = part.slice(idx + 1).trim();
      // A malformed %-escape must not throw and 500 every request.
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

export function createContext({ req, res }: CreateFastifyContextOptions): Context {
  // Reject cross-origin WebSocket upgrades (CSWSH) before doing anything else.
  if (isWebSocketUpgrade(req) && !isAllowedWsOrigin(req)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Bad origin.' });
  }

  const token =
    (req.cookies && req.cookies[COOKIE_NAME]) ?? parseCookie(req.headers?.cookie, COOKIE_NAME);
  const username = getSessionUser(token);
  const csrfHeader = req.headers?.[CSRF_HEADER];

  const canMutateCookies = res && typeof res.setCookie === 'function';
  return {
    username,
    sessionToken: token ?? null,
    csrf: typeof csrfHeader === 'string' ? csrfHeader : null,
    isWebSocket: isWebSocketUpgrade(req),
    ip: req.ip,
    host: req.headers?.host ?? null,
    setSessionCookie: canMutateCookies ? (t: string) => res.setCookie(COOKIE_NAME, t, COOKIE_OPTS) : undefined,
    clearSessionCookie: canMutateCookies ? () => res.clearCookie(COOKIE_NAME, { path: '/' }) : undefined,
  };
}
