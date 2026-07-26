// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Backup = a gzipped tar of platform config + per-app data, streamed straight to
 * the browser (CLAUDE.md §13.3). Read-only, so it can never harm a running app.
 *
 * IMPORTANT: apps keep their real data in named Docker VOLUMES (e.g. a SQLite db
 * at `data:/data`), which live in Docker's storage — NOT under the data dir. So
 * tarring `config/` + `apps/` alone misses every app's data. We therefore also
 * stage each app volume (a throwaway container tars its contents) into a temp dir
 * and fold it into the archive under `volumes/<name>.tar.gz`. Restore recreates
 * those volumes (system/restore.ts). Result: settings, Stripe/Cloudflare creds
 * (config/) AND all app data (volumes/) are captured and restorable.
 *
 * A BACKUP THAT SILENTLY LOST DATA IS WORSE THAN A BACKUP THAT FAILED. Two rules
 * follow, and both are load-bearing (a partial archive that reports success is
 * how the off-site retention prune evicts the last good copy):
 *   1. Any volume we cannot archive fails the WHOLE backup, and its truncated
 *      staging file is deleted rather than folded into the archive.
 *   2. The outer tar's exit code is reported through `BackupHandle.done`, and a
 *      non-zero exit destroys the stream so no consumer can mistake a truncated
 *      archive for a complete one.
 * Callers MUST await `done` and treat `ok === false` as "there is no backup":
 * never record success, and never prune older archives, on a failed run.
 *
 * KNOWN, UNFIXED, AND NOT DETECTABLE HERE: volumes are tarred while the app is
 * running, so an app using SQLite in WAL mode can be captured mid-checkpoint —
 * a `db` newer than its `-wal`, or a main file torn by a checkpoint that landed
 * between two tar reads. Note carefully what that means for the rules above:
 * **tar exits 0 on a torn capture**, because tar read every byte it was asked
 * for and nothing failed. So `BackupResult.ok` CANNOT see this class of damage,
 * and a `ok: true` backup is not by itself proof the databases inside it will
 * open. The rules above make *detectable* failures loud; they do not make the
 * archive byte-consistent.
 *
 * The real fix is app-side and is being done there: each app snapshots its own
 * SQLite with `VACUUM INTO` (or the backup API) so the volume always contains a
 * byte-consistent copy no matter when tar runs. The platform cannot do this for
 * an app — it has no idea which files in a volume are databases, nor a safe way
 * to open them. Do not "solve" it here by adding a plausible-looking check; it
 * would only move the false confidence somewhere harder to see.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { DATA_DIR } from '../config';
import { log } from '../logger';

const STAGING = path.join(DATA_DIR, '.backup-staging');
// A tiny image with `tar` to copy volume contents in/out. Pulled once; override
// for offline/air-gapped installs that pre-load a different tar-capable image.
const VOL_IMAGE = process.env.OPENMASJID_BACKUP_IMAGE ?? 'alpine';

function sh(cmd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args);
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.on('error', () => resolve({ code: -1, stdout }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout }));
  });
}

/** Raised when a second backup starts while one is already running. The two would
 *  share the single fixed staging path and corrupt each other's archive. */
export class BackupBusyError extends Error {
  constructor() {
    super('A backup is already running. Please wait for it to finish and try again.');
    this.name = 'BackupBusyError';
  }
}

/** How the archive ended. `ok: false` means THERE IS NO USABLE BACKUP. */
export interface BackupResult {
  ok: boolean;
  /** Friendly reason when ok is false; empty on success. */
  message: string;
}

export interface BackupHandle {
  /** The gzipped tar. Destroyed with an error if the archive fails to complete. */
  stream: Readable;
  /** Resolves once the archive is finished. Never treat a run as successful —
   *  and never prune older archives — until this resolves with `ok: true`. */
  done: Promise<BackupResult>;
}

/** Only one backup at a time: manual download and the scheduler share STAGING. */
let running = false;

