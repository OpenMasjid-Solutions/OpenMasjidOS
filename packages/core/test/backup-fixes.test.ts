// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Backups, restores, the File Explorer and the core update: what a review found, each pinned
 * where it would break. Docker, rclone and (once) tar are stand-ins on PATH — shell scripts
 * that log what they were asked and answer as the case needs.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Writable } from 'node:stream';
import { createRequire } from 'node:module';
import Fastify from 'fastify';
import fastifyMultipart from '@fastify/multipart';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-backup-fixes-'));
process.env.OPENMASJID_DATA_DIR = DATA;
// No Docker Engine API, whatever the machine running this has: only the stand-in CLI.
process.env.DOCKER_SOCKET = path.join(DATA, 'no-docker.sock');

const req = createRequire(__filename);
const backup = req('../src/system/backup') as typeof import('../src/system/backup');
const restore = req('../src/system/restore') as typeof import('../src/system/restore');
const offsite = req('../src/system/backup-upload') as typeof import('../src/system/backup-upload');
const settings = req('../src/settings/store') as typeof import('../src/settings/store');
const lock = req('../src/system/update-lock') as typeof import('../src/system/update-lock');
const store = req('../src/auth/store') as typeof import('../src/auth/store');
const sessions = req('../src/auth/sessions') as typeof import('../src/auth/sessions');
const { runUpdate, recreateCore } = req('../src/docker/update') as typeof import('../src/docker/update');
const { networkInfo } = req('../src/system/system') as typeof import('../src/system/system');
const { registerFiles } = req('../src/api/files') as typeof import('../src/api/files');

const CONFIG = path.join(DATA, 'config');
fs.mkdirSync(CONFIG, { recursive: true });
store.setCredentials('admin', '$argon2id$v=19$m=19456,t=2,p=1$aaaa$bbbb');
// An installed app, so a restore has something to stop.
fs.mkdirSync(path.join(DATA, 'apps', 'donations'), { recursive: true });
fs.writeFileSync(
  path.join(DATA, 'apps', 'donations', 'meta.json'),
  JSON.stringify({ id: 'donations', name: 'Donations', kind: 'catalog', createdAt: '2026-01-01T00:00:00.000Z' }),
);

// A restore that restarts the core keeps its lock until the core is replaced, which never
// happens here.
afterEach(() => lock.__releaseHeldLocksForTests());

const POSIX_ONLY = { skip: process.platform === 'win32' ? 'needs a POSIX shell and GNU tar — run the suite in WSL' : false } as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await sleep(20);
  }
  return true;
}

/** A stand-in `cmd` on PATH: logs each call's arguments as a line, then runs `body`. */
function standIn(cmd: string, body = 'exit 0'): { log: () => string; restore: () => void } {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), `omos-fake-${cmd}-`));
  const calls = path.join(bin, 'calls.log');
  fs.writeFileSync(calls, '');
  fs.writeFileSync(path.join(bin, cmd), `#!/bin/sh\necho "$*" >> '${calls}'\n${body}\n`, { mode: 0o755 });
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${PATH}`;
  return {
    log: () => fs.readFileSync(calls, 'utf8'),
    restore: () => {
      process.env.PATH = PATH;
    },
  };
}

/** A volume's archive, as a backup holds it: these files, under a root of this mode. */
function volumeArchive(files: Record<string, string | Buffer>, mode = 0o755): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-volume-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  fs.chmodSync(dir, mode);
  const made = spawnSync('tar', ['-czf', '-', '-C', dir, '.'], { maxBuffer: 64 * 1024 * 1024 });
  assert.equal(made.status, 0, String(made.stderr));
  return made.stdout;
}

/** Upload a backup holding these files (the restore's own path, as the upload route writes it). */
function uploadBackup(files: Record<string, Buffer>): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-staged-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  const made = spawnSync('tar', ['-czf', restore.RESTORE_PATH, '-C', root, ...fs.readdirSync(root)]);
  assert.equal(made.status, 0, String(made.stderr));
}

/** Everything under `dir`: each file's text, each folder as an empty string at `name/`. */
function tree(dir: string, base = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full);
    if (e.isDirectory()) {
      out[`${rel}/`] = '';
      tree(full, base, out);
    } else out[rel] = fs.readFileSync(full, 'utf8');
  }
  return out;
}

test('A RESTORED VOLUME IS IN EVERY BACKUP AFTER IT — app data is chosen by name, not by a label a restore never set', POSIX_ONLY, async () => {
  // A restore created each volume with a bare `docker volume create`, compose reused it
  // unlabelled, and backups chose volumes by compose's label: after a move to a new box every
  // backup left all the app data out, said it had worked, and the prune then evicted the
  // archives that still held it.
  const docker = standIn(
    'docker',
    [
      'case "$*" in',
      '  *label=*) ;;', // only labelled volumes asked for: these have none
      '  "volume ls"*) echo omos-donations_data; echo omos-cloudflared_state; echo someone-elses ;;',
      '  *"tar -czf"*) printf "the-volume-archive" ;;',
      'esac',
    ].join('\n'),
  );
  try {
    const handle = await backup.backupStream();
    const chunks: Buffer[] = [];
    for await (const c of handle.stream) chunks.push(c as Buffer);
    const result = await handle.done;
    assert.equal(result.ok, true, result.message);
    const listed = spawnSync('tar', ['-tzf', '-'], { input: Buffer.concat(chunks), encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    const names = listed.stdout.split('\n').filter(Boolean);
    assert.ok(names.includes('volumes/omos-donations_data.tar.gz'), `the app's data was left out: ${names.join(' | ')}`);
    assert.ok(!names.some((n) => /cloudflared|someone-elses/.test(n)), names.join(' | '));
    // And the archive goes to the backup alone, not also into the container's log.
    assert.match(docker.log(), /^run --rm --log-driver none -v omos-donations_data:\/from:ro /m);
  } finally {
    docker.restore();
  }
});

