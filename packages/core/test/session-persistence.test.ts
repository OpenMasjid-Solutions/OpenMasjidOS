// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Sign-in sessions survive a restart — and the ways that can go wrong.
 *
 * THE BUG. Sessions lived in a process-memory Map while the browser kept the cookie
 * for seven days. Every update, reboot and crash emptied the Map; the admin's open
 * dashboard tab went on drawing the signed-in shell; pressing Open on an app handed
 * it a cookie pointing at nothing; the app's SSO check said "not signed in"; and
 * because the platform WAS reachable, the app also refused its own password
 * recovery and told the admin to sign in through the dashboard — which they had.
 * Reported from a masjid as "it randomly asks for the control panel password". It
 * was not random. It was every restart.
 *
 * THE SECOND HALF. The first fix used "missing from the file" as the revocation
 * signal, and an adversarial review found five ways that broke — most seriously,
 * that a sign-in with the OLD password during the installer's Reset sign-in window
 * survived the reset. Sessions are now bound to a fingerprint of the password hash
 * instead. Several tests below exist for that review's findings by name.
 *
 * A "restart" is a fresh evaluation of the session store AND the admin store
 * against the same data directory — what a new daemon process does at boot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-sessions-'));
process.env.OPENMASJID_DATA_DIR = DATA;

const req = createRequire(__filename);
const SESSIONS_PATH = req.resolve('../src/auth/sessions');
const STORE_PATH = req.resolve('../src/auth/store');
type Sessions = typeof import('../src/auth/sessions');
type Store = typeof import('../src/auth/store');

let s: Sessions;
let store: Store;

/** A new daemon process, as far as the two stores can tell. */
function restart(): void {
  delete req.cache[SESSIONS_PATH];
  delete req.cache[STORE_PATH];
  store = req('../src/auth/store') as Store;
  s = req('../src/auth/sessions') as Sessions;
}

restart();
const FILE = s!.SESSIONS_FILE;
const TMP = `${FILE}.tmp`;

/** A known admin with a known hash, then a clean session file. */
function fresh(hash = '$argon2id$v=19$m=19456,t=2,p=1$aaaa$bbbb'): void {
  fs.rmSync(FILE, { force: true, recursive: true });
  fs.rmSync(TMP, { force: true, recursive: true });
  store.setCredentials('admin', hash);
  restart();
}

// ── the bug ────────────────────────────────────────────────────────────────

test('A SESSION SURVIVES A RESTART', () => {
  fresh();
  const { token, csrf } = s.createSession('admin', s.currentCredential());
  restart();
  assert.equal(
    s.getSessionUser(token),
    'admin',
    'the browser still holds this cookie for seven days; the server must not forget it on a restart',
  );
  assert.equal(s.verifyCsrf(token, csrf), true, 'and its dashboard key must come back with it');
});

test('several sessions survive together, and each keeps its own key', () => {
  fresh();
  const a = s.createSession('admin', s.currentCredential());
  const b = s.createSession('admin', s.currentCredential());
  restart();
  assert.equal(s.getSessionUser(a.token), 'admin');
  assert.equal(s.getSessionUser(b.token), 'admin');
  assert.equal(s.verifyCsrf(a.token, b.csrf), false, "one session's key must not unlock another");
});

// ── revocation is bound to the password ────────────────────────────────────

test('A PASSWORD CHANGE IN THIS PROCESS ENDS EVERY OLDER SESSION AT ONCE', () => {
  fresh();
  const before = s.createSession('admin', s.currentCredential());
  store.updatePasswordHash('$argon2id$v=19$m=19456,t=2,p=1$cccc$dddd');
  assert.equal(s.getSessionUser(before.token), null, 'a session from before the password change still works');
  assert.equal(s.verifyCsrf(before.token, before.csrf), false);
});

