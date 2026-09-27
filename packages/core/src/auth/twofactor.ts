// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The second factor: enrolment, verification and the state that makes it one.
 *
 * `auth/totp.ts` is the maths and remembers nothing. This file is the part that
 * makes a code single-use, which is the difference between a second factor and
 * a password that changes every thirty seconds. Three pieces of state matter:
 *
 *  - `lastCounter` — a TOTP code is refused once its step has been used. Without
 *    it, a code shoulder-surfed, phished or read off a shared screen stays valid
 *    for the rest of its window AND the next one, on any number of devices.
 *  - `usedAt` on a backup code — one use, ever.
 *  - the pending email challenge — one code, one TTL, a hard attempt cap.
 *
 * WHAT IS STORED AND WHY IT IS SHAPED THIS WAY:
 *  - The TOTP secret is stored in the clear. It has to be: verifying a code
 *    means recomputing the HMAC, so there is no one-way form that still works.
 *    `config/` is 0700 and this file 0600, the same treatment as the Stripe keys
 *    and the TLS private key, and it never leaves the server — the API returns
 *    "is enrolled", never the secret, except during the enrolment exchange.
 *  - Backup codes and email codes ARE hashed, with SHA-256 and not argon2. That
 *    is deliberate: both are high-entropy values this server generated (50 and
 *    ~20 bits), not human-chosen passwords, so there is nothing to guess offline
 *    and nothing for a slow hash to buy. Verifying a backup code means trying
 *    each of ten, and ten argon2 verifies per attempt would be a denial-of-
 *    service lever pointed at our own login.
 *
 * ENROLMENT IS TWO STEPS ON PURPOSE. `beginEnrolment` mints a secret and stores
 * it as PENDING; only `confirmEnrolment`, with a working code, makes it active.
 * An admin who scans a QR, then closes the tab before their app is set up, must
 * not be locked out of their own masjid by a factor they never proved they had.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { CONFIG_DIR } from '../config';
import { readJson, writeJson } from '../util/json-store';
import { generateSecret, otpauthUri, timingSafeEqualString, verifyTotp, TOTP_STEP_SECONDS } from './totp';

const FILE = path.join(CONFIG_DIR, 'twofactor.json');

/** How long an emailed code lives. Long enough for slow mail, short enough to matter. */
export const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
/** Wrong guesses against one emailed code before it is burned. */
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
/** Minimum gap between emailed codes — this is also an email-bomb guard. */
export const EMAIL_CODE_MIN_INTERVAL_MS = 60 * 1000;
/** How many backup codes are issued at enrolment. */
export const BACKUP_CODE_COUNT = 10;

export type SecondFactorKind = 'totp' | 'email';

interface PendingEmailCode {
  /** SHA-256 of the code. The code itself is never stored. */
  hash: string;
  expiresAt: number;
  attempts: number;
  sentAt: number;
}

interface BackupCode {
  hash: string;
  usedAt?: string;
}

export interface TwoFactorConfig {
  /** Active TOTP secret (base32). Absent when TOTP is not enrolled. */
  totpSecret?: string;
  /** Set only once a code has actually verified. A pending secret gates nothing. */
  totpConfirmedAt?: string;
  /** Highest TOTP step already spent. Replay guard — see the file header. */
  lastCounter?: number;
  /** A secret minted by `beginEnrolment` and not yet proved. */
  pendingTotpSecret?: string;
  /** Emailed codes are allowed as a second factor. Needs a configured provider. */
  emailEnabled?: boolean;
  pendingEmail?: PendingEmailCode;
  backupCodes?: BackupCode[];
}

function load(): TwoFactorConfig {
  return readJson<TwoFactorConfig>(FILE, {});
}

function save(cfg: TwoFactorConfig): void {
  // writeJson creates 0600 from the first byte (CLAUDE.md §15, secrets at rest).
  writeJson(FILE, cfg);
}

const sha256 = (v: string): string => crypto.createHash('sha256').update(v, 'utf8').digest('hex');

/** True when a second factor is enrolled and must be satisfied to sign in. */
export function twoFactorActive(): boolean {
  const c = load();
  return Boolean((c.totpSecret && c.totpConfirmedAt) || c.emailEnabled);
}

