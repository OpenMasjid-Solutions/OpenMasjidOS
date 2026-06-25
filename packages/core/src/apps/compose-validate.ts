// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Validates a docker-compose file before we ever run it (CLAUDE.md §11, §15).
 * Two outcomes:
 *   - parse failure  → hard error, nothing runs.
 *   - dangerous keys → list of human-readable warnings; the caller requires an
 *                      explicit "I understand the risk" acknowledgement.
 */
import YAML from 'yaml';

export interface ComposeCheck {
  /** Parsed object (only when the YAML is structurally valid). */
  parsed: Record<string, unknown> | null;
  /** Friendly descriptions of risky settings found. Empty = clean. */
  dangers: string[];
  /** Service names found, for display. */
  services: string[];
}

// Sensitive host directories. We flag a bind mount whose source equals OR is
// UNDER any of these (ancestor match), so e.g. /etc/cron.d and /root/.ssh are
// caught — not just the exact roots (the old exact-match was trivially bypassed).
const SENSITIVE_ROOTS = [
  '/etc',
  '/root',
  '/home',
  '/var',
  '/run',
  '/proc',
  '/sys',
  '/dev',
  '/boot',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  // The platform's own data dir on the host: app config/.env/secrets and the
  // admin credential store live here, so a stack must never bind-mount it
  // (security audit — symlink-into-the-sandbox planting).
  '/opt/openmasjid',
];

/** Pull the host-side source from a string or long-form volume entry, or null
 *  for named volumes / anonymous volumes / tmpfs (which aren't host binds). */
function bindSource(v: unknown): string | null {
  if (typeof v === 'string') {
    if (!v.includes(':')) return null; // anonymous volume (container path), not a host bind
    return v.split(':')[0];
  }
  if (v && typeof v === 'object') {
    const obj = v as { type?: string; source?: string };
    if (obj.type && obj.type !== 'bind') return null; // volume/tmpfs/npipe
    return obj.source ?? null;
  }
  return null;
}

/**
 * True if a value contains a docker-compose interpolation reference (`${VAR}`,
 * `${VAR:-default}` or `$VAR`) that isn't an escaped `$$`. We validate the RAW
 * text, but `docker compose up` interpolates first — so a dangerous setting
 * hidden behind a variable (e.g. `privileged: ${X:-true}`) would parse as a
 * harmless string here and only turn dangerous at runtime. We therefore treat
 * any interpolation in a security-sensitive field as a danger (fail closed).
 */
function hasInterpolation(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  return /\$(\{|[A-Za-z_])/.test(v.replace(/\$\$/g, ''));
}

/** Normalise to an array — compose accepts a scalar OR a list for several
 *  fields (cap_add, devices, security_opt, group_add…), and a scalar form was
 *  slipping past array-only checks. */
function toArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}

/** Flag a host path (from a service bind mount or a local-driver bind volume) if
 *  it is sensitive, the whole filesystem, the Docker socket, or escapes via "..". */
function checkHostPath(label: string, raw: string, dangers: string[]): void {
  const norm = String(raw).trim().replace(/\/+$/, '') || '/';
  if (/(^|\/)\.\.(\/|$)/.test(norm)) {
    dangers.push(`${label} mounts a path that escapes the app folder (it contains "..").`);
    return;
  }
  if (!norm.startsWith('/')) return; // relative path inside the app folder / named volume
  if (norm.endsWith('docker.sock') || norm === '/var/run/docker.sock') {
    dangers.push(`${label} mounts the Docker socket — that grants control of every container on the machine.`);
    return;
  }
  if (norm === '/') {
    dangers.push(`${label} mounts the entire host filesystem.`);
    return;
  }
  for (const root of SENSITIVE_ROOTS) {
    if (norm === root || norm.startsWith(root + '/')) {
      dangers.push(`${label} mounts a sensitive host path: ${norm}`);
      return;
    }
  }
}

function checkVolume(name: string, v: unknown, dangers: string[]): void {
  // A variable anywhere in a mount can't be statically verified — fail closed.
  if (typeof v === 'string' && hasInterpolation(v)) {
    dangers.push(`"${name}" uses a variable in a volume mount, so we can't check it's safe.`);
    return;
  }
  const raw = bindSource(v);
  if (!raw) return;
  if (hasInterpolation(raw)) {
    dangers.push(`"${name}" uses a variable in a volume mount, so we can't check it's safe.`);
    return;
  }
  checkHostPath(`"${name}"`, raw, dangers);
}

/**
 * Docker's built-in `local` driver can turn a "named" volume into a bind to an
 * arbitrary host path via driver_opts (o: bind / type: none / device: /etc). The
 * service mount then looks like an ordinary named volume and slips past
 * checkVolume, so we must inspect the top-level `volumes:` map directly. Without
 * this a community/custom stack could mount host / or /etc with no risk warning.
 */
function checkNamedVolumes(volumes: unknown, dangers: string[]): void {
  if (!volumes || typeof volumes !== 'object') return;
  for (const [name, def] of Object.entries(volumes as Record<string, unknown>)) {
    if (!def || typeof def !== 'object') continue;
    const opts = (def as { driver_opts?: unknown }).driver_opts;
    if (!opts || typeof opts !== 'object') continue;
    const o = String((opts as Record<string, unknown>).o ?? '');
    const type = String((opts as Record<string, unknown>).type ?? '');
    const device = (opts as Record<string, unknown>).device;
    const looksLikeBind =
      /bind/i.test(o) || type === 'none' || (typeof device === 'string' && device.startsWith('/'));
    if (!looksLikeBind) continue;
    if (hasInterpolation(device)) {
      dangers.push(`Volume "${name}" uses a variable for its host path, so we can't check it's safe.`);
      continue;
    }
    if (typeof device === 'string') checkHostPath(`Volume "${name}"`, device, dangers);
  }
}

