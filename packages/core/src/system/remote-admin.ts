// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Remote administration: serving the dashboard over the Cloudflare tunnel.
 *
 * This is the one place that decides whether that is allowed, the one place that
 * says which paths the dashboard owns, and the one place that says WHICH HOSTNAME
 * it lives on. All three are security decisions and this codebase has twice
 * shipped a second, subtly different copy of a check like this (CLAUDE.md §15's
 * raw-vs-decoded bullet, and the front door's own hand-rolled
 * `x-forwarded-proto` comparison). A second factor that is required or not
 * depending on which copy answered is not a second factor.
 *
 * ── ONE ADDRESS, AND THE KEY KEPT WHERE NO APP PAGE CAN REACH IT ──────────
 *
 * From outside the dashboard is served on the same tunnel address as the apps — the
 * one Cloudflare hostname the masjid already set up. A browser draws its line around
 * "this site's own data" by scheme + host + port, never by path, so every app page
 * there is the SAME ORIGIN as the dashboard: its script can read this origin's
 * storage, and send requests that carry the admin's cookie and pass the origin check.
 * What it must never get is the dashboard KEY, the second thing every signed-in
 * request needs (auth/sessions.ts): with both it could drive the whole admin API —
 * turn the root terminal on and open it. dev.13–15 kept the key in this origin's
 * storage and an adversarial review showed exactly that; dev.16 answered with a
 * second Cloudflare hostname for the dashboard alone, and the masjid found that one
 * address too many. So instead, for a request the front door handed over
 * (`wasHandedOver`):
 *  - the key is never stored where a page can read it: the remote dashboard keeps it
 *    in the tab's memory (ui/src/lib/session.ts), never in localStorage;
 *  - a reload gets it back from the page itself: the server writes it into the
 *    dashboard's HTML only for a top-level load the BROWSER marks as one
 *    (`Sec-Fetch-Dest: document` + `Sec-Fetch-Mode: navigate`, headers no script can
 *    set) — never for a fetch, a frame or an embed (api/static-ui.ts
 *    `registerRemoteDashboardPages`); `auth.me` never returns it;
 *  - no app page can hold a window on such a page: dashboard pages carry
 *    `Cross-Origin-Opener-Policy: same-origin` and app pages never carry COOP at all
 *    (system/ingress.ts strips it), so a window an app opens on the dashboard is cut
 *    off from it at once; and `frame-ancestors 'none'` keeps the dashboard out of
 *    frames;
 *  - an address that carries the key (`?k=`) never sends itself on: the File
 *    Explorer's inline view is `Referrer-Policy: no-referrer` (api/files.ts), or an SVG
 *    opened there would tell an app's path the key in a Referer.
 * Every signed-in route already refuses a request without the key; from outside
 * `auth.me` answers it as signed out too, so an app page calling it with the admin's
 * cookie learns nothing about the admin.
 * A browser that does not mark its loads (`Sec-Fetch-Dest` reached Safari in 16.4) is
 * given no key with the page and signs in again after a reload, rather than being
 * handed one blind.
 *
 * ── WHAT THIS DELIBERATELY BREAKS ──────────────────────────────────────────
 *
 * CLAUDE.md §15 said, for a long time and as its first line on the subject:
 *
 *   > The Cloudflare tunnel exposes ONLY app paths. The dashboard, tRPC, and the
 *   > secret-gated Fabric routes stay LAN-only.
 *
 * The first half is now conditional — at the masjid's explicit request, behind a
 * switch that is off by default. **The second half does not move and must not.**
 * `/api/fabric/*` and `/api/auth/session` carry every app's 256-bit Fabric secret
 * and every configured Stripe live key; `registerFabricTunnelGuard` runs on both
 * listeners regardless of this feature's state, and `isDashboardPath` below
 * claims nothing under `/api` except the dashboard's own routes (DASHBOARD_API) —
 * never the Fabric, the session check, or health.
 *
 * ── FAIL CLOSED ON EVERY PRECONDITION, AT REQUEST TIME ─────────────────────
 *
 * `remoteAdminEnabled()` re-checks every condition on every request rather than
 * trusting that they were true when the switch was flipped. The one that matters
 * most is `twoFactorActive()`: an admin who later turns two-step sign-in off
 * closes this door in the same action, automatically, without having to know
 * that the two settings are connected. Checking it only at toggle time would
 * leave a masjid with a password-only admin dashboard on the public internet and
 * nothing on screen to say so.
 *
 * It is also why `login` refuses tunnel traffic outright when no factor is
 * enrolled (`routers/auth.ts`): that is the backstop for every path that does
 * not come through here.
 */
