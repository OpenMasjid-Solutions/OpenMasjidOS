// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * OpenMasjidOS Fabric — the platform↔app integration layer (optional,
 * backwards-compatible). The Fabric is the unified appearance + single sign-on /
 * API that lets an installed app inherit the dashboard's look and (opt-in) share
 * its login:
 *
 *   GET /api/auth/session       — introspect the omos_session cookie so an app's
 *                                 BACKEND can share the dashboard login (SSO).
 *                                 Server→server only; NOT CORS-enabled, so a
 *                                 cross-origin page can't read another user's
 *                                 auth status. Bound to the calling app's identity.
 *   GET /api/public/appearance  — the dashboard's presentation prefs (theme,
 *                                 wallpaper, accent, lang) so an app can match
 *                                 the masjid's look. No masjid data, low
 *                                 sensitivity → public + CORS so an app's
 *                                 browser can poll it for live theme changes.
 *
 * Neither moves masjid/prayer data into the platform (CLAUDE.md §13).
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { COOKIE_NAME, getSessionUser } from '../auth/sessions';
import { findFabricApp, appDeclaresAlert } from '../apps/manager';
import { registerAppLink } from '../fabric/appLink';
import { sendNotification } from '../notify/notify';
import { sendEmail } from '../notify/email';
import {
  enqueue as enqueueWhatsApp,
  whatsappOutcome,
  gatewayStatus as whatsappStatus,
  outcomesInWindow,
  mediaProblem,
  MAX_MEDIA_BYTES,
  type OutgoingMedia,
} from '../notify/whatsapp';
import { suspectWindowsFor } from '../system/whatsapp-monitor';

/**
 * Body cap for the WhatsApp send route: 4 MB of JSON for a 2 MB image.
 *
 * Base64 inflates the bytes by 4/3, and the envelope (caption, group id, field names)
 * rides on top. Set per route rather than per server — see the handler.
 */
const FABRIC_WHATSAPP_BODY_LIMIT = 4 * 1024 * 1024;
import { listApprovedGroups, isApprovedGroup } from '../store/whatsapp';
import { deliverAlert } from '../notify/alerts';
import { getSettings } from '../settings/store';
import { getLogo, hasLogo } from '../store/branding';
import { listAccountsPublic, getAccountFull } from '../store/stripe';
import { appPublicUrl, appBasePath } from '../system/cloudflared';
import { log } from '../logger';
import { matchesSecretRoute, decodedPath, resolveDotSegments } from '../system/via-tunnel';

// Lightweight per-IP fixed-window limiter for the secret-gated Fabric routes,
// which are reachable without a session. It runs BEFORE any lookup so a flood of
// bad-secret requests can't tie up the event loop (security audit, defence-in-
// depth on top of the in-memory secret index).
const RATE_WINDOW_MS = 60_000;
/**
 * Two tiers, because the source IP is nearly useless as an identity here.
 *
 * Every installed app reaches the core through Docker's published port, so they all present
 * the SAME peer address (the bridge gateway, 172.17.0.1 — measured). A per-IP limiter is
 * therefore effectively a single global bucket that every app shares: one chatty or hostile
 * app could exhaust it and lock every other app out of email, WhatsApp and Stripe. That is a
 * cross-app denial of service, which is exactly what the Fabric's isolation is meant to
 * prevent.
 *
 * So: keep the coarse IP tier — it runs BEFORE any lookup, which is the property it was
 * added for (a flood of bad-secret requests must not tie up the event loop) — and add a
 * per-app tier once the caller is known, so one app's traffic cannot spend another's budget.
 */
const RATE_MAX = 600; // coarse per-IP ceiling: a shared bucket, so deliberately generous
const RATE_MAX_APP = 120; // per identified app per minute — the meaningful limit

