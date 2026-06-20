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
import { DATA_DIR } from '../config';
import { streamSpawn, recreateCore } from '../docker/update';
import { reupAllApps } from '../apps/manager';

export const RESTORE_PATH = path.join(DATA_DIR, '.restore.tar.gz');
const STAGING_DIR = path.join(DATA_DIR, '.restore-staging');
const ALLOWED_TOP = new Set(['config', 'apps']);

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

/** Cheap sanity check at upload time: is this a readable, non-empty gzip tar?
 *  This is NOT a security check — that happens at restore time on the real
 *  extracted files. Returns an error message, or null. */
export async function quickCheckArchive(): Promise<string | null> {
  if (!fs.existsSync(RESTORE_PATH)) return 'No backup file was uploaded.';
  const res = await capture('tar', ['-tzf', RESTORE_PATH]);
  if (res.code !== 0) return "That file isn't a valid backup archive.";
  if (res.out.split('\n').some((l) => l.trim())) return null;
  return 'That backup is empty.';
}

/** Validate the REAL extracted tree: only config/ + apps/ at the top, and no
 *  symlinks or special files anywhere. Returns an error message, or null. */
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

/** Extract the backup, validate the result, move it into place, restart apps,
 *  recreate the core. Streams progress through onLine. */
export async function runRestore(onLine: (s: string) => void): Promise<void> {
  if (!fs.existsSync(RESTORE_PATH)) {
    onLine('No backup file was found. Please upload one and try again.');
    return;
  }

  const cleanup = () => {
    fs.rmSync(STAGING_DIR, { recursive: true, force: true });
    fs.rmSync(RESTORE_PATH, { force: true });
  };

  onLine('Checking your backup…');
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
    cleanup();
    onLine('Restore failed while reading the backup.');
    return;
  }

  const err = validateExtracted(STAGING_DIR);
  if (err) {
    cleanup();
    onLine(err);
    return;
  }

  onLine('Restoring your settings and app data…');
  let moved = 0;
  for (const name of ALLOWED_TOP) {
    const src = path.join(STAGING_DIR, name);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(DATA_DIR, name);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(src, dest); // same filesystem → atomic
    moved++;
  }
  cleanup();
  if (moved === 0) {
    onLine('That backup had nothing to restore.');
    return;
  }

  onLine('');
  onLine('Starting your apps…');
  await reupAllApps(onLine);

  onLine('');
  onLine('Finishing up and restarting OpenMasjidOS…');
  if (!(await recreateCore(onLine))) {
    onLine('Restore finished, but the dashboard could not restart on its own. Re-run the installer if needed.');
    return;
  }
  onLine('The dashboard is restarting now — this page will reconnect automatically.');
}
