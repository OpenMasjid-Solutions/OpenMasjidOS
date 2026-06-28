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

/** Named Docker volumes that belong to installed apps (compose project omos-*),
 *  excluding OpenMasjidOS's own infra (e.g. the Cloudflare tunnel). */
async function appVolumeNames(): Promise<string[]> {
  const res = await sh('docker', ['volume', 'ls', '--filter', 'label=com.docker.compose.project', '--format', '{{.Name}}']);
  if (res.code !== 0) return [];
  return res.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((n) => n.startsWith('omos-') && !n.startsWith('omos-cloudflared'));
}

/** Tar one volume's contents into outFile via a throwaway container. Best-effort. */
function tarVolume(vol: string, outFile: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['run', '--rm', '-v', `${vol}:/from:ro`, VOL_IMAGE, 'tar', '-czf', '-', '-C', '/from', '.']);
    const out = fs.createWriteStream(outFile);
    let err = '';
    child.stdout.pipe(out);
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', () => resolve(false));
    child.on('close', (code) => {
      out.close();
      if (code !== 0) {
        log.warn(`Backup: could not archive volume ${vol}: ${err.trim().split('\n').pop() || `exit ${code}`}`);
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

/** Stage every app volume into STAGING/volumes/. Returns true if any were staged. */
async function stageVolumes(): Promise<boolean> {
  try {
    fs.rmSync(STAGING, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  const vols = await appVolumeNames();
  if (vols.length === 0) return false;
  const dir = path.join(STAGING, 'volumes');
  fs.mkdirSync(dir, { recursive: true });
  let any = false;
  for (const v of vols) {
    if (await tarVolume(v, path.join(dir, `${v}.tar.gz`))) any = true;
  }
  return any;
}

/**
 * Produce a tar.gz stream of config/ + apps/ + each app's volume data. Stages
 * volumes first (async), then streams; the staging dir is removed when the stream
 * ends. Returns the tar child's stdout (the caller pipes it to the reply / rclone).
 */
export async function backupStream(): Promise<Readable> {
  const targets: string[] = [];
  for (const dir of ['config', 'apps']) {
    if (fs.existsSync(`${DATA_DIR}/${dir}`)) targets.push(dir);
  }

  let haveVolumes = false;
  try {
    haveVolumes = await stageVolumes();
  } catch (err) {
    log.warn('Backup: volume staging failed; archiving config + apps only.', err);
  }

  const args = ['-czf', '-', '-C', DATA_DIR, ...(targets.length > 0 ? targets : ['.'])];
  if (haveVolumes) args.push('-C', STAGING, 'volumes');

  const child = spawn('tar', args);
  const cleanup = () => {
    try {
      fs.rmSync(STAGING, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };
  child.on('close', cleanup);
  child.stdout.on('error', cleanup);
  return child.stdout as Readable;
}

/** A friendly, sortable default filename for the download. */
export function backupFilename(): string {
  const d = new Date().toISOString().slice(0, 10);
  return `openmasjidos-backup-${d}.tar.gz`;
}
