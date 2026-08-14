// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * One update at a time.
 *
 * Nothing stopped two updates of the same thing running at once: every WebSocket
 * connection to `/api/update` started a fresh core update, and every connection to
 * `/api/apps/update?id=…` a fresh app update. So closing the progress window and pressing
 * the button again ran a SECOND update over the first — two
 * `docker compose up -d --force-recreate` runs racing for one container, with two writers
 * rewriting the same compose file underneath them. A masjid reported the result: the box
 * stopped coming back at all.
 *
 * The dialog is locked while an update runs, but that is the second line of defence. A
 * browser can be closed, a laptop can sleep, a phone can lose wifi — a guarantee that
 * depends on the user not clicking is not a guarantee, so the lock lives on the server.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(__filename);
const lock = req('../src/system/update-lock') as typeof import('../src/system/update-lock');

function codeOf(rel: string): string {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const never = () => new Promise<void>(() => {}); // a job that never settles

test('a second update of the same thing is refused, not run alongside', async () => {
  let released = () => {};
  const held = new Promise<void>((r) => (released = r));
  const first = lock.withUpdateLock('core', 'busy', () => held);

  assert.equal(lock.isUpdating('core'), true);
  await assert.rejects(() => lock.withUpdateLock('core', 'busy', never), /busy/);

  released();
  await first;
  assert.equal(lock.isUpdating('core'), false, 'the lock must be released when the work finishes');
});

test('the lock is per app, so two different apps still update in parallel', async () => {
  let releaseA = () => {};
  const a = lock.withUpdateLock('app:students', 'busy', () => new Promise<void>((r) => (releaseA = r)));
  // A different app must not be blocked by the first.
  await lock.withUpdateLock('app:donations', 'busy', async () => {});
  releaseA();
  await a;
});

test('a failed update releases the lock, so it can be retried', async () => {
  await assert.rejects(() =>
    lock.withUpdateLock('core', 'busy', async () => {
      throw new Error('pull failed');
    }),
  );
  assert.equal(lock.isUpdating('core'), false, 'a failure must not wedge the lock for ever');
  // Provable: the next attempt gets in.
  await lock.withUpdateLock('core', 'busy', async () => {});
});

test('both update entry points take the lock', () => {
  // If either one is left unlocked, the other's guard does not help — the two race paths
  // are the core updater and the per-app updater.
  assert.match(codeOf('core/src/docker/update.ts'), /withUpdateLock\('core'/, 'the core updater must lock');
  assert.match(codeOf('core/src/apps/manager.ts'), /withUpdateLock\(`app:\$\{id\}`/, 'the app updater must lock');
});

test('"already running" is reported as information, never as a failure', () => {
  // Calling it a failure pushes an admin into retrying, which is the exact action the
  // lock exists to prevent.
  for (const rel of ['core/src/api/update.ts', 'core/src/api/app-update.ts']) {
    const src = codeOf(rel);
    const at = src.indexOf('UpdateBusyError');
    assert.ok(at > 0, `${rel} must handle the busy case`);
    const branch = src.slice(at, at + 200);
    assert.doesNotMatch(branch.split('} else')[0], /Update failed/, `${rel} must not call it a failure`);
  }
});

test('the update dialog and window cannot be dismissed while running', () => {
  const modal = codeOf('ui/src/components/Modal.tsx');
  assert.match(modal, /locked \? undefined : onClose/, 'the backdrop must not close a locked dialog');
  assert.match(modal, /if \(!open \|\| locked\) return/, 'Escape must not close a locked dialog');
  assert.match(modal, /\{!locked && \(/, 'the X must be absent while locked');

  // The core updater locks until it is done.
  assert.match(codeOf('ui/src/components/UpdateModal.tsx'), /locked=\{phase !== 'done'\}/);

  // App updates open in a window instead, and both launchers must lock it.
  for (const rel of ['ui/src/components/AppCard.tsx', 'ui/src/routes/Dashboard.tsx']) {
    assert.match(codeOf(rel), /locked: true/, `${rel} must open the update window locked`);
    assert.match(codeOf(rel), /setLocked\(winId, false\)/, `${rel} must release it when done`);
  }
  // And the manager itself refuses close() for a locked window, so the Escape handler and
  // any future caller are covered by one rule rather than one check per entry point.
  assert.match(codeOf('ui/src/components/Windows.tsx'), /\?\.locked \? list :/);
});
