/** Shared session-cookie auth for the raw WebSocket / streaming HTTP routes. */
import type { FastifyRequest } from 'fastify';
import { COOKIE_NAME, CSRF_HEADER, getSessionUser, verifyCsrf } from '../auth/sessions';

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx !== -1 && part.slice(0, idx).trim() === name) {
      const raw = part.slice(idx + 1).trim();
      // A malformed %-escape must not throw in every WS/streaming route.
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

function tokenOf(req: FastifyRequest): string | null {
  return (req.cookies && req.cookies[COOKIE_NAME]) ?? parseCookie(req.headers?.cookie, COOKIE_NAME);
}

export function wsAuthed(req: FastifyRequest): boolean {
  return Boolean(getSessionUser(tokenOf(req)));
}

/**
 * Verify the dashboard key on a cookie-authenticated raw route (WS or streaming
 * HTTP). The browser can't set headers on a WS handshake or an <img>/<a> load,
 * so these routes carry the key in a `k` query param; a plain HTTP upload may
 * use the CSRF header instead. Either way an app on another port — which can
 * capture the shared cookie but not read the dashboard's storage — fails this.
 */
export function requestCsrfOk(req: FastifyRequest): boolean {
  const header = req.headers?.[CSRF_HEADER];
  const fromHeader = typeof header === 'string' ? header : null;
  const q = (req.query as { k?: unknown } | undefined)?.k;
  const fromQuery = typeof q === 'string' ? q : null;
  return verifyCsrf(tokenOf(req), fromHeader ?? fromQuery);
}