import type { IncomingMessage } from 'node:http';
import { Transform, type Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { getSettings } from '../settings/store';
import { refuseOverTunnel } from './tunnel-refusals';
import { REMOTE_COOKIE_NAME, isRemoteSession, sessionTokenFromCookieHeader } from '../auth/sessions';
import { twoFactorActive } from '../auth/twofactor';
import { isConfigured } from '../auth/store';
import { decodedPath, isViaTunnelHeaders, resolveDotSegments, urlHasPrefix, visitorScheme } from './via-tunnel';
import { compareVersions } from '../util/version';

/** What the HTTP front door does with a request, before any route sees it. */
export type FrontDoorDecision =
  /** Not a dashboard path: the front door's own routes (apps, Fabric, public) answer. */
  | { kind: 'pass' }
  /** A permitted tunnel visit to the dashboard: hand it to the dashboard listener. */
  | { kind: 'serve' }
  /** LAN traffic on the plain-HTTP port: 308 to the HTTPS dashboard, as always. */
  | { kind: 'lan-https' }
  /** A tunnel visitor on plain http://: 308 to the same path on the apps' (configured) hostname. */
  | { kind: 'upgrade'; to: string }
  /** Refused, with the refusal recorded for "Recently turned away" under `reason`. */
  | { kind: 'refuse'; reason: 'lan-only-route' | 'plain-http-no-host' };

/**
 * A Host header as a bare, comparable hostname: lower-case, no port, no trailing
 * dot, so two spellings of the SAME name are never told apart.
 */
export function normalizeHost(host: string | string[] | undefined | null): string {
  const raw = Array.isArray(host) ? host[0] : host;
  if (!raw) return '';
  let h = raw.trim().toLowerCase();
  // `[v6]:port` keeps its brackets; a DNS name loses its port.
  if (!h.startsWith('[')) h = h.replace(/:\d*$/, '');
  return h.replace(/\.+$/, '');
}

/** A "Your apps' address" value as a bare hostname: no scheme, path or port, normalised. */
export function hostnameOfDomain(domain: string): string {
  return normalizeHost((domain ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, ''));
}

/** The hostname the APPS are published on (Settings → Remote access → domain), normalised. */
export function appHostname(): string {
  return hostnameOfDomain(getSettings().cloudflare.domain ?? '');
}

/**
 * The front door's gate, as one pure function.
 *
 * Pure so the tests can drive the REAL decision. The first version had this logic
 * inline in index.ts and a hand-built copy in the tests — and the copy had already
 * drifted (it had no upgrade branch) by the time a review looked. A registered
 * route skips the not-found handler, so this gate is the only thing standing
 * between the internet and the dashboard routes on this listener; it must be the
 * thing under test, not a description of it.
 *
 * The dashboard is served on whichever tunnel hostname was asked for — Cloudflare only
 * delivers the ones the masjid configured. What keeps it apart from the app pages that
 * share that address is where the key lives, not the hostname (see the header).
 *
 * The plain-http:// tunnel case is an UPGRADE, not service. Serving it put the
 * admin password and the second-factor code on the public internet in clear
 * between the browser and Cloudflare's edge — and the session cookie, rightly
 * Secure there, would be discarded by the browser anyway, so sign-in could never
 * stick. The rules, each closing a specific failure:
 *  - Only on an EXPLICIT http signal. Unknown is served rather than redirected, so
 *    a proxy that strips the scheme header can never trap the dashboard in a loop
 *    (and `visitorScheme` reads cf-visitor first, so one that REWRITES
 *    x-forwarded-proto cannot either).
 *  - Always to the CONFIGURED apps' hostname. The target never comes from the
 *    request, so this cannot be an open redirect.
 *  - No configured hostname means nowhere safe to send them: refuse rather than
 *    serve the sign-in page in clear.
 */
export function frontDoorDecision(
  url: string,
  headers: NodeJS.Dict<string | string[]>,
  ctx: {
    viaTunnel: boolean;
    remoteAdminEnabled: boolean;
    /** The apps' hostname (Settings → Remote access), where a plain-http:// visit is sent. */
    appsHost: string;
  },
): FrontDoorDecision {
  // `touches`, not `isDashboardPath`: the gate must look at a request if ANY spelling
  // could reach a dashboard route. See touchesDashboardPath for the bypass this closes.
  if (!touchesDashboardPath(url)) return { kind: 'pass' }; // /api/*, app paths, unknown
  if (!ctx.viaTunnel) return { kind: 'lan-https' };
  if (!ctx.remoteAdminEnabled) return { kind: 'refuse', reason: 'lan-only-route' };
  if (visitorScheme(headers) !== 'http') return { kind: 'serve' };
  const ours = normalizeHost(ctx.appsHost);
  // `url` is a request target and always starts with '/'. Anything else is not
  // something to concatenate onto a scheme and a host.
  if (!ours || !url.startsWith('/') || url.startsWith('//')) return { kind: 'refuse', reason: 'plain-http-no-host' };
  return { kind: 'upgrade', to: `https://${ours}${url}` };
}

/**
 * Should the front door hand this WebSocket upgrade to the dashboard listener?
 *
 * The ingress listener owns every upgrade on the front door and destroys anything
 * it is not told to keep (system/ingress.ts says why). This is what it is told to
 * keep: one of the dashboard's own sockets (DASHBOARD_SOCKETS), over the tunnel, and
 * only when `frontDoorDecision` — the very function the HTTP gate calls — would SERVE
 * the same request.
 *
 * Asking the gate rather than re-deriving it is the point. The first version
 * checked "tunnel + feature on + /trpc" by hand, so an upgrade the gate would have
 * refused (no hostname) or redirected (plain http://) was claimed anyway and then
 * answered with an HTTP response on a socket nothing would ever close.
 *
 * EVERY spelling must be a dashboard socket, never just one. This decides to HAND
 * OVER, which is an allow, and an allow that one spelling is enough for is how the
 * gate was walked past before (`touchesDashboardPath` says how). It was `some`, and
 * a review found the cost: `/<private app>/../trpc` resolved to `/trpc`, was claimed
 * and answered by the dashboard, while `/<private app>` with no such suffix was
 * destroyed — so the answer told a stranger which apps were installed.
 */
export function claimsDashboardSocket(
  url: string,
  headers: NodeJS.Dict<string | string[]>,
  ctx: { remoteAdminEnabled: boolean; appsHost: string },
): boolean {
  if (!isViaTunnelHeaders(headers)) return false;
  if (!spellings(url).every((p) => DASHBOARD_SOCKETS.some((sock) => under(p, sock)))) return false;
  if (frontDoorDecision(url, headers, { viaTunnel: true, ...ctx }).kind !== 'serve') return false;
  // ONLY FOR A SIGNED-IN REMOTE SESSION. Every one of these sockets is useless without
  // one, and the dashboard opens its live socket only while something is subscribed
  // (ui/src/lib/trpcClient.ts, lazy), which takes a session — so the sign-in page holds
  // none. Handing over anyone's let a stranger hold any number open and push frames the
  // dashboard had to buffer and parse: the attack the 64 KB body limit above exists to
  // stop, through the one door it did not cover. Refused here, a stranger's socket is
  // destroyed exactly like an address with nothing at it.
  return hasRemoteSession(headers);
}

/**
 * The largest WebSocket message the dashboard listener accepts, from anyone (index.ts).
 * The dashboard only sends small frames over a socket — tRPC subscription messages, a
 * terminal's keystrokes and pastes — and uploads go over HTTP. Left at the library's
 * default (100 MB), every socket could make the daemon buffer, stringify and parse a
 * hundred megabytes per message.
 */
export const DASHBOARD_WS_MAX_PAYLOAD = 1024 * 1024;

/**
 * How often every dashboard socket is pinged (index.ts). Cloudflare closes a WebSocket
 * that carries nothing either way for about 100 seconds, and nothing else on these
 * sockets speaks while the admin is reading: a terminal at a prompt or in an editor, an
 * update between download lines. So a remote terminal used to print "[Session closed]"
 * in any pause — leaving whatever was running inside, an editor with unsaved changes
 * included, where nobody could get back to it. A browser answers a ping by itself, so the
 * page needs nothing; on the masjid's network it costs nothing either.
 */
export const DASHBOARD_WS_HEARTBEAT_MS = 30_000;

/** Ping every open socket of a WebSocket server every `everyMs`. Returns the stop. */
export function startDashboardHeartbeat(
  wss: { clients: Iterable<{ readyState: number; OPEN: number; ping: () => void }> },
  everyMs = DASHBOARD_WS_HEARTBEAT_MS,
): () => void {
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      try {
        ws.ping();
      } catch {
        /* closing under us: its own close handling deals with it */
      }
    }
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * May the dashboard be served over the tunnel right now?
 *
 * Four conditions, all re-read per request:
 *  - the tunnel is on at all (no point otherwise, and it keeps the two in step);
 *  - the admin switched remote administration on;
 *  - a second factor is enrolled, so a remote sign-in can actually demand one;
 *  - AN ADMIN EXISTS. Not implied by the other three: the second factor lives in
 *    its own file, separate from the admin record. With no admin, first-run setup
 *    and first-run restore are OPEN by design — "a fresh box belongs to whoever
 *    reaches it first" — and that must only ever mean whoever is in the building.
 *    A box whose admin record went missing (an odd archive restored over it, say)
 *    while these settings survived would otherwise offer "create the admin
 *    account" and "restore a backup" to the internet. (A DAMAGED record counts as
 *    configured, which is what keeps setup refused there; see auth/store.ts.)
 */