/**
 * Read-only status polling gets its own, larger budget on its own counter.
 *
 * `GET /api/fabric/whatsapp/status/:id` is an in-memory array scan with no outbound effect;
 * `POST /api/fabric/whatsapp` messages a real phone and carries the ban risk the tight limit
 * exists for. Sharing one bucket priced them identically, so an app doing exactly what the
 * platform asks — record the id, poll for the outcome — spent its send allowance on reads and
 * was 429'd part-way through reconciling a roster run. Separate counter, so a polling burst
 * can never refuse a send, or the reverse.
 */
const RATE_MAX_APP_READ = 600;

/** Routes that only read bounded in-memory state. Kept explicit — an allow-list, not a verb test. */
const READ_ONLY_ROUTES = [
  '/api/fabric/whatsapp/suspect','/api/fabric/whatsapp/status/'];

/**
 * Does this request qualify for the larger read budget? Fails closed to the send budget.
 *
 * Two rules, because getting this wrong widens the limit that actually matters (§15: never a
 * raw-string `startsWith` on a URL in a security decision):
 *
 * 1. **GET only.** Every sending route is a POST, so a method check alone makes it impossible
 *    for a send to be priced as a read — this is the load-bearing half.
 * 2. **The raw AND decoded-and-dot-resolved spellings must both match.** Fastify dispatches on
 *    the resolved path, so `/api/fabric/whatsapp/status/..` resolves to the send route while
 *    the raw text still carries the `status/` prefix. Requiring both spellings to agree means
 *    a disagreement falls back to the tight budget rather than granting the loose one.
 */
function isReadOnlyFabricRoute(method: string, url: string): boolean {
  if (method.toUpperCase() !== 'GET') return false;
  const raw = (url.split('?')[0] ?? '').toLowerCase();
  const resolved = resolveDotSegments(decodedPath(url)).toLowerCase();
  return READ_ONLY_ROUTES.some((r) => raw.startsWith(r) && resolved.startsWith(r));
}
const fabricHits = new Map<string, { count: number; resetAt: number }>();

