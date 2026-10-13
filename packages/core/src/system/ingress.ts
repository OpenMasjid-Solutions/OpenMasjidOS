// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Path-based ingress for remote access. So the admin only adds ONE Cloudflare
 * public hostname for the apps (omos.<domain> → http://localhost:<PORT>) instead of
 * one per app, the platform's HTTP front door reverse-proxies each app by the first
 * path segment: `omos.<domain>/donate/…` → the Donations container, `/display/…` →
 * Display, etc. (paths from getAppPath, admin-configurable).
 *
 * Cloudflare terminates TLS at its edge and sends plain HTTP to the origin, so we
 * proxy to each app's plain HTTP container port (no per-app HTTPS/No-TLS-Verify to
 * configure). Only known app paths are proxied here; everything else falls through
 * to the front door, whose gate decides the rest (system/remote-admin.ts).
 *
 * An app that is shared online is served to anyone. One that is NOT is served only
 * to a browser carrying that app's access token, which the remote dashboard's Open
 * button gives it (system/app-access.ts) — so the admin can open every app from
 * outside, while the public sees nothing at its path.
 *
 * The remote dashboard shares this address with the apps, so an app page is the
 * dashboard's own origin. What keeps it from driving the dashboard is the KEY, which
 * no app page can reach (system/remote-admin.ts has the whole rule). This file's part:
 * an app's responses lose any opener policy (`responseHeadersForTunnel`), so a window
 * an app opens on the dashboard is cut off from it, and no platform cookie reaches an
 * app (`cookieHeaderForApp`).
 */
import http from 'node:http';
import net from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { listInstalledWithHealth, getAppPath } from '../apps/manager';
import { isAppPathShape, isReservedPathSegment } from '../apps/paths';
import { isViaTunnelHeaders, decodedPath, resolveDotSegments } from './via-tunnel';
import { appHost } from './app-host';
import { log } from '../logger';
import { NO_STORE_HEADERS, noteRefusal, recordRefusal, refuseOverTunnel, type RefusalReason } from './tunnel-refusals';
import { appAccessFromCookie, cookieHeaderForApp } from './app-access';
import { trackAppSocket } from './remote-sockets';
import { closeTogether } from './socket-relay';
import { COOKIE_NAME, REMOTE_COOKIE_NAME } from '../auth/sessions';

// How the core reaches an app's published host port — one definition, shared with the
// per-app TLS proxy, the Fabric broker and the WhatsApp gateway client.
const TARGET_HOST = appHost();

// Client-supplied forwarding + hop-by-hop headers we must NOT relay verbatim: the
// tunnel is a hostile boundary and apps trust X-Forwarded-* behind the OS proxy,
// so a spoofed value would poison absolute-URL building (open redirect) or
// per-IP rate limits. We strip these and set our own trusted values below.
const STRIP_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-forwarded-port',
  // The base path some app frameworks trust (Spring, ASP.NET, Next.js behind a proxy):
  // the platform never sends one, so one arriving was typed by the visitor.
  'x-forwarded-prefix',
  'forwarded',
  // Client-IP headers of exactly the class this list exists to remove. Any proxy
  // in front of us would set these; a caller reaching us directly can type them,
  // and an app reading either one would be reading the caller's own choice.
  'x-real-ip',
  'true-client-ip',

  // Cloudflare's real-client-IP header. Stripped like the rest and re-set below ONLY
  // when the request actually came through the tunnel: on the LAN anyone can send it,
  // and it was previously honoured unconditionally — so a caller on the masjid's
  // network chose the IP every app saw in X-Forwarded-For, which is what apps rate-
  // limit and log by. Exactly the poisoning this list exists to prevent.
  'cf-connecting-ip',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
];

/** Build the header set to send upstream: the client's headers minus any
 *  forwarding/hop-by-hop headers, plus trusted forwarding headers we set — and,
 *  through the tunnel, the Cookie header with every platform session cookie
 *  removed but this app's own access token (`cookieHeaderForApp` says why). */
