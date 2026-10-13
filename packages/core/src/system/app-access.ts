// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Opening an app from the REMOTE dashboard.
 *
 * The admin's dashboard cookie never reaches an app — the ingress removes every
 * platform cookie before forwarding (`cookieHeaderForApp`), because the dashboard and
 * the apps share one address from outside. So an app has nothing from the admin's
 * browser to go on: an app that is not shared online cannot tell the admin from a
 * stranger, and one that signs the admin in through the platform has no cookie to
 * forward.
 *
 * What the dashboard does instead, when the admin presses Open:
 *
 *  1. asks the platform for a TICKET for that one app (`apps.openRemote`) — single
 *     use, sixty seconds, minted only for a session that passed the second factor;
 *  2. opens `https://<apps' hostname>/_omos/open?t=<ticket>` in a new tab;
 *  3. here, on the apps' hostname, the ticket is spent and the browser is given
 *     that app's ACCESS TOKEN as a cookie scoped to the app's own path — then sent
 *     on to the app.
 *
 * The access token (auth/sessions.ts `appAccessToken`) opens that app and nothing
 * else: the ingress lets it through to an app that is not shared online, and the
 * app's single sign-on accepts it — for that app — exactly as it accepts the session
 * cookie on the LAN. It lives only as long as the remote session it came from, and
 * it can never be turned back into that session, so an app that keeps it holds a key
 * to itself and nothing more. `_omos` is not a path any app can have: app paths are
 * lower-case letters, digits and hyphens.
 */
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  COOKIE_NAME,
  REMOTE_COOKIE_NAME,
  appAccessToken,
  appAccessUser,
  cookieValues,
  isRemoteSession,
  sessionExpiresAt,
} from '../auth/sessions';
import { getAppPath } from '../apps/manager';
import { remoteAdminEnabled } from './remote-admin';
import { isViaTunnel } from './via-tunnel';
import { NO_STORE_HEADERS, refuseOverTunnel } from './tunnel-refusals';

/** Where a ticket is spent, on the apps' hostname. Not a path an app can have. */
export const APP_OPEN_PATH = '/_omos/open';

/** Long enough to cross from one tab to the next; short enough that a copied link is dead. */
export const TICKET_TTL_MS = 60_000;
const MAX_TICKETS = 200;

interface Ticket {
  sessionToken: string;
  appId: string;
  expiresAt: number;
}

const tickets = new Map<string, Ticket>();

/** A one-use ticket to open `appId`, for a live remote session — or null. */
export function mintAppTicket(sessionToken: string, appId: string, now: number = Date.now()): string | null {
  if (!isRemoteSession(sessionToken)) return null;
  for (const [id, t] of tickets) if (t.expiresAt <= now) tickets.delete(id);
  // Bounded: tickets are minted by a signed-in admin, but a loop in a page should not
  // be able to grow this without limit. The oldest goes first.
  while (tickets.size >= MAX_TICKETS) {
    const oldest = tickets.keys().next().value;
    if (oldest === undefined) break;
    tickets.delete(oldest);
  }
  const id = crypto.randomBytes(32).toString('base64url');
  tickets.set(id, { sessionToken, appId, expiresAt: now + TICKET_TTL_MS });
  return id;
}

/** Spend a ticket. Gone after this whether or not it was still valid. */
export function redeemAppTicket(id: string, now: number = Date.now()): Ticket | null {
  const t = tickets.get(id);
  if (!t) return null;
  tickets.delete(id);
  return t.expiresAt > now ? t : null;
}

/** How many `omos_session` values one request may have checked as access tokens. */
const MAX_TOKEN_CANDIDATES = 8;

/**
 * The app access token in this Cookie header that is valid for THIS app, while
 * remote administration is on — or null. Every `omos_session` value is tried, not
 * just the first: a browser may hold an old one for another path.
 */
