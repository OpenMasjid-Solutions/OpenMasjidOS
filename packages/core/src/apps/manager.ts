// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Installed-app lifecycle. Each app is a compose project `omos-<id>` with its
 * files under APPS_DIR/<id>/. meta.json is the source of truth for an app's
 * display info; live Docker state (running/ports) and orphan recovery come from
 * discovery. Together they honour the golden rule: a running app is never
 * dropped from the dashboard, even if its metadata is lost (CLAUDE.md §8.1).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { APPS_DIR, PORT } from '../config';
import { log } from '../logger';
import { writeJson, ensureDir } from '../util/json-store';
import {
  composeUp,
  composeDown,
  composeStop,
  composeStart,
  composeRestart,
  composeLogs,
  composePull,
  composeUpStream,
  type RunResult,
} from '../docker/compose';
import { discoverApps, discoverAppsResult, type DiscoveredApp } from '../docker/discovery';
import { checkCompose } from './compose-validate';
import { isPlatformManaged } from './managed';
import { assertAppFree, isUpdating, withUpdateLock } from '../system/update-lock';
import { findCatalogApp } from '../store/catalog';
import { ensureProxy, stopProxy, allocateHttpsPort, activeProxyPorts } from '../system/app-proxy';
// Runtime-only import (called inside functions, never at module load) — no cycle
// hazard with cloudflared.ts, which imports getAppPath from here.
import { intendedPublicUrl } from '../system/cloudflared';
import { isReservedPathSegment } from './paths';
import { suppressOfflineAlert } from '../system/offline-suppress';
import { desiredBaseUrl, usableAppHost } from '../system/platform-address';
import { isNewerVersion } from '../util/version';
import { STILL_DOWNLOADING, STILL_WORKING, withHeartbeat } from '../util/heartbeat';
import { getSettings } from '../settings/store';
import type { Channel } from '../system/channel';
import type {
  AppMeta,
  AppReview,
  InstalledApp,
  CatalogApp,
  DeclaredAlert,
  DeclaredCommand,
  DeclaredCommandArgument,
} from './types';

const projectOf = (id: string) => `omos-${id}`;
// App ids reserved for OpenMasjidOS's OWN infrastructure (run as omos-* compose
// projects but NOT user apps). Never listed on the dashboard; an older build may
// have recovered one into a meta.json, so listInstalled also cleans those up.
const RESERVED_APP_IDS = new Set(['cloudflared']);

/**
 * App ids we refuse to INSTALL, because the word already names the platform.
 *
 * A WhatsApp command's namespace IS the app id (`!students`), so an app called
 * `os` would shadow `!os`; and `omos:platform` is what the platform calls itself
 * when it invokes an app directly (fabric/proxy.ts).
 *
 * Deliberately NOT added to RESERVED_APP_IDS: that set means "stray platform
 * infrastructure", and listInstalled DELETES the directory of anything in it
 * (see the cleanup below). Reserving a word there would destroy a masjid's data
 * the moment someone shipped an app under it. Refusing at install is the whole
 * job; nothing here ever removes an existing directory.
 */
const RESERVED_ID_WORDS = new Set([
  'os',
  'omos',
  'openmasjid',
  'openmasjidos',
  'platform',
  'help',
  // Also in RESERVED_APP_IDS, and that is exactly why it has to be here too.
  // Membership there means listInstalled() `rmSync`s the directory — so without
  // this line a catalog entry with `id: cloudflared` installs perfectly happily and
  // then has its compose.yml, its .env (holding its Fabric secret) and its meta.json
  // deleted out from under a still-running container, while discovery hides it from
  // the dashboard so nobody can see what happened. Refusing at install is free;
  // nothing on this path deletes anything.
  'cloudflared',
]);

/** True if this id names the platform rather than an app. Refuse it at install. */
export function isReservedAppId(id: string): boolean {
  return RESERVED_ID_WORDS.has(id.toLowerCase());
}

// Defense-in-depth: ids are already validated at every API/catalog boundary,
// but never let a path escape APPS_DIR even if a bad id slips through.
const appDir = (id: string) => {
  const dir = path.join(APPS_DIR, id);
  if (dir !== APPS_DIR && !dir.startsWith(APPS_DIR + path.sep)) {
    throw new Error(`Refusing to use an app path outside the apps directory: ${id}`);
  }
  return dir;
};
const composePath = (id: string) => path.join(appDir(id), 'compose.yml');
/** An app's on-disk compose path, for callers that need to re-vet it before
 *  starting it (system/address-monitor.ts). */
export const composePathOf = composePath;
const envPath = (id: string) => path.join(appDir(id), '.env');
const metaPath = (id: string) => path.join(appDir(id), 'meta.json');

/**
 * Installed apps whose recorded channel differs from the selected one — i.e. the
 * ones a channel switch still has to move. Drives the "Update all to <channel>"
 * prompt and the per-app pending markers.
 */
export function appsPendingChannel(): { id: string; name: string; from: Channel }[] {
  const target = getSettings().updateChannel;
  const out: { id: string; name: string; from: Channel }[] = [];
  for (const { id, meta } of listMetas()) {
    // Only catalog apps track a channel: community and custom apps come from a URL
    // or a pasted compose the admin owns, so the OS has no other version of them
    // to offer and must not claim they are "pending".
    if (!meta || meta.kind !== 'catalog') continue;
    const from = meta.channel ?? 'main';
    if (from !== target) out.push({ id, name: meta.name, from });
  }
  return out;
}