function trustedHeaders(req: IncomingMessage, keep: string | null): NodeJS.Dict<string | string[]> {
  const headers: NodeJS.Dict<string | string[]> = { ...req.headers };
  for (const h of STRIP_HEADERS) delete headers[h];
  const tunnel = isViaTunnelHeaders(req.headers);
  if (tunnel) {
    const cookie = cookieHeaderForApp(req.headers.cookie, keep);
    if (cookie === undefined) delete headers.cookie;
    else headers.cookie = cookie;
  }
  // Real client IP: Cloudflare's CF-Connecting-IP, but only when the request looks
  // like it arrived through the tunnel; otherwise the socket peer.
  //
  // BE HONEST ABOUT WHAT THIS IS WORTH. `isViaTunnelHeaders` reads `cf-ray` /
  // `x-forwarded-proto`, which Cloudflare sets at its edge and a tunnel client
  // therefore cannot strip — that is the direction this guard is sound in. But
  // this listener is also reachable directly (HOST is 0.0.0.0 and 80 is published),
  // and a caller arriving that way can simply TYPE `cf-ray` and `cf-connecting-ip`
  // and have both honoured here. So an app's X-Forwarded-For is trustworthy against
  // a tunnel visitor and NOT against someone who can reach this port. It is a
  // routing signal, never an authorisation one — and no route anywhere grants a
  // session or relaxes CSRF on the strength of it (CLAUDE.md §15). The real
  // mitigations are a firewall and a bind address, as documented for the operator
  // in docs/SECURITY.md.
  const cfIp = tunnel ? req.headers['cf-connecting-ip'] : undefined;
  const trustedCfIp = typeof cfIp === 'string' && cfIp ? cfIp : '';
  headers['x-forwarded-for'] = trustedCfIp || req.socket?.remoteAddress || '';
  // Put Cloudflare's own header back for apps that read it directly, but only with
  // the value we just decided to trust.
  if (trustedCfIp) headers['cf-connecting-ip'] = trustedCfIp;
  headers['x-forwarded-proto'] = tunnel ? 'https' : 'http';
  if (req.headers.host) headers['x-forwarded-host'] = String(req.headers.host);
  return headers;
}

/**
 * Where an app path goes. EVERY app with a web port is here, not only the ones
 * shared online: an app that is not shared is still served at its path to a browser
 * holding its access token (system/app-access.ts), so the admin can open it from
 * outside. To anyone else it is an address with nothing at it.
 */
interface Route {
  /** Whose path this is — the access token a request carries must be for THIS app. */
  id: string;
  port: number;
  /** Shared online: served to anyone. False: served only with this app's access token. */
  exposed: boolean;
}

let routes = new Map<string, Route>(); // path segment → where the app is
/** Set only by `__setRoutesForTests`, so a background rebuild cannot race a test's
 *  table — checked both before and after rebuild's one await. */
let pinnedForTests = false;
/** The last collisions logged, so the same one is not repeated every ten seconds. */
let lastCollisions = '';

/**
 * Put an app's route into the table being built, deciding a clash of paths.
 *
 * Two apps can end up with one path: nothing used to stop it (`setAppPath` refuses
 * it now, but an older install may already have one), and an app that is no longer
 * shared keeps the path it had. Before every app was in this table that could never
 * hurt a shared app — the private one was simply not here. Now it is, so the rule is
 * explicit: A SHARED APP KEEPS ITS PATH. A private app taking it would turn a
 * masjid's public donations page into a 404 for every donor, and stop the shared app
 * advertising its public address — while Settings went on showing it as shared.
 * Otherwise the later app wins, which is what the table always did.
 */
export function placeRoute(next: Map<string, Route>, seg: string, route: Route, clashes: string[]): void {
  const prev = next.get(seg);
  if (prev) clashes.push(`/${seg} (${prev.id}, ${route.id})`);
  if (prev?.exposed && !route.exposed) return;
  next.set(seg, route);
}

