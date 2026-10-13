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

test('FIRST-RUN SETUP IS REFUSED FROM OUTSIDE — it hands the box to whoever reaches it first', async () => {
  // Fine for someone in the building, and nobody else. Remote administration already
  // requires an admin (system/remote-admin.ts); this is the backstop.
  freshAdmin();
  assert.equal(store.isConfigured(), false, 'precondition: no admin yet');
  const { caller } = call(TUNNEL);
  await assert.rejects(
    caller.setup({ name: 'intruder', email: 'x@example.com', password: 'a-password-of-my-own' }),
    (e: { code?: string }) => e.code === 'FORBIDDEN',
  );
  assert.equal(store.isConfigured(), false, 'an admin was created from outside');
});

test('FIRST-RUN RESTORE IS REFUSED FROM OUTSIDE too', async () => {
  const Fastify = (await import('fastify')).default;
  const fastifyCookie = (await import('@fastify/cookie')).default;
  const fastifyMultipart = (await import('@fastify/multipart')).default;
  const fastifyWebsocket = (await import('@fastify/websocket')).default;
  const { registerRestore } = req('../src/api/restore') as typeof import('../src/api/restore');
  const app = Fastify();
  await app.register(fastifyCookie);
  await app.register(fastifyMultipart);
  await app.register(fastifyWebsocket);
  registerRestore(app);
  await app.ready();
  assert.equal(store.isConfigured(), false, 'precondition: no admin yet');
  const res = await app.inject({
    method: 'POST',
    url: '/api/restore/upload',
    headers: { 'cf-ray': 'abc-LHR', 'cf-visitor': '{"scheme":"https"}', host: 'omos.example.com' },
  });
  assert.equal(res.statusCode, 403, 'the open first-run restore answered the internet');
  // The control: the same first-run upload from the masjid's network is let in — it is
  // how a masjid moves onto new hardware — and fails only later, for want of a file.
  const lan = await app.inject({ method: 'POST', url: '/api/restore/upload', headers: { host: '192.168.1.50' } });
  assert.notEqual(lan.statusCode, 403, 'a first-run restore was refused on the masjid’s own network');
  assert.notEqual(lan.statusCode, 401);
  await app.close();
  // The progress socket that runs the restore refuses the same way (inject cannot
  // open a socket, so this half is read from the source).
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'restore.ts'), 'utf8');
  const run = src.slice(src.indexOf("server.get('/api/restore/run'"));
  assert.match(run, /\} else if \(isViaTunnel\(req\)\) \{\s*return refuse\(4403/, 'the restore socket runs a first-run restore for the internet');
});

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

// ── the per-address lockout, against someone who knows the password ──────────

const ipl = req('../src/auth/ip-lockout') as typeof import('../src/auth/ip-lockout');
const refused = (code: string) => (e: { code?: string }) => e.code === code;

test('A RIGHT PASSWORD DOES NOT WIPE THE WRONG CODES COUNTED AGAINST AN ADDRESS', async () => {
  // It did, so whoever had the password could alternate — sign in, five wrong codes,
  // sign in again — and guess codes for ever without the address ever locking.
  freshAdmin();
  const { secret } = tf.beginEnrolment('admin');
  tf.confirmEnrolment(totpLib.totp(secret, T), T);
  ipl.clearAllIpFailures();
  const { caller } = call(TUNNEL);
  try {
    for (let round = 0; round < Math.ceil(ipl.IP_MAX_FAILURES / lc.CHALLENGE_MAX_ATTEMPTS); round++) {
      const { challenge } = await caller.login({ username: 'admin', password: PASSWORD });
      const wrong = Array.from({ length: lc.CHALLENGE_MAX_ATTEMPTS }, () =>
        caller.completeLogin({ challenge: challenge!, code: '000000' }),
      );
      await Promise.allSettled(wrong);
    }
    await assert.rejects(caller.login({ username: 'admin', password: PASSWORD }), refused('TOO_MANY_REQUESTS'));
  } finally {
    ipl.clearAllIpFailures();
  }
});

test('A BATCH OF SIGN-INS FROM ONE ADDRESS STOPS BEING CHECKED ONCE THE ADDRESS IS LOCKED', async () => {
  // Every attempt in a batch passed the check on arrival, before any had failed: one
  // request could carry hundreds of guesses, and queue that many argon2 runs in front of
  // every other sign-in on the box. Each is asked again when its turn comes.
  ipl.clearAllIpFailures();
  const { caller } = call(TUNNEL);
  try {
    const batch = await Promise.allSettled(
      Array.from({ length: 3 * ipl.IP_MAX_FAILURES }, () => caller.login({ username: 'admin', password: 'wrong' })),
    );
    const codes = batch.map((r) => (r.status === 'rejected' ? (r.reason as { code?: string }).code : 'signed-in'));
    // UNAUTHORIZED is a password that was actually checked.
    assert.equal(codes.filter((c) => c === 'UNAUTHORIZED').length, ipl.IP_MAX_FAILURES, codes.join(' '));
    assert.equal(codes.filter((c) => c === 'TOO_MANY_REQUESTS').length, 2 * ipl.IP_MAX_FAILURES, codes.join(' '));
  } finally {
    ipl.clearAllIpFailures();
  }
});

test('A CODE THE CLOCK NOTE CONFIRMED FOR LATER IS NOT ACCEPTED WHEN ITS TIME COMES', async () => {
  // "It looks about 5 minutes slow" tells whoever typed the code that it works in five
  // minutes. The note stays; that code never works.
  const { challenge, secret } = await startTunnelLogin(T);
  const ahead = Date.now() + 5 * 60_000;
  const code = totpLib.totp(secret, ahead);
  await assert.rejects(
    call(TUNNEL).caller.completeLogin({ challenge, code }),
    (e: Error) => /clock/i.test(e.message) && /slow/i.test(e.message),
  );
  assert.deepEqual(tf.verifySecondFactor(code, ahead), { ok: false, reason: 'replayed' });
  ipl.clearAllIpFailures();
});
