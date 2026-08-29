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
import { backupStream, backupFilename, BackupBusyError } from './system/backup';
import { startBackupScheduler } from './system/backup-upload';
import { ensureCloudflared } from './system/cloudflared';
import { attachIngress } from './system/ingress';
import { noteRefusal } from './system/tunnel-refusals';
import { registerFabricTunnelGuard, isViaTunnel, urlHasPrefix } from './system/via-tunnel';
import { registerStaticUI } from './api/static-ui';
import { startAlertMonitor } from './system/alert-monitor';
import { startUpdateMonitor } from './system/update-monitor';
import { startAddressMonitor } from './system/address-monitor';
import { startStripeMonitor } from './system/stripe-monitor';
import { startWhatsAppMonitor } from './system/whatsapp-monitor';
import { setInboundHandler, startWhatsAppInbound } from './notify/whatsapp-inbound';
import { restoreWhatsAppQueue } from './notify/whatsapp';
import { handleInboundCommand } from './commands/execute';
import { registerTerminals } from './api/terminals';
import { registerFiles } from './api/files';
import { registerUpdate } from './api/update';
import { registerRestore } from './api/restore';
import { registerBranding } from './api/branding';
import { registerAppUpdate } from './api/app-update';
import { registerFabric } from './api/fabric';
import { COOKIE_NAME, getSessionUser } from './auth/sessions';
import { requestCsrfOk } from './api/ws-auth';
import { isAllowedOrigin, isWebSocketUpgrade } from './util/origin';

/** The dashboard server, with TLS when we have a usable cert and plain HTTP when we
 *  don't. One place, so the fallback path can rebuild it identically minus TLS. */
function buildServer(tls: { key: Buffer; cert: Buffer } | null) {
  return Fastify({
    maxParamLength: 5000,
    bodyLimit: 25 * 1024 * 1024,
    ...(tls ? { https: tls } : {}),
  });
}

