// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Scheduled off-site backups via rclone. The backup CONTENT is the same gzipped
 * tar of config + app data as the manual download (system/backup.ts) — here we
 * stream it straight to a remote (Google Drive or a NAS over SFTP/SMB/WebDAV)
 * with `rclone rcat`, on a schedule, pruning to a retention count.
 *
 * Secrets (NAS password / SFTP key / Drive token) live ONLY in the rclone config
 * file under the data dir (chmod 600) and an optional key file — never in
 * settings.json and never in any API response. settings.backups holds only
 * non-secret metadata (kind, label, remote path, schedule, last-run status).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { CONFIG_DIR } from '../config';
import { backupStream } from './backup';
import { getSettings, updateBackups } from '../settings/store';
import { log } from '../logger';

const RCLONE_CONF = path.join(CONFIG_DIR, 'rclone.conf');
const KEY_PATH = path.join(CONFIG_DIR, 'backup-sftp-key');
const REMOTE = 'omosbackup'; // the single rclone remote we manage

export type DestKind = 'drive' | 'sftp' | 'smb' | 'webdav';

export interface DestInput {
  kind: DestKind;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  keyPem?: string; // SFTP private key (alternative to password)
  share?: string; // SMB share name
  url?: string; // WebDAV URL
  vendor?: string; // WebDAV vendor (nextcloud | owncloud | other …)
  driveToken?: string; // Google Drive token JSON from `rclone authorize "drive"`
  folder?: string; // sub-folder on the remote
}

/** rclone obscures stored passwords; turn a plaintext password into that form. */
function obscure(plain: string): string {
  const r = spawnSync('rclone', ['obscure', plain], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error('rclone is not available on this build, so backups can’t be configured.');
  }
  return r.stdout.trim();
}