export function appAccessFromCookie(header: string | string[] | undefined, appId: string): string | null {
  const values = cookieValues(header, COOKIE_NAME);
  // The cheap test first: most requests through the tunnel are the public, with no
  // such cookie at all, and should not pay for reading the settings.
  if (values.length === 0 || !remoteAdminEnabled()) return null;
  // A browser holds a handful at most (one per app path, plus perhaps a stale one for
  // the whole hostname). Looking at more would let a stranger buy work on this daemon
  // per request with a Cookie header full of token-shaped values.
  for (const v of values.slice(0, MAX_TOKEN_CANDIDATES)) if (appAccessUser(v, appId)) return v;
  return null;
}

/** For the Fabric's single sign-on check: who this forwarded token belongs to, for this app. */
export function appAccessSsoUser(value: string | null | undefined, appId: string): string | null {
  if (!value || !remoteAdminEnabled()) return null;
  return appAccessUser(value, appId);
}

/**
 * The Cookie header an app receives through the tunnel.
 *
 * Every platform session cookie is removed — whatever its value — and the app's own
 * access token, if the request carried a valid one, is put back FIRST. First because
 * every OpenMasjid app forwards the first `omos_session` it finds and nothing else.
 *
 * Removing them all is what makes "a password-only sign-in cannot be used from
 * outside" true for apps as well as the dashboard: every app on the masjid's network
 * receives the admin's LAN cookie (that is how single sign-on works there), so an app
 * that kept one could otherwise present it through the tunnel to a shared app and be
 * signed in, with no second factor. A browser never sends the LAN cookie to the
 * apps' hostname by itself, so nothing legitimate is lost.
 */
export function cookieHeaderForApp(header: string | string[] | undefined, keep: string | null): string | undefined {
  const value = Array.isArray(header) ? header.join('; ') : header;
  const parts = (value ?? '')
    .split(';')
    .map((p) => p.trim())
    .filter((p) => {
      if (!p) return false;
      const eq = p.indexOf('=');
      const name = (eq === -1 ? p : p.slice(0, eq)).trim();
      return name !== COOKIE_NAME && name !== REMOTE_COOKIE_NAME;
    });
  if (keep) parts.unshift(`${COOKIE_NAME}=${keep}`);
  return parts.length > 0 ? parts.join('; ') : undefined;
}

function spentPage(reply: FastifyReply): FastifyReply {
  return reply
    .code(410)
    .type('text/html')
    .send(
      '<!doctype html><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>Link expired</title>' +
        '<div style="font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 1.5rem;color:#1f2937">' +
        '<h1 style="font-size:1.4rem;margin:0 0 .6rem">This link has expired</h1>' +
        '<p style="margin:0;color:#4b5563">Links that open an app only work once, for a minute. ' +
        'Go back to your OpenMasjidOS dashboard and press Open again.</p>' +
        '</div>',
    );
}

/** The route that spends a ticket. On the HTTP front door, where the tunnel lands. */
export function registerAppOpen(front: FastifyInstance): void {
  front.get(APP_OPEN_PATH, async (req, reply) => {
    for (const [k, v] of Object.entries(NO_STORE_HEADERS)) reply.header(k, v);
    reply.header('referrer-policy', 'no-referrer');
    if (!isViaTunnel(req)) return reply.code(404).send({ error: 'Not found.' });
    if (!remoteAdminEnabled()) return refuseOverTunnel(req, reply, 'no-app-at-path');
    const raw = (req.query as { t?: unknown } | undefined)?.t;
    const ticket = typeof raw === 'string' && raw.length <= 128 ? redeemAppTicket(raw) : null;
    const token = ticket ? appAccessToken(ticket.sessionToken, ticket.appId) : null;
    if (!ticket || !token) return spentPage(reply);
    const seg = getAppPath(ticket.appId);
    // No longer than the session it came from: past that the token is refused anyway,
    // and a cookie nobody honours is just clutter in the admin's browser.
    const until = sessionExpiresAt(ticket.sessionToken) ?? Date.now();
    const maxAge = Math.max(0, Math.floor((until - Date.now()) / 1000));
    reply.header(
      'set-cookie',
      `${COOKIE_NAME}=${token}; Path=/${seg}; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`,
    );
    return reply.code(303).redirect(`/${seg}/`);
  });
}

/** Test seam. Never called by the daemon. */
export function __clearAppTicketsForTests(): void {
  tickets.clear();
}