test('THE RESET-SIGN-IN WINDOW: a session from before a reset does not survive it — nor wait for a restart', () => {
  // The review's top finding. `install.sh` → Reset sign-in runs in a SEPARATE
  // process: it sets a new password and clears the sessions, then reinstalls every
  // app, and only THEN restarts the core — minutes later. Until that restart the
  // daemon held the OLD password hash in memory, so every old session lived on,
  // and the first version even wrote them back to disk where they survived it.
  //
  // Whether someone can SIGN IN with the old password in that window is the auth
  // router's question and is driven through it in credential-binding.test.ts.
  // This is the session store's half: what was already signed in.
  fresh();
  const before = s.createSession('admin', s.currentCredential());

  // The reset tool's two calls, from a separate process against the same data
  // directory. The real tool, prompts and all, is driven in credential-binding.test.ts.
  const script = [
    `const store = require(${JSON.stringify(STORE_PATH)});`,
    `const sessions = require(${JSON.stringify(SESSIONS_PATH)});`,
    `store.setCredentials('admin', '$argon2id$v=19$m=19456,t=2,p=1$eeee$ffff');`,
    `sessions.destroyAllSessions();`,
  ].join('\n');
  const cli = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], {
    env: { ...process.env, OPENMASJID_DATA_DIR: DATA },
    encoding: 'utf8',
  });
  assert.equal(cli.status, 0, `the reset process failed: ${cli.stderr}`);

  // The window: the daemon has not restarted. The next password check reads the
  // file first, and the old session is bound to a password that is no longer it.
  store.getPasswordHash({ fresh: true });
  assert.equal(s.getSessionUser(before.token), null, 'a pre-reset session is still alive in the reset window');
  assert.equal(s.verifyCsrf(before.token, before.csrf), false);

  restart(); // the core restart the reset ends with
  assert.equal(s.getSessionUser(before.token), null, 'a session from before the reset survived it');
});

test('re-setting the SAME password still revokes, because the hash has a new salt', () => {
  // A reset with an identical password must still sign everyone out. argon2 salts
  // every hash, so the hash string — and the fingerprint — changes.
  fresh('$argon2id$v=19$m=19456,t=2,p=1$salt1$hashsame');
  const before = s.createSession('admin', s.currentCredential());
  store.setCredentials('admin', '$argon2id$v=19$m=19456,t=2,p=1$salt2$hashsame');
  restart();
  assert.equal(s.getSessionUser(before.token), null);
});

test('the file holds a fingerprint of the password hash, never the hash', () => {
  const hash = '$argon2id$v=19$m=19456,t=2,p=1$distinctive$secretvalue';
  fresh(hash);
  s.createSession('admin', s.currentCredential());
  const body = fs.readFileSync(FILE, 'utf8');
  assert.equal(body.includes('secretvalue'), false, 'the session file became a second copy of the password hash');
  assert.doesNotMatch(body, /argon2/);
});

// ── what must NOT come back ────────────────────────────────────────────────

test('signing out survives a restart', () => {
  fresh();
  const { token } = s.createSession('admin', s.currentCredential());
  s.destroySession(token);
  restart();
  assert.equal(s.getSessionUser(token), null, 'a signed-out cookie came back to life');
});

test('"sign out everywhere" survives a restart', () => {
  fresh();
  const a = s.createSession('admin', s.currentCredential());
  const b = s.createSession('admin', s.currentCredential());
  s.destroyAllSessions();
  restart();
  assert.equal(s.getSessionUser(a.token), null);
  assert.equal(s.getSessionUser(b.token), null);
});

test('A SIGN-OUT THE DISK REFUSES STILL CANNOT COME BACK', () => {
  // The review: a failed write left the revoked token in the file, and the next boot
  // revived it. Now the file is removed instead — unlink works on a full disk, and a
  // missing file boots empty, which fails closed.
  fresh();
  const { token } = s.createSession('admin', s.currentCredential());
  fs.mkdirSync(TMP, { recursive: true }); // the file stays readable; writes now fail
  s.destroySession(token);
  fs.rmSync(TMP, { recursive: true, force: true });
  restart();
  assert.equal(s.getSessionUser(token), null, 'a sign-out the disk refused came back after a restart');
});

