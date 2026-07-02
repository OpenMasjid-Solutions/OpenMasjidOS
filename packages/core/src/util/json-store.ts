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
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  // Create the temp file 0o600 from the first byte so secrets (auth.json's
  // password hash, settings.json's notification webhook, stripe.json) are never
  // world-readable — not even briefly. openSync's mode is masked by umask, and is
  // ignored entirely if the tmp survived a prior crashed write, so also chmod
  // explicitly before the atomic rename (rename preserves the inode's mode).
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