export function remoteAdminEnabled(): boolean {
  return settingsOpenTheDoor(getSettings().cloudflare) && twoFactorActive() && isConfigured();
}

/**
 * The SETTINGS half of `remoteAdminEnabled`, as a pure function of a cloudflare
 * settings object — so a restore can ask it of the settings it is about to put in
 * place (system/restore.ts `remoteRestoreProblem`) with exactly the rule the live
 * box uses: a hand-written copy of a check like this in the restore once missed a
 * condition, and a restore it waved through shut the door behind the admin. Each a
 * literal `true`, never merely truthy.
 */
export function settingsOpenTheDoor(cf: { enabled?: unknown; remoteAdmin?: unknown }): boolean {
  return cf.enabled === true && cf.remoteAdmin === true;
}

/**
 * The first build whose remote dashboard can do everything from outside — files,
 * terminals, backups, updates, opening apps. Stable before this has no remote
 * dashboard at all, so the dashboard's own update and channel switch refuse, from
 * outside, to move the box to anything older: every window from outside would be cut off until someone at the masjid moved
 * it on again (docker/update.ts `runUpdate`, trpc/routers/system.ts
 * `setUpdateChannel`). A root terminal could still do it, as it can do anything.
 */
export const FIRST_REMOTE_ADMIN_VERSION = '0.51.2-dev.16';

