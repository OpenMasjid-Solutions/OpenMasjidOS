/**
 * Installed-app lifecycle. Each app is a compose project `omos-<id>` with its
 * files under APPS_DIR/<id>/. meta.json is the source of truth for an app's
 * display info; live Docker state (running/ports) and orphan recovery come from
 * discovery. Together they honour the golden rule: a running app is never
 * dropped from the dashboard, even if its metadata is lost (CLAUDE.md §8.1).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { APPS_DIR } from '../config';
import { log } from '../logger';
import { readJson, writeJson, ensureDir } from '../util/json-store';
import {
  composeUp,
  composeDown,
  composeStop,
  composeStart,
  composeRestart,
  composeLogs,
  composePull,
  composeUpStream,
} from '../docker/compose';
import { discoverApps } from '../docker/discovery';
import { checkCompose } from './compose-validate';
import { findCatalogApp } from '../store/catalog';
import { networkInfo } from '../system/system';
import { isNewerVersion } from '../util/version';
import type { AppMeta, InstalledApp, CatalogApp } from './types';

const projectOf = (id: string) => `omos-${id}`;

// Defense-in-depth: ids are already validated at every API/catalog boundary,
// but never let a path escape APPS_DIR even if a bad id slips through.
const appDir = (id: string) => {
  const dir = path.join(APPS_DIR, id);
  if (dir !== APPS_DIR && !dir.startsWith(APPS_DIR + path.sep)) {
    throw new Error(`Refusing to use an app path outside the apps directory: ${id}`);
  }
  return dir;
};
const composePath = (id: string) => path.join(appDir(id), 'compose.yml');
const envPath = (id: string) => path.join(appDir(id), '.env');
const metaPath = (id: string) => path.join(appDir(id), 'meta.json');

function prettify(id: string): string {
  return id
    .replace(/^custom-/, '')
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function loadMeta(id: string): AppMeta | null {
  try {
    if (!fs.existsSync(metaPath(id))) return null;
    return JSON.parse(fs.readFileSync(metaPath(id), 'utf8')) as AppMeta;
  } catch {
    return null;
  }
}

function saveMeta(meta: AppMeta): void {
  writeJson(metaPath(meta.id), meta);
  invalidateFabricIndex(); // a secret/capability may have changed
}

// A valid env-var name. We refuse anything else as a KEY so a newline/`=` in a
// setting key can't inject extra lines into the .env (security audit).
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function writeEnvFile(id: string, env: Record<string, string>): void {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_KEY_RE.test(k)) {
      log.warn(`Ignoring invalid env key for ${id}: ${JSON.stringify(k)}`);
      continue;
    }
    // Strip CR/LF from values so a single value can never span multiple lines.
    lines.push(`${k}=${String(v ?? '').replace(/[\r\n]+/g, ' ')}`);
  }
  fs.writeFileSync(envPath(id), lines.join('\n') + '\n', 'utf8');
}

/** Parse an app's .env back into a map. Used on update to keep the user's
 *  settings + the install-time base URL while reconciling the Fabric secret. */
function readEnvFile(id: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(envPath(id), 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i > 0) out[t.slice(0, i)] = t.slice(i + 1);
    }
  } catch {
    /* no env file yet */
  }
  return out;
}

/**
 * Resolve the platform base URL we hand to apps for SSO. Order:
 *   1. an explicit OPENMASJID_BASE_URL on the core (the recommended source for
 *      reverse-proxy / multi-host setups — see docs/NETWORKING.md),
 *   2. the host the admin reached us on (passed from the install request) — but
 *      only if it's a clean host[:port] with no credentials/path/whitespace, so a
 *      poisoned Host header can't become a credential-forwarding target,
 *   3. a best-effort LAN interface address.
 */
function cleanHost(host?: string | null): string | null {
  if (!host) return null;
  const h = host.trim();
  if (/^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/.test(h)) return h; // hostname[:port] or IPv4[:port]
  if (/^\[[0-9a-fA-F:]+\](:\d{1,5})?$/.test(h)) return h; // [IPv6][:port]
  return null;
}

function resolveBaseUrl(reqHost?: string | null): string {
  const explicit = process.env.OPENMASJID_BASE_URL;
  if (explicit) return /^https?:\/\//i.test(explicit) ? explicit : `http://${explicit}`;
  const host = cleanHost(reqHost);
  if (host) return `http://${host}`;
  const net = networkInfo();
  if (net.addresses[0]) return `http://${net.addresses[0]}:${net.port}`;
  return '';
}

/** Constant-time string compare (avoids leaking the secret via timing). */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export interface FabricApp {
  id: string;
  /** Display name — used to attribute relayed notifications (server-resolved, so
   *  an app can't spoof being another app in the masjid's Slack/Discord). */
  name: string;
  sso: boolean;
  notify: boolean;
}

