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
  /**
   * Dangers that can NEVER be acknowledged away — the stack is refused outright,
   * with no "I understand the risk" path. Reserved for settings that have no
   * legitimate app use and whose only effect is to breach ANOTHER app's data.
   */
  refusals: string[];
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

/** Docker Compose coerces several spellings of a boolean field to `true`
 *  (compose-go's toBoolean: true/yes/on/1/y, case-insensitive, plus the number
 *  1). A strict `=== true` check missed `privileged: yes|on|1|"true"`, which
 *  still starts the container privileged — so match the real coercion here. */
function isTruthyFlag(v: unknown): boolean {
  if (v === true) return true;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return /^(true|yes|on|1|y)$/i.test(v.trim());
  return false;
}

/** Top-level `secrets:`/`configs:` entries with a `file:` source are bind-mounted
 *  from the host into the container (non-swarm `docker compose`), so a `file:`
 *  pointing at the Docker socket, /etc/shadow, the platform data dir, etc. is an
 *  arbitrary host-file read. Check each file source exactly like a bind mount.
 *  (Relative, in-folder paths are allowed by checkHostPath's early return.) */
function checkFileSources(section: string, defs: unknown, dangers: string[]): void {
  if (!defs || typeof defs !== 'object') return;
  for (const [name, def] of Object.entries(defs as Record<string, unknown>)) {
    if (!def || typeof def !== 'object') continue;
    const file = (def as { file?: unknown }).file;
    if (typeof file !== 'string') continue;
    if (hasInterpolation(file)) {
      dangers.push(`${section} "${name}" uses a variable for its file path, so we can't check it's safe.`);
      continue;
    }
    checkHostPath(`${section} "${name}"`, file, dangers);
  }
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

/** The reserved Docker naming namespace. Every app's volumes and networks are
 *  `omos-<app>_<name>` (the compose project prefix), the platform's tunnel infra
 *  is `omos-cloudflared*`, and the core's own stack is `openmasjid*`
 *  (COMPOSE_PROJECT in install.sh). Nothing an app declares may attach to any of
 *  it — that is another app's data, or the core itself. */
const RESERVED_NAMESPACE_RE = /^(omos|openmasjid)[-_]/i;

/**
 * A compose file can point a "named" volume at an ALREADY-EXISTING Docker volume
 * in two ways, neither of which looks like a host bind:
 *   - `external: true`  → the volume name is used verbatim (the key, or `name:`),
 *   - `name: <literal>` → compose v2 skips the project prefix and uses that name.
 * So a stack could declare
 *     services: { x: { volumes: ["omos-students_data:/steal"] } }
 *     volumes:  { omos-students_data: { external: true } }
 * and read another app's database, because bindSource()/checkHostPath() only ever
 * look at HOST paths and a named volume returns early. Cross-app data access has
 * no legitimate use, so a target inside the reserved `omos-` namespace is a HARD
 * REFUSAL; any other pre-existing/renamed volume is merely unverifiable, so it
 * stays an acknowledgeable danger for the advanced custom/community paths.
 */
/**
 * Resolve what an `external:`/`name:` entry actually attaches to, for both the
 * `volumes:` and `networks:` top-level maps (they share this grammar exactly).
 * Returns null for an ordinary project-scoped entry that needs no checking.
 */
function externalTarget(key: string, def: unknown): { isExternal: boolean; target: string } | null {
  // `data:` / `data: {}` — an ordinary project-scoped entry. Nothing to check.
  if (!def || typeof def !== 'object') return null;
  const d = def as Record<string, unknown>;
  const ext = d.external;
  // `external: true|yes|1` (short form) or `external: { name: … }` (long form).
  const isExternal = isTruthyFlag(ext) || (!!ext && typeof ext === 'object');
  const named =
    typeof d.name === 'string'
      ? d.name
      : ext && typeof ext === 'object' && typeof (ext as { name?: unknown }).name === 'string'
        ? (ext as { name: string }).name
        : null;
  if (!isExternal && named == null) return null;
  // With `external: true` and no explicit name, the KEY is the real name.
  return { isExternal, target: String(named ?? key).trim() };
}

function checkExternalVolumes(volumes: unknown, dangers: string[], refusals: string[]): void {
  if (!volumes || typeof volumes !== 'object') return;
  for (const [key, def] of Object.entries(volumes as Record<string, unknown>)) {
    const found = externalTarget(key, def);
    if (!found) continue;
    const { isExternal, target } = found;
    if (hasInterpolation(target)) {
      dangers.push(`Volume "${key}" uses a variable for its Docker volume name, so we can't check whose data it would open.`);
      continue;
    }
    if (RESERVED_NAMESPACE_RE.test(target)) {
      refusals.push(`Volume "${key}" attaches to another OpenMasjid app's data (${target}).`);
      continue;
    }
    dangers.push(
      isExternal
        ? `Volume "${key}" attaches to an existing Docker volume on this machine (${target}) — we can't check what's inside it.`
        : `Volume "${key}" renames itself to "${target}" instead of using its own storage, so it can open data that isn't its own.`,
    );
  }
}

/**
 * The same attachment trick, one level over: a top-level `networks:` entry can
 * join an ALREADY-EXISTING Docker network.
 *
 *     networks: { victim: { external: true, name: omos-students_default } }
 *
 * Every app's compose project gets a network called `omos-<id>_default`, and the
 * platform's own stack is `openmasjid_default`. Joining one puts the container on
 * the same L2 as that app's (or the core's) containers, so it can talk STRAIGHT
 * to their UNPUBLISHED ports — no host port, no proxy, and completely around the
 * Fabric broker's manifest-grant authorization. Same isolation class as the
 * volume case above, so the same verdict: reserved namespace is a hard REFUSAL.
 *
 * Deliberately NOT flagged: a non-reserved external network. It has legitimate
 * advanced uses (joining an existing homelab network), and — unlike a volume —
 * making it a `danger` would make it hard-blocking on the catalog path
 * (`store.ts` refuses ANY danger with no acknowledge route), which could brick
 * install/update/restore for a shipped app. Revisit only with the live
 * catalog.json audited.
 */
function checkExternalNetworks(networks: unknown, dangers: string[], refusals: string[]): void {
  if (!networks || typeof networks !== 'object') return;
  for (const [key, def] of Object.entries(networks as Record<string, unknown>)) {
    const found = externalTarget(key, def);
    if (!found) continue;
    const { target } = found;
    if (hasInterpolation(target)) {
      dangers.push(`Network "${key}" uses a variable for its Docker network name, so we can't check what it would join.`);
      continue;
    }
    if (RESERVED_NAMESPACE_RE.test(target)) {
      refusals.push(`Network "${key}" joins another OpenMasjid app's private network (${target}).`);
    }
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
  const refusals: string[] = [];
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

    if (isTruthyFlag(svc.privileged)) {
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
    // `volumes_from` copies ALL of another container's mounts into this one. If it
    // names the core (`container:openmasjid-core`) the app inherits the mounted
    // Docker socket + the whole /data dir — full host root + every secret. No
    // legitimate OpenMasjid app needs it, so flag any occurrence.
    if (toArr(svc.volumes_from).length > 0) {
      dangers.push(`"${name}" uses "volumes_from", which copies another container's mounts — it can inherit the platform's Docker socket and data folder.`);
    }
    // `env_file` is read by `docker compose` itself, relative to the compose
    // file's directory (the app folder). An absolute path or one containing ".."
    // escapes that folder and can read another app's .env (its Fabric secret) or
    // the platform's config secrets (e.g. the Cloudflare token) straight into
    // this container's environment. In-folder relative files are fine.
    for (const ef of toArr(svc.env_file)) {
      const p =
        typeof ef === 'string'
          ? ef
          : ef && typeof ef === 'object'
            ? String((ef as { path?: unknown }).path ?? '')
            : '';
      if (!p) continue;
      if (hasInterpolation(p)) {
        dangers.push(`"${name}" uses a variable in "env_file", so we can't check it's safe.`);
        continue;
      }
      const norm = p.trim();
      if (norm.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(norm)) {
        dangers.push(`"${name}" reads an env file outside its own folder (${norm}) — that could expose another app's or the platform's secrets.`);
      }
    }
    for (const v of toArr(svc.volumes)) checkVolume(name, v, dangers);
  }

  // Top-level named volumes can be host binds via the local driver (see above).
  checkNamedVolumes(parsed.volumes, dangers);
  // …or point straight at ANOTHER APP's Docker volume via external:/name:.
  checkExternalVolumes(parsed.volumes, dangers, refusals);
  // The same attachment trick on networks — joins another app's private L2.
  checkExternalNetworks(parsed.networks, dangers, refusals);
  // Top-level file-based secrets/configs bind a host file into the container.
  checkFileSources('Secret', parsed.secrets, dangers);
  checkFileSources('Config', parsed.configs, dangers);

  return { parsed, dangers, refusals, services: names };
}
