// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The admin account store. There is exactly one admin in v1.0 (CLAUDE.md §9).
 * The password is only ever held as an argon2id hash; the plaintext never
 * touches disk or the logs.
 */
import path from 'node:path';
import { CONFIG_DIR } from '../config';
import { readJson, writeJson } from '../util/json-store';

interface AuthFile {
  username: string | null;
  passwordHash: string | null;
  /** The admin's email — the login identifier for new installs AND where OS alerts
   *  go (app offline, updates, …). Optional so pre-email installs still load; those
   *  admins add it in Settings → Account. */
  email?: string | null;
  /** Display name (shown in the dashboard header). */
  name?: string | null;
}

const AUTH_PATH = path.join(CONFIG_DIR, 'auth.json');
const DEFAULTS: AuthFile = { username: null, passwordHash: null, email: null, name: null };

let cache: AuthFile = { ...DEFAULTS, ...readJson(AUTH_PATH, DEFAULTS) };

/** Whether an admin account has been created yet (drives the first-run flow). */
export function isConfigured(): boolean {
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

/** Update the admin's display name and/or email (Settings → Account). Pass a field
 *  to change it; omit to leave it as-is. */
export function setProfile(patch: { name?: string; email?: string }): void {
  cache = {
    ...cache,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.email !== undefined ? { email: patch.email } : {}),
  };
  writeJson(AUTH_PATH, cache);
}

/** Replace only the password hash, keeping the username/email/name. */
export function updatePasswordHash(passwordHash: string): void {
  cache = { ...cache, passwordHash };
  writeJson(AUTH_PATH, cache);
}