async function rebuild(): Promise<void> {
  if (pinnedForTests) return;
  try {
    const { apps, discoveryOk } = await listInstalledWithHealth();
    // Checked again AFTER the await: a rebuild already waiting on Docker when the
    // routes were pinned would otherwise replace them when Docker answered. That is
    // what happened on any machine where Docker is reachable — CI included.
    if (pinnedForTests) return;
    // THE BUG THIS GUARD EXISTS FOR. A Docker hiccup used to arrive as a perfectly
    // well-formed list of apps that all happened to have no ports, so every app was
    // dropped below and this table went empty — and every visitor to the masjid's public
    // site got `{"error":"Not found."}` until the next tick ten seconds later. The
    // `catch` underneath was written to prevent precisely that and never fired, because
    // nothing threw. Keep what we had; it is far more likely to still be right.
    if (!discoveryOk) {
      log.warn('Ingress: could not read Docker; keeping the previous app routes.');
      return;
    }
    const next = new Map<string, Route>();
    const clashes: string[] = [];
    for (const a of apps) {
      const port = a.ports[0]; // raw HTTP container port (Cloudflare provides TLS)
      if (port == null) continue;
      const seg = getAppPath(a.id);
      // Per-app exposure is the admin's choice and is carried on the route rather
      // than deciding whether there is one: `exposed` is grandfathered-true for apps
      // installed before the flag existed (see InstalledApp.exposed), and an app that
      // is not shared still opens from the remote dashboard.
      // The platform's own endpoints are never an app's (apps/paths.ts — Settings
      // refuses them as an address, but an older install or a restore may hold one).
      if (seg && isAppPathShape(seg) && !isReservedPathSegment(seg)) {
        placeRoute(next, seg, { id: a.id, port, exposed: a.exposed }, clashes);
      }
    }
    const sig = clashes.join(', ');
    if (sig && sig !== lastCollisions) {
      log.warn(`Ingress: more than one app uses the same address: ${sig}. A shared app keeps it; give the other its own path in Settings → Remote access.`);
    }
    lastCollisions = sig;
    // Worth a line when the public site is about to go dark, even legitimately (every
    // app stopped, or every app un-exposed) — this was silent, and silence is what made
    // the outage above so hard to place.
    const shared = (m: Map<string, Route>) => [...m.values()].filter((r) => r.exposed).length;
    if (shared(next) === 0 && shared(routes) > 0) {
      log.warn(`Ingress: no app is exposed and running; ${shared(routes)} public path(s) will stop resolving.`);
    }
    routes = next;
  } catch (err) {
    // Reached only if something OTHER than Docker readability threw.
    log.warn('Ingress: rebuild failed; keeping the previous app routes.', err);
  }
}

/** Test seam: route path segments to ports without Docker, and stop the periodic
 *  rebuild from replacing them. Never called by the daemon. */
export function __setRoutesForTests(next: Record<string, number | { port: number; exposed: boolean; id?: string }>): void {
  pinnedForTests = true;
  // A bare port is an app shared online, which is what every test before private
  // apps existed meant by it. The app's id defaults to its path, as it does for
  // every app nobody has given a path of its own.
  routes = new Map(
    Object.entries(next).map(([seg, r]) => [
      seg,
      typeof r === 'number' ? { id: seg, port: r, exposed: true } : { id: r.id ?? seg, port: r.port, exposed: r.exposed },
    ]),
  );
}

/** Is the OS actually routing this app's public path to it right now? The Fabric
 *  `site` endpoint uses this so it only advertises a public URL the platform will
 *  really serve — the app can then trust it instead of doing a fragile hairpin
 *  self-probe through Cloudflare (which fails from inside a container even when the
 *  path routes fine for real external visitors). */
