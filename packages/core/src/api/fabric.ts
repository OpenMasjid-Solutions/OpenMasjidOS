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
import type { FastifyInstance } from 'fastify';
import { COOKIE_NAME, getSessionUser } from '../auth/sessions';
import { findFabricApp, appDeclaresAlert } from '../apps/manager';
import { registerAppLink } from '../fabric/appLink';
import { sendNotification } from '../notify/notify';
import { sendEmail } from '../notify/email';
import { enqueue as enqueueWhatsApp, gatewayStatus as whatsappStatus } from '../notify/whatsapp';
import { listApprovedGroups, isApprovedGroup } from '../store/whatsapp';
import { deliverAlert } from '../notify/alerts';
import { getSettings } from '../settings/store';
import { getLogo, hasLogo } from '../store/branding';
import { listAccountsPublic, getAccountFull } from '../store/stripe';
import { appPublicUrl, appBasePath } from '../system/cloudflared';
import { log } from '../logger';

// Lightweight per-IP fixed-window limiter for the secret-gated Fabric routes,
// which are reachable without a session. It runs BEFORE any lookup so a flood of
// bad-secret requests can't tie up the event loop (security audit, defence-in-
// depth on top of the in-memory secret index).
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120; // requests per IP per minute across the Fabric routes
const fabricHits = new Map<string, { count: number; resetAt: number }>();

function fabricRateOk(ip: string): boolean {
  const now = Date.now();
  if (fabricHits.size > 5000) {
    for (const [k, w] of fabricHits) if (w.resetAt <= now) fabricHits.delete(k);
  }
  const w = fabricHits.get(ip);
  if (!w || w.resetAt <= now) {
    fabricHits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (w.count >= RATE_MAX) return false;
  w.count += 1;
  return true;
}

export function registerFabric(server: FastifyInstance): void {
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
  // and quiet hours can defer it for hours, so `{queued: true}` is the honest answer
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
    return reply.send({ available: reason === 'ready', reason });
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
    if (!fabricRateOk(req.ip)) return reply.code(429).send({ groups: [] });
    const presented = req.headers['x-openmasjid-app-secret'];
    const app = findFabricApp(typeof presented === 'string' ? presented : null);
    if (!app || !app.whatsapp) {
      return reply.code(403).send({ groups: [], error: 'This app is not allowed to send WhatsApp messages.' });
    }
    return reply.send({ groups: listApprovedGroups().map((g) => ({ id: g.id, label: g.label })) });
  });

  server.post('/api/fabric/whatsapp', async (req, reply) => {
    if (!fabricRateOk(req.ip)) return reply.code(429).send({ queued: false, error: 'Too many requests.' });
    const presented = req.headers['x-openmasjid-app-secret'];
    const app = findFabricApp(typeof presented === 'string' ? presented : null);
    if (!app || !app.whatsapp) {
      return reply.code(403).send({ queued: false, error: 'This app is not allowed to send WhatsApp messages.' });
    }
    const body = (req.body ?? {}) as { to?: unknown; text?: unknown; group?: unknown };
    // A single recipient per call, deliberately. Accepting an array would invite an app
    // to hand over a thousand numbers in one request, and the shape of the API is the
    // first place to discourage a blast — the queue would pace it, but the app author
    // should be thinking one-parent-at-a-time.
    const to = typeof body.to === 'string' ? body.to : '';
    const group = typeof body.group === 'string' ? body.group : '';
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim() || Boolean(to) === Boolean(group)) {
      return reply
        .code(400)
        .send({ queued: false, error: 'Send "text" to either a "to" (phone number) or a "group", not both.' });
    }
    // An unapproved group is a 403, not a 400: it is an authorisation answer, and saying
    // "bad request" would send an app author looking for a typo in their payload.
    if (group && !isApprovedGroup(group)) {
      return reply
        .code(403)
        .send({ queued: false, error: 'That group has not been approved for sending in OpenMasjidOS.' });
    }
    const result = enqueueWhatsApp(group ? { groupId: group, text, source: app.id } : { to, text, source: app.id });
    // 202: accepted for later delivery, which is exactly what happened.
    return reply.code(result.queued ? 202 : 400).send(result);
  });

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
