// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Per-app HTTPS for apps that need a secure context (Stripe apps — the in-person
 * M2 reader / Stripe Terminal SDK and in-page Elements both require HTTPS).
 *
 * Such an app declares `https: true` in its manifest. The platform assigns it a
 * dedicated host port from a small pre-mapped range and runs an in-process TLS
 * terminator on that port (using the dashboard's cert) that forwards plain HTTP
 * to the app's own published port. The app itself stays a normal HTTP container;
 * only the public edge is TLS. Non-payment apps don't get a proxy at all.
 *
 * The app's HTTP port is published on the host, so the proxy reaches it via
 * `host.docker.internal` (the installer adds the host-gateway mapping to the core
 * service). The port range is mapped into the core container by the installer.
 */
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { loadCert } from './tls';
import { log } from '../logger';

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

const APP_TLS_MIN = envInt('OPENMASJID_APP_TLS_MIN', 8443);
const APP_TLS_MAX = envInt('OPENMASJID_APP_TLS_MAX', 8452);
/** How the core reaches an app's published host port (set via the installer's
 *  extra_hosts host-gateway mapping). Falls back to localhost in dev. */
const TARGET_HOST = process.env.OPENMASJID_APP_PROXY_TARGET ?? 'host.docker.internal';

// Client-supplied forwarding/hop-by-hop headers we must not relay verbatim (this
// edge is a trust boundary; apps trust X-Forwarded-* behind the OS proxy).
const STRIP_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-forwarded-port',
  'forwarded',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
];

/** Real client IP: Cloudflare's CF-Connecting-IP if present, else the TLS peer. */
function clientIp(req: import('node:http').IncomingMessage): string {
  const cf = req.headers['cf-connecting-ip'];
  return (typeof cf === 'string' && cf) || req.socket?.remoteAddress || '';
}

/** Strip spoofable forwarding headers and set trusted ones. TLS is terminated
 *  HERE, so the forwarded protocol upstream is always https. */
function trustedHeaders(
  req: import('node:http').IncomingMessage,
): NodeJS.Dict<string | string[]> {
  const headers: NodeJS.Dict<string | string[]> = { ...req.headers };
  for (const h of STRIP_HEADERS) delete headers[h];
  headers['x-forwarded-for'] = clientIp(req);
  headers['x-forwarded-proto'] = 'https';
  if (req.headers.host) headers['x-forwarded-host'] = String(req.headers.host);
  return headers;
}

interface AppProxy {
  server: https.Server;
  httpsPort: number;
  targetPort: number;
}

const proxies = new Map<string, AppProxy>();

export function appTlsPortRange(): { min: number; max: number } {
  return { min: APP_TLS_MIN, max: APP_TLS_MAX };
}

/** Ports currently bound by app proxies (so allocation doesn't collide). */
export function activeProxyPorts(): Set<number> {
  return new Set([...proxies.values()].map((p) => p.httpsPort));
}

/** First free HTTPS port in the range, avoiding `used`, or null if exhausted. */
export function allocateHttpsPort(used: Set<number>): number | null {
  for (let p = APP_TLS_MIN; p <= APP_TLS_MAX; p++) {
    if (!used.has(p)) return p;
  }
  return null;
}

/** Start (or move) the TLS proxy for an app: terminate TLS on httpsPort and
 *  forward to the app's HTTP port. Idempotent. No-op if no cert (dev). */
export function ensureProxy(id: string, httpsPort: number, targetPort: number): void {
  const existing = proxies.get(id);
  if (existing && existing.httpsPort === httpsPort && existing.targetPort === targetPort) return;
  if (existing) stopProxy(id);

  let cert: { cert: Buffer; key: Buffer };
  try {
    cert = loadCert();
  } catch {
    return; // no TLS cert available (e.g. local dev) — skip the proxy
  }

  const server = https.createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
    const upstream = http.request(
      { host: TARGET_HOST, port: targetPort, method: req.method, path: req.url, headers: trustedHeaders(req) },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('This app is not reachable right now.');
    });
    req.pipe(upstream);
  });

  // Forward WebSocket upgrades too (apps may use live sockets).
  server.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(targetPort, TARGET_HOST, () => {
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n`);
      // Keep the handshake headers (Connection/Upgrade) but drop client-supplied
      // forwarding headers, then inject trusted ones (TLS terminated here → https).
      const drop = new Set(['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port', 'forwarded']);
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (drop.has(req.rawHeaders[i].toLowerCase())) continue;
        upstream.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
      }
      upstream.write(`X-Forwarded-For: ${clientIp(req)}\r\n`);
      upstream.write('X-Forwarded-Proto: https\r\n');
      if (req.headers.host) upstream.write(`X-Forwarded-Host: ${req.headers.host}\r\n`);
      upstream.write('\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  server.on('error', (err) => log.error(`App HTTPS proxy for "${id}" (:${httpsPort}) failed`, err));
  server.listen(httpsPort, '0.0.0.0');
  proxies.set(id, { server, httpsPort, targetPort });
  log.info(`App HTTPS proxy: "${id}" on :${httpsPort} → ${TARGET_HOST}:${targetPort}`);
}

export function stopProxy(id: string): void {
  const p = proxies.get(id);
  if (!p) return;
  try {
    p.server.close();
  } catch {
    /* already closed */
  }
  proxies.delete(id);
}

/** Re-apply the current cert to every running app proxy (after regen/upload). */
export function reloadProxyCerts(): void {
  let cert: { cert: Buffer; key: Buffer };
  try {
    cert = loadCert();
  } catch {
    return;
  }
  for (const p of proxies.values()) {
    try {
      p.server.setSecureContext({ key: cert.key, cert: cert.cert });
    } catch {
      /* best effort */
    }
  }
}
