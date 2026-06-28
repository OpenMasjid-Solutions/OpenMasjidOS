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
import { log } from '../logger';

// How the core reaches an app's published host port (host-gateway mapping added by
// the installer; localhost in dev). Same target the per-app TLS proxy uses.
const TARGET_HOST = process.env.OPENMASJID_APP_PROXY_TARGET ?? 'host.docker.internal';
// Path segments that must never be treated as an app route (platform endpoints).
const RESERVED = new Set(['api', 'trpc', 'assets']);

let routes = new Map<string, number>(); // path segment → app HTTP port

async function rebuild(): Promise<void> {
  try {
    const apps = await listInstalled();
    const next = new Map<string, number>();
    for (const a of apps) {
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

function firstSegment(url: string): string {
  const path = url.split('?')[0].split('#')[0];
  for (const part of path.split('/')) {
    if (part) return part;
  }
  return '';
}

function proxyHttp(req: IncomingMessage, res: ServerResponse, port: number): void {
  const up = http.request(
    { host: TARGET_HOST, port, method: req.method, path: req.url, headers: req.headers },
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
    reply.hijack(); // we own the raw response from here
    proxyHttp(req.raw, reply.raw, port);
  });

  // WebSocket upgrades for app paths (apps may use live sockets behind the tunnel).
  front.server.on('upgrade', (req, socket, head) => {
    const seg = firstSegment(req.url ?? '');
    const port = seg ? routes.get(seg) : undefined;
    if (port == null) return; // not an app path — leave it (front door has no other WS)
    const up = net.connect(port, TARGET_HOST, () => {
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n`);
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        up.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
      }
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