test('an expired session is not reloaded', () => {
  fresh();
  const { token } = s.createSession('admin', s.currentCredential());
  const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8')) as { sessions: Array<{ expiresAt: number }> };
  for (const e of parsed.sessions) e.expiresAt = Date.now() - 1;
  fs.writeFileSync(FILE, JSON.stringify(parsed));
  restart();
  assert.equal(s.getSessionUser(token), null);
  assert.equal(s.sessionCount(), 0);
});

test('A HAND-EDITED ENTRY WITHOUT A DASHBOARD KEY OR A PASSWORD BINDING IS REFUSED', () => {
  // Without the key a session is a cookie-only credential — exactly what the
  // dashboard key exists to prevent. Without a binding it would outlive a password
  // change. A partially-restored or hand-edited file must not be able to mint either.
  fresh();
  s.createSession('admin', s.currentCredential());
  const real = (JSON.parse(fs.readFileSync(FILE, 'utf8')) as { sessions: Array<{ cred: string }> }).sessions[0]!;
  const future = Date.now() + 60_000;
  fs.writeFileSync(
    FILE,
    JSON.stringify({
      v: 2,
      sessions: [
        { token: 'a'.repeat(43), username: 'admin', expiresAt: future, cred: real.cred },
        { token: 'b'.repeat(43), username: 'admin', csrf: '', expiresAt: future, cred: real.cred },
        { token: 'c'.repeat(43), username: 'admin', csrf: 'x'.repeat(43), expiresAt: future },
        { token: 'd'.repeat(43), username: 'admin', csrf: 'x'.repeat(43), expiresAt: future, cred: 'not-ours' },
        { token: 'short', username: 'admin', csrf: 'x'.repeat(43), expiresAt: future, cred: real.cred },
      ],
    }),
  );
  restart();
  assert.equal(s.sessionCount(), 0, 'every malformed or unbound entry must be dropped on load');
});

// ── disk failures ──────────────────────────────────────────────────────────

test('A FAILED WRITE NEVER EVICTS A SESSION', () => {
  // The review: the first version pruned every session "missing from the file", so
  // a session the disk refused to save was signed out by the next successful write
  // from any other device — the reported lockout, back. Make the disk refuse while
  // the file stays readable (the temp path is a directory), as ENOSPC or a
  // read-only remount would.
  fresh();
  // The precondition that makes this bite: a file that EXISTS and is READABLE, from
  // an earlier good write, which later failed writes cannot update. The first
  // version of this test started from no file at all — so even the old
  // prune-by-file rule had nothing to prune against, and a mutation run showed the
  // test passing against the very bug it is named for.
  const earlier = s.createSession('admin', s.currentCredential());
  assert.ok(fs.existsSync(FILE), 'precondition: an earlier good write left a readable file');
  fs.mkdirSync(TMP, { recursive: true }); // from here on, every write fails
  const laptop = s.createSession('admin', s.currentCredential());
  const phone = s.createSession('admin', s.currentCredential());
  assert.equal(s.getSessionUser(laptop.token), 'admin', 'the phone signing in signed the laptop out');
  assert.equal(s.getSessionUser(phone.token), 'admin');
  assert.equal(s.getSessionUser(earlier.token), 'admin');

  fs.rmSync(TMP, { recursive: true, force: true }); // the disk recovers
  const tablet = s.createSession('admin', s.currentCredential());
  for (const t of [laptop, phone, tablet]) assert.equal(s.getSessionUser(t.token), 'admin');
  restart(); // and the recovered write carried the unsaved ones with it
  for (const t of [laptop, phone, tablet]) assert.equal(s.getSessionUser(t.token), 'admin');
});

test('A DISK THAT REFUSES THE WRITE NEVER FAILS A SIGN-IN', () => {
  fresh();
  fs.mkdirSync(FILE, { recursive: true }); // unreadable AND unwritable
  restart();
  let created: { token: string } | undefined;
  assert.doesNotThrow(() => {
    created = s.createSession('admin', s.currentCredential());
  }, 'createSession threw because the disk refused');
  assert.equal(s.getSessionUser(created!.token), 'admin');
  fs.rmSync(FILE, { recursive: true, force: true });
});

