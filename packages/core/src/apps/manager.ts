/**
 * Installed-app lifecycle. Each app is a compose project `omos-<id>` with its
 * files under APPS_DIR/<id>/. meta.json is the source of truth for an app's
 * display info; live Docker state (running/ports) and orphan recovery come from
 * discovery. Together they honour the golden rule: a running app is never
 * dropped from the dashboard, even if its metadata is lost (CLAUDE.md §8.1).
 */
import fs from 'node:fs';
import path from 'node:path';
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
} from '../docker/compose';
import { discoverApps } from '../docker/discovery';
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
}

function writeEnvFile(id: string, env: Record<string, string>): void {
  const lines = Object.entries(env).map(
    ([k, v]) => `${k}=${String(v ?? '').replace(/[\r\n]+/g, ' ')}`,
  );
  fs.writeFileSync(envPath(id), lines.join('\n') + '\n', 'utf8');
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
): Promise<InstalledApp> {
  ensureDir(appDir(app.id));
  fs.writeFileSync(composePath(app.id), app.compose, 'utf8');
  writeEnvFile(app.id, settings);
  saveMeta({
    id: app.id,
    name: app.name,
    kind: 'catalog',
    icon: app.icon,
    category: app.category,
    version: app.version,
    createdAt: new Date().toISOString(),
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
}): Promise<InstalledApp> {
  const { id, name, kind, composeText, env, icon } = opts;
  ensureDir(appDir(id));
  fs.writeFileSync(composePath(id), composeText, 'utf8');
  writeEnvFile(id, env);
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
}): Promise<InstalledApp> {
  return installStack({ ...opts, kind: 'custom' });
}

export function installCommunityApp(opts: {
  id: string;
  name: string;
  composeText: string;
  env: Record<string, string>;
  icon?: string;
}): Promise<InstalledApp> {
  return installStack({ ...opts, kind: 'community' });
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

/**
 * Remove an app: stop & delete its containers and drop it from the dashboard.
 * When deleteData is true, also remove its volumes and on-disk files.
 */
export async function removeApp(id: string, deleteData = false): Promise<void> {
  const file = fs.existsSync(composePath(id)) ? composePath(id) : undefined;
  await composeDown(projectOf(id), file, deleteData);
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
}
