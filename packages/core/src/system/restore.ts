// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Restore from a backup tarball (the counterpart to system/backup.ts).
 *
 * Security: we do NOT trust the archive. Rather than parse `tar` listings (which
 * can be fooled by newlines in entry names), we extract into a fresh, empty
 * STAGING dir and then validate the REAL extracted filesystem with lstat —
 * rejecting symlinks/special files and any top-level entry that isn't `config/`
 * or `apps/`. Only after that do we move the validated trees into place. A
 * malicious archive therefore can never escape the data dir (CLAUDE.md §15).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, DATA_DIR } from '../config';
import { streamSpawn, recreateCore } from '../docker/update';
import { reupAllApps, reviewEveryApp, stopAllApps, invalidateFabricIndex, listMetaSummaries } from '../apps/manager';
import { reloadSettings } from '../settings/store';
import { reloadEmailConfig } from '../store/email';
import { reloadStripeConfig } from '../store/stripe';
import { reloadWhatsAppConfig } from '../store/whatsapp';
import { reloadCommandConfig } from '../store/commands';
import { reloadAlertChannels } from '../notify/alerts';
import { endAllSessionsAtNextBoot, rebindRemoteSession, remoteGrantOf } from '../auth/sessions';
import { getPasswordHash, holdForRestore } from '../auth/store';
import { holdSecondFactorEpoch, renewSecondFactorEpoch, sameSecondFactorAs } from '../auth/twofactor';
import { readJson, writeJson } from '../util/json-store';
import { log } from '../logger';
import { tunnelTokenMatches } from './cloudflared';
import { settingsOpenTheDoor } from './remote-admin';
import { HOLD_UNTIL_REPLACED_MS, finishing, withUpdateLock, isUpdating, UpdateBusyError } from './update-lock';
import { backupInProgress } from './backup';

/** While a backup is being made it is copying the very data a restore would replace. */
export const BACKUP_RUNNING = 'A backup is being made right now. Please restore once it has finished. Nothing was changed.';

export const RESTORE_PATH = path.join(DATA_DIR, '.restore.tar.gz');
const STAGING_DIR = path.join(DATA_DIR, '.restore-staging');
const ALLOWED_TOP = new Set(['config', 'apps', 'volumes']);
// Must match system/backup.ts — the image used to copy data into a Docker volume.
const VOL_IMAGE = process.env.OPENMASJID_BACKUP_IMAGE ?? 'alpine';
// Hard ceiling on the DECOMPRESSED size, so a small but highly-compressible
// archive (a gzip bomb) can't balloon to fill the data disk and take the
// platform offline (security audit).
const MAX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024 * 1024; // 8 GiB

function capture(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args);
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('error', () => resolve({ code: -1, out }));
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
  });
}

const TOO_LARGE = 'That backup is too large to restore safely (it would fill the disk).';

/** What `tar -tzvf` lists in an archive: its lines, and the sizes they add up to (the 3rd
 *  whitespace field, for GNU and busybox tar alike). `ok` is false when tar could not read it all. */
async function listArchive(file: string): Promise<{ ok: boolean; entries: number; bytes: number }> {
  const res = await capture('tar', ['-tzvf', file]);
  let entries = 0;
  let bytes = 0;
  for (const line of res.out.split('\n')) {
    if (!line.trim()) continue;
    entries++;
    const size = Number(line.trim().split(/\s+/)[2]);
    if (Number.isFinite(size) && size > 0) bytes += size;
  }
  return { ok: res.code === 0, entries, bytes };
}

/** The upload's listing, kept so the restore need not unpack it once more to measure it.
 *  Keyed on the file's size and time: a new upload is measured anew. */
let uploadListing: { size: number; mtimeMs: number; bytes: number } | null = null;

/** Cheap sanity check at upload time: is this a readable, non-empty gzip tar?
 *  This is NOT a security check — that happens at restore time on the real
 *  extracted files. Returns an error message, or null. */
