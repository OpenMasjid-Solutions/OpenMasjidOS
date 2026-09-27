// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Remote sign-in: the half-authenticated state, and the rule that a second
 * factor is demanded on tunnel traffic and not on the LAN.
 *
 * The behavioural half is driven through the real `authRouter` with a real
 * context, because the interesting failures are not in the challenge store —
 * they are in which branch the login takes. A unit test of `createChallenge`
 * would have passed happily while `login` handed out a session over the tunnel.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.OPENMASJID_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-remote-'));

const req = createRequire(__filename);
const lc = req('../src/auth/login-challenge') as typeof import('../src/auth/login-challenge');
const tf = req('../src/auth/twofactor') as typeof import('../src/auth/twofactor');
const totpLib = req('../src/auth/totp') as typeof import('../src/auth/totp');
const store = req('../src/auth/store') as typeof import('../src/auth/store');
const { authRouter } = req('../src/trpc/routers/auth') as typeof import('../src/trpc/routers/auth');

const LAN = { viaTunnel: false, remoteIp: null };
const TUNNEL = { viaTunnel: true, remoteIp: '203.0.113.7' };
const T = 1_700_000_000_000;

/** A context shaped like the real one, for whichever origin the test needs. */
function ctxFor(origin: { viaTunnel: boolean; remoteIp: string | null }) {
  let cookie: string | null = null;
  return {
    ctx: {
      username: null,
      sessionToken: null,
      csrf: null,
      isWebSocket: false,
      ip: '172.17.0.1',
      host: 'omos.example.com',
      viaTunnel: origin.viaTunnel,
      remoteIp: origin.remoteIp,
      setSessionCookie: (t: string) => {
        cookie = t;
      },
      clearSessionCookie: () => {
        cookie = null;
      },
    },
    cookieSet: () => cookie !== null,
  };
}

const call = (origin: { viaTunnel: boolean; remoteIp: string | null }) => {
  const { ctx, cookieSet } = ctxFor(origin);
  return { caller: authRouter.createCaller(ctx as never), cookieSet };
};

const PASSWORD = 'a-long-enough-admin-password';

function freshAdmin(): void {
  tf.disableTwoFactor();
  lc.clearChallenges();
}

test('setup: an admin exists', async () => {
  freshAdmin();
  if (!store.isConfigured()) {
    const { caller } = call(LAN);
    await caller.setup({ name: 'admin', email: 'admin@masjid.test', password: PASSWORD });
  }
  assert.equal(store.isConfigured(), true);
});

// ── which branch login takes ───────────────────────────────────────────────

test('on the LAN, the password alone signs you in — even with 2FA enrolled', async () => {
  // Hasan's call: a volunteer on the masjid's own network must not be locked out
  // by a phone they left at home.
  freshAdmin();
  const { secret } = tf.beginEnrolment('admin');
  tf.confirmEnrolment(totpLib.totp(secret, T), T);
  assert.equal(tf.twoFactorActive(), true);

  const { caller, cookieSet } = call(LAN);
  const res = await caller.login({ username: 'admin', password: PASSWORD });
  assert.equal(res.authenticated, true);
  assert.equal(res.needsSecondFactor, false);
  assert.equal(res.challenge, null);
  assert.ok(cookieSet(), 'the LAN path sets the session cookie immediately');
});

test('over the tunnel, the password alone does NOT sign you in', async () => {
  freshAdmin();
  const { secret } = tf.beginEnrolment('admin');
  tf.confirmEnrolment(totpLib.totp(secret, T), T);

  const { caller, cookieSet } = call(TUNNEL);
  const res = await caller.login({ username: 'admin', password: PASSWORD });
  assert.equal(res.authenticated, false, 'no session from a password alone');
  assert.equal(res.needsSecondFactor, true);
  assert.ok(res.challenge, 'and a challenge is handed back instead');
  assert.equal(res.csrf, null, 'no dashboard key either');
  assert.equal(cookieSet(), false, 'NO COOKIE — this is the whole point');
  assert.deepEqual(res.factors, ['totp']);
});