/** Can a box running `version` be managed from outside? */
export function managesFromOutside(version: string): boolean {
  return compareVersions(version, FIRST_REMOTE_ADMIN_VERSION) >= 0;
}

/**
 * Whether the switch COULD be turned on — surfaced to Settings so the reason is
 * visible before the admin presses something that refuses.
 */
export function remoteAdminBlockedReason(): 'no-two-factor' | 'no-tunnel' | null {
  if (!twoFactorActive()) return 'no-two-factor';
  if (!getSettings().cloudflare.enabled) return 'no-tunnel';
  return null;
}

// ── Requests handed to the dashboard listener ────────────────────────────────

/**
 * Requests and sockets the front door handed to the dashboard listener.
 *
 * The one signal that cannot be typed: only the front door adds to it, and only for
 * a request its gate decided to serve. Headers say "this came through Cloudflare",
 * and a LAN client can send those headers; this says "the remote-administration gate
 * let this in", which nobody can send.
 */
const handedOver = new WeakSet<IncomingMessage>();

export function markHandedOver(req: IncomingMessage): void {
  handedOver.add(req);
}

export function wasHandedOver(req: IncomingMessage | undefined | null): boolean {
  return req != null && handedOver.has(req);
}

/**
 * On the DASHBOARD listener: answer Cloudflare traffic only when the front door
 * handed it over.
 *
 * The tunnel is meant to point at the front door (port 80), whose gate is what makes
 * remote administration a switch. Pointed at the dashboard's own port instead — one
 * wrong field in Cloudflare — every route here would answer the internet directly,
 * gate or no gate, the switch off. Sessions would still
 * need the second factor, but "off by default" would be a sentence in Settings
 * rather than a fact. `cf-ray` is Cloudflare's own header, set at its edge and never
 * sent by a browser on the masjid's network or by a reverse proxy of the masjid's
 * own, so this refuses exactly the misrouted traffic and nothing else.
 *
 * An upgrade is closed rather than answered, for the reason registerOriginFormGuard
 * gives: on this listener a reply from an early hook leaves the socket open for good.
 */
