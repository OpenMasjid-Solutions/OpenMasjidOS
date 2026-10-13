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
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from '../config';
import { readJson, writeJson } from '../util/json-store';
import { getAdminEmail } from './store';
import { emailDeliveryFingerprint } from '../store/email';
import {
  clockSkewSteps,
  generateSecret,
  otpauthUri,
  timingSafeEqualString,
  totpCounter,
  verifyTotp,
} from './totp';

const FILE = path.join(CONFIG_DIR, 'twofactor.json');

/** How long an emailed code lives. Long enough for slow mail, short enough to matter. */
export const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
/** Wrong guesses against one emailed code before it is burned. */
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
/** Minimum gap between emailed codes — this is also an email-bomb guard. */
export const EMAIL_CODE_MIN_INTERVAL_MS = 60 * 1000;
/** How many backup codes are issued at enrolment. */
export const BACKUP_CODE_COUNT = 10;
/**
 * How long a scanned-but-unconfirmed secret stays confirmable, and how many
 * wrong codes it survives.
 *
 * BOTH OF THESE CLOSE A REAL HOLE, not a theoretical one. `confirmEnrolment`
 * deliberately does not ask for the password — the pending secret was minted
 * behind one moments earlier and is worthless to anyone who did not receive it.
 * That reasoning is sound for the secret, and it was wrong about what confirming
 * HANDS BACK: the ten backup codes, each of which authorises a sign-in.
 *
 * So the attack was: an admin starts enrolment and closes the tab, leaving a
 * pending secret on disk; someone who has reached an authenticated dashboard but
 * does NOT have the password then guesses six digits against it. They never
 * learn the secret — they do not need to. They get the backup codes.
 *
 * A guess is worth about 3 in a million (the verification window accepts three
 * steps), which is nothing at five tries and quite a lot at a million. The cap
 * makes it five, and the TTL removes the stale tab that is the precondition.
 */
export const PENDING_TTL_MS = 15 * 60 * 1000;
export const PENDING_MAX_ATTEMPTS = 5;

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
  /** When it was minted — it stops being confirmable after `PENDING_TTL_MS`. */
  pendingTotpAt?: number;
  /** Wrong codes against it so far. At `PENDING_MAX_ATTEMPTS` it is discarded. */
  pendingTotpAttempts?: number;
  /** Emailed codes are allowed as a second factor. Needs a configured provider. */
  emailEnabled?: boolean;
  /**
   * Where emailed codes were going when they were switched on: the admin's address
   * and the mail account they are sent through (`emailBinding`). Codes are honoured
   * and sent only while that is still where they would go. See `emailUsable`.
   */
  emailBoundTo?: string;
  pendingEmail?: PendingEmailCode;
  backupCodes?: BackupCode[];
  /**
   * Changes whenever what counts as a second factor changes: an authenticator
   * enrolled, backup codes replaced, emailed codes switched on or off, two-step
   * sign-in turned off. A remote session records the value it signed in under and
   * is honoured from outside only while it still matches (auth/sessions.ts) — so
   * replacing a lost phone, or burning the backup codes someone found, shuts every
   * session made with the old ones out from the internet at once. Without it those
   * sessions ran from outside for their full seven days, files and terminals
   * included, whatever the admin did about the factor. On the masjid's network such a
   * session goes on working, as any session does there: the second factor has never
   * been part of signing in on the LAN, and a password change is what ends a session
   * everywhere.
   * Random rather than a counter, so a restored file can never collide with a value
   * a later change produced.
   */
  epoch?: string;
}

/** A fresh copy of the file, for code that changes it. */
function load(): TwoFactorConfig {
  return readJson<TwoFactorConfig>(FILE, {});
}

/**
 * The file as last read, for the read-only checks below: they run several times on every
 * request from outside. Kept while the file's stat stamp is unchanged, the way auth/store.ts
 * notices another process's write (reset-auth, a restore); a read that failed is never kept.
 */