interface FabricEntry extends FabricApp {
  ssoSecret: string;
}

// In-memory index of issued Fabric secrets. /api/fabric/* is reachable
// unauthenticated (it's secret-gated), so resolving the secret must NOT scan the
// apps dir from disk on every request — that synchronous fs work on the event
// loop was a DoS lever (security audit). We build the index once and rebuild it
// only when an app is installed / updated / removed.
let fabricCache: FabricEntry[] | null = null;

/** Drop the cached Fabric secret index; rebuilt lazily on next lookup. */
export function invalidateFabricIndex(): void {
  fabricCache = null;
}

function fabricEntries(): FabricEntry[] {
  if (fabricCache) return fabricCache;
  const out: FabricEntry[] = [];
  for (const id of listMetaIds()) {
    const meta = loadMeta(id);
    if (meta?.ssoSecret) {
      out.push({ id, name: meta.name ?? id, sso: meta.sso === true, notify: meta.notify === true, ssoSecret: meta.ssoSecret });
    }
  }
  fabricCache = out;
  return out;
}

/**
 * Resolve an installed app by the per-app Fabric secret it presents (constant-
 * time), returning its identity + which Fabric capabilities it holds. The SSO
 * endpoint requires `.sso`, the notify endpoint requires `.notify` — so one
 * installed app can't act as another, and an app can't use a capability it didn't
 * opt into. Only apps that opted into a Fabric capability are issued a secret, so
 * this returns null for everything else (security audit #1).
 */
export function findFabricApp(secret: string | undefined | null): FabricApp | null {
  if (!secret || secret.length < 16) return null;
  for (const e of fabricEntries()) {
    if (safeEqual(e.ssoSecret, secret)) {
      return { id: e.id, name: e.name, sso: e.sso, notify: e.notify };
    }
  }
  return null;
}

/**
 * OpenMasjidOS Fabric env, injected into every installed app (CLAUDE.md app
 * contract). Presentation is handed off in the browser via the Open URL; these
 * let an app's backend find the platform for OPTIONAL single sign-on (forward
 * the omos_session cookie to `${OPENMASJID_BASE_URL}/api/auth/session`). Apps
 * that don't use them simply ignore them. Override the base with the
 * OPENMASJID_BASE_URL env on the core.
 */
function platformEnv(
  id: string,
  baseUrl?: string | null,
  ssoSecret?: string,
): Record<string, string> {
  const env: Record<string, string> = { OPENMASJID_APP_ID: id };
  const base = resolveBaseUrl(baseUrl);
  if (base) env.OPENMASJID_BASE_URL = base;
  // Only SSO-capable apps get a secret — it's what lets them (and only them)
  // introspect the dashboard session at ${OPENMASJID_BASE_URL}/api/auth/session.
  if (ssoSecret) env.OPENMASJID_APP_SECRET = ssoSecret;
  return env;
}

function listMetaIds(): string[] {
  try {
    return fs
      .readdirSync(APPS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((id) => fs.existsSync(metaPath(id)));
  } catch {
    return [];
  }
}

/** Merge on-disk metadata with live Docker state; recover orphans. */
export async function listInstalled(): Promise<InstalledApp[]> {
  const discovered = await discoverApps();
  const byId = new Map<string, InstalledApp>();

  // 1. Apps we have metadata for.
  for (const id of listMetaIds()) {
    const meta = loadMeta(id);
    if (!meta) continue;
    const disc = discovered.get(projectOf(id));
    byId.set(id, {
      id: meta.id,
      name: meta.name,
      kind: meta.kind,
      icon: meta.icon,
      category: meta.category,
      running: disc?.running ?? false,
      ports: disc?.ports ?? [],
      createdAt: meta.createdAt,
    });
  }

  // 2. Running/known projects without metadata — recover them (golden rule).
  for (const disc of discovered.values()) {
    if (byId.has(disc.id)) continue;
    // We can't vet a recovered app, so never claim it's "Official". Honour a
    // kind label if Docker has one, otherwise treat it as Custom.
    const kind: AppMeta['kind'] =
      disc.kind === 'catalog' || disc.kind === 'community' ? disc.kind : 'custom';
    const recovered: AppMeta = {
      id: disc.id,
      name: disc.name || prettify(disc.id),
      kind,
      createdAt: new Date().toISOString(),
    };
    try {
      ensureDir(appDir(disc.id));
      saveMeta(recovered);
      log.warn(`Recovered orphaned app from Docker: ${disc.id}`);
    } catch {
      /* best-effort persistence; still show it this session */
    }
    byId.set(disc.id, {
      ...recovered,
      running: disc.running,
      ports: disc.ports,
    });
  }

  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getInstalled(id: string): Promise<InstalledApp | null> {
  const all = await listInstalled();
  return all.find((a) => a.id === id) ?? null;
}

/** Install a catalog app: write its files (with settings as env) and start it. */
export async function installCatalogApp(
  app: CatalogApp,
  settings: Record<string, string>,
  baseUrl?: string | null,
): Promise<InstalledApp> {
  ensureDir(appDir(app.id));
  fs.writeFileSync(composePath(app.id), app.compose, 'utf8');
  // Fabric capabilities are opt-in per app. An app that uses SSO and/or
  // notifications gets a fresh per-app secret so it can prove its identity.
  const sso = app.sso === true;
  const notify = app.notifications === true;
  const ssoSecret = sso || notify ? crypto.randomBytes(32).toString('base64url') : undefined;
  writeEnvFile(app.id, { ...settings, ...platformEnv(app.id, baseUrl, ssoSecret) });
  saveMeta({
    id: app.id,
    name: app.name,
    kind: 'catalog',
    icon: app.icon,
    category: app.category,
    version: app.version,
    createdAt: new Date().toISOString(),
    sso,
    notify,
    ssoSecret,
  });

  const res = await composeUp(projectOf(app.id), composePath(app.id), envPath(app.id));
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || 'The app failed to start.');
  }
  return (await getInstalled(app.id))!;
}

