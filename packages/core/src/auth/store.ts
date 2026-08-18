// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The admin account store. There is exactly one admin in v1.0 (CLAUDE.md §9).
 * The password is only ever held as an argon2id hash; the plaintext never
 * touches disk or the logs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from '../config';
import { writeJson } from '../util/json-store';
import { log } from '../logger';

interface AuthFile {
  username: string | null;
  passwordHash: string | null;
  /** The admin's email — the login identifier for new installs AND where OS alerts
   *  go (app offline, updates, …). Optional so pre-email installs still load; those
   *  admins add it in Settings → Account. */
  email?: string | null;
  /** Display name (shown in the dashboard header). */
  name?: string | null;
  /**
   * The admin's WhatsApp number, digits only in international format. Optional and
   * never a login identifier — it is purely a destination, for OS alerts routed to
   * the WhatsApp channel and for the "send test message" button, exactly as `email`
   * is for mail. Stored here rather than in settings.json for the same reason the
   * email is: it belongs to the person, not to the dashboard's appearance.
   */
  phone?: string | null;
}

const AUTH_PATH = path.join(CONFIG_DIR, 'auth.json');
const DEFAULTS: AuthFile = { username: null, passwordHash: null, email: null, name: null, phone: null };

/**
 * True when auth.json is PRESENT but could not be read or parsed.
 *
 * This distinction is load-bearing and used to be absent. `readJson` catches every
 * error and returns its fallback, so "no admin yet" (first run — the file does not
 * exist) and "the admin record is damaged" (SD-card corruption, a truncated write,
 * a partial restore, or someone deleting it through the File Explorer) looked
 * IDENTICAL. The second case then reported `isConfigured() === false`, which
 * re-opened `auth.setup` — a public procedure — on an already-established box, so
 * the next visitor on the masjid's LAN could claim it and inherit an admin session
 * that reaches host root.
 *
 * So a damaged file fails CLOSED: the box is treated as configured, setup stays
 * refused, and recovery goes through the documented CLI (`reset-password`), which
 * requires host access. Locking the admin out of their own dashboard is bad; letting
 * a stranger claim their masjid's server is worse.
 */
let corrupt = false;

function loadAuth(): AuthFile {
  let raw: string;
  try {
    raw = fs.readFileSync(AUTH_PATH, 'utf8');
  } catch (err) {
    // ENOENT is the legitimate first-run case. Anything else (EACCES, EIO) means a
    // file we cannot vouch for, so fail closed.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      corrupt = true;
      log.error(`Could not read ${AUTH_PATH}. Refusing first-run setup so the box cannot be claimed by someone else. Recover with the reset-password tool.`, err);
    }
    return { ...DEFAULTS };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    corrupt = true;
    log.error(`${AUTH_PATH} exists but is not valid JSON. Refusing first-run setup so the box cannot be claimed by someone else. Recover with the reset-password tool.`, err);
    return { ...DEFAULTS };
  }
  // Parsing is not enough — the VALUE has to be a plain object. `[]`, `"x"` and `0`
  // are all valid JSON that spread into DEFAULTS without error, producing an
  // all-null record that reads as "no admin yet" and re-opens first-run. A wrong
  // shape is a damaged file, not an empty one.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    corrupt = true;
    log.error(`${AUTH_PATH} does not contain an admin record. Refusing first-run setup so the box cannot be claimed by someone else. Recover with the reset-password tool.`);
    return { ...DEFAULTS };
  }
  return { ...DEFAULTS, ...(parsed as Partial<AuthFile>) };
}

let cache: AuthFile = loadAuth();

/** True when the stored admin record is unreadable — see `corrupt` above. */
export function isAuthStoreDamaged(): boolean {
  return corrupt;
}

/** Whether an admin account has been created yet (drives the first-run flow). */
export function isConfigured(): boolean {
  // `corrupt` counts as configured on purpose: it must never re-open first-run.
  if (corrupt) return true;
  return Boolean(cache.username && cache.passwordHash);
}

export function getUsername(): string | null {
  return cache.username;
}

export function getPasswordHash(): string | null {
  return cache.passwordHash;
}

/** The admin's email (alert destination), or null if not set (pre-email install). */
export function getAdminEmail(): string | null {
  return cache.email ?? null;
}

/** The admin's WhatsApp number (alert destination), or null if not set. */
export function getAdminPhone(): string | null {
  return cache.phone ?? null;
}

/** The admin's display name, or null. */
export function getAdminName(): string | null {
  return cache.name ?? null;
}

/** Create or replace the admin credentials (keeps email/name unless given). */
export function setCredentials(username: string, passwordHash: string): void {
  cache = { ...cache, username, passwordHash };
  writeJson(AUTH_PATH, cache);
}

export interface AdminInput {
  username: string;
  passwordHash: string;
  email?: string | null;
  name?: string | null;
}

/** First-run compare-and-set: create the admin ONLY if none exists yet (capturing
 *  email + display name), and report whether we did. The check + assignment run
 *  synchronously (no await between them), so they're atomic within the event loop —
 *  this closes the race where two concurrent `setup` calls both pass an earlier
 *  isConfigured() check (before either awaited argon2) and the later write clobbers
 *  the first admin. Returns false if an admin already exists. */
export function createAdminIfUnset(input: AdminInput): boolean {
  if (isConfigured()) return false;
  cache = {
    username: input.username,
    passwordHash: input.passwordHash,
    email: input.email ?? null,
    name: input.name ?? null,
  };
  writeJson(AUTH_PATH, cache);
  return true;
}

/** Update the admin's display name, email and/or WhatsApp number (Settings → Account).
 *  Pass a field to change it; omit to leave it as-is. */
export function setProfile(patch: { name?: string; email?: string; phone?: string }): void {
  cache = {
    ...cache,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.email !== undefined ? { email: patch.email } : {}),
    ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
  };
  writeJson(AUTH_PATH, cache);
}

/** Replace only the password hash, keeping the username/email/name. */
export function updatePasswordHash(passwordHash: string): void {
  cache = { ...cache, passwordHash };
  writeJson(AUTH_PATH, cache);
}