let lastRead: { stamp: string; cfg: TwoFactorConfig } | null = null;

function save(cfg: TwoFactorConfig): void {
  // writeJson creates 0600 from the first byte (CLAUDE.md §15, secrets at rest).
  writeJson(FILE, cfg);
  lastRead = null;
}

function stampOf(): string | null {
  try {
    const st = fs.statSync(FILE);
    return `${st.ino}:${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

/** The configuration for READING. Never change what this returns — writers use `load()`. */
function current(): TwoFactorConfig {
  const stamp = stampOf();
  if (stamp === null) return {}; // no file: nothing is set up, which is what load() says too
  if (lastRead?.stamp === stamp) return lastRead.cfg;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    lastRead = { stamp, cfg: parsed as TwoFactorConfig };
    return lastRead.cfg;
  } catch {
    return {}; // as load() answers, but not kept: the next call reads again
  }
}

/** An authenticator app is set up and proved. */
function hasAuthenticator(c: TwoFactorConfig): c is TwoFactorConfig & { totpSecret: string } {
  return Boolean(c.totpSecret && c.totpConfirmedAt);
}

/** Some second factor must be satisfied to sign in from outside. */
function isActive(c: TwoFactorConfig): boolean {
  return hasAuthenticator(c) || emailUsable(c);
}

const sha256 = (v: string): string => crypto.createHash('sha256').update(v, 'utf8').digest('hex');

/**
 * Where an emailed code would go right now: the admin's address, and the mail
 * account it would be sent through.
 *
 * THE DESTINATION IS PART OF THE FACTOR. An emailed code proves "this person can
 * read the masjid admin's mail" only while it is sent to the masjid admin's mail.
 * Changing the address (Settings → Account) or pointing mail at another relay
 * (Settings → Email) needs nothing but a signed-in session — a password-only one,
 * on the masjid's network — so without this binding that session could quietly
 * redirect the next sign-in code, and the factor would no longer mean what the admin
 * switched on.
 *
 * Be exact about what this does NOT do: it is not what stands between a full dashboard
 * session at the masjid and signing in from outside. Such a session can download a
 * backup, which holds the authenticator's secret along with every other one (backups
 * are unencrypted, CLAUDE.md §15). What two-step sign-in protects is remote access
 * from someone who knows the password but cannot reach the masjid's network.
 */
function emailBinding(): string {
  const to = (getAdminEmail() ?? '').trim().toLowerCase();
  return sha256(`omos-email-factor:${to}\n${emailDeliveryFingerprint()}`);
}

/**
 * Emailed codes are on AND still going where they went when they were switched on.
 *
 * A change of address or mail account PAUSES them rather than following the change:
 * the admin turns them on again from the two-step panel, which asks for the password
 * and an authenticator code. Emailed codes are only ever offered alongside an
 * authenticator (Settings shows the switch once one is set up), so pausing them
 * never leaves the admin without a way in.
 */
function emailUsable(c: TwoFactorConfig): boolean {
  return Boolean(c.emailEnabled) && c.emailBoundTo === emailBinding();
}

/** Give the factor configuration a new epoch — see `TwoFactorConfig.epoch`. */
function bumpEpoch(cfg: TwoFactorConfig): void {
  cfg.epoch = crypto.randomBytes(16).toString('hex');
}

/**
 * A restore's hold on the epoch (`holdSecondFactorEpoch`), or null. While held,
 * `secondFactorEpoch()` answers the value the restore began with.
 */
let epochHold: { epoch: string } | null = null;

/**
 * The current second-factor epoch ('' for a configuration written before epochs
 * existed). A remote session is honoured only while it matches the one it signed in
 * under (auth/sessions.ts `getSessionUserFor`).
 */
export function secondFactorEpoch(): string {
  return epochHold ? epochHold.epoch : (current().epoch ?? '');
}

/**
 * Give the second factor a NEW epoch, once a restore has put a backup's twofactor.json
 * in place (system/restore.ts). Returns it.
 *
 * Releasing the restore's hold would otherwise hand the box the BACKUP's epoch: every
 * session made under the factor as it stood when the backup was taken counted from
 * outside again — one the admin had shut out since by replacing the factor included —
 * while the admin doing the restore was shut out. A new epoch counts for nobody; the
 * restore moves its own admin onto it (auth/sessions.ts `rebindRemoteSession`).
 */
export function renewSecondFactorEpoch(): string {
  const cfg = load();
  bumpEpoch(cfg);
  save(cfg);
  return cfg.epoch ?? '';
}

/**
 * Keep `secondFactorEpoch()` at its current value until released — for a restore,
 * which replaces twofactor.json under a running process (system/restore.ts says why).
 * Owned, like auth/store.ts `holdForRestore`: a release lifts only its own hold, and
 * is safe to call twice.
 *
 * The factor itself is not changed while held (`secondFactorHeld`; the two-step
 * router refuses, as the account store refuses a password change during a restore).
 * A change written now would not count until the release — and the admin making it,
 * moved onto the epoch that counts NOW, would be signed out from outside the moment
 * the restore let go. Signing in still works: a code checked during the hold is
 * judged, and the session bound, against the held epoch (`verifySecondFactor`).
 */
export function holdSecondFactorEpoch(): () => void {
  const hold = { epoch: load().epoch ?? '' };
  epochHold = hold;
  return () => {
    if (epochHold === hold) epochHold = null;
  };
}

/** Is a restore holding the epoch right now (`holdSecondFactorEpoch`)? */
export function secondFactorHeld(): boolean {
  return epochHold !== null;
}

/**
 * Bind emailed codes that were switched on before the binding existed to where
 * they go NOW. Run once at boot — not from a read, because a status check must
 * not change security state as a side effect (see `pendingIsLive`). Without it an
 * upgrade would pause every working emailed factor; with it, the binding starts
 * from what the masjid already had, which is the same trust the old code extended.
 */
export function adoptLegacyEmailBinding(): void {
  const cfg = load();
  if (!cfg.emailEnabled || cfg.emailBoundTo !== undefined) return;
  cfg.emailBoundTo = emailBinding();
  save(cfg);
}

/**
 * Would a configuration restored from a backup let the admin sign in with the SAME
 * second factor they use now? For a restore started from outside, which must not
 * swap in a factor the admin no longer has (system/restore.ts).
 *
 * The authenticator is what is compared — the secret itself, in constant time — and
 * both sides must have one.
 */
export function sameSecondFactorAs(other: unknown): boolean {
  const o = (other && typeof other === 'object' ? other : {}) as TwoFactorConfig;
  const c = load();
  const mine = hasAuthenticator(c) ? c.totpSecret : null;
  const theirs = typeof o.totpSecret === 'string' && o.totpConfirmedAt ? o.totpSecret : null;
  // With no authenticator to compare, say no. Emailed codes alone are never offered,
  // and whether a restored emailed factor would even work depends on the restored
  // address and mail account too — not something to guess at for a restore that
  // nobody can repair from outside if the guess is wrong.
  return mine !== null && theirs !== null && timingSafeEqualString(mine, theirs);
}

/** True when a second factor is enrolled and must be satisfied to sign in. */
export function twoFactorActive(): boolean {
  return isActive(current());
}

/** What the admin may be asked for, in the order the UI should offer them. */
export function availableFactors(): SecondFactorKind[] {
  const c = current();
  const out: SecondFactorKind[] = [];
  if (hasAuthenticator(c)) out.push('totp');
  if (emailUsable(c)) out.push('email');
  return out;
}

/**
 * Is there a pending enrolment that could still be confirmed?
 *
 * A PURE PREDICATE — it applies the TTL without deleting anything. A status read
 * must not mutate security state as a side effect; `confirmEnrolment` is where
 * an expired secret is actually dropped. (This repo has made the opposite
 * mistake before: `hasPending` in the WhatsApp command gate tested for presence
 * without applying its TTL, and an ignored prompt held the prefix exemption open
 * for ever.)
 */
function pendingIsLive(c: TwoFactorConfig, nowMs: number): boolean {
  if (!c.pendingTotpSecret) return false;
  if (c.pendingTotpAt === undefined || nowMs - c.pendingTotpAt > PENDING_TTL_MS) return false;
  return (c.pendingTotpAttempts ?? 0) < PENDING_MAX_ATTEMPTS;
}

/** Status for the dashboard. Deliberately returns NO secret and NO code. */
export function twoFactorStatus(nowMs: number = Date.now()): {
  active: boolean;
  totp: boolean;
  email: boolean;
  /** Switched on, but the address or mail account has changed since — see `emailUsable`. */
  emailPaused: boolean;
  enrolmentPending: boolean;
  backupCodesRemaining: number;
} {
  const c = current();
  return {
    active: isActive(c),
    totp: hasAuthenticator(c),
    email: Boolean(c.emailEnabled),
    emailPaused: Boolean(c.emailEnabled) && !emailUsable(c),
    enrolmentPending: pendingIsLive(c, nowMs),
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
export function beginEnrolment(
  account: string,
  issuer = 'OpenMasjidOS',
  nowMs: number = Date.now(),
): { secret: string; uri: string } {
  const cfg = load();
  const secret = generateSecret();
  cfg.pendingTotpSecret = secret;
  cfg.pendingTotpAt = nowMs;
  cfg.pendingTotpAttempts = 0;
  save(cfg);
  return { secret, uri: otpauthUri({ secretBase32: secret, account, issuer }) };
}

/** Forget a pending enrolment. Used when it expires, burns out, or is replaced. */
function dropPending(cfg: TwoFactorConfig): void {
  cfg.pendingTotpSecret = undefined;
  cfg.pendingTotpAt = undefined;
  cfg.pendingTotpAttempts = undefined;
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

  // Expired, or guessed at too many times. Either way the pending secret goes:
  // starting again costs the admin one button press, and it is the only thing
  // that bounds a search for the six digits that would hand over the backup
  // codes (see PENDING_TTL_MS for the full reasoning).
  const at = cfg.pendingTotpAt;
  const expired = at === undefined || nowMs - at > PENDING_TTL_MS;
  const burned = (cfg.pendingTotpAttempts ?? 0) >= PENDING_MAX_ATTEMPTS;
  if (expired || burned) {
    dropPending(cfg);
    save(cfg);
    return null;
  }

  const counter = verifyTotp(cfg.pendingTotpSecret, code, nowMs);
  if (counter === null) {
    // Counted BEFORE returning, so a flood burns the enrolment rather than
    // getting unlimited tries at it — the same shape as the emailed code.
    cfg.pendingTotpAttempts = (cfg.pendingTotpAttempts ?? 0) + 1;
    save(cfg);
    return null;
  }

  const plain = Array.from({ length: BACKUP_CODE_COUNT }, () => newBackupCode());
  cfg.totpSecret = cfg.pendingTotpSecret;
  cfg.totpConfirmedAt = new Date(nowMs).toISOString();
  // Spend the step that proved it, so the very code used to enrol cannot then
  // be replayed to sign in.
  cfg.lastCounter = counter;
  dropPending(cfg);
  cfg.backupCodes = plain.map((p) => ({ hash: sha256(p) }));
  bumpEpoch(cfg);
  save(cfg);
  revealedSteps.clear(); // they were the old secret's
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

/**
 * Steps still to come whose code a clock-skew note has confirmed (`skewSteps`). The note
 * tells whoever typed it "right, but for later", so that code is refused when its step
 * comes round. In memory only; a step is dropped once it is past.
 */
const revealedSteps = new Set<number>();

export type VerifyResult =
  | {
      ok: true;
      used: 'totp' | 'backup' | 'email';
      /**
       * The epoch of the configuration this code was checked against. A remote
       * session is bound to THIS, not to whatever is current when it is written —
       * the same rule as the password binding (auth/sessions.ts `createSession`).
       */
      epoch: string;
    }
  | {
      ok: false;
      reason: 'bad-code' | 'replayed' | 'expired' | 'too-many-attempts' | 'not-enrolled';
      /**
       * Set when the submitted code WOULD have been right had this server's
       * clock been this many 30-second steps different. Diagnostic only — the
       * code is still refused. A drifted clock and a mistyped code look
       * identical to the person typing and have opposite fixes, and without
       * this the admin has no reason to suspect the one that explains it.
       */
      skewSteps?: number;
    };

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
  // The epoch sessions are judged against RIGHT NOW — the held one during a restore —
  // or a sign-in made then was bound to the restored file's and refused at once.
  const epoch = epochHold ? epochHold.epoch : (cfg.epoch ?? '');
  const submitted = code.replace(/\s/g, '').toUpperCase();
  if (!isActive(cfg)) return { ok: false, reason: 'not-enrolled' };
  const step = totpCounter(Math.floor(nowMs / 1000));
  for (const s of revealedSteps) if (s < step - 1) revealedSteps.delete(s);

  // 1. TOTP.
  if (hasAuthenticator(cfg)) {
    const counter = verifyTotp(cfg.totpSecret, code, nowMs);
    if (counter !== null) {
      if ((cfg.lastCounter !== undefined && counter <= cfg.lastCounter) || revealedSteps.has(counter)) {
        return { ok: false, reason: 'replayed' };
      }
      cfg.lastCounter = counter;
      save(cfg);
      return { ok: true, used: 'totp', epoch };
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
    return { ok: true, used: 'backup', epoch };
  }

  // 3. A pending emailed code — only while emailed codes still go where they went
  //    when they were switched on (`emailUsable`).
  if (cfg.pendingEmail && emailUsable(cfg)) {
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
      return { ok: true, used: 'email', epoch };
    }
    // A wrong guess costs an attempt. Counted BEFORE returning, so a flood
    // burns the code rather than getting unlimited tries at it.
    p.attempts += 1;
    cfg.pendingEmail = p;
    save(cfg);
  }

  // Nothing matched. Before giving up, work out whether the TOTP code was right
  // and this server's CLOCK is wrong — the one failure the admin cannot guess at.
  const skew = hasAuthenticator(cfg) ? clockSkewSteps(cfg.totpSecret, code, nowMs) : null;
  if (skew === null) return { ok: false, reason: 'bad-code' };
  // A step still to come: the note confirms this code, so it must never be accepted then.
  if (skew > 0) revealedSteps.add(step + skew);
  return { ok: false, reason: 'bad-code', skewSteps: skew };
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
  // Bound to where codes go NOW — the address and account the admin just proved
  // themselves alongside (the router asks for the password and a current code).
  cfg.emailBoundTo = enabled ? emailBinding() : undefined;
  cfg.pendingEmail = undefined;
  bumpEpoch(cfg);
  save(cfg);
}

/** Issue a fresh set of backup codes, invalidating the old ones. Returned once. */
export function regenerateBackupCodes(): string[] {
  const cfg = load();
  const plain = Array.from({ length: BACKUP_CODE_COUNT }, () => newBackupCode());
  cfg.backupCodes = plain.map((p) => ({ hash: sha256(p) }));
  // New codes usually mean the old ones were seen by someone else, so a remote
  // session made with one of them must not outlive them.
  bumpEpoch(cfg);
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
  // Everything goes except a NEW epoch: a remote session made under the factor being
  // removed must not come back to life if two-step sign-in is switched on again.
  const cfg: TwoFactorConfig = {};
  bumpEpoch(cfg);
  save(cfg);
  revealedSteps.clear();
}