test('a volume a restore creates is labelled as compose labels its own, and refilled through the swap', POSIX_ONLY, async () => {
  const docker = standIn('docker');
  try {
    uploadBackup({ 'volumes/omos-donations_data.tar.gz': volumeArchive({ 'db.sqlite': 'restored' }) });
    const lines: string[] = [];
    assert.equal(await restore.runRestore((l) => lines.push(l)), 'restarting', lines.join(' | '));
    const log = docker.log();
    assert.match(
      log,
      /^volume create --label com\.docker\.compose\.project=omos-donations --label com\.docker\.compose\.volume=data omos-donations_data$/m,
    );
    assert.match(log, /^run --rm -i -v omos-donations_data:\/to \S+ sh -c .*tar -xzf - -C "\$new".* sh \/to$/m);
  } finally {
    docker.restore();
  }
});

test('A REFILL LEAVES EXACTLY THE BACKUP IN THE VOLUME — and one that fails leaves the volume as it was', POSIX_ONLY, () => {
  // Unpacked over what was there, a SQLite -wal left from before was replayed onto the
  // restored database, and a refill failing part-way left old and new mixed — under a report
  // telling the admin those apps had kept "whatever data was already on this machine".
  const vol = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-vol-'));
  fs.writeFileSync(path.join(vol, 'db.sqlite'), 'live');
  fs.writeFileSync(path.join(vol, 'db.sqlite-wal'), 'pages newer than the backup');
  fs.mkdirSync(path.join(vol, 'old-uploads'));
  fs.writeFileSync(path.join(vol, 'old-uploads', 'x.png'), 'png');
  const before = tree(vol);
  const archive = volumeArchive({ 'db.sqlite': 'restored', 'uploads/a.txt': 'a', '.hidden': 'h' }, 0o750);
  const refill = (input: Buffer) => spawnSync('sh', ['-c', restore.VOLUME_REFILL, 'sh', vol], { input, encoding: 'utf8' });

  const cut = refill(archive.subarray(0, archive.length - 20));
  assert.notEqual(cut.status, 0, 'a cut-off archive was taken as whole');
  assert.deepEqual(tree(vol), before, 'a refill that failed changed the data');

  const whole = refill(archive);
  assert.equal(whole.status, 0, whole.stderr);
  assert.deepEqual(
    tree(vol),
    { 'db.sqlite': 'restored', 'uploads/': '', 'uploads/a.txt': 'a', '.hidden': 'h' },
    'the old data was left beside the backup',
  );
  assert.equal(fs.statSync(vol).mode & 0o777, 0o750, "the volume's own mode is not the backup's");
});

