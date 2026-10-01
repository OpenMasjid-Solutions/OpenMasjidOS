// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * A sign-in is bound to the password it PROVED — not to whatever the password is
 * when the session happens to be written.
 *
 * Sessions are bound to a fingerprint of the password hash (auth/sessions.ts), so a
 * password change or a reset ends every older session. A second adversarial review
 * found three ways round that, each with the same shape: something awaited between
 * "the password was right" and "mint the session", and the binding was taken from
 * the CURRENT password at the end rather than the one that was actually checked.
 *
 *   - argon2 is awaited. A password change landing during it minted a session
 *     bound to the NEW password for someone who had only shown the old one.
 *   - A remote sign-in waits up to ten minutes for its second factor. A change in
 *     that time did the same thing, more slowly.
 *   - The admin store was read once, at boot. The installer's Reset sign-in is a
 *     separate process that restarts the core minutes later — and until then the
 *     daemon went on accepting the old password, the very one a reset exists to
 *     stop, and minting sessions for it.
 *
 * Driven through the real `authRouter`, because each of these lived in which
 * value a login read and when, which no unit test of the session store can see.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-cred-'));
process.env.OPENMASJID_DATA_DIR = DATA;

const req = createRequire(__filename);
const store = req('../src/auth/store') as typeof import('../src/auth/store');
const sessions = req('../src/auth/sessions') as typeof import('../src/auth/sessions');
const lc = req('../src/auth/login-challenge') as typeof import('../src/auth/login-challenge');
const tf = req('../src/auth/twofactor') as typeof import('../src/auth/twofactor');
const totpLib = req('../src/auth/totp') as typeof import('../src/auth/totp');
const pw = req('../src/auth/passwords') as typeof import('../src/auth/passwords');
const { writeJson } = req('../src/util/json-store') as typeof import('../src/util/json-store');
const { CONFIG_DIR } = req('../src/config') as typeof import('../src/config');
const { authRouter } = req('../src/trpc/routers/auth') as typeof import('../src/trpc/routers/auth');

const AUTH_JSON = path.join(CONFIG_DIR, 'auth.json');
const STORE_PATH = req.resolve('../src/auth/store');
type Store = typeof import('../src/auth/store');

const OLD = 'the-original-admin-password';
const NEW = 'a-brand-new-admin-password';
const T = 1_700_000_000_000;

type Origin = { viaTunnel: boolean; remoteIp: string | null };
const LAN: Origin = { viaTunnel: false, remoteIp: null };
const TUNNEL: Origin = { viaTunnel: true, remoteIp: '203.0.113.9' };

function call(origin: Origin, session?: { token: string; csrf: string }) {
  let cookie: string | null = null;
  const ctx = {
    username: session ? sessions.getSessionUser(session.token) : null,
    sessionToken: session?.token ?? null,
    csrf: session?.csrf ?? null,
    isWebSocket: false,
    ip: '172.17.0.1',
    host: 'omos.example.org',
    viaTunnel: origin.viaTunnel,
    remoteIp: origin.remoteIp,
    setSessionCookie: (t: string) => {
      cookie = t;
    },
    clearSessionCookie: () => {
      cookie = null;
    },
  };
  return { caller: authRouter.createCaller(ctx as never), cookie: () => cookie };
}

/** What the installer's Reset sign-in writes: the whole record, by temp + rename. */
function writeAuthFromOutside(passwordHash: string): void {
  const cur = JSON.parse(fs.readFileSync(AUTH_JSON, 'utf8')) as Record<string, unknown>;
  writeJson(AUTH_JSON, { ...cur, passwordHash });
}

let OLD_HASH = '';
let NEW_HASH = '';

/** The admin, back on the original password, with nothing half-finished. */
async function reset(): Promise<void> {
  tf.disableTwoFactor();
  lc.clearChallenges();
  store.updatePasswordHash(OLD_HASH);
  sessions.destroyAllSessions();
}

async function rejects(p: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(p, (e: { code?: string }) => {
    assert.equal(e.code, code);
    return true;
  });
}

test('setup', async () => {
  OLD_HASH = await pw.hashPassword(OLD);
  NEW_HASH = await pw.hashPassword(NEW);
  const { caller } = call(LAN);
  await caller.setup({ name: 'admin', email: 'admin@masjid.test', password: OLD });
  store.updatePasswordHash(OLD_HASH);
  assert.equal(store.isConfigured(), true);
});

