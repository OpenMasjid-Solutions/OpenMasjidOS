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

/** True when the request reached us through the Cloudflare tunnel (not the LAN). */
export function isViaTunnel(req: FastifyRequest): boolean {
  return Boolean(req.headers['cf-ray']) || req.headers['x-forwarded-proto'] === 'https';
}

/** Same check for a raw Node request (used in the ingress reverse proxy / WS path). */
export function isViaTunnelHeaders(headers: NodeJS.Dict<string | string[]>): boolean {
  return Boolean(headers['cf-ray']) || headers['x-forwarded-proto'] === 'https';
}

/**
 * Block the SECRET-GATED Fabric routes when a request arrived via the tunnel.
 * Covers `/api/auth/session` (exact) and everything under `/api/fabric` (prefix)
 * — which includes the app-to-app broker at `/api/fabric/app/*`. App backends
 * always call these over the LAN base URL, so this never breaks a real flow; it
 * only removes the unintended public exposure. `/api/public/appearance` is
 * intentionally NOT matched and stays reachable over the tunnel.
 */
export function registerFabricTunnelGuard(server: FastifyInstance): void {
  server.addHook('onRequest', (req, reply, done) => {
    const url = req.url.split('?')[0];
    const secretRoute = url === '/api/auth/session' || url.startsWith('/api/fabric');
    if (!secretRoute) return done();
    if (isViaTunnel(req)) return reply.code(404).send({ error: 'Not found.' });
    done();
  });
}
