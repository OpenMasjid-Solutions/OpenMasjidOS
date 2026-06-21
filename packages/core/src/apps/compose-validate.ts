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
  const norm = String(raw).trim().replace(/\/+$/, '') || '/';
  // A bind source that climbs out of the app folder ("..") resolves to an
  // arbitrary host path at runtime even though it isn't an absolute path here.
  if (/(^|\/)\.\.(\/|$)/.test(norm)) {
    dangers.push(`"${name}" mounts a path that escapes the app folder (it contains "..").`);
    return;
  }
  if (!norm.startsWith('/')) return; // relative path inside the app folder / named volume

  if (norm.endsWith('docker.sock') || norm === '/var/run/docker.sock') {
    dangers.push(`"${name}" mounts the Docker socket — that grants control of every container on the machine.`);
    return;
  }
  if (norm === '/') {
    dangers.push(`"${name}" mounts the entire host filesystem.`);
    return;
  }
  for (const root of SENSITIVE_ROOTS) {
    if (norm === root || norm.startsWith(root + '/')) {
      dangers.push(`"${name}" mounts a sensitive host path: ${norm}`);
      return;
    }
  }
}

export function checkCompose(text: string): ComposeCheck {
  let doc: unknown;
  try {
    doc = YAML.parse(text);
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
    // Sensitive flags hidden behind a variable can't be verified statically.
    for (const field of ['privileged', 'network_mode', 'pid', 'ipc', 'userns_mode'] as const) {
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
    const caps = svc.cap_add;
    if (Array.isArray(caps) && caps.length > 0) {
      dangers.push(`"${name}" adds extra Linux capabilities: ${caps.map(String).join(', ')}.`);
    }
    if (Array.isArray(svc.devices) && svc.devices.length > 0) {
      dangers.push(`"${name}" passes host devices into the container.`);
    }
    const secopt = svc.security_opt;
    if (Array.isArray(secopt) && secopt.map(String).some((s) => /unconfined/i.test(s))) {
      dangers.push(`"${name}" weakens kernel sandboxing (security_opt: unconfined).`);
    }
    if (Array.isArray(svc.volumes)) {
      for (const v of svc.volumes) checkVolume(name, v, dangers);
    }
  }

  return { parsed, dangers, services: names };
}
