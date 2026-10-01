// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Server-side sessions. Tokens are long random strings set in an HTTP-only,
 * SameSite=Lax cookie (Lax so the cookie rides the top-level "Open app"
 * navigation, which is cross-scheme — HTTPS dashboard → HTTP app — and would drop
 * a Strict cookie). NOT Secure on the LAN, so HTTP apps still receive it for SSO.
 *
 * Each session also carries a CSRF token (the "dashboard key"). The cookie is
 * SHARED with any installed app on another port of the same host (cookies aren't
 * port-scoped), so a malicious app could capture and replay it. The defence: the
 * dashboard key is delivered ONLY in the auth response body and the dashboard UI
 * keeps it in its own origin's storage (localStorage / a header) — which an app
 * on a different origin (port) physically cannot read. Cookie-authenticated
 * routes require the key, so possessing the cookie alone is not enough to act as
 * the admin (security audit: Fabric/SSO session-replay).
 *
 * ── SESSIONS SURVIVE A RESTART, AND WHY THAT IS A BUG FIX ───────────────────
 *
 * This file used to say "Sessions reset on a daemon restart — the admin simply
 * signs in again", and keep them in a plain Map. That was true of the dashboard
 * and false of everything else. The browser holds the cookie for SEVEN DAYS
 * (`maxAge` in trpc/context.ts); the Map was emptied by every update, reboot and
 * crash. So after any restart the admin's open dashboard tab went on drawing the
 * signed-in shell while its cookie pointed at nothing — and pressing Open on an
 * app handed that app a dead cookie. The app's SSO check came back "not signed
 * in", and because the platform WAS reachable the app refused its own password
 * recovery too ("sign in through your dashboard"), which is exactly what the admin
 * had just done. A masjid reported it as "it randomly asks for the control panel
 * password". It was every restart.
 *
 * So they are persisted to `config/sessions.json` (0600 via `writeJson`, atomic
 * temp-and-rename; `config/**` is refused to the File Explorer by
 * `protectedReason`). Reads stay in memory — `getSessionUser` runs on every
 * authenticated request and must not touch the disk.
 *
 * ── REVOCATION IS BOUND TO THE PASSWORD, NOT TO THE FILE ────────────────────
 *
 * Every session records a fingerprint of the password hash it was created under,
 * and is honoured only while that still matches the current one. That single rule
 * is what makes persistence safe, and the first version of this file did without
 * it — using "this token is missing from the file" as the revocation signal
 * instead. An adversarial review found five ways that went wrong:
 *
 *  - The installer's Reset sign-in runs in a SEPARATE process and only restarts
 *    the core minutes later, after reinstalling every app. The daemon still holds
 *    the OLD password hash in memory until then, so a sign-in with the old
 *    password in that window was written to disk and survived the reset — handing
 *    a seven-day session to precisely the person the reset existed to lock out.
 *  - A failed write could not be told apart from a revocation: a session the disk
 *    had refused to save was "missing from the file", so the next successful write
 *    from any other device silently signed it out — the reported lockout, back.
 *  - A restore, a race with the reset tools, or a period on an older Stable build
 *    (which never touches this file) could each bring sessions back that should
 *    have died.
 *
 * Bound to the password instead, none of those depend on what the file happens to
 * contain. Whoever changes the password — this daemon, the reset tools, a restore
 * of a backup with a different password, an older build — changes the hash, and
 * every session created under the old one stops working the moment the daemon
 * holding the new hash reads it. A fresh argon2 hash has a new random salt, so
 * even re-setting the SAME password revokes, which is what a reset should do.
 *
 * Other rules, each from a specific failure:
 *  - A damaged file never stops boot; it starts empty, which is the old behaviour
 *    (CLAUDE.md §15, the TLS-cert lesson: degrade, never exit).
 *  - A failed write never fails a sign-in, and never evicts anything.
 *  - A sign-out that cannot be written REMOVES the file rather than leaving the
 *    revoked session on disk to come back at the next boot: unlink still works on
 *    a full disk, and a missing file boots empty, which fails closed.
 *  - Signing out a token that is not a live session does nothing at all. Logout is
 *    a public procedure, and with tRPC batching one unauthenticated request could
 *    otherwise force hundreds of synchronous disk rewrites.
 *
 * Backups leave this file out (`system/backup.ts`): a session is a bearer
 * credential and the archive is unencrypted.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from '../config';
import { writeJson } from '../util/json-store';
import { getPasswordHash, isAuthStoreDamaged } from './store';
import { log } from '../logger';

export const COOKIE_NAME = 'omos_session';
/** Header the dashboard sends the key in (HTTP); raw WS/download routes use ?k=. */
export const CSRF_HEADER = 'x-omos-csrf';
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Where sessions are kept. Excluded from backups by name — see the header. */
export const SESSIONS_FILE = path.join(CONFIG_DIR, 'sessions.json');

interface Session {
  username: string;
  csrf: string;
  expiresAt: number;
  /** Fingerprint of the password hash this session was created under. */
  cred: string;
}

interface StoredSession extends Session {
  token: string;
}