test('over the tunnel with NO second factor enrolled, login is refused outright', async () => {
  // Fail closed. If a tunnel request reaches the login and 2FA is not set up,
  // refuse — rather than handing out a session because the setting that was
  // supposed to gate this is half-configured.
  freshAdmin();
  assert.equal(tf.twoFactorActive(), false);
  const { caller, cookieSet } = call(TUNNEL);
  await assert.rejects(
    () => caller.login({ username: 'admin', password: PASSWORD }),
    (e: Error) => /two-step sign-in/i.test(e.message),
  );
  assert.equal(cookieSet(), false);
});

test('a wrong password over the tunnel never reveals whether 2FA exists', async () => {
  freshAdmin();
  const { caller } = call(TUNNEL);
  await assert.rejects(
    () => caller.login({ username: 'admin', password: 'wrong' }),
    (e: Error) => /username or password is incorrect/i.test(e.message),
  );
});

// ── completing the challenge ───────────────────────────────────────────────

async function startTunnelLogin(at: number): Promise<{ challenge: string; secret: string }> {
  freshAdmin();
  const { secret } = tf.beginEnrolment('admin');
  tf.confirmEnrolment(totpLib.totp(secret, at), at);
  const { caller } = call(TUNNEL);
  const res = await caller.login({ username: 'admin', password: PASSWORD });
  return { challenge: res.challenge!, secret };
}

test('a correct code completes the sign-in and issues the session', async () => {
  const at = T + 5 * 30_000;
  const { challenge, secret } = await startTunnelLogin(at);
  const { caller, cookieSet } = call(TUNNEL);
  const done = await caller.completeLogin({ challenge, code: totpLib.totp(secret, Date.now()) });
  assert.equal(done.authenticated, true);
  assert.equal(done.username, 'admin');
  assert.ok(cookieSet(), 'now the cookie is set');
});

test('a challenge is single use — a completed sign-in cannot be replayed', async () => {
  const { challenge, secret } = await startTunnelLogin(T);
  const { caller } = call(TUNNEL);
  await caller.completeLogin({ challenge, code: totpLib.totp(secret, Date.now()) });
  const again = await caller.completeLogin({ challenge, code: totpLib.totp(secret, Date.now() + 30_000) });
  assert.equal(again.authenticated, false);
  assert.equal(again.restart, true, 'a spent challenge must send the caller back to the start');
});

test('A CHALLENGE CANNOT CROSS THE BOUNDARY IT WAS ISSUED ON', async () => {
  // Without this the two paths are one: start a sign-in on the LAN, where no
  // second factor is required, and finish it over the tunnel — or the reverse,
  // completing a tunnel challenge from a LAN foothold that proved nothing.
  const { challenge, secret } = await startTunnelLogin(T);
  const { caller: lanCaller, cookieSet } = call(LAN);
  const crossed = await lanCaller.completeLogin({ challenge, code: totpLib.totp(secret, Date.now()) });
  assert.equal(crossed.authenticated, false);
  assert.equal(crossed.restart, true);
  assert.equal(cookieSet(), false, 'NO COOKIE — this is the whole point');
  // And it is destroyed, not merely refused — a challenge someone is moving
  // between origins does not get left lying around for another attempt.
  const { caller: back } = call(TUNNEL);
  const retry = await back.completeLogin({ challenge, code: totpLib.totp(secret, Date.now()) });
  assert.equal(retry.authenticated, false);
});

test('a wrong code SAYS HOW MANY TRIES ARE LEFT', async () => {
  // Without a count, the wall at five arrives with no warning — which is how
  // the dead end below was walked into.
  const { challenge } = await startTunnelLogin(T);
  const { caller } = call(TUNNEL);
  await assert.rejects(
    () => caller.completeLogin({ challenge, code: '000000' }),
    (e: Error) => /\b4 tries left/.test(e.message),
    'the first wrong code should say four are left',
  );
  await assert.rejects(
    () => caller.completeLogin({ challenge, code: '000000' }),
    (e: Error) => /\b3 tries left/.test(e.message),
  );
});

