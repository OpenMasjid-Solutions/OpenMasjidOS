// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * A restore started from OUTSIDE must not lock the admin out.
 *
 * A restore replaces `config/` whole, and nothing carries the current remote-access
 * setup across. At the masjid that is simply what restoring means. From outside, a
 * backup taken before remote administration was set up — most of them, the feature
 * being new — switched the door off behind the admin, and getting back in needed
 * someone in the building. So from outside a restore goes ahead only if the way back
 * in survives it: the same switch, tunnel, password and second factor
 * (system/restore.ts `remoteRestoreProblem`). These drive that function against real
 * files, and pin that it runs before anything is stopped or replaced.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-remote-restore-'));
process.env.OPENMASJID_DATA_DIR = DATA;
// No Docker Engine API here, whatever the machine running the tests has: the restore
// must find nothing to inspect and fall back to what the compose file names.
process.env.DOCKER_SOCKET = path.join(DATA, 'no-docker.sock');

const req = createRequire(__filename);
const settings = req('../src/settings/store') as typeof import('../src/settings/store');
const store = req('../src/auth/store') as typeof import('../src/auth/store');
const tf = req('../src/auth/twofactor') as typeof import('../src/auth/twofactor');
const totpLib = req('../src/auth/totp') as typeof import('../src/auth/totp');
const cloudflared = req('../src/system/cloudflared') as typeof import('../src/system/cloudflared');
const sessions = req('../src/auth/sessions') as typeof import('../src/auth/sessions');
const { remoteRestoreProblem, runRestore, RESTORE_PATH, readRestoreReport } = req('../src/system/restore') as typeof import('../src/system/restore');
const { RESTORE_CLOSE } = req('../src/api/restore') as typeof import('../src/api/restore');
const lock = req('../src/system/update-lock') as typeof import('../src/system/update-lock');
const email = req('../src/store/email') as typeof import('../src/store/email');

// A restore that restarts the core keeps its lock until the core is replaced, which never
// happens here: let go of it between tests, as the replacement would.
beforeEach(() => lock.__releaseHeldLocksForTests());

const CONFIG = path.join(DATA, 'config');
const HASH = '$argon2id$v=19$m=19456,t=2,p=1$aaaa$bbbb';

// The box as it is now: managed from outside, at omos.example.org.
store.setCredentials('admin', HASH);
settings.updateCloudflare({ enabled: true, remoteAdmin: true, domain: 'omos.example.org' });
cloudflared.setToken('TOKEN-NOW');
{
  const { secret } = tf.beginEnrolment('admin');
  tf.confirmEnrolment(totpLib.totp(secret, Date.now()));
}

/** Copy today's config into a fresh "extracted backup", then let a case change it. */
function staged(change: (cfg: string) => void = () => {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-staged-'));
  fs.cpSync(CONFIG, path.join(root, 'config'), { recursive: true });
  change(path.join(root, 'config'));
  return root;
}
const json = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test fixture
const write = (file: string, v: unknown) => fs.writeFileSync(file, JSON.stringify(v));
const editSettings = (cfg: string, patch: Record<string, unknown>) => {
  const s = json(path.join(cfg, 'settings.json'));
  s.cloudflare = { ...s.cloudflare, ...patch };
  write(path.join(cfg, 'settings.json'), s);
};

const OFF = /would switch off managing OpenMasjidOS from outside/;
const CREDS = /different password or two-step sign-in/;

test('a backup of the box as it is now restores from outside', () => {
  assert.equal(remoteRestoreProblem(staged()), null);
});

test('a backup with no settings in it touches none of this, and is never refused here', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-staged-'));
  fs.mkdirSync(path.join(root, 'apps'));
  assert.equal(remoteRestoreProblem(root), null);
});

test('A BACKUP FROM BEFORE REMOTE ADMINISTRATION WAS SET UP IS REFUSED FROM OUTSIDE', () => {
  // The case the review found: most backups predate the feature.
  for (const [what, patch] of [
    ['the switch off', { remoteAdmin: false }],
    ['no switch at all', { remoteAdmin: undefined }],
    ['the tunnel off', { enabled: false }],
  ] as const) {
    assert.match(remoteRestoreProblem(staged((cfg) => editSettings(cfg, patch))) ?? '', OFF, what);
  }
  assert.match(remoteRestoreProblem(staged((cfg) => fs.rmSync(path.join(cfg, 'settings.json')))) ?? '', OFF, 'no settings');
  assert.match(
    remoteRestoreProblem(staged((cfg) => fs.writeFileSync(path.join(cfg, 'settings.json'), '{damaged'))) ?? '',
    OFF,
    'damaged settings',
  );
});

test("A BACKUP WITH ANOTHER APPS' ADDRESS, OR A DASHBOARD ADDRESS OF ITS OWN, STILL RESTORES FROM OUTSIDE", () => {
  // The dashboard is served beside the apps on whichever routed hostname is asked for, so
  // no address in the backup decides whether the way back in survives — including a dev.16
  // backup that still names a dashboard address of its own, or none.
  for (const patch of [
    { domain: 'apps.example.net' },
    { domain: '' },
    { adminHost: 'admin.example.org' },
    { adminHost: '' },
  ]) {
    assert.equal(remoteRestoreProblem(staged((cfg) => editSettings(cfg, patch))), null, JSON.stringify(patch));
  }
});

