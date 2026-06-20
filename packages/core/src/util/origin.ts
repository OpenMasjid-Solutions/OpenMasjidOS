/**
 * WebSocket origin validation — defends against Cross-Site WebSocket Hijacking.
 *
 * SameSite=Strict alone is NOT enough here: the cookie is non-Secure over
 * plain-HTTP LAN, and a browser "site" excludes the port, so a page served by
 * an installed app on the SAME host but a different port is "same-site" and its
 * WS handshake would still carry the session cookie. So we verify the Origin
 * header (host + port) matches the host the request actually came in on.
 *
 * Only enforced in production: in dev the Vite proxy deliberately makes the
 * Origin (5173) and Host (8723) differ. Browsers always send Origin on a WS
 * handshake, so a missing Origin means a non-browser client (not a CSWSH
 * vector) and is allowed. An optional allowlist supports reverse-proxy setups.
 */
import type { FastifyRequest } from 'fastify';
import { IS_PRODUCTION } from '../config';

const EXTRA_ORIGINS = (process.env.OPENMASJID_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function isAllowedWsOrigin(req: FastifyRequest): boolean {
  if (!IS_PRODUCTION) return true;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    if (u.host === req.headers.host) return true;
    if (EXTRA_ORIGINS.includes(origin) || EXTRA_ORIGINS.includes(u.host)) return true;
    return false;
  } catch {
    return false;
  }
}

/** True when this request is a WebSocket upgrade. */
export function isWebSocketUpgrade(req: FastifyRequest): boolean {
  return String(req.headers.upgrade ?? '').toLowerCase() === 'websocket';
}