export async function quickCheckArchive(): Promise<string | null> {
  if (!fs.existsSync(RESTORE_PATH)) return 'No backup file was uploaded.';
  const { size, mtimeMs } = fs.statSync(RESTORE_PATH);
  const listing = await listArchive(RESTORE_PATH);
  if (!listing.ok) return "That file isn't a valid backup archive.";
  if (listing.entries === 0) return 'That backup is empty.';
  uploadListing = { size, mtimeMs, bytes: listing.bytes };
  return null;
}

/** What the uploaded backup unpacks to. A listing that fails counts nothing: the
 *  extraction then fails and says so. */
async function uploadedBytes(): Promise<number> {
  const { size, mtimeMs } = fs.statSync(RESTORE_PATH);
  if (uploadListing?.size === size && uploadListing.mtimeMs === mtimeMs) return uploadListing.bytes;
  const listing = await listArchive(RESTORE_PATH);
  return listing.ok ? listing.bytes : 0;
}

/** 90% of the data disk's free space right now — Infinity when it cannot be read. */
function freeSpaceCap(): number {
  try {
    const st = fs.statfsSync(DATA_DIR);
    return Math.floor(st.bsize * st.bavail * 0.9);
  } catch {
    return Infinity; // statfs unavailable: the hard ceiling alone guards the upload
  }
}

/** The most the uploaded backup may unpack to: the hard ceiling, or the free space if less. */
function restoreCap(): number {
  return Math.min(MAX_UNCOMPRESSED_BYTES, freeSpaceCap());
}

/** Validate the REAL extracted tree: only config/, apps/ or volumes/ at the top,
 *  and no symlinks or special files anywhere. Returns an error message, or null. */
function validateExtracted(root: string): string | null {
  let top: fs.Dirent[];
  try {
    top = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return "That backup couldn't be read.";
  }
  if (top.length === 0) return 'That backup is empty.';

  const stack: string[] = [];
  for (const e of top) {
    if (!ALLOWED_TOP.has(e.name)) {
      return 'That backup contains unexpected files and was rejected for safety.';
    }
    const full = path.join(root, e.name);
    if (!fs.lstatSync(full).isDirectory()) {
      return 'That backup is not in the expected format.';
    }
    stack.push(full);
  }

  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, e.name);
      const st = fs.lstatSync(full); // lstat: never follow links
      if (st.isSymbolicLink()) return 'That backup contains links and was rejected for safety.';
      if (st.isDirectory()) {
        stack.push(full);
      } else if (!st.isFile()) {
        return 'That backup contains special files and was rejected for safety.';
      }
    }
  }
  return null;
}

/**
 * The app-volume archives in a backup that a restore would actually put back: regular
 * `.tar.gz` files named for an app's volume, never the platform's own (cloudflared).
 * One list for the "is there anything here?" check and for the work itself, so the two
 * can never disagree about what a backup holds.
 */