test('A BACKUP WHOSE APP DATA WOULD FILL THE DISK IS REFUSED — before any app is stopped', POSIX_ONLY, async () => {
  // Volume archives were counted at their COMPRESSED size: a well-compressing one passed,
  // then filled the disk while it was unpacked, after the settings and apps were replaced.
  const docker = standIn('docker');
  // 4 MiB of zeros: a few KB in the backup, 4 MiB once unpacked — on a disk with 2 MiB free.
  uploadBackup({ 'volumes/omos-donations_data.tar.gz': volumeArchive({ 'db.sqlite': Buffer.alloc(4 * 1024 * 1024) }) });
  const realStatfs = fs.statfsSync;
  fs.statfsSync = (() => ({ bsize: 1024, bavail: 2048 })) as unknown as typeof fs.statfsSync;
  try {
    const lines: string[] = [];
    assert.equal(await restore.runRestore((l) => lines.push(l)), 'unchanged', lines.join(' | '));
    assert.ok(lines.some((l) => /too large to restore safely/.test(l)), lines.join(' | '));
    assert.doesNotMatch(docker.log(), /\bstop\b|volume create/, 'apps were stopped or data replaced for a backup that could not fit');
  } finally {
    fs.statfsSync = realStatfs;
    fs.rmSync(restore.RESTORE_PATH, { force: true });
    docker.restore();
  }
});

test('APP DATA THAT UNPACKS PAST 8 GiB STILL RESTORES WHEN THE DISK HAS ROOM', POSIX_ONLY, async () => {
  // The 8 GiB ceiling guards the upload itself (a small file that balloons). Applied to the
  // app data inside as well, it refused every larger install's backup with plenty of disk free.
  const realTar = spawnSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).stdout.trim();
  const docker = standIn('docker');
  uploadBackup({ 'volumes/omos-donations_data.tar.gz': volumeArchive({ 'db.sqlite': 'x' }) });
  // The volume's archive lists 9 GiB; everything else is the real tar.
  const tar = standIn(
    'tar',
    `case "$1 $2" in "-tzvf "*omos-donations_data.tar.gz) echo "-rw-r--r-- root/root 9663676416 2026-01-01 00:00 ./db.sqlite"; exit 0;; esac\nexec '${realTar}' "$@"`,
  );
  const realStatfs = fs.statfsSync;
  // 100 GiB free.
  fs.statfsSync = (() => ({ bsize: 1024, bavail: 100 * 1024 * 1024 })) as unknown as typeof fs.statfsSync;
  try {
    const lines: string[] = [];
    await restore.runRestore((l) => lines.push(l));
    assert.ok(!lines.some((l) => /too large to restore safely/.test(l)), lines.join(' | '));
    assert.match(docker.log(), /volume create .*omos-donations_data/, 'the app data was not put back');
  } finally {
    fs.statfsSync = realStatfs;
    fs.rmSync(restore.RESTORE_PATH, { force: true });
    tar.restore();
    docker.restore();
  }
});

test('THE UPLOADED BACKUP IS NOT UNPACKED AGAIN JUST TO MEASURE IT', POSIX_ONLY, async () => {
  const realTar = spawnSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).stdout.trim();
  const docker = standIn('docker');
  uploadBackup({ 'volumes/omos-donations_data.tar.gz': volumeArchive({ 'db.sqlite': 'x' }) });
  const tar = standIn('tar', `exec '${realTar}' "$@"`);
  try {
    assert.equal(await restore.quickCheckArchive(), null); // the upload's own check
    assert.equal(await restore.runRestore(() => undefined), 'restarting');
    const listings = tar
      .log()
      .split('\n')
      .filter((l) => l.startsWith('-tz') && l.includes('.restore.tar.gz'));
    assert.equal(listings.length, 1, tar.log());
  } finally {
    tar.restore();
    docker.restore();
  }
});

test(
  'AN OFF-SITE BACKUP WHOSE RCLONE GIVES UP ENDS — it hung, and every backup and restore after it was refused',
  { ...POSIX_ONLY, timeout: 30_000 },
  async () => {
    const docker = standIn('docker'); // no app volumes
    const rclone = standIn('rclone', 'exit 1'); // a wrong NAS password: refused before reading a byte
    fs.writeFileSync(path.join(CONFIG, 'rclone.conf'), '[omosbackup]\ntype = sftp\n');
    settings.updateBackups({ configured: true, remotePath: 'Backups' });
    // More than the pipes between tar, the core and rclone hold, so tar must wait for a reader.
    const filler = path.join(CONFIG, 'filler.bin');
    fs.writeFileSync(filler, crypto.randomBytes(4 * 1024 * 1024));
    try {
      const run = await Promise.race([offsite.runBackup(), sleep(20_000).then(() => null)]);
      assert.ok(run, 'the backup never finished');
      assert.equal(run.ok, false);
      assert.equal(backup.backupInProgress(), false, '"a backup is already running" was left set');
      assert.equal(fs.existsSync(path.join(DATA, '.backup-staging')), false);
      assert.equal(settings.getSettings().backups.lastResult, 'error');
      // Whatever the NAS kept under that name is removed, so no prune counts it as a backup.
      const name = run.name.replace(/\./g, '\\.');
      assert.match(rclone.log(), new RegExp(`^--config \\S+ deletefile omosbackup:Backups/${name}$`, 'm'));
    } finally {
      fs.rmSync(filler, { force: true });
      rclone.restore();
      docker.restore();
    }
  },
);