export function registerHandoffOnlyGuard(server: FastifyInstance): void {
  server.addHook('onRequest', (req, reply, done) => {
    if (!req.headers['cf-ray'] || wasHandedOver(req.raw)) return done();
    if (req.raw.headers.upgrade) {
      reply.hijack();
      req.raw.socket.destroy();
      return;
    }
    // Its own reason, so "Recently turned away" names the misconfiguration (a Cloudflare
    // hostname pointed at this port) instead of calling it "Local network only".
    return refuseOverTunnel(req, reply, 'wrong-port');
  });
}

/** The largest body accepted from a remote visitor who is not signed in. */
export const ANONYMOUS_BODY_LIMIT = 64 * 1024;

/**
 * Refuse a body from someone who is NOT signed in that SAYS it is too large, before
 * it is handed to the dashboard listener — or null to let it through.
 *
 * The dashboard listener allows 25 MB of JSON, because a signed-in admin uploads
 * wallpapers and pastes compose files. Handing it the internet's requests unread made
 * that reachable by anybody: a handful of concurrent 25 MB posts is a memory-
 * exhaustion attack on a Raspberry Pi running as root, and when that process dies so
 * does every public page the masjid serves. The only things a stranger may send are a
 * sign-in and a code, which are a few hundred bytes.
 *
 * This is the cheap half — a declared length is refused without reading a byte. A
 * body that declares nothing (`transfer-encoding: chunked`, which a tunnel may use on
 * the way to us even for a browser's fixed-size request) is NOT refused here, because
 * refusing it could refuse a real sign-in; the dashboard listener counts it as it
 * arrives instead (`limitAnonymousBody`, below), against the same limit.
 */
export function anonymousBodyRefusal(headers: NodeJS.Dict<string | string[]>): 413 | null {
  const lenRaw = headers['content-length'];
  if (lenRaw === undefined) return null;
  const len = typeof lenRaw === 'string' && /^\d+$/.test(lenRaw.trim()) ? Number(lenRaw.trim()) : null;
  if (len === null) return 413; // a length that is not a number
  return len > ANONYMOUS_BODY_LIMIT ? 413 : null;
}

/** Does this request carry a live remote session — one that passed the second factor? */
export function hasRemoteSession(headers: NodeJS.Dict<string | string[]>): boolean {
  return isRemoteSession(sessionTokenFromCookieHeader(headers.cookie, REMOTE_COOKIE_NAME));
}

/**
 * Count a remote stranger's request body as it arrives, and stop it at
 * ANONYMOUS_BODY_LIMIT. The front door refuses a body that DECLARES itself too large
 * (`anonymousBodyRefusal`); this is the half for one that does not say how large it
 * is, which cannot be refused up front without refusing real sign-ins along with it.
 */
function limitAnonymousBody(payload: Readable): Readable {
  let seen = 0;
  const counted = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      (counted as Transform & { receivedEncodedLength?: number }).receivedEncodedLength = seen;
      if (seen > ANONYMOUS_BODY_LIMIT) {
        cb(Object.assign(new Error('That request is too large.'), { statusCode: 413 }));
        return;
      }
      cb(null, chunk);
    },
  });
  payload.on('error', (err) => counted.destroy(err));
  return payload.pipe(counted);
}