export function checkCompose(text: string): ComposeCheck {
  let doc: unknown;
  try {
    // merge:true resolves YAML merge keys (`<<: *anchor`) the way `docker compose`
    // does, so a dangerous setting hidden in an anchor (e.g. `<<: *evil` carrying
    // privileged:true) lands on the service object where the checks below see it.
    // Without this, `<<` left the keys unmerged and the whole gate was bypassable.
    doc = YAML.parse(text, { merge: true });
  } catch (err) {
    throw new Error(
      `We couldn't read that Compose file. Please check it's valid YAML. (${(err as Error).message})`,
    );
  }
  if (!doc || typeof doc !== 'object') {
    throw new Error("That doesn't look like a Compose file — it has no services.");
  }

  const parsed = doc as Record<string, unknown>;
  const services = (parsed.services ?? {}) as Record<string, Record<string, unknown>>;
  const names = Object.keys(services);
  if (names.length === 0) {
    throw new Error('That Compose file defines no services, so there is nothing to run.');
  }

  const dangers: string[] = [];
  // `include:`/`extends:` pull in configuration from other files that we never
  // see here but `docker compose up` merges in — so they could smuggle dangerous
  // settings past this check. Refuse to vouch for them.
  if (parsed.include) {
    dangers.push('This file uses "include", which pulls in settings we can\'t check.');
  }
  for (const [name, svc] of Object.entries(services)) {
    if (!svc || typeof svc !== 'object') continue;

    if ('extends' in svc) {
      dangers.push(`"${name}" uses "extends", which merges settings we can't check.`);
    }
    // A `build:` context produces an image we never see — only pre-built, pinned
    // images can be vouched for (like include/extends, the built image could carry
    // anything). Catalog apps must ship a published image, not build on the box.
    if ('build' in svc) {
      dangers.push(`"${name}" builds its image from a "build" context we can't inspect — use a pre-built, pinned image instead.`);
    }
    // Sensitive flags hidden behind a variable can't be verified statically.
    for (const field of ['privileged', 'network_mode', 'pid', 'ipc', 'userns_mode', 'cgroup', 'uts'] as const) {
      if (hasInterpolation((svc as Record<string, unknown>)[field])) {
        dangers.push(`"${name}" uses a variable for "${field}", a security-sensitive setting we can't verify.`);
      }
    }

    if (svc.privileged === true) {
      dangers.push(`"${name}" runs in privileged mode (full access to this machine).`);
    }
    if (svc.network_mode === 'host') {
      dangers.push(`"${name}" uses host networking (shares the machine's network directly).`);
    }
    if (svc.pid === 'host') {
      dangers.push(`"${name}" shares the host process space.`);
    }
    if (svc.ipc === 'host') {
      dangers.push(`"${name}" shares the host IPC namespace.`);
    }
    if (svc.userns_mode === 'host') {
      dangers.push(`"${name}" disables user-namespace isolation (userns_mode: host).`);
    }
    if (svc.cgroup === 'host') {
      dangers.push(`"${name}" shares the host cgroup namespace.`);
    }
    if (svc.uts === 'host') {
      dangers.push(`"${name}" shares the host UTS namespace (can read/alter the machine's hostname).`);
    }
    // network_mode/pid/ipc can also JOIN another container's or service's
    // namespace (`container:<name>` / `service:<name>`) — e.g. joining the core's
    // own namespace for lateral movement. Flag those too, not just ":host".
    for (const field of ['network_mode', 'pid', 'ipc'] as const) {
      const v = (svc as Record<string, unknown>)[field];
      if (typeof v === 'string' && /^\s*(container|service):/i.test(v)) {
        dangers.push(`"${name}" joins another container's namespace (${field}: ${v.trim()}).`);
      }
    }
    const caps = toArr(svc.cap_add);
    if (caps.length > 0) {
      dangers.push(`"${name}" adds extra Linux capabilities: ${caps.map(String).join(', ')}.`);
    }
    if (toArr(svc.devices).length > 0) {
      dangers.push(`"${name}" passes host devices into the container.`);
    }
    if (toArr(svc.device_cgroup_rules).length > 0) {
      dangers.push(`"${name}" sets device cgroup rules (direct host device access).`);
    }
    // These two match on VALUE CONTENT, so a `${VAR}` token slips past the
    // literal check and only turns dangerous after `docker compose` interpolates
    // the user-controlled .env (e.g. security_opt: ["${X}"], X=seccomp=unconfined).
    // Fail closed on any interpolation here, mirroring the namespace fields above.
    if (toArr(svc.group_add).some((g) => hasInterpolation(g))) {
      dangers.push(`"${name}" uses a variable in "group_add", which we can't verify is safe.`);
    }
    if (toArr(svc.group_add).map(String).some((g) => /^(0|root|docker)$/i.test(g.trim()))) {
      dangers.push(`"${name}" joins a privileged host group (group_add: root/docker).`);
    }
    if (toArr(svc.security_opt).some((s) => hasInterpolation(s))) {
      dangers.push(`"${name}" uses a variable in "security_opt", a security-sensitive setting we can't verify.`);
    }
    if (toArr(svc.security_opt).map(String).some((s) => /unconfined/i.test(s))) {
      dangers.push(`"${name}" weakens kernel sandboxing (security_opt: unconfined).`);
    }
    for (const v of toArr(svc.volumes)) checkVolume(name, v, dangers);
  }

  // Top-level named volumes can be host binds via the local driver (see above).
  checkNamedVolumes(parsed.volumes, dangers);

  return { parsed, dangers, services: names };
}
