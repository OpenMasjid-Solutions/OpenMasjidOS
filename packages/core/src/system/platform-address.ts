// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Where installed apps should reach the dashboard — the value baked into each
 * app's `OPENMASJID_BASE_URL`.
 *
 * THE BUG THIS EXISTS TO FIX: that address used to be resolved once, at install
 * time, and never again. Move the box to a different subnet and every installed
 * app keeps calling the old IP forever (`EHOSTUNREACH` on every Fabric call —
 * appearance, SSO introspection, email, alerts). The dashboard itself looked
 * fine, because Settings showed the browser's own URL rather than anything the
 * core knew.
 *
 * Two things made the old resolution unreliable even when it DID run:
 *
 *   1. Its primary input was the browser's `Host` header, so the value depended
 *      on how the admin happened to reach the dashboard that day. `localhost`,
 *      `openmasjidos.local` and the Cloudflare domain all passed the syntax
 *      check, and none of them resolve from inside an app container.
 *   2. Its fallback was `os.networkInterfaces()` — evaluated INSIDE the core
 *      container, which is bridge-networked. That enumerates the container's own
 *      172.x veth, not the host's LAN address. So the one code path that already
 *      tried to repair a stale value (post-restore) would have written an address
 *      no app could reach.
 *
 * So the order here deliberately prefers platform-controlled facts over anything
 * a request carries, and it NEVER returns an empty string when a usable value is
 * known: blanking the key would strip `OPENMASJID_BASE_URL` from every app at
 * once and break SSO for all of them simultaneously.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_DIR, PORT } from '../config';
import { readJson, writeJson } from '../util/json-store';
import { log } from '../logger';
import { ipIsPrivate } from '../util/net';

const STATE_FILE = path.join(CONFIG_DIR, 'platform-address.json');

interface AddressState {
  /** Last address we resolved and were happy with, e.g. "192.168.1.24". */
  lastKnownGood?: string;
  /** The most recent IP-literal Host an authenticated dashboard request used. */
  observedHost?: string;
  updatedAt?: string;
}

/** A bare IPv4 literal, optionally with a port. Deliberately NOT hostnames: a
 *  name that resolves in the admin's browser (mDNS, /etc/hosts, a public domain)
 *  usually does not resolve inside an app container. */
const IPV4_HOST_RE = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?$/;

/** Addresses that are never useful to an app in another container. */
function isUsableLanAddress(ip: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return false;
  if (ip.split('.').some((o) => Number(o) > 255)) return false;
  if (ip.startsWith('127.')) return false; // loopback is the container itself
  if (ip.startsWith('169.254.')) return false; // link-local autoconf
  if (ip === '0.0.0.0') return false;
  // It must be a PRIVATE address. This is the platform address handed to every app as
  // `OPENMASJID_BASE_URL`, and one source of it is the browser's `Host` header
  // (`observeDashboardHost`) — which is read in `createContext`, i.e. BEFORE
  // `protectedProcedure` checks the dashboard key, so the session cookie alone is enough to
  // influence it. A same-site app on another port is given that cookie by the browser, which
  // is the threat the dashboard key exists for.
  //
  // Without this test any bare IPv4 was accepted, including a PUBLIC one — so a caller
  // holding only the cookie could point every installed app's base URL at an address they
  // control, and the apps would then send their Fabric secrets there. Restricting it to
  // private space removes the exfiltration path; a public IP is never a useful answer to
  // "which address should an app on this LAN use to reach the platform" anyway.
  return ipIsPrivate(ip);
}

/**
 * Pull the bare IPv4 out of a `Host` header, if it is one we could hand an app.
 * The PORT is deliberately discarded — see `formatBaseUrl`.
 */
export function usableAppHost(host?: string | null): string | null {
  if (!host) return null;
  const m = IPV4_HOST_RE.exec(host.trim());
  if (!m) return null;
  return isUsableLanAddress(m[1]!) ? m[1]! : null;
}

/**
 * Build the URL from an address. The port comes from the core's own `PORT` (the
 * plain-HTTP front door, which is what apps talk to), NEVER from the browser's
 * Host header: on a TLS install the admin arrives on 443, and inheriting that
 * produced `http://ip:443` — plain HTTP against the TLS listener, broken from
 * the first request. Port 80 is left off so the value matches what install.sh
 * prints.
 */
function formatBaseUrl(addr: string): string {
  return PORT === 80 ? `http://${addr}` : `http://${addr}:${PORT}`;
}

function readState(): AddressState {
  return readJson<AddressState>(STATE_FILE, {});
}

function writeState(next: AddressState): void {
  try {
    writeJson(STATE_FILE, { ...next, updatedAt: new Date().toISOString() });
  } catch (err) {
    log.warn('Could not save the platform address.', err);
  }
}

/**
 * Record the address an authenticated admin actually reached the dashboard on.
 *
 * This is the self-healing input: an IP literal on a request that genuinely
 * arrived is proof the box answers at that address right now, which is exactly
 * what an app needs. It is safe because `/trpc` is registered ONLY on the LAN
 * dashboard listener and never on the tunnel-facing front door, and because a
 * name is rejected outright — an attacker cannot make an IP literal point at
 * their own host and still have the request reach us.
 *
 * Persists only on change, so this is cheap enough to call per request.
 */
export function observeDashboardHost(host?: string | null): void {
  const addr = usableAppHost(host);
  if (!addr) return;
  const state = readState();
  if (state.observedHost === addr) return;
  writeState({ ...state, observedHost: addr });
}

/** Host addresses as the CORE sees them. Inside a container these are the
 *  container's own, which is why this is the last resort, not the first. */
function interfaceAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal && isUsableLanAddress(ni.address)) out.push(ni.address);
    }
  }
  return out;
}

/** True when we are running inside a container (so interface addresses lie). */
function inContainer(): boolean {
  return fs.existsSync('/.dockerenv') || Boolean(process.env.OPENMASJID_HOST_IP);
}

/**
 * The address apps should use, resolved from the most trustworthy source
 * available. Returns null only when we genuinely have nothing.
 */
export function desiredAddress(): string | null {
  // 1. The installer knows the host's real LAN address (it prints it to the
  //    admin) and re-writes it on every install / update / repair. Namespace-proof.
  const fromInstaller = process.env.OPENMASJID_HOST_IP?.trim();
  if (fromInstaller && isUsableLanAddress(fromInstaller)) return fromInstaller;

  // 2. An address a real authenticated LAN request arrived on.
  const state = readState();
  if (state.observedHost && isUsableLanAddress(state.observedHost)) return state.observedHost;

  // 3. Our own interfaces — only meaningful when NOT containerised.
  if (!inContainer()) {
    const own = interfaceAddresses();
    if (own[0]) return own[0];
  }

  // 4. Whatever worked last. Better a stale-but-once-real address than nothing,
  //    because "nothing" means deleting the key from every app.
  if (state.lastKnownGood && isUsableLanAddress(state.lastKnownGood)) return state.lastKnownGood;
  return null;
}

/**
 * The full base URL for apps, or '' when undeterminable. An explicit
 * `OPENMASJID_BASE_URL` on the core always wins — that is the documented escape
 * hatch for reverse-proxy and multi-host installs.
 */
export function desiredBaseUrl(): string {
  const explicit = process.env.OPENMASJID_BASE_URL?.trim();
  if (explicit) return /^https?:\/\//i.test(explicit) ? explicit : `http://${explicit}`;
  const addr = desiredAddress();
  if (!addr) return '';
  const state = readState();
  if (state.lastKnownGood !== addr) writeState({ ...state, lastKnownGood: addr });
  return formatBaseUrl(addr);
}
