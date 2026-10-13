// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Platform fixes whose modules had no test file of their own: a setting the disk
 * refused, and what the logo upload tells the admin when it cannot take an image.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(__filename);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-fixes-'));
process.env.OPENMASJID_DATA_DIR = DATA_DIR;
const CONFIG_DIR = path.join(DATA_DIR, 'config');

// Loaded after DATA_DIR is set (config.ts reads it at import time).
const settings = req('../src/settings/store') as typeof import('../src/settings/store');

test('a setting the disk refused is not in effect, not even until the next restart', () => {
  // updateSettings changed its in-memory copy and THEN wrote. On a full disk the save
  // reported an error, yet the change was live: managing from outside, switched off,
  // read as closed — and quietly reopened at the next boot, when the file was read again.
  settings.updateCloudflare({ remoteAdmin: true });
  const tmp = path.join(CONFIG_DIR, 'settings.json.tmp');
  fs.mkdirSync(tmp); // writeJson cannot create its temp file, so every write fails
  try {
    assert.throws(() => settings.updateCloudflare({ remoteAdmin: false }));
    assert.equal(settings.getSettings().cloudflare.remoteAdmin, true, 'the refused change was believed');
    assert.throws(() => settings.updateSettings({ rootTerminal: true }));
    assert.equal(settings.getSettings().rootTerminal, false, 'the refused change was believed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  settings.reloadSettings();
  assert.equal(settings.getSettings().cloudflare.remoteAdmin, true, 'memory and disk agree');
});
