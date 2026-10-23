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

/**
 * ── NOTICING A CHANGE MADE BY ANOTHER PROCESS ───────────────────────────────
 *
 * This cache used to be read once, at boot, and never again. The installer's
 * Reset sign-in is a SEPARATE process: it writes a new password hash to auth.json,
 * reinstalls every app — minutes — and only then restarts the core. Until that
 * restart the daemon went on accepting the OLD password, and any daemon-side write
 * (a profile edit, even an empty one) wrote the OLD hash back over the reset,
 * undoing it. Sessions are bound to the password hash (auth/sessions.ts), so the
 * same window also kept every old session alive.
 *
 * So the daemon now notices: a cheap stat of the file (inode, mtime, size), at
 * most once a second on reads and ALWAYS before a write or a password check. Two
 * rules make this safe:
 *  - ONLY A GOOD READ IS ADOPTED. A read that fails, a damaged file, or a missing
 *    file keeps the last good copy and is retried later. Adopting a bad read would
 *    lock the admin out on one transient SD-card error, and adopting a MISSING file
 *    as "no admin yet" would re-open first-run setup for the next visitor — the
 *    exact takeover the `corrupt` flag above exists to prevent.
 *  - A good read also clears `corrupt`: a box whose file was damaged at boot and
 *    then repaired by the reset tool is usable again without a restart.
 */
const REFRESH_EVERY_MS = 1000;
/** Not a stamp `stampOf` can return, so it never matches the file. */
const NEVER_READ = '';
/**
 * The stamp of the file `cache` was last read from or written to. After a failed
 * boot read it is a value no stat can produce, so the first re-check reads the file
 * again rather than seeing "unchanged" and trusting a read that never worked — one
 * transient EIO at boot otherwise refused the right password and dropped every
 * saved session until something rewrote the file. A file that really is damaged
 * just fails `readGood` again, at most once a second, which is harmless.
 */
let lastStamp = corrupt ? NEVER_READ : stampOf();
let lastCheck = Date.now();

function stampOf(): string {
  try {
    const st = fs.statSync(AUTH_PATH);
    return `${st.ino}:${st.mtimeMs}:${st.size}`;
  } catch {
    return 'unreadable';
  }
}

/** Read auth.json with no side effects. Only an object with a record counts. */
function readGood(): AuthFile | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return { ...DEFAULTS, ...(parsed as Partial<AuthFile>) };
  } catch {
    return null;
  }
}

/**
 * A restore replaces config/ underneath the daemon. While it runs, this daemon keeps
 * serving the identity it started the restore with: adopting the restored auth.json
 * mid-way (which `refresh` otherwise would, within a second) signs the admin out
 * part-way through, and the dashboard then unmounts the restore's progress and
 * failure report — the window that tells them whether it worked. The NEW core that
 * a restore ends by starting reads everything fresh anyway.
 *
 * Writes are REFUSED while held, not merely delayed. Between the restore removing
 * config/ and moving the restored copy into place, auth.json does not exist at all;
 * a write in that gap would recreate config/ and make the restore's rename fail.
 */
let holds = 0;
/**
 * Hold the store for one restore. Returns that restore's release, which is safe to
 * call more than once and only ever releases its OWN hold.
 *
 * Owned rather than a shared flag, because a flag let one restore lift another's
 * hold: a second run that failed early released in its `finally` while the first
 * was still mid-way, and the store adopted the restored record under it. Restores
 * are also single-flight now (system/restore.ts), so this is the second line of
 * defence, not the first.
 */
export function holdForRestore(): () => void {
  holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    if (holds === 0) lastCheck = 0; // look at the file straight away
  };
}
function assertNotHeld(): void {
  if (holds > 0) throw new Error('A restore is in progress. Please try again once it has finished.');
}

function refresh(force = false): void {
  if (holds > 0) return;
  const now = Date.now();
  if (!force && now - lastCheck < REFRESH_EVERY_MS) return;
  lastCheck = now;
  const stamp = stampOf();
  if (stamp === lastStamp) return;
  const next = readGood();
  if (!next) return; // keep the last good copy; lastStamp unchanged, so we retry
  cache = next;
  corrupt = false;
  lastStamp = stamp;
}

/**
 * Write `next`, and only once that has worked make it what this process believes.
 *
 * The other order — assign the cache, then write — meant a failed write (a full SD
 * card) still changed the password IN MEMORY. Sessions are bound to the password,
 * so the admin was signed out by their own failed change, told it had failed, and
 * then refused when they signed back in with the old password; the new one worked
 * only until a restart brought the disk copy back. And nothing could repair it,
 * because the file never changed, so its stamp never did either. Now a failed
 * write throws with memory and disk still agreeing.
 */
function save(next: AuthFile): void {
  writeJson(AUTH_PATH, next);
  cache = next;
  lastStamp = stampOf(); // our own write is not news
}

/** True when the stored admin record is unreadable — see `corrupt` above. */
export function isAuthStoreDamaged(): boolean {
  refresh();
  return corrupt;
}

/** Whether an admin account has been created yet (drives the first-run flow). */
export function isConfigured(): boolean {
  refresh();
  // `corrupt` counts as configured on purpose: it must never re-open first-run.
  if (corrupt) return true;
  return Boolean(cache.username && cache.passwordHash);
}

export function getUsername(): string | null {
  refresh();
  return cache.username;
}

/**
 * The current password hash. `fresh` forces a check of the file first — used by
 * anything that VERIFIES a password, so a reset made by another process a moment
 * ago is honoured at once rather than within the next second.
 */
export function getPasswordHash(opts: { fresh?: boolean } = {}): string | null {
  refresh(opts.fresh === true);
  return cache.passwordHash;
}

/** The admin's email (alert destination), or null if not set (pre-email install). */
export function getAdminEmail(): string | null {
  refresh();
  return cache.email ?? null;
}

/** The admin's WhatsApp number (alert destination), or null if not set. */
export function getAdminPhone(): string | null {
  refresh();
  return cache.phone ?? null;
}

/** The admin's display name, or null. */
export function getAdminName(): string | null {
  refresh();
  return cache.name ?? null;
}

/** Create or replace the admin credentials (keeps email/name unless given). */
export function setCredentials(username: string, passwordHash: string): void {
  assertNotHeld();
  refresh(true);
  save({ ...cache, username, passwordHash });
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
  assertNotHeld();
  refresh(true);
  if (isConfigured()) return false;
  save({
    username: input.username,
    passwordHash: input.passwordHash,
    email: input.email ?? null,
    name: input.name ?? null,
  });
  return true;
}

/** Update the admin's display name, email and/or WhatsApp number (Settings → Account).
 *  Pass a field to change it; omit to leave it as-is. */
export function setProfile(patch: { name?: string; email?: string; phone?: string }): void {
  // Merged onto the LATEST file, not a stale cache — or this would write an old
  // password hash back over a reset made by another process.
  assertNotHeld();
  refresh(true);
  save({
    ...cache,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.email !== undefined ? { email: patch.email } : {}),
    ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
  });
}

/** Replace only the password hash, keeping the username/email/name. */
export function updatePasswordHash(passwordHash: string): void {
  assertNotHeld();
  refresh(true);
  save({ ...cache, passwordHash });
}