export function isRouted(appId: string): boolean {
  // PUBLICLY routed, and to THIS app. A private app is in the table too, but it has no
  // public URL to advertise — the admin opening it remotely does not make it reachable
  // by a donor. And when two apps answer to one path (placeRoute decides which keeps
  // it), only the one actually there may be told it is published there: the other's
  // Stripe return links and QR codes would otherwise point at someone else's app.
  const seg = getAppPath(appId);
  const r = seg ? routes.get(seg) : undefined;
  return r !== undefined && r.id === appId && r.exposed === true;
}

/**
 * Is this request a browser fetching a SERVICE WORKER'S script? Browsers mark it twice —
 * `Service-Worker: script` (the Service Workers specification) and `Sec-Fetch-Dest:
 * serviceworker` — and a page cannot make an ordinary fetch that carries the second.
 */
export function isWorkerScriptFetch(headers: http.IncomingHttpHeaders): boolean {
  const one = (v: string | string[] | undefined) => String(Array.isArray(v) ? v[0] : (v ?? '')).trim().toLowerCase();
  return one(headers['service-worker']) === 'script' || one(headers['sec-fetch-dest']) === 'serviceworker';
}

/**
 * Is this an app's BARE address — `/<seg>` with nothing after it but a query?
 *
 * A service worker's reach is the directory of its script's address, and the directory
 * of `/<seg>` is `/` — the whole apps hostname: every other app's pages, and the address
 * that hands a browser an app's access token (system/app-access.ts). Stripping
 * Service-Worker-Allowed (below) only confines a script that lives UNDER `/<seg>/`; a
 * review found an app could serve its worker at the bare address instead. So the app's
 * worker script is never served there (`isWorkerScriptFetch`) — only one that removes
 * itself (`SELF_REMOVING_WORKER`) — and nothing answered there may be kept in a cache,
 * the browser's or Cloudflare's, from which it could stand in for one later. Everything
 * else reaches the app as it always did.
 *
 * Not a redirect to `/<seg>/`, which was the first fix: an app that treats `/<seg>` as
 * its root and sends `/<seg>/` back there (Next.js with a base path does, by default)
 * then bounced between the two for ever, and its public page was gone.
 *
 * Every spelling counts (`/%73hared` is `/shared` to the router), which is why this asks
 * of the raw path only "one segment, no trailing slash".
 */
export function isBareAppAddress(url: string): boolean {
  const raw = url.split('?')[0]!.split('#')[0]!;
  return !raw.endsWith('/') && raw.split('/').filter(Boolean).length === 1;
}

/**
 * A service worker that removes itself — what a worker's script fetch at a bare address
 * gets, instead of a 404.
 *
 * A 404 stops NEW registrations. But by the Service Workers specification, an update
 * check that fetches no script leaves an EXISTING registration in place with its old
 * worker still running — and every build before this one let an app's page register a
 * worker over the whole apps' address from its bare one (Stable passed
 * Service-Worker-Allowed through, too). Such a worker, in the browser of anyone who once
 * opened that app through the internet address, the admin included, went on answering
 * every page there — the one-use Open address now among them — after the app was gone.
 * The browser's next update check installs this instead, and it unregisters on
 * activation. It does nothing else: it clears no caches, which belong to the apps.
 *
 * It reaches only a worker whose script is AT a bare address. One an older build let an
 * app register over the whole address from a script under its own path (`/<seg>/sw.js`
 * with `Service-Worker-Allowed: /`) checks for updates there, which is the app's to
 * answer; without the header now its update fails, and a failed update leaves the old
 * worker running. Clearing that browser's data for the apps' address is the way out.
 */
export const SELF_REMOVING_WORKER =
  "self.addEventListener('install',()=>self.skipWaiting());" +
  "self.addEventListener('activate',(e)=>e.waitUntil(self.registration.unregister()));\n";

