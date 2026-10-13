// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The state that makes a second factor a second factor.
 *
 * `totp.test.ts` proves the maths against published vectors. This proves the
 * things the maths cannot: that a code is spent when it is used, that an
 * unconfirmed enrolment gates nothing, that a backup code works once, and that
 * an emailed code expires, burns out under guessing and cannot be requested in
 * a loop. Every one of those is a place where an implementation that "works"
 * when you try it by hand is not actually a second factor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.OPENMASJID_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-2fa-'));

const req = createRequire(__filename);
const tf = req('../src/auth/twofactor') as typeof import('../src/auth/twofactor');
const totpLib = req('../src/auth/totp') as typeof import('../src/auth/totp');

/** Enrol and return the secret + the backup codes, at a fixed moment. */
function enrol(at: number): { secret: string; backups: string[] } {
  const { secret } = tf.beginEnrolment('admin');
  const backups = tf.confirmEnrolment(totpLib.totp(secret, at), at);
  assert.ok(backups, 'enrolment must confirm with a live code');
  return { secret, backups: backups! };
}

/**
 * A successful check also reports the epoch it was made under (auth/twofactor.ts
 * `epoch`), which is random; these tests are about WHICH factor passed, so compare
 * that and leave the epoch to the tests below that are about it.
 */
function okUsed(r: ReturnType<typeof tf.verifySecondFactor>): unknown {
  return r.ok ? { ok: r.ok, used: r.used } : r;
}

const T = 1_700_000_000_000; // a fixed "now" so nothing depends on the wall clock
const STEP = 30_000;

test('nothing is active before enrolment, and status leaks no secret', () => {
  tf.disableTwoFactor();
  assert.equal(tf.twoFactorActive(), false);
  assert.deepEqual(tf.availableFactors(), []);
  const s = tf.twoFactorStatus();
  assert.deepEqual(s, {
    active: false,
    totp: false,
    email: false,
    emailPaused: false,
    enrolmentPending: false,
    backupCodesRemaining: 0,
  });
  assert.equal(JSON.stringify(s).includes('secret'), false, 'status must never carry the secret');
});

test('a PENDING enrolment gates nothing', () => {
  // An admin who scans the QR and closes the tab before their app is set up must
  // not be locked out by a factor they never proved they had.
  tf.disableTwoFactor();
  tf.beginEnrolment('admin');
  assert.equal(tf.twoFactorActive(), false, 'pending is not active');
  assert.equal(tf.twoFactorStatus().enrolmentPending, true);
  assert.deepEqual(tf.availableFactors(), []);
});

test('enrolment needs a working code, and a wrong one changes nothing', () => {
  tf.disableTwoFactor();
  tf.beginEnrolment('admin');
  assert.equal(tf.confirmEnrolment('000000', T), null, 'a wrong code must not enrol');
  assert.equal(tf.twoFactorActive(), false);
  assert.equal(tf.twoFactorStatus().enrolmentPending, true, 'and must not discard the pending secret');
});

test('confirming activates TOTP and issues backup codes exactly once', () => {
  tf.disableTwoFactor();
  const { backups } = enrol(T);
  assert.equal(backups.length, tf.BACKUP_CODE_COUNT);
  assert.equal(new Set(backups).size, tf.BACKUP_CODE_COUNT, 'codes must be distinct');
  assert.equal(tf.twoFactorActive(), true);
  assert.deepEqual(tf.availableFactors(), ['totp']);
  assert.equal(tf.twoFactorStatus().backupCodesRemaining, tf.BACKUP_CODE_COUNT);
});

// ── the replay guard ───────────────────────────────────────────────────────

test('THE CODE THAT ENROLLED CANNOT THEN SIGN IN', () => {
  // The step is spent by confirmEnrolment. Without that, the code an admin has
  // just typed into the enrolment box is still live for the rest of its window.
  tf.disableTwoFactor();
  const { secret } = enrol(T);
  const r = tf.verifySecondFactor(totpLib.totp(secret, T), T);
  assert.deepEqual(r, { ok: false, reason: 'replayed' });
});

