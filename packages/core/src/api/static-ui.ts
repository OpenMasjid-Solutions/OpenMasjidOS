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
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { decodedPath } from '../system/via-tunnel';
import { DASHBOARD_SEGMENTS, wasHandedOver } from '../system/remote-admin';
import { sessionKey } from '../auth/sessions';
import { requestSessionToken, requestUser } from './ws-auth';

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

/** The dashboard's own pages — the ones a browser loads as a document. */
function isDashboardPage(url: string): boolean {
  const p = decodedPath(url);
  if (p === '/' || p === '/index.html') return true;
  const first = p.split('/').find(Boolean) ?? '';
  return first !== 'trpc' && first !== 'assets' && (DASHBOARD_SEGMENTS as readonly string[]).includes(first);
}

/**
 * The remote dashboard's pages: index.html with the dashboard key in it, and nothing an
 * app page sharing this address can use to get it.
 *
 * From outside the dashboard shares its address — and so its origin — with every app
 * page (system/remote-admin.ts, the key rule in its header). So the remote dashboard
 * keeps the key in the tab's memory, never in this origin's storage, and gets it back on
 * a reload from here:
 *  - only for a load the BROWSER marks as a top-level page load — `Sec-Fetch-Dest:
 *    document` and `Sec-Fetch-Mode: navigate`, which no script can set. An app page's
 *    fetch, frame or embed of the same address gets the page with no key in it;
 *  - only for a live remote session through an open door (`requestUser`);
 *  - with `Cross-Origin-Opener-Policy: same-origin`, so a window an app page opened on
 *    it is cut off from it at once (app pages never carry COOP: system/ingress.ts), and
 *    `frame-ancestors 'none'`, so it is never framed;
 *  - never cached, by the browser or Cloudflare.
 * Every remote page carries the meta tag, key or not: its presence is what tells the
 * dashboard to keep the key in memory (ui/src/lib/session.ts).
 */
function registerRemoteDashboardPages(server: FastifyInstance, uiDir: string): void {
  const indexHtml = fs.readFileSync(path.join(uiDir, 'index.html'), 'utf8');
  server.addHook('onRequest', async (req, reply) => {
    if (!wasHandedOver(req.raw) || (req.method !== 'GET' && req.method !== 'HEAD') || !isDashboardPage(req.url)) return;
    const loadedAsPage = req.headers['sec-fetch-dest'] === 'document' && req.headers['sec-fetch-mode'] === 'navigate';
    const key = (loadedAsPage && requestUser(req) && sessionKey(requestSessionToken(req))) || '';
    const meta = `<meta name="omos-key" content="${key}">`; // base64url: nothing to escape
    const html = /<head[^>]*>/i.test(indexHtml) ? indexHtml.replace(/<head[^>]*>/i, (m) => m + meta) : meta + indexHtml;
    return reply
      .header('cache-control', 'no-store')
      .header('cross-origin-opener-policy', 'same-origin')
      .header('x-frame-options', 'DENY')
      .header('content-security-policy', "frame-ancestors 'none'")
      .type('text/html; charset=utf-8')
      .send(html);
  });
}

/**
 * Register static UI serving + the SPA fallback. Returns whether a UI build was
 * found — in local dev Vite serves the UI, so `dist` may not exist and the daemon
 * still has to boot.
 */
export async function registerStaticUI(server: FastifyInstance, uiDir: string): Promise<boolean> {
  const haveUI = await registerStaticFiles(server, uiDir);
  if (haveUI) registerRemoteDashboardPages(server, uiDir);
  const fallback = spaFallback(haveUI);
  server.setNotFoundHandler((req, reply) => {
    if (!fallback(req, reply)) reply.code(404).send({ error: 'Not found' });
  });
  return haveUI;
}