function capture(args: string[], timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('rclone', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr || e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Build + write the rclone config from guided fields. Returns non-secret metadata.
 *  Throws a friendly Error on bad/missing input. Never returns any secret. */
export function setDestination(input: DestInput): { destKind: DestKind; destLabel: string; remotePath: string } {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const folder = (input.folder?.trim() || 'OpenMasjidOS-Backups').replace(/^\/+|\/+$/g, '');
  const lines = [`[${REMOTE}]`];
  let destLabel = '';
  let remotePath = folder;

  if (input.kind === 'drive') {
    const token = input.driveToken?.trim();
    if (!token) throw new Error('Paste the Google Drive token from `rclone authorize "drive"`.');
    try {
      JSON.parse(token);
    } catch {
      throw new Error('That Google Drive token isn’t valid JSON — copy the whole token line.');
    }
    lines.push('type = drive', `token = ${token}`, 'scope = drive');
    destLabel = 'Google Drive';
  } else if (input.kind === 'sftp') {
    if (!input.host?.trim() || !input.user?.trim()) throw new Error('SFTP host and username are required.');
    lines.push('type = sftp', `host = ${input.host.trim()}`, `user = ${input.user.trim()}`);
    if (input.port) lines.push(`port = ${input.port}`);
    if (input.keyPem?.trim()) {
      fs.writeFileSync(KEY_PATH, input.keyPem.trim() + '\n', 'utf8');
      try {
        fs.chmodSync(KEY_PATH, 0o600);
      } catch {
        /* best effort */
      }
      lines.push(`key_file = ${KEY_PATH}`);
    } else if (input.password) {
      lines.push(`pass = ${obscure(input.password)}`);
    } else {
      throw new Error('Provide an SFTP password or a private key.');
    }
    destLabel = input.host.trim();
  } else if (input.kind === 'smb') {
    if (!input.host?.trim() || !input.share?.trim()) throw new Error('SMB host and share name are required.');
    lines.push('type = smb', `host = ${input.host.trim()}`);
    if (input.user?.trim()) lines.push(`user = ${input.user.trim()}`);
    if (input.password) lines.push(`pass = ${obscure(input.password)}`);
    remotePath = `${input.share.trim().replace(/^\/+|\/+$/g, '')}/${folder}`;
    destLabel = input.host.trim();
  } else if (input.kind === 'webdav') {
    if (!input.url?.trim()) throw new Error('WebDAV URL is required.');
    lines.push('type = webdav', `url = ${input.url.trim()}`, `vendor = ${input.vendor?.trim() || 'other'}`);
    if (input.user?.trim()) lines.push(`user = ${input.user.trim()}`);
    if (input.password) lines.push(`pass = ${obscure(input.password)}`);
    destLabel = input.url.trim();
  } else {
    throw new Error('Unknown backup destination type.');
  }

  fs.writeFileSync(RCLONE_CONF, lines.join('\n') + '\n', 'utf8');
  try {
    fs.chmodSync(RCLONE_CONF, 0o600);
  } catch {
    /* best effort */
  }
  return { destKind: input.kind, destLabel, remotePath };
}

export function clearDestination(): void {
  for (const f of [RCLONE_CONF, KEY_PATH]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Verify the configured remote is reachable + credentials work. */
export async function testRemote(): Promise<{ ok: boolean; message: string }> {
  if (!fs.existsSync(RCLONE_CONF)) return { ok: false, message: 'No backup destination is configured yet.' };
  const r = await capture(['--config', RCLONE_CONF, 'lsd', `${REMOTE}:`], 20_000);
  if (r.code === 0) return { ok: true, message: 'Connected successfully.' };
  return { ok: false, message: lastLine(r.stderr) || 'Could not connect to the destination.' };
}

function lastLine(s: string): string {
  return s.trim().split('\n').filter(Boolean).pop() ?? '';
}

function backupName(now = new Date()): string {
  // Date-time stamp; sortable lexicographically so prune can keep the newest.
  return `openmasjidos-backup-${now.toISOString().replace(/:/g, '-').slice(0, 19)}.tar.gz`;
}

/** Delete remote backups beyond the retention count (newest kept). */
async function pruneOld(remotePath: string, retention: number): Promise<void> {
  const r = await capture(['--config', RCLONE_CONF, 'lsf', '--files-only', `${REMOTE}:${remotePath}`], 30_000);
  if (r.code !== 0) return;
  const files = r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((f) => /^openmasjidos-backup-.*\.tar\.gz$/.test(f))
    .sort()
    .reverse(); // newest first (names are date-stamped)
  for (const f of files.slice(Math.max(0, retention))) {
    await capture(['--config', RCLONE_CONF, 'deletefile', `${REMOTE}:${remotePath}/${f}`], 30_000);
  }
}

/** Run one backup now: stream the tar to the remote, prune, record status. */
export async function runBackup(): Promise<{ ok: boolean; name: string; message: string }> {
  const cfg = getSettings().backups;
  if (!cfg.configured || !fs.existsSync(RCLONE_CONF)) {
    return { ok: false, name: '', message: 'No backup destination is configured.' };
  }
  const name = backupName();
  const dest = `${REMOTE}:${cfg.remotePath}/${name}`;

  const tar = await backupStream();
  const result = await new Promise<{ ok: boolean; message: string }>((resolve) => {
    const rc = spawn('rclone', ['--config', RCLONE_CONF, 'rcat', dest], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    rc.stderr.on('data', (d) => (err += d.toString()));
    rc.on('error', (e) => resolve({ ok: false, message: `rclone unavailable: ${e.message}` }));
    rc.on('close', (code) => resolve(code === 0 ? { ok: true, message: '' } : { ok: false, message: lastLine(err) || `rclone exited ${code}` }));
    tar.on('error', (e) => {
      try {
        rc.kill();
      } catch {
        /* ignore */
      }
      resolve({ ok: false, message: `Could not read the backup: ${(e as Error).message}` });
    });
    tar.pipe(rc.stdin);
  });

  if (result.ok) {
    await pruneOld(cfg.remotePath, cfg.retention).catch(() => undefined);
  }
  updateBackups({
    lastRunAt: new Date().toISOString(),
    lastResult: result.ok ? 'ok' : 'error',
    lastMessage: result.message,
    ...(result.ok ? { lastBackupName: name } : {}),
  });
  if (!result.ok) log.warn(`Scheduled backup failed: ${result.message}`);
  return { ok: result.ok, name, message: result.message };
}

// ── Scheduler ────────────────────────────────────────────────────────────────
// A simple tick (every 15 min) runs a backup when one is due, based on the
// persisted lastRunAt — so it survives restarts and needs no cron daemon.
const TICK_MS = 15 * 60 * 1000;
const INTERVAL_MS: Record<'daily' | 'weekly', number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};
let ticking = false;

async function tick(): Promise<void> {
  if (ticking) return;
  const cfg = getSettings().backups;
  if (!cfg.enabled || !cfg.configured) return;
  const last = cfg.lastRunAt ? Date.parse(cfg.lastRunAt) : 0;
  if (Date.now() - last < INTERVAL_MS[cfg.schedule]) return;
  ticking = true;
  try {
    log.info('Running scheduled off-site backup…');
    await runBackup();
  } catch (err) {
    log.error('Scheduled backup tick failed.', err);
  } finally {
    ticking = false;
  }
}

export function startBackupScheduler(): void {
  const t = setInterval(() => void tick(), TICK_MS);
  t.unref?.();
  // A first check shortly after boot (a backup overdue from before a restart runs soon).
  const boot = setTimeout(() => void tick(), 60_000);
  boot.unref?.();
}