test('a TOTP code works once and is then refused as a replay', () => {
  tf.disableTwoFactor();
  const { secret } = enrol(T);
  const later = T + 5 * STEP;
  const code = totpLib.totp(secret, later);

  assert.deepEqual(okUsed(tf.verifySecondFactor(code, later)), { ok: true, used: 'totp' });
  // Same code, same window — this is the shoulder-surf / phish case.
  assert.deepEqual(okUsed(tf.verifySecondFactor(code, later)), { ok: false, reason: 'replayed' });
  // And still refused a step later, when drift alone would otherwise accept it.
  assert.deepEqual(okUsed(tf.verifySecondFactor(code, later + STEP)), { ok: false, reason: 'replayed' });
});

test('an OLDER step is refused even though drift would accept it', () => {
  tf.disableTwoFactor();
  const { secret } = enrol(T);
  const later = T + 10 * STEP;
  assert.deepEqual(okUsed(tf.verifySecondFactor(totpLib.totp(secret, later), later)), { ok: true, used: 'totp' });
  // The previous step is inside the +/-1 window, but it is behind the high-water
  // mark, so it must not be accepted.
  assert.deepEqual(
    okUsed(tf.verifySecondFactor(totpLib.totp(secret, later - STEP), later)),
    { ok: false, reason: 'replayed' },
  );
});

test('the next step still works — the guard must not freeze the account', () => {
  tf.disableTwoFactor();
  const { secret } = enrol(T);
  const a = T + 3 * STEP;
  assert.equal(tf.verifySecondFactor(totpLib.totp(secret, a), a).ok, true);
  const b = a + STEP;
  assert.deepEqual(okUsed(tf.verifySecondFactor(totpLib.totp(secret, b), b)), { ok: true, used: 'totp' });
});

// ── backup codes ───────────────────────────────────────────────────────────

test('a backup code works once, in any case, and is then spent', () => {
  tf.disableTwoFactor();
  const { backups } = enrol(T);
  const code = backups[3]!;

  assert.deepEqual(okUsed(tf.verifySecondFactor(code.toLowerCase(), T)), { ok: true, used: 'backup' });
  assert.equal(tf.twoFactorStatus().backupCodesRemaining, tf.BACKUP_CODE_COUNT - 1);
  assert.deepEqual(okUsed(tf.verifySecondFactor(code, T)), { ok: false, reason: 'bad-code' }, 'no second use');
  // The others are untouched.
  assert.deepEqual(okUsed(tf.verifySecondFactor(backups[4]!, T)), { ok: true, used: 'backup' });
});

test('regenerating backup codes invalidates the old set', () => {
  tf.disableTwoFactor();
  const { backups } = enrol(T);
  const fresh = tf.regenerateBackupCodes();
  assert.equal(fresh.length, tf.BACKUP_CODE_COUNT);
  assert.deepEqual(okUsed(tf.verifySecondFactor(backups[0]!, T)), { ok: false, reason: 'bad-code' }, 'old code is dead');
  assert.deepEqual(okUsed(tf.verifySecondFactor(fresh[0]!, T)), { ok: true, used: 'backup' });
});

// ── emailed codes ──────────────────────────────────────────────────────────

test('an emailed code verifies once, and the plaintext is never stored', () => {
  tf.disableTwoFactor();
  tf.setEmailFactor(true);
  const issued = tf.issueEmailCode(T);
  assert.ok('code' in issued);
  const code = (issued as { code: string }).code;
  assert.match(code, /^\d{6}$/);

  const onDisk = fs.readFileSync(
    path.join(process.env.OPENMASJID_DATA_DIR!, 'config', 'twofactor.json'),
    'utf8',
  );
  assert.equal(onDisk.includes(code), false, 'the code itself must not be on disk');

  assert.deepEqual(okUsed(tf.verifySecondFactor(code, T)), { ok: true, used: 'email' });
  assert.deepEqual(okUsed(tf.verifySecondFactor(code, T)), { ok: false, reason: 'bad-code' }, 'single use');
});

