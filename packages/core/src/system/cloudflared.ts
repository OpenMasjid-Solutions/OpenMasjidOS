// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Cloudflare Tunnel (remote access). The admin pastes a tunnel TOKEN + their
 * domain once in Settings; the OS runs the official `cloudflared` image so the
 * masjid's apps are reachable from the internet at that domain — no port
 * forwarding, no static public IP (CLAUDE.md §4 remote-access helper).
 *
 * We run cloudflared as its own one-service compose project (reusing the same
 * compose wrapper apps use) on the HOST network, so it can reach each app's
 * published localhost port. The token is a SECRET: it lives only in
 * config/cloudflare/.env (chmod 600) and is never returned by any API or logged.
 *
 * Cloudflare's own dashboard sends the tunnel's public hostnames to the box's front
 * door (HTTP localhost:80); from there the OS routes each app by its path
 * (system/ingress.ts) and, when the admin switches it on, serves the dashboard at the
 * root of the same address (system/remote-admin.ts). Each app learns its public URL over
 * the Fabric (GET /api/fabric/site).
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from '../config';
import { composeUp, composeDown } from '../docker/compose';
import { docker } from '../docker/client';
import { getSettings } from '../settings/store';
import { getAppPath } from '../apps/manager';
import { isRouted } from './ingress';
import { log } from '../logger';

const CF_DIR = path.join(CONFIG_DIR, 'cloudflare');
const COMPOSE_PATH = path.join(CF_DIR, 'docker-compose.yml');
const ENV_PATH = path.join(CF_DIR, '.env');
const PROJECT = 'omos-cloudflared';
const CONTAINER = 'openmasjid-cloudflared';

// cloudflared on the host network so it can reach apps' published localhost ports.
// The token arrives via the env file; `--no-autoupdate` keeps the pinned image.
const COMPOSE_YML = `services:
  cloudflared:
    image: cloudflare/cloudflared:latest
    container_name: ${CONTAINER}
    command: tunnel --no-autoupdate run --token \${CF_TUNNEL_TOKEN}
    network_mode: host
    restart: unless-stopped
`;

function writeFiles(token: string): void {
  fs.mkdirSync(CF_DIR, { recursive: true });
  fs.writeFileSync(COMPOSE_PATH, COMPOSE_YML, 'utf8');
  fs.writeFileSync(ENV_PATH, `CF_TUNNEL_TOKEN=${token}\n`, 'utf8');
  try {
    fs.chmodSync(ENV_PATH, 0o600);
  } catch {
    /* best effort (non-POSIX dev) */
  }
}

function readToken(): string | null {
  try {
    const m = /^CF_TUNNEL_TOKEN=(.*)$/m.exec(fs.readFileSync(ENV_PATH, 'utf8'));
    const t = m?.[1]?.trim();
    return t ? t : null;
  } catch {
    return null;
  }
}

export function hasToken(): boolean {
  return readToken() != null;
}

/**
 * Does this `.env` text (from a backup being restored) hold the SAME tunnel token as
 * the one in use? Answers the question without handing the token to anyone.
 */
export function tunnelTokenMatches(envText: string | null): boolean {
  const current = readToken();
  if (!current || !envText) return false;
  const staged = /^CF_TUNNEL_TOKEN=(.*)$/m.exec(envText)?.[1]?.trim();
  return staged === current;
}