/**
 * Install a pre-validated app from raw compose text (custom-paste or community
 * app store). The compose + env are written and started under project omos-<id>.
 * Risk-checking happens in the router before this is called.
 */
async function installStack(opts: {
  id: string;
  name: string;
  kind: AppMeta['kind'];
  composeText: string;
  env: Record<string, string>;
  icon?: string;
  baseUrl?: string | null;
}): Promise<InstalledApp> {
  const { id, name, kind, composeText, env, icon, baseUrl } = opts;
  ensureDir(appDir(id));
  fs.writeFileSync(composePath(id), composeText, 'utf8');
  writeEnvFile(id, { ...env, ...platformEnv(id, baseUrl) });
  saveMeta({ id, name, kind, icon, createdAt: new Date().toISOString() });

  const res = await composeUp(projectOf(id), composePath(id), envPath(id));
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || 'The app failed to start.');
  }
  return (await getInstalled(id))!;
}

export function installCustomApp(opts: {
  id: string;
  name: string;
  composeText: string;
  env: Record<string, string>;
  icon?: string;
  baseUrl?: string | null;
}): Promise<InstalledApp> {
  return installStack({ ...opts, kind: 'custom' });
}

export function installCommunityApp(opts: {
  id: string;
  name: string;
  composeText: string;
  env: Record<string, string>;
  icon?: string;
  baseUrl?: string | null;
}): Promise<InstalledApp> {
  return installStack({ ...opts, kind: 'community' });
}

/**
 * Bring every installed app back up from its on-disk compose file. Used after a
 * restore so apps run with the restored data (and so a fresh-box restore
 * actually recreates them). Streams a friendly line per app via onLine.
 */
export async function reupAllApps(onLine: (s: string) => void): Promise<void> {
  const ids = listMetaIds().filter((id) => fs.existsSync(composePath(id)));
  if (ids.length === 0) {
    onLine('No apps to restart.');
    return;
  }
  for (const id of ids) {
    const name = loadMeta(id)?.name ?? id;
    onLine(`• ${name}`);
    // A backup is an opaque, externally-craftable file — so re-run each restored
    // stack through the SAME risk gate a fresh install uses. We never auto-start
    // a dangerous compose (privileged, host namespaces, socket/sensitive binds…)
    // that a crafted backup could smuggle in without the usual consent (audit).
    try {
      const { dangers } = checkCompose(fs.readFileSync(composePath(id), 'utf8'));
      if (dangers.length > 0) {
        onLine(`  (not started — needs review: ${dangers[0]})`);
        continue;
      }
    } catch (err) {
      onLine(`  (not started — couldn't check it safely: ${(err as Error).message})`);
      continue;
    }
    try {
      const res = await composeUp(projectOf(id), composePath(id), envPath(id));
      if (res.code !== 0) {
        onLine(`  (couldn't start — ${res.stderr.trim().split('\n')[0] || 'error'})`);
      }
    } catch (err) {
      onLine(`  (couldn't start — ${(err as Error).message})`);
    }
  }
}

export async function startApp(id: string): Promise<void> {
  // Prefer a fresh `up` when we have the compose file (recreates if needed),
  // otherwise fall back to `start` for orphaned projects.
  if (fs.existsSync(composePath(id))) {
    await composeUp(projectOf(id), composePath(id), envPath(id));
  } else {
    await composeStart(projectOf(id));
  }
}