test('an emailed code expires', () => {
  tf.disableTwoFactor();
  tf.setEmailFactor(true);
  const { code } = tf.issueEmailCode(T) as { code: string };
  const tooLate = T + tf.EMAIL_CODE_TTL_MS + 1;
  assert.deepEqual(okUsed(tf.verifySecondFactor(code, tooLate)), { ok: false, reason: 'expired' });
});

test('guessing burns the emailed code rather than getting unlimited tries', () => {
  tf.disableTwoFactor();
  tf.setEmailFactor(true);
  const { code } = tf.issueEmailCode(T) as { code: string };
  const wrong = code === '000000' ? '111111' : '000000';

  for (let i = 0; i < tf.EMAIL_CODE_MAX_ATTEMPTS; i++) {
    assert.deepEqual(okUsed(tf.verifySecondFactor(wrong, T)), { ok: false, reason: 'bad-code' }, `attempt ${i + 1}`);
  }
  // The cap is reached, so even the RIGHT code no longer works — the code is
  // burned and a new one must be sent.
  assert.deepEqual(okUsed(tf.verifySecondFactor(code, T)), { ok: false, reason: 'too-many-attempts' });
});

test('emailed codes cannot be requested in a loop — this is an email-bomb guard', () => {
  tf.disableTwoFactor();
  tf.setEmailFactor(true);
  assert.ok('code' in tf.issueEmailCode(T));
  const again = tf.issueEmailCode(T + 1_000);
  assert.ok('retryAfterMs' in again, 'a second request moments later must be refused');
  assert.ok((again as { retryAfterMs: number }).retryAfterMs > 0);
  // After the interval it is allowed again.
  assert.ok('code' in tf.issueEmailCode(T + tf.EMAIL_CODE_MIN_INTERVAL_MS + 1));
});

test('turning email off drops any pending code with it', () => {
  tf.disableTwoFactor();
  tf.setEmailFactor(true);
  const { code } = tf.issueEmailCode(T) as { code: string };
  tf.setEmailFactor(false);
  assert.deepEqual(okUsed(tf.verifySecondFactor(code, T)), { ok: false, reason: 'not-enrolled' });
});

// ── the epoch: replacing a factor ends what was made with the old one ────────

test('EVERY change to what counts as a second factor gives a new epoch', () => {
  // A remote session is bound to the epoch it signed in under (auth/sessions.ts), so
  // these four are what sign out every session made with a lost phone or a found
  // backup code. A change that forgot to bump would leave those running for a week.
  tf.disableTwoFactor();
  const seen = new Set<string>([tf.secondFactorEpoch()]);
  const fresh = (what: string) => {
    const e = tf.secondFactorEpoch();
    assert.ok(e.length > 0 && !seen.has(e), `${what} must give a NEW epoch`);
    seen.add(e);
  };
  enrol(T);
  fresh('enrolling an authenticator');
  tf.regenerateBackupCodes();
  fresh('replacing the backup codes');
  tf.setEmailFactor(true);
  fresh('turning emailed codes on');
  tf.setEmailFactor(false);
  fresh('turning emailed codes off');
  tf.disableTwoFactor();
  fresh('turning two-step sign-in off');
});

test('USING a factor does not change the epoch — signing in must not sign everyone else out', () => {
  tf.disableTwoFactor();
  const { secret, backups } = enrol(T);
  const before = tf.secondFactorEpoch();
  const later = T + 5 * STEP;
  const r1 = tf.verifySecondFactor(totpLib.totp(secret, later), later);
  const r2 = tf.verifySecondFactor(backups[0]!, later);
  assert.equal(tf.secondFactorEpoch(), before);
  // And each reports the epoch it was checked under — what a remote session binds to.
  assert.equal(r1.ok && r1.epoch, before);
  assert.equal(r2.ok && r2.epoch, before);
});

