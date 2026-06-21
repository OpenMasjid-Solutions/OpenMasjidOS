/**
 * Platform↔app integration endpoints (optional, backwards-compatible):
 *
 *   GET /api/auth/session       — introspect the omos_session cookie so an app's
 *                                 BACKEND can share the dashboard login (SSO).
 *                                 Server→server only; NOT CORS-enabled, so a
 *                                 cross-origin page can't read another user's
 *                                 auth status.
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
import { findSsoAppBySecret } from '../apps/manager';
import { getSettings } from '../settings/store';
import { log } from '../logger';

export function registerIntegration(server: FastifyInstance): void {
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
    const appId = findSsoAppBySecret(typeof presented === 'string' ? presented : null);
    if (!appId) {
      // Valid session, but the caller didn't prove a known SSO-capable identity.
      log.debug('SSO introspection denied: missing or unrecognised app secret.');
      return { authenticated: false };
    }
    log.info(`SSO introspection: app "${appId}" validated a session.`);
    return { authenticated: true, username };
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
