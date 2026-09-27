// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Serves the built dashboard (the Vite output) plus the SPA fallback.
 *
 * Extracted from index.ts so it can be tested directly: @fastify/static is the
 * one dependency here with a history of path-traversal and route-guard-bypass
 * advisories (the v8 -> v10 bump was to clear four of them), and "does the
 * dashboard still load, and can anything escape the UI directory" is not a
 * question to answer by eye.
 */
import fs from 'node:fs';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { decodedPath } from '../system/via-tunnel';

/** Prefixes that must always 404 as JSON rather than fall back to the SPA. */
const API_PREFIXES = ['/trpc', '/api'];

/**
 * Serve the built files, without claiming the not-found handler.
 *
 * Split out because the HTTP front door already has a not-found handler of its
 * own — the one that 404s tunnel traffic and 308-redirects everything else — and
 * Fastify allows exactly one per instance. The front door composes the SPA
 * fallback into that handler instead of replacing it (see `spaFallback`), so
 * remote administration can serve the dashboard without losing the refusal
 * recording that makes a wrong public address diagnosable.
 */
export async function registerStaticFiles(server: FastifyInstance, uiDir: string): Promise<boolean> {
  const haveUI = fs.existsSync(uiDir);
  if (haveUI) {
    await server.register(fastifyStatic, {
      root: uiDir,
      prefix: '/',
      wildcard: false,
      cacheControl: false,
      // Vite fingerprints everything under /assets/ — cache those forever so
      // repeat visits are instant. index.html must always revalidate so a new
      // build is picked up immediately.
      //
      // NOTE: @fastify/static v10 changed this callback's first argument from a
      // raw ServerResponse to a FastifyReply, so it is `reply.header(...)` here,
      // not `res.setHeader(...)`. Nothing in CI would have caught that — no
      // workflow typechecks, and the build is esbuild/vite — so a silent
      // regression to no caching on /assets was one `npm audit fix --force` away.
      setHeaders: (reply, filePath) => {
        if (/[\\/]assets[\\/]/.test(filePath)) {
          reply.header('cache-control', 'public, max-age=31536000, immutable');
        } else {
          reply.header('cache-control', 'no-cache');
        }
      },
    });
  }

  return haveUI;
}

/**
 * The SPA fallback, as a plain function so either listener can use it.
 *
 * Returns `false` when it declined to answer, so a caller that has its own
 * not-found behaviour (the front door's tunnel refusal + HTTPS redirect) can
 * carry on rather than having the reply half-written underneath it.
 */
export function spaFallback(haveUI: boolean) {
  return (req: FastifyRequest, reply: FastifyReply): boolean => {
    // Compared on the decoded path as well as the raw one, for the same reason the
    // Fabric guard is: the router dispatches on the decoded path, so `/%61pi/…`
    // is an API request that a raw `startsWith('/api')` does not recognise. The
    // consequence here is milder than the Fabric case — the worst outcome is
    // index.html where JSON belonged — but an API path must not answer with the
    // dashboard shell, and the two checks should not disagree about what `/api` is.
    const raw = req.url.split('?')[0]!.split('#')[0]!;
    const dec = decodedPath(req.url);
    const isApi = API_PREFIXES.some((p) => raw.startsWith(p) || dec.startsWith(p));
    if (isApi) {
      reply.code(404).send({ error: 'Not found' });
      return true;
    }
    if (haveUI && req.method === 'GET') {
      reply.type('text/html').sendFile('index.html');
      return true;
    }
    return false;
  };
}

/**
 * Register static UI serving + the SPA fallback. Returns whether a UI build was
 * found — in local dev Vite serves the UI, so `dist` may not exist and the daemon
 * still has to boot.
 */
export async function registerStaticUI(server: FastifyInstance, uiDir: string): Promise<boolean> {
  const haveUI = await registerStaticFiles(server, uiDir);
  const fallback = spaFallback(haveUI);
  server.setNotFoundHandler((req, reply) => {
    if (!fallback(req, reply)) reply.code(404).send({ error: 'Not found' });
  });
  return haveUI;
}