/** What the admin may be asked for, in the order the UI should offer them. */
export function availableFactors(): SecondFactorKind[] {
  const c = load();
  const out: SecondFactorKind[] = [];
  if (c.totpSecret && c.totpConfirmedAt) out.push('totp');
  if (c.emailEnabled) out.push('email');
  return out;
}

/** Status for the dashboard. Deliberately returns NO secret and NO code. */
export function twoFactorStatus(): {
  active: boolean;
  totp: boolean;
  email: boolean;
  enrolmentPending: boolean;
  backupCodesRemaining: number;
} {
  const c = load();
  return {
    active: twoFactorActive(),
    totp: Boolean(c.totpSecret && c.totpConfirmedAt),
    email: Boolean(c.emailEnabled),
    enrolmentPending: Boolean(c.pendingTotpSecret),
    backupCodesRemaining: (c.backupCodes ?? []).filter((b) => !b.usedAt).length,
  };
}

// ── TOTP enrolment ─────────────────────────────────────────────────────────

/**
 * Mint a secret and hand back what the admin needs to add it to their app. The
 * secret is PENDING until `confirmEnrolment` sees a working code — nothing about
 * signing in changes until then.
 *
 * Calling this again before confirming replaces the pending secret, which is the
 * behaviour you want: an admin who lost the first QR just asks for another.
 */
export function beginEnrolment(account: string, issuer = 'OpenMasjidOS'): { secret: string; uri: string } {
  const cfg = load();
  const secret = generateSecret();
  cfg.pendingTotpSecret = secret;
  save(cfg);
  return { secret, uri: otpauthUri({ secretBase32: secret, account, issuer }) };
}

/**
 * Prove the pending secret with a live code, activate it, and issue backup codes.
 *
 * The plaintext backup codes are returned EXACTLY ONCE, here. They are stored
 * hashed, so there is no second chance to read them — which is the point, and
 * the UI has to say so before the admin navigates away.
 */
export function confirmEnrolment(code: string, nowMs: number = Date.now()): string[] | null {
  const cfg = load();
  if (!cfg.pendingTotpSecret) return null;
  const counter = verifyTotp(cfg.pendingTotpSecret, code, nowMs);
  if (counter === null) return null;

  const plain = Array.from({ length: BACKUP_CODE_COUNT }, () => newBackupCode());
  cfg.totpSecret = cfg.pendingTotpSecret;
  cfg.totpConfirmedAt = new Date(nowMs).toISOString();
  // Spend the step that proved it, so the very code used to enrol cannot then
  // be replayed to sign in.
  cfg.lastCounter = counter;
  cfg.pendingTotpSecret = undefined;
  cfg.backupCodes = plain.map((p) => ({ hash: sha256(p) }));
  save(cfg);
  return plain;
}

/** 10 chars of Crockford-ish base32, ~50 bits. Grouped for legibility on paper. */
function newBackupCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) out += alphabet[bytes[i]! % alphabet.length];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

// ── verification ───────────────────────────────────────────────────────────

export type VerifyResult =
  | { ok: true; used: 'totp' | 'backup' | 'email' }
  | { ok: false; reason: 'bad-code' | 'replayed' | 'expired' | 'too-many-attempts' | 'not-enrolled' };

/**
 * Check a submitted second factor against everything enrolled.
 *
 * TOTP is tried first, then a backup code, then a pending emailed code. Each is
 * spent on success. A REPLAY is reported distinctly from a wrong code — not to
 * the user, who gets one message either way, but so an operator reading the log
 * can tell "they typed it twice" from "someone is guessing".
 */
