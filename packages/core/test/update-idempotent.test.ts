// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * An update must refuse to "update" to the version already running.
 *
 * THE LOOP this prevents, reported after returning from Development to Stable:
 * every connection to `/api/update` ran a full pull + recreate unconditionally. The
 * recreate restarted the core, which then dropped every session (auth/sessions.ts kept
 * them in a Map; they are persisted now), so the dashboard fell back to the sign-in
 * screen. That unmounted AppShell — where the windows render — so the migration
 * window's subtree unmounted while the window itself survived in WindowsProvider, which
 * then sat above the router. Signing back in remounted it from scratch, which re-ran
 * every app and then the OS again, which signed you out again. Endless, and escapable
 * only by closing the window in the seconds before the restart landed.
 *
 * The rule is the same one `updateCatalogApp` already applies to apps ("is already up to
 * date"); the core's own update never had it.
 *
 * The subtlety is that a CHANNEL MOVE must still proceed when the version says
 * otherwise. The running build states its channel exactly — a Development build's
 * version is a prerelease, a Stable one is not — so:
 *
 *   dev -> main   prerelease -> release   semver already calls this an upgrade
 *   main -> dev   release -> prerelease   semver calls it a DOWNGRADE, so without the
 *                                         channel check the platform would refuse to
 *                                         follow its own channel switch
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(__filename);
const { isPrerelease } = req('../src/util/version') as typeof import('../src/util/version');

/**
 * The decision runUpdate makes, extracted so every combination can be checked. This copy
 * once drifted from the code — it said an unreadable version still "tries" while the code
 * stopped with "already up to date" — so the case is also driven through the real
 * runUpdate in remote-update.test.ts.
 */
function proceeds(running: string, latest: string | null, channel: 'main' | 'dev'): boolean {
  const wrongChannel = isPrerelease(running) !== (channel === 'dev');
  // Unreadable: a channel move still goes (to the channel's alias); otherwise nothing is
  // pulled, and the window says it could not check rather than "up to date".
  if (latest === null) return wrongChannel;
  const { isNewerVersion } = req('../src/util/version') as typeof import('../src/util/version');
  const updateAvailable = isNewerVersion(running, latest);
  return updateAvailable || wrongChannel;
}

test('THE LOOP: after reverting to Stable, a repeat update does nothing', () => {
  // The box has landed on the Stable release and the channel is Stable. Every further
  // connection to /api/update must stop here — this is the exact state the sign-out
  // kept returning to.
  assert.equal(proceeds('0.50.3', '0.50.3', 'main'), false);
  // …and it must keep refusing however many times it is asked.
  for (let i = 0; i < 5; i++) assert.equal(proceeds('0.50.3', '0.50.3', 'main'), false);
});

test('the revert itself still proceeds', () => {
  // Running a Development build, channel just switched to Stable. Semver agrees a
  // release outranks its prerelease, so this would proceed even without the channel
  // check — but it must proceed.
  assert.equal(proceeds('0.50.3-dev.1', '0.50.3', 'main'), true);
});

test('switching TO Development proceeds even though semver calls it a downgrade', () => {
  // The case the channel check exists for. Stable 0.50.3 running, channel now dev,
  // dev publishes 0.50.3-dev.1 — which is LOWER. Without the wrong-channel test the
  // platform refuses to follow its own switch and sits on the Stable image while the
  // dashboard says Development: exactly the mixed-channel state the feature prevents.
  assert.equal(proceeds('0.50.3', '0.50.3-dev.1', 'dev'), true);
  // Once it has moved, it must settle rather than loop.
  assert.equal(proceeds('0.50.3-dev.1', '0.50.3-dev.1', 'dev'), false);
});

test('an ordinary update is unaffected', () => {
  assert.equal(proceeds('0.50.2', '0.50.3', 'main'), true, 'newer Stable release');
  assert.equal(proceeds('0.50.3-dev.1', '0.50.3-dev.2', 'dev'), true, 'newer dev build');
  assert.equal(proceeds('0.50.3', '0.50.2', 'main'), false, 'never downgrade on its own');
});

test('a version that cannot be read pulls nothing on the same channel — and is never called "up to date"', () => {
  // `checkForUpdate` fails soft. On the same channel there is nothing known to move to,
  // so nothing is pulled — that is the loop guard — and the window says it could not
  // check. A channel move still goes, to the channel's alias.
  assert.equal(proceeds('0.50.3', null, 'main'), false);
  assert.equal(proceeds('0.50.3-dev.1', null, 'dev'), false);
  assert.equal(proceeds('0.50.3', null, 'dev'), true);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'docker', 'update.ts'), 'utf8');
  const fn = src.slice(src.indexOf('async function runUpdateInner'));
  const couldNot = fn.indexOf("onLine(\"Couldn't check for the latest version just now");
  const upToDate = fn.indexOf('is already up to date (v');
  assert.ok(couldNot > 0 && upToDate > 0, 'setup');
  assert.ok(couldNot < upToDate, 'an unreadable version must not reach "already up to date"');
});

test('the guard is wired into runUpdate BEFORE anything is pulled', () => {
  // Structural: a guard placed after the pull would still restart the core, which is
  // the step that signs everyone out and restarts the loop.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'docker', 'update.ts'), 'utf8');
  const fn = src.slice(src.indexOf('async function runUpdateInner'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  const guardAt = body.indexOf('already up to date');
  const pullAt = body.indexOf("streamSpawn('docker', ['pull'");
  assert.ok(guardAt > 0, 'runUpdate must refuse a no-op update');
  assert.ok(pullAt > 0);
  assert.ok(guardAt < pullAt, 'and must refuse BEFORE pulling or recreating');
  assert.match(body, /isPrerelease\(/, 'the channel move must still be allowed through');
});

test('the migration window reads what is pending instead of trusting a stale prop', () => {
  // The other half. The window used to survive the sign-out its own OS update caused,
  // because WindowsProvider sat above the router while the windows render in AppShell —
  // so the subtree unmounted and remounted with fresh state. Given a captured prop it
  // replayed the whole migration; reading live state, a remount sees nothing pending.
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'ui', 'src', 'components', 'ChannelMigrate.tsx'),
    'utf8',
  );
  assert.match(src, /trpc\.system\.channel\.useQuery\(\)/, 'it must read live pending state');
  assert.doesNotMatch(
    src,
    /^\s*apps: PendingApp\[\];/m,
    'the pending list must not arrive as a prop captured when the window opened',
  );
  // And the snapshot must exist, or an invalidation mid-run shifts the list under the
  // index and an app is skipped.
  assert.match(src, /setPlan\(/, 'the work must be snapshotted once, not re-read per render');

  const caller = fs.readFileSync(
    path.join(__dirname, '..', '..', 'ui', 'src', 'routes', 'Settings.tsx'),
    'utf8',
  );
  // Found first, or the check below passes on a file that no longer renders it at all.
  assert.match(caller, /<ChannelMigrate\b/, 'the Settings shell must still open the migration window');
  assert.doesNotMatch(caller, /<ChannelMigrate[^>]*apps=/, 'the caller must not pass a stale list');
});
