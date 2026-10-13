// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** Shared session-cookie auth for the raw WebSocket / streaming HTTP routes. */
import type { FastifyRequest } from 'fastify';
import {
  COOKIE_NAME,
  CSRF_HEADER,
  REMOTE_COOKIE_NAME,
  getSessionUserFor,
  sessionTokenFromCookieHeader,
  verifyCsrf,
} from '../auth/sessions';
import { isViaTunnel } from '../system/via-tunnel';
import { remoteAdminEnabled, wasHandedOver } from '../system/remote-admin';

function tokenOf(req: FastifyRequest): string | null {
  // The remote dashboard has its own cookie (auth/sessions.ts REMOTE_COOKIE_NAME).
  const name = wasHandedOver(req.raw) ? REMOTE_COOKIE_NAME : COOKIE_NAME;
  return (req.cookies && req.cookies[name]) ?? sessionTokenFromCookieHeader(req.headers?.cookie, name);
}

/** The session token a raw-route request carries (the remote cookie if handed over). */
export function requestSessionToken(req: FastifyRequest): string | null {
  return tokenOf(req);
}

/**
 * The signed-in admin behind a raw dashboard route, or null.
 *
 * The ONE place these routes ask, so the rule cannot differ between them: from the
 * tunnel, only a session that passed the second factor counts (auth/sessions.ts
 * `getSessionUserFor`). These are the routes that used to be refused over the tunnel
 * outright — files, terminals, backups, restore, updates — and they are reachable
 * from outside now on exactly that condition.
 */
export function requestUser(req: FastifyRequest): string | null {
  // Handed over by the remote-administration gate: only while its door is still open.
  // Asked on every use, not only at the start — a terminal asks it for each keystroke
  // (api/terminals.ts).
  const handedOver = wasHandedOver(req.raw);
  if (handedOver && !remoteAdminEnabled()) return null;
  return getSessionUserFor(tokenOf(req), { viaTunnel: isViaTunnel(req), handedOver });
}

export function wsAuthed(req: FastifyRequest): boolean {
  return Boolean(requestUser(req));
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