/**
 * Answer a worker's script fetch at a bare address with SELF_REMOVING_WORKER — the same
 * answer whether a shared app is there, a private one, or nothing at all, so it says
 * nothing about what is installed (the front door's not-found handler gives it too).
 * Recorded as a refusal when it came through the tunnel; never cacheable.
 */
export function answerBareWorkerFetch(req: FastifyRequest, reply: FastifyReply, opts: { record: boolean }): FastifyReply {
  if (opts.record) recordRefusal(req, 'worker-at-bare-address');
  for (const [k, v] of Object.entries(NO_STORE_HEADERS)) reply.header(k, v);
  return reply.code(200).type('text/javascript; charset=utf-8').send(SELF_REMOVING_WORKER);
}

/**
 * App paths this ingress declined to serve, and why — an app that is not shared
 * online, asked for without its access token, or ANY app asked for on the admin
 * hostname. The not-found handler reads it to record the reason
 * (system/tunnel-refusals.ts `notFoundReason`) while sending the very same 404, so
 * the difference exists only in the record.
 */
const declined = new WeakMap<IncomingMessage, RefusalReason>();
export function declinedReason(req: IncomingMessage): RefusalReason | null {
  return declined.get(req) ?? null;
}

function segmentOf(path: string): string {
  for (const part of path.split('/')) {
    if (part) return part;
  }
  return '';
}

/**
 * The app segment this URL is for, matched against the routing table.
 *
 * Tries the raw spelling and the DECODED one, because the table is keyed on plain app
 * paths while a client may send anything that decodes to one — `/%64onate` is `/donate`
 * to every URL parser downstream, and reached here as the literal segment `%64onate`,
 * matched nothing, and 404'd a request that should have routed.
 *
 * This is the same raw-versus-decoded split the Fabric guard is careful about
 * (`isFabricSubpath` tests both), applied to the half that decides WHERE a request goes
 * rather than whether it is allowed. No bypass: the guard already tests both spellings,
 * so an encoded `/fabric` is still refused whichever way this resolves.
 */
function firstSegment(url: string): string {
  const raw = url.split('?')[0]!.split('#')[0]!;
  const direct = segmentOf(raw);
  if (direct && routes.has(direct)) return direct;
  const decoded = segmentOf(decodedPath(url));
  if (decoded && routes.has(decoded)) return decoded;
  return direct;
}

/** True if, after the app's path segment, the request targets the app's own
 *  `/fabric/*` space (e.g. /donate/fabric/billing/lookup). Those are LAN-only
 *  app↔platform / app↔app broker routes — they must NEVER be reachable over the
 *  public tunnel. The platform is the first wall; apps enforce it themselves too.
 *
 *  Compared on the DECODED path as well as the raw one: we forward `req.url`
 *  verbatim, so an app framework that resolves `%66` would route
 *  `/donate/%66abric/x` to its own /fabric handler while a raw-text check saw
 *  nothing. Segment-splitting (rather than slicing by `seg.length`) also keeps a
 *  doubled slash like `//donate/fabric` from shifting the comparison.
 *  Exported for tests. */
export function isFabricSubpath(url: string, seg: string): boolean {
  const targetsFabric = (path: string): boolean => {
    const parts = path.split('/').filter(Boolean);
    // Normally parts[0] is the app's own segment and parts[1] is what it asked
    // for; if the segment doesn't line up, fall back to the first segment so an
    // unexpected shape fails CLOSED rather than open.
    return parts[parts[0] === seg ? 1 : 0] === 'fabric';
  };
  const raw = url.split('?')[0]!.split('#')[0]!;
  // Dot segments have to be resolved before comparing, and this is the third
  // spelling-of-the-same-path bug in this codebase (raw-vs-decoded was the first two).
  // `/donate/./fabric/billing` split to ['donate','.','fabric',…], so parts[1] was '.'
  // and the guard said "not fabric" — while `firstSegment` still returned `donate`, so
  // the request was proxied on with its URL forwarded verbatim, and any app framework
  // that normalises dot segments then served its own LAN-only /fabric handler to the
  // public tunnel. Test every spelling the far end might resolve to.
  return [raw, decodedPath(url), resolveDotSegments(raw), resolveDotSegments(decodedPath(url))].some(
    targetsFabric,
  );
}