export function verifySecondFactor(code: string, nowMs: number = Date.now()): VerifyResult {
  const cfg = load();
  const submitted = code.replace(/\s/g, '').toUpperCase();
  if (!twoFactorActive()) return { ok: false, reason: 'not-enrolled' };

  // 1. TOTP.
  if (cfg.totpSecret && cfg.totpConfirmedAt) {
    const counter = verifyTotp(cfg.totpSecret, code, nowMs);
    if (counter !== null) {
      if (cfg.lastCounter !== undefined && counter <= cfg.lastCounter) {
        return { ok: false, reason: 'replayed' };
      }
      cfg.lastCounter = counter;
      save(cfg);
      return { ok: true, used: 'totp' };
    }
  }

  // 2. A backup code. Compared against every UNUSED code in constant time, and
  //    the loop is not short-circuited, so the number of comparisons does not
  //    depend on which code matched.
  const backups = cfg.backupCodes ?? [];
  let matched = -1;
  const hash = sha256(submitted);
  for (let i = 0; i < backups.length; i++) {
    const b = backups[i]!;
    if (b.usedAt) continue;
    if (timingSafeEqualString(b.hash, hash) && matched < 0) matched = i;
  }
  if (matched >= 0) {
    backups[matched]!.usedAt = new Date(nowMs).toISOString();
    cfg.backupCodes = backups;
    save(cfg);
    return { ok: true, used: 'backup' };
  }

  // 3. A pending emailed code.
  if (cfg.pendingEmail) {
    const p = cfg.pendingEmail;
    if (nowMs > p.expiresAt) {
      cfg.pendingEmail = undefined;
      save(cfg);
      return { ok: false, reason: 'expired' };
    }
    if (p.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
      cfg.pendingEmail = undefined;
      save(cfg);
      return { ok: false, reason: 'too-many-attempts' };
    }
    if (timingSafeEqualString(p.hash, sha256(submitted))) {
      cfg.pendingEmail = undefined; // single use
      save(cfg);
      return { ok: true, used: 'email' };
    }
    // A wrong guess costs an attempt. Counted BEFORE returning, so a flood
    // burns the code rather than getting unlimited tries at it.
    p.attempts += 1;
    cfg.pendingEmail = p;
    save(cfg);
  }

  return { ok: false, reason: 'bad-code' };
}

// ── emailed codes ──────────────────────────────────────────────────────────

/**
 * Mint an emailed code, or refuse if one was sent moments ago.
 *
 * The rate limit is not only about brute force: without it this endpoint is an
 * email bomb pointed at the masjid's own admin, and at whatever reputation their
 * SMTP sender has. Returns the plaintext for the CALLER to send — this module
 * never touches the mail path, so the code and the transport stay separable.
 */
export function issueEmailCode(nowMs: number = Date.now()): { code: string } | { retryAfterMs: number } {
  const cfg = load();
  const prev = cfg.pendingEmail;
  if (prev && nowMs - prev.sentAt < EMAIL_CODE_MIN_INTERVAL_MS) {
    return { retryAfterMs: EMAIL_CODE_MIN_INTERVAL_MS - (nowMs - prev.sentAt) };
  }
  // Six digits, uniformly. `randomInt` is rejection-sampled, so no modulo bias.
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  cfg.pendingEmail = {
    hash: sha256(code),
    expiresAt: nowMs + EMAIL_CODE_TTL_MS,
    attempts: 0,
    sentAt: nowMs,
  };
  save(cfg);
  return { code };
}

/** Turn emailed codes on or off as a factor. Requires a configured mail provider — the caller checks. */
export function setEmailFactor(enabled: boolean): void {
  const cfg = load();
  cfg.emailEnabled = enabled;
  if (!enabled) cfg.pendingEmail = undefined;
  save(cfg);
}

/** Issue a fresh set of backup codes, invalidating the old ones. Returned once. */
export function regenerateBackupCodes(): string[] {
  const cfg = load();
  const plain = Array.from({ length: BACKUP_CODE_COUNT }, () => newBackupCode());
  cfg.backupCodes = plain.map((p) => ({ hash: sha256(p) }));
  save(cfg);
  return plain;
}

/**
 * Remove the second factor entirely.
 *
 * Every field goes, including `lastCounter` and the backup codes — a later
 * re-enrolment mints a new secret, so a counter from the old one would only be
 * a stale bound, and stale security state is how a replay guard quietly stops
 * guarding. The caller is responsible for requiring the password (and, if one is
 * active, the current second factor) before calling this.
 */
export function disableTwoFactor(): void {
  save({});
}

/** Seconds until the current TOTP step rolls over — for "this code expires in…". */
export function secondsUntilNextStep(nowMs: number = Date.now()): number {
  return TOTP_STEP_SECONDS - (Math.floor(nowMs / 1000) % TOTP_STEP_SECONDS);
}