/**
 * On the DASHBOARD listener: the two limits on what a request may make this process
 * read, whoever sends it.
 *
 *  - tRPC takes JSON and nothing else. Its adapter also accepts multipart bodies and
 *    reads them with NO size limit, which nothing in the dashboard uses (its uploads
 *    go to their own /api routes) and which let anyone who could reach the sign-in
 *    page — the internet, once remote administration is on — make a root process
 *    buffer a body of any size.
 *  - A remote stranger's body is counted as it arrives and stopped at
 *    ANONYMOUS_BODY_LIMIT. "Remote stranger" means handed over by the front door
 *    (`wasHandedOver`) with no session that passed the second factor.
 */
export function registerDashboardRequestLimits(server: FastifyInstance): void {
  server.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    if (!urlHasPrefix(req.url, '/trpc')) return;
    const type = String(req.headers['content-type'] ?? '').toLowerCase();
    if (!type.startsWith('application/json')) {
      return reply.code(415).send({ error: 'This request is not in a form the dashboard accepts.' });
    }
  });
  server.addHook('preParsing', async (req, _reply, payload) =>
    req.method !== 'GET' && req.method !== 'HEAD' && wasHandedOver(req.raw) && !hasRemoteSession(req.headers)
      ? limitAnonymousBody(payload)
      : payload,
  );
}

/**
 * The first path segments the dashboard owns.
 *
 * AN ALLOW-LIST, NOT "EVERYTHING THAT IS NOT AN APP". The difference matters for
 * two reasons. It keeps the surface published to the internet to what was
 * actually decided rather than whatever happens to be registered. And it leaves
 * every other address still refused — so "Recently turned away" goes on being
 * the diagnostic it was, instead of every wrong address silently getting the
 * admin sign-in page.
 *
 * `test/remote-admin.test.ts` reads `Root.tsx` and fails if a UI route is added
 * whose segment is not here — otherwise that page would simply 404 remotely,
 * with nothing to say why.
 */
export const DASHBOARD_SEGMENTS = [
  'trpc', // the API itself (HTTP + WebSocket subscriptions)
  'assets', // Vite's fingerprinted bundles
  'store',
  'apps',
  'files',
  'settings',
  'design-system',
] as const;

/** Files the built UI serves from its root. */
const DASHBOARD_ROOT_FILES = ['/index.html', '/favicon.svg', '/ambient.mp4'];

/**
 * The dashboard's own routes under `/api` — the ones it needs beyond tRPC: updates,
 * the File Explorer's transfers, terminals, backup, restore, the logo upload.
 *
 * These were refused over the tunnel outright (LAN_ONLY_FEATURES, now gone), and the
 * admin asked for everything to work remotely. They are reachable from outside on
 * the same conditions as the rest of the dashboard — the tunnel, the switch, an
 * enrolled second factor — AND only for a session that passed
 * that second factor, which every one of these routes checks for itself
 * (api/ws-auth.ts `requestUser`).
 *
 * AN ALLOW-LIST, like DASHBOARD_SEGMENTS, and for the same reason: everything else
 * under `/api` keeps its own rule. The Fabric and `/api/auth/session` stay refused
 * over the tunnel unconditionally; health and readiness stay LAN-only; the public
 * appearance and logo stay public. A new dashboard route is unreachable remotely
 * until it is added here — which is the failure to prefer.
 */
export const DASHBOARD_API = [
  '/api/update', // core update progress (WebSocket)
  '/api/apps/update', // app update progress (WebSocket)
  '/api/files', // File Explorer download / raw view / upload
  '/api/terminal', // root shell and app shells (WebSocket)
  '/api/backup', // backup download
  '/api/restore', // restore upload + progress (WebSocket)
  '/api/branding/logo', // masjid logo upload / clear
] as const;

/**
 * The WebSockets the dashboard opens: its live data, and the progress and terminal
 * streams. The ONLY non-app upgrades the front door hands on (system/ingress.ts
 * destroys everything else), so this is kept to exactly the sockets that exist.
 */