// ── a password check that straddles a change ───────────────────────────────

test('baseline: the right password signs in', async () => {
  await reset();
  const { caller, cookie } = call(LAN);
  const res = await caller.login({ username: 'admin', password: OLD });
  assert.equal(res.authenticated, true);
  assert.ok(cookie(), 'a session cookie was not set');
  // And the session behind it WORKS. A sign-in that reports success but mints a dead
  // session is the reported bug in its purest form: "signed in", then asked again.
  assert.equal(sessions.getSessionUser(cookie()), 'admin', 'the sign-in succeeded but its session does not work');
});

test('A SIGN-IN WHOSE PASSWORD CHECK STRADDLES A PASSWORD CHANGE IS REFUSED', async () => {
  // The change lands while argon2 is verifying the old password. That password WAS
  // right when it was checked — and is not the password any more.
  await reset();
  const { caller, cookie } = call(LAN);
  let changedDuringCheck = false;
  const attempt = caller.login({ username: 'admin', password: OLD });
  setImmediate(() => {
    store.updatePasswordHash(NEW_HASH);
    changedDuringCheck = true;
  });
  await rejects(attempt, 'UNAUTHORIZED');
  assert.ok(changedDuringCheck, 'precondition: the change must land while the check is in flight');
  assert.equal(cookie(), null, 'a session was issued for a password that is no longer the password');

  // And the new password is the way in.
  const ok = await call(LAN).caller.login({ username: 'admin', password: NEW });
  assert.equal(ok.authenticated, true);
});

test('A RESET WRITTEN BY ANOTHER PROCESS WHILE THE PASSWORD IS BEING CHECKED IS HONOURED', async () => {
  // The same straddle, but the change comes from the installer's Reset sign-in — a
  // separate process — so this daemon only learns of it by reading the file. The
  // check after argon2 used the throttled copy, which had been read a moment before
  // the verify began, so it still said "old password" and the sign-in went through.
  await reset();
  const { caller, cookie } = call(LAN);
  let written = false;
  const attempt = caller.login({ username: 'admin', password: OLD });
  setImmediate(() => {
    writeAuthFromOutside(NEW_HASH);
    written = true;
  });
  await rejects(attempt, 'UNAUTHORIZED');
  assert.ok(written, 'precondition: the reset must land while the check is in flight');
  assert.equal(cookie(), null, 'a session was minted for the old password after a reset had replaced it');
});

test('every sign-in mints its session with the credential it PROVED, never a fresh read', () => {
  // `createSession` used to read the current hash itself. A refresh landing between a
  // sign-in's check and that read bound the session to a password nobody had shown —
  // a seven-day session for someone who only knew the old one. So the credential is a
  // REQUIRED parameter, and the compiler refuses a caller that leaves it out. This
  // pins that it stays required: a default value would quietly restore the bug for
  // every caller that relies on it, and lint would say nothing.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'auth', 'sessions.ts'), 'utf8');
  const sig = /export function createSession\(([^)]*)\)/.exec(src);
  assert.ok(sig, 'createSession is gone or renamed');
  assert.match(sig![1]!, /^\s*username: string,\s*cred: string\s*$/, `createSession's credential must be required: (${sig![1]})`);
});

// ── a remote sign-in waiting for its second factor ─────────────────────────

async function startTunnelLogin(): Promise<{ challenge: string; secret: string }> {
  await reset();
  const { secret } = tf.beginEnrolment('admin');
  tf.confirmEnrolment(totpLib.totp(secret, T), T);
  const res = await call(TUNNEL).caller.login({ username: 'admin', password: OLD });
  assert.equal(res.needsSecondFactor, true);
  return { challenge: res.challenge!, secret };
}

