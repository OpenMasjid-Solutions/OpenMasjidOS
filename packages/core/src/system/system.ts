/**
 * Platform/system info for Settings → Advanced: network details, the AGPL
 * "Source code" link (CLAUDE.md §3 network clause), and the core update check.
 */
import os from 'node:os';
import { PORT, MACHINE_HOSTNAME } from '../config';
import { VERSION } from '../version';
import { log } from '../logger';

export const SOURCE_URL = 'https://github.com/hasan-ismail/OpenMasjidOS';

const VERSION_CHECK_URL =
  process.env.OPENMASJID_VERSION_CHECK_URL ??
  'https://raw.githubusercontent.com/hasan-ismail/OpenMasjidOS/master/VERSION';

export interface NetworkInfo {
  hostname: string;
  localDomain: string; // e.g. openmasjidos.local
  addresses: string[]; // LAN IPv4 addresses
  port: number;
}

export function networkInfo(): NetworkInfo {
  const addresses: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) addresses.push(ni.address);
    }
  }
  return {
    hostname: MACHINE_HOSTNAME,
    localDomain: `${MACHINE_HOSTNAME}.local`,
    addresses,
    port: PORT,
  };
}

export interface UpdateInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  sourceUrl: string;
}

/** Compare dotted numeric versions; returns true if b is strictly newer than a. */
function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (y > x) return true;
    if (y < x) return false;
  }
  return false;
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  let latest: string | null = null;
  try {
    const res = await fetch(VERSION_CHECK_URL, {
      headers: { accept: 'text/plain' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const raw = (await res.text()).trim();
      if (/^\d+\.\d+\.\d+/.test(raw)) latest = raw;
    }
  } catch (err) {
    log.warn('Update check failed (offline?).', err);
  }
  return {
    current: VERSION,
    latest,
    updateAvailable: latest != null && isNewer(VERSION, latest),
    sourceUrl: SOURCE_URL,
  };
}