test('A DAMAGED FILE NEVER STOPS BOOT', () => {
  // The TLS-cert lesson (§15): a corrupt boot-critical file under
  // `restart: unless-stopped` is a crash-loop with no dashboard left to fix it from.
  fresh();
  fs.writeFileSync(FILE, '\u0000\u0001 not json at all');
  assert.doesNotThrow(() => restart());
  assert.equal(s.sessionCount(), 0, 'it starts empty: everyone signs in again, which is the old behaviour');
  const { token } = s.createSession('admin', s.currentCredential());
  restart();
  assert.equal(s.getSessionUser(token), 'admin', 'and signing in repairs it');
});

test('SIGNING OUT A TOKEN THAT IS NOT A SESSION WRITES NOTHING', () => {
  // The review: logout is a public procedure, it called destroySession with ANY
  // cookie value, and every call rewrote and fsynced the file — so one batched
  // request could force hundreds of synchronous disk writes on a Pi's SD card.
  fresh();
  assert.equal(fs.existsSync(FILE), false);
  for (let i = 0; i < 50; i++) s.destroySession(`not-a-session-${i}`.padEnd(43, 'x'));
  assert.equal(fs.existsSync(FILE), false, 'an unauthenticated logout caused a disk write');
});

test('a failed write leaves no temp file behind holding tokens', () => {
  fresh();
  fs.mkdirSync(FILE, { recursive: true }); // the rename onto it fails after the temp is written
  s.createSession('admin', s.currentCredential());
  assert.equal(fs.existsSync(TMP), false, 'a temp file with live tokens was left on disk');
  fs.rmSync(FILE, { recursive: true, force: true });
});

test('the file is written 0600, like every other secret', { skip: process.platform === 'win32' }, () => {
  fresh();
  s.createSession('admin', s.currentCredential());
  assert.equal(fs.statSync(FILE).mode & 0o777, 0o600);
});

// ── backups leave it out ───────────────────────────────────────────────────

