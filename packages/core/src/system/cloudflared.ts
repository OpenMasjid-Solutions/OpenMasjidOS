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
 * Routing (which hostname/path → which app) is configured in the Cloudflare
 * Zero-Trust dashboard for the tunnel; the platform exposes each app's intended
 * public URL to the app over the Fabric (GET /api/fabric/site). OS-managed
 * path-based ingress is a planned enhancement (see docs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from '../config';
import { composeUp, composeDown } from '../docker/compose';
import { docker } from '../docker/client';
import { getSettings } from '../settings/store';
import { getAppPath } from '../apps/manager';
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

export async function cloudflaredRunning(): Promise<boolean> {
  try {
    const info = await docker.getContainer(CONTAINER).inspect();
    return info.State?.Running === true;
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
    if (r.ok) log.info('Cloudflare tunnel is running.');
    else log.warn(`Cloudflare tunnel could not start: ${r.message}`);
  } else {
    await stopCloudflared();
  }
}

/** The public host the tunnel serves, e.g. "omos.example.org". The admin enters
 *  their root domain; we use the `omos` subdomain (the guided Cloudflare setup
 *  tells them to create exactly that public hostname). Empty if no domain. */
export function publicHost(): string {
  const cf = getSettings().cloudflare;
  const d = (cf.domain || '').replace(/^https?:\/\//, '').replace(/\/+$/, '').trim();
  if (!d) return '';
  return d.startsWith('omos.') ? d : `omos.${d}`;
}

/** Each app is served under a path (admin-configurable, default = its id). This is
 *  the Cloudflare public-hostname Path and the base path the app mounts under. */
export function appBasePath(appId: string): string {
  const cf = getSettings().cloudflare;
  return cf.enabled && cf.domain ? `/${getAppPath(appId)}` : '';
}

/** The public base URL an app is reachable at (Fabric `site`), or '' if remote
 *  access is off — e.g. "https://omos.example.org/donations". */
export function appPublicUrl(appId: string): string {
  const host = publicHost();
  const cf = getSettings().cloudflare;
  if (!cf.enabled || !host) return '';
  return `https://${host}${appBasePath(appId)}`;
}