// ── emailed codes are bound to where they go ─────────────────────────────────

const store = req('../src/auth/store') as typeof import('../src/auth/store');
const emailStore = req('../src/store/email') as typeof import('../src/store/email');

function withAdmin(email: string): void {
  if (!store.isConfigured()) store.setCredentials('admin', '$argon2id$v=19$m=19456,t=2,p=1$aaaa$bbbb');
  store.setProfile({ email });
}

test('CHANGING THE ADMIN ADDRESS PAUSES EMAILED CODES — a session must not be able to send itself the next code', () => {
  // A password-only session on the masjid's network can change the account email.
  // Without the binding it could then sign in from outside with a code it sent to
  // itself — turning a LAN password into a remote session, the one thing two-step
  // sign-in exists to stop.
  tf.disableTwoFactor();
  withAdmin('admin@masjid.example');
  enrol(T);
  tf.setEmailFactor(true);
  assert.deepEqual(tf.availableFactors(), ['totp', 'email']);
  const { code } = tf.issueEmailCode(T) as { code: string };

  withAdmin('intruder@elsewhere.example');
  assert.deepEqual(tf.availableFactors(), ['totp'], 'emailed codes must not be offered to the new address');
  assert.equal(tf.twoFactorStatus().emailPaused, true);
  assert.equal(tf.twoFactorStatus().email, true, 'still switched on — paused, not forgotten');
  assert.equal(tf.verifySecondFactor(code, T).ok, false, 'a code already sent must not be honoured either');
  assert.equal(tf.twoFactorActive(), true, 'the authenticator still counts');

  // Turning it on again binds it to the new address — the router asks for the
  // password and a current code to do that.
  tf.setEmailFactor(true);
  assert.deepEqual(tf.availableFactors(), ['totp', 'email']);
  assert.equal(tf.twoFactorStatus().emailPaused, false);
});

test('POINTING MAIL AT ANOTHER RELAY PAUSES EMAILED CODES TOO', () => {
  tf.disableTwoFactor();
  withAdmin('admin@masjid.example');
  enrol(T);
  emailStore.saveEmailConfig({
    provider: 'smtp',
    fromEmail: 'alerts@masjid.example',
    smtp: { host: 'smtp.masjid.example', port: 587, user: 'alerts', pass: 'pw' },
  });
  tf.setEmailFactor(true);
  assert.ok(tf.availableFactors().includes('email'));

  // The From address and the password are not where mail GOES; changing them alone
  // must not pause anything (rotating a password is routine).
  emailStore.saveEmailConfig({ fromEmail: 'noreply@masjid.example', smtp: { pass: 'rotated' } });
  assert.ok(tf.availableFactors().includes('email'), 'a new From address or password is not a new destination');

  emailStore.saveEmailConfig({ smtp: { host: 'relay.attacker.example', user: 'me' } });
  assert.equal(tf.availableFactors().includes('email'), false, 'a different relay must pause emailed codes');
  emailStore.saveEmailConfig({ provider: 'none' });
});