async function main() {
  ensureDir(CONFIG_DIR);
  ensureDir(APPS_DIR);
  // Config holds every platform secret (admin password hash, Stripe keys, the
  // Cloudflare tunnel token, the notification webhook). Lock the directory to
  // root-only, so even if an individual secret file is briefly created with the
  // default umask (0o644) before its own chmod, a non-root co-tenant can't
  // traverse in to read it. The core runs as root, so this never blocks itself.
  try {
    fs.chmodSync(CONFIG_DIR, 0o700);
  } catch {
    /* best-effort (non-POSIX dev environment) */
  }

  // Defense-in-depth: the core runs as root and is the single control plane —
  // a stray async error (e.g. a hijacked terminal stream) must never crash it.
  process.on('uncaughtException', (err) => log.error('Uncaught exception (continuing).', err));
  process.on('unhandledRejection', (err) => log.error('Unhandled rejection (continuing).', err));

  // Forced HTTPS: serve the dashboard over TLS. Self-signed by default (a LAN box
  // can't get a public cert), regenerable / replaceable from Settings. `ensureCert`
  // repairs a damaged cert rather than handing us one that can't be loaded, and if
  // no cert can be made at all (local dev without openssl, a read-only disk) we
  // fall back to plain HTTP — the dashboard is still served, just without TLS, so
  // an admin can always get in and fix it.
  let tls: { key: Buffer; cert: Buffer } | null = null;
  try {
    ensureCert();
    tls = loadCert();
  } catch (err) {
    log.warn('TLS unavailable — serving plain HTTP (expected in local dev without openssl).', err);
  }

  let server: ReturnType<typeof buildServer>;
  try {
    server = buildServer(tls);
  } catch (err) {
    // Last line of defence for the boot path [OPENMASJIDOS-011]. Node builds the
    // TLS context inside this constructor, so a certificate that somehow got past
    // the checks in system/tls.ts throws HERE — outside the try/catch above, which
    // only covers reading it. That killed the process, and under
    // `restart: unless-stopped` a dead process is a crash-loop with no dashboard
    // left to repair it from. Degrading to plain HTTP keeps the box reachable, and
    // clearing `tls` also keeps the tunnel refused (it must never carry the
    // dashboard) and routes us down the HTTP branch below.
    log.error(
      'Could not start the HTTPS listener — falling back to plain HTTP so the dashboard stays reachable. Regenerate the certificate in Settings → Security.',
      err,
    );
    tls = null;
    server = buildServer(null);
  }

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
  // `urlHasPrefix` (not `req.url.startsWith`) because Fastify dispatches on the
  // percent-DECODED path: `/%74rpc/auth.setup` does not start with `/trpc` as raw
  // text, but the router still routes it to the tRPC handler — so a raw-text
  // comparison here skipped the origin check entirely for any encoded spelling.
  // Same class as the `/api/%66abric/...` walk-past fixed in v0.46.0; CLAUDE.md §15
  // forbids a raw-string startsWith in a security check by name.
  server.addHook('onRequest', async (req, reply) => {
    if (urlHasPrefix(req.url, '/trpc') && !isWebSocketUpgrade(req) && !isAllowedOrigin(req)) {
      return reply.code(403).send({ error: 'This request came from an unexpected place.' });
    }
  });

  // Health — unauthenticated, used by the installer and the container healthcheck.
  //
  // The version is withheld from anything that looks like it came through the tunnel, exactly
  // as on the front door. This copy was missed when the front-door pair was guarded, which is
  // the usual shape of that mistake: two listeners, one fix. On a host that is directly
  // reachable there is no header to detect and this still answers — mitigating THAT is a
  // firewall and a bind address, not a route guard (see docs/SECURITY.md).
  server.get('/api/health', async (req, reply) => {
    if (isViaTunnel(req)) {
      noteRefusal(req.url, String(req.headers.host ?? ''), 'lan-only-route');
      return reply.code(404).send({ error: 'Not found.' });
    }
    return { status: 'ok', version: VERSION };
  });

  server.get('/api/ready', async (req, reply) => {
    if (isViaTunnel(req)) {
      noteRefusal(req.url, String(req.headers.host ?? ''), 'lan-only-route');
      return reply.code(404).send({ error: 'Not found.' });
    }
    return { ready: await dockerReachable() };
  });

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
    // A backup that can't capture everything is refused rather than served as a
    // silently-incomplete file (system/backup.ts). Say so plainly instead of
    // handing the admin an archive they'd trust and later find gaps in.
    let backup;
    try {
      backup = await backupStream();
    } catch (err) {
      const busy = err instanceof BackupBusyError;
      return reply.code(busy ? 409 : 500).send({ error: (err as Error).message });
    }
    reply
      .header('content-type', 'application/gzip')
      .header('content-disposition', `attachment; filename="${backupFilename()}"`);
    return reply.send(backup.stream);
  });

  // WebSocket terminals (root shell + per-app shell), gated by settings + auth.
  registerTerminals(server);

  // File explorer download/upload (streaming, cookie-authenticated).
  registerFiles(server);

  // Live self-update over WebSocket (pull + recreate, streamed to the UI).
  registerUpdate(server);

  // Backup restore: upload (HTTP) + streamed restore (WebSocket).
  registerRestore(server);

  // Masjid logo upload/clear (admin, LAN-only; the public read is in the Fabric).
  registerBranding(server);

  // Catalog app updates streamed over a WebSocket (pull + recreate).
  registerAppUpdate(server);

  // LAN-only guard for the secret-gated Fabric routes, on the TLS listener too.
  // Nothing routes the tunnel at :443 today, so this is defence in depth — but a
  // single Cloudflare route pointed at https://localhost:443 would otherwise
  // publish /api/fabric/app/* (the app-to-app broker) and /api/auth/session to
  // the internet. The invariant is "these are LAN-only", not "LAN-only on the
  // listener we happen to expose", so both listeners carry the same guard.
  registerFabricTunnelGuard(server);

  // OpenMasjidOS Fabric: SSO cookie introspection + public appearance (optional).
  registerFabric(server);

  // Static UI + SPA fallback (api/static-ui.ts, so it can be tested directly).
  // In local dev the UI is served by Vite, so dist may not exist — the daemon
  // still has to boot.
  const haveUI = await registerStaticUI(server, UI_DIR);
  if (!haveUI) {
    log.warn(`UI build not found at ${UI_DIR} — serving API only (run the UI dev server).`);
  }

  // A plain-HTTP front door on PORT: answers the container health check, keeps the
  // Fabric API reachable over HTTP for app backends (which can't trust a
  // self-signed cert for server-to-server calls), and 308-redirects every other
  // request to the HTTPS dashboard. So browsers are forced to HTTPS while apps and
  // the healthcheck keep working — and a bare URL still leads somewhere.
  async function startHttpFront(): Promise<void> {
    const front = Fastify({ maxParamLength: 5000 });
    await front.register(fastifyCookie);
    // Path-based app ingress: omos.<domain>/donate → the Donations container, etc.
    // (one Cloudflare route → here, the OS routes each app by path). Hooks first.
    attachIngress(front);
    // LAN-only guard for the SECRET-GATED Fabric routes (incl. the app-to-app
    // broker at /api/fabric/app/*). App backends always call these server-to-server
    // over the LAN base URL, never through the public tunnel. The not-found handler
    // below 404s tunnel traffic to unknown paths, but REGISTERED routes skip it —
    // so this guard blocks tunnel-origin requests before they match. One shared
    // implementation (system/via-tunnel.ts) so the broker + ingress agree.
    registerFabricTunnelGuard(front);
    // Health and readiness are for the container healthcheck and the installer, both
    // of which reach us over loopback on the LAN. They are REGISTERED routes, so they
    // skip the notFoundHandler below that 404s tunnel traffic — which left
    // `{"status":"ok","version":"0.51.0"}` readable by anyone on the internet who
    // found the tunnel hostname. That is a free "which build is this masjid running,
    // and which advisories apply to it" lookup, so it gets the same LAN-only
    // treatment as the secret routes. Nothing real breaks: the Docker healthcheck
    // and `install.sh` both call loopback and send no `cf-ray`.
    front.get('/api/health', async (req, reply) => {
      if (isViaTunnel(req)) {
        noteRefusal(req.url, String(req.headers.host ?? ''), 'lan-only-route');
        return reply.code(404).send({ error: 'Not found.' });
      }
      return { status: 'ok', version: VERSION };
    });
    front.get('/api/ready', async (req, reply) => {
      if (isViaTunnel(req)) {
        noteRefusal(req.url, String(req.headers.host ?? ''), 'lan-only-route');
        return reply.code(404).send({ error: 'Not found.' });
      }
      return { ready: await dockerReachable() };
    });
    registerFabric(front);
    front.setNotFoundHandler((req, reply) => {
      // Traffic that arrived through the Cloudflare tunnel for a non-app path: don't
      // 308-redirect (it would loop the tunnel) and don't expose the dashboard —
      // just 404. The admin UI stays LAN-only; only app paths are public.
      //
      // Uses the SHARED detector, not a hand-rolled one. This line used to be its own
      // `x-forwarded-proto === 'https'` comparison, so the same listener classified
      // the same request two different ways — the Fabric guard robustly, this one
      // naively, missing `"HTTPS"`, `"https,http"` and a duplicated header (the exact
      // spellings `forwardedProtoIsHttps` exists to catch).
      if (isViaTunnel(req)) {
        const asked = String(req.headers.host ?? '');
        // An /api path here is a platform route being probed from outside; anything else
        // is a visitor at an address where no app is published. Both 404 identically to
        // the caller — only the record distinguishes them (see system/tunnel-refusals.ts).
        const raw = req.url.split('?')[0]!;
        noteRefusal(req.url, asked, raw.startsWith('/api') ? 'lan-only-route' : 'no-app-at-path');
        // A person typing an address deserves a sentence, not a JSON object. Deliberately
        // says nothing about what IS published here — the whole point of this guard is that
        // the internet learns nothing about this masjid's platform from a wrong address.
        if (req.method === 'GET' && String(req.headers.accept ?? '').includes('text/html')) {
          return reply
            .code(404)
            .type('text/html')
            .send(
              '<!doctype html><meta charset="utf-8">' +
                '<meta name="viewport" content="width=device-width,initial-scale=1">' +
                '<title>Page not found</title>' +
                '<div style="font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 1.5rem;color:#1f2937">' +
                '<h1 style="font-size:1.4rem;margin:0 0 .6rem">There is no page at this address</h1>' +
                '<p style="margin:0;color:#4b5563">Please check the address and try again. ' +
                'If someone gave you this link, ask them for the full one \u2014 pages here usually ' +
                'have something after the website name.</p></div>',
            );
        }
        return reply.code(404).send({ error: 'Not found.' });
      }
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

  // Watch installed apps and email/webhook the admin when one goes offline
  // (gated by the granular alert toggles). No-op until email/webhook is set up.
  startAlertMonitor();

  // Watch for a new core version + newer versions of installed apps, and raise the
  // core-update / app-update alerts the moment one is detected (gated by the matrix).
  startUpdateMonitor();

  // Watch each configured Stripe account for chargebacks and alert the admin (gated
  // by the matrix). No-op until a Stripe account is configured. The platform polls
  // rather than taking a webhook because a dispute belongs to the ACCOUNT that
  // several apps share, and because a webhook would need a public platform route.
  startStripeMonitor();

  // Notice when WhatsApp signs the masjid's phone out, hold the queue, and say so by
  // email and webhook. It probes a route that has to REACH WhatsApp rather than reading
  // OpenWA's cached session word — a session logged out at WhatsApp's end goes on
  // reporting 'ready', which is how an outage once went unnoticed with every message
  // recorded as sent. No-op until a phone has actually been linked.
  startWhatsAppMonitor();

  // Keep installed apps pointed at this machine's CURRENT address. Moving the box
  // to a new subnet used to leave every app calling the old IP forever, because
  // OPENMASJID_BASE_URL was resolved once at install and never revisited.
  startAddressMonitor();

  // Listen for admin commands sent to the masjid's WhatsApp number. No-op — it does
  // not even open a socket — until the feature is switched on AND someone is on the
  // authorised list AND a phone is linked. Outbound is untouched: replies go through
  // the one queue in notify/whatsapp.ts.
  setInboundHandler(handleInboundCommand);
  startWhatsAppInbound();

  // Bring back anything the send queue was holding when we last stopped. Without this a
  // message held by a cap or the warm-up ramp is destroyed by a restart, silently: the
  // caller was told 202 and there is nothing anywhere to contradict it. That was a real
  // masjid, accepted-and-never-delivered for over 24 hours.
  restoreWhatsAppQueue();

  // Cloudflare tunnel (remote access) — bring it up if the admin enabled it.
  // No-op until a token is set + enabled. Never blocks boot.
  // Only in the TLS topology: there the dashboard is on TLS_PORT and only app
  // paths are exposed on the tunnel-facing PORT. In the plain-HTTP fallback the
  // full dashboard sits on PORT, so starting the tunnel would expose the admin UI
  // to the internet — refuse and tell the admin instead.
  if (tls) {
    ensureCloudflared().catch((err) => log.error('Could not start the Cloudflare tunnel.', err));
  } else {
    log.warn(
      'Remote access (Cloudflare tunnel) not started: TLS is unavailable, so the tunnel would expose the dashboard. Restore TLS to enable remote access.',
    );
  }
}

main().catch((err) => {
  log.error('Fatal: the core failed to start.', err);
  process.exit(1);
});
