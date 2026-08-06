// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Semver precedence, prereleases included — the single axis the whole update system
 * now turns on, for BOTH channels.
 *
 * Why this file carries weight: before dev builds had versions, a Development build
 * reused the stable version string and pointed at a moving `:dev` tag, so nothing
 * observable changed when one was published. No update could be detected and nobody
 * could be notified. The platform grew a parallel mechanism (compare registry image
 * digests, ask the catalogue to publish them, a manual "check for a new Development
 * build") purely to fake this comparison. Giving dev builds real prerelease versions
 * deleted all of it — which means every Development update now depends on the ordering
 * below being right.
 *
 * Two ways to get it wrong, both silent, both pinned here:
 *   - text-comparing prerelease numbers, which stops offering updates at `-dev.10`;
 *   - treating a prerelease as newer than its own release, which offers a masjid a
 *     "downgrade" to the release they should be moving to.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const req = createRequire(__filename);
const { isNewerVersion, compareVersions, isPrerelease } = req(
  '../src/util/version',
) as typeof import('../src/util/version');

test('THE ORDERING: a dev build sits above the last release and below the next', () => {
  // The whole scheme in one line: 0.49.3 < 0.50.0-dev.1 < 0.50.0-dev.2 < 0.50.0
  const ladder = ['0.49.3', '0.50.0-dev.1', '0.50.0-dev.2', '0.50.0'];
  for (let i = 0; i < ladder.length - 1; i++) {
    const a = ladder[i]!;
    const b = ladder[i + 1]!;
    assert.equal(isNewerVersion(a, b), true, `${b} must be newer than ${a}`);
    assert.equal(isNewerVersion(b, a), false, `${a} must NOT be newer than ${b}`);
  }
  // And transitively across the whole ladder, not just neighbours.
  assert.equal(isNewerVersion('0.49.3', '0.50.0'), true);
  assert.equal(isNewerVersion('0.50.0', '0.49.3'), false);
});

test('prerelease numbers compare NUMERICALLY, so -dev.10 beats -dev.9', () => {
  // Lexically "10" < "9". A text compare therefore stops offering updates at the tenth
  // dev build of a version and simply goes quiet — no error, nothing in a log.
  assert.equal(isNewerVersion('0.50.0-dev.9', '0.50.0-dev.10'), true);
  assert.equal(isNewerVersion('0.50.0-dev.10', '0.50.0-dev.9'), false);
  assert.equal(isNewerVersion('0.50.0-dev.99', '0.50.0-dev.100'), true);
  assert.equal(isNewerVersion('0.50.0-dev.2', '0.50.0-dev.11'), true);
});

test('a release outranks its own prereleases', () => {
  // The bug in the compare this replaced: it read `0.50.0-dev.4` as [0,50,0,4] and so
  // called it NEWER than `0.50.0` — offering a "downgrade" to the actual release.
  assert.equal(isNewerVersion('0.50.0-dev.4', '0.50.0'), true, 'the release is the upgrade');
  assert.equal(isNewerVersion('0.50.0', '0.50.0-dev.4'), false, 'and never the other way');
  // Same core version, one prerelease: not equal.
  assert.ok(compareVersions('0.50.0', '0.50.0-dev.1') > 0);
});

test('the real catalogue pairs order correctly', () => {
  // The live stable/dev entries at the time this landed. Each dev build must read as
  // newer than the stable release it descends from, or the channel switch and the
  // update banner disagree about which way is forward.
  const pairs: [string, string][] = [
    ['0.66.1', '0.67.0-dev.1'], // display
    ['0.40.1', '0.41.0-dev.1'], // donations
    ['0.10.2', '0.11.0-dev.1'], // kiosk
    ['0.45.1', '0.46.0-dev.1'], // students
  ];
  for (const [stable, dev] of pairs) {
    assert.equal(isNewerVersion(stable, dev), true, `${dev} must be ahead of ${stable}`);
    assert.equal(isNewerVersion(dev, stable), false, `${stable} must not be ahead of ${dev}`);
  }
});

test('equal versions are never an update, however they are spelled', () => {
  // `checkCatalogUpdate` returns "up to date" from this, and that answer is what stops
  // a pointless container recreate — a real outage for a wall-mounted display.
  for (const v of ['0.50.0', '0.50.0-dev.1', '1.0.0', '0.0.1']) {
    assert.equal(isNewerVersion(v, v), false, `${v} is not newer than itself`);
    assert.equal(compareVersions(v, v), 0);
  }
  // Spellings that mean the same version.
  assert.equal(compareVersions('0.50', '0.50.0'), 0, 'a missing patch is zero');
  assert.equal(compareVersions('v0.50.0', '0.50.0'), 0, 'a leading v is tolerated');
  assert.equal(compareVersions('0.50.0 ', ' 0.50.0'), 0, 'surrounding space is trimmed');
  // Build metadata is not part of precedence (semver §10).
  assert.equal(compareVersions('0.50.0+build.7', '0.50.0'), 0);
  assert.equal(compareVersions('0.50.0-dev.1+a', '0.50.0-dev.1+b'), 0);
});

test('prerelease identifier rules follow the spec', () => {
  // Numeric identifiers rank below alphanumeric ones…
  assert.equal(isNewerVersion('0.50.0-1', '0.50.0-alpha'), true);
  assert.equal(isNewerVersion('0.50.0-alpha', '0.50.0-1'), false);
  // …alphanumerics compare as text…
  assert.equal(isNewerVersion('0.50.0-alpha', '0.50.0-beta'), true);
  assert.equal(isNewerVersion('0.50.0-beta', '0.50.0-alpha'), false);
  // …and with all else equal, more fields ranks higher.
  assert.equal(isNewerVersion('0.50.0-dev', '0.50.0-dev.1'), true);
  assert.equal(isNewerVersion('0.50.0-dev.1', '0.50.0-dev'), false);
});

test('major and minor still dominate a prerelease suffix', () => {
  // A prerelease must never let a lower core version win — that would let a stale dev
  // entry look newer than a real release.
  assert.equal(isNewerVersion('0.50.0-dev.1', '0.51.0'), true);
  assert.equal(isNewerVersion('0.51.0', '0.50.0-dev.99'), false);
  assert.equal(isNewerVersion('0.9.0', '0.10.0-dev.1'), true, '10 > 9, not "10" < "9"');
  assert.equal(isNewerVersion('1.0.0-dev.1', '1.0.0'), true);
  assert.equal(isNewerVersion('0.99.99', '1.0.0-dev.1'), true);
});

test('junk sorts predictably instead of throwing', () => {
  // These strings come from a fetched VERSION file, a catalog entry, and a meta.json
  // written by an older build. A malformed one must not throw inside an update check.
  for (const junk of ['', '   ', 'nonsense', 'v', '..', '-dev.1', 'NaN.NaN.NaN']) {
    assert.doesNotThrow(() => compareVersions(junk, '0.50.0'));
    assert.doesNotThrow(() => compareVersions('0.50.0', junk));
    assert.doesNotThrow(() => isNewerVersion(junk, junk));
  }
  // Unparseable reads as 0.0.0, so a real version beats it — and, crucially, junk never
  // reads as newer, which would offer an update to nothing.
  assert.equal(isNewerVersion('nonsense', '0.50.0'), true);
  assert.equal(isNewerVersion('0.50.0', 'nonsense'), false);
  // @ts-expect-error deliberately calling with the wrong type — this comes off the wire
  assert.doesNotThrow(() => compareVersions(undefined, null));
});

test('isPrerelease recognises a Development build', () => {
  assert.equal(isPrerelease('0.50.0-dev.1'), true);
  assert.equal(isPrerelease('0.50.0'), false);
  assert.equal(isPrerelease('0.50.0+build.1'), false, 'build metadata is not a prerelease');
  assert.equal(isPrerelease(''), false);
});

test('the UI copy of this function stays in step with the core', () => {
  // CLAUDE.md §7 forbids the UI importing core runtime code, so this is a deliberate
  // duplicate. The changelog's "newer than you're running" badge reads it, and a
  // Development build's version is a prerelease — so a copy that drifts on the
  // prerelease rule shows the badge on a release the box already runs.
  const core = fs.readFileSync(path.join(__dirname, '..', 'src', 'util', 'version.ts'), 'utf8');
  const ui = fs.readFileSync(
    path.join(__dirname, '..', '..', 'ui', 'src', 'lib', 'version.ts'),
    'utf8',
  );
  // Compare the logic, not the prose: strip comments and whitespace.
  const logic = (s: string) =>
    s
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/\s+/g, '');
  assert.equal(logic(ui), logic(core), 'the UI copy must be logic-identical to the core');
});
