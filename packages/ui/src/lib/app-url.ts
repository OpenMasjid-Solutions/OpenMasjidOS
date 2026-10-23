// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Where an installed app lives, from where the dashboard is being used.
 *
 * Deliberately React-free and import-free, so a core test can check it
 * (packages/ui has no test runner; lib/phone.ts is tested the same way).
 *
 * TWO ANSWERS, and the difference is the whole point of this file:
 *
 *  - **At the masjid** an app is at its own port on this machine —
 *    `http://<the address the dashboard was opened at>:<port>` (https for a Stripe
 *    app behind its TLS proxy). The scheme comes from the APP, never from the
 *    dashboard's own page: the dashboard is HTTPS, most apps are not.
 *
 *  - **From outside** (the remote dashboard, at the root of the apps' hostname) there
 *    is no such port: an app is at `https://<the apps' hostname>/<its path>/`, the
 *    dashboard's own origin. What stops an app page driving the dashboard as the admin
 *    is not the address but the dashboard key, which only the dashboard's own page
 *    holds, in memory (lib/session.ts; core system/remote-admin.ts). There is still no
 *    URL to build here for OPENING an app from outside — the dashboard asks the
 *    platform for a one-use one (`apps.openRemote`, lib/apps.ts) that signs the browser
 *    in to that app alone. What is built here is only the address of a SHARED app's
 *    public files, which anyone may load — its icon, say.
 */

export interface OpenableApp {
  /** Served over HTTPS on the LAN (a Stripe app behind the TLS proxy). */
  https?: boolean;
  /** The LAN port to open; null/absent when the app publishes no web port. */
  openPort?: number | null;
  /** The path it is served under through the tunnel. */
  path?: string;
  /** Shared online — its pages are public at its path. */
  exposed?: boolean;
}

export interface Viewpoint {
  /** This dashboard is the remote one (auth.me → remote, which follows the front
   *  door's hand-over, not a header). */
  remote: boolean;
  /** From outside: `https://<the apps' hostname>` (auth.me → appOrigin). Null when unknown. */
  appOrigin: string | null;
  /** `window.location.hostname` — the LAN address the dashboard was opened at. */
  hostname: string;
}

/**
 * The app's base address with no trailing slash, or null when there is none to
 * use from here. Append `/favicon.ico` and the like directly.
 *
 * From outside, only a SHARED app has one: anything else at its path is served only
 * to a browser the admin opened it in, and loading it from the dashboard would just
 * be refused.
 */
export function appBaseUrl(app: OpenableApp, where: Viewpoint): string | null {
  // No web port means nothing to open, from anywhere: the tunnel reaches an app
  // through the same published port the LAN does.
  if (app.openPort == null) return null;
  if (where.remote) {
    const path = (app.path ?? '').replace(/^\/+|\/+$/g, '');
    if (!path || app.exposed !== true || !where.appOrigin) return null;
    return `${where.appOrigin.replace(/\/+$/, '')}/${encodeURIComponent(path)}`;
  }
  const scheme = app.https ? 'https' : 'http';
  return `${scheme}://${where.hostname}:${app.openPort}`;
}

/**
 * The address to open the app at ON THE MASJID'S NETWORK, or null. From outside
 * there is never one to build — see the header; lib/apps.ts asks the platform.
 */
export function appOpenUrl(app: OpenableApp, where: Viewpoint): string | null {
  if (where.remote) return null;
  return appBaseUrl(app, where);
}
