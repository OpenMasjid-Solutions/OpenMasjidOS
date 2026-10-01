// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * tRPC request context. Resolves the signed-in admin from the session cookie
 * for BOTH HTTP requests and the WebSocket upgrade request (we parse the raw
 * Cookie header so it works in either case). Cookie mutation helpers are only
 * present for HTTP, where a Fastify reply exists.
 */
// Type-only side-effect import: @fastify/cookie augments Fastify's request/reply
// with cookies/setCookie/clearCookie, and this file USES them. Relying on some
// other file in the program to have imported the plugin makes the types depend
// on which tsconfig compiles us — the UI typechecks this file too (it infers
// AppRouter from here), and there the augmentation wasn't loaded. Declaring the
// dependency where it's used fixes that without emitting a runtime import.
import type {} from '@fastify/cookie';
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';
import { TRPCError } from '@trpc/server';
import { COOKIE_NAME, CSRF_HEADER, getSessionUser, SESSION_TTL_MS } from '../auth/sessions';
import { isAllowedWsOrigin, isWebSocketUpgrade } from '../util/origin';
import { isViaTunnel, visitorScheme } from '../system/via-tunnel';
import { observeDashboardHost } from '../system/platform-address';

const COOKIE_OPTS = {
  httpOnly: true,
  // Lax, not Strict: the dashboard is HTTPS but apps are served over HTTP, so
  // clicking "Open" is a cross-scheme top-level navigation that browsers treat as
  // cross-site ("schemeful same-site"). Strict would withhold the cookie there,
  // breaking SSO on the first open; Lax still rides top-level GET navigations.
  // CSRF/replay is blocked by the origin-bound dashboard key, not by SameSite.
  sameSite: 'lax' as const,
  path: '/',
  // Secure is OPT-IN (OPENMASJID_SECURE_COOKIE=1). By default it is OFF because an
  // installed app on a plain-HTTP port must still receive the forwarded session
  // cookie for SSO, and a Secure cookie is never sent over HTTP. The dashboard is
  // HTTPS-forced, so the cookie is already encrypted in transit to the dashboard,
  // and the origin-bound dashboard key (not the cookie) is what blocks replay — so
  // leaving this off is safe on a trusted LAN. Turn it ON when the whole
  // deployment is end-to-end HTTPS (e.g. behind a reverse proxy / Tailscale Serve)
  // or you don't use HTTP-app SSO, to harden the dashboard cookie on a hostile
  // network. (A fuller fix would be a separate Secure dashboard-only cookie split
  // from the cross-app SSO cookie — see docs/SECURITY.md.)
  secure: process.env.OPENMASJID_SECURE_COOKIE === '1',
  maxAge: Math.floor(SESSION_TTL_MS / 1000),
};

/**
 * Cookie options for THIS request.
 *
 * `Secure` is opt-in and off by default for the reason above — an app on a plain
 * HTTP port needs the forwarded session cookie for SSO. A session created by a
 * visitor who reached Cloudflare over HTTPS is the exception: there is no
 * plain-HTTP app on that origin to keep working, and a session cookie for a
 * hostname that resolves on the public internet must never travel in clear.
 *
 * BOTH conditions, and the second one is the bug this replaced. It used to be
 * `isViaTunnel(req)` alone, with a comment asserting "it reached us through
 * Cloudflare, so the browser is on HTTPS". That inference is false: Cloudflare
 * stamps `cf-ray` on a plain `http://` visit too, and terminating TLS at its edge
 * says nothing about the visitor→edge leg. A browser REJECTS a `Secure` cookie
 * delivered over plain HTTP, so a remote sign-in over `http://` finished its
 * second factor and bounced straight back to the sign-in screen. (The front door
 * now upgrades such a visit to HTTPS before it ever gets here, but the cookie
 * rule must be right on its own rather than relying on that.)
 *
 *  - `cf-ray`, not `isViaTunnel`: `isViaTunnel` is ALSO true for a bare
 *    `x-forwarded-proto: https`, which a masjid's own LAN reverse proxy sends. A
 *    Secure cookie there lands on the LAN hostname, overwrites the non-Secure one
 *    in the same cookie jar, and silently ends SSO for every plain-HTTP app on the
 *    box. That trade-off is the operator's to make, via OPENMASJID_SECURE_COOKIE.
 *  - `visitorScheme === 'https'`, not "not http": unknown is not HTTPS.
 *
 * Per-response rather than per-process, because one daemon issues both kinds and
 * they are genuinely different. The tunnel hostname and the LAN address are
 * separate origins with separate cookie jars, so marking one Secure cannot strand
 * the other.
 */
