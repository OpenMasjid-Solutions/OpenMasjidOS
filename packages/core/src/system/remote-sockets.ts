// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Connections the front door handed to the dashboard from outside — and closing
 * them when the reason they were let in stops being true.
 *
 * The front-door gate decides once per request (system/remote-admin.ts). That is
 * enough for HTTP, where every click is a new request, and NOT enough for a
 * WebSocket, which is one request that lasts for hours: the dashboard's live data,
 * an update's progress, and — the one that matters — a root terminal. A review found
 * all of them outliving the very actions an admin takes to shut a door: turning
 * remote administration off, turning two-step sign-in off, signing out, changing
 * the password. A live terminal went on taking keystrokes after every one of them,
 * and a live tRPC socket could switch remote administration straight back on.
 *
 * So every socket handed over is recorded here with the session it came with, and
 * closed the moment that session, or the door, stops qualifying: by a sweep a few
 * seconds apart, and immediately by the actions above (`sweepHandedOverSockets`).
 * The routes behind them also re-check on every message or call (api/terminals.ts,
 * trpc/trpc.ts) — this is the half that catches a socket sitting idle.
 *
 * Closing one never stops the work it was reporting on: an update or a restore runs
 * to the end whether or not anyone is watching (CLAUDE.md §15, one update at a time).
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  REMOTE_COOKIE_NAME,
  appAccessUser,
  isRemoteSession,
  isRemoteSessionAt,
  sessionTokenFromCookieHeader,
} from '../auth/sessions';
import { secondFactorEpoch } from '../auth/twofactor';
import { remoteAdminEnabled } from './remote-admin';
import { log } from '../logger';

type Tracked =
  /** One of the dashboard's own sockets, handed over by the front door. */
  | {
      kind: 'dashboard';
      /** The remote session the socket was opened with. */
      token: string;
    }
  /**
   * An app's socket opened through the tunnel WITH an access token (system/app-access.ts)
   * — the admin, inside that app. The same promise holds for it: signing out, a new
   * password, a changed second factor or the door shutting ends it. Without this the
   * dashboard's sockets closed on every one of those and the app's stayed open, and a
   * review found a private app still answering a socket opened before the admin signed
   * out. A socket opened with no token is the public's, and nothing ends it here.
   */
  | { kind: 'app'; appId: string; token: string };

const tracked = new Map<Duplex, Tracked>();
let timer: NodeJS.Timeout | null = null;
const SWEEP_MS = 5_000;
/**
 * At most this many at once. Every socket recorded here belongs to a signed-in remote
 * session or carries one of its app tokens, so the admin never comes near it; the bound
 * is there because this map is still filled from the internet, and a map keyed by
 * something the internet chooses gets one (auth/ip-lockout.ts). A socket refused for it
 * is destroyed like any other the front door does not keep.
 */
export const MAX_TRACKED_SOCKETS = 200;
/**
 * Of those, at most this many may be apps' — so the last ones are always the dashboard's.
 * An app's page opens a socket with the admin's token whenever it likes, and a hostile
 * or merely leaky app (a reconnect loop that never closes the old one) filled the whole
 * table: from then on every terminal, update and restore from outside failed to start —
 * on every device — for as long as that tab stayed open.
 */
export const MAX_APP_SOCKETS = 150;

let refusalLoggedAt = 0;
function add(socket: Duplex, t: Tracked): boolean {
  const full =
    tracked.size >= MAX_TRACKED_SOCKETS ||
    (t.kind === 'app' && [...tracked.values()].filter((x) => x.kind === 'app').length >= MAX_APP_SOCKETS);
  if (full) {
    // Once a minute at most: a reconnect loop would otherwise write a line per attempt,
    // and the core's log is not rotated.
    if (Date.now() - refusalLoggedAt > 60_000) {
      refusalLoggedAt = Date.now();
      log.warn(
        t.kind === 'app'
          ? `Remote administration: refused an app's connection from outside — ${MAX_APP_SOCKETS} are already open.`
          : `Remote administration: refused a connection from outside — ${MAX_TRACKED_SOCKETS} are already open.`,
      );
    }
    return false;
  }
  tracked.set(socket, t);
  socket.once('close', () => tracked.delete(socket));
  if (!timer) {
    timer = setInterval(() => sweepHandedOverSockets(), SWEEP_MS);
    timer.unref?.();
  }
  return true;
}

/**
 * Record a socket the front door is about to hand to the dashboard listener. False when
 * the table is full, or when the socket carries no live remote session (the front door
 * only hands those over — this refuses, rather than keeps, one that slipped through) —
 * the caller must then refuse the socket rather than hand it over.
 */
export function trackHandedOverSocket(req: IncomingMessage, socket: Duplex): boolean {
  const token = sessionTokenFromCookieHeader(req.headers.cookie, REMOTE_COOKIE_NAME);
  if (!token || !isRemoteSession(token)) return false;
  return add(socket, { kind: 'dashboard', token });
}

/** Record an app's socket opened through the tunnel with that app's access token. */
export function trackAppSocket(socket: Duplex, appId: string, token: string): boolean {
  return add(socket, { kind: 'app', appId, token });
}

/**
 * Close every recorded socket that no longer qualifies: the door is shut (remote
 * administration off, no second factor…), or the session it was
 * opened with — or the session behind its app token — has ended or no longer has the
 * second factor it proved.
 *
 * The door and the second factor are read ONCE per sweep. They used to be read for every
 * socket, so a sweep cost one file read per open socket, every five seconds, on the
 * daemon's only thread.
 */
export function sweepHandedOverSockets(): number {
  const open = remoteAdminEnabled();
  const epoch = secondFactorEpoch();
  let closed = 0;
  for (const [socket, t] of tracked) {
    const keep =
      open &&
      (t.kind === 'dashboard' ? isRemoteSessionAt(t.token, epoch) : appAccessUser(t.token, t.appId) !== null);
    if (keep) continue;
    tracked.delete(socket);
    socket.destroy();
    closed++;
  }
  if (closed > 0) log.info(`Remote administration: closed ${closed} connection(s) from outside that no longer qualify.`);
  if (tracked.size === 0 && timer) {
    clearInterval(timer);
    timer = null;
  }
  return closed;
}

/** How many handed-over sockets are open — for tests and diagnostics. */
export function handedOverSocketCount(): number {
  return tracked.size;
}
