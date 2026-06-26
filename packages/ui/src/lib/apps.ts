// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** Helpers for installed-app cards/dock. */
import { prefsStore } from './prefs';

/** The LAN URL an app is reachable at, or null. The server decides the scheme +
 *  port per app: a flagged (Stripe) app is `https://…:<proxy port>`, every other
 *  app is plain `http://…:<published port>`. We must NOT derive the scheme from
 *  the dashboard's own protocol — the dashboard is HTTPS, but most apps are HTTP. */
export function appUrl(app: { https?: boolean; openPort?: number | null }): string | null {
  if (app.openPort == null) return null;
  const scheme = app.https ? 'https' : 'http';
  return `${scheme}://${window.location.hostname}:${app.openPort}`;
}

/**
 * Appearance hand-off (OpenMasjidOS Fabric, A1). We pass the viewer's
 * presentation prefs (theme/wallpaper/accent/language) to the app as a URL
 * FRAGMENT (`#omos=…`) — the part after `#` is never sent to a server or logged,
 * and is cross-origin safe. An integrated app reads it on load to match the
 * dashboard's look; apps that don't understand it just ignore the hash.
 */
function appearanceHash(): string {
  const p = prefsStore.get();
  const payload = {
    v: 1,
    theme: p.theme,
    wallpaper: p.wallpaper,
    wallpaperImage: p.wallpaperImage || undefined,
    accent: p.accent,
    lang: p.language,
  };
  // base64url(JSON) — no padding, URL-safe.
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
  return `#omos=${b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

/** Best-effort favicon URL for an app (used as its icon when none is set). */
export function appFaviconUrl(app: { https?: boolean; openPort?: number | null }): string | null {
  const base = appUrl(app);
  return base ? `${base}/favicon.ico` : null;
}

export function appInitial(name: string): string {
  return (name.trim()[0] || '?').toUpperCase();
}

/** Deterministic colourful gradient per app id (umbrelOS-style variety). */
export function appColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  const h2 = (h + 40) % 360;
  return `linear-gradient(150deg, hsl(${h} 70% 55%), hsl(${h2} 75% 45%))`;
}

export function openApp(app: { https?: boolean; openPort?: number | null; fabric?: boolean }): boolean {
  const url = appUrl(app);
  if (!url) return false;
  // Only hand the appearance prefs (the OpenMasjidOS Fabric `#omos=` fragment) to
  // apps that opted into the Fabric. A community/custom 3rd-party app (e.g. Homarr)
  // never declared support and must NOT receive the platform's prefs in its URL.
  const target = app.fabric ? url + appearanceHash() : url;
  window.open(target, '_blank', 'noopener,noreferrer');
  return true;
}