function stagedVolumeArchives(volDir: string): string[] {
  try {
    return fs
      .readdirSync(volDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.tar.gz'))
      .map((e) => e.name)
      .filter((f) => {
        const vol = f.replace(/\.tar\.gz$/, '');
        return /^omos-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(vol) && !vol.startsWith('omos-cloudflared');
      });
  } catch {
    return []; // no volumes/ in this backup (older format)
  }
}

/** What the app-data archives in a backup unpack to, from what tar can list — of one it
 *  cannot read to the end too: its refill fails, but may unpack that much first. */
async function stagedVolumeBytes(volDir: string): Promise<number> {
  let total = 0;
  for (const f of stagedVolumeArchives(volDir)) total += (await listArchive(path.join(volDir, f))).bytes;
  return total;
}

/** The labels compose gives a volume it makes (`omos-donations_data` is project
 *  `omos-donations`'s volume `data`), so one a restore makes is no different. */
function composeVolumeLabels(vol: string): string[] {
  const m = /^(omos-[a-z0-9-]+)_(.+)$/.exec(vol);
  return m ? ['--label', `com.docker.compose.project=${m[1]}`, '--label', `com.docker.compose.volume=${m[2]}`] : [];
}

/** Refill a volume (`$1`) from the archive on stdin into a fresh folder, swapped in only once tar
 *  has succeeded: unpacked over the old data, a stale SQLite `-wal` was replayed onto the restored
 *  database, and a failure part-way left old and new mixed. */
export const VOLUME_REFILL = [
  'new=$(mktemp -d "$1/.omos-restore.XXXXXX") || exit 1',
  // The volume's own owner and mode, unless the archive brings its own ("./").
  'chown "$(stat -c %u:%g "$1")" "$new"; chmod "$(stat -c %a "$1")" "$new"',
  'if ! tar -xzf - -C "$new"; then rm -rf "$new"; exit 1; fi',
  'for f in "$1"/* "$1"/.[!.]* "$1"/..?*; do if [ "$f" != "$new" ] && { [ -e "$f" ] || [ -L "$f" ]; }; then rm -rf "$f" || exit 1; fi; done',
  'for f in "$new"/* "$new"/.[!.]* "$new"/..?*; do if [ -e "$f" ] || [ -L "$f" ]; then mv "$f" "$1"/ || exit 1; fi; done',
  'chown "$(stat -c %u:%g "$new")" "$1"; chmod "$(stat -c %a "$new")" "$1"; rmdir "$new"',
].join('; ');

/** Recreate each app's Docker volume from volumes/<name>.tar.gz and refill it via
 *  a throwaway container. Best-effort per volume so one bad entry can't abort the
 *  whole restore — but every failure is REPORTED, both per-volume and in the
 *  summary, so "restore finished" can never mean "your app data didn't come back". */
async function restoreVolumes(
  volDir: string,
  onLine: (s: string) => void,
): Promise<{ restored: number; failed: string[] }> {
  const files = stagedVolumeArchives(volDir);
  if (files.length === 0) return { restored: 0, failed: [] };

  onLine('');
  onLine('Restoring app data…');
  let restored = 0;
  const failed: string[] = [];
  for (const f of files) {
    const vol = f.replace(/\.tar\.gz$/, '');
    onLine(`• ${vol}`);
    await capture('docker', ['volume', 'create', ...composeVolumeLabels(vol), vol]);
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn('docker', ['run', '--rm', '-i', '-v', `${vol}:/to`, VOL_IMAGE, 'sh', '-c', VOLUME_REFILL, 'sh', '/to']);
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
      // A file that cannot be read fails THIS volume. With no handler, its error went
      // to the process-wide handler, stdin was never ended, and `tar -xzf -` waited
      // for the rest of an archive that was never coming — the whole restore hung
      // with every app it had stopped still down.
      child.stdin.on('error', () => {});
      const src = fs.createReadStream(path.join(volDir, f));
      src.on('error', () => {
        // End tar's INPUT: a truncated archive makes it exit non-zero, which fires
        // 'close'. A signal alone does not — `docker run -i` forwards SIGTERM to the
        // container, where tar runs as PID 1 with no handler and ignores it. SIGKILL
        // ends the client if nothing else has.
        child.stdin.end();
        setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
      });
      src.pipe(child.stdin);
    });
    if (ok) {
      restored++;
    } else {
      failed.push(vol);
      onLine(`  (couldn't restore ${vol})`);
    }
  }
  return { restored, failed };
}

const RESTORE_BUSY = 'A restore is already running. It will finish on its own — please wait for it.';

