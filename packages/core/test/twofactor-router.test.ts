// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Managing the second factor: the rule that A SESSION IS NOT ENOUGH.
 *
 * `twofactor.test.ts` covers the state machine — replay, single-use backup
 * codes, the pending-secret dance. This file covers the thing that state machine
 * cannot defend by itself: who is allowed to change it.
 *
 * The attack to keep in mind throughout is NOT "an attacker turns 2FA off" —
 * that makes remote sign-in fail closed and costs them their own way in. It is
 * RE-ENROLMENT: reach an authenticated dashboard, mint a fresh secret into your
 * own authenticator, and now you can sign in from anywhere, indefinitely,
 * through the front door, while the admin's password still works and nothing on
 * screen looks wrong. Every `requireSudo` assertion below is about that.
 *
 * Driven through the real router with a real session, because the interesting
 * failures are in the procedure wiring rather than in the store — a unit test of
 * `beginEnrolment` passes happily while the procedure calling it asks for
 * nothing at all.
 *
 * ── A NOTE ON CODES, because it shapes every test here ────────────────────
 *
 * `verifyTotp`'s window is ±1 step and a used step is burned, so ONE TOTP code
 * is available per enrolment: `nextCode` returns the code for exactly one step
 * ahead of now, which is inside the window and above the counter that enrolment
 * spent. A second sudo action in the same test therefore uses a BACKUP code —
 * which is realistic, and which is why `enrol()` hands both back.
 *
 * Deliberately no fake clock. The replay guard is time-based state, and mocking
 * the clock is how you end up testing the mock. One step ahead of the real
 * `Date.now()` is always in-window whichever side of a step boundary the call
 * lands on, so there is no flake to buy off.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.OPENMASJID_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-2fa-router-'));

const req = createRequire(__filename);
const tf = req('../src/auth/twofactor') as typeof import('../src/auth/twofactor');
const totpLib = req('../src/auth/totp') as typeof import('../src/auth/totp');
const sessions = req('../src/auth/sessions') as typeof import('../src/auth/sessions');
const lc = req('../src/auth/login-challenge') as typeof import('../src/auth/login-challenge');
const { authRouter } = req('../src/trpc/routers/auth') as typeof import('../src/trpc/routers/auth');

const PASSWORD = 'a-long-enough-admin-password';
const WRONG = 'not-the-admin-password';
const STEP_MS = 30_000;

/** A caller with a genuine session and its dashboard key — what the UI has. */
function signedIn() {
  const { token, csrf } = sessions.createSession('admin', sessions.currentCredential());
  return authRouter.createCaller({
    username: 'admin',
    sessionToken: token,
    csrf,
    isWebSocket: false,
    ip: '172.17.0.1',
    host: 'openmasjidos.local',
    viaTunnel: false,
    remoteIp: null,
    setSessionCookie: () => {},
    clearSessionCookie: () => {},
  } as never);
}

type Caller = ReturnType<typeof signedIn>;

/** The code for one step ahead of now — in-window, and above the spent counter. */
const nextCode = (secret: string): string => totpLib.totp(secret, Date.now() + STEP_MS);

/** Enrol from scratch through the router, returning everything the admin would hold. */
async function enrol(caller: Caller): Promise<{ secret: string; backupCodes: string[] }> {
  tf.disableTwoFactor();
  const begun = await caller.twoFactor.begin({ password: PASSWORD });
  const { backupCodes } = await caller.twoFactor.confirm({
    code: totpLib.totp(begun.secret, Date.now()),
  });
  return { secret: begun.secret, backupCodes };
}

test('setup: an admin exists', async () => {
  tf.disableTwoFactor();
  lc.clearChallenges();
  await signedIn().setup({ name: 'admin', email: 'admin@masjid.test', password: PASSWORD });
  assert.equal(tf.twoFactorActive(), false);
});

// ── status leaks nothing ───────────────────────────────────────────────────

test('status returns no secret, no QR and no codes', async () => {
  const caller = signedIn();
  tf.disableTwoFactor();
  const before = await caller.twoFactor.status();
  assert.equal(before.active, false);
  assert.equal(before.totp, false);
  assert.equal(before.backupCodesRemaining, 0);

  const { secret, backupCodes } = await enrol(caller);
  const after = await caller.twoFactor.status();
  assert.equal(after.active, true);
  assert.equal(after.totp, true);
  assert.equal(after.backupCodesRemaining, tf.BACKUP_CODE_COUNT);
  // Whatever else this grows, it must never carry the things that are secret.
  const body = JSON.stringify(after);
  assert.equal(body.includes(secret), false, 'status returned the TOTP secret');
  assert.equal(body.includes(backupCodes[0]!), false, 'status returned a backup code');
  assert.doesNotMatch(body, /otpauth:/, 'status returned an enrolment URI');
});

