// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Daemon entry point. One Fastify server hosts everything on one port:
 *   - tRPC over HTTP at /trpc (queries + mutations)
 *   - tRPC over WebSocket at /trpc (live subscriptions, e.g. system stats)
 *   - a couple of plain /api routes (health for the installer, backup download)
 *   - the built React UI as static files, with SPA fallback to index.html
 */
import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';

import { HOST, PORT, TLS_PORT, UI_DIR, CONFIG_DIR, APPS_DIR } from './config';
import { VERSION } from './version';
import { ensureCert, loadCert, setLiveServer } from './system/tls';
import { restoreAppProxies } from './apps/manager';
import { log } from './logger';
import { ensureDir } from './util/json-store';
import { appRouter, type AppRouter } from './trpc/router';
import { createContext } from './trpc/context';
import { dockerReachable } from './docker/client';
import { backupStream, backupFilename } from './system/backup';
import { startBackupScheduler } from './system/backup-upload';
import { ensureCloudflared } from './system/cloudflared';
import { registerTerminals } from './api/terminals';
import { registerFiles } from './api/files';
import { registerUpdate } from './api/update';
import { registerRestore } from './api/restore';
import { registerAppUpdate } from './api/app-update';
import { registerFabric } from './api/fabric';
import { COOKIE_NAME, getSessionUser } from './auth/sessions';
import { requestCsrfOk } from './api/ws-auth';
import { isAllowedOrigin, isWebSocketUpgrade } from './util/origin';