/**
 * What an app may say back through the tunnel.
 *
 *  - Never a platform session cookie. The apps share a hostname with each other, and
 *    one app setting `omos_session` for another's path is how it would sign the admin
 *    out of that app, or into an account of its own choosing.
 *  - Never `Service-Worker-Allowed`. Without it a service worker is confined to the
 *    directory its script is served from — which, because no app's worker script is
 *    ever served at the bare `/<seg>` address (isBareAppAddress), is always inside the
 *    app's own path. With it, one app could register a worker over the whole hostname, see
 *    every other app's pages — and the address that hands a browser an app's access
 *    token (system/app-access.ts), which it could then use elsewhere.
 *  - Never `Cross-Origin-Opener-Policy`. The dashboard shares this address and sends
 *    `same-origin`; a window is kept between two pages only when both send the SAME
 *    policy, so an app page that sent it too could open the dashboard and read the key
 *    out of the window (system/remote-admin.ts, the key rule in its header).
 *  - Never cached by anyone but the admin's own browser, when the page is private or
 *    the request carried the admin's access token: Cloudflare keys its cache on the
 *    address alone, so a cached copy would go to everyone who asks next.
 */
function responseHeadersForTunnel(
  headers: http.IncomingHttpHeaders,
  opts: { private: boolean },
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = { ...headers };
  delete out['service-worker-allowed'];
  delete out['cross-origin-opener-policy'];
  const cookies = headers['set-cookie'];
  if (cookies) {
    const kept = cookies.filter((c) => {
      const name = c.slice(0, Math.max(0, c.indexOf('='))).trim();
      return name !== COOKIE_NAME && name !== REMOTE_COOKIE_NAME;
    });
    if (kept.length > 0) out['set-cookie'] = kept;
    else delete out['set-cookie'];
  }
  if (opts.private) {
    for (const [k, v] of Object.entries(NO_STORE_HEADERS)) out[k] = v;
    delete out.expires;
  }
  return out;
}

function proxyHttp(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  /** `noStore`: never cacheable, whatever the app says (an app's bare address). */
  opts: { tunnel: boolean; keep: string | null; private: boolean; noStore: boolean },
): void {
  const up = http.request(
    { host: TARGET_HOST, port, method: req.method, path: req.url, headers: trustedHeaders(req, opts.keep) },
    (upRes) => {
      let headers: http.OutgoingHttpHeaders = opts.tunnel
        ? responseHeadersForTunnel(upRes.headers, { private: opts.private || opts.noStore })
        : upRes.headers;
      if (!opts.tunnel && opts.noStore) {
        headers = { ...upRes.headers, ...NO_STORE_HEADERS };
        delete headers.expires;
      }
      res.writeHead(upRes.statusCode ?? 502, headers);
      upRes.pipe(res);
    },
  );
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('This app is not reachable right now.');
  });
  // A browser that leaves part-way — a live event stream, a long poll, a big download,
  // or Cloudflare dropping the connection — ends the request to the app too. pipe() only
  // pauses the app's response, so this daemon held the app's connection until the app
  // gave up by itself (system/socket-relay.ts is the same lesson for sockets).
  res.once('close', () => {
    if (!res.writableFinished) up.destroy();
  });
  req.pipe(up);
}

/**
 * Wire path-based app proxying onto the HTTP front door. App paths are hijacked +
 * proxied; everything else falls through to the front door's own routes.
 */