/**
 * How a restore ended, so the progress window can say so rather than guess.
 *
 * It used to guess: when the stream ended it assumed the core was restarting, waited
 * four minutes for that, and then announced "Restore complete" — after a restore that
 * had been REFUSED and changed nothing, which is the common case from outside.
 *  - 'restarting'    the restore ran and the core is being replaced;
 *  - 'restarting-with-problems'
 *                    the same, but some app data could not be put back, or some app
 *                    could not be started. Not "Restore complete.": a masjid moving to a
 *                    new box whose app data all failed was shown exactly that, over the
 *                    lines saying otherwise — and so was one whose donations page did not
 *                    start;
 *  - 'unchanged'     it stopped before touching anything (refused, busy, bad file,
 *                    nothing in it) — no app was stopped either;
 *  - 'not-restarted' it failed part-way, after things had begun to change;
 *  - 'restored-not-restarted'
 *                    everything was put back, but the core could not restart itself to
 *                    finish. Told apart from the last because the advice is opposite: run
 *                    it again there, restart the machine here — and someone told "it
 *                    stopped" would restore again, stopping every app again for nothing.
 */
export type RestoreOutcome =
  | 'restarting'
  | 'restarting-with-problems'
  | 'unchanged'
  | 'not-restarted'
  | 'restored-not-restarted';

/**
 * What went wrong in the last restore, kept for the dashboard to show after the next
 * sign-in (trpc/routers/backups.ts). Written into `config/` after the swap, so the new
 * core finds it; the admin dismisses it. App NAMES, as the window shows them.
 */
export interface RestoreReport {
  at: string;
  appsWithoutData: string[];
  appsNotStarted: string[];
  /** Apps Docker would not stop, so their data was put back under a running app. */
  appsNotPaused: string[];
}
const REPORT_PATH = path.join(CONFIG_DIR, 'restore-report.json');

function writeRestoreReport(r: Omit<RestoreReport, 'at'>): void {
  try {
    writeJson(REPORT_PATH, { at: new Date().toISOString(), ...r });
  } catch (err) {
    log.warn('Restore: could not save the list of apps that need attention.', err);
  }
}

/** The last restore's problems, or null when there were none (or they were dismissed). */
export function readRestoreReport(): RestoreReport | null {
  const r = readJson<Partial<RestoreReport> | null>(REPORT_PATH, null);
  if (!r || typeof r.at !== 'string') return null;
  const names = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    at: r.at,
    appsWithoutData: names(r.appsWithoutData),
    appsNotStarted: names(r.appsNotStarted),
    appsNotPaused: names(r.appsNotPaused),
  };
}

export function dismissRestoreReport(): void {
  try {
    fs.rmSync(REPORT_PATH, { force: true });
  } catch (err) {
    log.warn('Restore: could not clear the list of apps that needed attention.', err);
  }
}

/**
 * The app a Docker volume belongs to, by name where it is known: `omos-donations_data` is
 * Donations' (a compose project is `omos-<app id>`, and app ids never contain "_").
 */
function appOfVolume(vol: string, apps: { id: string; name: string }[]): string {
  const id = /^omos-([a-z0-9-]+)_/.exec(vol)?.[1];
  return apps.find((a) => a.id === id)?.name ?? vol;
}

const REMOTE_RESTORE_OFF =
  'This backup would switch off managing OpenMasjidOS from outside, so restoring it from here would lock you out. Nothing has been changed. Restore it at the masjid instead.';
const REMOTE_RESTORE_CREDENTIALS =
  'This backup has a different password or two-step sign-in from the ones you use now, so restoring it from here could lock you out. Nothing has been changed. Restore it at the masjid instead.';

/**
 * Would restoring this extracted backup lock out an admin who is doing it from
 * OUTSIDE? Null when it would not.
 *
 * A restore replaces `config/` whole, and nothing carries the current remote-access
 * setup across: not the switch, the tunnel token, the password or the second factor. Done at the masjid, that is what restoring means. Done from
 * outside, a backup taken before remote administration was set up — which is most of
 * them, the feature being new — turns the door off behind the admin, and getting back
 * in needs someone in the building. So from outside a restore goes ahead only if the
 * door will still be there afterwards, with the same tunnel, and the same password and
 * second factor to open it with. A backup with no `config/`
 * touches none of that and is never refused here.
 */