test('A REMOTE SIGN-IN WAITING FOR ITS CODE CANNOT FINISH ONCE THE PASSWORD HAS CHANGED', async () => {
  const { challenge, secret } = await startTunnelLogin();
  store.updatePasswordHash(NEW_HASH);
  const { caller, cookie } = call(TUNNEL);
  const res = await caller.completeLogin({ challenge, code: totpLib.totp(secret, Date.now()) });
  assert.equal(res.authenticated, false, 'the old password plus a code still produced a session');
  assert.equal(res.restart, true, 'the admin must be sent back to the password step, not left on a dead one');
  assert.match(res.message ?? '', /password was changed/);
  assert.equal(cookie(), null);
  assert.equal(lc.pendingCount(), 0, 'the challenge must be spent, not left for another try');
});

test('...nor once a reset from ANOTHER process has replaced it', async () => {
  // The check before minting read the throttled copy, which had been refreshed when
  // the password was verified a moment earlier — so it missed a reset the installer
  // had just written, and the old password plus a code still produced a session.
  const { challenge, secret } = await startTunnelLogin();
  writeAuthFromOutside(NEW_HASH);
  const { caller, cookie } = call(TUNNEL);
  const res = await caller.completeLogin({ challenge, code: totpLib.totp(secret, Date.now()) });
  assert.equal(res.authenticated, false, 'a reset written by another process did not stop a waiting sign-in');
  assert.equal(res.restart, true);
  assert.equal(cookie(), null);
});

test('a session minted with a credential that is no longer current is born dead', async () => {
  // What makes passing the PROVED credential safe: if it is already stale, the
  // session simply never works, rather than quietly taking on the current one.
  await reset();
  const stale = sessions.createSession('admin', sessions.credentialFingerprint(NEW_HASH));
  assert.equal(sessions.getSessionUser(stale.token), null);
  const current = sessions.createSession('admin', sessions.credentialFingerprint(OLD_HASH));
  assert.equal(sessions.getSessionUser(current.token), 'admin');
});

test('a remote sign-in with no change in between still completes', async () => {
  const { challenge, secret } = await startTunnelLogin();
  const { caller, cookie } = call(TUNNEL);
  const res = await caller.completeLogin({ challenge, code: totpLib.totp(secret, Date.now()) });
  assert.equal(res.authenticated, true);
  assert.equal(sessions.getSessionUser(cookie()), 'admin', 'the sign-in succeeded but its session does not work');
});

// ── changing the password ──────────────────────────────────────────────────

test('changing the password clears every remote sign-in still waiting for a code', async () => {
  await startTunnelLogin();
  assert.equal(lc.pendingCount(), 1);
  const s = sessions.createSession('admin', sessions.currentCredential());
  const res = await call(LAN, s).caller.changePassword({ currentPassword: OLD, newPassword: NEW });
  assert.equal(res.ok, true);
  assert.equal(lc.pendingCount(), 0, 'a challenge that proved the OLD password is still waiting');
  assert.equal(sessions.getSessionUser(s.token), null, 'the session that made the change is replaced, not kept');
});

test('TWO PASSWORD CHANGES RACING: exactly one wins, the other is told why', async () => {
  // Both proved the same current password. Letting both through means the first
  // admin's new password silently stops working, and they never learn why.
  await reset();
  const s = sessions.createSession('admin', sessions.currentCredential());
  const a = call(LAN, s).caller.changePassword({ currentPassword: OLD, newPassword: NEW });
  const b = call(LAN, s).caller.changePassword({ currentPassword: OLD, newPassword: `${NEW}-other` });
  const results = await Promise.allSettled([a, b]);
  const won = results.filter((r) => r.status === 'fulfilled');
  const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  assert.equal(won.length, 1, `expected one winner, got ${won.length}`);
  assert.equal(lost.length, 1);
  assert.equal((lost[0]!.reason as { code?: string }).code, 'CONFLICT');
});

// ── a reset made by ANOTHER process ────────────────────────────────────────

test('A RESET MADE BY ANOTHER PROCESS IS HONOURED AT ONCE: the old password stops working', async () => {
  // No restart, and no waiting for the background re-check either — a password
  // check always reads the file first.
  await reset();
  store.getUsername(); // the store has just looked, so only a FRESH read can see what follows
  writeAuthFromOutside(NEW_HASH);
  await rejects(call(LAN).caller.login({ username: 'admin', password: OLD }), 'UNAUTHORIZED');
  const ok = await call(LAN).caller.login({ username: 'admin', password: NEW });
  assert.equal(ok.authenticated, true, 'the password the reset set must work straight away');
});