function hit(key: string, max: number): boolean {
  const now = Date.now();
  if (fabricHits.size > 5000) {
    for (const [k, w] of fabricHits) if (w.resetAt <= now) fabricHits.delete(k);
  }
  const w = fabricHits.get(key);
  if (!w || w.resetAt <= now) {
    fabricHits.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (w.count >= max) return false;
  w.count += 1;
  return true;
}

function fabricRateOk(ip: string): boolean {
  return hit(`ip:${ip}`, RATE_MAX);
}

export function registerFabric(server: FastifyInstance): void {
  /**
   * The per-app rate tier, applied centrally.
   *
   * One hook rather than a line in each of the twelve route handlers — same reasoning as
   * `registerFabricTunnelGuard`: a limit that has to be remembered at every call site is a
   * limit that will be missing from the thirteenth route. Resolving the caller here costs an
   * in-memory index lookup, which the route then repeats; that is cheap and worth it.
   *
   * A request whose secret resolves to no app falls through to the coarse per-IP tier in the
   * handler, which is the correct order: we must not spend an expensive lookup deciding
   * whether to rate-limit an unauthenticated flood.
   */
  server.addHook('onRequest', (req, reply, done) => {
    if (!matchesSecretRoute(req.url)) return done();
    const presented = req.headers['x-openmasjid-app-secret'];
    const app = findFabricApp(typeof presented === 'string' ? presented : null);
    if (app) {
      // Separate counter as well as a separate ceiling: sharing the key would let a
      // polling burst refuse a send even under the larger limit.
      const read = isReadOnlyFabricRoute(req.method, req.url);
      const key = read ? `appread:${app.id}` : `app:${app.id}`;
      if (!hit(key, read ? RATE_MAX_APP_READ : RATE_MAX_APP)) {
        return reply.code(429).send({ error: 'Too many requests.' });
      }
    }
    done();
  });

  // B1 — single sign-on introspection. Returns whether the omos_session cookie
  // ON THIS REQUEST is valid. It is the trust anchor (an app mints a signed-in
  // session from a `true`), so it FAILS CLOSED and is bound to the calling app's
  // identity: the app must present the per-app OPENMASJID_APP_SECRET it was issued
  // at install (header X-OpenMasjid-App-Secret). A valid user cookie alone is NOT
  // enough — that stops one installed app, which the browser also hands the shared
  // cookie, from validating (or impersonating) the session as another app. The
  // token is read ONLY from the cookie, never a query/header/body. Not CORS-enabled.
  server.get('/api/auth/session', async (req, reply) => {
    if (!fabricRateOk(req.ip)) return reply.code(429).send({ authenticated: false });
    const username = getSessionUser(req.cookies?.[COOKIE_NAME]);
    if (!username) return { authenticated: false };
    const presented = req.headers['x-openmasjid-app-secret'];
    const app = findFabricApp(typeof presented === 'string' ? presented : null);
    if (!app || !app.sso) {
      // Valid session, but the caller didn't prove a known SSO-capable identity.
      log.debug('SSO introspection denied: missing or unrecognised app secret.');
      return { authenticated: false };
    }
    log.info(`SSO introspection: app "${app.id}" validated a session.`);
    return { authenticated: true, username };
  });

  // Fabric notifications — an app relays a message to the admin's configured
  // webhook. Server→server (the app proves itself with its per-app secret); the
  // app never sees the webhook URL, and must hold the notify capability. The
  // platform owns the destination, so there is no SSRF vector from the app. Not
  // CORS-enabled.
  server.post('/api/fabric/notify', async (req, reply) => {
    if (!fabricRateOk(req.ip)) {
      return reply.code(429).send({ delivered: false, error: 'Too many requests.' });
    }
    const presented = req.headers['x-openmasjid-app-secret'];
    const app = findFabricApp(typeof presented === 'string' ? presented : null);
    if (!app || !app.notify) {
      return reply.code(403).send({ delivered: false, error: 'This app is not allowed to send notifications.' });
    }
    const body = (req.body ?? {}) as { title?: unknown; text?: unknown; level?: unknown };
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) {
      return reply.code(400).send({ delivered: false, error: 'A message ("text") is required.' });
    }
    const levels = ['info', 'success', 'warning', 'error'] as const;
    const level = (levels as readonly string[]).includes(String(body.level))
      ? (body.level as (typeof levels)[number])
      : 'info';
    const result = await sendNotification(
      { title: typeof body.title === 'string' ? body.title : undefined, text, level },
      app.id,
      app.name,
    );
    return reply.send(result);
  });

  // Fabric Stripe — an app fetches a NAMED Stripe account's keys that the admin
  // configured once in OS settings, so several apps share one account without
  // re-entering keys. Server→server: the app proves itself with its per-app
  // secret and must hold the `stripe` capability. Returns secret material, so it
  // is NOT CORS-enabled (no browser can read it cross-origin) and is rate-limited.
  // The app picks the account by the name the admin chose for it (its own install
  // setting); omitting it falls back to the only/first account.
  server.get('/api/fabric/stripe', async (req, reply) => {
    if (!fabricRateOk(req.ip)) return reply.code(429).send({ error: 'Too many requests.' });
    const presented = req.headers['x-openmasjid-app-secret'];
    const app = findFabricApp(typeof presented === 'string' ? presented : null);
    if (!app || !app.stripe) {
      return reply.code(403).send({ error: 'This app is not allowed to use Stripe.' });
    }
    const accounts = listAccountsPublic();
    if (accounts.length === 0) {
      return reply.code(404).send({ error: 'No Stripe account is configured in OpenMasjidOS yet.' });
    }
    const q = (req.query ?? {}) as { account?: unknown };
    const requested = typeof q.account === 'string' && q.account.trim() ? q.account.trim() : accounts[0].id;
    const acc = getAccountFull(requested);
    if (!acc) {
      return reply.code(404).send({ error: `No Stripe account named "${requested}".` });
    }
    log.info(`Fabric Stripe: app "${app.id}" fetched account "${acc.label}".`);
    return {
      id: acc.id,
      label: acc.label,
      publishableKey: acc.publishableKey,
      secretKey: acc.secretKey,
      webhookSecret: acc.webhookSecret,
    };
  });

  // Fabric Stripe accounts — the NON-secret list (id + label only) so an app can
  // render its OWN in-app account picker, then fetch the chosen account's keys via
  // GET /api/fabric/stripe?account=<id>. Capability-gated; no keys here.
  server.get('/api/fabric/stripe/accounts', async (req, reply) => {
    if (!fabricRateOk(req.ip)) return reply.code(429).send({ error: 'Too many requests.' });
    const presented = req.headers['x-openmasjid-app-secret'];
    const app = findFabricApp(typeof presented === 'string' ? presented : null);
    if (!app || !app.stripe) {
      return reply.code(403).send({ error: 'This app is not allowed to use Stripe.' });
    }
    return { accounts: listAccountsPublic().map((a) => ({ id: a.id, label: a.label })) };
  });

  // Fabric site — an app learns its PUBLIC URL (the admin's Cloudflare-tunnel
  // domain + the app's path) so it can build absolute links: Stripe success/cancel
  // URLs, webhook endpoints, QR codes. Server→server (per-app secret) + the
  // `domain` capability. No secrets, but kept off CORS for consistency — an app's
  // backend reads it. `publicUrl` is '' when remote access isn't enabled.
  server.get('/api/fabric/site', async (req, reply) => {
    if (!fabricRateOk(req.ip)) return reply.code(429).send({ error: 'Too many requests.' });
    const presented = req.headers['x-openmasjid-app-secret'];
    const app = findFabricApp(typeof presented === 'string' ? presented : null);
    if (!app || !app.domain) {
      return reply.code(403).send({ error: 'This app is not allowed to read site info.' });
    }
    const cf = getSettings().cloudflare;
    const enabled = cf.enabled && !!cf.domain;
    return {
      enabled,
      domain: enabled ? cf.domain : '',
      publicUrl: appPublicUrl(app.id),
      // The path the app is served under (= its id). The app should mount its
      // routes/assets under this base path so links resolve behind the tunnel.
      basePath: appBasePath(app.id),
    };
  });

  // A2 — public presentation prefs, readable cross-origin by apps. `logo` is the
  // path to the masjid logo (empty when none set); an app resolves it against the
  // same origin it fetched appearance from, so it can brand its own pages/receipts.
  const appearance = () => {
    const a = getSettings().appearance;
    return {
      v: 1,
      theme: a.theme,
      wallpaper: a.wallpaper,
      wallpaperImage: a.wallpaperImage,
      accent: a.accent,
      lang: a.lang,
      logo: hasLogo() ? '/api/public/logo' : '',
    };
  };
  server.get('/api/public/appearance', async (_req, reply) => {
    reply.header('access-control-allow-origin', '*');
    reply.header('cache-control', 'no-store');
    return appearance();
  });
  // Preflight (in case an app sends a non-simple request).
  server.options('/api/public/appearance', async (_req, reply) => {
    reply
      .header('access-control-allow-origin', '*')
      .header('access-control-allow-methods', 'GET, OPTIONS')
      .header('access-control-allow-headers', '*')
      .code(204)
      .send();
  });

  // The masjid logo itself — a low-sensitivity public asset (same class as
  // appearance), so it is CORS-open and, like appearance, intentionally reachable
  // over the tunnel: Slack/Discord fetch it from the internet as the webhook avatar,
  // and an app's public donor page embeds it. Raster only (see store/branding), so
  // there is no script-in-SVG vector. Short cache so a logo change propagates.
  /**
   * The icons a browser or phone fetches from the ROOT on its own.
   *
   * A masjid serves its apps under paths (`/donate`), so nothing is published at the root
   * and every one of these 404'd. Harmless but not free: adding the site to a phone's home
   * screen produced a blank icon, and the refusal log filled with them.
   *
   * Served from the masjid's own logo, which is ALREADY intentionally public over the
   * tunnel (`/api/public/logo`, CLAUDE.md §15) — so this publishes nothing that was not
   * public a moment ago. Raster only, for the same reason the logo is: no SVG script
   * vector. A masjid with no logo set still gets a clean 404 rather than a broken image.
   */
  const rootIcon = async (_req: unknown, reply: FastifyReply) => {
    const logo = getLogo();
    if (!logo) return reply.code(404).header('cache-control', 'no-store').send({ error: 'Not found.' });
    reply.header('access-control-allow-origin', '*');
    reply.header('cache-control', 'public, max-age=300');
    reply.type(logo.mime);
    return reply.send(logo.buf);
  };
  for (const p of [
    '/favicon.ico',
    '/apple-touch-icon.png',
    '/apple-touch-icon-precomposed.png',
  ]) {
    server.get(p, rootIcon);
  }

  server.get('/api/public/logo', async (_req, reply) => {
    reply.header('access-control-allow-origin', '*');
    const logo = getLogo();
    if (!logo) return reply.code(404).header('cache-control', 'no-store').send({ error: 'No logo set.' });
    reply.header('cache-control', 'public, max-age=300');
    reply.type(logo.mime);
    return reply.send(logo.buf);
  });

  // Fabric email — an app sends an email (donation receipt, parent notice, …) via
  // the admin-configured provider (SMTP/Resend). Server→server: the app proves
  // itself with its per-app secret and must hold the `email` capability. The app
  // never sees the mail credentials or the From address. Not CORS-enabled.
  server.post('/api/fabric/email', async (req, reply) => {
    if (!fabricRateOk(req.ip)) return reply.code(429).send({ sent: false, error: 'Too many requests.' });
    const presented = req.headers['x-openmasjid-app-secret'];
    const app = findFabricApp(typeof presented === 'string' ? presented : null);
    if (!app || !app.email) {
      return reply.code(403).send({ sent: false, error: 'This app is not allowed to send email.' });
    }
    const body = (req.body ?? {}) as { to?: unknown; subject?: unknown; text?: unknown; html?: unknown };
    const to = typeof body.to === 'string' ? body.to : '';
    const subject = typeof body.subject === 'string' ? body.subject : '';
    const text = typeof body.text === 'string' ? body.text : '';
    const html = typeof body.html === 'string' ? body.html : undefined;
    if (!to || !subject || (!text && !html)) {
      return reply.code(400).send({ sent: false, error: 'A "to", "subject", and "text" (or "html") are required.' });
    }
    const result = await sendEmail({ to, subject, text, html }, app.id);
    return reply.send(result);
  });

  // Fabric WhatsApp — an app sends a WhatsApp message (a fee reminder to a parent, a
  // class notice) through the admin's own OpenWA gateway. Requires the `whatsapp`
  // capability. The app never sees the gateway URL or its API key, and never talks to
  // WhatsApp itself — which is the point: the anti-ban pacing belongs to the NUMBER,
  // so it has to be enforced in one place for every caller at once.
  //
  // This QUEUES. It does not send. Human pacing puts delivery seconds to minutes away,
  // and a cap can defer it, so `{queued: true}` is the honest answer
  // and no app may treat it as delivery. Nothing auth-critical (a login code, a
  // one-time password) may depend on this — say so to app authors, loudly, in
  // docs/WHATSAPP.md.
  /**
   * Can this masjid send WhatsApp at all?
   *
   * An app needs this to build a settings page honestly: without it, "WhatsApp
   * reminders" is a switch that looks available on every install and silently fails on
   * the ones where no gateway was ever set up — and the failure only shows when a real
   * reminder was due. It also distinguishes "not set up" from "set up but no phone
   * linked yet", which have completely different fixes and are not the app's to make.
   *
   * Deliberately a tiny, stable vocabulary rather than the internal session enum: an app
   * should render one of four sentences, not track OpenWA's lifecycle. No credentials, no
   * gateway address, no phone number — LAN-only under /api/fabric like the rest.
   */
  server.get('/api/fabric/whatsapp', async (req, reply) => {
    if (!fabricRateOk(req.ip)) return reply.code(429).send({ available: false, reason: 'unknown' });
    const presented = req.headers['x-openmasjid-app-secret'];
    const app = findFabricApp(typeof presented === 'string' ? presented : null);
    if (!app || !app.whatsapp) {
      return reply.code(403).send({ available: false, reason: 'not-allowed' });
    }
    const s = await whatsappStatus();
    const reason =
      s.state === 'ready'
        ? 'ready'
        : s.state === 'unconfigured'
          ? 'not-configured'
          : s.state === 'pending' || s.state === 'no-session'
            ? 'not-linked'
            : 'unreachable';
    // `media` tells an app whether it can send an IMAGE before it renders a poster and
    // base64s half a megabyte into a request that was never going to work. An older
    // platform omits the field entirely, and an app must read that absence as false.
    return reply.send({
      available: reason === 'ready',
      reason,
      media: reason === 'ready',
      maxMediaBytes: MAX_MEDIA_BYTES,
      // `outcomes` says this platform can tell you what became of a queued message
      // (GET /api/fabric/whatsapp/status/:id). Absent means false, as with `media`.
      outcomes: true,
    });
  });

  /**
   * What became of a message this app queued.
   *
   * Exists because `202 {queued:true}` was the end of the story: an app recorded that it
   * had handed a message over and there was nothing, anywhere, that could contradict it.
   * That is what made a real 24-hour non-delivery undiagnosable from the app's side.
   *
   * Scoped to the CALLER's own messages — an id belonging to another app answers 404, the
   * same as an unknown id, so this cannot be used to observe another app's traffic. Holds
   * no message text and no recipient.
   */
  /**
   * Windows in which this app's messages were reported sent but may never have arrived.
   *
   * Between a WhatsApp session dying and the platform noticing, OpenWA accepts messages and
   * returns 2xx, so the platform records them `sent` — and the body is deleted at that
   * moment, by design. Those are unrecoverable HERE. The app, however, still has its own
   * source data, so the useful thing the platform can do is say WHEN it was blind and how
   * many of this app's messages fell in it.
   *
   * Additive and read-only: an app that does not know about this route is unaffected, and
   * nothing about the existing `/status/:id` response has changed. Scoped to the caller's
   * own `source`, so it cannot become a way to observe another app's traffic — the same
   * rule the per-id route follows.
   */
  server.get('/api/fabric/whatsapp/suspect', async (req, reply) => {
    if (!fabricRateOk(req.ip)) return reply.code(429).send({ error: 'Too many requests.' });
    const presented = req.headers['x-openmasjid-app-secret'];
    const app = findFabricApp(typeof presented === 'string' ? presented : null);
    if (!app || !app.whatsapp) return reply.code(403).send({ error: 'This app is not allowed to use WhatsApp.' });
    // Retained for a week AFTER recovery, not only while the link is down. The first cut
    // answered only during an outage, and relinking clears that — so the evidence vanished
    // at the exact moment an app went looking for what it had missed. Reported by Kiosk.
    //
    // `ok` is stated explicitly so a caller that does not check the status code cannot read
    // a 403 or 429 body as an all-clear (the trap Students pointed out on /groups).
    return reply.send({ ok: true, windows: suspectWindowsFor(app.id) });
  });

  server.get<{ Params: { id: string } }>('/api/fabric/whatsapp/status/:id', async (req, reply) => {
    if (!fabricRateOk(req.ip)) return reply.code(429).send({ error: 'Too many requests.' });
    const presented = req.headers['x-openmasjid-app-secret'];
    const app = findFabricApp(typeof presented === 'string' ? presented : null);
    if (!app || !app.whatsapp) return reply.code(403).send({ error: 'This app is not allowed to use WhatsApp.' });
    const rec = whatsappOutcome(String(req.params.id ?? ''), app.id);
    if (!rec) return reply.code(404).send({ error: 'No such message.' });
    return reply.send({ id: rec.id, state: rec.state, reason: rec.reason, at: rec.at, target: rec.targetKind });
  });

  /**
   * The groups this app may post into — the ones the ADMIN approved, and nothing else.
   *
   * The raw OpenWA group list must never cross this boundary: it contains every group the
   * masjid's number belongs to, including the imam's family chat and whatever else that
   * phone is in. An app sees only what an admin deliberately put in front of it, and only
   * ever a label and an opaque id.
   */
  server.get('/api/fabric/whatsapp/groups', async (req, reply) => {
    // An `error` field on the 429, because `{groups: []}` alone is indistinguishable from
    // "you have no approved groups" to a caller that does not check the status code — and
    // the Students app pointed out that this route is the precedent other consumers copy.
    if (!fabricRateOk(req.ip)) return reply.code(429).send({ groups: [], error: 'Too many requests.' });
    const presented = req.headers['x-openmasjid-app-secret'];
    const app = findFabricApp(typeof presented === 'string' ? presented : null);
    if (!app || !app.whatsapp) {
      return reply.code(403).send({ groups: [], error: 'This app is not allowed to send WhatsApp messages.' });
    }
    return reply.send({ groups: listApprovedGroups().map((g) => ({ id: g.id, label: g.label })) });
  });

  server.post(
    '/api/fabric/whatsapp',
    {
      // THE ROUTE, not the instance. This handler is registered on BOTH servers, and they
      // do not agree: the dashboard allows 25 MB while the HTTP front door — which is
      // exactly what an app reaches over OPENMASJID_BASE_URL — was left on Fastify's 1 MB
      // default. A base64 poster lands around 200–550 KB, so it fits today and a slightly
      // larger one would have failed on one server and not the other. Setting it per
      // route makes both correct without raising the ceiling for every other front-door
      // route (the tunnel ingress among them).
      //
      // 4 MB of JSON for a 2 MB image: base64 is 4/3 the bytes, plus the envelope.
      bodyLimit: FABRIC_WHATSAPP_BODY_LIMIT,
      // Fastify's own 413 says "Request body is too large" and never names the limit,
      // which leaves an app author guessing how much to shrink a poster by. Scoped to
      // this route, so nothing else's error handling changes.
      errorHandler: (err, _req, reply) => {
        if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || err.statusCode === 413) {
          return reply.code(413).send({
            queued: false,
            error:
              `That request is too large. Images may be up to ${MAX_MEDIA_BYTES / 1024 / 1024} MB ` +
              `(the whole request, base64 included, is capped at ${FABRIC_WHATSAPP_BODY_LIMIT / 1024 / 1024} MB).`,
          });
        }
        // Anything else keeps Fastify's behaviour — and the body is never echoed back,
        // because it holds the caption and the image.
        return reply.code(err.statusCode ?? 500).send({ queued: false, error: 'That request could not be read.' });
      },
    },
    async (req, reply) => {
      if (!fabricRateOk(req.ip)) return reply.code(429).send({ queued: false, error: 'Too many requests.' });
      const presented = req.headers['x-openmasjid-app-secret'];
      const app = findFabricApp(typeof presented === 'string' ? presented : null);
      if (!app || !app.whatsapp) {
        return reply.code(403).send({ queued: false, error: 'This app is not allowed to send WhatsApp messages.' });
      }
      const body = (req.body ?? {}) as { to?: unknown; text?: unknown; group?: unknown; media?: unknown };
      // A single recipient per call, deliberately. Accepting an array would invite an app
      // to hand over a thousand numbers in one request, and the shape of the API is the
      // first place to discourage a blast — the queue would pace it, but the app author
      // should be thinking one-parent-at-a-time.
      const to = typeof body.to === 'string' ? body.to : '';
      const group = typeof body.group === 'string' ? body.group : '';
      const text = typeof body.text === 'string' ? body.text : '';

      // An optional image. `text` becomes its caption, and may be omitted entirely — a
      // poster can speak for itself.
      let media: OutgoingMedia | undefined;
      if (body.media != null) {
        const m = body.media as { data?: unknown; mimeType?: unknown; filename?: unknown };
        if (typeof m.data !== 'string' || typeof m.mimeType !== 'string') {
          return reply
            .code(400)
            .send({ queued: false, error: '"media" needs "data" (base64) and "mimeType".' });
        }
        media = {
          data: m.data,
          mimeType: m.mimeType,
          ...(typeof m.filename === 'string' ? { filename: m.filename } : {}),
        };
        const problem = mediaProblem(media);
        // 413 for "too big", 400 for "wrong shape" — an app retrying a 413 with the same
        // bytes is wasting its time, and the status should say so.
        if (problem) {
          const tooBig = problem.includes('the limit is');
          return reply.code(tooBig ? 413 : 400).send({ queued: false, error: problem });
        }
      }

      if ((!text.trim() && !media) || Boolean(to) === Boolean(group)) {
        return reply.code(400).send({
          queued: false,
          error: 'Send "text" (or "media") to either a "to" (phone number) or a "group", not both.',
        });
      }
      // An unapproved group is a 403, not a 400: it is an authorisation answer, and saying
      // "bad request" would send an app author looking for a typo in their payload.
      if (group && !isApprovedGroup(group)) {
        return reply
          .code(403)
          .send({ queued: false, error: 'That group has not been approved for sending in OpenMasjidOS.' });
      }
      const result = enqueueWhatsApp(
        group ? { groupId: group, text, media, source: app.id } : { to, text, media, source: app.id },
      );
      // 202: accepted for later delivery, which is exactly what happened. The body now
      // also carries an `id` the app can poll — see /api/fabric/whatsapp/status/:id.
      return reply.code(result.queued ? 202 : 400).send(result);
    },
  );

  // Fabric alert — an app raises an admin alert (a camera/reader offline, a failed
  // payment, …). Requires the `notify` capability AND the alert id must be one the
  // app declared in its manifest. The platform gates on the admin's granular on/off
  // for that alert, then delivers to the admin email + the webhook. Not CORS-enabled.
  server.post('/api/fabric/alert', async (req, reply) => {
    if (!fabricRateOk(req.ip)) return reply.code(429).send({ delivered: false, error: 'Too many requests.' });
    const presented = req.headers['x-openmasjid-app-secret'];
    const app = findFabricApp(typeof presented === 'string' ? presented : null);
    // Declaring the alert in the manifest IS the opt-in (it issues the secret), so
    // authorize on the declaration below rather than a separate capability.
    if (!app) {
      return reply.code(403).send({ delivered: false, error: 'This app is not allowed to send alerts.' });
    }
    const body = (req.body ?? {}) as { alert?: unknown; title?: unknown; text?: unknown; level?: unknown };
    const alertId = typeof body.alert === 'string' ? body.alert : '';
    const text = typeof body.text === 'string' ? body.text : '';
    if (!alertId || !text.trim()) {
      return reply.code(400).send({ delivered: false, error: 'An "alert" (id) and "text" are required.' });
    }
    if (!appDeclaresAlert(app.id, alertId)) {
      return reply.code(400).send({ delivered: false, error: `Unknown alert "${alertId}" — declare it in your manifest's "alerts" list.` });
    }
    const levels = ['info', 'success', 'warning', 'error'] as const;
    const level = (levels as readonly string[]).includes(String(body.level))
      ? (body.level as (typeof levels)[number])
      : 'warning';
    const result = await deliverAlert({
      source: app.id,
      sourceName: app.name,
      alertId,
      title: typeof body.title === 'string' ? body.title : undefined,
      text,
      level,
    });
    return reply.send(result);
  });

  // App-to-app broker (POST /api/fabric/app/:target/:capability/:method). Under
  // /api/fabric, so it inherits the LAN-only viaTunnel guard automatically.
  registerAppLink(server);
}