const DASHBOARD_SOCKETS = ['/trpc', '/api/update', '/api/apps/update', '/api/restore/run', '/api/terminal'];

/** `p` is `prefix` itself or something under it — never `prefix` as a mere string prefix. */
function under(p: string, prefix: string): boolean {
  return p === prefix || p.startsWith(prefix + '/');
}

function firstSegment(path: string): string {
  for (const part of path.split('/')) if (part) return part;
  return '';
}

/**
 * Is this a path the dashboard owns?
 *
 * Tested against the raw spelling, the decoded one AND the dot-resolved ones,
 * because the router dispatches on the decoded path and a framework downstream
 * may resolve `.`/`..`. This is the same three-spellings rule `isFabricSubpath`
 * documents, applied here — but note the direction is reversed and so is the
 * failure mode: this predicate ALLOWS, so it must be true for every spelling
 * rather than any. `/%74rpc/…` reaching the tRPC handler while this said "not a
 * dashboard path" would mean the gate never ran on it.
 *
 * Nothing under `/api` is a dashboard path except DASHBOARD_API. The rest —
 * health, ready, the Fabric, the session check, the public appearance and logo —
 * each own their tunnel rules, and the secret-gated ones are refused by a guard
 * that runs before this one.
 */
export function isDashboardPath(url: string): boolean {
  return spellings(url).every(spellingIsDashboard);
}

/**
 * Could the router send this request to a dashboard route under ANY spelling?
 *
 * THE GATE'S QUESTION, and it is not `isDashboardPath`'s. That one decides whether
 * to SERVE the SPA and must fail closed by requiring EVERY spelling to agree. This
 * one decides whether the gate APPLIES, and must fail closed the other way: if any
 * spelling is a dashboard path, the gate looks at it.
 *
 * One predicate used to answer both, and an adversarial review found what that cost.
 * `/%74rpc/auth.me` has a raw first segment of `%74rpc`, so `every` said "not a
 * dashboard path", the gate waved it through — and the router, which matches the
 * DECODED path, delivered it to tRPC. Proved against the real daemon: the whole
 * dashboard API answered over the tunnel with remote administration switched OFF.
 * The comment above `isDashboardPath` described this exact failure as the thing
 * `every` prevents; for the gate, `every` was the thing that caused it.
 *
 * No /api exclusion here, deliberately: a spelling that starts with /api but
 * resolves to a dashboard path must still be gated. The /api routes keep their own
 * guards, which run first.
 */
export function touchesDashboardPath(url: string): boolean {
  return spellings(url).some(spellingIsDashboard);
}

function spellings(url: string): string[] {
  const raw = url.split('?')[0]!.split('#')[0]!;
  return [raw, decodedPath(url), resolveDotSegments(raw), resolveDotSegments(decodedPath(url))];
}

function spellingIsDashboard(p: string): boolean {
  if (p === '/' || p === '') return true;
  if (DASHBOARD_ROOT_FILES.includes(p)) return true;
  if (p === '/api' || p.startsWith('/api/')) return DASHBOARD_API.some((a) => under(p, a));
  return (DASHBOARD_SEGMENTS as readonly string[]).includes(firstSegment(p));
}

/**
 * There used to be a list here, LAN_ONLY_FEATURES — the File Explorer, terminals,
 * and backup/restore — kept off the tunnel while the dashboard itself went out first,
 * each "a deliberate decision to expose the management surface first and revisit
 * the rest with its own argument". The masjid revisited it: everything should be
 * manageable remotely once two-step sign-in is set up.
 *
 * What makes that defensible rather than reckless is not this file alone but two
 * rules together. The session rule: from the tunnel, every one of those routes
 * accepts only a session that passed the second factor (auth/sessions.ts
 * `getSessionUserFor`), so reaching a root shell from outside takes the password
 * AND the second factor. And the key rule in the header: no app page sharing the
 * dashboard's address can ever get hold of the dashboard key. The terminals keep their own
 * off-by-default switches in Settings → Advanced, and the File Explorer keeps its
 * protected paths (files/manager.ts `protectedReason`) — both apply remotely too.
 */
