// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * An update must refuse to "update" to the version already running.
 *
 * THE LOOP this prevents, reported after returning from Development to Stable:
 * every connection to `/api/update` ran a full pull + recreate unconditionally. The
 * recreate restarts the core, which drops every in-memory session (auth/sessions.ts
 * keeps them in a Map), so the dashboard falls back to the sign-in screen. That
 * unmounts AppShell — and the window layer renders inside the Dock — so the migration
 * window's subtree unmounted while the window itself survived in WindowsProvider, which
 * sits above the router. Signing back in remounted it from scratch, which re-ran every
 * app and then the OS again, which signed you out again. Endless, and escapable only by
 * closing the window in the seconds before the restart landed.
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

/** The decision runUpdate makes, extracted so every combination can be checked. */
function proceeds(running: string, latest: string | null, channel: 'main' | 'dev'): boolean {
  if (latest === null) return true; // offline: can't tell, so let a manual attempt try
  const { isNewerVersion } = req('../src/util/version') as typeof import('../src/util/version');
  const updateAvailable = isNewerVersion(running, latest);
  const wrongChannel = isPrerelease(running) !== (channel === 'dev');
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

test('offline still tries, rather than claiming to be up to date', () => {
  // `checkForUpdate` fails soft. Treating "I could not ask" as "nothing to do" would
  // silently disable updating for anyone behind a flaky uplink.
  assert.equal(proceeds('0.50.3', null, 'main'), true);
  assert.equal(proceeds('0.50.3', null, 'dev'), true);
});

test('the guard is wired into runUpdate BEFORE anything is pulled', () => {
  // Structural: a guard placed after the pull would still restart the core, which is
  // the step that signs everyone out and restarts the loop.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'docker', 'update.ts'), 'utf8');
  const fn = src.slice(src.indexOf('export async function runUpdate'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  const guardAt = body.indexOf('already up to date');
  const pullAt = body.indexOf("streamSpawn('docker', ['pull'");
  assert.ok(guardAt > 0, 'runUpdate must refuse a no-op update');
  assert.ok(pullAt > 0);
  assert.ok(guardAt < pullAt, 'and must refuse BEFORE pulling or recreating');
  assert.match(body, /isPrerelease\(/, 'the channel move must still be allowed through');
});

test('the migration window reads what is pending instead of trusting a stale prop', () => {
  // The other half. The window survives the sign-out its own OS update causes, because
  // WindowsProvider sits above the router while the window LAYER renders inside the
  // Dock — so the subtree unmounts and remounts with fresh state. Given a captured
  // prop it replayed the whole migration; reading live state it sees nothing pending.
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
  assert.doesNotMatch(caller, /<ChannelMigrate[^>]*apps=/, 'the caller must not pass a stale list');
});
