// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The progress windows — a core update, an app update, a restore — are read by a masjid
 * volunteer, so they say what is happening in plain words. Docker's and tar's own output
 * (layer ids, image references, container ids, "Error response from daemon") goes to the
 * server log, labelled with what produced it, and never to the window. And because the
 * window no longer sees that output, a long step puts a plain line in it every 30 s, so it
 * does not look frozen.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-plain-progress-'));
process.env.OPENMASJID_DATA_DIR = DATA;
// No Docker Engine API: nothing here may reach a real daemon. The CLI is a stand-in below.
process.env.DOCKER_SOCKET = path.join(DATA, 'no-docker.sock');

const req = createRequire(__filename);
const { log } = req('../src/logger') as typeof import('../src/logger');
const settings = req('../src/settings/store') as typeof import('../src/settings/store');
const lock = req('../src/system/update-lock') as typeof import('../src/system/update-lock');
const { runUpdate } = req('../src/docker/update') as typeof import('../src/docker/update');
const { updateCatalogApp } = req('../src/apps/manager') as typeof import('../src/apps/manager');
const { runRestore, RESTORE_PATH } = req('../src/system/restore') as typeof import('../src/system/restore');
const hb = req('../src/util/heartbeat') as typeof import('../src/util/heartbeat');

const POSIX_ONLY = { skip: process.platform === 'win32' ? 'needs a POSIX shell and GNU tar — run the suite in WSL' : false } as const;

/** What Docker itself prints, which no window may show. */
const RAW = /Pulling from|Pull complete|Downloaded newer image|ghcr\.io|4f9c0e1d2b3a|Error response from daemon|Container omos-|gzip:|tar:/;

/** A stand-in `docker` that talks the way the real one does. */
function chattyDocker(): () => void {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-chatty-docker-'));
  fs.writeFileSync(
    path.join(bin, 'docker'),
    [
      '#!/bin/sh',
      'case "$*" in',
      `  "pull "*) echo "0.99.0-dev.1: Pulling from openmasjid-solutions/openmasjid-core"; printf 'a1b2c3d4e5f6: Pull complete\\r'; echo "Status: Downloaded newer image for $2" ;;`,
      '  "run "*) echo "4f9c0e1d2b3a5c6d7e8f" ;;',
      '  compose*" pull") echo " app Pulling"; echo " 4f4fb700ef54 Pull complete" >&2 ;;',
      '  compose*" up "*) echo " Container omos-hello-app-1  Recreate"; echo "Error response from daemon: port is already allocated" >&2; exit 1 ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${PATH}`;
  return () => {
    process.env.PATH = PATH;
  };
}

/** What GitHub answers: the Development VERSION, and a one-app catalogue. */
function publishes(): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes('OpenMasjidAPPS')) {
      return new Response(
        JSON.stringify({ apps: [{ id: 'hello', name: 'Hello', version: '1.1.0', compose: 'services:\n  app:\n    image: nginx:1.27\n' }] }),
      );
    }
    return new Response('0.99.0-dev.1\n');
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

/** Every line the server logged at info, while `fn` runs. */
async function logged<T>(fn: () => Promise<T>): Promise<{ result: T; info: string[] }> {
  const info = mock.method(log, 'info', () => undefined);
  try {
    const result = await fn();
    return { result, info: info.mock.calls.map((c) => String(c.arguments[0])) };
  } finally {
    info.mock.restore();
  }
}

test("A CORE UPDATE'S WINDOW NEVER SHOWS DOCKER'S OUTPUT — the log gets it, the window gets the version in words", POSIX_ONLY, async () => {
  settings.updateSettings({ updateChannel: 'dev' });
  fs.writeFileSync(path.join(DATA, 'docker-compose.yml'), 'services:\n  core:\n    image: ghcr.io/openmasjid-solutions/openmasjid-core:0.51.2-dev.16\n');
  const restorePath = chattyDocker();
  const unpublish = publishes();
  try {
    const lines: string[] = [];
    const { result, info } = await logged(() => runUpdate((l) => lines.push(l)));
    assert.equal(result, 'restarting', lines.join(' | '));
    assert.ok(lines.includes('Downloading version 0.99.0-dev.1…'), lines.join(' | '));
    for (const l of lines) assert.doesNotMatch(l, RAW, `Docker's own output reached the window: "${l}"`);
    assert.ok(info.some((l) => l.startsWith('docker pull: 0.99.0-dev.1: Pulling from')), info.join(' | '));
    assert.ok(info.some((l) => l === 'docker pull: a1b2c3d4e5f6: Pull complete'), 'a \\r redraw is its own log line');
    assert.ok(info.some((l) => l === 'docker run: 4f9c0e1d2b3a5c6d7e8f'), 'the helper container id goes to the log');
  } finally {
    unpublish();
    restorePath();
    lock.__releaseHeldLocksForTests(); // the core this one handed over to is "replaced"
  }
});

test("AN APP UPDATE'S WINDOW NEVER SHOWS COMPOSE'S OUTPUT — not even when the start fails", POSIX_ONLY, async () => {
  const dir = path.join(DATA, 'apps', 'hello');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ id: 'hello', name: 'Hello', kind: 'catalog', version: '1.0.0', channel: 'dev', createdAt: '2026-01-01T00:00:00.000Z' }),
  );
  fs.writeFileSync(path.join(dir, 'compose.yml'), 'services:\n  app:\n    image: nginx:1.26\n');
  const restorePath = chattyDocker();
  const unpublish = publishes();
  try {
    const lines: string[] = [];
    const { result, info } = await logged(() => updateCatalogApp('hello', (l) => lines.push(l)));
    assert.equal(result, 'unchanged', lines.join(' | '));
    // The plain lines stay, and say what happened.
    assert.ok(lines.includes('Downloading the new version…'));
    assert.ok(lines.includes('The update could not start. The previous version may still be running.'), lines.join(' | '));
    for (const l of lines) assert.doesNotMatch(l, RAW, `compose's own output reached the window: "${l}"`);
    assert.ok(info.includes('compose pull omos-hello:  app Pulling'), info.join(' | '));
    assert.ok(info.includes('compose up omos-hello: Error response from daemon: port is already allocated'), info.join(' | '));
  } finally {
    unpublish();
    restorePath();
  }
});