test('A BACKUP WITH ANOTHER TUNNEL IS REFUSED FROM OUTSIDE — the way in would be a different one', () => {
  assert.match(
    remoteRestoreProblem(staged((cfg) => fs.writeFileSync(path.join(cfg, 'cloudflare', '.env'), 'CF_TUNNEL_TOKEN=TOKEN-THEN\n'))) ?? '',
    OFF,
  );
  assert.match(remoteRestoreProblem(staged((cfg) => fs.rmSync(path.join(cfg, 'cloudflare', '.env')))) ?? '', OFF, 'no token');
});

test('A BACKUP WITH ANOTHER PASSWORD OR SECOND FACTOR IS REFUSED FROM OUTSIDE', () => {
  const auth = (cfg: string) => path.join(cfg, 'auth.json');
  const twofa = (cfg: string) => path.join(cfg, 'twofactor.json');
  assert.match(
    remoteRestoreProblem(staged((cfg) => write(auth(cfg), { ...json(auth(cfg)), passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$cccc$dddd' }))) ?? '',
    CREDS,
    'a different password',
  );
  assert.match(remoteRestoreProblem(staged((cfg) => fs.rmSync(auth(cfg)))) ?? '', CREDS, 'no admin at all');
  assert.match(
    remoteRestoreProblem(staged((cfg) => write(twofa(cfg), { ...json(twofa(cfg)), totpSecret: 'JBSWY3DPEHPK3PXP' }))) ?? '',
    CREDS,
    'an authenticator the admin may no longer have',
  );
  assert.match(remoteRestoreProblem(staged((cfg) => fs.rmSync(twofa(cfg)))) ?? '', CREDS, 'no second factor');
  // Backup codes used or replaced since do not matter: the authenticator still works.
  assert.equal(
    remoteRestoreProblem(staged((cfg) => write(twofa(cfg), { ...json(twofa(cfg)), backupCodes: [] }))),
    null,
  );
});

test('the check runs before anything is stopped or replaced, and only from outside', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'system', 'restore.ts'), 'utf8');
  const body = src.slice(src.indexOf('async function restoreOnce'));
  const check = body.indexOf('remoteRestoreProblem(STAGING_DIR)');
  assert.ok(check > 0, 'the remote restore check is gone');
  assert.ok(check < body.indexOf('await stopAllApps(onLine)'), 'apps were stopped before the check');
  assert.ok(check < body.indexOf('holdForRestore()'), 'config was touched before the check');
  assert.match(body.slice(0, check), /if \(opts\.remote\)/, 'it applies from outside only');
  const api = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'restore.ts'), 'utf8');
  // "From outside" is the front door's hand-over, not a header a masjid's own reverse
  // proxy also sends.
  assert.match(api, /runRestore\(send, \{ remote: wasHandedOver\(req\.raw\), callerToken: requestSessionToken\(req\) \}\)/);
});

test("A BACKUP THE LIVE BOX'S OWN RULE WOULD SHUT IS REFUSED FROM OUTSIDE — truthy is not on", () => {
  // The restore asks the same predicate the live box does (remote-admin.ts
  // settingsOpenTheDoor) instead of a hand-written copy, which once missed a case.
  assert.match(remoteRestoreProblem(staged((cfg) => editSettings(cfg, { enabled: 'yes' }))) ?? '', OFF, 'truthy is not on');
  assert.match(remoteRestoreProblem(staged((cfg) => editSettings(cfg, { remoteAdmin: 1 }))) ?? '', OFF, '…nor is 1');
});

test('A BACKUP WITH NO USERNAME IS REFUSED FROM OUTSIDE — nobody could sign in to what it restores', () => {
  const auth = (cfg: string) => path.join(cfg, 'auth.json');
  for (const username of [null, '', 7]) {
    assert.match(
      remoteRestoreProblem(staged((cfg) => write(auth(cfg), { ...json(auth(cfg)), username }))) ?? '',
      CREDS,
      JSON.stringify(username),
    );
  }
});

test('WITHOUT AN AUTHENTICATOR, A RESTORE FROM OUTSIDE IS REFUSED — emailed codes alone are not vouched for', () => {
  // Whether a restored emailed factor would even work depends on the restored address
  // and mail account as well; a wrong guess there cannot be repaired from outside.
  const twofa = path.join(CONFIG, 'twofactor.json');
  const saved = fs.readFileSync(twofa);
  try {
    tf.disableTwoFactor();
    tf.setEmailFactor(true); // an older, emailed-codes-only configuration
    assert.match(remoteRestoreProblem(staged()) ?? '', CREDS, 'an identical emailed-only backup was waved through');
  } finally {
    fs.writeFileSync(twofa, saved);
  }
  assert.equal(remoteRestoreProblem(staged()), null, 'the authenticator is back for the tests after this one');
});

