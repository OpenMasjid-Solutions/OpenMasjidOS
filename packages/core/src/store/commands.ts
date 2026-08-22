// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Who may run admin commands over WhatsApp, and whether the feature is on at all.
 *
 * This is the security boundary for a channel that can start, stop and update a
 * masjid's apps, authenticated by nothing stronger than possession of a phone. Every
 * default here is chosen so that the failure mode is "nothing happens":
 *
 *   - `enabled` is false until an admin turns it on, and is only ever true when the
 *     stored value is literally `true`.
 *   - An empty list means NOBODY. There is no implicit grant, and in particular the
 *     admin's own phone (auth/store.ts) is NOT one — that number was collected as a
 *     destination for alerts, never as an authenticator, and auto-granting it would
 *     hand every existing masjid a live grant the instant they flicked the switch.
 *   - A person with no scopes is dropped on load rather than kept as an empty shell.
 *
 * The file is chmod 600: it is a list of the masjid's trustees and their phone
 * numbers. Deliberately separate from `whatsapp.json`, whose whole config object is
 * handed to the sender — an authorisation list has no business travelling there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from '../config';
import { readJson, writeJson } from '../util/json-store';
import { toDigits } from '../util/phone';

const COMMANDS_PATH = path.join(CONFIG_DIR, 'commands.json');

/** The `!` that starts every command. Not configurable: a per-masjid prefix is a
 *  setting nobody documents and every app author then has to ask about. */
export const COMMAND_PREFIX = '!';

/** The namespace word for the platform's own commands. */
export const OS_SCOPE_WORD = 'os';
/** Read-only OS commands — stats, the app list, which apps have updates. */
export const OS_READ = 'os:read';
/** OS commands that change something — start, stop, restart, update one app. */
export const OS_CONTROL = 'os:control';

const APP_SCOPE_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** A grant is either one of the two OS halves, or an app id. */
export function isScopeKey(v: unknown): v is string {
  return typeof v === 'string' && (v === OS_READ || v === OS_CONTROL || APP_SCOPE_RE.test(v));
}

/** A masjid trusts a handful of people. A longer list is not a real configuration,
 *  and every entry is another phone that can restart the displays. */
const MAX_PEOPLE = 10;

export interface CommandPerson {
  /** Bare digits (toDigits output) — one number, one representation. THE identity. */
  phone: string;
  /** The admin's label for them. Shown in Settings; never sent anywhere. */
  label: string;
  /** What they may run. Empty is impossible — such an entry is dropped on load. */
  scopes: string[];
  addedAt: string;
  /** So an admin can spot a grant nobody has used in a year. */
  lastUsedAt: string | null;
}

export interface CommandConfig {
  enabled: boolean;
  people: CommandPerson[];
}

interface CommandFile {
  commands: CommandConfig;
}

const DEFAULT_CONFIG: CommandConfig = { enabled: false, people: [] };

function sanitizeScopes(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of v) {
    if (!isScopeKey(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= 64) break;
  }
  return out;
}

/** Drop anything malformed rather than trusting the file on disk. */
function sanitizePeople(list: unknown): CommandPerson[] {
  if (!Array.isArray(list)) return []; // absence means nobody, which is the safe answer
  const seen = new Set<string>();
  const out: CommandPerson[] = [];
  for (const raw of list) {
    const p = raw as Partial<CommandPerson> | null;
    // Re-canonicalise on EVERY load. A hand-edited "+44 7700 900123" has to become
    // the same digits the gate compares against, or the entry silently never matches
    // and the admin is left wondering why their commands are ignored.
    const phone = toDigits(String(p?.phone ?? ''));
    if (!phone || seen.has(phone)) continue;
    const scopes = sanitizeScopes(p?.scopes);
    if (scopes.length === 0) continue; // a person who may do nothing is not a person here
    seen.add(phone);
    out.push({
      phone,
      label: typeof p?.label === 'string' && p.label.trim() ? p.label.trim().slice(0, 60) : phone,
      scopes,
      addedAt: typeof p?.addedAt === 'string' ? p.addedAt : new Date(0).toISOString(),
      lastUsedAt: typeof p?.lastUsedAt === 'string' ? p.lastUsedAt : null,
    });
    if (out.length >= MAX_PEOPLE) break;
  }
  return out;
}