test('emailed codes switched on before the binding existed are adopted at boot, not paused', () => {
  tf.disableTwoFactor();
  withAdmin('admin@masjid.example');
  enrol(T);
  // A twofactor.json from an older build: emailEnabled with no binding at all.
  const file = path.join(process.env.OPENMASJID_DATA_DIR!, 'config', 'twofactor.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  cfg.emailEnabled = true;
  delete cfg.emailBoundTo;
  fs.writeFileSync(file, JSON.stringify(cfg));
  assert.equal(tf.availableFactors().includes('email'), false, 'unbound reads as paused until adopted');
  tf.adoptLegacyEmailBinding();
  assert.ok(tf.availableFactors().includes('email'), 'boot adopts it as it is now');
});

test('sameSecondFactorAs compares the authenticator itself', () => {
  tf.disableTwoFactor();
  enrol(T);
  const file = path.join(process.env.OPENMASJID_DATA_DIR!, 'config', 'twofactor.json');
  const mine = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  assert.equal(tf.sameSecondFactorAs(mine), true);
  assert.equal(tf.sameSecondFactorAs({ ...mine, totpSecret: 'JBSWY3DPEHPK3PXP' }), false);
  assert.equal(tf.sameSecondFactorAs({}), false);
  assert.equal(tf.sameSecondFactorAs(null), false);
});

// ── teardown ───────────────────────────────────────────────────────────────

test('disabling clears the replay high-water mark too', () => {
  // A stale counter from a retired secret is not a bound on anything, and
  // leaving it is how a replay guard quietly stops guarding after a re-enrol.
  tf.disableTwoFactor();
  const { secret } = enrol(T);
  const late = T + 100 * STEP;
  assert.equal(tf.verifySecondFactor(totpLib.totp(secret, late), late).ok, true);

  tf.disableTwoFactor();
  const fresh = enrol(T); // an EARLIER moment than the spent counter
  const now = T + 2 * STEP;
  assert.deepEqual(
    okUsed(tf.verifySecondFactor(totpLib.totp(fresh.secret, now), now)),
    { ok: true, used: 'totp' },
    'a fresh enrolment must not inherit the old high-water mark',
  );
});

test('the config file is written 0600', () => {
  tf.disableTwoFactor();
  enrol(T);
  const file = path.join(process.env.OPENMASJID_DATA_DIR!, 'config', 'twofactor.json');
  const mode = fs.statSync(file).mode & 0o777;
  // Windows does not model POSIX modes; the check is meaningful on the Linux
  // box this suite is required to run on (CLAUDE.md).
  if (process.platform !== 'win32') {
    assert.equal(mode, 0o600, `twofactor.json must be 0600, got ${mode.toString(8)}`);
  }
});

// ── review fixes ────────────────────────────────────────────────────────────

const { writeJson } = req('../src/util/json-store') as typeof import('../src/util/json-store');
const FILE = path.join(process.env.OPENMASJID_DATA_DIR!, 'config', 'twofactor.json');

test('THE READ-ONLY CHECKS DO NOT RE-READ AN UNCHANGED FILE — and see a change made elsewhere at once', () => {
  // They run several times on every request from outside.
  tf.disableTwoFactor();
  enrol(T);
  const realRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (String(file) === FILE) reads += 1;
    return (realRead as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.readFileSync;
  try {
    tf.secondFactorEpoch();
    reads = 0;
    for (let i = 0; i < 20; i++) {
      tf.secondFactorEpoch();
      tf.twoFactorActive();
      tf.availableFactors();
      tf.twoFactorStatus();
    }
    assert.equal(reads, 0, 'an unchanged file was read again');
  } finally {
    fs.readFileSync = realRead;
  }
  // Rewritten by another process (the full sign-in reset, a restore): seen at once.
  writeJson(FILE, { ...(JSON.parse(fs.readFileSync(FILE, 'utf8')) as object), epoch: 'written-elsewhere' });
  assert.equal(tf.secondFactorEpoch(), 'written-elsewhere');
  writeJson(FILE, {});
  assert.equal(tf.twoFactorActive(), false, 'two-step sign-in turned off elsewhere still read as on');
});

test('a read of that file that fails is not remembered', () => {
  tf.disableTwoFactor();
  enrol(T);
  const realRead = fs.readFileSync;
  let failed = false;
  fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (!failed && String(file) === FILE) {
      failed = true;
      throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
    }
    return (realRead as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.readFileSync;
  try {
    assert.equal(tf.twoFactorActive(), false, 'an unreadable file reads as nothing set up, as it always has');
  } finally {
    fs.readFileSync = realRead;
  }
  assert.ok(failed, 'precondition: the read must have failed');
  assert.equal(tf.twoFactorActive(), true, 'one failed read was kept until the file next changed');
});