test('THE DEAD END: running out of tries must not leave the admin on "expired"', async () => {
  // THE BUG THAT REACHED A MASJID. Five wrong codes destroyed the challenge, and
  // every press afterwards answered "that sign-in attempt has expired" — seconds
  // after starting it, which the admin knew was untrue — while the primary
  // button on screen stayed "Sign in", an action that could never again succeed.
  // They pressed it repeatedly, because that is what the screen invited.
  //
  // Two things must hold now: the LAST wrong try itself reports restart (rather
  // than the NEXT press discovering it), and the reason says what happened.
  const { challenge, secret } = await startTunnelLogin(T);
  const { caller } = call(TUNNEL);
  for (let i = 0; i < lc.CHALLENGE_MAX_ATTEMPTS - 1; i++) {
    await assert.rejects(() => caller.completeLogin({ challenge, code: '000000' }), `attempt ${i + 1}`);
  }
  const last = await caller.completeLogin({ challenge, code: '000000' });
  assert.equal(last.restart, true, 'the final wrong try must send them back, not throw');
  assert.match(String(last.message), /last try|start again/i);

  // And the right code afterwards also says start again, naming the real reason
  // rather than claiming a fresh sign-in expired.
  const after = await caller.completeLogin({ challenge, code: totpLib.totp(secret, Date.now()) });
  assert.equal(after.restart, true);
  assert.match(String(after.message), /too many wrong codes/i, 'it must not say "expired" when it was not');
});

test('a CLOCK-SKEWED code is refused, but the admin is told why', async () => {
  // A drifted server clock and a mistyped code are identical to the person
  // typing and have opposite fixes. Without this an admin watches five correct
  // codes be rejected with no reason to suspect the one thing that explains it.
  const { challenge, secret } = await startTunnelLogin(T);
  const { caller } = call(TUNNEL);
  // A code from five minutes ago: far outside the ±1 step accept window.
  const stale = totpLib.totp(secret, Date.now() - 5 * 60_000);
  await assert.rejects(
    () => caller.completeLogin({ challenge, code: stale }),
    (e: Error) => /clock/i.test(e.message) && /not right/i.test(e.message),
    'a refused-but-explicable code must name the clock',
  );
});

test('an unknown challenge asks the caller to start again', async () => {
  const { caller } = call(TUNNEL);
  const res = await caller.completeLogin({ challenge: 'not-a-real-challenge', code: '123456' });
  assert.equal(res.authenticated, false);
  assert.equal(res.restart, true);
  // Still merged with a genuinely expired one: there is nothing useful to learn
  // from the difference, and it is one fewer oracle. Only "too many tries" is
  // told apart, and reaching that requires having held a real challenge.
  assert.doesNotMatch(String(res.message), /too many/i);
});

// ── the challenge store itself ─────────────────────────────────────────────

test('a challenge expires', () => {
  lc.clearChallenges();
  const id = lc.createChallenge('admin', TUNNEL, T);
  assert.equal(lc.claimChallenge(id, TUNNEL, T).ok, true);
  const late = T + lc.CHALLENGE_TTL_MS + 1;
  assert.deepEqual(lc.claimChallenge(id, TUNNEL, late), { ok: false, reason: 'expired' });
});

test('expired challenges are swept rather than accumulating', () => {
  lc.clearChallenges();
  for (let i = 0; i < 20; i++) lc.createChallenge('admin', TUNNEL, T);
  assert.equal(lc.pendingCount(), 20);
  // Any later operation sweeps.
  lc.createChallenge('admin', TUNNEL, T + lc.CHALLENGE_TTL_MS + 1);
  assert.equal(lc.pendingCount(), 1, 'stale challenges must not pile up in memory');
});

test('nothing is persisted — a restart invalidates a half-finished sign-in', () => {
  lc.clearChallenges();
  lc.createChallenge('admin', TUNNEL, T);
  const configDir = path.join(process.env.OPENMASJID_DATA_DIR!, 'config');
  const files = fs.existsSync(configDir) ? fs.readdirSync(configDir) : [];
  for (const f of files) {
    const body = fs.readFileSync(path.join(configDir, f), 'utf8');
    assert.equal(body.includes('challenge'), false, `${f} must not hold a half-authenticated token`);
  }
});