function withDefaults(c: Partial<CommandConfig> | undefined): CommandConfig {
  return {
    ...DEFAULT_CONFIG,
    ...(c ?? {}),
    // NOT via the spread: a file holding `"enabled": "yes"` must read as OFF. Same
    // lesson as isTruthyFlag in the compose gate, pointing the other way — there we
    // must not miss a truthy danger flag, here we must not accept a non-`true` as on.
    enabled: c?.enabled === true,
    people: sanitizePeople(c?.people),
  };
}

let cache: CommandConfig = withDefaults(
  readJson<CommandFile>(COMMANDS_PATH, { commands: DEFAULT_CONFIG }).commands,
);

function persist(): void {
  writeJson(COMMANDS_PATH, { commands: cache });
  try {
    fs.chmodSync(COMMANDS_PATH, 0o600);
  } catch {
    /* best effort (non-POSIX dev) */
  }
}

/** Called after any change so the inbound listener re-evaluates whether to connect
 *  and any pending confirmation from a removed person dies with their access.
 *  Registered rather than imported, to keep this module free of the transport. */
type ChangeHook = () => void;
const hooks: ChangeHook[] = [];
export function onCommandConfigChange(fn: ChangeHook): void {
  hooks.push(fn);
}
function changed(): void {
  persist();
  for (const fn of hooks) {
    try {
      fn();
    } catch {
      /* a listener must never break a settings save */
    }
  }
}

export function getCommandConfig(): CommandConfig {
  return cache;
}

export function listCommandPeople(): CommandPerson[] {
  return cache.people;
}

export function areCommandsEnabled(): boolean {
  return cache.enabled;
}

/**
 * THE authorisation check for an inbound command sender. Everything else in the
 * inbound path is parsing; this is the boundary.
 *
 * Fail-closed at every step, and a null is a SILENT drop — the caller must not reply.
 *
 * A plain linear find is right here: this is ten entries of a phone number, which is
 * not a secret, so a constant-time compare would buy nothing and cost legibility.
 */
export function authoriseSender(rawFrom: string | null | undefined): CommandPerson | null {
  if (!cache.enabled) return null;
  if (!rawFrom) return null; // @lid and friends arrive as null — see util/phone.ts
  const digits = toDigits(rawFrom);
  if (!digits) return null;
  return cache.people.find((p) => p.phone === digits) ?? null;
}

// There is deliberately no `authoriseCommand(from, scope)` here.
//
// One was written alongside this file and never called: dispatch authorises through
// `commands/registry.ts` `namespacesFor`, which resolves membership AND filters each
// namespace down to the commands that sender's scopes actually cover — so a command the
// sender cannot run is never in the list to be picked in the first place. That is the
// stronger shape, because it cannot be forgotten at a call site.
//
// It was worth deleting rather than leaving: the test suite exercised it under the name
// "scope is checked separately from membership", which read as coverage of the security
// boundary while the code that really runs had none. A dead function that tests point at
// is worse than no function.

export function setCommandsEnabled(on: boolean): CommandConfig {
  cache = { ...cache, enabled: on === true };
  changed();
  return cache;
}

/** Throws a friendly error on a number we cannot canonicalise — the same sentence the
 *  send path uses, so an admin sees one wording for one problem. */
