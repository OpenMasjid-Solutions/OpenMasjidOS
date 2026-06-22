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
import { findFabricApp } from '../apps/manager';
import { sendNotification } from '../notify/notify';
import { getSettings } from '../settings/store';
import { log } from '../logger';

export function registerFabric(server: FastifyInstance): void {
  // B1 — single sign-on introspection. Returns whether the omos_session cookie
  // ON THIS REQUEST is valid. It is the trust anchor (an app mints a signed-in
  // session from a `true`), so it FAILS CLOSED and is bound to the calling app's
  // identity: the app must present the per-app OPENMASJID_APP_SECRET it was issued
  // at install (header X-OpenMasjid-App-Secret). A valid user cookie alone is NOT
  // enough — that stops one installed app, which the browser also hands the shared
  // cookie, from validating (or impersonating) the session as another app. The
  // token is read ONLY from the cookie, never a query/header/body. Not CORS-enabled.
  server.get('/api/auth/session', async (req) => {
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
    );
    return reply.send(result);
  });

  // A2 — public presentation prefs, readable cross-origin by apps.
  const appearance = () => {
    const a = getSettings().appearance;
    return { v: 1, theme: a.theme, wallpaper: a.wallpaper, wallpaperImage: a.wallpaperImage, accent: a.accent, lang: a.lang };
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
}
