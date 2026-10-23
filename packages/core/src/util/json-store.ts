// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Tiny JSON persistence helpers. Writes go through a temp file + rename so a
 * crash mid-write can never leave a half-written config on disk.
 */
import fs from 'node:fs';
import path from 'node:path';

export function readJson<T>(file: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return { ...fallback, ...(JSON.parse(raw) as Partial<T>) };
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(value, null, 2));
}

/**
 * Replace `file` with `data` whole or not at all: written to a temp file beside it, then
 * renamed over it. A write the disk refuses part-way (ENOSPC, EIO) leaves the old file as
 * it was — a plain writeFileSync truncates first and leaves it cut short.
 */
export function writeFileAtomic(file: string, data: string, mode = 0o600): void {
  const tmp = `${file}.tmp`;
  try {
    // Create the temp file with its mode from the first byte so secrets (auth.json's
    // password hash, settings.json's notification webhook, stripe.json) are never
    // world-readable — not even briefly. openSync's mode is masked by umask, and is
    // ignored entirely if the tmp survived a prior crashed write, so also chmod
    // explicitly before the atomic rename (rename preserves the inode's mode).
    const fd = fs.openSync(tmp, 'w', mode);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true }); // it holds what failed to land
    } catch {
      /* the write's own error is the one to report */
    }
    throw err;
  }
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
