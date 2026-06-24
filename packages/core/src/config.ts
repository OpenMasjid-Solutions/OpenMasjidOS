/**
 * Central configuration — every path and tunable the daemon needs, resolved
 * once from the environment. The installer mounts persistent data at /data and
 * sets OPENMASJID_DATA_DIR; in local dev we fall back to a ./.data folder.
 */
import path from 'node:path';
import os from 'node:os';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Absolute path to the persistent data directory (config, app state, volumes). */
export const DATA_DIR = process.env.OPENMASJID_DATA_DIR
  ? path.resolve(process.env.OPENMASJID_DATA_DIR)
  : path.resolve(process.cwd(), '.data');

/** Where platform config files (auth.json, settings.json…) live. */
export const CONFIG_DIR = path.join(DATA_DIR, 'config');

/** Where each installed app keeps its compose, env, metadata, and volumes. */
export const APPS_DIR = path.join(DATA_DIR, 'apps');

/** TCP port the daemon binds to. Matches the installer + compose default.
 *  In production this is the HTTP front door (health, Fabric, and a redirect to
 *  HTTPS); the dashboard itself is served over TLS_PORT. */
export const PORT = envInt('OPENMASJID_PORT', 8723);

/** HTTPS port the dashboard is served on (forced HTTPS in production). */
export const TLS_PORT = envInt('OPENMASJID_TLS_PORT', 443);

/** Bind address — all interfaces, so the LAN can reach the dashboard. */
export const HOST = process.env.OPENMASJID_HOST ?? '0.0.0.0';

/**
 * The built React UI. The monorepo layout is preserved in the runtime image,
 * so the daemon at packages/core/{dist,src} finds the UI two levels up.
 */
export const UI_DIR = process.env.OPENMASJID_UI_DIR
  ? path.resolve(process.env.OPENMASJID_UI_DIR)
  : path.resolve(__dirname, '../../ui/dist');

/**
 * Where the App Store catalog is fetched from. The apps live in a separate
 * repo (OpenMasjidAPPS); the catalog is a static catalog.json it publishes.
 */
export const CATALOG_URL =
  process.env.OPENMASJID_CATALOG_URL ??
  'https://raw.githubusercontent.com/hasan-ismail/OpenMasjidAPPS/main/catalog.json';

/** True when running the production build inside the container. */
export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/** Hostname of the machine, used for the "network info" panel. */
export const MACHINE_HOSTNAME = os.hostname();