test('A RESTORE HOLDS THE SECOND-FACTOR EPOCH — the admin restoring from outside is not signed out half-way', () => {
  const twofa = path.join(CONFIG, 'twofactor.json');
  const saved = fs.readFileSync(twofa);
  const epoch = tf.secondFactorEpoch();
  const remote = sessions.createSession('admin', sessions.currentCredential(), { remote: true, tf: epoch, handedOver: true });
  const release = tf.holdSecondFactorEpoch();
  try {
    // The restored file carries another epoch: any change to the factor since the backup.
    write(twofa, { ...json(twofa), epoch: 'from-the-backup' });
    assert.equal(tf.secondFactorEpoch(), epoch);
    assert.equal(sessions.getSessionUserFor(remote.token, { viaTunnel: true }), 'admin', 'signed out mid-restore');
  } finally {
    release();
  }
  assert.equal(tf.secondFactorEpoch(), 'from-the-backup', 'once released, the restored factor rules');
  assert.equal(sessions.getSessionUserFor(remote.token, { viaTunnel: true }), null);
  release(); // a second release is harmless
  // Owned: letting go of an older hold does not lift a newer one.
  const older = tf.holdSecondFactorEpoch();
  const newer = tf.holdSecondFactorEpoch();
  older();
  write(twofa, { ...json(twofa), epoch: 'later' });
  assert.equal(tf.secondFactorEpoch(), 'from-the-backup');
  newer();
  assert.equal(tf.secondFactorEpoch(), 'later');
  fs.writeFileSync(twofa, saved);

  // The restore takes it beside the store's hold, before anything is replaced, and
  // lets it go in its finally.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'system', 'restore.ts'), 'utf8');
  const body = src.slice(src.indexOf('async function restoreOnce'));
  const taken = body.indexOf('holdSecondFactorEpoch()');
  assert.ok(taken > body.indexOf('holdForRestore()'), 'taken with the store hold');
  assert.ok(taken < body.indexOf('fs.rmSync(dest'), 'before anything is replaced');
  assert.match(body.slice(body.indexOf('} finally {')), /releaseEpoch\?\.\(\)/, 'released in the finally');
});