function cleanupStaging(): void {
  try {
    fs.rmSync(STAGING, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Named Docker volumes that belong to installed apps (compose project omos-*),
 *  excluding OpenMasjidOS's own infra (e.g. the Cloudflare tunnel). `ok: false`
 *  means we could not ASK Docker — very different from "there are none", since
 *  treating it as "none" would quietly produce a backup with no app data. */
async function appVolumeNames(): Promise<{ ok: boolean; names: string[] }> {
  const res = await sh('docker', ['volume', 'ls', '--filter', 'label=com.docker.compose.project', '--format', '{{.Name}}']);
  if (res.code !== 0) return { ok: false, names: [] };
  return {
    ok: true,
    names: res.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((n) => n.startsWith('omos-') && !n.startsWith('omos-cloudflared')),
  };
}

/** Tar one volume's contents into outFile via a throwaway container. Returns an
 *  error message on failure (and removes the truncated file, so a half-written
 *  archive can never be folded into the backup and restored over good data). */
function tarVolume(vol: string, outFile: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['run', '--rm', '-v', `${vol}:/from:ro`, VOL_IMAGE, 'tar', '-czf', '-', '-C', '/from', '.']);
    const out = fs.createWriteStream(outFile);
    let err = '';
    let settled = false;
    // Wait for BOTH the container to exit AND the file to be flushed to disk;
    // resolving on the child alone can leave the last chunk unwritten.
    let code: number | null = null;
    let closed = false;

    const finish = () => {
      if (settled || !closed || code === null) return;
      settled = true;
      if (code === 0) return resolve(null);
      const why = err.trim().split('\n').pop() || `exit ${code}`;
      log.warn(`Backup: could not archive volume ${vol}: ${why}`);
      try {
        fs.rmSync(outFile, { force: true });
      } catch {
        /* best effort — the whole staging dir is removed anyway */
      }
      resolve(why);
    };

    child.stdout.pipe(out);
    child.stderr.on('data', (d) => (err += d.toString()));
    out.on('close', () => {
      closed = true;
      finish();
    });
    out.on('error', (e) => {
      err += String(e.message);
      closed = true;
      code ??= -1;
      finish();
    });
    child.on('error', (e) => {
      err += String(e.message);
      code = -1;
      out.destroy();
    });
    child.on('close', (c) => {
      code = c ?? -1;
      finish();
    });
  });
}

/** Stage every app volume into STAGING/volumes/. Throws if the app data could not
 *  be captured in full — an incomplete backup must never look like a good one. */
async function stageVolumes(): Promise<{ any: boolean }> {
  cleanupStaging();
  const { ok, names } = await appVolumeNames();
  if (!ok) {
    throw new Error("We couldn't ask Docker which app data to save, so the backup was stopped rather than saved without it.");
  }
  if (names.length === 0) return { any: false };
  const dir = path.join(STAGING, 'volumes');
  fs.mkdirSync(dir, { recursive: true });
  const failed: string[] = [];
  for (const v of names) {
    if (await tarVolume(v, path.join(dir, `${v}.tar.gz`))) failed.push(v);
  }
  if (failed.length > 0) {
    throw new Error(
      `Some app data couldn't be saved (${failed.join(', ')}), so the backup was stopped — an incomplete backup is not safe to rely on.`,
    );
  }
  return { any: true };
}

/**
 * Produce a tar.gz stream of config/ + apps/ + each app's volume data. Stages
 * volumes first (async), then streams; the staging dir is removed when the stream
 * ends. Throws BackupBusyError if one is already running, or a friendly Error if
 * the app data couldn't be staged in full (nothing is streamed in that case).
 */
export async function backupStream(): Promise<BackupHandle> {
  if (running) throw new BackupBusyError();
  running = true;

  let haveVolumes = false;
  try {
    haveVolumes = (await stageVolumes()).any;
  } catch (err) {
    cleanupStaging();
    running = false;
    throw err;
  }

  const targets: string[] = [];
  for (const dir of ['config', 'apps']) {
    if (fs.existsSync(`${DATA_DIR}/${dir}`)) targets.push(dir);
  }
  const args = ['-czf', '-', '-C', DATA_DIR, ...(targets.length > 0 ? targets : ['.'])];
  if (haveVolumes) args.push('-C', STAGING, 'volumes');

  const child = spawn('tar', args);
  const stream = child.stdout as Readable;

  let settled = false;
  const done = new Promise<BackupResult>((resolve) => {
    const finish = (result: BackupResult) => {
      if (settled) return;
      settled = true;
      cleanupStaging();
      running = false;
      if (!result.ok) {
        log.warn(`Backup failed: ${result.message}`);
        // Break the stream so a consumer (the browser download, rclone) sees a
        // failure instead of quietly accepting a truncated archive.
        stream.destroy(new Error(result.message));
      }
      resolve(result);
    };
    child.on('error', (e) =>
      finish({ ok: false, message: `The backup could not be created: ${e.message}` }),
    );
    child.on('close', (code) =>
      finish(
        code === 0
          ? { ok: true, message: '' }
          : { ok: false, message: `The backup file did not finish writing (tar exited ${code}).` },
      ),
    );
  });

  return { stream, done };
}

/** A friendly, sortable default filename for the download. */
export function backupFilename(): string {
  const d = new Date().toISOString().slice(0, 10);
  return `openmasjidos-backup-${d}.tar.gz`;
}