function prettify(id: string): string {
  return id
    .replace(/^custom-/, '')
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function loadMeta(id: string): AppMeta | null {
  try {
    if (!fs.existsSync(metaPath(id))) return null;
    return JSON.parse(fs.readFileSync(metaPath(id), 'utf8')) as AppMeta;
  } catch {
    return null;
  }
}

function saveMeta(meta: AppMeta): void {
  writeJson(metaPath(meta.id), meta);
  invalidateFabricIndex(); // a secret/capability may have changed
}

// A valid env-var name. We refuse anything else as a KEY so a newline/`=` in a
// setting key can't inject extra lines into the .env (security audit).
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Fabric broker capability + grant shapes (mirror OpenMasjidAPPS validate-compose /
// build-catalog). A capability is a kebab slug; a grant is "<app-id>/<capability>".
const CAPABILITY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const GRANT_RE = /^[a-z0-9][a-z0-9-]{0,79}\/[a-z0-9][a-z0-9-]{0,39}$/;

/** A value can never span lines: CR/LF become a space. */
const oneLine = (v: string | undefined): string => String(v ?? '').replace(/[\r\n]+/g, ' ');

/** What `docker compose` reads differently in an UNQUOTED .env value: `$` interpolates,
 *  ` #` starts a comment, quotes and backslashes are syntax, and edge whitespace is trimmed. */
const NEEDS_QUOTES = /[$#"'\\]|^[\s\u0085]|[\s\u0085]$/;

/**
 * A literal value as .env text that compose reads back unchanged. A plain value is left
 * exactly as it is; anything else is double-quoted with `\` and `"` escaped and `$`
 * doubled (compose-go's dotenv rules: double quotes interpolate, and `$$` is one `$`).
 */
export function encodeEnvValue(value: string): string {
  const v = oneLine(value);
  if (!NEEDS_QUOTES.test(v)) return v;
  return `"${v.replace(/[\\"$]/g, (c) => (c === '$' ? '$$' : `\\${c}`))}"`;
}

/** The inverse of encodeEnvValue. A value the platform did not quote is returned as written. */
export function decodeEnvValue(raw: string): string {
  const quoted = /^"(.*)"$/.exec(raw);
  if (!quoted) return raw;
  return quoted[1].replace(/\\([\\"])|\$\$/g, (_seq, escaped?: string) => escaped ?? '$');
}

/** The key a .env line sets, or null for a blank line or a comment. */
function envKeyOf(line: string): string | null {
  const t = line.trim();
  if (!t || t.startsWith('#')) return null;
  const i = t.indexOf('=');
  return i > 0 ? t.slice(0, i) : null;
}

function readEnvLines(id: string): string[] {
  try {
    return fs.readFileSync(envPath(id), 'utf8').split('\n');
  } catch {
    return []; // no env file yet
  }
}

/**
 * Write an app's .env afresh, at install. `values` are literal (a setting as typed, a
 * platform address) and are encoded; `pasted` is a custom app's .env as the admin pasted
 * it — .env text already — and is written as given, as it always has been.
 */
function writeEnvFile(id: string, values: Record<string, string>, pasted: Record<string, string> = {}): void {
  const lines: string[] = [];
  for (const [k, v] of Object.entries({ ...pasted, ...values })) {
    if (!ENV_KEY_RE.test(k)) {
      log.warn(`Ignoring invalid env key for ${id}: ${JSON.stringify(k)}`);
      continue;
    }
    lines.push(`${k}=${Object.hasOwn(values, k) ? encodeEnvValue(v) : oneLine(v)}`);
  }
  fs.writeFileSync(envPath(id), lines.join('\n') + '\n', 'utf8');
}

/**
 * Set some keys of an app's .env (`undefined` removes one) and leave every other line
 * exactly as it is, so a platform rewrite never changes what the app reads elsewhere.
 */
function updateEnvFile(id: string, changes: Record<string, string | undefined>): void {
  const changed = new Map(Object.entries(changes));
  const placed = new Set<string>();
  const lines: string[] = [];
  const place = (key: string): void => {
    placed.add(key);
    const value = changed.get(key);
    if (value !== undefined) lines.push(`${key}=${encodeEnvValue(value)}`);
  };
  for (const line of readEnvLines(id)) {
    const key = envKeyOf(line);
    if (key !== null && changed.has(key)) {
      if (!placed.has(key)) place(key); // where it was, and only once
    } else if (line) {
      lines.push(line);
    }
  }
  for (const key of changed.keys()) if (!placed.has(key)) place(key);
  fs.writeFileSync(envPath(id), lines.join('\n') + '\n', 'utf8');
}

/** An app's .env as a map of values. */
function readEnvFile(id: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readEnvLines(id)) {
    const key = envKeyOf(line);
    if (key !== null) out[key] = decodeEnvValue(line.trim().slice(key.length + 1));
  }
  return out;
}

/**
 * The platform base URL handed to apps (for SSO introspection and every other
 * Fabric call). The resolution order lives in system/platform-address.ts — see
 * that file for why the request's Host header is no longer trusted first and why
 * this must never resolve to an empty string.
 */
function resolveBaseUrl(reqHost?: string | null): string {
  // system/platform-address.ts owns this decision now (explicit env → installer
  // address → observed authenticated LAN host → interfaces → last-known-good).
  // The request Host is only a last resort, and only as a bare IP: the old order
  // trusted it FIRST, which is how `openmasjidos.local` / `localhost` / the
  // tunnel domain — none of them resolvable from inside an app container — ended
  // up baked into app .env files.
  const desired = desiredBaseUrl();
  if (desired) return desired;
  const fromRequest = usableAppHost(reqHost);
  if (fromRequest) return `http://${fromRequest}${PORT === 80 ? '' : `:${PORT}`}`;
  return '';
}

/**
 * Rewrite `OPENMASJID_BASE_URL` in every installed app's .env to the current
 * platform address, and report which apps need restarting to pick it up.
 *
 * Mirrors `reconcilePublicUrls`: only that one line of the .env changes, so the app's
 * own settings and `OPENMASJID_APP_SECRET` survive untouched. Never writes an empty
 * value — that would de-authorise every Fabric app at once.
 */
export function reconcileBaseUrls(): { changed: string[]; needRestart: string[] } {
  const changed: string[] = [];
  const needRestart: string[] = [];
  const want = desiredBaseUrl();
  if (!want) return { changed, needRestart };
  for (const { id, meta } of listMetas()) {
    const env = readEnvFile(id);
    // Write when the app already has the key, or when it plainly wants one (its
    // compose interpolates it, or it holds a Fabric secret) — an app installed
    // while the address was unresolvable would otherwise stay broken forever.
    let compose = '';
    try {
      compose = fs.readFileSync(composePath(id), 'utf8');
    } catch {
      /* no compose on disk (orphan) — the env check below still applies */
    }
    const wantsIt =
      env.OPENMASJID_BASE_URL !== undefined ||
      compose.includes('OPENMASJID_BASE_URL') ||
      meta?.ssoSecret !== undefined;
    if (!wantsIt) continue;
    if (env.OPENMASJID_BASE_URL === want) continue;
    updateEnvFile(id, { OPENMASJID_BASE_URL: want });
    changed.push(id);
    // A restart is only useful if the container actually reads the var through
    // compose interpolation; otherwise the new .env is picked up next time anyway.
    if (compose.includes('OPENMASJID_BASE_URL')) needRestart.push(id);
  }
  return { changed, needRestart };
}

/** Constant-time string compare (avoids leaking the secret via timing). */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export interface FabricApp {
  id: string;
  /** Display name — used to attribute relayed notifications (server-resolved, so
   *  an app can't spoof being another app in the masjid's Slack/Discord). */
  name: string;
  sso: boolean;
  notify: boolean;
  stripe: boolean;
  domain: boolean;
  /** True if the app may send email via POST /api/fabric/email. */
  email: boolean;
  /** True if the app may send WhatsApp via POST /api/fabric/whatsapp. */
  whatsapp: boolean;
  /** Broker capabilities this app SERVES (for target-side authorization). */
  provides: string[];
  /** Broker grants this app may CALL, "<target-app-id>/<capability>". */
  consumes: string[];
}

interface FabricEntry extends FabricApp {
  ssoSecret: string;
  /** The alert ids its manifest declared — the gate for POST /api/fabric/alert. */
  alerts: string[];
}

// In-memory index of issued Fabric secrets. /api/fabric/* is reachable
// unauthenticated (it's secret-gated), so resolving the secret must NOT scan the
// apps dir from disk on every request — that synchronous fs work on the event
// loop was a DoS lever (security audit). We build the index once and rebuild it
// only when an app is installed / updated / removed.
let fabricCache: FabricEntry[] | null = null;

/** Drop the cached Fabric secret index; rebuilt lazily on next lookup. */
export function invalidateFabricIndex(): void {
  fabricCache = null;
}

function fabricEntries(): FabricEntry[] {
  if (fabricCache) return fabricCache;
  const out: FabricEntry[] = [];
  // Platform infrastructure ids are NOT skipped here, unlike every other listing.
  for (const { id, meta } of listMetas({ includeInfra: true })) {
    if (meta?.ssoSecret) {
      out.push({
        id,
        name: meta.name ?? id,
        sso: meta.sso === true,
        notify: meta.notify === true,
        stripe: meta.stripe === true,
        domain: meta.domain === true,
        email: meta.email === true,
        whatsapp: meta.whatsapp === true,
        provides: Array.isArray(meta.fabricProvides) ? meta.fabricProvides : [],
        consumes: Array.isArray(meta.fabricConsumes) ? meta.fabricConsumes : [],
        ssoSecret: meta.ssoSecret,
        // Defensive: one malformed record must not break every app's Fabric lookups.
        alerts: Array.isArray(meta.appAlerts) ? meta.appAlerts.map((a) => a?.id).filter((x) => typeof x === 'string') : [],
      });
    }
  }
  fabricCache = out;
  return out;
}

/**
 * Resolve an installed app by the per-app Fabric secret it presents (constant-
 * time), returning its identity + which Fabric capabilities it holds. The SSO
 * endpoint requires `.sso`, the notify endpoint requires `.notify` — so one
 * installed app can't act as another, and an app can't use a capability it didn't
 * opt into. Only apps that opted into a Fabric capability are issued a secret, so
 * this returns null for everything else (security audit #1).
 */
export function findFabricApp(secret: string | undefined | null): FabricApp | null {
  if (!secret || secret.length < 16) return null;
  for (const e of fabricEntries()) {
    if (safeEqual(e.ssoSecret, secret)) return stripSecret(e);
  }
  return null;
}

/** Drop the raw secret from a FabricEntry before returning it to callers. */
function stripSecret(e: FabricEntry): FabricApp {
  return {
    id: e.id,
    name: e.name,
    sso: e.sso,
    notify: e.notify,
    stripe: e.stripe,
    domain: e.domain,
    email: e.email,
    whatsapp: e.whatsapp,
    provides: e.provides,
    consumes: e.consumes,
  };
}

/** Look up a Fabric app by id (capabilities + broker grants), or null. Used by the
 *  app-to-app broker to authorize the TARGET side (does it `provide` the capability?). */
export function getFabricApp(id: string): FabricApp | null {
  const e = fabricEntries().find((x) => x.id === id);
  return e ? stripSecret(e) : null;
}

/** The per-app Fabric secret for an app id — SERVER-SIDE ONLY. The broker presents
 *  the TARGET's own secret so the target knows the call truly came from the
 *  platform (only the platform holds it). NEVER expose this over any API. */
export function getFabricSecret(id: string): string | null {
  return fabricEntries().find((x) => x.id === id)?.ssoSecret ?? null;
}

/** True if an app opted into ANY Fabric capability that needs a per-app secret —
 *  sso / notifications / stripe / domain, OR the app-to-app broker (provides or
 *  consumes). Used by both install and update so a fabric-only app is issued a
 *  secret exactly like an sso app. */
export function needsFabricSecret(caps: {
  sso?: boolean;
  notify?: boolean;
  stripe?: boolean;
  domain?: boolean;
  email?: boolean;
  whatsapp?: boolean;
  provides?: string[];
  consumes?: string[];
  alerts?: unknown[];
  commands?: unknown[];
}): boolean {
  return Boolean(
    caps.sso ||
      caps.notify ||
      caps.stripe ||
      caps.domain ||
      caps.whatsapp ||
      caps.email ||
      (caps.provides && caps.provides.length) ||
      (caps.consumes && caps.consumes.length) ||
      (caps.alerts && caps.alerts.length) ||
      // Required, not cosmetic: the platform proves a command call is genuine by
      // presenting the app's OWN secret, so a commands-only app without one could
      // never be called at all.
      (caps.commands && caps.commands.length),
  );
}

/** Validate + normalise a catalog app's `alerts:` list (manifest). Throws a
 *  friendly error on a malformed shape; returns the cleaned list. Mirrors the
 *  OpenMasjidAPPS catalog-build validator. */
export function parseAlerts(alerts: unknown, appId: string): DeclaredAlert[] {
  if (alerts == null) return [];
  if (!Array.isArray(alerts)) throw new Error(`"${appId}": "alerts" must be a list.`);
  const out: DeclaredAlert[] = [];
  const seen = new Set<string>();
  for (const a of alerts) {
    const id = a && typeof a === 'object' ? (a as { id?: unknown }).id : undefined;
    const label = a && typeof a === 'object' ? (a as { label?: unknown }).label : undefined;
    const description = a && typeof a === 'object' ? (a as { description?: unknown }).description : undefined;
    if (typeof id !== 'string' || !CAPABILITY_RE.test(id)) {
      throw new Error(`"${appId}": each alert needs a kebab-case "id" (a–z, 0–9, -).`);
    }
    if (typeof label !== 'string' || !label.trim()) {
      throw new Error(`"${appId}": alert "${id}" needs a "label".`);
    }
    if (seen.has(id)) throw new Error(`"${appId}": duplicate alert id "${id}".`);
    seen.add(id);
    out.push({
      id,
      label: label.trim().slice(0, 80),
      description: typeof description === 'string' ? description.trim().slice(0, 200) : undefined,
    });
  }
  return out;
}

/** Every installed app's declared alert types — for the granular Settings list. */
export function listAppAlerts(): { appId: string; appName: string; alerts: DeclaredAlert[] }[] {
  const out: { appId: string; appName: string; alerts: DeclaredAlert[] }[] = [];
  for (const { id, meta } of listMetas()) {
    if (meta && Array.isArray(meta.appAlerts) && meta.appAlerts.length) {
      out.push({ appId: id, appName: meta.name ?? id, alerts: meta.appAlerts });
    }
  }
  return out;
}

/** Did this app declare `alertId` in its manifest? (Gate for POST /api/fabric/alert.)
 *  Read from the Fabric index: declaring an alert issues the secret the caller proved. */
export function appDeclaresAlert(appId: string, alertId: string): boolean {
  return fabricEntries().find((e) => e.id === appId)?.alerts.includes(alertId) ?? false;
}

/**
 * The capability name the platform uses to call an app's declared commands. It is
 * RESERVED: an app may not put it in `fabric.provides`, because that would let
 * another app reach the very same /fabric/commands/run handler through the broker
 * (`consumes: ["<app>/commands"]`) and turn an admin-only surface into an
 * app-to-app one. Same path prefix, different trust boundary.
 */
export const COMMANDS_CAPABILITY = 'commands';

/** Command ids that would collide with the platform's own words in a chat. */
const RESERVED_COMMAND_IDS = new Set(['help', 'yes', 'no', 'cancel', 'stop']);
/** A numbered menu longer than this stops being a menu and stops fitting a reply. */
const MAX_APP_COMMANDS = 12;

/**
 * Validate + normalise a catalog app's `commands:` list (manifest). Throws a
 * friendly error on a malformed shape; returns the cleaned list. Mirrors the
 * OpenMasjidAPPS catalog-build validator — keep the two in step, or "passes the
 * catalog build" stops meaning "installs cleanly".
 */
export function parseCommands(commands: unknown, appId: string): DeclaredCommand[] {
  if (commands == null) return [];
  if (!Array.isArray(commands)) throw new Error(`"${appId}": "commands" must be a list.`);
  if (commands.length > MAX_APP_COMMANDS) {
    throw new Error(`"${appId}": an app can offer at most ${MAX_APP_COMMANDS} commands.`);
  }
  const out: DeclaredCommand[] = [];
  const seen = new Set<string>();
  for (const c of commands) {
    const obj = c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : null;
    if (!obj) throw new Error(`"${appId}": each command must be an object with an "id" and a "label".`);
    const { id, label, description, argument, confirm } = obj;

    if (typeof id !== 'string' || !CAPABILITY_RE.test(id)) {
      throw new Error(`"${appId}": each command needs a kebab-case "id" (a–z, 0–9, -).`);
    }
    // An all-digit id would be ambiguous with a menu selection: `!display 2` could
    // mean "the second option" or "the command called 2". The parser's grammar
    // depends on that being impossible.
    if (/^\d+$/.test(id)) throw new Error(`"${appId}": command id "${id}" cannot be all digits.`);
    if (RESERVED_COMMAND_IDS.has(id)) {
      throw new Error(`"${appId}": command id "${id}" is reserved by OpenMasjidOS.`);
    }
    if (seen.has(id)) throw new Error(`"${appId}": duplicate command id "${id}".`);
    seen.add(id);

    if (typeof label !== 'string' || !label.trim()) {
      throw new Error(`"${appId}": command "${id}" needs a "label".`);
    }
    if (description != null && typeof description !== 'string') {
      throw new Error(`"${appId}": command "${id}" has a "description" that is not text.`);
    }
    if (confirm != null && typeof confirm !== 'boolean') {
      throw new Error(`"${appId}": command "${id}" has a "confirm" that is not true or false.`);
    }

    // Deliberately strict, and NOT coerced. `argument: true` reads like it means
    // "takes an argument" but carries no label, and silently dropping it would
    // throw away whatever a volunteer typed while telling them it worked.
    let arg: DeclaredCommandArgument | undefined;
    if (argument != null) {
      if (typeof argument !== 'object' || Array.isArray(argument)) {
        throw new Error(`"${appId}": command "${id}" — "argument" must be an object with a "label".`);
      }
      const a = argument as Record<string, unknown>;
      if (typeof a.label !== 'string' || !a.label.trim()) {
        throw new Error(`"${appId}": command "${id}" — "argument" needs a "label".`);
      }
      if (a.required != null && typeof a.required !== 'boolean') {
        throw new Error(`"${appId}": command "${id}" — "argument.required" must be true or false.`);
      }
      arg = {
        label: a.label.trim().slice(0, 40),
        ...(a.required === false ? { required: false } : {}),
      };
    }

    out.push({
      id,
      label: label.trim().slice(0, 80),
      description: typeof description === 'string' ? description.trim().slice(0, 200) : undefined,
      argument: arg,
      confirm: confirm === true ? true : undefined,
    });
  }
  return out;
}

/** Every installed app's declared commands — for the WhatsApp menu and the
 *  Settings matrix. Meta-only and synchronous: it sits on the path of an
 *  arriving message, so it must not wait on Docker. */
export function listAppCommands(): { appId: string; appName: string; commands: DeclaredCommand[] }[] {
  const out: { appId: string; appName: string; commands: DeclaredCommand[] }[] = [];
  for (const { id, meta } of listMetas()) {
    if (meta && Array.isArray(meta.appCommands) && meta.appCommands.length) {
      out.push({ appId: id, appName: meta.name ?? id, commands: meta.appCommands });
    }
  }
  return out;
}

/** Did this app declare `commandId`? The per-call gate, like appDeclaresAlert —
 *  returns the command itself, because the caller needs its argument/confirm. */
export function getAppCommand(appId: string, commandId: string): DeclaredCommand | null {
  const meta = loadMeta(appId);
  return meta?.appCommands?.find((c) => c.id === commandId) ?? null;
}

/** Every installed app's id and name, straight from meta.json — synchronous and
 *  Docker-free. Use this when you need the ROSTER (which apps exist); use
 *  listInstalled() when you need running state or ports. */
export function listMetaSummaries(): { id: string; name: string; kind: AppMeta['kind'] }[] {
  const out: { id: string; name: string; kind: AppMeta['kind'] }[] = [];
  for (const { id, meta } of listMetas()) {
    if (meta) out.push({ id, name: meta.name ?? id, kind: meta.kind });
  }
  return out;
}

/**
 * Validate + normalise a catalog app's `fabric` block. Throws a friendly error on a
 * malformed shape (so an install/update surfaces it), returns the flattened grants.
 * Kept manual (no schema dep) to mirror the OpenMasjidAPPS catalog-build validator.
 */
export function parseFabric(fabric: unknown, appId: string): { provides: string[]; consumes: string[] } {
  if (fabric == null) return { provides: [], consumes: [] };
  if (typeof fabric !== 'object' || Array.isArray(fabric)) {
    throw new Error(`"${appId}": the fabric section must be an object with "provides" and/or "consumes".`);
  }
  const f = fabric as { provides?: unknown; consumes?: unknown };
  const provides: string[] = [];
  if (f.provides != null) {
    if (!Array.isArray(f.provides)) throw new Error(`"${appId}": fabric.provides must be a list.`);
    for (const p of f.provides) {
      const cap = p && typeof p === 'object' ? (p as { capability?: unknown }).capability : undefined;
      if (typeof cap !== 'string' || !CAPABILITY_RE.test(cap)) {
        throw new Error(`"${appId}": each fabric.provides entry needs a kebab-case "capability" (a–z, 0–9, -).`);
      }
      // Reserved: /fabric/commands/run is an ADMIN surface the platform calls. If an
      // app could advertise it as a broker capability, another app could reach the
      // same handler with consumes:["<app>/commands"]. Use the manifest `commands:`
      // block instead — it is the same endpoint under a different trust boundary.
      if (cap === COMMANDS_CAPABILITY) {
        throw new Error(
          `"${appId}": "${COMMANDS_CAPABILITY}" is reserved for admin commands — declare them under "commands:", not fabric.provides.`,
        );
      }
      provides.push(cap);
    }
  }
  const consumes: string[] = [];
  if (f.consumes != null) {
    if (!Array.isArray(f.consumes)) throw new Error(`"${appId}": fabric.consumes must be a list.`);
    for (const c of f.consumes) {
      if (typeof c !== 'string' || !GRANT_RE.test(c)) {
        throw new Error(`"${appId}": each fabric.consumes entry must be "<app-id>/<capability>" (kebab-case).`);
      }
      consumes.push(c.trim());
    }
  }
  return { provides, consumes };
}

/**
 * OpenMasjidOS Fabric env, injected into every installed app (CLAUDE.md app
 * contract). Presentation is handed off in the browser via the Open URL; these
 * let an app's backend find the platform for OPTIONAL single sign-on (forward
 * the omos_session cookie to `${OPENMASJID_BASE_URL}/api/auth/session`). Apps
 * that don't use them simply ignore them. Override the base with the
 * OPENMASJID_BASE_URL env on the core.
 */
function platformEnv(
  id: string,
  baseUrl?: string | null,
  ssoSecret?: string,
): Record<string, string> {
  const env: Record<string, string> = { OPENMASJID_APP_ID: id };
  const base = resolveBaseUrl(baseUrl);
  if (base) env.OPENMASJID_BASE_URL = base;
  // Only SSO-capable apps get a secret — it's what lets them (and only them)
  // introspect the dashboard session at ${OPENMASJID_BASE_URL}/api/auth/session.
  if (ssoSecret) env.OPENMASJID_APP_SECRET = ssoSecret;
  return env;
}

function listMetaIds(): string[] {
  try {
    return fs
      .readdirSync(APPS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((id) => fs.existsSync(metaPath(id)));
  } catch {
    return [];
  }
}

/**
 * Every app that has a meta.json, with its record (null when the file cannot be read).
 * OpenMasjidOS's own infrastructure ids (RESERVED_APP_IDS) are left out unless asked for.
 */
function listMetas({ includeInfra = false } = {}): { id: string; meta: AppMeta | null }[] {
  return listMetaIds()
    .filter((id) => includeInfra || !RESERVED_APP_IDS.has(id))
    .map((id) => ({ id, meta: loadMeta(id) }));
}

/** The open target for an app: its dedicated HTTPS proxy port when it's a flagged
 *  (Stripe) app, otherwise its first published HTTP port. */
function openTarget(meta: AppMeta | null, ports: number[]): { https: boolean; openPort: number | null } {
  if (meta?.https && meta.httpsPort) return { https: true, openPort: meta.httpsPort };
  return { https: false, openPort: ports[0] ?? null };
}

/** Pick a free dedicated HTTPS port for a flagged app, avoiding ports already
 *  assigned to other apps and any live proxy. Null if the range is exhausted. */
function pickHttpsPort(): number | null {
  const used = activeProxyPorts();
  for (const { meta } of listMetas({ includeInfra: true })) {
    if (meta?.httpsPort) used.add(meta.httpsPort);
  }
  return allocateHttpsPort(used);
}

/** How long to wait before asking Docker again, when it could not be read at boot. */
const PROXY_RETRY_MS = [5_000, 15_000, 30_000, 60_000];

/** Re-establish the TLS proxy for every flagged app on boot (their ports are
 *  fixed, so this points each proxy at the app's published HTTP port again).
 *  `attempt` counts the earlier tries Docker could not be read for. */
export async function restoreAppProxies(attempt = 0): Promise<void> {
  const { apps, discoveryOk } = await listInstalledWithHealth();
  // Docker unreadable is not "no app has a port": decide nothing, and ask again.
  if (!discoveryOk) return retryAppProxies(attempt);
  for (const a of apps) {
    const meta = loadMeta(a.id);
    if (meta?.https && meta.httpsPort && a.ports[0] != null) {
      // Per-app, so one app that can't get a proxy doesn't cost every app after it
      // in the list its HTTPS too. The caller only catches the first throw.
      try {
        ensureProxy(a.id, meta.httpsPort, a.ports[0]);
      } catch (err) {
        log.error(`Could not restore the HTTPS proxy for "${a.id}" — its other functions still work.`, err);
      }
    }
  }
}

/** Try restoreAppProxies again after the next wait; after the last, say whose HTTPS is down. */
function retryAppProxies(attempt: number): void {
  const flagged = listMetas().filter(({ meta }) => meta?.https && meta.httpsPort);
  if (flagged.length === 0) return; // no app has an HTTPS address to restore
  const wait = PROXY_RETRY_MS[attempt];
  if (wait === undefined) {
    const names = flagged.map(({ id, meta }) => meta?.name ?? id).join(', ');
    log.warn(`Docker could not be read, so the HTTPS address of ${names} was not restored. Restarting OpenMasjidOS tries again.`);
    return;
  }
  const retry = () => restoreAppProxies(attempt + 1).catch((err) => log.error('Could not restore app HTTPS proxies.', err));
  setTimeout(retry, wait).unref(); // never what keeps the process (or a test) alive
}

/** Merge on-disk metadata with live Docker state; recover orphans. */
/**
 * The installed apps, AND whether Docker could actually be read.
 *
 * When `discoveryOk` is false every app comes back `running: false` with no ports —
 * because that is all we know, not because it is true. A caller that routes traffic or
 * raises alerts from those fields must check this first; one that just draws a list need
 * not. See `DiscoveryResult.ok` for what happened when nothing checked.
 */
export async function listInstalledWithHealth(): Promise<{ apps: InstalledApp[]; discoveryOk: boolean }> {
  const result = await discoverAppsResult();
  return { apps: await buildInstalled(result.apps), discoveryOk: result.ok };
}

export async function listInstalled(): Promise<InstalledApp[]> {
  return buildInstalled(await discoverApps());
}

async function buildInstalled(discovered: Awaited<ReturnType<typeof discoverApps>>): Promise<InstalledApp[]> {
  const byId = new Map<string, InstalledApp>();

  // 1. Apps we have metadata for.
  for (const id of listMetaIds()) {
    // Never surface OS-internal infra. An older build may have recovered the
    // Cloudflare tunnel container into a stray meta.json — delete it so it's gone.
    if (RESERVED_APP_IDS.has(id)) {
      try {
        fs.rmSync(appDir(id), { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      continue;
    }
    const meta = loadMeta(id);
    if (!meta) continue;
    byId.set(id, toInstalled(meta, discovered.get(projectOf(id))));
  }

  // 2. Running/known projects without metadata — recover them (golden rule).
  for (const disc of discovered.values()) {
    if (byId.has(disc.id)) continue;
    // We can't vet a recovered app, so never claim it's "Official" — and that means
    // NOT reading `disc.kind`, which is where this used to go wrong. That value comes
    // from a `com.openmasjid.kind` Docker label, and **nothing in the platform ever
    // writes one**: discovery only reads it. So the only way a label is present is
    // that the app's own compose set it — and a pasted or community compose can set
    // anything, while `apps/compose-validate.ts` never inspects `labels:` at all.
    // Honouring it let an unvetted stack promote itself to `catalog` ("Official"),
    // which also flipped its default tunnel exposure from private to PUBLIC. Trust
    // is not something the subject gets to assert.
    //
    // `exposed` is pinned false for the same reason. `undefined` is grandfathered as
    // exposed so pre-0.40 installs did not go dark, but that grandfathering is for
    // apps an admin actually installed — a stack we just found running and cannot
    // vet must not be published to the internet on its own say-so. The admin can
    // switch it on in Settings, which is the point at which a person has looked.
    const recovered: AppMeta = {
      id: disc.id,
      name: disc.name || prettify(disc.id),
      kind: 'custom',
      exposed: false,
      createdAt: new Date().toISOString(),
    };
    // A record that EXISTS but will not parse is not an orphan: it is shown held, as
    // startBlockedReason holds it, and left on disk. Recovering it wrote a fresh record
    // with no review over it, so a backup pairing a broken meta.json with a privileged
    // compose, for an app already on the box, became an ordinary Start button.
    const unreadable = fs.existsSync(metaPath(disc.id));
    if (!unreadable) {
      try {
        ensureDir(appDir(disc.id));
        saveMeta(recovered);
        log.warn(`Recovered orphaned app from Docker: ${disc.id}`);
      } catch {
        /* best-effort persistence; still show it this session */
      }
    }
    byId.set(disc.id, {
      ...recovered,
      running: disc.running,
      ports: disc.ports,
      fabric: false, // recovered/un-vetted apps never get the Fabric hand-off
      managed: isPlatformManaged(disc.id),
      // Must agree with what `saveMeta(recovered)` just persisted (no `exposed`
      // key), or this row would claim "shared online" while the very next read
      // said otherwise. So it follows the same kind-dependent default as every
      // other app: a recovered catalog app stays reachable, a recovered
      // custom/community one — which we cannot vet at all — starts private.
      exposed: isExposedMeta(recovered),
      path: appPathOf(disc.id, recovered),
      // A recovered orphan has no compose file of ours to have vetted, and it is
      // ALREADY running — holding it for a review we never performed would show
      // the admin a finding that does not exist. It starts un-held, exactly as
      // before; what keeps it honest is that it can never claim to be "Official".
      // One whose record exists but will not parse is held instead (above).
      review: unreadable ? unreadableMeta(recovered.createdAt) : null,
      ...openTarget(recovered, disc.ports),
    });
  }

  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The dashboard row for an app we hold a record for, given what Docker reports for it. */
function toInstalled(meta: AppMeta, disc: DiscoveredApp | undefined): InstalledApp {
  return {
    id: meta.id,
    name: meta.name,
    kind: meta.kind,
    icon: meta.icon,
    category: meta.category,
    running: disc?.running ?? false,
    ports: disc?.ports ?? [],
    createdAt: meta.createdAt,
    // Only Fabric-opted-in catalog apps receive the appearance hand-off on Open.
    fabric: meta.sso === true || meta.notify === true,
    managed: isPlatformManaged(meta.id),
    exposed: isExposedMeta(meta),
    path: appPathOf(meta.id, meta),
    review: meta.review ?? null,
    ...openTarget(meta, disc?.ports ?? []),
  };
}

/** One installed app — the same row listInstalled() gives, without reading every app. */
export async function getInstalled(id: string): Promise<InstalledApp | null> {
  if (RESERVED_APP_IDS.has(id)) return null;
  const meta = loadMeta(id);
  // No record of our own (an orphan): only the full listing recovers one.
  if (!meta || meta.id !== id) return (await listInstalled()).find((a) => a.id === id) ?? null;
  return toInstalled(meta, (await discoverApps()).get(projectOf(id)));
}

/** Install a catalog app: write its files (with settings as env) and start it. */
export async function installCatalogApp(
  app: CatalogApp,
  settings: Record<string, string>,
  baseUrl?: string | null,
  expose?: boolean,
): Promise<InstalledApp> {
  // Not while a restore, an update of this app or of the core is under way (system/update-lock.ts).
  assertAppFree(app.id, 'install');
  // Validate the manifest FIRST — a malformed grant or command must fail before we
  // write any files (throws a friendly error surfaced by the install mutation).
  const fabric = parseFabric(app.fabric, app.id);
  const appAlerts = parseAlerts(app.alerts, app.id);
  const appCommands = parseCommands(app.commands, app.id);
  if (isReservedAppId(app.id)) {
    throw new Error(`"${app.id}" is a name OpenMasjidOS uses for itself, so it can't be an app id.`);
  }
  const address = addressForNewApp(app.id);
  ensureDir(appDir(app.id));
  fs.writeFileSync(composePath(app.id), app.compose, 'utf8');
  // Fabric capabilities are opt-in per app. An app that uses SSO, notifications,
  // Stripe, domain, or the app-to-app broker gets a per-app secret to prove itself.
  const sso = app.sso === true;
  const notify = app.notifications === true;
  const stripe = app.stripe === true;
  const domain = app.domain === true;
  const email = app.email === true;
  const whatsapp = app.whatsapp === true;
  const ssoSecret = needsFabricSecret({
    sso,
    notify,
    stripe,
    domain,
    email,
    whatsapp,
    alerts: appAlerts,
    commands: appCommands,
    ...fabric,
  })
    ? crypto.randomBytes(32).toString('base64url')
    : undefined;
  // Per-app tunnel exposure. Nothing is public until the admin says so, so we
  // never infer this from the manifest: `app.tunnel` is only a REQUEST, and the
  // Store turns that request into an explicit install-time question (a checkbox,
  // pre-ticked from `tunnel:true`) whose answer arrives here as `expose`. Absent
  // an answer we stay private; the admin can still flip it in Settings → Remote
  // access. (Before v0.45.0 the Store never sent `expose`, so a `tunnel:true`
  // request was silently dropped and the app never got a public URL.)
  const exposed = expose === true;
  // Stripe apps (https:true) are served over HTTPS on a dedicated proxy port.
  const wantsHttps = app.https === true;
  const httpsPort = wantsHttps ? pickHttpsPort() : undefined;
  if (wantsHttps && httpsPort == null) {
    log.warn(`No free HTTPS port for "${app.id}" — installing on HTTP. Free a slot or widen OPENMASJID_APP_TLS_MAX.`);
  }
  writeEnvFile(app.id, {
    ...settings,
    ...platformEnv(app.id, baseUrl, ssoSecret),
    OPENMASJID_PUBLIC_URL: intendedPublicUrl(app.id, exposed, address.path),
  });
  noteDisplacedAddress(app.id, address);
  saveMeta({
    id: app.id,
    name: app.name,
    kind: 'catalog',
    path: address.path,
    icon: app.icon,
    category: app.category,
    version: app.version,
    // Stamp the channel this came from, so a later switch can tell which apps
    // still need moving. Written explicitly (never left undefined) because
    // undefined means "predates channels".
    channel: getSettings().updateChannel,
    createdAt: new Date().toISOString(),
    sso,
    notify,
    stripe,
    domain,
    fabricProvides: fabric.provides.length ? fabric.provides : undefined,
    fabricConsumes: fabric.consumes.length ? fabric.consumes : undefined,
    email,
    whatsapp,
    appAlerts: appAlerts.length ? appAlerts : undefined,
    appCommands: appCommands.length ? appCommands : undefined,
    exposed,
    ssoSecret,
    https: wantsHttps && httpsPort != null,
    httpsPort: httpsPort ?? undefined,
  });

  const res = await composeUp(projectOf(app.id), composePath(app.id), envPath(app.id));
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || 'The app failed to start.');
  }
  const installed = (await getInstalled(app.id))!;
  if (httpsPort != null && installed.ports[0] != null) {
    ensureProxy(app.id, httpsPort, installed.ports[0]);
  }
  return installed;
}

/**
 * Install a pre-validated app from raw compose text (custom-paste or community
 * app store). The compose + env are written and started under project omos-<id>.
 * Risk-checking happens in the router before this is called.
 */
async function installStack(opts: {
  id: string;
  name: string;
  kind: AppMeta['kind'];
  composeText: string;
  env: Record<string, string>;
  icon?: string;
  baseUrl?: string | null;
  expose?: boolean;
}): Promise<InstalledApp> {
  assertAppFree(opts.id, 'install');
  const { id, name, kind, composeText, env, icon, baseUrl, expose } = opts;
  // Before anything is written: a custom/community id the admin chose freely must
  // not be a word the platform uses for itself (it would shadow `!os` in a
  // WhatsApp command, among other things).
  if (isReservedAppId(id)) {
    throw new Error(`"${id}" is a name OpenMasjidOS uses for itself, so it can't be an app id.`);
  }
  const address = addressForNewApp(id);
  ensureDir(appDir(id));
  fs.writeFileSync(composePath(id), composeText, 'utf8');
  writeEnvFile(id, platformEnv(id, baseUrl), env);
  noteDisplacedAddress(id, address);
  // Record the exposure decision EXPLICITLY, exactly like the catalog path
  // (`exposed = expose === true`). Omitting the key used to leave it `undefined`,
  // which the old grandfather rule read as "public" — so every pasted or
  // community stack was internet-facing without anyone being asked.
  const exposed = expose === true;
  saveMeta({ id, name, kind, icon, exposed, path: address.path, createdAt: new Date().toISOString() });
  if (exposed) log.warn(`Third-party app ${id} was installed shared over the internet, at the admin's request.`);

  const res = await composeUp(projectOf(id), composePath(id), envPath(id));
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || 'The app failed to start.');
  }
  return (await getInstalled(id))!;
}

export function installCustomApp(opts: {
  id: string;
  name: string;
  composeText: string;
  env: Record<string, string>;
  icon?: string;
  baseUrl?: string | null;
  expose?: boolean;
}): Promise<InstalledApp> {
  return installStack({ ...opts, kind: 'custom' });
}

/** Say why a new app did not get its own name as its address, where an admin looks. */
function noteDisplacedAddress(id: string, address: { path?: string; displaced?: string }): void {
  if (!address.displaced || !address.path) return;
  log.warn(
    address.displaced === 'OpenMasjidOS'
      ? `"${id}" cannot use /${id} (OpenMasjidOS uses it), so it gets /${address.path}. Change it in Settings → Remote access.`
      : `"${id}" cannot use /${id} (the app "${address.displaced}" already does), so it gets /${address.path}. Change either in Settings → Remote access.`,
  );
}

export function installCommunityApp(opts: {
  id: string;
  name: string;
  composeText: string;
  env: Record<string, string>;
  icon?: string;
  baseUrl?: string | null;
  expose?: boolean;
}): Promise<InstalledApp> {
  return installStack({ ...opts, kind: 'community' });
}

/**
 * Stop every installed app's containers. Used at the START of a restore: an app
 * that is still running while we replace the contents of its Docker volume keeps
 * writing to (and caching pages from) the data we are overwriting, which is a
 * reliable way to corrupt a SQLite database. Stop first, refill, then reup.
 * Best-effort per app — one stubborn stack must not abort the restore.
 */
export async function stopAllApps(onLine: (s: string) => void): Promise<string[]> {
  // The apps that could NOT be paused, by name: their data was put back under a running
  // container, so a restore that touched them is not "complete". `composeStop` reports a
  // failure in its exit code and never throws, so the catch below alone never fired —
  // and a container Docker refused to stop was listed as paused.
  const notPaused: string[] = [];
  const ids = listMetaIds();
  if (ids.length === 0) return notPaused;
  onLine('Pausing your apps while the data is put back…');
  for (const id of ids) {
    const name = loadMeta(id)?.name ?? id;
    // A pause the restore asked for is not an outage (system/alert-monitor.ts skips its
    // checks for the whole restore too).
    suppressOfflineAlert(id);
    let problem: string | null = null;
    try {
      const res = await composeStop(projectOf(id));
      if (res.code !== 0) problem = res.stderr.trim().split('\n')[0] || 'error';
    } catch (err) {
      problem = (err as Error).message;
    }
    if (problem === null) {
      onLine(`• ${name}`);
    } else {
      log.warn(`Restore: could not stop ${id} before restoring its data — ${problem}`);
      onLine(`• ${name} (couldn't pause it — its data may not restore cleanly)`);
      notPaused.push(name);
    }
  }
  return notPaused;
}

/**
 * Record a fresh review verdict for every app with a compose file (`reviewCompose`) — for a
 * restore, straight after it moves the backup's apps/ into place, so the verdict on disk is
 * this platform's own from that moment rather than the backup's. A compose that cannot
 * even be read is logged and left to `reupAllApps`, which holds it.
 */
export function reviewEveryApp(): void {
  for (const id of listMetaIds()) {
    if (!fs.existsSync(composePath(id))) continue;
    try {
      reviewCompose(id);
    } catch (err) {
      log.warn(`Restore: could not check ${id}'s compose file.`, err);
    }
  }
}

/**
 * Bring every installed app back up from its on-disk compose file. Used after a
 * restore so apps run with the restored data (and so a fresh-box restore
 * actually recreates them). Streams a friendly line per app via onLine.
 */
export async function reupAllApps(onLine: (s: string) => void): Promise<string[]> {
  // The apps it could NOT start — held for review, or refused by Docker — by name. A
  // restore that left the donations page down must not end on "Restore complete."
  const notStarted: string[] = [];
  const ids = listMetaIds().filter((id) => fs.existsSync(composePath(id)));
  if (ids.length === 0) {
    onLine('No apps to restart.');
    return notStarted;
  }
  for (const id of ids) {
    const name = loadMeta(id)?.name ?? id;
    onLine(`• ${name}`);
    // A backup is an opaque, externally-craftable file — so re-run each restored
    // stack through the SAME risk gate a fresh install uses. We never auto-start
    // a dangerous compose (privileged, host namespaces, socket/sensitive binds…)
    // that a crafted backup could smuggle in without the usual consent (audit).
    //
    // The verdict is PERSISTED (`AppMeta.review`), not just printed. Declining to
    // auto-start it here and then forgetting was the whole bug: restore writes
    // apps/ to disk ungated, so once this stream closed the app was an ordinary
    // Stopped card and its Start button ran the unvetted compose as root with the
    // Docker socket — host root, with no warning at the moment of the click.
    // `reviewCompose` also CLEARS a stale review when the compose now passes.
    //
    // Its own try/catch, and FAIL CLOSED: an unexpected throw here (an I/O
    // error, an unwritable meta.json) used to abort the whole loop, which left
    // every app after this one in the list unreviewed and unheld — one crafted
    // entry early in the alphabet would have disarmed the gate for the rest.
    let review: AppReview | null;
    try {
      review = reviewCompose(id);
    } catch (err) {
      log.warn(`Could not check ${id}'s compose file.`, err);
      review = { kind: 'unreadable', reasons: ["we couldn't check what it does"], at: new Date().toISOString() };
    }
    if (review) {
      onLine(`  (not started — needs review: ${review.reasons[0]})`);
      notStarted.push(name);
      continue;
    }
    // Migration fix: a backup restored onto a NEW machine carries the old
    // machine's address baked into each app's OPENMASJID_BASE_URL, so the app
    // can't reach the platform for SSO and falls back to its standalone setup.
    // Re-resolve the base URL to THIS machine and rewrite it before starting,
    // preserving the app's settings + per-app Fabric secret. Best-effort.
    try {
      const env = readEnvFile(id);
      if (env.OPENMASJID_BASE_URL) {
        const base = resolveBaseUrl(null);
        if (base && base !== env.OPENMASJID_BASE_URL) {
          updateEnvFile(id, { OPENMASJID_BASE_URL: base });
          log.info(`${id} now reaches the platform at ${base}.`);
        }
      }
    } catch {
      /* keep going — a failed base-URL refresh shouldn't block the restart */
    }
    // Docker's own words go to the log; the window says it plainly.
    try {
      const res = await withHeartbeat(onLine, STILL_WORKING, () => composeUp(projectOf(id), composePath(id), envPath(id)));
      if (res.code !== 0) {
        log.warn(`Could not start ${id} — ${res.stderr.trim() || 'no output'}`);
        onLine("  (couldn't start it)");
        notStarted.push(name);
      }
    } catch (err) {
      log.warn(`Could not start ${id}.`, err);
      onLine("  (couldn't start it)");
      notStarted.push(name);
    }
  }
  return notStarted;
}

/**
 * Rotate every Fabric-enabled app's per-app secret (its "sign-in key"). Part of
 * the full sign-in reset (recovery after a restore/migration): each app's old
 * OPENMASJID_APP_SECRET is replaced with a fresh one in BOTH its meta.json and
 * its .env, so apps re-establish trust with the platform under new keys. App
 * DATA is never touched. Returns how many apps were rotated. The caller must
 * reup the apps afterwards so the running containers pick up the new env.
 */
export function rotateAllFabricSecrets(onLine?: (s: string) => void): number {
  let rotated = 0;
  for (const { id, meta } of listMetas({ includeInfra: true })) {
    if (!meta?.ssoSecret) continue; // only apps that opted into the Fabric hold a secret
    const secret = crypto.randomBytes(32).toString('base64url');
    saveMeta({ ...meta, ssoSecret: secret });
    updateEnvFile(id, { OPENMASJID_APP_SECRET: secret });
    rotated += 1;
    onLine?.(`• ${meta.name ?? id}`);
  }
  invalidateFabricIndex();
  return rotated;
}

/** Sanitize a public path segment: lowercase, single segment, url-safe. */
function sanitizePath(p: string): string {
  return p
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

/** The public path an app is served under behind the tunnel — the Cloudflare
 *  Public-Hostname path AND the Fabric `basePath`. Admin-configurable; defaults
 *  to the app id (e.g. donations → "donations"; the admin can change it to "donate"). */
export function getAppPath(id: string): string {
  return appPathOf(id, loadMeta(id));
}

/** getAppPath, for a record already in hand. */
function appPathOf(id: string, meta: AppMeta | null): string {
  const recorded = recordedPath(id, meta);
  return meta && isReservedPathSegment(recorded) ? moveOffReservedPath(id, meta, recorded) : recorded;
}

/** The address an app's record names: its own path when one is set, otherwise its id. */
function recordedPath(id: string, meta: AppMeta | null): string {
  const clean = meta?.path ? sanitizePath(meta.path) : '';
  return clean || id;
}

/**
 * Move an app off an address OpenMasjidOS has since taken for itself (0.51.2-dev.17
 * reserved the dashboard's pages), once and for good, to the address a new app would get.
 * Left there it had no public page, and its links and QR codes opened the dashboard.
 */
function moveOffReservedPath(id: string, meta: AppMeta, recorded: string): string {
  const moved = freeAddress(id);
  // This runs on reads — the ingress rebuilds every 10 s — so not while a restore runs: the
  // record is about to be replaced, and a write could land in the tree it puts in place. The
  // first read after the restore records the move.
  if (isUpdating('restore')) return moved;
  try {
    saveMeta({ ...meta, path: moved === id ? undefined : moved });
    const url = intendedPublicUrl(id, isExposedMeta(meta), moved);
    if ((readEnvFile(id).OPENMASJID_PUBLIC_URL ?? '') !== url) updateEnvFile(id, { OPENMASJID_PUBLIC_URL: url });
    unrecordedMoves.delete(id);
    log.warn(`"${id}" was at /${recorded}, which OpenMasjidOS now uses for itself, so it moves to /${moved}. Change it in Settings → Remote access.`);
  } catch (err) {
    // Retried on every read; said once, not every ten seconds.
    if (!unrecordedMoves.has(id)) log.warn(`Could not record "${id}"'s move from /${recorded} to /${moved}.`, err);
    unrecordedMoves.add(id);
  }
  return moved;
}
const unrecordedMoves = new Set<string>();

/**
 * Set an app's public path (or reset to the id when blank). Returns the effective path.
 *
 * Refuses a path another installed app already answers to. Two apps on one address
 * used to be possible and silent: the routing table kept whichever it met last, so
 * an app nobody had shared could take a shared app's public page offline, with
 * Settings still showing the shared one as published (system/ingress.ts `placeRoute`
 * now keeps a shared app's path either way, for installs that already have a clash).
 */
export function setAppPath(id: string, path: string): string {
  const meta = loadMeta(id);
  if (!meta) throw new Error('That app is not installed.');
  const clean = sanitizePath(path);
  const effective = clean || id;
  if (isReservedPathSegment(effective)) {
    throw new Error(`/${effective} is used by OpenMasjidOS itself. Choose a different address for this app.`);
  }
  if (pathTakenBy(effective, id)) {
    throw new Error(`Another app already uses /${effective}. Choose a different address for this one.`);
  }
  saveMeta({ ...meta, path: clean || undefined });
  return effective;
}

/** The installed app (other than `exceptId`) that answers to `seg`, or null. */
function pathTakenBy(seg: string, exceptId: string): string | null {
  for (const { id, meta } of listMetas()) {
    if (id !== exceptId && recordedPath(id, meta) === seg) return id;
  }
  return null;
}

/**
 * The address a NEW app gets: its own id when that is free (stored as nothing, so it
 * keeps following the id), otherwise the id with the first free number after it.
 *
 * Installing used to take the id unconditionally, and that is the half of "no two
 * apps on one address" that `setAppPath` could not see. Give a community app the
 * address /donations, install the official Donations app later, and the two shared
 * one address: the newer one took the public page, Settings listed both as published
 * there, and opening the older one from outside opened the other. Decided before
 * anything is written, so a refused install leaves nothing behind.
 */
function addressForNewApp(id: string): { path?: string; displaced?: string } {
  const existing = loadMeta(id)?.path;
  // A reinstall keeps the address it had, unless OpenMasjidOS has since taken it.
  if (existing && !isReservedPathSegment(sanitizePath(existing))) return { path: existing };
  const taken = isReservedPathSegment(id) ? 'OpenMasjidOS' : pathTakenBy(id, id);
  if (!taken) return {};
  return { path: freeAddress(id), displaced: taken };
}

/** The app's id when no app answers to it and OpenMasjidOS does not keep it, otherwise
 *  the id with the first free number after it. */
function freeAddress(id: string): string {
  if (!isReservedPathSegment(id) && !pathTakenBy(id, id)) return id;
  for (let n = 2; n < 1000; n++) {
    // Room for the number inside sanitizePath's 40 characters, so what is stored is
    // exactly what getAppPath will read back.
    const candidate = sanitizePath(`${id.slice(0, 34)}-${n}`);
    if (!isReservedPathSegment(candidate) && !pathTakenBy(candidate, id)) return candidate;
  }
  throw new Error('Every address for this app is taken. Change another app’s address in Settings → Remote access, then try again.');
}

/**
 * Is this app shared over the internet? The SINGLE source of truth for that
 * question — every caller must go through here rather than testing
 * `meta.exposed !== false` inline, because the answer is not the same for every
 * kind of app.
 *
 * A missing `exposed` means two completely different things depending on how the
 * app got installed:
 *   - **catalog**: it predates per-app exposure (v0.40.0), when every routed app
 *     was public. Grandfathered EXPOSED so an upgrade doesn't take a masjid's
 *     working public app offline.
 *   - **custom / community**: `installStack` never wrote the key at all, so
 *     `undefined` was never a decision — and reading it as "exposed" published
 *     the LEAST-vetted apps by default, on the lowest published port (often a
 *     database in a CasaOS stack). These default to PRIVATE. §15's rule is that
 *     nothing is public without the admin's explicit toggle, and a value nobody
 *     ever set is not a toggle.
 */
export function isExposedMeta(meta: Pick<AppMeta, 'kind' | 'exposed'>): boolean {
  if (typeof meta.exposed === 'boolean') return meta.exposed;
  return meta.kind === 'catalog';
}

/** Turn an app's internet exposure on/off (the admin's per-app consent). Rewrites
 *  the OPENMASJID_PUBLIC_URL env to match; the CALLER must reup the app so the
 *  container picks up the new value and the ingress route map rebuilds. */
export function setExposed(id: string, exposed: boolean): void {
  const meta = loadMeta(id);
  if (!meta) throw new Error('That app is not installed.');
  saveMeta({ ...meta, exposed });
  updateEnvFile(id, { OPENMASJID_PUBLIC_URL: intendedPublicUrl(id, exposed) });
}

/** Recompute OPENMASJID_PUBLIC_URL for every installed app from the current
 *  Cloudflare settings + each app's exposure, rewriting the .env where it changed.
 *  Returns the ids whose value changed (the caller reups them). Used when the tunnel
 *  is enabled/disabled or the domain/path changes, so exposed apps learn their URL. */
export function reconcilePublicUrls(): string[] {
  const changed: string[] = [];
  for (const { id, meta } of listMetas()) {
    if (!meta) continue;
    // Read before working out the URL: that can move the app off a reserved address,
    // which rewrites this line itself, and the app still needs its reup.
    const had = readEnvFile(id).OPENMASJID_PUBLIC_URL ?? '';
    const want = intendedPublicUrl(id, isExposedMeta(meta));
    if (had !== want) {
      updateEnvFile(id, { OPENMASJID_PUBLIC_URL: want });
      changed.push(id);
    }
  }
  return changed;
}

/**
 * Thrown when an app is held for review and something asked to start it anyway.
 * A distinct type so each caller can say the right thing: the dashboard offers
 * the acknowledgement, WhatsApp explicitly cannot (see `startApp`).
 */
export class AppNeedsReviewError extends Error {
  readonly review: AppReview;
  /** True when the finding can never be acknowledged, however emphatically. */
  readonly refusal: boolean;
  constructor(review: AppReview) {
    super(review.reasons[0] ?? 'This app needs to be looked at before it can start.');
    this.name = 'AppNeedsReviewError';
    this.review = review;
    this.refusal = review.kind === 'refusal';
  }
}

/** Two verdicts are the same only if BOTH the kind and every reason match. */
function sameReview(a: AppReview | null | undefined, b: AppReview | null): boolean {
  if (!a || !b) return !a && !b;
  return a.kind === b.kind && a.reasons.length === b.reasons.length && a.reasons.every((r, i) => r === b.reasons[i]);
}

/** The verdict for an app whose own record we cannot read. */
const unreadableMeta = (at: string): AppReview => ({
  kind: 'unreadable',
  reasons: ["We couldn't read this app's record, so we couldn't check what it does."],
  at,
});

/**
 * Re-run the install-time risk gate over an app's on-disk compose and record the
 * verdict on its meta. Returns the review when it is blocked, else null (having
 * CLEARED any stale review, so an app fixed by a legitimate update or reinstall
 * stops being held).
 *
 * Called wherever a compose arrives from outside our control — today that is
 * `reupAllApps`, i.e. every restore. A file we cannot even read is treated as
 * blocking: "couldn't check it" is not "it is fine" (CLAUDE.md §15's rule that a
 * failure to ask records nothing applies here as a refusal to proceed).
 */
export function reviewCompose(id: string): AppReview | null {
  const at = new Date().toISOString();

  // Compute the verdict FIRST, from the compose alone, and never let meta.json
  // decide whether the gate runs. meta.json arrives in the SAME backup as the
  // compose, so making it a precondition hands the attacker an off switch: the
  // first cut of this function opened with `loadMeta(id); if (!meta) return null`,
  // which meant one unparseable byte in an attacker-supplied meta.json produced
  // "no finding" and `reupAllApps` then AUTO-STARTED the unvetted stack — worse
  // than the hole this whole change exists to close.
  let review: AppReview | null = null;
  try {
    const { dangers, refusals } = checkCompose(fs.readFileSync(composePath(id), 'utf8'));
    // A refusal outranks a danger: the app can never be started, so the admin
    // must not be shown a tickbox. Dangers are still listed, because if the
    // refusal is ever removed they are what remains to agree to.
    if (refusals.length > 0) review = { kind: 'refusal', reasons: [...refusals, ...dangers], at };
    else if (dangers.length > 0) review = { kind: 'danger', reasons: dangers, at };
  } catch (err) {
    review = { kind: 'unreadable', reasons: [(err as Error).message], at };
  }

  const meta = loadMeta(id);
  if (!meta) {
    // Nowhere to persist it. Say so instead of implying there was no finding —
    // an app whose own record is unreadable is held on that ground alone.
    log.warn(`App ${id}: meta.json is unreadable; holding the app rather than trusting it.`);
    return review ?? unreadableMeta(at);
  }
  // The persisted record is what every downstream decision reads (the start
  // guard, the acknowledgement, the tRPC status code) — and it came out of the
  // same backup, so the freshly COMPUTED verdict always wins. Comparing only the
  // reason text let a pre-seeded `refusal: false` survive a genuine refusal and
  // turn a never-acknowledgeable finding into a tickbox the admin could clear.
  if (!sameReview(meta.review, review)) saveMeta({ ...meta, review: review ?? undefined });
  return review;
}

/**
 * Why this app must not be started, or null when it is free to go.
 *
 * Consulted inside `startApp` and `restartApp` rather than at each of their
 * callers. The bug this closes existed because a verdict was computed in one
 * place and acted on nowhere; putting the check at the four call sites (tRPC,
 * WhatsApp `!os start`, and the exposure toggle twice) would be the same mistake
 * with more steps — the fifth caller is always the one that gets forgotten.
 *
 * BOTH functions, not just `startApp`: `composeRestart` starts a stopped
 * container, so "restart" is a start path. `stopApp` is deliberately NOT guarded
 * — stopping a held app is exactly what you want to be able to do.
 */
export function startBlockedReason(id: string): AppReview | null {
  const meta = loadMeta(id);
  if (meta) return meta.review ?? null;
  // FAIL CLOSED when the record exists but will not parse: meta.json is now
  // security state, it arrives in the backup, and "we couldn't read it" must
  // never read as "there is nothing to worry about" (§15's rule, applied to a
  // file rather than to Docker). A record that is absent entirely is a different
  // thing — the app is not installed — and is left to the caller's own error path.
  if (fs.existsSync(metaPath(id))) return unreadableMeta(new Date().toISOString());
  return null;
}

/** Record the admin's explicit "I understand the risk" for a held app, freeing
 *  it to start. Refusals are NEVER acknowledgeable — the same rule the custom
 *  (paste-a-compose) installer applies, for the same reason: a stack reaching
 *  into another app's data cannot be consented into safety. */
export function acknowledgeReview(id: string): void {
  const meta = loadMeta(id);
  if (!meta?.review) return;
  if (meta.review.kind === 'refusal') throw new AppNeedsReviewError(meta.review);
  log.warn(`App ${id}: admin acknowledged a held compose — ${meta.review.reasons.join('; ')}`);
  saveMeta({ ...meta, review: undefined });
}

/**
 * Start an app.
 *
 * `acknowledgeRisk` is the admin's explicit consent, and ONLY the dashboard
 * passes it. A WhatsApp `!os start` deliberately cannot: possession of a phone
 * already authorises a lot (§13.2b-iii), and consenting to a `privileged: true`
 * compose on a daemon running as root with the Docker socket is not something a
 * chat message should be able to do. That path gets the refusal and a pointer to
 * the dashboard, which is where a person can actually read what they are agreeing to.
 */
export async function startApp(id: string, acknowledgeRisk = false): Promise<void> {
  assertAppFree(id, 'start');
  const held = startBlockedReason(id);
  if (held) {
    if (!acknowledgeRisk || held.kind === 'refusal') throw new AppNeedsReviewError(held);
    acknowledgeReview(id);
  }
  // Prefer a fresh `up` when we have the compose file (recreates if needed),
  // otherwise fall back to `start` for orphaned projects.
  const res = fs.existsSync(composePath(id))
    ? await composeUp(projectOf(id), composePath(id), envPath(id))
    : await composeStart(projectOf(id));
  throwIfFailed(res, id, "This app couldn't be started. Its logs may say why.");
}

export async function stopApp(id: string): Promise<void> {
  suppressOfflineAlert(id); // admin-initiated stop — don't fire the offline alert
  throwIfFailed(await composeStop(projectOf(id)), id, "This app couldn't be stopped. Please try again.");
}

/** docker/compose.ts reports a failure only in the exit code, so say it here: in plain
 *  words to whoever asked, with Docker's own output in the log. */
function throwIfFailed(res: RunResult, id: string, message: string): void {
  if (res.code === 0) return;
  log.warn(`App ${id}: ${message} ${res.stderr.trim() || `(docker exited with ${res.code})`}`);
  throw new Error(message);
}

export async function restartApp(id: string): Promise<void> {
  // `docker compose restart` STARTS a stopped container, so this is a start path
  // too — it simply doesn't re-read the compose file. Guarding only `startApp`
  // left `!os restart` able to run a held app from the very phone that is
  // deliberately not allowed to consent to one, using the neighbouring verb.
  // There is no `acknowledgeRisk` here on purpose: agreeing is Start's job, and
  // a Restart that silently doubled as consent would be the same trap again.
  assertAppFree(id, 'start');
  const held = startBlockedReason(id);
  if (held) throw new AppNeedsReviewError(held);
  suppressOfflineAlert(id); // brief intended downtime
  throwIfFailed(await composeRestart(projectOf(id)), id, "This app couldn't be restarted. Its logs may say why.");
}

export async function appLogs(id: string, tail = 200): Promise<string> {
  return composeLogs(projectOf(id), tail);
}

/** How long to give a container to prove it is going to stay up. */
const SETTLE_MS = 3_000;
const SETTLE_SAMPLES = 3;
/** Shown where an app's last log lines would be, when it is down and left none to read. */
const NO_LOGS_TO_SHOW = "(It isn't running, and it left no logs we could read.)";

/**
 * Did the app actually STAY running?
 *
 * `docker compose up -d` exits 0 once a container is created and started — it says
 * nothing about whether the process inside then died. A container that boots, throws,
 * and is restarted by `restart: unless-stopped` therefore looked like a clean success:
 * the update reported "Done", and the only symptom was the dashboard quietly showing
 * the app as not running, with the actual reason buried in container logs the admin
 * had to go and find. That happened for real when a gateway update added a new
 * config guard the masjid's existing settings did not satisfy.
 *
 * Sampled a few times rather than once, because a crash-loop spends part of its cycle
 * genuinely `running` and a single check can land in that window.
 *
 * Returns null when it is up, or the last few log lines when it is not (a sentence
 * saying so when there are none to show).
 */
export async function verifyStayedUp(id: string): Promise<string | null> {
  let up = false;
  for (let i = 0; i < SETTLE_SAMPLES; i++) {
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    up = (await getInstalled(id))?.running === true;
    if (!up) break; // one bad sample is enough — a healthy app is up on every one
  }
  if (up) return null;
  // Every caller reads null as "it stayed up", so an app that is down always gets words.
  try {
    return (await composeLogs(projectOf(id), 40)).trim() || NO_LOGS_TO_SHOW;
  } catch {
    return NO_LOGS_TO_SHOW;
  }
}

export interface UpdateCheck {
  updateAvailable: boolean;
  current: string;
  latest: string | null;
  /**
   * WHY an update is on offer — the UI wants different words for each, and a
   * boolean alone was the bug that made a channel switch look like "up to date".
   *   'version'  a genuinely newer version on the same channel
   *   'channel'  this app is on the other channel and needs moving
   *
   * There is deliberately no third, Development-only reason. There used to be
   * ('dev-refresh'), because dev catalog entries carried the same version as stable
   * and pointed at a moving `:dev` tag — so the only way to guess at a new build was
   * to compare image digests, and the answer was usually "can't tell". Dev entries now
   * publish prerelease versions and pin an immutable per-build tag, so 'version'
   * covers Development too.
   */
  reason: 'version' | 'channel' | null;
  /** The channel this app is currently on, and the one selected. */
  appChannel: Channel;
  channel: Channel;
}

/** Is a newer version of this (catalog) app available in the store? Community /
 *  custom apps have no store source, so they never report an update here. */
export async function checkCatalogUpdate(id: string): Promise<UpdateCheck> {
  const channel = getSettings().updateChannel;
  const meta = loadMeta(id);
  const current = meta?.version ?? '';
  const appChannel: Channel = meta?.channel ?? 'main';
  const none = { updateAvailable: false, current, latest: null, reason: null, appChannel, channel } as const;
  if (!meta || meta.kind !== 'catalog') return none;
  const app = await findCatalogApp(id);
  if (!app) return none;

  // Two reasons to offer an update, checked most-specific first.
  //
  // The channel check has to come FIRST and cannot be folded into the version check:
  // moving an app between channels is required regardless of what the versions say,
  // and the target can legitimately be OLDER (going back to Stable). Semver alone was
  // the bug that made switching channels mean deleting and reinstalling an app.
  //
  // The version check now works on both channels, because a dev catalog entry carries
  // a prerelease version (`0.11.0-dev.1`) that moves with each build instead of
  // repeating the stable one. That is what removed the whole third branch here.
  let reason: UpdateCheck['reason'] = null;
  if (appChannel !== channel) reason = 'channel';
  else if (isNewerVersion(current, app.version)) reason = 'version';

  return {
    updateAvailable: reason !== null,
    current,
    latest: app.version,
    reason,
    appChannel,
    channel,
  };
}

/**
 * How an app's update ended, for whoever is watching (api/app-update.ts turns it into the
 * window's close code). `updated`; `unchanged` — refused, already current, or put back
 * after a download or start that failed, so the version that was running still is; or
 * `not-running` — updated, but the new version does not stay up. The window used to say
 * "<app> is up to date now." whatever had happened.
 */
export type AppUpdateOutcome = 'updated' | 'unchanged' | 'not-running';

/**
 * Update a catalog app to the store's current version, streaming plain progress via
 * onLine (Docker's own output goes to the log). The user's existing settings (.env)
 * are kept; only the compose + image change. Re-runs `pull` then `up -d` so the new
 * image is fetched and the container recreated.
 */
export async function updateCatalogApp(id: string, onLine: (s: string) => void): Promise<AppUpdateOutcome> {
  // One at a time per app. Two of these at once rewrite the same compose.yml while two
  // `compose up` runs race for the same project — which is how an app stops coming back
  // after its progress window was closed and the update pressed again.
  return withUpdateLock(`app:${id}`, 'This app is already being updated. It will finish on its own.', () =>
    updateCatalogAppInner(id, onLine),
  );
}

async function updateCatalogAppInner(id: string, onLine: (s: string) => void): Promise<AppUpdateOutcome> {
  const meta = loadMeta(id);
  if (!meta || meta.kind !== 'catalog') {
    onLine('This app cannot be updated from the store.');
    return 'unchanged';
  }
  const app = await findCatalogApp(id);
  if (!app) {
    onLine("Could not find this app in the store anymore. Nothing was changed.");
    return 'unchanged';
  }

  const channel = getSettings().updateChannel;
  // `undefined` predates channels — grandfathered as Stable (see AppMeta.channel).
  const appChannel = meta.channel ?? 'main';
  const switching = appChannel !== channel;
  const downgrading = switching && channel === 'main';

  // Two reasons to proceed, and the version check only governs the first:
  //   1. a genuinely newer version on the same channel — true on Development too,
  //      now that dev entries carry prerelease versions rather than reusing stable's;
  //   2. a CHANNEL SWITCH, where the target version may be identical or older and we
  //      still have to move the app.
  //
  // This gate is also what protects against a pointless recreate. Restarting an app is
  // a real outage when it's a prayer-times display on a wall, so "nothing newer" must
  // stop here rather than pull-and-recreate on the chance something changed.
  if (!switching && !isNewerVersion(meta.version ?? '', app.version)) {
    onLine(`${meta.name} is already up to date (v${app.version}).`);
    return 'unchanged';
  }

  // Re-apply the INSTALL-TIME risk gate. The refreshed catalog entry is fresh
  // external data — a compromised or spoofed catalog could ship an update whose
  // compose asks for powers the installed version never had, and an update that
  // skipped this check would slip straight past the gate the install honoured.
  // (reupAllApps re-checks on restore for exactly the same reason.)
  let dangers: string[];
  let refusals: string[];
  try {
    ({ dangers, refusals } = checkCompose(app.compose));
  } catch (err) {
    log.warn(`App ${id}: the update's compose file could not be checked.`, err);
    onLine("The update couldn't be checked safely, so nothing was changed.");
    return 'unchanged';
  }
  const blocking = [...refusals, ...dangers];
  if (blocking.length > 0) {
    onLine('This update asks for powerful permissions, so it was blocked for safety.');
    onLine(`Reason: ${blocking[0]}`);
    onLine(`Nothing was changed — ${meta.name} is still running its current version.`);
    return 'unchanged';
  }

  if (switching) {
    onLine(
      downgrading
        ? `Moving ${meta.name} back to the Stable version (v${app.version})…`
        : `Moving ${meta.name} to the Development version…`,
    );
    if (downgrading) {
      // Say it plainly rather than in the summary at the end: this is the step
      // where dev-only data can start misbehaving, and the admin is watching.
      onLine('Its data is kept, but anything added by a Development version may not work on Stable.');
    }
  } else {
    onLine(`Updating ${meta.name} from v${meta.version ?? '?'} to v${app.version}…`);
  }

  // Reconcile Fabric capabilities from the REFRESHED entry so an author can add
  // OR revoke sso/notifications on update — the capability gate reads meta, so a
  // withdrawn capability must stop working. Keep the user's settings + the
  // install-time OPENMASJID_BASE_URL; only the per-app secret tracks capability.
  //
  // Parsed BEFORE the compose is written, exactly as install does. These throw on a
  // malformed manifest, and until v0.51.0 they ran AFTER the write — so a bad
  // manifest left the new compose.yml on disk beside the old meta.json, and the
  // next reup or Start ran the new stack believing it was the old version.
  const fabric = parseFabric(app.fabric, id);
  const appAlerts = parseAlerts(app.alerts, id);
  const appCommands = parseCommands(app.commands, id);

  // New compose; keep the user's saved settings (.env) untouched.
  //
  // Snapshot what is on disk FIRST, so a pull or an `up` that fails below can put it back.
  // Without that, an aborted update left the NEW compose.yml (and the rewritten .env) on
  // disk beside the OLD meta.json — and `startApp` reads that file straight from disk and
  // is deliberately NOT compose-gated (CLAUDE.md §15). So the next time a volunteer pressed
  // Start on an app whose update had failed, they silently got the new stack: the version
  // the platform reports is the old one, and the risk gate that would have vetted the new
  // compose at install time never ran on it.
  //
  // Read before write, and only what already exists — a missing file restores to "delete",
  // which is the correct undo for a compose that was not there to begin with.
  const prevCompose = fs.existsSync(composePath(id)) ? fs.readFileSync(composePath(id), 'utf8') : null;
  const prevEnv = fs.existsSync(envPath(id)) ? fs.readFileSync(envPath(id), 'utf8') : null;
  /** Put the app back exactly as it was. Best effort — a failure here is already the
   *  unhappy path, and throwing would replace a clear message with a stack trace. */
  const rollback = (): void => {
    try {
      if (prevCompose === null) fs.rmSync(composePath(id), { force: true });
      else fs.writeFileSync(composePath(id), prevCompose, 'utf8');
      if (prevEnv === null) fs.rmSync(envPath(id), { force: true });
      else fs.writeFileSync(envPath(id), prevEnv, 'utf8');
    } catch (err) {
      log.warn(`Could not restore ${id} after a failed update.`, err);
    }
  };
  fs.writeFileSync(composePath(id), app.compose, 'utf8');

  const sso = app.sso === true;
  const notify = app.notifications === true;
  const stripe = app.stripe === true;
  const domain = app.domain === true;
  const email = app.email === true;
  const whatsapp = app.whatsapp === true;
  let ssoSecret = meta.ssoSecret;
  if (
    needsFabricSecret({
      sso,
      notify,
      stripe,
      domain,
      email,
      whatsapp,
      alerts: appAlerts,
      commands: appCommands,
      ...fabric,
    })
  ) {
    if (!ssoSecret) ssoSecret = crypto.randomBytes(32).toString('base64url');
  } else {
    ssoSecret = undefined;
  }
  updateEnvFile(id, {
    OPENMASJID_APP_ID: id,
    OPENMASJID_APP_SECRET: ssoSecret, // removed when the app no longer needs one
    // Keep the app's public URL in sync with its exposure (preserved from meta).
    OPENMASJID_PUBLIC_URL: intendedPublicUrl(id, meta.exposed !== false),
  });

  // Reconcile per-app HTTPS the same way — an app can gain (or lose) the Stripe
  // HTTPS requirement on update. Keep an already-assigned port; allocate one if
  // it just turned on.
  const wantsHttps = app.https === true;
  let httpsPort = meta.httpsPort;
  if (wantsHttps) {
    if (httpsPort == null) httpsPort = pickHttpsPort() ?? undefined;
  } else {
    httpsPort = undefined;
  }

  onLine('');
  onLine('Downloading the new version…');
  // Docker's own output goes to the log (docker/compose.ts `streamSpawn`), not this window.
  if ((await withHeartbeat(onLine, STILL_DOWNLOADING, () => composePull(projectOf(id), composePath(id), envPath(id)))) !== 0) {
    onLine('');
    onLine('Could not download the update. Please check the connection and try again.');
    // Nothing was applied, so leave nothing new behind for a later Start to pick up.
    rollback();
    return 'unchanged';
  }

  onLine('');
  onLine('Applying the update…');
  suppressOfflineAlert(id); // recreate briefly stops the container — not an outage
  if ((await withHeartbeat(onLine, STILL_WORKING, () => composeUpStream(projectOf(id), composePath(id), envPath(id)))) !== 0) {
    onLine('');
    onLine('The update could not start. The previous version may still be running.');
    // The old container is still the running one; put its compose back so a later Start
    // recreates THAT, not the version that just failed to come up.
    rollback();
    return 'unchanged';
  }

  saveMeta({
    ...meta,
    name: app.name || meta.name,
    icon: app.icon ?? meta.icon,
    category: app.category ?? meta.category,
    version: app.version,
    sso,
    notify,
    stripe,
    domain,
    fabricProvides: fabric.provides.length ? fabric.provides : undefined,
    fabricConsumes: fabric.consumes.length ? fabric.consumes : undefined,
    email,
    whatsapp,
    appAlerts: appAlerts.length ? appAlerts : undefined,
    appCommands: appCommands.length ? appCommands : undefined,
    ssoSecret,
    https: wantsHttps && httpsPort != null,
    httpsPort: httpsPort ?? undefined,
    // The app now tracks the selected channel. Written on every update so a switch
    // converges: once each app has been through here, none are pending.
    channel,
    // This compose is FRESH catalogue data that has just been through the risk
    // gate above and then actually started, so any review held against the file
    // it replaced no longer describes anything on disk. Leaving a stale hold here
    // would make "update the app" the one fix an admin cannot apply.
    review: undefined,
  });

  // Start (or tear down) the per-app HTTPS proxy to match the new state.
  if (wantsHttps && httpsPort != null) {
    const cur = await getInstalled(id);
    if (cur?.ports[0] != null) ensureProxy(id, httpsPort, cur.ports[0]);
  } else {
    stopProxy(id);
  }

  // `compose up` exiting 0 only means the container STARTED. Check it is still up
  // before claiming the update worked — a new version that rejects the masjid's
  // existing settings boots, throws, and restarts forever, and saying "Done" there
  // sends the admin hunting through container logs for a reason we already have.
  onLine('');
  onLine('Checking it stayed running…');
  const crash = await verifyStayedUp(id);
  if (crash !== null) {
    onLine('');
    onLine(`${meta.name} was updated to v${app.version}, but it is not staying running.`);
    onLine('This usually means the new version needs a setting the app does not have yet.');
    onLine('');
    onLine('The last thing it printed before stopping:');
    for (const line of crash.split('\n').slice(-12)) onLine(`  ${line}`);
    return 'not-running';
  }

  onLine('');
  onLine(`Done — ${meta.name} is now on v${app.version}.`);
  return 'updated';
}

/**
 * Remove an app: stop & delete its containers and drop it from the dashboard.
 * When deleteData is true, also remove its volumes and on-disk files.
 */
export async function removeApp(id: string, deleteData = false): Promise<void> {
  assertAppFree(id, 'remove');
  // `compose down` stops it for some seconds before its record goes: not an outage.
  suppressOfflineAlert(id);
  stopProxy(id); // tear down any per-app HTTPS proxy first
  const file = fs.existsSync(composePath(id)) ? composePath(id) : undefined;
  // When deleting data, also drop the app's images so the space is reclaimed.
  await composeDown(projectOf(id), file, deleteData, deleteData);
  try {
    if (deleteData) {
      fs.rmSync(appDir(id), { recursive: true, force: true });
    } else if (fs.existsSync(metaPath(id))) {
      // Keep the data dir, but the app leaves the dashboard.
      fs.rmSync(metaPath(id), { force: true });
    }
  } catch (err) {
    log.warn(`Cleanup after removing ${id} had a problem.`, err);
  }
  invalidateFabricIndex(); // the app's secret (if any) is gone
}
