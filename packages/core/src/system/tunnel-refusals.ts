// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Why the platform refused a request that arrived through the Cloudflare tunnel.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
 *
 * Five different guards answered a tunnel request with a byte-identical, opaque
 * `{"error":"Not found."}` and **no log line anywhere**. So a masjid whose public page
 * stopped working — and whoever they asked for help — had no way to tell apart:
 *
 *   - "nothing is published at that path" (the usual answer: the address is wrong, or
 *     the app is not exposed, or the routing table was momentarily empty),
 *   - "that is a LAN-only route and always will be" (the dashboard, tRPC, the Fabric),
 *   - "that is the app's own LAN-only /fabric space".
 *
 * All three are correct behaviour in their own case, which is exactly why an
 * undifferentiated 404 is so expensive: the right diagnosis and the wrong one look the
 * same from outside, and from inside there was nothing to read at all.
 *
 * ── THE DISCLOSURE RULE ─────────────────────────────────────────────────────────
 *
 * **The RESPONSE stays generic.** No code, no reason, no hint of which guard fired — a
 * discriminating 404 would tell anyone on the internet which paths are real routes on this
 * platform and which are nothing, which is precisely what the tunnel guard exists to
 * withhold (the same reasoning that withholds the version from `/api/health`).
 *
 * The detail goes HERE instead: in memory, read only over the LAN-only dashboard. The
 * masjid can see exactly why their page was refused; the internet cannot.
 *
 * Bounded and in-memory on purpose. This is a diagnostic for "why is my page 404ing right
 * now", not an access log — persisting visitor paths would be a new pile of request data
 * on a masjid's disk for no proportionate benefit.
 */
import crypto from 'node:crypto';
import { log } from '../logger';

export type RefusalReason =
  /** No app is routed at that first path segment. Usually the real answer. */
  | 'no-app-at-path'
  /** A platform route that is LAN-only by design (dashboard, tRPC, health, Fabric). */
  | 'lan-only-route'
  /** An exposed app's own `/fabric/*` space, which is LAN-only. */
  | 'app-fabric-lan-only';

export interface Refusal {
  at: number;
  /**
   * Short random handle, shown to the visitor in the 404 and listed here.
   *
   * This is what makes a hit-and-miss failure investigable: somebody who sees the error
   * reads six characters off their screen, and the masjid finds THAT request rather than
   * guessing which of the day's refusals it was. Random on purpose — it encodes nothing,
   * so it tells a stranger nothing, which is what lets it appear in a public response at
   * all (see THE DISCLOSURE RULE above).
   */
  ref: string;
  /** Path only — never the query string, which is where tokens and ids live. */
  path: string;
  /** The Host header asked for, so a wrong hostname is obvious. */
  host: string;
  reason: RefusalReason;
  /** GET, POST… — a page load and a background fetch fail for different reasons. */
  method: string;
  /**
   * Cloudflare's own request id. The single most useful field here: it is the same id
   * Cloudflare shows in its dashboard, so a refusal can be matched to what Cloudflare
   * thought it was doing — including WHICH EDGE served it, which is the obvious suspect
   * when the same page works for one visitor and not another.
   */
  cfRay: string;
  /** Whether the client asked for a page or for data. A raw JSON 404 reaching a person
   *  means it was never a page load, which changes the diagnosis entirely. */
  wantsHtml: boolean;
  /** Truncated, for spotting "only this browser" or "only this app's webview". */
  agent: string;
  /** How many times this exact path+reason has been refused. */
  count: number;
}

/**
 * Paths every browser and phone asks for on its own, at the ROOT, whatever is published.
 *
 * These are not evidence of anything. A masjid serving apps under paths
 * (`/donate`, `/kiosk`) will have every visitor's browser ask for `/favicon.ico` and,
 * on iOS, the touch icons; Android asks for `/.well-known/assetlinks.json` when a link is
 * opened. Recording them buries the one line that matters — the first real report from a
 * masjid was four rows of exactly this and nothing else, which is precisely the failure
 * this panel exists to prevent.
 *
 * Still refused, still 404 — only kept out of the record.
 */
const BROWSER_NOISE = [
  '/favicon.ico',
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
  '/robots.txt',
  '/sitemap.xml',
  '/browserconfig.xml',
  '/manifest.json',
  '/site.webmanifest',
];

/** True for a path no human typed and no app owns. */
export function isBrowserNoise(path: string): boolean {
  const p = path.toLowerCase();
  if (BROWSER_NOISE.includes(p)) return true;
  // Apple appends a size to the touch icon: /apple-touch-icon-180x180.png
  if (/^\/apple-touch-icon(-precomposed)?(-\d+x\d+)?\.png$/.test(p)) return true;
  // Android App Links + the various probe files under /.well-known.
  if (p.startsWith('/.well-known/')) return true;
  return false;
}

/** Enough to see a pattern, few enough to be free. */
const MAX = 25;
/** Paths are truncated: a long URL is a log-flooding vector and adds nothing here. */
const MAX_PATH = 120;

const recent: Refusal[] = [];

/**
 * Record a refusal, collapsing repeats.
 *
 * A phone retrying a failed page produces the same line a dozen times; collapsing keeps
 * the list readable and stops one client evicting everything else's evidence.
 */
export interface RefusalContext {
  host?: string;
  method?: string;
  cfRay?: string;
  accept?: string;
  agent?: string;
}

/**
 * Record a refusal, collapsing repeats. Returns the reference to show the visitor, or
 * `null` for a path we deliberately do not record (see BROWSER_NOISE) — those get a plain
 * 404 with nothing to look up, because there would be nothing to find.
 */
export function noteRefusal(rawPath: string, ctx: RefusalContext, reason: RefusalReason): string | null {
  const host = ctx.host ?? '';
  const path = String(rawPath ?? '')
    .split('?')[0]!
    .split('#')[0]!
    .slice(0, MAX_PATH);
  const cleanHost = String(host).slice(0, 120);
  // Kept out of the record entirely — see BROWSER_NOISE. The request is still refused;
  // it just is not something a masjid should have to read past.
  if (isBrowserNoise(path)) return null;

  const method = String(ctx.method ?? '').slice(0, 10).toUpperCase();
  const cfRay = String(ctx.cfRay ?? '').slice(0, 40);
  const wantsHtml = String(ctx.accept ?? '').includes('text/html');
  const agent = String(ctx.agent ?? '').slice(0, 120);

  const existing = recent.find((r) => r.path === path && r.reason === reason && r.host === cleanHost);
  if (existing) {
    existing.count += 1;
    existing.at = Date.now();
    // Keep the LATEST cf-ray: the useful one is the request the person is looking at now,
    // not the first of the day.
    if (cfRay) existing.cfRay = cfRay;
    return existing.ref;
  }

  const ref = crypto.randomBytes(3).toString('hex');
  recent.unshift({ at: Date.now(), ref, path, host: cleanHost, reason, method, cfRay, wantsHtml, agent, count: 1 });
  if (recent.length > MAX) recent.length = MAX;
  // One line per distinct path, not per request — the collapse above is what makes this
  // safe to log at all. The ref and cf-ray are here so the container log answers the same
  // question as the dashboard for anyone who prefers `docker logs`.
  log.warn(`Tunnel refused ${cleanHost}${path} [${reason}] ref=${ref} cf-ray=${cfRay || '-'} ${method}.`);
  return ref;
}

/** Newest first. For the LAN-only dashboard. */
export function recentRefusals(): Refusal[] {
  return recent.map((r) => ({ ...r }));
}

export function __clearRefusalsForTests(): void {
  recent.length = 0;
}