export function remoteRestoreProblem(stagingRoot: string): string | null {
  const cfg = path.join(stagingRoot, 'config');
  if (!fs.existsSync(cfg)) return null;
  const read = (rel: string): string | null => {
    try {
      return fs.readFileSync(path.join(cfg, rel), 'utf8');
    } catch {
      return null;
    }
  };
  const json = (rel: string): Record<string, unknown> | null => {
    const text = read(rel);
    if (text === null) return null;
    try {
      const v: unknown = JSON.parse(text);
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };

  const cf = (json('settings.json')?.cloudflare ?? null) as Record<string, unknown> | null;
  // The SAME rule the live box applies (remote-admin.ts `settingsOpenTheDoor`), not a
  // copy of it: a hand-written copy here once missed a condition, and a restore it
  // allowed shut the remote dashboard behind the admin.
  if (!cf || !settingsOpenTheDoor(cf)) return REMOTE_RESTORE_OFF;
  if (!tunnelTokenMatches(read('cloudflare/.env'))) return REMOTE_RESTORE_OFF;

  // An admin who can sign in: a username AND the same password (isConfigured needs both).
  const auth = json('auth.json');
  const theirHash = typeof auth?.passwordHash === 'string' ? auth.passwordHash : null;
  const theirName = typeof auth?.username === 'string' ? auth.username : '';
  const ourHash = getPasswordHash({ fresh: true });
  if (!theirName || !theirHash || !ourHash || theirHash !== ourHash) return REMOTE_RESTORE_CREDENTIALS;
  if (!sameSecondFactorAs(json('twofactor.json'))) return REMOTE_RESTORE_CREDENTIALS;
  return null;
}

/**
 * Remove what an interrupted restore left behind — the uploaded archive (every secret on
 * the box, unencrypted) and the staging copy — at boot, when no restore can be running.
 * A restore cut off by the core being replaced, or by a crash, never reached the
 * `finally` that removes them.
 */
export function removeRestoreLeftovers(): void {
  for (const p of [RESTORE_PATH, STAGING_DIR]) {
    try {
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
        log.warn(`Removed ${path.basename(p)} left behind by a restore that did not finish.`);
      }
    } catch (err) {
      log.warn(`Could not remove ${p}.`, err);
    }
  }
}

/** Is a restore running right now? The upload route refuses while one is, because a
 *  new upload would overwrite the archive the running restore is reading. */
export function restoreInProgress(): boolean {
  return isUpdating('restore');
}

/**
 * `remote`: started from the remote dashboard (its safety rule, `remoteRestoreProblem`).
 * `callerToken`: the session of whoever started it, kept signed in from outside once the
 * second factor's epoch is renewed (`renewSecondFactorEpoch`).
 */
type RestoreOptions = { remote?: boolean; callerToken?: string | null };

/**
 * Extract the backup, validate the result, move it into place, restart apps,
 * recreate the core. Streams progress through onLine.
 *
 * ONE AT A TIME, enforced here rather than by the dialog. Nothing stopped a second
 * restore: close the progress window, pick a file again, and a second run started
 * over the first — its own start wiped the first's staging directory (so the
 * first's next volume read failed and, before the handler above, hung for ever),
 * and its `finally` released the account store the first was still holding. Same
 * lesson, and the same lock, as system/update-lock.ts: the server is the first line
 * of defence, the locked dialog the second.
 */
