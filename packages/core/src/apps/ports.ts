/**
 * Web-UI port-conflict detection for app installs. Before an app starts we parse
 * the published host ports out of its compose, compare them against the ports
 * already in use on the machine, and (when the user picks new ones) rewrite the
 * compose's host ports. This prevents the classic "port is already allocated"
 * failure and lets the user fix it in the UI first (CLAUDE.md §11).
 */
import fs from 'node:fs';
import YAML from 'yaml';
import { docker } from '../docker/client';

const HOST_PROC = process.env.HOST_PROC ?? '/host/proc';
const CORE_PORT = Number.parseInt(process.env.OPENMASJID_PORT ?? '80', 10);

export interface PublishedPort {
  service: string;
  hostPort: number;
  containerPort: string;
}

export interface PortConflict {
  hostPort: number;
  service: string;
  /** A free port we suggest instead. */
  suggestion: number;
}

/** Parse one compose `ports:` entry into its published host port, or null when
 *  there's no fixed host port (container-only, ranges, or unparseable). */
function parsePortEntry(entry: unknown, service: string): PublishedPort | null {
  if (entry && typeof entry === 'object') {
    const o = entry as { published?: number | string; target?: number | string };
    if (o.published == null) return null;
    const hp = Number.parseInt(String(o.published), 10);
    return Number.isFinite(hp) ? { service, hostPort: hp, containerPort: String(o.target ?? '') } : null;
  }
  if (typeof entry === 'string' || typeof entry === 'number') {
    let s = String(entry).trim();
    if (s.includes('-')) return null; // port ranges — skip
    s = s.replace(/\/(tcp|udp)$/i, '');
    const parts = s.split(':');
    if (parts.length < 2) return null; // "80" → random host port, no conflict
    const hostStr = parts[parts.length - 2];
    const containerStr = parts[parts.length - 1];
    const hp = Number.parseInt(hostStr, 10);
    return Number.isFinite(hp) ? { service, hostPort: hp, containerPort: containerStr } : null;
  }
  return null;
}

export function extractPublishedPorts(composeText: string): PublishedPort[] {
  let doc: unknown;
  try {
    doc = YAML.parse(composeText);
  } catch {
    return [];
  }
  const services = ((doc as { services?: Record<string, unknown> })?.services ?? {}) as Record<string, { ports?: unknown }>;
  const out: PublishedPort[] = [];
  for (const [name, svc] of Object.entries(services)) {
    const ports = svc?.ports;
    if (!Array.isArray(ports)) continue;
    for (const p of ports) {
      const parsed = parsePortEntry(p, name);
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

/** Listening TCP ports on the machine (the LXC's netns), from host /proc. This
 *  catches both Docker-published ports and any native services. */
function readListeningPorts(): Set<number> {
  const ports = new Set<number>();
  for (const f of ['net/tcp', 'net/tcp6']) {
    try {
      const txt = fs.readFileSync(`${HOST_PROC}/${f}`, 'utf8');
      for (const line of txt.split('\n').slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 4) continue;
        if (cols[3] !== '0A') continue; // 0A = TCP LISTEN
        const portHex = cols[1].split(':')[1];
        if (portHex) {
          const p = Number.parseInt(portHex, 16);
          if (Number.isFinite(p) && p > 0) ports.add(p);
        }
      }
    } catch {
      /* not available (e.g. dev) */
    }
  }
  return ports;
}

async function dockerPublishedPorts(): Promise<Set<number>> {
  const used = new Set<number>();
  try {
    const list = await docker.listContainers({ all: false });
    for (const c of list) {
      for (const p of c.Ports ?? []) {
        if (p.PublicPort) used.add(p.PublicPort);
      }
    }
  } catch {
    /* ignore */
  }
  return used;
}

export async function portsInUse(): Promise<Set<number>> {
  const used = readListeningPorts();
  for (const p of await dockerPublishedPorts()) used.add(p);
  used.add(CORE_PORT);
  return used;
}

/** First free port at/after a base, kept out of the privileged range. */
function suggestPort(taken: Set<number>, base: number): number {
  let p = base < 1024 ? 8080 : base;
  while (taken.has(p)) p++;
  return p;
}

export async function findPortConflicts(
  composeText: string,
): Promise<{ published: PublishedPort[]; conflicts: PortConflict[] }> {
  const published = extractPublishedPorts(composeText);
  const used = await portsInUse();
  const taken = new Set(used);
  const seen = new Set<number>();
  const conflicts: PortConflict[] = [];
  for (const p of published) {
    const duplicate = seen.has(p.hostPort);
    seen.add(p.hostPort);
    if (used.has(p.hostPort) || duplicate) {
      const suggestion = suggestPort(taken, p.hostPort + 1);
      taken.add(suggestion);
      conflicts.push({ hostPort: p.hostPort, service: p.service, suggestion });
    }
  }
  return { published, conflicts };
}

function rewriteEntry(entry: unknown, remap: Map<number, number>): unknown {
  const parsed = parsePortEntry(entry, '');
  if (!parsed) return entry;
  const next = remap.get(parsed.hostPort);
  if (next == null) return entry;

  if (entry && typeof entry === 'object') {
    return { ...(entry as object), published: next };
  }
  let s = String(entry).trim();
  let proto = '';
  const pm = s.match(/\/(tcp|udp)$/i);
  if (pm) {
    proto = pm[0];
    s = s.slice(0, -proto.length);
  }
  const parts = s.split(':');
  if (parts.length < 2) return entry;
  parts[parts.length - 2] = String(next); // host side (works for host:ctr and ip:host:ctr)
  return parts.join(':') + proto;
}

/** Rewrite published host ports in the compose per the remap (oldHost → newHost). */
export function remapPorts(composeText: string, remap: Record<string, number>): string {
  const entries = Object.entries(remap)
    .map(([k, v]) => [Number.parseInt(k, 10), v] as const)
    .filter(([k, v]) => Number.isFinite(k) && Number.isFinite(v));
  if (entries.length === 0) return composeText;
  const map = new Map<number, number>(entries);

  const doc = YAML.parse(composeText) as { services?: Record<string, { ports?: unknown[] }> };
  const services = doc?.services ?? {};
  for (const svc of Object.values(services)) {
    if (svc && Array.isArray(svc.ports)) {
      svc.ports = svc.ports.map((e) => rewriteEntry(e, map));
    }
  }
  return YAML.stringify(doc);
}