function cookieOptsFor(req: { headers?: NodeJS.Dict<string | string[]> }) {
  const h = req.headers ?? {};
  const httpsTunnelVisitor = Boolean(h['cf-ray']) && visitorScheme(h) === 'https';
  return { ...COOKIE_OPTS, secure: COOKIE_OPTS.secure || httpsTunnelVisitor };
}

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
  /** Did this request arrive through the Cloudflare tunnel? Decided once, by the
   *  shared detector, so no router re-derives it (see the value's comment). */
  viaTunnel: boolean;
  /** Cloudflare's client IP, and only over the tunnel — off-tunnel the header is
   *  attacker-supplied. This is what lets remote sign-in have a per-IP lockout. */
  remoteIp: string | null;
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

/** A header can arrive as a list (duplicated by a proxy); take the first hop. */
function firstHeader(v: string | string[] | undefined): string | undefined {
  if (v == null) return undefined;
  const first = Array.isArray(v) ? v[0] : v;
  return first?.split(',')[0]?.trim() || undefined;
}

export function createContext({ req, res }: CreateFastifyContextOptions): Context {
  // Reject cross-origin WebSocket upgrades (CSWSH) before doing anything else.
  if (isWebSocketUpgrade(req) && !isAllowedWsOrigin(req)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Bad origin.' });
  }

  const token =
    (req.cookies && req.cookies[COOKIE_NAME]) ?? parseCookie(req.headers?.cookie, COOKIE_NAME);
  const username = getSessionUser(token);
  // The dashboard key. A WebSocket handshake cannot carry a custom header, so the
  // key rides in `?k=` there — the same convention api/ws-auth.ts already uses for
  // every other raw WS route, and for the plain-<a> backup download. Accepting
  // both here is what lets protectedProcedure verify the key on BOTH transports
  // instead of exempting WS (see trpc.ts).
  // On the HTTP path `req` is a Fastify request with `query` already parsed. On the
  // WebSocket path it is a raw Node IncomingMessage — `query` is undefined there,
  // so the key has to come out of the URL by hand. Getting this wrong fails CLOSED
  // (the dashboard's own live-stats subscription stops connecting), which is how I
  // caught it: reading only `req.query` rejected the legitimate dashboard too.
  const csrfHeader = req.headers?.[CSRF_HEADER];
  const fromQueryObject = (req.query as { k?: unknown } | undefined)?.k;
  let fromUrl: string | null = null;
  if (typeof fromQueryObject !== 'string' && typeof req.url === 'string') {
    try {
      fromUrl = new URL(req.url, 'http://placeholder.invalid').searchParams.get('k');
    } catch {
      fromUrl = null; // a malformed URL must not throw during auth
    }
  }
  const csrf =
    typeof csrfHeader === 'string'
      ? csrfHeader
      : typeof fromQueryObject === 'string'
        ? fromQueryObject
        : fromUrl;

  const canMutateCookies = res && typeof res.setCookie === 'function';

  // Learn this machine's LAN address from requests that actually reach us. Only
  // for a signed-in admin, and `observeDashboardHost` keeps just bare IP literals
  // — a name that resolves in the admin's browser usually does not resolve inside
  // an app container. This is what lets apps re-find the dashboard after a subnet
  // move without anyone re-running the installer. /trpc is on the LAN listener
  // only (never the tunnel front door), so the value can't come from the internet.
  if (username) observeDashboardHost(req.headers?.host ?? null);

  return {
    username,
    sessionToken: token ?? null,
    csrf,
    isWebSocket: isWebSocketUpgrade(req),
    ip: req.ip,
    host: req.headers?.host ?? null,
    /**
     * Did this request arrive through the Cloudflare tunnel? Computed HERE, once,
     * from the shared detector — no router re-derives it. This codebase has twice
     * shipped a hand-rolled copy of this check that disagreed with the real one
     * (§15's raw-vs-decoded bullet), and a second factor that is required or not
     * depending on which copy answered is not a second factor.
     */
    viaTunnel: isViaTunnel(req),
    /**
     * The real client address, and ONLY when the request came over the tunnel.
     *
     * Cloudflare sets `cf-connecting-ip` at its edge and a tunnel client cannot
     * forge it — the same property that makes `cf-ray` usable. That is what lets
     * remote sign-in have a genuine PER-IP lockout, where the LAN cannot: Docker's
     * port publishing SNATs every LAN client to the bridge gateway, so there they
     * all look identical (see `util/net.ts`).
     *
     * Null off the tunnel, deliberately. Off-tunnel the header is attacker-supplied,
     * and trusting it would hand any LAN client a way to walk past a per-IP counter
     * by varying one header.
     */
    remoteIp: isViaTunnel(req) ? (firstHeader(req.headers?.['cf-connecting-ip']) ?? null) : null,
    setSessionCookie: canMutateCookies
      ? (t: string) => res.setCookie(COOKIE_NAME, t, cookieOptsFor(req))
      : undefined,
    clearSessionCookie: canMutateCookies ? () => res.clearCookie(COOKIE_NAME, { path: '/' }) : undefined,
  };
}