export async function stopApp(id: string): Promise<void> {
  await composeStop(projectOf(id));
}

export async function restartApp(id: string): Promise<void> {
  await composeRestart(projectOf(id));
}

export async function appLogs(id: string, tail = 200): Promise<string> {
  return composeLogs(projectOf(id), tail);
}

export interface UpdateCheck {
  updateAvailable: boolean;
  current: string;
  latest: string | null;
}

/** Is a newer version of this (catalog) app available in the store? Community /
 *  custom apps have no store source, so they never report an update here. */
export async function checkCatalogUpdate(id: string): Promise<UpdateCheck> {
  const meta = loadMeta(id);
  const current = meta?.version ?? '';
  if (!meta || meta.kind !== 'catalog') return { updateAvailable: false, current, latest: null };
  const app = await findCatalogApp(id);
  if (!app) return { updateAvailable: false, current, latest: null };
  return { updateAvailable: isNewerVersion(current, app.version), current, latest: app.version };
}

/**
 * Update a catalog app to the store's current version, streaming progress via
 * onLine. The user's existing settings (.env) are kept; only the compose +
 * image change. Re-runs `pull` then `up -d` so the new image is fetched and the
 * container recreated.
 */
export async function updateCatalogApp(id: string, onLine: (s: string) => void): Promise<void> {
  const meta = loadMeta(id);
  if (!meta || meta.kind !== 'catalog') {
    onLine('This app cannot be updated from the store.');
    return;
  }
  const app = await findCatalogApp(id);
  if (!app) {
    onLine("Could not find this app in the store anymore. Nothing was changed.");
    return;
  }
  if (!isNewerVersion(meta.version ?? '', app.version)) {
    onLine(`${meta.name} is already up to date (v${app.version}).`);
    return;
  }

  onLine(`Updating ${meta.name} from v${meta.version ?? '?'} to v${app.version}…`);
  // New compose; keep the user's saved settings (.env) untouched.
  fs.writeFileSync(composePath(id), app.compose, 'utf8');

  // Reconcile Fabric capabilities from the REFRESHED entry so an author can add
  // OR revoke sso/notifications on update — the capability gate reads meta, so a
  // withdrawn capability must stop working. Keep the user's settings + the
  // install-time OPENMASJID_BASE_URL; only the per-app secret tracks capability.
  const sso = app.sso === true;
  const notify = app.notifications === true;
  let ssoSecret = meta.ssoSecret;
  if (sso || notify) {
    if (!ssoSecret) ssoSecret = crypto.randomBytes(32).toString('base64url');
  } else {
    ssoSecret = undefined;
  }
  const env = readEnvFile(id);
  env.OPENMASJID_APP_ID = id;
  if (ssoSecret) env.OPENMASJID_APP_SECRET = ssoSecret;
  else delete env.OPENMASJID_APP_SECRET;
  writeEnvFile(id, env);

  onLine('');
  onLine('Downloading the new version…');
  if ((await composePull(projectOf(id), composePath(id), envPath(id), onLine)) !== 0) {
    onLine('');
    onLine('Could not download the update. Please check the connection and try again.');
    return;
  }

  onLine('');
  onLine('Applying the update…');
  if ((await composeUpStream(projectOf(id), composePath(id), envPath(id), onLine)) !== 0) {
    onLine('');
    onLine('The update could not start. The previous version may still be running.');
    return;
  }

  saveMeta({
    ...meta,
    name: app.name || meta.name,
    icon: app.icon ?? meta.icon,
    category: app.category ?? meta.category,
    version: app.version,
    sso,
    notify,
    ssoSecret,
  });
  onLine('');
  onLine(`Done — ${meta.name} is now on v${app.version}.`);
}

/**
 * Remove an app: stop & delete its containers and drop it from the dashboard.
 * When deleteData is true, also remove its volumes and on-disk files.
 */
export async function removeApp(id: string, deleteData = false): Promise<void> {
  const file = fs.existsSync(composePath(id)) ? composePath(id) : undefined;
  // When deleting data, also drop the app's images so the space is reclaimed.
  await composeDown(projectOf(id), file, deleteData, deleteData);
  try {
    if (deleteData) {
      fs.rmSync(appDir(id), { recursive: true, force: true });
    } else if (fs.existsSync(metaPath(id))) {
      // Keep the data dir, but the app leaves the dashboard.
      fs.rmSync(metaPath(id), { force: true });
    }
  } catch (err) {
    log.warn(`Cleanup after removing ${id} had a problem.`, err);
  }
  invalidateFabricIndex(); // the app's secret (if any) is gone
}