/** Is `token` the one in use? Answers without handing the token to anyone. */
export function isCurrentTunnelToken(token: string): boolean {
  return readToken() === token;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this, by its shape, a tunnel token as Cloudflare issues one — in exactly the form
 * cloudflared will read?
 *
 * cloudflared decodes it with Go's padded standard base64, which refuses a final block
 * without its "=" padding or with too much. Node's decoder accepts both, so this used to
 * pass tokens cloudflared then refused — so canonical form only: a whole number of
 * four-character blocks that encodes back to itself.
 */
function isTunnelToken(s: string): boolean {
  if (s.length < 32 || s.length > 4096 || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
  const bytes = Buffer.from(s, 'base64');
  if (bytes.toString('base64') !== s) return false;
  try {
    const o = JSON.parse(bytes.toString('utf8')) as Record<string, unknown> | null;
    return (
      typeof o === 'object' &&
      o !== null &&
      typeof o.a === 'string' &&
      o.a !== '' &&
      typeof o.t === 'string' &&
      UUID_RE.test(o.t) &&
      typeof o.s === 'string' &&
      o.s !== ''
    );
  } catch {
    return false;
  }
}

/**
 * The tunnel token in what was pasted — or a sentence saying it is not one.
 *
 * A token is base64 of a small JSON object: the account (`a`), the tunnel's id (`t`, a
 * UUID) and its secret (`s`). cloudflared refuses anything else and, under `restart:
 * unless-stopped`, retries for ever, so a bad paste took the dashboard's address and
 * every shared app offline while the platform logged "Cloudflare tunnel is running." —
 * the container was up, it just never connected. Two pastes are common: half a token (a
 * selection that stopped short) and Cloudflare's whole install command, which is what
 * its page shows. The command is reduced to its token; anything else is refused.
 *
 * And one is repaired: a token whose "=" padding was left behind. A double-click selects
 * letters and digits only, so it takes all of a token but that — and the padding carries
 * nothing, being fixed by the length — yet cloudflared refuses a token without it. It
 * used to be saved as it was, and the tunnel never came back.
 */
export function normalizeTunnelToken(input: string): string {
  const raw = input.trim();
  let candidate = raw;
  if (/\s/.test(raw)) {
    // `cloudflared tunnel run --token X`, `--token=X`, or `cloudflared service install X`.
    const m = /--token(?:=|\s+)(\S+)/.exec(raw) ?? /\bservice\s+install\s+(\S+)/.exec(raw);
    candidate = m?.[1] ?? '';
  }
  // Base64 pads to a whole number of four-character blocks: two characters short gets
  // "==", one short gets "=", and three short (a length of 4n+1) cannot be base64 at all.
  const bare = candidate.replace(/=+$/, '');
  const pad = ['', null, '==', '='][bare.length % 4];
  if (pad != null) candidate = bare + pad;
  if (pad == null || !isTunnelToken(candidate)) {
    throw new Error(
      "That doesn't look like a whole tunnel token. Please copy it again from Cloudflare — just the long part after “--token”.",
    );
  }
  return candidate;
}

/** Save the tunnel token (secret). Does not start it — the caller decides. */
export function setToken(token: string): void {
  if (!token.trim()) throw new Error('Paste your Cloudflare tunnel token.');
  writeFiles(token.trim());
}

/** Forget the token + tear the tunnel down. */
export async function clearTunnel(): Promise<void> {
  await stopCloudflared();
  try {
    fs.rmSync(ENV_PATH, { force: true });
  } catch {
    /* ignore */
  }
}

export async function startCloudflared(): Promise<{ ok: boolean; message?: string }> {
  const token = readToken();
  if (!token) return { ok: false, message: 'No tunnel token is set.' };
  writeFiles(token); // ensure compose + env are present/current
  const res = await composeUp(PROJECT, COMPOSE_PATH, ENV_PATH);
  if (res.code !== 0) {
    return { ok: false, message: res.stderr.trim().split('\n')[0] || 'cloudflared failed to start.' };
  }
  return { ok: true };
}

export async function stopCloudflared(): Promise<void> {
  if (!fs.existsSync(COMPOSE_PATH)) return;
  try {
    await composeDown(PROJECT, COMPOSE_PATH);
  } catch {
    /* best effort */
  }
}

/**
 * Is the tunnel's container actually up? Docker reports a container in its restart loop
 * as Running too — and a refused token is exactly that loop, so "Running" alone showed a
 * green "Tunnel is running." and sent the admin home with the dashboard's address and
 * every shared app offline.
 */
export function tunnelContainerUp(state: { Running?: boolean; Restarting?: boolean } | undefined): boolean {
  return state?.Running === true && state.Restarting !== true;
}

export async function cloudflaredRunning(): Promise<boolean> {
  try {
    const info = await docker.getContainer(CONTAINER).inspect();
    return tunnelContainerUp(info.State);
  } catch {
    return false;
  }
}

/** Reconcile the running tunnel with settings: up if enabled + token present,
 *  down otherwise. Called on boot and whenever the config changes. */
export async function ensureCloudflared(): Promise<void> {
  const cf = getSettings().cloudflare;
  if (cf.enabled && hasToken()) {
    const r = await startCloudflared();
    // "Started" is all compose can say: a token Cloudflare refuses leaves the container
    // restarting for ever (tunnelContainerUp), which "running" used to hide in this log.
    if (r.ok) log.info('Cloudflare tunnel started.');
    else log.warn(`Cloudflare tunnel could not start: ${r.message}`);
  } else {
    await stopCloudflared();
  }
}

/** The public host the tunnel serves — EXACTLY the hostname the admin entered
 *  (and created as a Cloudflare public hostname), e.g. "app.rifusa.org" or
 *  "omos.example.org". Used verbatim: forcing an `omos.` subdomain broke setups
 *  where the admin chose a different hostname (the tunnel then pointed at a
 *  host that doesn't exist, so every app path 404'd). Empty if no domain. */
export function publicHost(): string {
  const cf = getSettings().cloudflare;
  return (cf.domain || '').replace(/^https?:\/\//, '').replace(/\/+$/, '').trim();
}

/** Each app is served under a path (admin-configurable, default = its id). This is
 *  the Cloudflare public-hostname Path and the base path the app mounts under. */
export function appBasePath(appId: string): string {
  const cf = getSettings().cloudflare;
  return cf.enabled && cf.domain ? `/${getAppPath(appId)}` : '';
}

/** The public base URL an app is reachable at (Fabric `site`), or '' if remote
 *  access is off OR the OS isn't actually routing this app's path yet — e.g.
 *  "https://omos.example.org/donations". Gating on `isRouted` makes this value
 *  authoritative: if it's non-empty, the platform really serves that path to this
 *  app, so the app can advertise it without a fragile hairpin self-probe. */
export function appPublicUrl(appId: string): string {
  const host = publicHost();
  const cf = getSettings().cloudflare;
  if (!cf.enabled || !host || !isRouted(appId)) return '';
  return `https://${host}${appBasePath(appId)}`;
}

/** The public URL an app WILL be served at once exposed — for the convenience
 *  OPENMASJID_PUBLIC_URL env var written to the app's .env. Unlike appPublicUrl it
 *  is gated on the admin's `exposed` choice (not the live routing tick), so a
 *  freshly-exposed app gets a stable value immediately. '' when the tunnel is off,
 *  no domain, or the app isn't exposed. The LIVE source of truth stays
 *  GET /api/fabric/site (appPublicUrl). */
export function intendedPublicUrl(appId: string, exposed: boolean, path?: string): string {
  const host = publicHost();
  const cf = getSettings().cloudflare;
  if (!cf.enabled || !host || !exposed) return '';
  // `path`: an install decides its address before its meta.json exists to read it from.
  return `https://${host}${path ? `/${path}` : appBasePath(appId)}`;
}
