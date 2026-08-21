// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Shared "did this request arrive over the Cloudflare tunnel?" detection and the
 * LAN-only guard for the secret-gated Fabric routes.
 *
 * Cloudflare injects a `cf-ray` header and terminates TLS at its edge (so the
 * origin sees `x-forwarded-proto: https`); either signal marks tunnel-origin
 * traffic. The dashboard, tRPC, and the secret-gated Fabric routes must stay
 * LAN-only — only app paths are served publicly (see CLAUDE.md §15). Registered
 * routes skip the front door's notFoundHandler, so the secret routes are kept
 * LAN-only by an explicit onRequest guard, applied here so index.ts, the app-to-
 * app broker, and the ingress /fabric refusal all use ONE implementation.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * `x-forwarded-proto` is attacker-influenced and arrives in more shapes than one
 * exact string: a chained proxy appends (`"https,http"`), Node joins a duplicated
 * header with ", ", and nothing guarantees lowercase. Compare the FIRST hop,
 * trimmed and lowercased, so none of those spellings slips past the check.
 */
function forwardedProtoIsHttps(value: string | string[] | undefined): boolean {
  if (value == null) return false;
  const first = Array.isArray(value) ? value[0] : value;
  return first.split(',')[0]!.trim().toLowerCase() === 'https';
}

/** True when the request reached us through the Cloudflare tunnel (not the LAN). */
export function isViaTunnel(req: FastifyRequest): boolean {
  return Boolean(req.headers['cf-ray']) || forwardedProtoIsHttps(req.headers['x-forwarded-proto']);
}

/** Same check for a raw Node request (used in the ingress reverse proxy / WS path). */
export function isViaTunnelHeaders(headers: NodeJS.Dict<string | string[]>): boolean {
  return Boolean(headers['cf-ray']) || forwardedProtoIsHttps(headers['x-forwarded-proto']);
}

/**
 * The request path, with query/fragment stripped and percent-escapes resolved.
 *
 * Load-bearing for every path comparison in this file: the router matches the
 * DECODED path, so a guard that compared the raw `req.url` could be walked
 * straight past with `/api/%66abric/...` — the raw text doesn't start with
 * `/api/fabric`, but Fastify still dispatched it to the Fabric handler. Callers
 * must test BOTH this and the raw path (see `matchesSecretRoute`) so neither an
 * escaped spelling nor a decode that invents a new segment can win.
 *
 * Decoding is done percent-escape by percent-escape rather than with
 * `decodeURIComponent` on the whole string, so one malformed escape can't throw
 * away the rest of the path.
 */
export function decodedPath(url: string): string {
  const path = url.split('?')[0]!.split('#')[0]!;
  return path.replace(/%[0-9a-fA-F]{2}/g, (esc) => {
    try {
      return decodeURIComponent(esc);
    } catch {
      return esc;
    }
  });
}

/**
 * Collapse `.` and `..` in a path, the way an HTTP server or URL parser would before
 * routing. Only used to make security comparisons see what the far end will see —
 * never to build a URL we then request.
 *
 * Lives here, beside `decodedPath`, because canonicalising a request path before comparing
 * it is one job with one owner. It was private to `system/ingress.ts` and the second caller
 * needed it, which is exactly how a codebase ends up with two subtly different resolvers and
 * a guard that disagrees with the router.
 */
export function resolveDotSegments(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return `/${out.join('/')}`;
}

/**
 * Block the SECRET-GATED Fabric routes when a request arrived via the tunnel.
 * Covers `/api/auth/session` (exact) and everything under `/api/fabric` (prefix)
 * — which includes the app-to-app broker at `/api/fabric/app/*`. App backends
 * always call these over the LAN base URL, so this never breaks a real flow; it
 * only removes the unintended public exposure. `/api/public/appearance` is
 * intentionally NOT matched and stays reachable over the tunnel.
 */
/** Does this URL address a secret-gated route, under ANY spelling the router
 *  would accept? Checked against the raw and the decoded path, so the guard
 *  fails CLOSED for both `/api/fabric/...` and `/api/%66abric/...`. */
export function matchesSecretRoute(url: string): boolean {
  const raw = url.split('?')[0]!.split('#')[0]!;
  // `/api/fabric` stays a broad PREFIX match on purpose: it costs nothing today
  // (no sibling route shares the stem) and it means a future `/api/fabric-*`
  // secret route is covered the moment it is added rather than the moment
  // someone remembers to widen this.
  return [raw, decodedPath(url)].some((p) => p === '/api/auth/session' || p.startsWith('/api/fabric'));
}

/**
 * Does this URL address something under `prefix`, under ANY spelling the router
 * would accept? Tests the raw text AND the decoded path, so it fails CLOSED.
 *
 * This exists because the same mistake has now been made twice: a security hook
 * that compares `req.url` verbatim while Fastify dispatches on the DECODED path,
 * so `/api/%66abric/...` walked past the Fabric guard (fixed in v0.46.0) and
 * `/%74rpc/...` walked past the tRPC origin check the same way. Both are one
 * predicate now — a third caller should reuse it rather than write the
 * comparison a third time.
 */
export function urlHasPrefix(url: string, prefix: string): boolean {
  const raw = url.split('?')[0]!.split('#')[0]!;
  return [raw, decodedPath(url)].some((p) => p.startsWith(prefix));
}

export function registerFabricTunnelGuard(server: FastifyInstance): void {
  server.addHook('onRequest', (req, reply, done) => {
    if (!matchesSecretRoute(req.url)) return done();
    if (isViaTunnel(req)) return reply.code(404).send({ error: 'Not found.' });
    done();
  });
}