test('AN OFF-SITE BACKUP REFUSED BECAUSE ANOTHER IS RUNNING IS NOT A FAILED RUN — the next tick tries again', POSIX_ONLY, async () => {
  const docker = standIn('docker');
  const rclone = standIn('rclone');
  fs.writeFileSync(path.join(CONFIG, 'rclone.conf'), '[omosbackup]\ntype = sftp\n');
  settings.updateBackups({ configured: true, remotePath: 'Backups', lastRunAt: '2026-01-01T00:00:00.000Z', lastResult: 'ok' });
  const download = await backup.backupStream(); // a download from the dashboard, still being sent
  try {
    const run = await offsite.runBackup();
    assert.equal(run.ok, false);
    assert.match(run.message, /already running/);
    assert.equal(settings.getSettings().backups.lastRunAt, '2026-01-01T00:00:00.000Z', 'recorded as a run: the next try a whole interval away');
    assert.equal(settings.getSettings().backups.lastResult, 'ok');
    assert.equal(rclone.log(), '', 'rclone was asked to do something for a backup that never started');
  } finally {
    download.stream.destroy();
    await download.done;
    rclone.restore();
    docker.restore();
  }
});

test('A VOLUME THAT CANNOT BE WRITTEN TO STAGING DOES NOT LEAVE ITS CONTAINER RUNNING', POSIX_ONLY, async () => {
  // A staging file that fails (ENOSPC) stopped the reading, so the docker client blocked on a
  // full pipe for ever — and its container with it, the volume still mounted. Every nightly
  // retry leaked another.
  const pidFile = path.join(DATA, 'tar-client.pid');
  const docker = standIn(
    'docker',
    ['case "$*" in', '  "volume ls"*) echo omos-donations_data ;;', `  *"tar -czf"*) echo $$ > '${pidFile}'; exec yes ;;`, 'esac'].join('\n'),
  );
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const realCreate = fs.createWriteStream;
  const full = () =>
    new Writable({
      write: (_chunk, _enc, cb) => cb(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })),
    });
  fs.createWriteStream = full as unknown as typeof fs.createWriteStream;
  let pid = 0;
  try {
    await assert.rejects(backup.backupStream(), /couldn't be saved/);
    fs.createWriteStream = realCreate;
    pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(pid > 0, 'setup: the stand-in client started');
    assert.ok(await until(() => !alive(pid)), 'the client was left blocked on a pipe nobody reads');
    assert.equal(backup.backupInProgress(), false);
  } finally {
    fs.createWriteStream = realCreate;
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    docker.restore();
  }
});

test('A BACKUP CUT OFF BY A RESTART LEAVES NO COPY OF THE APP DATA BEHIND', () => {
  const staging = path.join(DATA, '.backup-staging', 'volumes');
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'omos-donations_data.tar.gz'), 'every family on the roll');
  backup.removeBackupLeftovers();
  assert.equal(fs.existsSync(path.join(DATA, '.backup-staging')), false);
  backup.removeBackupLeftovers(); // nothing there is fine
  // …and it runs at boot, as the restore's does.
  const index = fs.readFileSync(path.join(__dirname, '../src/index.ts'), 'utf8');
  assert.match(index.slice(index.indexOf('async function main')), /removeBackupLeftovers\(\);/);
});

test('THE CORE IS NOT UPDATED UNDER A BACKUP BEING MADE — it would be cut off, an off-site one left half-uploaded', POSIX_ONLY, async () => {
  const docker = standIn('docker');
  const download = await backup.backupStream();
  try {
    const lines: string[] = [];
    assert.equal(await runUpdate((l) => lines.push(l)), 'unchanged');
    assert.ok(
      lines.includes('A backup is being made right now. Please update OpenMasjidOS once it has finished. Nothing was changed.'),
      lines.join(' | '),
    );
    assert.doesNotMatch(docker.log(), /^pull /m, 'something was downloaded for an update that could not go ahead');
  } finally {
    download.stream.destroy();
    await download.done;
    docker.restore();
  }
  // Asked again after the download, which can take minutes: a backup may start meanwhile.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'docker', 'update.ts'), 'utf8');
  const body = src.slice(src.indexOf('async function runUpdateInner'));
  const again = body.lastIndexOf('if (backupInTheWay(onLine))');
  assert.ok(again > body.indexOf("streamSpawn('docker', ['pull'"), 'not asked after the download');
  assert.ok(again < body.indexOf('recreateCore(onLine, tag)'), 'asked only once the core was being replaced');
});

