// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** Helpers for installed-app cards/dock. */
import { prefsStore } from './prefs';
import { appBaseUrl, appOpenUrl, type OpenableApp, type Viewpoint } from './app-url';

/**
 * Is this dashboard being used from outside the masjid, and where are the apps from
 * there? Set by Root from `auth.me` whenever it is read, so it is right before
 * anything can be clicked. It changes HOW an app opens (below, and lib/app-url.ts),
 * and nothing else — what a remote request may do is decided by the server, from the
 * session it carries.
 */
let remoteSession = false;
let remoteAppOrigin: string | null = null;
export function setRemoteSession(remote: boolean, appOrigin: string | null = null): void {
  remoteSession = remote;
  remoteAppOrigin = appOrigin;
}

/** Is this dashboard being used from outside the masjid? */
export function isRemoteSession(): boolean {
  return remoteSession;
}

/**
 * How the dashboard asks the platform for a one-use address that opens an app from
 * outside (`apps.openRemote`). Set by Root, which has the tRPC client and the toast —
 * this file has neither and should not grow them. `onFail` says so to the admin.
 */
type RemoteOpener = (id: string) => Promise<string>;
let remoteOpener: { open: RemoteOpener; onFail: (err: unknown) => void } | null = null;
export function setRemoteOpener(open: RemoteOpener, onFail: (err: unknown) => void): void {
  remoteOpener = { open, onFail };
}

function viewpoint(): Viewpoint {
  return { remote: remoteSession, appOrigin: remoteAppOrigin, hostname: window.location.hostname };
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
export function appFaviconUrl(app: OpenableApp): string | null {
  const base = appBaseUrl(app, viewpoint());
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

/**
 * Open an app in a new tab. Returns false when there is nothing to open from here
 * (no web port, or a pop-up blocker said no), so a caller can offer something else.
 */
export function openApp(app: OpenableApp & { id: string; fabric?: boolean }): boolean {
  // Only hand the appearance prefs (the OpenMasjidOS Fabric `#omos=` fragment) to
  // apps that opted into the Fabric. A community/custom 3rd-party app (e.g. Homarr)
  // never declared support and must NOT receive the platform's prefs in its URL.
  const withPrefs = (url: string) => (app.fabric ? url + appearanceHash() : url);
  if (remoteSession) return openFromOutside(app, withPrefs);
  const url = appOpenUrl(app, viewpoint());
  if (!url) return false;
  window.open(withPrefs(url), '_blank', 'noopener,noreferrer');
  return true;
}

/**
 * From outside: ask the platform for the app's one-use address, then send a new tab
 * there. It signs that tab in to that one app, on the apps' own hostname — never this
 * one (core system/app-access.ts).
 *
 * The tab is opened FIRST, empty, while the click is still a click: a pop-up blocker
 * allows a new tab only in direct response to one, and the address takes a round trip
 * to get. Its link back to this page is cut before it goes anywhere, so the app it
 * ends up showing cannot reach back into the dashboard. The `#omos=` fragment survives
 * the platform's redirect, as a fragment does.
 */
function openFromOutside(app: OpenableApp & { id: string }, withPrefs: (url: string) => string): boolean {
  if (app.openPort == null || !remoteOpener) return false;
  const tab = window.open('', '_blank');
  if (!tab) return false;
  try {
    tab.opener = null;
  } catch {
    /* some browsers make it read-only once set; it is null already then */
  }
  const { open, onFail } = remoteOpener;
  open(app.id).then(
    (url) => tab.location.replace(withPrefs(url)),
    (err: unknown) => {
      tab.close();
      onFail(err);
    },
  );
  return true;
}