async function main() {
  ensureDir(CONFIG_DIR);
  ensureDir(APPS_DIR);

  // Defense-in-depth: the core runs as root and is the single control plane —
  // a stray async error (e.g. a hijacked terminal stream) must never crash it.
  process.on('uncaughtException', (err) => log.error('Uncaught exception (continuing).', err));
  process.on('unhandledRejection', (err) => log.error('Unhandled rejection (continuing).', err));

  // Forced HTTPS: serve the dashboard over TLS. Self-signed by default (a LAN box
  // can't get a public cert), regenerable / replaceable from Settings. If no cert
  // can be made (local dev without openssl) we fall back to plain HTTP.
  let tls: { key: Buffer; cert: Buffer } | null = null;
  try {
    ensureCert();
    tls = loadCert();
  } catch (err) {
    log.warn('TLS unavailable — serving plain HTTP (expected in local dev without openssl).', err);
  }

  const server = Fastify({
    maxParamLength: 5000,
    bodyLimit: 25 * 1024 * 1024,
    ...(tls ? { https: tls } : {}),
  });

  await server.register(fastifyCookie);
  await server.register(fastifyWebsocket);
  await server.register(fastifyMultipart, { limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

  // tRPC — HTTP and WebSocket on the same /trpc prefix.
  const trpcPluginOptions: FastifyTRPCPluginOptions<AppRouter> = {
    prefix: '/trpc',
    useWSS: true,
    trpcOptions: {
      router: appRouter,
      createContext,
      onError({ path, error }) {
        log.error(`tRPC error${path ? ` on "${path}"` : ''}: ${error.message}`);
      },
    },
  };
  await server.register(fastifyTRPCPlugin, trpcPluginOptions);

  // Security headers on every response. frame-ancestors/X-Frame-Options stop the
  // dashboard from being framed by a malicious app on another port (same host =
  // same-site, so the cookie would ride along) — clickjacking defence. We don't
  // overwrite a route's own CSP (the file raw-viewer sets a strict sandbox CSP).
  server.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    if (!reply.getHeader('content-security-policy')) {
      reply.header('Content-Security-Policy', "frame-ancestors 'self'");
    }
    return payload;
  });

  // CSRF defence for the tRPC HTTP path: any cookie-carrying call from a foreign
  // origin is rejected (queries AND mutations — a query can still have a side
  // effect, and same-site apps on another port share the cookie). WebSocket
  // upgrades are exempt here (they're origin-checked in createContext), and dev /
  // absent-Origin (non-browser) requests are allowed by isAllowedOrigin.
  server.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/trpc') && !isWebSocketUpgrade(req) && !isAllowedOrigin(req)) {
      return reply.code(403).send({ error: 'This request came from an unexpected place.' });
    }
  });

  // Health — unauthenticated, used by the installer and the container healthcheck.
  server.get('/api/health', async () => ({ status: 'ok', version: VERSION }));

  server.get('/api/ready', async () => ({ ready: await dockerReachable() }));

  // Backup download — a gzipped tar of platform config + app data. Authenticated
  // by the session cookie directly (it's a browser download, not a tRPC call).
  server.get('/api/backup', async (req, reply) => {
    if (!isAllowedOrigin(req)) return reply.code(403).send({ error: 'Bad origin.' });
    const token = req.cookies?.[COOKIE_NAME];
    if (!getSessionUser(token)) {
      return reply.code(401).send({ error: 'Please sign in.' });
    }
    // The download URL is a plain <a href> (no header), so the dashboard key
    // rides in ?k= — an app that captured the cookie can't forge it.
    if (!requestCsrfOk(req)) return reply.code(403).send({ error: 'This request came from an unexpected place.' });
    reply
      .header('content-type', 'application/gzip')
      .header('content-disposition', `attachment; filename="${backupFilename()}"`);
    return reply.send(await backupStream());
  });

  // WebSocket terminals (root shell + per-app shell), gated by settings + auth.
  registerTerminals(server);

  // File explorer download/upload (streaming, cookie-authenticated).
  registerFiles(server);

  // Live self-update over WebSocket (pull + recreate, streamed to the UI).
  registerUpdate(server);

  // Backup restore: upload (HTTP) + streamed restore (WebSocket).
  registerRestore(server);

  // Catalog app updates streamed over a WebSocket (pull + recreate).
  registerAppUpdate(server);

  // OpenMasjidOS Fabric: SSO cookie introspection + public appearance (optional).
  registerFabric(server);

  // Static UI + SPA fallback. In local dev the UI is served by Vite, so dist may
  // not exist — guard the registration so the daemon still boots.
  const haveUI = fs.existsSync(UI_DIR);
  if (haveUI) {
    await server.register(fastifyStatic, {
      root: UI_DIR,
      prefix: '/',
      wildcard: false,
      cacheControl: false,
      // Vite fingerprints everything under /assets/ — cache those forever so
      // repeat visits are instant. index.html must always revalidate so a new
      // build is picked up immediately.
      setHeaders: (res, filePath) => {
        if (/[\\/]assets[\\/]/.test(filePath)) {
          res.setHeader('cache-control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('cache-control', 'no-cache');
        }
      },
    });
  } else {
    log.warn(`UI build not found at ${UI_DIR} — serving API only (run the UI dev server).`);
  }

  server.setNotFoundHandler((req, reply) => {
    const url = req.url.split('?')[0];
    // Never SPA-fallback API/tRPC routes — those 404 as JSON.
    if (url.startsWith('/trpc') || url.startsWith('/api')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    if (haveUI && req.method === 'GET') {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'Not found' });
  });

  // A plain-HTTP front door on PORT: answers the container health check, keeps the
  // Fabric API reachable over HTTP for app backends (which can't trust a
  // self-signed cert for server-to-server calls), and 308-redirects every other
  // request to the HTTPS dashboard. So browsers are forced to HTTPS while apps and
  // the healthcheck keep working — and a bare URL still leads somewhere.
  async function startHttpFront(): Promise<void> {
    const front = Fastify({ maxParamLength: 5000 });
    await front.register(fastifyCookie);
    front.get('/api/health', async () => ({ status: 'ok', version: VERSION }));
    front.get('/api/ready', async () => ({ ready: await dockerReachable() }));
    registerFabric(front);
    front.setNotFoundHandler((req, reply) => {
      const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
      if (!host) return reply.code(400).send({ error: 'Bad request.' });
      const target = TLS_PORT === 443 ? host : `${host}:${TLS_PORT}`;
      return reply.code(308).redirect(`https://${target}${req.url}`);
    });
    await front.listen({ host: HOST, port: PORT });
  }

  if (tls) {
    setLiveServer(server);
    await server.listen({ host: HOST, port: TLS_PORT });
    await startHttpFront();
    // Re-establish the per-app HTTPS proxies (Stripe apps) after a restart.
    restoreAppProxies().catch((err) => log.error('Could not restore app HTTPS proxies.', err));
    log.info(`OpenMasjidOS core v${VERSION} on https://${HOST}:${TLS_PORT} (HTTP→HTTPS redirect on ${PORT})`);
  } else {
    await server.listen({ host: HOST, port: PORT });
    log.info(`OpenMasjidOS core v${VERSION} listening on http://${HOST}:${PORT}`);
  }

  // Scheduled off-site backups (Google Drive / NAS) — a lightweight tick that
  // runs a backup when one is due. No-op until the admin configures a destination.
  startBackupScheduler();

  // Cloudflare tunnel (remote access) — bring it up if the admin enabled it.
  // No-op until a token is set + enabled. Never blocks boot.
  ensureCloudflared().catch((err) => log.error('Could not start the Cloudflare tunnel.', err));
}

main().catch((err) => {
  log.error('Fatal: the core failed to start.', err);
  process.exit(1);
});