// ── a session alone cannot enrol ───────────────────────────────────────────

test('A SESSION ALONE CANNOT ENROL — the password is re-proved', async () => {
  // The stolen-cookie case. Without this, reaching an authenticated dashboard is
  // enough to install your own authenticator and keep permanent remote access.
  const caller = signedIn();
  tf.disableTwoFactor();
  await assert.rejects(
    () => caller.twoFactor.begin({ password: WRONG }),
    (e: Error) => /password is not right/i.test(e.message),
  );
  assert.equal(tf.twoFactorStatus().enrolmentPending, false, 'a refused begin must mint nothing');
});

test('ONCE A FACTOR IS ACTIVE, RE-ENROLLING NEEDS THE CURRENT ONE', async () => {
  // The stolen-password case, which the password check alone does not cover: on
  // the LAN a password is the whole of sign-in, so an attacker who has it can
  // reach this procedure. Knowing the password must not be enough to replace the
  // factor guarding the door they cannot otherwise open.
  const caller = signedIn();
  const { secret } = await enrol(caller);

  await assert.rejects(
    () => caller.twoFactor.begin({ password: PASSWORD }),
    (e: Error) => /authenticator app|backup code/i.test(e.message),
    'the right password with no code must not be enough',
  );
  await assert.rejects(
    () => caller.twoFactor.begin({ password: PASSWORD, code: '000000' }),
    (e: Error) => /code is not right/i.test(e.message),
  );
  assert.equal(tf.twoFactorStatus().enrolmentPending, false, 'a refused begin must mint nothing');

  // And with a real code it goes through, so this is a gate and not a wall.
  const ok = await caller.twoFactor.begin({ password: PASSWORD, code: nextCode(secret) });
  assert.match(ok.uri, /^otpauth:\/\/totp\//);
  assert.notEqual(ok.secret, secret, 'a new enrolment must mint a new secret');
});

test('a BACKUP CODE authorises a change, so a lost phone is not a dead end', async () => {
  const caller = signedIn();
  const { backupCodes } = await enrol(caller);

  const begun = await caller.twoFactor.begin({ password: PASSWORD, code: backupCodes[0]! });
  assert.ok(begun.secret);
  assert.equal(
    (await caller.twoFactor.status()).backupCodesRemaining,
    tf.BACKUP_CODE_COUNT - 1,
    'spending a backup code must be visible to the admin',
  );
  // Spent: the same backup code cannot authorise a second change.
  await assert.rejects(
    () => caller.twoFactor.begin({ password: PASSWORD, code: backupCodes[0]! }),
    (e: Error) => /code is not right/i.test(e.message),
  );
});

// ── enrolment is two steps ─────────────────────────────────────────────────

test('a pending secret changes nothing until a code proves it', async () => {
  const caller = signedIn();
  tf.disableTwoFactor();
  await caller.twoFactor.begin({ password: PASSWORD });
  assert.equal(tf.twoFactorActive(), false, 'scanning a QR must not arm the factor');
  assert.equal(tf.twoFactorStatus().enrolmentPending, true);

  await assert.rejects(
    () => caller.twoFactor.confirm({ code: '000000' }),
    (e: Error) => /match/i.test(e.message),
  );
  assert.equal(tf.twoFactorActive(), false, 'a wrong code must not activate it either');
});

test('confirming returns the backup codes exactly once', async () => {
  const caller = signedIn();
  const { backupCodes } = await enrol(caller);
  assert.equal(backupCodes.length, tf.BACKUP_CODE_COUNT);
  assert.equal(new Set(backupCodes).size, tf.BACKUP_CODE_COUNT, 'duplicate backup codes');
  for (const c of backupCodes) assert.match(c, /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
});

test('A PENDING ENROLMENT BURNS OUT UNDER GUESSING', async () => {
  // `confirm` deliberately does not ask for the password — the pending secret
  // was minted behind one moments earlier. That is right about the SECRET and
  // was wrong about what confirming hands back: ten backup codes, each of which
  // authorises a sign-in. So an admin who starts enrolment and closes the tab
  // used to leave a six-digit guessing game, playable by anyone who had reached
  // an authenticated dashboard without the password, whose prize was those
  // codes. Five tries, then the pending secret is gone.
  const caller = signedIn();
  tf.disableTwoFactor();
  await caller.twoFactor.begin({ password: PASSWORD });
  assert.equal(tf.twoFactorStatus().enrolmentPending, true);

  for (let i = 0; i < tf.PENDING_MAX_ATTEMPTS; i++) {
    await assert.rejects(() => caller.twoFactor.confirm({ code: '000000' }), `attempt ${i + 1}`);
  }
  assert.equal(tf.twoFactorStatus().enrolmentPending, false, 'the pending secret must be discarded');
  assert.equal(tf.twoFactorActive(), false);
});

test('a pending enrolment expires, and reading the status does not delete it', async () => {
  const caller = signedIn();
  tf.disableTwoFactor();
  const begun = await caller.twoFactor.begin({ password: PASSWORD });

  // The TTL is applied on READ as a pure predicate — a status query must not
  // mutate security state. (The WhatsApp command gate's `hasPending` got this
  // wrong in the other direction and held an exemption open for ever.)
  const later = Date.now() + tf.PENDING_TTL_MS + 1;
  assert.equal(tf.twoFactorStatus(later).enrolmentPending, false, 'an expired enrolment must read as gone');
  assert.equal(tf.twoFactorStatus().enrolmentPending, true, 'reading it must not have deleted it');

  // And confirming an expired one fails even with the right code.
  assert.equal(
    tf.confirmEnrolment(totpLib.totp(begun.secret, later), later),
    null,
    'an expired enrolment must not be confirmable',
  );
  assert.equal(tf.twoFactorActive(), false);
  assert.equal(tf.twoFactorStatus().enrolmentPending, false, 'and now it really is gone');
});

test('a fresh begin clears the attempt count from the last one', async () => {
  // Otherwise an admin who mistyped four times is one wrong code away from
  // having to start over, on an enrolment they only just restarted.
  const caller = signedIn();
  tf.disableTwoFactor();
  await caller.twoFactor.begin({ password: PASSWORD });
  for (let i = 0; i < tf.PENDING_MAX_ATTEMPTS - 1; i++) {
    await assert.rejects(() => caller.twoFactor.confirm({ code: '000000' }));
  }
  const begun = await caller.twoFactor.begin({ password: PASSWORD });
  await assert.rejects(() => caller.twoFactor.confirm({ code: '000000' }));
  // Still confirmable: the counter was reset, so this is attempt two of five.
  const { backupCodes } = await caller.twoFactor.confirm({
    code: totpLib.totp(begun.secret, Date.now()),
  });
  assert.equal(backupCodes.length, tf.BACKUP_CODE_COUNT);
});

test('the code that completed enrolment cannot then be replayed', async () => {
  const caller = signedIn();
  tf.disableTwoFactor();
  const begun = await caller.twoFactor.begin({ password: PASSWORD });
  const code = totpLib.totp(begun.secret, Date.now());
  await caller.twoFactor.confirm({ code });
  await assert.rejects(
    () => caller.twoFactor.begin({ password: PASSWORD, code }),
    (e: Error) => /code is not right/i.test(e.message),
    'the enrolment code was still live afterwards',
  );
});

// ── turning it off ─────────────────────────────────────────────────────────

test('disabling needs the password AND the current factor', async () => {
  const caller = signedIn();
  const { secret, backupCodes } = await enrol(caller);

  await assert.rejects(() => caller.twoFactor.disable({ password: WRONG, code: backupCodes[0]! }));
  await assert.rejects(() => caller.twoFactor.disable({ password: PASSWORD }));
  assert.equal(tf.twoFactorActive(), true, 'still on after two refused attempts');

  const res = await caller.twoFactor.disable({ password: PASSWORD, code: nextCode(secret) });
  assert.equal(res.active, false);
  assert.equal(tf.twoFactorActive(), false);
});

test('disabling wipes the replay guard and the backup codes too', async () => {
  const caller = signedIn();
  const { secret } = await enrol(caller);
  await caller.twoFactor.disable({ password: PASSWORD, code: nextCode(secret) });

  const status = await caller.twoFactor.status();
  assert.equal(status.backupCodesRemaining, 0, 'old backup codes must not survive');
  assert.equal(status.enrolmentPending, false);
  // A stale `lastCounter` against a secret that no longer exists is not a bound,
  // it is a trap: re-enrolling would refuse the first code as a replay.
  const again = await caller.twoFactor.begin({ password: PASSWORD });
  await caller.twoFactor.confirm({ code: totpLib.totp(again.secret, Date.now()) });
  assert.equal(tf.twoFactorActive(), true, 're-enrolment was blocked by state that should have gone');
});

test('turning it off destroys any half-finished remote sign-in', async () => {
  const caller = signedIn();
  const { secret } = await enrol(caller);
  lc.createChallenge('admin', { viaTunnel: true, remoteIp: '203.0.113.9' });
  assert.ok(lc.pendingCount() > 0);

  await caller.twoFactor.disable({ password: PASSWORD, code: nextCode(secret) });
  assert.equal(lc.pendingCount(), 0, 'a challenge naming factors that no longer exist must not survive');
});

// ── backup codes ───────────────────────────────────────────────────────────

test('regenerating replaces every old code', async () => {
  const caller = signedIn();
  const { backupCodes: first } = await enrol(caller);
  const second = await caller.twoFactor.regenerateBackupCodes({
    password: PASSWORD,
    code: first[0]!,
  });
  assert.equal(second.backupCodes.length, tf.BACKUP_CODE_COUNT);
  for (const c of first) {
    assert.equal(second.backupCodes.includes(c), false, 'an old code came back in the new set');
  }
  assert.equal(
    (await caller.twoFactor.status()).backupCodesRemaining,
    tf.BACKUP_CODE_COUNT,
    'regenerating must restore a full set, not carry the spent one over',
  );
  // An old code no longer authorises anything.
  await assert.rejects(() => caller.twoFactor.begin({ password: PASSWORD, code: first[1]! }));
});

test('backup codes are refused before anything is enrolled', async () => {
  const caller = signedIn();
  tf.disableTwoFactor();
  await assert.rejects(
    () => caller.twoFactor.regenerateBackupCodes({ password: PASSWORD }),
    (e: Error) => /authenticator app first/i.test(e.message),
    'codes that are a way back in from nowhere are not a way back in',
  );
});

// ── emailed codes ──────────────────────────────────────────────────────────

test('emailed codes cannot be switched on without somewhere to send them', async () => {
  // A factor that cannot be delivered is a lockout with extra steps. No mail
  // provider is configured in this test's data dir, so this is the real path.
  const caller = signedIn();
  const { backupCodes } = await enrol(caller);
  await assert.rejects(
    () => caller.twoFactor.setEmailFactor({ enabled: true, password: PASSWORD, code: backupCodes[0]! }),
    (e: Error) => /email provider|Settings/i.test(e.message),
  );
  assert.equal(tf.twoFactorStatus().email, false);
  const status = await caller.twoFactor.status();
  assert.equal(status.emailPossible, false, 'the UI must be able to see that this is unavailable');
});

test('switching emailed codes OFF is always allowed', async () => {
  // The refusal above is about ARMING a factor that cannot be delivered. Turning
  // one off must never be blocked by the provider being broken — that is exactly
  // when an admin wants rid of it.
  const caller = signedIn();
  const { secret } = await enrol(caller);
  tf.setEmailFactor(true);
  assert.equal(tf.twoFactorStatus().email, true);

  const res = await caller.twoFactor.setEmailFactor({
    enabled: false,
    password: PASSWORD,
    code: nextCode(secret),
  });
  assert.equal(res.email, false);
  assert.equal(tf.twoFactorStatus().email, false);
});

// ── the QR that comes back ─────────────────────────────────────────────────

test('begin returns a scannable grid and the key for typing in by hand', async () => {
  const caller = signedIn();
  tf.disableTwoFactor();
  const begun = await caller.twoFactor.begin({ password: PASSWORD });
  assert.equal(begun.qr.modules.length, begun.qr.size * begun.qr.size);
  assert.ok(begun.qr.size >= 21 && begun.qr.size <= 177);
  assert.ok(begun.uri.includes(begun.secret), 'the QR and the typed key must be the same secret');
  assert.equal(begun.account, 'admin@masjid.test', 'the authenticator should name the account usefully');
  assert.match(begun.uri, /issuer=OpenMasjidOS/);
});