export function addCommandPerson(rawPhone: string, label: string, scopes: string[] = []): CommandPerson[] {
  const phone = toDigits(rawPhone);
  if (!phone) throw new Error('That phone number needs a country code, e.g. +1 555 010 1234.');
  const name = String(label ?? '').trim().slice(0, 60);
  if (!name) throw new Error('Give this person a name so you can recognise them later.');
  const clean = sanitizeScopes(scopes);
  const existing = cache.people.find((p) => p.phone === phone);
  if (existing) {
    cache = {
      ...cache,
      people: cache.people.map((p) => (p.phone === phone ? { ...p, label: name, scopes: clean } : p)),
    };
  } else {
    if (cache.people.length >= MAX_PEOPLE) {
      throw new Error(`You can have at most ${MAX_PEOPLE} people on this list.`);
    }
    cache = {
      ...cache,
      people: [
        ...cache.people,
        { phone, label: name, scopes: clean, addedAt: new Date().toISOString(), lastUsedAt: null },
      ],
    };
  }
  changed();
  return cache.people;
}

export function renameCommandPerson(rawPhone: string, label: string): CommandPerson[] {
  const phone = toDigits(rawPhone);
  const name = String(label ?? '').trim().slice(0, 60);
  if (!name) throw new Error('Give this person a name so you can recognise them later.');
  cache = { ...cache, people: cache.people.map((p) => (p.phone === phone ? { ...p, label: name } : p)) };
  changed();
  return cache.people;
}

export function removeCommandPerson(rawPhone: string): CommandPerson[] {
  const phone = toDigits(rawPhone);
  cache = { ...cache, people: cache.people.filter((p) => p.phone !== phone) };
  changed();
  return cache.people;
}

/**
 * Remove EVERY authorised sender. For the "delete it all" path in Settings.
 *
 * This list is the whole authorisation model for admin commands — a phone on it can
 * start, stop and update a masjid's apps with no password step. Leaving it behind after
 * the masjid has deleted WhatsApp would mean that re-enabling the feature months later
 * silently re-arms whichever numbers were trusted back then, including a volunteer's
 * phone that has since changed hands. So it goes with everything else.
 *
 * One call to `changed()`, not one per person: the hook re-reconciles the inbound socket
 * and resets conversations, and firing that per row would do the same work N times.
 */
export function clearCommandPeople(): CommandPerson[] {
  cache = { ...cache, people: [] };
  changed();
  return cache.people;
}

/** Grant or revoke one scope for one person. Note this does NOT decide whether the
 *  scope is available — the caller (trpc/routers/commands.ts) refuses a grant for a
 *  scope that does not exist, and `commands/registry.ts` re-checks on READ anyway. */
export function setCommandScope(rawPhone: string, scope: string, allowed: boolean): CommandPerson[] {
  const phone = toDigits(rawPhone);
  if (!phone || !isScopeKey(scope)) throw new Error('That permission could not be changed.');
  cache = {
    ...cache,
    people: cache.people.map((p) => {
      if (p.phone !== phone) return p;
      const scopes = p.scopes.filter((s) => s !== scope);
      if (allowed) scopes.push(scope);
      return { ...p, scopes };
    }),
  };
  changed();
  return cache.people;
}

/** Stamp last-used, at most once a minute per person — this is a nicety for the
 *  Settings list, not something worth an fsync per message. */
let lastUseWrite = 0;
export function recordCommandUse(phone: string, now = Date.now()): void {
  if (now - lastUseWrite < 60_000) return;
  const person = cache.people.find((p) => p.phone === phone);
  if (!person) return;
  lastUseWrite = now;
  cache = {
    ...cache,
    people: cache.people.map((p) => (p.phone === phone ? { ...p, lastUsedAt: new Date(now).toISOString() } : p)),
  };
  persist(); // no hooks: nothing about reachability or access changed
}

/** Test seam — reload from disk after a fixture writes the file. */
export function __reloadCommandConfigForTests(): void {
  cache = withDefaults(readJson<CommandFile>(COMMANDS_PATH, { commands: DEFAULT_CONFIG }).commands);
}
