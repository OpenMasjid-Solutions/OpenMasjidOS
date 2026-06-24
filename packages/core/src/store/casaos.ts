/**
 * CasaOS-compatible community app store reader.
 *
 * A "repo" is a link to a CasaOS app-store repository — either a .zip archive or
 * a GitHub repo URL (we derive the archive). CasaOS stores apps as
 * `Apps/<Name>/docker-compose.yml` with an `x-casaos:` extension block carrying
 * the display metadata. docker compose ignores `x-` keys, so we can run the
 * compose as-is. This is best-effort interop, not a full CasaOS reimplementation.
 *
 * Security (see the audit): the repo URL is fetched server-side, so we (a) block
 * SSRF to private/loopback/metadata addresses (DNS-resolved, with redirects
 * re-validated per hop), (b) cap the download size and add a timeout, and
 * (c) only decompress small files matching the compose path — so a zip /
 * decompression bomb can never balloon the root core process's heap.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { unzipSync, strFromU8 } from 'fflate';
import YAML from 'yaml';
import { log } from '../logger';
import { slugify } from '../util/slug';
import type { CatalogApp } from '../apps/types';

const MAX_APPS = 400;
const APP_RE = /(?:^|\/)Apps\/([^/]+)\/docker-compose\.ya?ml$/i;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024; // 64 MiB raw archive cap
const MAX_ENTRY_BYTES = 512 * 1024; // 512 KiB per compose file (uncompressed)
const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

const repoCache = new Map<string, { at: number; apps: CatalogApp[] }>();

function archiveCandidates(repo: string): string[] {
  const u = repo.trim().replace(/\/+$/, '');
  if (u.endsWith('.zip')) return [u];
  if (u.includes('github.com')) {
    return [`${u}/archive/refs/heads/main.zip`, `${u}/archive/refs/heads/master.zip`];
  }
  return [u];
}

// ── SSRF guard ───────────────────────────────────────────────────────────────
function ipIsPrivate(ip: string): boolean {
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    return false;
  }
  const lc = ip.toLowerCase();
  if (lc === '::1' || lc === '::') return true;
  if (lc.startsWith('fe80') || lc.startsWith('fc') || lc.startsWith('fd')) return true;
  const mapped = lc.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipIsPrivate(mapped[1]);
  return false;
}

/** Resolve a host to a single vetted PUBLIC address, or null if it's a literal
 *  private IP / resolves to any private/loopback/metadata address. */
async function resolveVetted(host: string): Promise<{ ip: string; family: number } | null> {
  if (host.toLowerCase() === 'localhost') return null;
  if (net.isIP(host)) return ipIsPrivate(host) ? null : { ip: host, family: net.isIP(host) };
  try {
    const addrs = await dns.lookup(host, { all: true });
    if (addrs.length === 0 || addrs.some((a) => ipIsPrivate(a.address))) return null;
    return { ip: addrs[0].address, family: addrs[0].family };
  } catch {
    return null;
  }
}

/** One GET, with the socket PINNED to a pre-vetted IP via a custom `lookup` so
 *  the address we validated is exactly the address we connect to — closing the
 *  DNS-rebinding (TOCTOU) gap a separate fetch-time resolution would reopen.
 *  TLS servername stays the hostname, so certificate validation is unaffected.
 *  Returns the body (≤ cap), or a redirect location, or null. */
function getPinned(
  url: string,
  pinnedIp: string,
  family: number,
): Promise<{ status: number; location: string | null; body: Uint8Array | null }> {
  return new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return resolve({ status: 0, location: null, body: null });
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      { method: 'GET', lookup: (_h, _o, cb) => cb(null, pinnedIp, family), timeout: FETCH_TIMEOUT_MS },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, location: res.headers.location ?? null, body: null });
        }
        if (status < 200 || status >= 300) {
          res.resume();
          return resolve({ status, location: null, body: null });
        }
        const declared = Number(res.headers['content-length'] ?? '0');
        if (declared && declared > MAX_DOWNLOAD_BYTES) {
          res.destroy();
          return resolve({ status, location: null, body: null });
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (c: Buffer) => {
          total += c.length;
          if (total > MAX_DOWNLOAD_BYTES) {
            res.destroy();
            resolve({ status, location: null, body: null });
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status, location: null, body: new Uint8Array(Buffer.concat(chunks)) }));
        res.on('error', () => resolve({ status, location: null, body: null }));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0, location: null, body: null }));
    req.end();
  });
}

/** Fetch an archive with SSRF checks (pinned per hop), a size cap, a timeout,
 *  and manual, re-validated redirect following. Returns null on any failure. */
async function downloadArchive(startUrl: string): Promise<Uint8Array | null> {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const vetted = await resolveVetted(u.hostname.replace(/^\[|\]$/g, ''));
    if (!vetted) return null;
    const res = await getPinned(url, vetted.ip, vetted.family);
    if (res.status >= 300 && res.status < 400) {
      if (!res.location) return null;
      url = new URL(res.location, url).toString();
      continue;
    }
    return res.body;
  }
  return null;
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
  // The icon URL is rendered as <img src> in the admin's browser and persisted,
  // so only accept http(s) — never data:/javascript:/relative — from an
  // untrusted community repo (security audit).
  const icon =
    typeof x.icon === 'string' && /^https?:\/\//i.test(x.icon) ? x.icon : undefined;
  return {
    id: `community-${slugify(folder)}`,
    name: localized(x.title, folder),
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
    buf = await downloadArchive(url);
    if (buf) break;
  }
  if (!buf) throw new Error('Could not download that app store. Check the link is a trusted, public URL.');

  let files: Record<string, Uint8Array>;
  try {
    // Only decompress small files on the compose path — a bomb entry is either
    // off-path or over the per-entry cap, so it is skipped without inflating.
    files = unzipSync(buf, {
      filter: (file) => APP_RE.test(file.name) && file.originalSize <= MAX_ENTRY_BYTES,
    });
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
