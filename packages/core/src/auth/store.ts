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
}

const AUTH_PATH = path.join(CONFIG_DIR, 'auth.json');
const DEFAULTS: AuthFile = { username: null, passwordHash: null };

let cache: AuthFile = readJson(AUTH_PATH, DEFAULTS);

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

/** Create or replace the admin credentials. */
export function setCredentials(username: string, passwordHash: string): void {
  cache = { username, passwordHash };
  writeJson(AUTH_PATH, cache);
}

/** First-run compare-and-set: create the admin ONLY if none exists yet, and
 *  report whether we did. The check + assignment run synchronously (no await
 *  between them), so they're atomic within the event loop — this closes the race
 *  where two concurrent first-run `setup` calls both pass an earlier
 *  isConfigured() check (before either awaited argon2) and the later write clobbers
 *  the first admin. Returns false if an admin already exists. */
export function setCredentialsIfUnset(username: string, passwordHash: string): boolean {
  if (isConfigured()) return false;
  cache = { username, passwordHash };
  writeJson(AUTH_PATH, cache);
  return true;
}

/** Replace only the password hash, keeping the username. */
export function updatePasswordHash(passwordHash: string): void {
  cache = { ...cache, passwordHash };
  writeJson(AUTH_PATH, cache);
}
