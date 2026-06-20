/**
 * CasaOS-compatible community app store reader.
 *
 * A "repo" is a link to a CasaOS app-store repository — either a .zip archive or
 * a GitHub repo URL (we derive the archive). CasaOS stores apps as
 * `Apps/<Name>/docker-compose.yml` with an `x-casaos:` extension block carrying
 * the display metadata. docker compose ignores `x-` keys, so we can run the
 * compose as-is. This is best-effort interop, not a full CasaOS reimplementation.
 */
import { unzipSync, strFromU8 } from 'fflate';
import YAML from 'yaml';
import { log } from '../logger';
import { slugify } from '../util/slug';
import type { CatalogApp } from '../apps/types';

const MAX_APPS = 400;
const APP_RE = /(?:^|\/)Apps\/([^/]+)\/docker-compose\.ya?ml$/i;
const CACHE_TTL_MS = 10 * 60 * 1000;

// Downloading + unzipping a repo is expensive, so cache parsed results per URL.
const repoCache = new Map<string, { at: number; apps: CatalogApp[] }>();

/** Turn a user-supplied repo link into candidate archive URLs. */
function archiveCandidates(repo: string): string[] {
  const u = repo.trim().replace(/\/+$/, '');
  if (u.endsWith('.zip')) return [u];
  if (u.includes('github.com')) {
    return [
      `${u}/archive/refs/heads/main.zip`,
      `${u}/archive/refs/heads/master.zip`,
    ];
  }
  return [u];
}

function localized(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, string>;
    return obj.en_us || obj['en-us'] || Object.values(obj)[0] || fallback;
  }
  return fallback;
}

function parseApp(folder: string, text: string): CatalogApp | null {
  let doc: Record<string, unknown>;
  try {
    doc = YAML.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object' || !doc.services) return null;

  const x = (doc['x-casaos'] ?? {}) as Record<string, unknown>;
  const name = localized(x.title, folder);
  const icon = typeof x.icon === 'string' ? x.icon : undefined;
  return {
    id: `community-${slugify(folder)}`,
    name,
    tagline: localized(x.tagline),
    description: localized(x.description),
    category: typeof x.category === 'string' ? x.category : undefined,
    author: typeof x.developer === 'string' ? x.developer : undefined,
    version: '1.0.0',
    icon,
    compose: text,
  };
}

/** Download + parse one repo into catalog-shaped community apps (cached). */
export async function fetchRepoApps(repo: string, force = false): Promise<CatalogApp[]> {
  const cached = repoCache.get(repo);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.apps;

  let buf: Uint8Array | null = null;
  for (const url of archiveCandidates(repo)) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) continue;
      buf = new Uint8Array(await res.arrayBuffer());
      break;
    } catch {
      /* try next candidate */
    }
  }
  if (!buf) throw new Error('Could not download that app store. Check the link.');

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(buf);
  } catch {
    throw new Error('That link is not a valid app-store archive.');
  }

  const apps: CatalogApp[] = [];
  const seen = new Set<string>();
  for (const [path, data] of Object.entries(files)) {
    const m = path.match(APP_RE);
    if (!m) continue;
    const app = parseApp(m[1], strFromU8(data));
    if (app && !seen.has(app.id)) {
      seen.add(app.id);
      apps.push(app);
    }
    if (apps.length >= MAX_APPS) break;
  }
  if (apps.length === 0) {
    throw new Error("We couldn't find any apps in that store.");
  }
  repoCache.set(repo, { at: Date.now(), apps });
  return apps;
}

/** Aggregate apps across several repos, ignoring ones that fail. */
export async function fetchAllCommunityApps(repos: string[]): Promise<CatalogApp[]> {
  const out: CatalogApp[] = [];
  const seen = new Set<string>();
  for (const repo of repos) {
    try {
      for (const app of await fetchRepoApps(repo)) {
        if (!seen.has(app.id)) {
          seen.add(app.id);
          out.push(app);
        }
      }
    } catch (err) {
      log.warn(`Community repo failed: ${repo}`, err);
    }
  }
  return out;
}
