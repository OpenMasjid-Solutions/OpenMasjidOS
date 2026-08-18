// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Path-based ingress for remote access. So the admin only adds ONE Cloudflare
 * public hostname (omos.<domain> → http://localhost:<PORT>) instead of one per
 * app, the platform's HTTP front door reverse-proxies each app by the first path
 * segment: `omos.<domain>/donate/…` → the Donations container, `/display/…` →
 * Display, etc. (paths from getAppPath, admin-configurable).
 *
 * Cloudflare terminates TLS at its edge and sends plain HTTP to the origin, so we
 * proxy to each app's plain HTTP container port (no per-app HTTPS/No-TLS-Verify to
 * configure). The dashboard itself is NOT exposed here — only known app paths are
 * proxied; everything else falls through to the front door (health/Fabric/redirect)
 * which 404s tunnel traffic, keeping the admin UI LAN-only.
 */
import http from 'node:http';
import net from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { listInstalled, getAppPath } from '../apps/manager';
import { isViaTunnelHeaders, decodedPath } from './via-tunnel';
import { appHost } from './app-host';
import { log } from '../logger';

// How the core reaches an app's published host port — one definition, shared with the
// per-app TLS proxy, the Fabric broker and the WhatsApp gateway client.
const TARGET_HOST = appHost();
// Path segments that must never be treated as an app route (platform endpoints).
const RESERVED = new Set(['api', 'trpc', 'assets']);

// Client-supplied forwarding + hop-by-hop headers we must NOT relay verbatim: the
// tunnel is a hostile boundary and apps trust X-Forwarded-* behind the OS proxy,
// so a spoofed value would poison absolute-URL building (open redirect) or
// per-IP rate limits. We strip these and set our own trusted values below.
const STRIP_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-forwarded-port',
  'forwarded',
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
 *  forwarding/hop-by-hop headers, plus trusted forwarding headers we set. */
function trustedHeaders(req: IncomingMessage): NodeJS.Dict<string | string[]> {
  const headers: NodeJS.Dict<string | string[]> = { ...req.headers };
  for (const h of STRIP_HEADERS) delete headers[h];
  const tunnel = isViaTunnelHeaders(req.headers);
  // Real client IP: Cloudflare's CF-Connecting-IP, but ONLY when the request really
  // arrived through the tunnel — off-tunnel that header is just something the caller
  // typed. Off-tunnel we use the socket peer, which cannot be forged.
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

let routes = new Map<string, number>(); // path segment → app HTTP port

async function rebuild(): Promise<void> {
  try {
    const apps = await listInstalled();
    const next = new Map<string, number>();
    for (const a of apps) {
      // Per-app exposure opt-in: only route apps the admin has exposed over the
      // tunnel. `exposed` is grandfathered-true for apps installed before this flag
      // (see InstalledApp.exposed), so upgrades never silently drop a working app.
      if (!a.exposed) continue;
      const port = a.ports[0]; // raw HTTP container port (Cloudflare provides TLS)
      if (port == null) continue;
      const seg = getAppPath(a.id);
      if (seg && !RESERVED.has(seg)) next.set(seg, port);
    }
    routes = next;
  } catch {
    /* keep the previous map on a transient Docker hiccup */
  }
}

/** Is the OS actually routing this app's public path to it right now? The Fabric
 *  `site` endpoint uses this so it only advertises a public URL the platform will
 *  really serve — the app can then trust it instead of doing a fragile hairpin
 *  self-probe through Cloudflare (which fails from inside a container even when the
 *  path routes fine for real external visitors). */
export function isRouted(appId: string): boolean {
  const seg = getAppPath(appId);
  return Boolean(seg) && routes.has(seg);
}

function firstSegment(url: string): string {
  const path = url.split('?')[0].split('#')[0];
  for (const part of path.split('/')) {
    if (part) return part;
  }
  return '';
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
 * Collapse `.` and `..` in a path, the way an HTTP server or URL parser would before
 * routing. Only used to make security comparisons see what the far end will see —
 * never to build a URL we then request.
 */
function resolveDotSegments(path: string): string {
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

function proxyHttp(req: IncomingMessage, res: ServerResponse, port: number): void {
  const up = http.request(
    { host: TARGET_HOST, port, method: req.method, path: req.url, headers: trustedHeaders(req) },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('This app is not reachable right now.');
  });
  req.pipe(up);
}

/**
 * Wire path-based app proxying onto the HTTP front door. App paths are hijacked +
 * proxied; everything else falls through to the front door's own routes.
 */
export function attachIngress(front: FastifyInstance): void {
  void rebuild();
  const timer = setInterval(() => void rebuild(), 10_000);
  timer.unref?.();

  front.addHook('onRequest', (req, reply, done) => {
    const seg = firstSegment(req.url);
    const port = seg ? routes.get(seg) : undefined;
    if (port == null) return done(); // not an app path → normal front-door handling
    // Refuse an app's /fabric/* over the tunnel — LAN-only (app↔platform + broker).
    if (isViaTunnelHeaders(req.headers) && isFabricSubpath(req.url, seg)) {
      return reply.code(404).send({ error: 'Not found.' });
    }
    reply.hijack(); // we own the raw response from here
    proxyHttp(req.raw, reply.raw, port);
  });

  // WebSocket upgrades for app paths (apps may use live sockets behind the tunnel).
  front.server.on('upgrade', (req, socket, head) => {
    const seg = firstSegment(req.url ?? '');
    const port = seg ? routes.get(seg) : undefined;
    if (port == null) return; // not an app path — leave it (front door has no other WS)
    // Same /fabric/* refusal on the WebSocket path (a WS upgrade must not tunnel in).
    if (isViaTunnelHeaders(req.headers) && isFabricSubpath(req.url ?? '', seg)) {
      socket.destroy();
      return;
    }
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
        'forwarded',
        'cf-connecting-ip',
      ]);
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (drop.has(req.rawHeaders[i].toLowerCase())) continue;
        up.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
      }
      const tunnel = isViaTunnelHeaders(req.headers);
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
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });

  log.info('Path-based app ingress attached to the HTTP front door.');
}