interface SessionFile {
  v: 2;
  sessions: StoredSession[];
}

/**
 * The fingerprint of a given password hash. Not the hash: a session file must not
 * become a second copy of the thing an attacker would crack. Exported so sign-in
 * can bind to the hash it VERIFIED — see `freshCredential` and `createSession`.
 */
export function credentialFingerprint(hash: string | null): string {
  return crypto
    .createHash('sha256')
    .update(`omos-session-credential:${hash ?? ''}`)
    .digest('hex')
    .slice(0, 32);
}

// Memoized on the hash string, since it is consulted on every authenticated request.
let fpFor: string | null | undefined;
let fpValue = '';
function currentCred(): string {
  const hash = getPasswordHash();
  if (hash !== fpFor) {
    fpFor = hash;
    fpValue = credentialFingerprint(hash);
  }
  return fpValue;
}

/**
 * The fingerprint of the current password hash, as this process last read it.
 *
 * Cheap and throttled (auth/store.ts re-checks the file at most once a second), so
 * it is right for "is this session still live" and WRONG for "may this sign-in
 * finish" — use `freshCredential` for that.
 */
export function currentCredential(): string {
  return currentCred();
}

/**
 * The fingerprint of the current password hash, read from the file now.
 *
 * What a sign-in compares the hash it VERIFIED against, after argon2 or after
 * waiting for a second factor. A second review is why it is forced: the throttled
 * read could still be the old hash for up to a second after the installer's Reset
 * sign-in wrote a new one from another process, and the comparison passed for a
 * password that had already been replaced.
 */
export function freshCredential(): string {
  return credentialFingerprint(getPasswordHash({ fresh: true }));
}

function isLive(s: Session, nowMs: number): boolean {
  return s.expiresAt > nowMs && s.cred === currentCred();
}

/**
 * May this session be THROWN AWAY? Not the same question as "is it live".
 *
 * While the password file cannot be read, the current hash is unknown — so no
 * session is honoured (fail closed), but none is discarded either. Treating
 * "unreadable" as "the password changed" dropped every saved session after one
 * transient read error at boot, signing the admin and every app out: the very
 * symptom this file exists to fix. Once the file reads again, each session is
 * judged against the real hash.
 */
function isDead(s: Session, nowMs: number): boolean {
  if (s.expiresAt <= nowMs) return true;
  if (isAuthStoreDamaged()) return false;
  return s.cred !== currentCred();
}

/**
 * Left by a restore so the NEXT core to boot starts with no sessions — which is
 * what a restore always meant when sessions lived only in memory.
 *
 * A marker rather than `destroyAllSessions()` mid-restore, and a review is why. The
 * first fix signed everyone out as soon as config/ was replaced; the dashboard's
 * next sign-in check then dropped the admin to the sign-in screen part-way through
 * the restore, unmounting the window that reports whether it worked. The old core
 * keeps the admin signed in until it is replaced; the new one starts clean.
 */
export const SESSIONS_RESET_MARKER = path.join(CONFIG_DIR, 'sessions.reset');

/** Have the next boot start with no sessions. Never throws — a restore must not fail on it. */
export function endAllSessionsAtNextBoot(): void {
  try {
    fs.writeFileSync(SESSIONS_RESET_MARKER, 'Written by a restore; the next boot starts with no sessions.\n');
  } catch (err) {
    log.warn('Could not mark sessions to end after the restore.', err);
  }
}

function loadAtBoot(): Map<string, Session> {
  const out = new Map<string, Session>();
  if (fs.existsSync(SESSIONS_RESET_MARKER)) {
    // After a restore: start clean, and remove both files so this happens once.
    // If the sessions file cannot be removed, the marker stays and the next boot
    // tries again — it is never honoured "half".
    try {
      fs.rmSync(SESSIONS_FILE, { force: true });
      fs.rmSync(SESSIONS_RESET_MARKER, { force: true });
      log.info('Restored from a backup: everyone will need to sign in again.');
    } catch (err) {
      log.warn('Could not finish clearing sessions after a restore; will retry at the next start.', err);
    }
    return out;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('The saved sign-in sessions could not be read; everyone will need to sign in again.', err);
    }
    return out;
  }
  let parsed: Partial<SessionFile>;
  try {
    parsed = JSON.parse(raw) as Partial<SessionFile>;
  } catch {
    log.warn('The saved sign-in sessions were damaged; everyone will need to sign in again.');
    return out;
  }
  if (!parsed || !Array.isArray(parsed.sessions)) return out;
  const now = Date.now();
  // Ask the file now rather than trusting the throttled copy: if the store's own
  // boot read failed a moment ago, this is its retry (auth/store.ts NEVER_READ).
  getPasswordHash({ fresh: true });
  for (const s of parsed.sessions) {
    // Shape-check every field: a hand-edited or partially-restored file must not
    // be able to inject a session with no CSRF key — a cookie-only credential, the
    // exact thing the dashboard key exists to stop — or one with no credential
    // binding, which would outlive a password change.
    if (
      s &&
      typeof s.token === 'string' &&
      s.token.length >= 32 &&
      typeof s.username === 'string' &&
      s.username.length > 0 &&
      typeof s.csrf === 'string' &&
      s.csrf.length >= 32 &&
      typeof s.expiresAt === 'number' &&
      typeof s.cred === 'string' &&
      s.cred.length > 0
    ) {
      const session = { username: s.username, csrf: s.csrf, expiresAt: s.expiresAt, cred: s.cred };
      if (!isDead(session, now)) out.set(s.token, session);
    }
  }
  return out;
}