test('...and every session from before it ends, without a restart', async () => {
  await reset();
  const before = sessions.createSession('admin', sessions.currentCredential());
  writeAuthFromOutside(NEW_HASH);
  store.getPasswordHash({ fresh: true }); // what the next sign-in attempt does anyway
  assert.equal(sessions.getSessionUser(before.token), null, 'a pre-reset session outlived the reset');
});

test('...even if nothing signs in: the background re-check catches it within a second', async () => {
  await reset();
  const before = sessions.createSession('admin', sessions.currentCredential());
  writeAuthFromOutside(NEW_HASH);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(sessions.getSessionUser(before.token), null);
});

/**
 * Run the REAL reset-password tool as its own process, answering its prompts the
 * way a person at the terminal would: each answer is sent only once its question is
 * on screen (readline drops lines that arrive before the question is asked).
 *
 * It ends by restarting the core container. DOCKER_SOCKET and the container name are
 * pointed at nothing, so a test can never restart a real OpenMasjidOS on the machine
 * running it; the tool reports that it could not, which is its normal path anyway.
 */
function runResetTool(newPassword: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(__dirname, '..', 'src', 'reset-password.ts')], {
      env: {
        ...process.env,
        OPENMASJID_DATA_DIR: DATA,
        DOCKER_SOCKET: path.join(DATA, 'there-is-no-docker-here.sock'),
        OPENMASJID_CONTAINER_NAME: 'omos-test-no-such-container',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    const prompts: Array<[RegExp, string]> = [
      [/Username \[[^\]]*\]: $/, ''],
      [/New password \(typed visibly\): $/, newPassword],
      [/Confirm new password: $/, newPassword],
    ];
    let next = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the reset tool did not finish. It printed:\n${out}`));
    }, 60_000);
    child.stdout.on('data', (b: Buffer) => {
      out += b.toString();
      if (next < prompts.length && prompts[next]![0].test(out)) {
        child.stdin.write(`${prompts[next]![1]}\n`);
        next += 1;
        if (next === prompts.length) child.stdin.end();
      }
    });
    child.stderr.on('data', (b: Buffer) => (out += b.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

test('THE REAL RESET TOOL, AS A SEPARATE PROCESS: the old password and old sessions end at once', { timeout: 90_000 }, async () => {
  // install.sh → Reset sign-in runs this tool, then (in reset-auth) reinstalls every
  // app, and only THEN restarts the core — minutes later. That window is where the
  // person the reset exists to lock out could still sign in. This is the actual
  // entry point, prompts and argon2 included, not a copy of the calls it makes.
  await reset();
  const before = sessions.createSession('admin', sessions.currentCredential());
  const NEWER = 'the-password-the-reset-tool-set';
  const run = await runResetTool(NEWER);
  assert.equal(run.code, 0, `the reset tool failed:\n${run.out}`);
  assert.match(run.out, /Password updated/, `the reset tool did not finish its work:\n${run.out}`);

  const { caller, cookie } = call(LAN);
  await rejects(caller.login({ username: 'admin', password: OLD }), 'UNAUTHORIZED');
  assert.equal(cookie(), null, 'THE OLD PASSWORD STILL SIGNED IN AFTER A RESET');
  assert.equal(sessions.getSessionUser(before.token), null, 'a pre-reset session is still alive');
  assert.equal((await call(LAN).caller.login({ username: 'admin', password: NEWER })).authenticated, true);
});

test("CHANGING HOW YOU SIGN IN RE-PROVES THE CURRENT PASSWORD, not last second's", async () => {
  // The two-step settings ask for the password again before changing anything. That
  // check read the throttled copy, so for up to a second after a reset from the
  // installer, the OLD password could still turn two-step sign-in off.
  await reset();
  const s = sessions.createSession('admin', sessions.currentCredential());
  store.getUsername(); // the store has just looked, so only a FRESH read can see what follows
  writeAuthFromOutside(NEW_HASH);
  await assert.rejects(call(LAN, s).caller.twoFactor.begin({ password: OLD }), /That password is not right/);
});

// ── what the re-check must never do ────────────────────────────────────────

test('A DAMAGED auth.json IS NEVER ADOPTED — the last good copy keeps working', async () => {
  // Adopting a bad read would lock the admin out on one SD-card hiccup.
  await reset();
  const good = fs.readFileSync(AUTH_JSON, 'utf8');
  try {
    fs.writeFileSync(AUTH_JSON, '{"username": "adm');
    store.getPasswordHash({ fresh: true });
    assert.equal(store.getUsername(), 'admin');
    assert.equal(store.isConfigured(), true);
    assert.equal((await call(LAN).caller.login({ username: 'admin', password: OLD })).authenticated, true);
    fs.writeFileSync(AUTH_JSON, '[]');
    store.getPasswordHash({ fresh: true });
    assert.equal(store.isConfigured(), true, 'a wrong-shaped file read as "no admin yet"');
  } finally {
    writeJson(AUTH_JSON, JSON.parse(good));
  }
});

test('A MISSING auth.json NEVER RE-OPENS FIRST-RUN SETUP', async () => {
  // "No admin yet" is what lets the next visitor create one. A file that vanishes
  // underneath a configured box — a half-finished restore, a slip in the File
  // Explorer — must not hand that box to whoever opens the dashboard next.
  await reset();
  const good = fs.readFileSync(AUTH_JSON, 'utf8');
  try {
    fs.rmSync(AUTH_JSON);
    store.getPasswordHash({ fresh: true });
    assert.equal(store.isConfigured(), true);
    await rejects(
      call(LAN).caller.setup({ name: 'intruder', email: 'x@example.com', password: 'a-password-of-my-own' }),
      'CONFLICT',
    );
  } finally {
    writeJson(AUTH_JSON, JSON.parse(good));
  }
});

test('A PASSWORD CHANGE THE DISK REFUSES CHANGES NOTHING — not even in memory', async () => {
  // The store used to update its copy and THEN write. A full SD card therefore left
  // the new password in memory only: the admin's own session died (sessions are bound
  // to the password), the old password was refused although the screen said the
  // change had failed, and a restart brought the old one back. Nothing could repair
  // it, because the file never changed.
  await reset();
  const s = sessions.createSession('admin', sessions.currentCredential());
  const tmp = `${AUTH_JSON}.tmp`;
  fs.mkdirSync(tmp); // writeJson cannot create its temp file, so every write fails
  try {
    await assert.rejects(call(LAN, s).caller.changePassword({ currentPassword: OLD, newPassword: NEW }));
    assert.equal(store.getPasswordHash({ fresh: true }), OLD_HASH, 'the failed change was believed in memory');
    assert.equal(sessions.getSessionUser(s.token), 'admin', 'the admin was signed out by their own failed change');
    assert.throws(() => store.setProfile({ name: 'not-saved' }));
    assert.notEqual(store.getAdminName(), 'not-saved', 'a profile edit the disk refused was kept in memory');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  assert.equal(
    (await call(LAN).caller.login({ username: 'admin', password: OLD })).authenticated,
    true,
    'the old password must still work after a change that failed',
  );
});

test('ONE FAILED READ AT BOOT IS RETRIED, not trusted until the next restart', () => {
  // A single transient EIO while the store first read auth.json used to stick: the
  // stamp of the (intact) file was recorded anyway, every later check saw "unchanged"
  // and never read it again, the right password was refused and every saved session
  // was dropped.
  const shared = req.cache[STORE_PATH];
  const realRead = fs.readFileSync;
  let failed = false;
  const flaky = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (!failed && String(file) === AUTH_JSON) {
      failed = true;
      throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
    }
    return (realRead as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.readFileSync;
  let booted: Store;
  try {
    fs.readFileSync = flaky;
    delete req.cache[STORE_PATH];
    booted = req('../src/auth/store') as Store;
  } finally {
    fs.readFileSync = realRead;
    req.cache[STORE_PATH] = shared;
  }
  assert.ok(failed, 'precondition: the boot read must have failed');
  assert.equal(booted.getPasswordHash({ fresh: true }), store.getPasswordHash(), 'the good file was never read again');
  assert.equal(booted.isAuthStoreDamaged(), false);
});

test('a box whose file was damaged at boot is usable once the reset tool repairs it', () => {
  const good = fs.readFileSync(AUTH_JSON, 'utf8');
  const shared = req.cache[STORE_PATH];
  try {
    fs.writeFileSync(AUTH_JSON, 'not json');
    delete req.cache[STORE_PATH];
    const booted = req('../src/auth/store') as typeof import('../src/auth/store');
    assert.equal(booted.isAuthStoreDamaged(), true);
    writeJson(AUTH_JSON, JSON.parse(good));
    booted.getPasswordHash({ fresh: true });
    assert.equal(booted.isAuthStoreDamaged(), false, 'still reporting damage after a repair');
    assert.equal(booted.getUsername(), 'admin');
  } finally {
    writeJson(AUTH_JSON, JSON.parse(good));
    // Put the shared instance back for any test after this one.
    req.cache[STORE_PATH] = shared;
  }
});

// ── while a restore runs ───────────────────────────────────────────────────

test('DURING A RESTORE the store keeps the identity it started with, and refuses writes', async () => {
  // Adopting the restored auth.json mid-restore signs the admin out part-way, and
  // the dashboard then unmounts the window reporting whether the restore worked.
  // And between the restore removing config/ and moving the new one in, a write
  // would recreate config/ and make that move fail.
  await reset();
  const s = sessions.createSession('admin', sessions.currentCredential());
  const release = store.holdForRestore();
  try {
    writeAuthFromOutside(NEW_HASH);
    assert.equal(store.getPasswordHash({ fresh: true }), OLD_HASH, 'the restored record was adopted mid-restore');
    assert.equal(sessions.getSessionUser(s.token), 'admin', 'the admin was signed out part-way through a restore');
    assert.throws(() => store.setProfile({ name: 'x' }), /restore is in progress/);
    assert.throws(() => store.updatePasswordHash(OLD_HASH), /restore is in progress/);
    assert.throws(() => store.setCredentials('admin', OLD_HASH), /restore is in progress/);
  } finally {
    release();
  }
  assert.equal(store.getPasswordHash(), NEW_HASH, 'once released, the restored record must be read at once');
});

test("ONE RESTORE CANNOT LIFT ANOTHER RESTORE'S HOLD", async () => {
  // A shared flag let a second restore that stopped early release in its `finally`
  // while the first was still mid-way, and the store adopted the restored record
  // under the first — signing the admin out of the window reporting on it.
  await reset();
  const first = store.holdForRestore();
  const second = store.holdForRestore();
  try {
    writeAuthFromOutside(NEW_HASH);
    second();
    second(); // releasing twice must not release someone else's hold either
    assert.equal(store.getPasswordHash({ fresh: true }), OLD_HASH, "one restore's release lifted the other's hold");
    assert.throws(() => store.setProfile({ name: 'x' }), /restore is in progress/);
  } finally {
    first();
  }
  assert.equal(store.getPasswordHash(), NEW_HASH);
});

test('ONLY ONE RESTORE RUNS AT A TIME — a second is told, not started', async () => {
  // Closing the progress window and picking a file again started a second restore
  // over the first: it wiped the first's staging directory and released its hold.
  const lock = req('../src/system/update-lock') as typeof import('../src/system/update-lock');
  const restore = req('../src/system/restore') as typeof import('../src/system/restore');
  let finish!: () => void;
  const running = lock.withUpdateLock('restore', 'busy', () => new Promise<void>((r) => (finish = r)));
  try {
    assert.equal(restore.restoreInProgress(), true);
    const lines: string[] = [];
    await restore.runRestore((l) => lines.push(l));
    assert.ok(
      lines.some((l) => /already running/.test(l)),
      `a second restore was not refused: ${JSON.stringify(lines)}`,
    );
    assert.ok(!lines.some((l) => /fail/i.test(l)), 'a refused second run must not read as a failure');
  } finally {
    finish();
    await running;
  }
  assert.equal(restore.restoreInProgress(), false);
});

test('the restore upload refuses while a restore is running', () => {
  // A new upload overwrites the very archive the running restore is reading.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'restore.ts'), 'utf8');
  const route = src.slice(src.indexOf("server.post('/api/restore/upload'"));
  const guard = route.indexOf('restoreInProgress()');
  const write = route.indexOf('createWriteStream(RESTORE_PATH');
  assert.ok(guard > 0, 'the upload route does not check for a running restore');
  assert.ok(guard < write, 'it must refuse BEFORE it writes over the archive');
});