test(
  'A RESTORE SAYS HOW IT ENDED — a refused one is "nothing changed", never "restarting… complete"',
  { skip: process.platform === 'win32' ? 'needs GNU tar — run the suite in WSL' : false },
  async () => {
    const lines: string[] = [];
    assert.equal(await runRestore((l) => lines.push(l)), 'unchanged', 'no file at all');

    // A real backup, refused from outside because it would switch remote administration off.
    const root = staged((cfg) => editSettings(cfg, { remoteAdmin: false }));
    const made = spawnSync('tar', ['-czf', RESTORE_PATH, '-C', root, 'config']);
    assert.equal(made.status, 0, String(made.stderr));
    assert.equal(await runRestore((l) => lines.push(l), { remote: true }), 'unchanged');
    assert.ok(lines.some((l) => OFF.test(l)), 'the reason is streamed to the window');
    assert.equal(fs.existsSync(RESTORE_PATH), false, 'and the upload is cleaned up');

    // The socket carries the ending to the window: one close code each, and the
    // window's own copy of them in step.
    assert.deepEqual(RESTORE_CLOSE.restarting, [1000, 'restarting'], 'a normal close is the one restart');
    const modal = fs.readFileSync(path.join(__dirname, '..', '..', 'ui', 'src', 'components', 'RestoreModal.tsx'), 'utf8');
    const notRestarted = Number(/const CLOSED_NOT_RESTARTED = (\d+);/.exec(modal)?.[1]);
    assert.equal(notRestarted, RESTORE_CLOSE['not-restarted'][0], "the window's code for a stopped restore");
    const withProblems = Number(/const CLOSED_WITH_PROBLEMS = (\d+);/.exec(modal)?.[1]);
    assert.equal(withProblems, RESTORE_CLOSE['restarting-with-problems'][0], "the window's code for a restart with missing app data");
    const restoredNoRestart = Number(/const CLOSED_RESTORED_NOT_RESTARTED = (\d+);/.exec(modal)?.[1]);
    assert.equal(restoredNoRestart, RESTORE_CLOSE['restored-not-restarted'][0], "the window's code for a restore that could not restart");
    assert.match(
      modal,
      /code !== CLOSED_NOT_RESTARTED &&\s+code !== CLOSED_WITH_PROBLEMS &&\s+code !== CLOSED_RESTORED_NOT_RESTARTED/,
      'none of them may read as "nothing changed"',
    );
    const unchanged = RESTORE_CLOSE.unchanged[0];
    assert.ok(
      unchanged >= 4000 &&
        unchanged <= 4999 &&
        ![notRestarted, withProblems, restoredNoRestart].includes(unchanged),
      'the window reads every other 4xxx as "nothing changed"',
    );
    // Every outcome has its own code.
    const codes = Object.values(RESTORE_CLOSE).map(([c]) => c);
    assert.equal(new Set(codes).size, codes.length, 'two outcomes share a close code');
    const api = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'restore.ts'), 'utf8');
    assert.match(api, /socket\.close\(\.\.\.RESTORE_CLOSE\[outcome\]\)/);
    // A refusal before the restore starts is SAID in the window, not only in the close
    // frame the window never shows — "the messages above say why" over an empty log.
    const route = api.slice(api.indexOf("'/api/restore/run'"));
    assert.match(route, /const refuse = \(code: number, why: string\) => \{[\s\S]*?socket\.send\([\s\S]*?socket\.close\(code, why\)/);
    assert.doesNotMatch(route.slice(0, route.indexOf('runRestore(')), /return socket\.close\(44/, 'a refusal closes without saying why');
  },
);


// ── the restore's own outcome, end to end, with a stand-in Docker ────────────

/**
 * A stand-in `docker` that records every call and fails the ones matching `fail` (a
 * shell `case` pattern over its arguments) — by default only a volume refill.
 */
function fakeDocker(fail = '*"tar -xzf"*'): { log: () => string; restore: () => void } {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-fake-docker-'));
  const logFile = path.join(bin, 'calls.log');
  fs.writeFileSync(logFile, '');
  fs.writeFileSync(
    path.join(bin, 'docker'),
    `#!/bin/sh\necho "$*" >> "$FAKE_DOCKER_LOG"\ncase "$*" in ${fail}) exit 1 ;; esac\nexit 0\n`,
    { mode: 0o755 },
  );
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${PATH}`;
  process.env.FAKE_DOCKER_LOG = logFile;
  return {
    log: () => fs.readFileSync(logFile, 'utf8'),
    restore: () => {
      process.env.PATH = PATH;
      delete process.env.FAKE_DOCKER_LOG;
    },
  };
}

/** Pack a staged tree as the uploaded archive. */
function upload(root: string): void {
  const tops = fs.readdirSync(root);
  const made = spawnSync('tar', ['-czf', RESTORE_PATH, '-C', root, ...tops]);
  assert.equal(made.status, 0, String(made.stderr));
}

const POSIX_ONLY = { skip: process.platform === 'win32' ? 'needs GNU tar and a POSIX shell — run the suite in WSL' : false } as const;

// An installed app, so "stop every app" has something to stop.
fs.mkdirSync(path.join(DATA, 'apps', 'donations'), { recursive: true });
fs.writeFileSync(
  path.join(DATA, 'apps', 'donations', 'meta.json'),
  JSON.stringify({ id: 'donations', name: 'Donations', kind: 'catalog', createdAt: '2026-01-01T00:00:00.000Z' }),
);

test('A BACKUP WITH NOTHING TO RESTORE STOPS NO APP — and says nothing changed', POSIX_ONLY, async () => {
  // It was found out only after every app had been stopped, which left them stopped —
  // a manually stopped container does not even come back after a reboot — under a
  // window saying "Nothing was changed".
  const docker = fakeDocker();
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-staged-'));
    fs.mkdirSync(path.join(root, 'volumes', 'omos-donations_data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'volumes', 'omos-donations_data', 'db.sqlite'), 'a folder, not an archive');
    upload(root);
    const lines: string[] = [];
    assert.equal(await runRestore((l) => lines.push(l)), 'unchanged');
    assert.ok(lines.some((l) => /nothing to restore/.test(l)), lines.join(' | '));
    assert.doesNotMatch(docker.log(), /\bstop\b/, 'an app was stopped for a backup with nothing in it');
  } finally {
    docker.restore();
  }
});

test(
  'A RESTORE WHOSE APP DATA DID NOT ALL COME BACK IS NOT "COMPLETE" — and the core comes back on the build it is running',
  POSIX_ONLY,
  async () => {
    const docker = fakeDocker();
    const compose = path.join(DATA, 'docker-compose.yml');
    const composeText = 'services:\n  core:\n    image: ghcr.io/openmasjid-solutions/openmasjid-core:0.51.2-dev.16\n    restart: unless-stopped\n';
    fs.writeFileSync(compose, composeText);
    // Two remote sessions: the admin doing the restore, and one from before it.
    const caller = sessions.createSession('admin', sessions.currentCredential(), { remote: true, tf: tf.secondFactorEpoch(), handedOver: true });
    const other = sessions.createSession('admin', sessions.currentCredential(), { remote: true, tf: tf.secondFactorEpoch(), handedOver: true });
    const epochBefore = tf.secondFactorEpoch();
    try {
      const root = staged(); // this box's own settings…
      fs.mkdirSync(path.join(root, 'volumes'));
      fs.writeFileSync(path.join(root, 'volumes', 'omos-donations_data.tar.gz'), 'whose refill the stand-in fails');
      upload(root);
      const lines: string[] = [];
      const outcome = await runRestore((l) => lines.push(l), { callerToken: caller.token });
      assert.equal(outcome, 'restarting-with-problems', lines.join(' | '));
      assert.ok(lines.some((l) => /NONE of your app data could be put back/.test(l)));

      // The core came back on what it was running, never the channel's alias — which
      // nothing refreshes after the install, so it named the install-time build.
      assert.equal(fs.readFileSync(compose, 'utf8'), composeText, "the core's compose file was rewritten");
      assert.match(docker.log(), /run -d --rm .*openmasjid-core:0\.51\.2-dev\.16 -c sleep 2; docker compose/);
      assert.doesNotMatch(docker.log(), /openmasjid-core:(dev|latest)\b/);

      // A fresh second-factor epoch, the restoring admin moved onto it, and nobody else.
      const after = tf.secondFactorEpoch();
      assert.notEqual(after, epochBefore, 'the backup’s epoch was released into');
      assert.equal(sessions.getSessionUserFor(caller.token, { viaTunnel: true }), 'admin', 'the admin restoring was shut out');
      assert.equal(sessions.getSessionUserFor(other.token, { viaTunnel: true }), null, 'a session from before the restore still counts from outside');

      // Which apps came back without their data is kept for the dashboard: this window is
      // gone soon after the core restarts, when every session ends.
      const report = readRestoreReport();
      assert.deepEqual(report?.appsWithoutData, ['Donations'], 'by the name the admin knows, not the volume');
      assert.ok(lines.some((l) => /Affected: Donations/.test(l)), lines.join(' | '));
    } finally {
      docker.restore();
      fs.rmSync(compose, { force: true });
    }
  },
);

/** Give the installed Donations app a compose file, so a restore starts it again. */
function withComposeFile(): () => void {
  const file = path.join(DATA, 'apps', 'donations', 'compose.yml');
  fs.writeFileSync(file, 'services:\n  app:\n    image: nginx:1.27\n    ports: ["8080:80"]\n');
  return () => fs.rmSync(file, { force: true });
}

test('AN APP THAT DID NOT START AFTER A RESTORE IS NOT "COMPLETE" EITHER — and the dashboard is told which', POSIX_ONLY, async () => {
  // Only app data that failed counted: a move to a new box that could not pull an app's
  // image ended on "Restore complete." with the donations page down.
  const docker = fakeDocker('compose*omos-*" up "*');
  const removeCompose = withComposeFile();
  try {
    const root = staged();
    upload(root);
    const lines: string[] = [];
    assert.equal(await runRestore((l) => lines.push(l)), 'restarting-with-problems', lines.join(' | '));
    assert.ok(lines.some((l) => /couldn't start/.test(l)), lines.join(' | '));
    assert.deepEqual(readRestoreReport()?.appsNotStarted, ['Donations']);

    // A later restore with nothing to report clears it — even the copy that came back
    // inside the backup's own config/, which is where this one's backup took it from.
    const healthy = fakeDocker();
    try {
      lock.__releaseHeldLocksForTests(); // the core the first one handed over to was replaced
      upload(staged());
      assert.equal(await runRestore(() => undefined), 'restarting');
      assert.equal(readRestoreReport(), null, 'an old report outlived a restore that went well');
    } finally {
      healthy.restore();
    }
  } finally {
    removeCompose();
    docker.restore();
  }
});

test('"RESTORED, BUT IT COULD NOT RESTART ITSELF" IS NOT "IT STOPPED PART-WAY"', POSIX_ONLY, async () => {
  // Both were 4002, and the window under "Restore finished, but the dashboard could not
  // restart on its own" said "The restore stopped before it could finish" — inviting a
  // second restore that stops every app again, when only a restart was missing.
  const docker = fakeDocker('"run -d"*');
  try {
    upload(staged());
    const lines: string[] = [];
    assert.equal(await runRestore((l) => lines.push(l)), 'restored-not-restarted', lines.join(' | '));
    assert.equal(RESTORE_CLOSE['restored-not-restarted'][0], 4004);
  } finally {
    docker.restore();
  }
});

test('A RESTORE DOES NOT CARRY ITS CALLER BACK IN once that session was shut out while it ran', POSIX_ONLY, async () => {
  // Whoever started the restore is moved onto the renewed second-factor epoch at the end —
  // which brought back, from outside, a session the admin had shut out while the restore
  // was still unpacking: a copied cookie restoring a backup, say, while the admin replaced
  // the backup codes to get rid of it.
  const docker = fakeDocker();
  try {
    const caller = sessions.createSession('admin', sessions.currentCredential(), {
      remote: true,
      tf: tf.secondFactorEpoch(),
      handedOver: true,
    });
    tf.regenerateBackupCodes(); // the admin shuts it out
    assert.equal(sessions.getSessionUserFor(caller.token, { viaTunnel: true }), null, 'setup: shut out');
    upload(staged());
    assert.equal(await runRestore(() => undefined, { callerToken: caller.token }), 'restarting');
    assert.equal(sessions.getSessionUserFor(caller.token, { viaTunnel: true }), null, 'the restore let a shut-out session back in');
  } finally {
    docker.restore();
  }
});

test('a sign-in DURING a restore is bound to the epoch sessions are judged against then', () => {
  // The restore holds the epoch; a code checked meanwhile reported the restored file's
  // instead, so the session it made was refused from its very first request.
  const twofa = path.join(CONFIG, 'twofactor.json');
  const saved = fs.readFileSync(twofa);
  const secret = String(json(twofa).totpSecret);
  const release = tf.holdSecondFactorEpoch();
  try {
    const held = tf.secondFactorEpoch();
    write(twofa, { ...json(twofa), epoch: 'restored-file' });
    const r = tf.verifySecondFactor(totpLib.totp(secret, Date.now() + 30_000));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.ok && r.epoch, held);
  } finally {
    release();
    fs.writeFileSync(twofa, saved);
  }
});

test('A RESTORE THAT RESTARTS THE CORE KEEPS ITS LOCK UNTIL THE CORE IS REPLACED', POSIX_ONLY, async () => {
  // The old core goes on running for some seconds after the hand-off. A second restore,
  // an update or an app started in that gap was accepted, and then cut off part-way.
  const docker = fakeDocker();
  try {
    upload(staged());
    assert.equal(await runRestore(() => undefined), 'restarting');
    assert.equal(lock.isUpdating('restore'), true, 'let go at the hand-off');
    upload(staged());
    const lines: string[] = [];
    assert.equal(await runRestore((l) => lines.push(l)), 'unchanged', 'a second restore ran before the core was replaced');
    assert.ok(
      lines.some((l) => /^OpenMasjidOS is restarting to finish restoring your backup\. Please try again in a minute or two\./.test(l)),
      lines.join(' | '),
    );
    // The first restore removed its own file on the way out, so this one is the refused
    // request's — and nothing else would remove it.
    assert.equal(fs.existsSync(RESTORE_PATH), false, 'a refused backup was left in the data folder');
    // But while a restore is still RUNNING, the file is the one it is reading.
    lock.__releaseHeldLocksForTests();
    let release = () => {};
    const running = lock.withUpdateLock('restore', 'busy', () => new Promise<void>((r) => (release = r)));
    upload(staged());
    assert.equal(await runRestore(() => undefined), 'unchanged');
    assert.equal(fs.existsSync(RESTORE_PATH), true, "a second request deleted the running restore's file");
    release();
    await running;
    fs.rmSync(RESTORE_PATH, { force: true });
  } finally {
    docker.restore();
  }
});

test('A RESTORE REFUSED FOR AN UPDATE IN ITS WAY SAYS SO, AND LEAVES NO BACKUP BEHIND', POSIX_ONLY, async () => {
  const docker = fakeDocker();
  let release = () => {};
  const held = lock.withUpdateLock('core', 'busy', () => new Promise<void>((r) => (release = r)));
  try {
    upload(staged());
    const lines: string[] = [];
    assert.equal(await runRestore((l) => lines.push(l)), 'unchanged');
    assert.ok(
      lines.some((l) => /^OpenMasjidOS is being updated right now\. Please restore your backup once it has finished\./.test(l)),
      lines.join(' | '),
    );
    // A whole backup — every secret in it — left in the data directory for nothing.
    assert.equal(fs.existsSync(RESTORE_PATH), false, 'the refused backup was left on disk');
    assert.doesNotMatch(docker.log(), /\bstop\b/, 'an app was stopped for a refused restore');
  } finally {
    release();
    await held;
    docker.restore();
  }
  // The upload says so before the whole file has been sent.
  const api = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'restore.ts'), 'utf8');
  const route = api.slice(api.indexOf("'/api/restore/upload'"));
  const check = route.indexOf("clashFor('restore')");
  assert.ok(check > 0 && check < route.indexOf('req.file()'), 'the upload reads the file before asking');
});

test('NOTHING IS CHANGED FROM THE DASHBOARD WHILE A RESTORE RUNS — looking is fine', async () => {
  // A restore replaces config/ whole: a setting saved meanwhile was written over, or
  // written into a directory that did not exist for a moment, and the admin was told it
  // had been saved.
  const { router, protectedProcedure } = req('../src/trpc/trpc') as typeof import('../src/trpc/trpc');
  const r = router({
    look: protectedProcedure.query(() => 'looked'),
    change: protectedProcedure.mutation(() => 'changed'),
    // Named as the real ones are, since the allowance is by path.
    apps: router({
      stop: protectedProcedure.mutation(() => 'stopped'),
      openRemote: protectedProcedure.mutation(() => 'ticket'),
      start: protectedProcedure.mutation(() => 'started'),
    }),
  });
  const s = sessions.createSession('admin', sessions.currentCredential());
  const caller = r.createCaller({
    username: 'admin',
    sessionToken: s.token,
    csrf: s.csrf,
    isWebSocket: false,
    ip: '172.17.0.1',
    host: '192.168.1.50',
    viaTunnel: false,
    handedOver: false,
  } as never);
  assert.equal(await caller.change(), 'changed');
  let release = () => {};
  const held = lock.withUpdateLock('restore', 'busy', () => new Promise<void>((res) => (release = res)));
  try {
    await assert.rejects(
      caller.change(),
      (e: { code?: string; message?: string }) => e.code === 'CONFLICT' && /A backup is being restored right now/.test(e.message ?? ''),
    );
    assert.equal(await caller.look(), 'looked', 'reading was refused too');
    // Turning an app off always works, and opening one from outside writes nothing.
    assert.equal(await caller.apps.stop(), 'stopped', 'Stop was refused during a restore');
    assert.equal(await caller.apps.openRemote(), 'ticket', 'opening an app from outside was refused');
    await assert.rejects(caller.apps.start(), (e: { code?: string }) => e.code === 'CONFLICT', 'Start went ahead');
  } finally {
    release();
    await held;
  }
  assert.equal(await caller.change(), 'changed');
  // Once the restore has finished and only waits for the core to be replaced, it says so.
  await lock.withUpdateLock('restore', 'busy', async () => 'restarting', { holdAfter: () => 60_000 });
  await assert.rejects(
    caller.change(),
    (e: { code?: string; message?: string }) => e.code === 'CONFLICT' && /^OpenMasjidOS is restarting to finish restoring your backup\./.test(e.message ?? ''),
  );
  lock.__releaseHeldLocksForTests();
  // Every protected procedure carries it.
  const trpc = fs.readFileSync(path.join(__dirname, '..', 'src', 'trpc', 'trpc.ts'), 'utf8');
  assert.match(trpc, /export const protectedProcedure = t\.procedure\.use\(isAuthed\)\.use\(noChangesDuringRestore\);/);
  // And the logo, which is changed outside tRPC and lives in config/ too.
  const branding = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'branding.ts'), 'utf8');
  const guard = branding.slice(branding.indexOf('function guard('), branding.indexOf('export function registerBranding'));
  assert.match(guard, /if \(isUpdating\('restore'\)\) \{\s*return \{\s*code: 409,/);
  assert.equal((branding.match(/const bad = guard\(req\);/g) ?? []).length, 2, 'both logo routes ask');
});

test('A RESTORE PUTS ITS SETTINGS IN PLACE AT ONCE — not at the next restart', POSIX_ONLY, async () => {
  // The stores keep what they read at boot. The restored files sat under a daemon that
  // went on using the old ones — and the next save from it wrote them back over the backup.
  const docker = fakeDocker();
  const alerts = req('../src/notify/alerts') as typeof import('../src/notify/alerts');
  try {
    settings.updateSettings({ allowCustomApps: false });
    upload(
      staged((cfg) => {
        const st = json(path.join(cfg, 'settings.json'));
        write(path.join(cfg, 'settings.json'), { ...st, allowCustomApps: true });
        write(path.join(cfg, 'email.json'), { email: { provider: 'none', fromEmail: '', fromName: 'From the backup' } });
        write(path.join(cfg, 'alerts.json'), { channels: { 'os:core-update': { email: false, webhook: true } } });
      }),
    );
    assert.equal(await runRestore(() => undefined), 'restarting');
    assert.equal(settings.getSettings().allowCustomApps, true, 'the restored settings are not the ones in use');
    assert.equal(email.getEmailConfig().fromName, 'From the backup', 'the restored mail settings are not the ones in use');
    assert.equal(alerts.getAlertChannels('os', 'core-update').email, false, 'the restored alert routing is not the one in use');
    // Every store with a cache is reloaded.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'system', 'restore.ts'), 'utf8');
    for (const fn of ['reloadSettings', 'reloadEmailConfig', 'reloadStripeConfig', 'reloadWhatsAppConfig', 'reloadCommandConfig', 'reloadAlertChannels']) {
      assert.match(src, new RegExp(`\\b${fn}\\(\\);`), fn);
    }
  } finally {
    settings.updateSettings({ allowCustomApps: false });
    alerts.setAlertChannel('os', 'core-update', 'email', true);
    docker.restore();
  }
});

test('AN APP THAT COULD NOT BE PAUSED IS NOT "COMPLETE" — its data may not have gone back cleanly', POSIX_ONLY, async () => {
  // `docker compose stop` reports a failure in its exit code and never throws, so a
  // container Docker refused to stop was listed as paused and the restore called complete.
  const docker = fakeDocker('*"omos-donations stop"');
  try {
    upload(staged());
    const lines: string[] = [];
    assert.equal(await runRestore((l) => lines.push(l)), 'restarting-with-problems', lines.join(' | '));
    assert.ok(lines.some((l) => /Donations \(couldn't pause it/.test(l)), lines.join(' | '));
    assert.deepEqual(readRestoreReport()?.appsNotPaused, ['Donations']);
  } finally {
    docker.restore();
  }
});

test('WHAT AN UNFINISHED RESTORE LEFT BEHIND IS REMOVED AT BOOT', () => {
  // A restore cut off by a power cut left the uploaded backup — every secret, unencrypted
  // — and its unpacked copy in the data directory for good.
  const { removeRestoreLeftovers } = req('../src/system/restore') as typeof import('../src/system/restore');
  const staging = path.join(DATA, '.restore-staging');
  fs.writeFileSync(RESTORE_PATH, 'a backup');
  fs.mkdirSync(path.join(staging, 'config'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'config', 'auth.json'), '{}');
  removeRestoreLeftovers();
  assert.equal(fs.existsSync(RESTORE_PATH), false);
  assert.equal(fs.existsSync(staging), false);
  removeRestoreLeftovers(); // nothing there is fine
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  assert.match(index.slice(index.indexOf('async function main')), /removeRestoreLeftovers\(\);/);
});

test('NEITHER THE OFFLINE ALERTS NOR THE OFF-SITE BACKUP RUN WHILE A RESTORE DOES', () => {
  // The restore pauses every app on purpose: each read as an outage, and the alert told
  // the admin to press Start over data still being put back. And a backup taken then
  // copies data half replaced.
  const body = (rel: string) => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'system', rel), 'utf8');
    const at = src.indexOf('async function tick()');
    return src.slice(at, src.indexOf('\n}\n', at));
  };
  const alerts = body('alert-monitor.ts');
  assert.ok(alerts.indexOf("if (isUpdating('restore')) return;") > 0, 'the offline check runs during a restore');
  assert.ok(alerts.indexOf("isUpdating('restore')") < alerts.indexOf('listInstalledWithHealth'), 'it looks before it checks');
  const backups = body('backup-upload.ts');
  assert.ok(backups.indexOf("if (isUpdating('restore') || isUpdating('core')) return;") > 0, 'the off-site backup runs during a restore');
  assert.ok(backups.indexOf("isUpdating('restore')") < backups.indexOf('ticking = true'));
  // Nor the address monitor, which rewrites apps' settings in a tree about to be swapped out.
  const address = body('address-monitor.ts');
  assert.ok(address.indexOf("if (isUpdating('restore')) return;") > 0, 'the address monitor runs during a restore');
  assert.ok(address.indexOf("isUpdating('restore')") < address.indexOf('reconcileNow()'));
});

test("A RESTORED APP'S COMPOSE IS CHECKED THE MOMENT IT IS IN PLACE — not after its data is back", () => {
  // The verdict in a restored meta.json is the backup's. Until the restore reached its
  // last step, an app carrying a `privileged: true` it had not been checked for looked
  // like any other stopped app, with a Start button.
  const { reviewEveryApp, startBlockedReason } = req('../src/apps/manager') as typeof import('../src/apps/manager');
  const dir = path.join(DATA, 'apps', 'smuggled');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id: 'smuggled', name: 'Smuggled', kind: 'custom', createdAt: '2026-01-01T00:00:00.000Z' }));
  fs.writeFileSync(path.join(dir, 'compose.yml'), 'services:\n  app:\n    image: nginx:1.27\n    privileged: true\n');
  try {
    assert.equal(startBlockedReason('smuggled'), null, 'setup: the backup says nothing about it');
    reviewEveryApp();
    assert.equal(startBlockedReason('smuggled')?.kind, 'danger', 'the restored compose was not checked');
    assert.equal(startBlockedReason('donations'), null, 'an app with no compose file is left alone');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Straight after apps/ is moved into place, before any app data goes back.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'system', 'restore.ts'), 'utf8');
  const body = src.slice(src.indexOf('async function restoreOnce'));
  const review = body.indexOf('if (moved > 0) reviewEveryApp();');
  assert.ok(review > body.indexOf('fs.renameSync(src, dest)'), 'checked before the apps were in place');
  assert.ok(review < body.indexOf('await restoreVolumes('), 'checked only after the data went back');
});

test('A BACKUP AND A RESTORE NEVER OVERLAP — the backup would copy data half replaced, and say it worked', POSIX_ONLY, async () => {
  const backup = req('../src/system/backup') as typeof import('../src/system/backup');
  const { BACKUP_RUNNING } = req('../src/system/restore') as typeof import('../src/system/restore');
  // A backup asked for during a restore is refused, before anything is made.
  let release = () => {};
  const held = lock.withUpdateLock('restore', 'busy', () => new Promise<void>((r) => (release = r)));
  try {
    assert.match(backup.backupRefusal() ?? '', /^A backup is being restored right now\. Please make a backup once it has finished\./);
    await assert.rejects(backup.backupStream(), (e: Error) => e.name === 'BackupBusyError' && /being restored/.test(e.message));
  } finally {
    release();
    await held;
  }
  assert.equal(backup.backupRefusal(), null);

  // And a restore asked for while a backup is being made is refused, its upload removed.
  const docker = fakeDocker();
  const handle = await backup.backupStream();
  try {
    assert.equal(backup.backupInProgress(), true, 'setup: a backup is running');
    upload(staged());
    const lines: string[] = [];
    assert.equal(await runRestore((l) => lines.push(l)), 'unchanged');
    assert.ok(lines.includes(BACKUP_RUNNING), lines.join(' | '));
    assert.equal(fs.existsSync(RESTORE_PATH), false, 'the refused backup was left in the data folder');
    assert.doesNotMatch(docker.log(), /\bstop\b/, 'an app was stopped while a backup was being made');
  } finally {
    handle.stream.destroy();
    await handle.done;
    docker.restore();
  }
  // The upload says so first.
  const api = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'restore.ts'), 'utf8');
  const route = api.slice(api.indexOf("'/api/restore/upload'"));
  const check = route.indexOf('if (backupInProgress()) return reply.code(409).send({ error: BACKUP_RUNNING });');
  assert.ok(check > 0 && check < route.indexOf('req.file()'), 'the upload reads the file before asking');
});