const sessions = loadAtBoot();
let writeFailureLogged = false;

/** Remove a leftover temp file: it would hold tokens, and backups must not carry them. */
function removeTemp(): void {
  try {
    fs.rmSync(`${SESSIONS_FILE}.tmp`, { force: true });
  } catch {
    /* best effort — it is excluded from backups regardless */
  }
}

/**
 * Write the live sessions to disk. Returns false if the disk refused.
 *
 * Memory is authoritative here and nothing is pruned on the strength of what the
 * file does or does not contain — that is the rule the first version broke (see
 * the header). Expired and superseded sessions are dropped first so they do not
 * accumulate on disk.
 */
function save(): boolean {
  const now = Date.now();
  for (const [token, s] of sessions) if (isDead(s, now)) sessions.delete(token);
  const file: SessionFile = { v: 2, sessions: [...sessions].map(([token, s]) => ({ token, ...s })) };
  try {
    writeJson(SESSIONS_FILE, file);
    writeFailureLogged = false;
    return true;
  } catch (err) {
    removeTemp();
    if (!writeFailureLogged) {
      writeFailureLogged = true;
      log.warn('Could not save sign-in sessions to disk.', err);
    }
    return false;
  }
}

/**
 * Make a removal durable even if the write failed: delete the file. Unlink works on
 * a full disk, and a missing file boots empty — so the revoked session cannot come
 * back, at the cost of everyone signing in again after the next restart.
 */
function saveRemoval(): void {
  if (save()) return;
  try {
    fs.rmSync(SESSIONS_FILE, { force: true });
    log.warn('Removed the saved sessions file so a signed-out session cannot return after a restart.');
  } catch (err) {
    log.error('A sign-out could not be saved, and the sessions file could not be removed either. Restarting OpenMasjidOS may bring it back until it expires.', err);
  }
}

export interface NewSession {
  token: string;
  /** The dashboard key — returned to the UI, never set in a cookie. */
  csrf: string;
}

/**
 * Mint a session, bound to `cred`: the fingerprint of the password the caller
 * actually proved (`credentialFingerprint(hash)` of the hash it verified, or set).
 *
 * Passed in, never re-read here. Reading the current hash at this point — which is
 * what this did — let a refresh landing between a sign-in's check and this call
 * bind the session to a password nobody had shown. If `cred` is already stale the
 * session is simply born dead, which is the right answer.
 *
 * REQUIRED, with no default, so `npm run lint` refuses a caller that leaves it out.
 * It had a default for tests at first, and the structural test standing in for the
 * compiler could be passed by a multi-line call with a trailing comma.
 */
export function createSession(username: string, cred: string): NewSession {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { username, csrf, expiresAt: Date.now() + TTL_MS, cred });
  // A failed save never fails the sign-in: the session works for the life of this
  // process, and the next successful save of anything writes it out with the rest.
  save();
  return { token, csrf };
}

/** Resolve the username for a token, or null if missing, expired or superseded. Memory only. */
export function getSessionUser(token: string | undefined | null): string | null {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  const now = Date.now();
  if (!isLive(s, now)) {
    // Dropped from memory now (the next save drops it from disk) — unless it is only
    // unverifiable for the moment, in which case it is kept for when it can be.
    if (isDead(s, now)) sessions.delete(token);
    return null;
  }
  return s.username;
}

/**
 * Constant-time check that `provided` matches the session's dashboard key. A
 * cookie-authenticated request that can't present the key is treated as a
 * replay (e.g. from an app that captured the shared cookie) and rejected.
 */
export function verifyCsrf(token: string | undefined | null, provided: string | undefined | null): boolean {
  if (!token || !provided) return false;
  const s = sessions.get(token);
  if (!s || !isLive(s, Date.now())) return false;
  const a = Buffer.from(s.csrf);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function destroySession(token: string | undefined | null): void {
  // Nothing to do — and nothing written — for a token that is not a live session.
  // Logout is a public procedure: without this, any cookie value made it rewrite
  // the file, and a batched request could make it do so hundreds of times.
  if (!token || !sessions.has(token)) return;
  sessions.delete(token);
  saveRemoval();
}

/**
 * Drop every session — after a password change, and from the installer's Reset
 * sign-in. The password change itself is what revokes durably (every session is
 * bound to the old hash); clearing the file as well keeps it from holding dead
 * entries, and removing it outright is the fallback when the disk refuses.
 */
export function destroyAllSessions(): void {
  sessions.clear();
  saveRemoval();
}

/** How many sessions are live in memory — for tests and diagnostics only. */
export function sessionCount(): number {
  return sessions.size;
}

export const SESSION_TTL_MS = TTL_MS;
