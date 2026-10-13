// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Daemon entry point. Two listeners:
 *   - the DASHBOARD, over HTTPS on TLS_PORT: tRPC over HTTP and WebSocket at /trpc, the
 *     dashboard's own /api routes (updates, files, terminals, backup, restore, logo) and
 *     the built React UI, with SPA fallback to index.html;
 *   - the FRONT DOOR, plain HTTP on PORT: health and readiness, the LAN-only Fabric routes
 *     apps call, a redirect to the dashboard for browsers, apps served by path (the
 *     ingress) — and, when remote administration is on, the gate that hands the remote
 *     dashboard's requests to the dashboard listener (system/remote-admin.ts).
 * With no usable certificate the dashboard falls back to plain HTTP on PORT alone.
 */
import fs from 'node:fs';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
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
import { remoteBackupDownload, sendBackup } from './api/backup-download';
import { removeRestoreLeftovers } from './system/restore';
import { startBackupScheduler } from './system/backup-upload';
import { ensureCloudflared } from './system/cloudflared';
import { answerBareWorkerFetch, attachIngress, declinedReason, isBareAppAddress, isWorkerScriptFetch } from './system/ingress';
import { notFoundReason, refuseOverTunnel } from './system/tunnel-refusals';
import { registerFabricTunnelGuard, registerOriginFormGuard, isViaTunnel, urlHasPrefix } from './system/via-tunnel';
import { registerStaticUI } from './api/static-ui';
import {
  anonymousBodyRefusal,
  appHostname,
  claimsDashboardSocket,
  DASHBOARD_WS_MAX_PAYLOAD,
  startDashboardHeartbeat,
  frontDoorDecision,
  hasRemoteSession,
  markHandedOver,
  registerDashboardRequestLimits,
  registerHandoffOnlyGuard,
  remoteAdminEnabled,
  wasHandedOver,
} from './system/remote-admin';
import { trackHandedOverSocket } from './system/remote-sockets';
import { registerAppOpen } from './system/app-access';
import { adoptLegacyEmailBinding } from './auth/twofactor';
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
import { requestCsrfOk, requestUser } from './api/ws-auth';
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
  // An archive and a staging copy a restore never got to remove (system/restore.ts).
  removeRestoreLeftovers();
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

  // Emailed sign-in codes switched on before they were bound to an address get bound
  // to where they go now (auth/twofactor.ts says why the binding exists).
  try {
    adoptLegacyEmailBinding();
  } catch (err) {
    log.warn('Could not record where emailed sign-in codes go.', err);
  }

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
    // clearing `tls` also keeps the tunnel refused (in this fallback the whole dashboard
    // sits on the tunnel-facing port, unguarded) and routes us down the HTTP branch below.
    log.error(
      'Could not start the HTTPS listener — falling back to plain HTTP so the dashboard stays reachable. Regenerate the certificate in Settings → Security.',
      err,
    );
    tls = null;
    server = buildServer(null);
  }

  // First hook of all: every guard below reads the request target as a path.
  registerOriginFormGuard(server);
  // Cloudflare traffic is answered here ONLY when the front door handed it over —
  // a tunnel pointed at this port by mistake must not walk round the gate.
  registerHandoffOnlyGuard(server);
  // tRPC takes JSON only, and a remote stranger's body is counted as it arrives —
  // both close ways for anyone who can reach the sign-in page to make this process
  // read an unbounded body into memory (system/remote-admin.ts says how).
  registerDashboardRequestLimits(server);
  await server.register(fastifyCookie);
  // Small frames only: the dashboard never sends a big message over a socket, and the
  // library default (100 MB) let any socket make the daemon buffer and parse that much
  // per message (system/remote-admin.ts DASHBOARD_WS_MAX_PAYLOAD).
  await server.register(fastifyWebsocket, { options: { maxPayload: DASHBOARD_WS_MAX_PAYLOAD } });
  // And a ping on every one of them, or Cloudflare closes a quiet remote terminal
  // (system/remote-admin.ts DASHBOARD_WS_HEARTBEAT_MS).
  startDashboardHeartbeat(server.websocketServer);
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
  server.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    if (!reply.getHeader('content-security-policy')) {
      reply.header('Content-Security-Policy', "frame-ancestors 'self'");
    }
    // Nothing the remote dashboard sends is for Cloudflare to keep. Its edge caches
    // by address alone, and some of these addresses end in .pdf or .png — a file
    // downloaded from the File Explorer would otherwise be served to the next person
    // to ask for the same address. The admin's own browser may still cache as usual.
    if (wasHandedOver(req.raw)) {
      reply.header('cdn-cache-control', 'no-store');
      reply.header('cloudflare-cdn-cache-control', 'no-store');
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
    if (isViaTunnel(req)) return refuseOverTunnel(req, reply, 'lan-only-route');
    return { status: 'ok', version: VERSION };
  });

  server.get('/api/ready', async (req, reply) => {
    if (isViaTunnel(req)) return refuseOverTunnel(req, reply, 'lan-only-route');
    return { ready: await dockerReachable() };
  });

  // Backup download — a gzipped tar of platform config + app data. Authenticated
  // by the session cookie directly (it's a browser download, not a tRPC call).
  server.get('/api/backup', async (req, reply) => {
    if (!isAllowedOrigin(req)) return reply.code(403).send({ error: 'Bad origin.' });
    if (!requestUser(req)) {
      return reply.code(401).send({ error: 'Please sign in.' });
    }
    // The download URL is a plain <a href> (no header), so the dashboard key
    // rides in ?k= — an app that captured the cookie can't forge it.
    if (!requestCsrfOk(req)) return reply.code(403).send({ error: 'This request came from an unexpected place.' });
    if (wasHandedOver(req.raw)) return remoteBackupDownload(reply);
    // Listen for the browser leaving BEFORE the backup is made: copying the app data can
    // take minutes, and a 'close' that fires during them does not fire again
    // (api/backup-download.ts `sendBackup` says what a missed one costs).
    let gone = false;
    reply.raw.once('close', () => {
      gone = true;
    });
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
    if (gone) {
      backup.stream.destroy(); // nobody to send it to: end tar, which clears the flag
      reply.hijack();
      return;
    }
    // Ended only once tar has said it succeeded (api/backup-download.ts `sendBackup`):
    // `reply.send(stream)` ended with tar's output, which comes BEFORE tar's verdict, so a
    // failed backup arrived as a clean, complete-looking file.
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'application/gzip',
      'content-disposition': `attachment; filename="${backupFilename()}"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    });
    sendBackup(reply.raw, backup);
  });

  // WebSocket terminals (root shell + per-app shell), gated by settings + auth.
  registerTerminals(server);

  // File explorer download/upload (streaming, cookie-authenticated).
  registerFiles(server);

  // Live self-update over WebSocket (pull + recreate, streamed to the UI).
  registerUpdate(server);

  // Backup restore: upload (HTTP) + streamed restore (WebSocket).
  registerRestore(server);

  // Masjid logo upload/clear (admin only — from outside, only through remote
  // administration's hand-over; the public read is in the Fabric).
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
    // NOTE ON `bodyLimit`: Fastify's 1 MB default here applies only to this
    // listener's OWN routes — the Fabric API, which carries JSON from app backends
    // (the WhatsApp image route sets its own). Remote dashboard traffic never reaches
    // this listener's body parser: the gate below hands it, unread, to the dashboard
    // listener, whose limits apply exactly as they do on the LAN.
    const front = Fastify({ maxParamLength: 5000 });
    // First hook of all, before the ingress and every guard: each reads the request
    // target as a path, and a target that is not one walked past them.
    registerOriginFormGuard(front);
    await front.register(fastifyCookie);
    // Path-based app ingress: omos.<domain>/donate → the Donations container, etc.
    // (one Cloudflare route → here, the OS routes each app by path). Hooks first.
    //
    // `claimUpgrade` is the ONLY way a non-app WebSocket survives this listener,
    // and it is deliberately narrow: the dashboard's own sockets, over the tunnel,
    // while remote administration is on, for a signed-in remote session only
    // (system/remote-admin.ts DASHBOARD_SOCKETS, `claimsDashboardSocket`).
    // Anything wider abandons sockets that nothing will answer (system/ingress.ts
    // says why that matters).
    //
    // A claimed socket is HANDED to the dashboard listener — its own upgrade event,
    // where @fastify/websocket and every route's own checks deal with it exactly as
    // on the LAN. @fastify/websocket is never registered HERE: it claims every
    // upgrade on its server, which broke every app's WebSocket over the tunnel
    // (dev.13–14; system/ingress.ts `claimUpgrade` says how).
    attachIngress(front, {
      claimUpgrade: (req, socket, head) => {
        // The SAME decision the HTTP gate makes (system/remote-admin.ts says why).
        // Declining is not "leave it": the ingress destroys anything not claimed.
        const ok = claimsDashboardSocket(req.url ?? '', req.headers, {
          remoteAdminEnabled: remoteAdminEnabled(),
          appsHost: appHostname(),
        });
        if (!ok) return false;
        // Recorded, so it is closed the moment the door shuts or its session ends
        // (system/remote-sockets.ts — a socket outlives the check made at its start); a
        // full table refuses it like any other. Then marked, so every route behind it
        // re-checks the door on every use.
        if (!trackHandedOverSocket(req, socket)) return false;
        markHandedOver(req);
        server.server.emit('upgrade', req, socket, head);
        return true;
      },
    });
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
      if (isViaTunnel(req)) return refuseOverTunnel(req, reply, 'lan-only-route');
      return { status: 'ok', version: VERSION };
    });
    front.get('/api/ready', async (req, reply) => {
      if (isViaTunnel(req)) return refuseOverTunnel(req, reply, 'lan-only-route');
      return { ready: await dockerReachable() };
    });
    registerFabric(front);
    // Opening an app from the remote dashboard: spends a one-use ticket on the apps'
    // hostname and hands the browser that app's access token (system/app-access.ts).
    registerAppOpen(front);

    // ── Remote administration: the dashboard over the tunnel ─────────────────
    //
    // THIS LISTENER DOES NOT SERVE THE DASHBOARD. It decides, and hands over.
    // A permitted remote request goes, unread, to the DASHBOARD listener — the one
    // the LAN uses — as its own request event. So every part of the dashboard works
    // remotely the moment it works on the LAN: the File Explorer, terminals,
    // backups, restore, updates, the logo upload, with the same routes, the same
    // limits and the same checks, and no second copy of any of them to drift.
    //
    // The first version registered tRPC and the built UI on THIS listener instead.
    // That was a second copy of the dashboard, and only part of one: everything
    // under /api stayed behind on the LAN listener, which is why "remote access"
    // could look at the dashboard but not update an app or open a file.
    //
    // The gate is an onRequest hook, added AFTER the Fabric guard so that guard
    // still wins, and it answers every case itself rather than hoping something
    // downstream does.
    //
    // Both no-change cases are preserved exactly:
    //   - LAN traffic on this plain-HTTP port still 308s to the HTTPS dashboard,
    //     so nothing starts serving the admin UI over unencrypted HTTP on the
    //     masjid's own network;
    //   - tunnel traffic with the feature off still 404s AND still records a
    //     refusal, so "Recently turned away" keeps working.
    /** 308 a browser to the HTTPS dashboard. Shared, because two places need it
     *  and they must not drift. */
    const toHttps = (req: FastifyRequest, reply: FastifyReply) => {
      const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
      if (!host) return reply.code(400).send({ error: 'Bad request.' });
      const target = TLS_PORT === 443 ? host : `${host}:${TLS_PORT}`;
      return reply.code(308).redirect(`https://${target}${req.url}`);
    };

    front.addHook('onRequest', (req, reply, done) => {
      // ONE pure decision, shared with the tests (system/remote-admin.ts says why the
      // first version's hand-built test copy could not be trusted).
      const d = frontDoorDecision(req.url, req.headers, {
        viaTunnel: isViaTunnel(req),
        remoteAdminEnabled: remoteAdminEnabled(),
        appsHost: appHostname(),
      });
      switch (d.kind) {
        case 'pass':
          return done();
        case 'serve': {
          // A stranger may send a sign-in and a code, and nothing larger: refused here,
          // unread, when the body says up front that it is bigger than that.
          const tooBig = hasRemoteSession(req.headers) ? null : anonymousBodyRefusal(req.headers);
          if (tooBig) return reply.code(tooBig).send({ error: 'That request is too large.' });
          // Hand the request to the dashboard listener, body unread. Its own hooks run
          // on it exactly as on the LAN — the request-target guard, the Fabric guard,
          // the origin check — and every route behind them accepts only a session that
          // passed the second factor, because the request still carries Cloudflare's
          // headers (auth/sessions.ts getSessionUserFor). Marked first, because that
          // mark is how the dashboard listener knows the gate let it in.
          markHandedOver(req.raw);
          reply.hijack();
          server.server.emit('request', req.raw, reply.raw);
          return;
        }
        case 'lan-https':
          // LAN, on the plain-HTTP front door. REDIRECT HERE, do not fall through.
          //
          // This used to fall through, on the reasoning that the not-found handler
          // below would redirect it — true until this listener started registering
          // the dashboard's own routes. A REGISTERED route skips the not-found
          // handler, so `GET /` matched @fastify/static and was served index.html
          // over plain HTTP on the masjid's LAN. A smoke test against the real
          // daemon found it; the unit tests' copy of this gate had no static route.
          return toHttps(req, reply);
        case 'upgrade':
          // A tunnel visitor on plain http:// is upgraded, never served in clear.
          return reply.code(308).redirect(d.to);
        case 'refuse':
          return refuseOverTunnel(req, reply, d.reason);
      }
    });

    // The security headers the TLS listener sets, on this listener's own answers —
    // its refusals and redirects. The dashboard's responses come from the dashboard
    // listener, which sets them itself.
    front.addHook('onSend', async (_req, reply, payload) => {
      reply.header('X-Frame-Options', 'SAMEORIGIN');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Referrer-Policy', 'no-referrer');
      if (!reply.getHeader('content-security-policy')) {
        reply.header('Content-Security-Policy', "frame-ancestors 'self'");
      }
      return payload;
    });

    front.setNotFoundHandler((req, reply) => {
      // A service worker's script asked for at a bare address gets the worker that removes
      // itself — here as at a shared app's (system/ingress.ts SELF_REMOVING_WORKER), so a
      // private app's address, or one with nothing at it, answers exactly the same.
      if (isBareAppAddress(req.url) && isWorkerScriptFetch(req.headers)) {
        return answerBareWorkerFetch(req, reply, { record: isViaTunnel(req) });
      }
      // Traffic that arrived through the Cloudflare tunnel for something nothing here
      // serves: don't 308-redirect (it would loop the tunnel) — refuse, with the one
      // response every refusal sends (system/tunnel-refusals.ts).
      //
      // Uses the SHARED detector, not a hand-rolled one. This line used to be its own
      // `x-forwarded-proto === 'https'` comparison, so the same listener classified
      // the same request two different ways — the Fabric guard robustly, this one
      // naively, missing `"HTTPS"`, `"https,http"` and a duplicated header (the exact
      // spellings `forwardedProtoIsHttps` exists to catch).
      if (isViaTunnel(req)) {
        // Only the record tells these apart: an app that is installed but not shared
        // online, a platform route probed from outside, or an address with nothing at
        // it. The caller gets the same answer
        // for all of them.
        return refuseOverTunnel(req, reply, notFoundReason(req.url, declinedReason(req.raw)));
      }
      return toHttps(req, reply);
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
  // Only in the TLS topology: there the dashboard is on TLS_PORT, and the tunnel-facing
  // PORT serves app paths and — only through remote administration's gate — hands the
  // dashboard over. In the plain-HTTP fallback the full dashboard sits on PORT itself,
  // so starting the tunnel would expose the admin UI with no gate at all — refuse and
  // tell the admin instead.
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
