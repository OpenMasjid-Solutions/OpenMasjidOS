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
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';

import { HOST, PORT, UI_DIR, CONFIG_DIR, APPS_DIR } from './config';
import { VERSION } from './version';
import { log } from './logger';
import { ensureDir } from './util/json-store';
import { appRouter, type AppRouter } from './trpc/router';
import { createContext } from './trpc/context';
import { dockerReachable } from './docker/client';
import { backupStream, backupFilename } from './system/backup';
import { registerTerminals } from './api/terminals';
import { COOKIE_NAME, getSessionUser } from './auth/sessions';

async function main() {
  ensureDir(CONFIG_DIR);
  ensureDir(APPS_DIR);

  const server = Fastify({ maxParamLength: 5000, bodyLimit: 25 * 1024 * 1024 });

  await server.register(fastifyCookie);
  await server.register(fastifyWebsocket);

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

  // Health — unauthenticated, used by the installer and the container healthcheck.
  server.get('/api/health', async () => ({ status: 'ok', version: VERSION }));

  server.get('/api/ready', async () => ({ ready: await dockerReachable() }));

  // Backup download — a gzipped tar of platform config + app data. Authenticated
  // by the session cookie directly (it's a browser download, not a tRPC call).
  server.get('/api/backup', async (req, reply) => {
    const token = req.cookies?.[COOKIE_NAME];
    if (!getSessionUser(token)) {
      return reply.code(401).send({ error: 'Please sign in.' });
    }
    reply
      .header('content-type', 'application/gzip')
      .header('content-disposition', `attachment; filename="${backupFilename()}"`);
    return reply.send(backupStream());
  });

  // WebSocket terminals (root shell + per-app shell), gated by settings + auth.
  registerTerminals(server);

  // Static UI + SPA fallback. In local dev the UI is served by Vite, so dist may
  // not exist — guard the registration so the daemon still boots.
  const haveUI = fs.existsSync(UI_DIR);
  if (haveUI) {
    await server.register(fastifyStatic, { root: UI_DIR, prefix: '/', wildcard: false });
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

  await server.listen({ host: HOST, port: PORT });
  log.info(`OpenMasjidOS core v${VERSION} listening on http://${HOST}:${PORT}`);
}

main().catch((err) => {
  log.error('Fatal: the core failed to start.', err);
  process.exit(1);
});