export function attachIngress(
  front: FastifyInstance,
  opts: {
    /**
     * Take ownership of a non-app WebSocket upgrade, or decline it.
     *
     * Return true ONLY after actually handling the socket (completing the
     * handshake). Anything declined is destroyed below. This listener is the ONE
     * owner of every upgrade on the front door, and that is the fix for a bug: the
     * first version registered @fastify/websocket here too, which attaches its own
     * `upgrade` listener and routes EVERY upgrade through Fastify. An app's socket
     * was then handled twice — piped to the app by this listener, AND run through
     * the ingress onRequest hook as a plain HTTP proxy — so the client got the
     * app's page injected into its WebSocket stream and the connection died. Every
     * app using live sockets over the tunnel was broken by it.
     *
     * The previous hook here, `allowUpgrade`, meant "leave this alone for another
     * listener". There is no other listener any more, by design.
     */
    claimUpgrade?: (req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => boolean;
  } = {},
): void {
  void rebuild();
  const timer = setInterval(() => void rebuild(), 10_000);
  timer.unref?.();

  front.addHook('onRequest', (req, reply, done) => {
    const seg = firstSegment(req.url);
    const route = seg ? routes.get(seg) : undefined;
    if (!route) return done(); // not an app path → normal front-door handling
    const tunnel = isViaTunnelHeaders(req.headers);
    // The admin's access token for THIS app, if the request carries a valid one.
    const keep = tunnel ? appAccessFromCookie(req.headers.cookie, route.id) : null;
    const isPrivate = tunnel && (!route.exposed || keep !== null);
    // An app that is not shared online, asked for without its token, is declined
    // FIRST — before anything below can answer differently for it than for an empty
    // address. A review found the /fabric refusal answering here, before the body was
    // read, while an empty address went on to the not-found route, where Fastify
    // parses the body first: a malformed or oversized POST then got 404 at an
    // installed app's path and 400/413 at an empty one, which told a stranger which
    // apps were installed. Declined here, both take the same road.
    if (!route.exposed) {
      // Not shared online. On the masjid's network nothing changes — it is reached at
      // its own port, and this listener goes on not serving it.
      if (!tunnel) return done();
      // From outside: only with its access token. Anyone else falls through to the
      // not-found handler and gets exactly the 404 an empty address gets.
      if (!keep) {
        declined.set(req.raw, 'app-not-shared');
        return done();
      }
    }
    // Refuse an app's /fabric/* over the tunnel — LAN-only (app↔platform + broker).
    // An access token does not open it either.
    if (tunnel && isFabricSubpath(req.url, seg)) return refuseOverTunnel(req, reply, 'app-fabric-lan-only');
    // An app's bare address never serves the app's worker script — only one that removes
    // itself — and nothing answered there is cacheable (isBareAppAddress says why).
    // Everything else goes to the app.
    const bare = isBareAppAddress(req.url);
    if (bare && isWorkerScriptFetch(req.headers)) return answerBareWorkerFetch(req, reply, { record: tunnel });
    reply.hijack(); // we own the raw response from here
    proxyHttp(req.raw, reply.raw, route.port, { tunnel, keep, private: isPrivate, noStore: bare });
  });

  // WebSocket upgrades for app paths (apps may use live sockets behind the tunnel).
  front.server.on('upgrade', (req, socket, head) => {
    const seg = firstSegment(req.url ?? '');
    const found = seg ? routes.get(seg) : undefined;
    const tunnel = isViaTunnelHeaders(req.headers);
    // Is this an app socket THIS request may open? The same rules as HTTP: an app that
    // is not shared online only with its access token, and on the masjid's network
    // not through this listener at all.
    const keep = found && tunnel ? appAccessFromCookie(req.headers.cookie, found.id) : null;
    let route = found;
    let why: RefusalReason | null = null;
    if (route && !route.exposed && !(tunnel && keep)) {
      why = 'app-not-shared';
      route = undefined;
    }
    // Same /fabric/* refusal as the HTTP path (a WS upgrade must not tunnel in) — and,
    // as there, only for a socket that would otherwise be served, so a declined app's
    // /fabric takes the same road as an empty address below.
    if (route && tunnel && isFabricSubpath(req.url ?? '', seg)) {
      socket.destroy();
      return;
    }
    if (!route) {
      if (tunnel && why) {
        noteRefusal(
          req.url ?? '',
          {
            host: String(req.headers.host ?? ''),
            method: req.method,
            cfRay: String(req.headers['cf-ray'] ?? ''),
            accept: String(req.headers.accept ?? ''),
            agent: String(req.headers['user-agent'] ?? ''),
          },
          why,
        );
      }
      // Not an app socket. ONE thing may claim it: one of the dashboard's own sockets,
      // when the front-door gate would let that request through. A declined app takes
      // this same path rather than being destroyed on the spot, so the answer is the
      // same as for an address with nothing at it — a review found that destroying a
      // private app's socket here, while a dot-segment spelling of nothing was claimed
      // and answered, told a stranger which apps were installed.
      if (opts.claimUpgrade?.(req, socket, head)) return;
      // Otherwise DESTROY it, never just return. An abandoned socket gets no
      // response and no close — it holds a file descriptor until the peer gives
      // up, and the peer is the one choosing. On the tunnel-facing front door that
      // is an unauthenticated resource-exhaustion lever against a daemon running
      // as root with the Docker socket. Destroying is also what keeps a refused
      // upgrade from being answered with a keep-alive HTTP response on a socket
      // whose parser has already detached — which cloudflared would return to its
      // connection pool and then hand the next visitor, who would get no answer.
      socket.destroy();
      return;
    }
    // Opened with the admin's access token: recorded, so signing out, a new password, a
    // changed second factor or the door shutting closes it (system/remote-sockets.ts).
    if (tunnel && keep && !trackAppSocket(socket, route.id, keep)) {
      socket.destroy();
      return;
    }
    const port = route.port;
    const up = net.connect(port, TARGET_HOST, () => {
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n`);
      // Relay the handshake headers (incl. Connection/Upgrade, which WS needs) but
      // drop client-supplied forwarding headers, then inject trusted ones — same
      // hostile-boundary reasoning as the HTTP path.
      // Same drop-list as the HTTP path, including cf-connecting-ip — it is only
      // trustworthy when Cloudflare set it, and it is re-added below if so.
      const drop = new Set([
        'x-forwarded-for',
        'x-forwarded-proto',
        'x-forwarded-host',
        'x-forwarded-port',
        'x-forwarded-prefix',
        'forwarded',
        'cf-connecting-ip',
        'x-real-ip',
        'true-client-ip',
      ]);
      // Through the tunnel the Cookie header is rebuilt, exactly as on the HTTP path:
      // no platform session cookie reaches an app, only its own access token.
      if (tunnel) drop.add('cookie');
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (drop.has(req.rawHeaders[i].toLowerCase())) continue;
        up.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
      }
      if (tunnel) {
        const cookie = cookieHeaderForApp(req.headers.cookie, keep);
        if (cookie !== undefined) up.write(`Cookie: ${cookie}\r\n`);
      }
      const cfIp = tunnel ? req.headers['cf-connecting-ip'] : undefined;
      const trustedCfIp = typeof cfIp === 'string' && cfIp ? cfIp : '';
      const fwdFor = trustedCfIp || req.socket?.remoteAddress || '';
      if (trustedCfIp) up.write(`CF-Connecting-IP: ${trustedCfIp}\r\n`);
      up.write(`X-Forwarded-For: ${fwdFor}\r\n`);
      up.write(`X-Forwarded-Proto: ${tunnel ? 'https' : 'http'}\r\n`);
      if (req.headers.host) up.write(`X-Forwarded-Host: ${req.headers.host}\r\n`);
      up.write('\r\n');
      if (head && head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    closeTogether(socket, up);
  });

  log.info('Path-based app ingress attached to the HTTP front door.');
}