export async function runRestore(onLine: (s: string) => void, opts: RestoreOptions = {}): Promise<RestoreOutcome> {
  try {
    // Held past the hand-off to the helper, as a core update's is (system/update-lock.ts).
    return await withUpdateLock('restore', RESTORE_BUSY, () => restoreOnce(onLine, opts), {
      holdAfter: (outcome) =>
        outcome === 'restarting' || outcome === 'restarting-with-problems' ? HOLD_UNTIL_REPLACED_MS : 0,
    });
  } catch (err) {
    // Information, not a failure: calling it "failed" pushes an admin into retrying. Either
    // a restore is already running, or an update is — which would replace the core under
    // this one (system/update-lock.ts `EXCLUSIVE`).
    if (err instanceof UpdateBusyError) {
      onLine(err.message);
      // Refused because OTHER work is under way: the uploaded backup belongs to this
      // refused request, and nothing else would remove it — every secret on the box,
      // unencrypted, left in the data folder. Nor when the last restore has finished and only
      // waits for the core to be replaced: it removed its own file on the way out. Not when a
      // restore is still running: that one is reading it.
      if (err.clash || finishing('restore')) fs.rmSync(RESTORE_PATH, { force: true });
      return 'unchanged';
    }
    throw err;
  }
}

async function restoreOnce(onLine: (s: string) => void, opts: RestoreOptions): Promise<RestoreOutcome> {
  if (!fs.existsSync(RESTORE_PATH)) {
    onLine('No backup file was found. Please upload one and try again.');
    return 'unchanged';
  }

  // A finally guarantees the staging tree + uploaded archive are removed even on
  // a mid-extract failure (e.g. an ENOSPC from a too-large archive), so a failed
  // restore never leaves a partial tree wasting disk.
  let releaseHold: (() => void) | null = null;
  let releaseEpoch: (() => void) | null = null;
  let renewedEpoch: string | null = null;
  try {
    // Not over a backup being made: it would copy the data half replaced, and say it worked.
    if (backupInProgress()) {
      onLine(BACKUP_RUNNING);
      return 'unchanged';
    }
    onLine('Checking your backup…');
    // Measured before anything is unpacked, so a small archive that would balloon (a gzip
    // bomb) cannot fill the data disk and take the platform offline.
    const cap = restoreCap();
    const unpacked = await uploadedBytes();
    if (unpacked > cap) {
      onLine(TOO_LARGE);
      return 'unchanged';
    }
    fs.rmSync(STAGING_DIR, { recursive: true, force: true });
    fs.mkdirSync(STAGING_DIR, { recursive: true });

    // Extract into the fresh staging dir. A fresh empty target means there are no
    // pre-existing symlinks to traverse, and GNU tar refuses absolute/`..` paths.
    const code = await streamSpawn(
      'tar',
      ['-xzf', RESTORE_PATH, '-C', STAGING_DIR, '--no-same-owner', '--no-same-permissions', '--no-overwrite-dir'],
      onLine,
    );
    if (code !== 0) {
      onLine('Restore failed while reading the backup.');
      return 'unchanged';
    }

    const err = validateExtracted(STAGING_DIR);
    if (err) {
      onLine(err);
      return 'unchanged';
    }

    // Is there anything here to put back at all? Decided BEFORE a single app is stopped:
    // this was found out only afterwards, so a backup holding nothing usable (an
    // "app data only" folder built by hand, say) stopped every app, left them stopped —
    // a manually stopped container does not even come back after a reboot — and was
    // then reported as "Nothing was changed".
    const hasTrees = ['config', 'apps'].some((name) => fs.existsSync(path.join(STAGING_DIR, name)));
    if (!hasTrees && stagedVolumeArchives(path.join(STAGING_DIR, 'volumes')).length === 0) {
      onLine('That backup had nothing to restore. Nothing has been changed.');
      return 'unchanged';
    }

    // From outside, only a backup that leaves the way back in where it is
    // (`remoteRestoreProblem`). Checked before anything is stopped or replaced.
    if (opts.remote) {
      const problem = remoteRestoreProblem(STAGING_DIR);
      if (problem) {
        onLine(problem);
        return 'unchanged';
      }
    }

    // The app data in it is still compressed, and its refill unpacks it onto the disk: that
    // has to fit as well. Counted at its compressed size, a well-compressing volume passed,
    // then filled the disk once settings and apps had already been replaced. Against the
    // free space left NOW, after the staging copy — not the 8 GiB ceiling, which is for the
    // upload: a masjid's app data may rightly unpack to more than that.
    if ((await stagedVolumeBytes(path.join(STAGING_DIR, 'volumes'))) > freeSpaceCap()) {
      onLine(TOO_LARGE);
      return 'unchanged';
    }

    // Quiesce first. Refilling a Docker volume underneath a RUNNING container
    // means the app keeps writing to (and serving from) data we are replacing —
    // the reliable way to corrupt a SQLite database mid-restore. Stop them before
    // anything is overwritten; reupAllApps starts them again at the end. This
    // uses the CURRENT on-disk app list, so it must run before apps/ is replaced.
    const notPaused = await stopAllApps(onLine);

    onLine('');
    onLine('Restoring your settings and app data…');
    // From here until this process is replaced, the admin store keeps serving the
    // identity the restore started with, and refuses writes — auth.json does not
    // exist at all between the remove and the rename below (auth/store.ts says why).
    releaseHold = holdForRestore();
    // The second-factor epoch too. The restored twofactor.json can carry an older epoch
    // (any change to the factor since the backup — new backup codes, say), and a remote
    // session is honoured only under the epoch it signed in with: the restoring admin
    // was being signed out MID-restore, their progress window closed by the sweep and
    // every line after it lost. Every session ends at the next boot anyway.
    releaseEpoch = holdSecondFactorEpoch();
    let moved = 0;
    let configMoved = false;
    // config/ + apps/ are filesystem trees moved into the data dir. volumes/ is
    // handled separately (restored into Docker volumes), not moved here.
    for (const name of ['config', 'apps']) {
      const src = path.join(STAGING_DIR, name);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(DATA_DIR, name);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(src, dest); // same filesystem → atomic
      moved++;
      if (name === 'config') configMoved = true;
    }

    // The backup's second factor is now the one on disk, with the BACKUP's epoch. A new
    // one, so that no session from before the restore — a shut-out one included —
    // counts from outside when the hold is released, except the admin doing this one
    // (moved onto it in the finally). auth/twofactor.ts `renewSecondFactorEpoch`.
    if (configMoved) renewedEpoch = renewSecondFactorEpoch();

    // Every app's Fabric key just changed underneath the cache that resolves them.
    // `saveMeta` invalidates that cache on each write, but this replaced `apps/`
    // wholesale without going through it — so the platform went on matching sign-in
    // checks against the PRE-restore keys while the restored apps presented the
    // backup's. Every SSO check then failed as "unrecognised app", and every app
    // asked the admin for its own password, until something else happened to clear
    // the cache. Same symptom as the session bugs in auth/sessions.ts, different door.
    if (moved > 0) invalidateFabricIndex();

    // And this process's own copies of the settings: the restore runs to its end on them,
    // and a write made with the pre-restore copy (a scheduled job, a monitor) put it back
    // over the restored file.
    if (configMoved) {
      reloadSettings();
      reloadEmailConfig();
      reloadStripeConfig();
      reloadWhatsAppConfig();
      reloadCommandConfig();
      reloadAlertChannels();
    }

    // Every restored app's compose is checked NOW, not after its data is back. The verdict
    // in a restored meta.json is the backup's, and until this ran, whatever started an app
    // meanwhile started an unvetted compose (starts are refused during a restore as well —
    // system/update-lock.ts assertAppFree — but this does not depend on that).
    if (moved > 0) reviewEveryApp();

    // And every sign-in session ends — at the NEXT boot, not now. A restore always
    // ended every session when they lived in memory, because it ends by restarting
    // the core. Ending them HERE (the first fix) signed the admin out part-way
    // through, and the dashboard then unmounted the window reporting whether the
    // restore worked. The marker makes the new core start clean instead.
    if (moved > 0) endAllSessionsAtNextBoot();

    // Restore each app's Docker volume (its real data — SQLite db, uploads, …)
    // BEFORE starting apps, so `compose up` finds the populated volumes.
    const { restored: restoredVols, failed: failedVols } = await restoreVolumes(
      path.join(STAGING_DIR, 'volumes'),
      onLine,
    );

    if (moved === 0 && restoredVols === 0 && failedVols.length === 0) {
      // Not reached: the check before the apps were stopped found something to restore.
      // If it ever is, the apps stopped for it must not stay stopped, and it is not
      // "nothing was changed".
      onLine('That backup had nothing to restore.');
      await reupAllApps(onLine);
      return 'not-restarted';
    }

    // Settings restoring while every app's data failed is NOT a successful
    // restore, and must never be reported as one just because config/ moved.
    const apps = listMetaSummaries();
    const withoutData = [...new Set(failedVols.map((vol) => appOfVolume(vol, apps)))];
    if (failedVols.length > 0) {
      onLine('');
      onLine(
        restoredVols === 0
          ? "Your settings were restored, but NONE of your app data could be put back."
          : `Your settings were restored, but some app data could not be put back (${failedVols.length} of ${restoredVols + failedVols.length}).`,
      );
      onLine(`Affected: ${withoutData.join(', ')}`);
      onLine('Those apps will start with whatever data was already on this machine. Please check them before relying on this restore.');
      log.warn(`Restore: app data could not be put back for ${failedVols.join(', ')}.`);
    }

    onLine('');
    onLine('Starting your apps…');
    const notStarted = await reupAllApps(onLine);
    if (notStarted.length > 0) log.warn(`Restore: these apps did not start: ${notStarted.join(', ')}.`);
    const problems = withoutData.length > 0 || notStarted.length > 0 || notPaused.length > 0;
    // The window that says which apps are affected is gone soon after the core restarts
    // (every session ends then, and the dashboard returns to its sign-in), so it is kept
    // for the dashboard to show after the next sign-in (`readRestoreReport`). A restore
    // with nothing to report clears any older one — including one that came back inside
    // the backup's own config/.
    if (problems) writeRestoreReport({ appsWithoutData: withoutData, appsNotStarted: notStarted, appsNotPaused: notPaused });
    else dismissRestoreReport();

    onLine('');
    onLine('Finishing up and restarting OpenMasjidOS…');
    // On the build that is running now, never the channel's alias (docker/update.ts says why).
    if (!(await recreateCore(onLine))) {
      onLine('Restore finished, but the dashboard could not restart on its own. Re-run the installer if needed.');
      return 'restored-not-restarted';
    }
    onLine('The dashboard is restarting now — this page will reconnect automatically.');
    return problems ? 'restarting-with-problems' : 'restarting';
  } finally {
    // Keep whoever started the restore signed in from outside under the new epoch —
    // while both holds still stand, so there is no moment their session does not count.
    // Only if that session STILL counts under the factor as it stood: one shut out by a
    // change to the second factor — made before the restore began, or by another process
    // while it ran, since the dashboard refuses such a change meanwhile — must stay out,
    // not be carried onto the new epoch with it.
    if (renewedEpoch !== null && opts.callerToken && remoteGrantOf(opts.callerToken) !== null) {
      rebindRemoteSession(opts.callerToken, renewedEpoch);
    }
    // Every exit — success (the core is about to be replaced), a failure before the
    // swap (nothing changed), or after it (the restored files are now the truth) —
    // lets the admin store pick up whatever is on disk. Never left held: a held
    // store refuses every account change. Only THIS run's hold, and only if it took
    // one: a run that stopped before the swap has nothing to release.
    releaseHold?.();
    releaseEpoch?.();
    try {
      fs.rmSync(STAGING_DIR, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    try {
      fs.rmSync(RESTORE_PATH, { force: true });
    } catch {
      /* best effort */
    }
  }
}