test('BACKUPS LEAVE THE SESSIONS FILES OUT, AND ONLY THOSE — checked with the real GNU tar', (t) => {
  // The runtime image installs GNU tar (Alpine `tar` 1.35), where --exclude and
  // --anchored are POSITIONAL and patterns are unanchored by default. Both bit:
  // after the paths it excluded nothing, and unanchored it also dropped any app's
  // own apps/<id>/config/sessions.json. So this runs the real arguments through
  // the real binary and checks what came out in both directions.
  const probe = spawnSync('tar', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0 || !/GNU tar/.test(probe.stdout)) {
    // Reported as SKIPPED, not passed: a green tick here would claim a check that
    // never ran. WSL and CI both have GNU tar, which is where this must run.
    t.skip('GNU tar is not on PATH — production uses GNU tar');
    return;
  }
  fresh();
  s.createSession('admin', s.currentCredential());
  fs.writeFileSync(TMP, '{"leftover":"tokens"}');
  fs.writeFileSync(path.join(DATA, 'config', 'auth.json.extra'), '{}');
  fs.mkdirSync(path.join(DATA, 'apps', 'demo', 'config'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'apps', 'demo', 'meta.json'), '{}');
  fs.writeFileSync(path.join(DATA, 'apps', 'demo', 'config', 'sessions.json'), '{"the app":"its own data"}');

  const backup = req('../src/system/backup') as typeof import('../src/system/backup');
  const made = spawnSync('tar', backup.backupTarArgs(false), { maxBuffer: 64 * 1024 * 1024 });
  assert.equal(made.status, 0, `tar failed: ${made.stderr}`);
  // Listed from STDIN: GNU tar reads a colon in an archive NAME as host:path.
  const listed = spawnSync('tar', ['-tzf', '-'], { input: made.stdout, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(listed.status, 0, `tar -t failed: ${listed.stderr}`);
  const names = new Set(listed.stdout.split(/\r?\n/).filter(Boolean).map((n) => n.replace(/^\.\//, '')));

  assert.equal(names.has('config/sessions.json'), false, 'the sessions file is in the backup');
  assert.equal(names.has('config/sessions.json.tmp'), false, 'the leftover temp file of tokens is in the backup');
  assert.ok(names.has('config/auth.json.extra'), 'the rest of config/ must still be backed up');
  assert.ok(
    names.has('apps/demo/config/sessions.json'),
    "AN APP'S OWN config/sessions.json WAS DROPPED — the exclusion is not anchored",
  );
  fs.rmSync(TMP, { force: true });
});

// ── a restore ends every session at the next boot ──────────────────────────

test('A RESTORE ENDS EVERY SESSION AT THE NEXT BOOT — including ones made while it ran', () => {
  // The old core keeps serving until a restore replaces it, so the admin stays
  // signed in to watch it finish. Anything signed in during that window is written
  // into the RESTORED config/ — and must not outlive the restore either.
  fresh();
  const before = s.createSession('admin', s.currentCredential());
  s.endAllSessionsAtNextBoot();
  assert.equal(s.getSessionUser(before.token), 'admin', 'the admin was signed out part-way through the restore');
  const during = s.createSession('admin', s.currentCredential());

  restart();
  assert.equal(s.getSessionUser(before.token), null, 'a pre-restore session survived the restore');
  assert.equal(s.getSessionUser(during.token), null, 'a session made during the restore survived it');
  assert.equal(fs.existsSync(s.SESSIONS_RESET_MARKER), false, 'the marker must be spent, or every boot signs everyone out');
  assert.equal(fs.existsSync(FILE), false);
});

test('the marker is honoured ONCE: a sign-in after the restore survives the next restart', () => {
  fresh();
  s.endAllSessionsAtNextBoot();
  restart();
  const after = s.createSession('admin', s.currentCredential());
  restart();
  assert.equal(s.getSessionUser(after.token), 'admin', 'the restore went on signing everyone out at every boot');
});

test('a marker that cannot be written never fails the restore', () => {
  fresh();
  // A directory where the marker file should go: the write fails.
  fs.mkdirSync(s.SESSIONS_RESET_MARKER, { recursive: true });
  try {
    assert.doesNotThrow(() => s.endAllSessionsAtNextBoot());
  } finally {
    fs.rmSync(s.SESSIONS_RESET_MARKER, { recursive: true, force: true });
  }
});

// ── a password file that cannot be read is not a password change ───────────

const AUTH_FILE = path.join(DATA, 'config', 'auth.json');

/** A restart during which the first `times` reads of auth.json fail with EIO. */
function restartWithUnreadableAuth(times: number): void {
  const realRead = fs.readFileSync;
  let left = times;
  fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (left > 0 && String(file) === AUTH_FILE) {
      left -= 1;
      throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
    }
    return (realRead as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.readFileSync;
  try {
    restart();
  } finally {
    fs.readFileSync = realRead;
  }
  assert.equal(left, 0, 'precondition: every injected read failure must have been used');
}

test('ONE FAILED READ OF THE PASSWORD FILE AT BOOT SIGNS NOBODY OUT', () => {
  // The store retried its read, but the sessions had already been judged against
  // "no password" and thrown away — every device signed out by one SD-card hiccup.
  fresh();
  const { token } = s.createSession('admin', s.currentCredential());
  restartWithUnreadableAuth(1);
  assert.equal(s.getSessionUser(token), 'admin', 'a transient read error at boot signed the admin out');
});

test('WHILE THE PASSWORD FILE CANNOT BE READ, SESSIONS ARE HELD — not honoured, not thrown away', () => {
  fresh();
  const { token } = s.createSession('admin', s.currentCredential());
  restartWithUnreadableAuth(2); // the store's boot read AND the sessions' retry both fail
  assert.equal(store.isAuthStoreDamaged(), true, 'precondition: the password file is unreadable for now');
  assert.equal(s.getSessionUser(token), null, 'a session was honoured with no password to check it against');
  s.createSession('admin', s.currentCredential()); // a save happens meanwhile
  // The file reads again.
  store.getPasswordHash({ fresh: true });
  assert.equal(store.isAuthStoreDamaged(), false);
  assert.equal(s.getSessionUser(token), 'admin', 'the session was thrown away instead of held');
  restart();
  assert.equal(s.getSessionUser(token), 'admin', 'and it must have survived the save made while it was held');
});