test('AN UPDATE WHOSE COMPOSE FILE CANNOT NAME THE NEW VERSION CHANGES NOTHING — it restarted onto the old build', POSIX_ONLY, async () => {
  const compose = path.join(DATA, 'docker-compose.yml');
  const noImageLine = 'services:\n  core:\n    build: .\n';
  fs.writeFileSync(compose, noImageLine);
  const docker = standIn('docker');
  try {
    assert.equal(await recreateCore(() => undefined, '0.51.2-dev.99'), false);
    assert.doesNotMatch(docker.log(), /^run -d/m, 'the core was recreated on the build it was already running');
    assert.equal(fs.readFileSync(compose, 'utf8'), noImageLine);
  } finally {
    docker.restore();
    fs.rmSync(compose, { force: true });
  }
});

test("SETTINGS → NETWORK SHOWS THE MACHINE'S ADDRESS — not the container's 172.x and id", () => {
  process.env.OPENMASJID_HOST_IP = '192.168.1.24';
  try {
    assert.deepEqual(networkInfo(), { localDomain: '', addresses: ['192.168.1.24'] });
  } finally {
    delete process.env.OPENMASJID_HOST_IP;
  }
});

// ── the File Explorer's upload and download ─────────────────────────────────

async function filesServer() {
  const app = Fastify();
  await app.register(fastifyMultipart, { limits: { fileSize: 64 } });
  registerFiles(app);
  await app.ready();
  return app;
}
function signedIn(): Record<string, string> {
  const s = sessions.createSession('admin', sessions.currentCredential());
  return { cookie: `${sessions.COOKIE_NAME}=${s.token}`, [sessions.CSRF_HEADER]: s.csrf };
}
function multipart(filename: string, body: string) {
  const boundary = 'omos-test-boundary';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n${body}\r\n--${boundary}--\r\n`,
    ),
  };
}

test('AN UPLOAD THAT DOES NOT FINISH LEAVES THE FILE IT WOULD HAVE REPLACED AS IT WAS — and says why plainly', async () => {
  const app = await filesServer();
  const notes = path.join(DATA, 'notes.txt');
  fs.writeFileSync(notes, 'khutbah notes');
  fs.mkdirSync(path.join(DATA, 'Bulletins'), { recursive: true });
  const upload = (filename: string, body: string) => {
    const form = multipart(filename, body);
    return app.inject({ method: 'POST', url: '/api/files/upload?path=/', headers: { ...signedIn(), ...form.headers }, payload: form.payload });
  };
  try {
    // Over the size limit: refused — and the file it would have replaced was already emptied.
    let res = await upload('notes.txt', 'x'.repeat(200));
    assert.equal(res.statusCode, 413, res.body);
    assert.equal(fs.readFileSync(notes, 'utf8'), 'khutbah notes', 'a refused upload destroyed the file it would have replaced');
    // A failure that is not the explorer's own is said in plain words: no raw error, no path.
    res = await upload('Bulletins', 'x');
    assert.equal(res.statusCode, 500, res.body);
    assert.equal((JSON.parse(res.body) as { error: string }).error, 'There is already a folder with that name here.');
    assert.deepEqual(fs.readdirSync(DATA).filter((n) => n.startsWith('.upload-')), [], 'a half-written upload was left behind');
    // And one that finishes replaces it.
    res = await upload('notes.txt', 'new notes');
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(fs.readFileSync(notes, 'utf8'), 'new notes');
  } finally {
    await app.close();
  }
});

test('A DOWNLOADED FILE KEEPS ITS NAME — not "Jumu%27ah%20notes.pdf"', async () => {
  const app = await filesServer();
  fs.writeFileSync(path.join(DATA, "Jumu'ah notes (draft).pdf"), '%PDF');
  fs.writeFileSync(path.join(DATA, 'خطبة.txt'), 'khutbah');
  const download = (name: string) =>
    app.inject({ method: 'GET', url: `/api/files/download?path=${encodeURIComponent(`/${name}`)}`, headers: signedIn() });
  try {
    let res = await download("Jumu'ah notes (draft).pdf");
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(
      res.headers['content-disposition'],
      `attachment; filename="Jumu'ah notes (draft).pdf"; filename*=UTF-8''Jumu%27ah%20notes%20%28draft%29.pdf`,
    );
    res = await download('خطبة.txt');
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers['content-disposition'], `attachment; filename="____.txt"; filename*=UTF-8''${encodeURIComponent('خطبة')}.txt`);
  } finally {
    await app.close();
  }
});