test("A RESTORE'S WINDOW NEVER SHOWS TAR'S OUTPUT for a backup it cannot read", POSIX_ONLY, async () => {
  fs.writeFileSync(RESTORE_PATH, 'not a gzip archive at all');
  const lines: string[] = [];
  const { result, info } = await logged(() => runRestore((l) => lines.push(l)));
  assert.equal(result, 'unchanged', lines.join(' | '));
  assert.ok(lines.includes('Restore failed while reading the backup.'), lines.join(' | '));
  for (const l of lines) assert.doesNotMatch(l, RAW, `tar's own output reached the window: "${l}"`);
  assert.ok(info.some((l) => l.startsWith('tar -xzf: ')), info.join(' | '));
});

test('a long step puts a plain line in the window every 30 s — and stops when it ends, however it ends', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const lines: string[] = [];
    let finish!: (code: number) => void;
    const work = hb.withHeartbeat((l) => lines.push(l), hb.STILL_DOWNLOADING, () => new Promise<number>((r) => (finish = r)));
    mock.timers.tick(29_999);
    assert.equal(lines.length, 0, 'too early');
    mock.timers.tick(1);
    assert.deepEqual(lines, [hb.STILL_DOWNLOADING]);
    mock.timers.tick(30_000);
    assert.equal(lines.length, 2);
    finish(0);
    assert.equal(await work, 0, 'the step’s own result comes through');
    mock.timers.tick(120_000);
    assert.equal(lines.length, 2, 'still talking after the step ended');

    // A step that throws stops it too, and the error is the caller's to handle.
    const failing = hb.withHeartbeat((l) => lines.push(l), hb.STILL_WORKING, () => Promise.reject(new Error('boom')));
    await assert.rejects(failing, /boom/);
    mock.timers.tick(120_000);
    assert.equal(lines.length, 2, 'still talking after the step failed');
  } finally {
    mock.timers.reset();
  }

  // And no line promises a wait: a real build once took nearly two hours to publish.
  for (const l of [hb.STILL_DOWNLOADING, hb.STILL_WORKING]) assert.doesNotMatch(l, /\b(seconds?|minutes?|hours?)\b/i, l);
});
