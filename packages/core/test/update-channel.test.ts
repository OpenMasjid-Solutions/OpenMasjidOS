// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Update channels (system/channel.ts) — the mapping, the legacy migration, and the
 * rule that a switch never half-applies.
 *
 * The two things most likely to bite here, both pinned below:
 *
 *  1. **The channel name is not the branch name.** The channel value matches
 *     OpenMasjidAPPS, whose stable branch is `main`; THIS repo's stable branch is
 *     `master`. Interpolating the channel straight into an OpenMasjidOS raw URL
 *     silently yields a 404 on a path nobody tests by hand.
 *  2. **`updateChannel` already existed** as `'stable' | 'beta'` — declared,
 *     defaulted and accepted by the settings router, but never read. Every upgraded
 *     masjid therefore has the old word in settings.json, and `withDefaults` spreads
 *     persisted values OVER the defaults, so without migration the stale value wins
 *     and we fetch `…/OpenMasjidAPPS/stable/catalog.json`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(__filename);

// Loaded once — pure functions with no data-dir dependency.
const ch = req('../src/system/channel') as typeof import('../src/system/channel');

test('a channel maps to the right branch, image tag and catalog URL', () => {
  // Stable is `master` in THIS repo but `main` in the catalog repo. That asymmetry
  // is the whole reason osBranch() exists.
  assert.equal(ch.osBranch('main'), 'master', "OpenMasjidOS's stable branch is master");
  assert.equal(ch.osBranch('dev'), 'dev');

  assert.equal(ch.coreImageTag('main'), 'latest');
  assert.equal(ch.coreImageTag('dev'), 'dev');

  // The catalog repo genuinely uses `main`, so the channel goes in verbatim there.
  assert.match(ch.catalogUrl('main'), /OpenMasjidAPPS\/main\/catalog\.json$/);
  assert.match(ch.catalogUrl('dev'), /OpenMasjidAPPS\/dev\/catalog\.json$/);

  // …but OS raw URLs must use the BRANCH, never the channel word.
  assert.match(ch.versionCheckUrl('main'), /OpenMasjidOS\/master\/VERSION$/);
  assert.match(ch.versionCheckUrl('dev'), /OpenMasjidOS\/dev\/VERSION$/);
  assert.match(ch.changelogUrl('main'), /OpenMasjidOS\/master\/CHANGELOG\.md$/);
  assert.match(ch.changelogUrl('dev'), /OpenMasjidOS\/dev\/CHANGELOG\.md$/);
  // The bug this rules out: a `/main/` path on the OS repo, which 404s.
  for (const url of [ch.versionCheckUrl('main'), ch.changelogUrl('main')]) {
    assert.doesNotMatch(url, /OpenMasjidOS\/main\//, 'OS URLs must not use the channel word as a branch');
  }
});

test('labels are for humans', () => {
  // A volunteer reads "Stable", not a branch name.
  assert.equal(ch.channelLabel('main'), 'Stable');
  assert.equal(ch.channelLabel('dev'), 'Development');
});

test('an update pulls the EXACT version on Development, and :latest on Stable', () => {
  // Development must not pull `:dev`. That alias can still point at the previous build
  // while a new one publishes, so pulling it installs different bytes than the version
  // the admin was just told about — and, before per-build tags existed, there was no
  // other reference to pull, which is why Development updates could silently do nothing.
  assert.equal(ch.coreTargetTag('dev', '0.50.0-dev.2'), '0.50.0-dev.2');
  // Stable stays on the alias: there `:latest` IS the release by construction, and it
  // is what the installer writes into every box's compose file.
  assert.equal(ch.coreTargetTag('main', '0.50.0'), 'latest');
  // Offline / unreadable VERSION → fall back to the alias rather than pulling nothing.
  for (const v of [null, undefined, '', '   ']) {
    assert.equal(ch.coreTargetTag('dev', v), 'dev', `${JSON.stringify(v)} falls back to :dev`);
    assert.equal(ch.coreTargetTag('main', v), 'latest');
  }
});

test('there is no moving-tag predicate any more', () => {
  // Structural, and deliberate. `usesMovingTags()` was the hook every
  // Development-only branch hung off — digest comparison, a suppressed update banner,
  // `reason: 'dev-refresh'`. Dev builds are versioned now, so both channels share one
  // path; a predicate like this reappearing means that split is growing back.
  assert.equal('usesMovingTags' in ch, false, 'usesMovingTags must stay deleted');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'system', 'channel.ts'), 'utf8');
  assert.doesNotMatch(src, /export function usesMovingTags/);
});

test('every channel value crossing a boundary is validated', () => {
  assert.equal(ch.channelSchema.safeParse('main').success, true);
  assert.equal(ch.channelSchema.safeParse('dev').success, true);
  for (const bad of ['master', 'stable', 'beta', 'MAIN', '', 'main ', null, 1, {}, ['dev']]) {
    assert.equal(ch.channelSchema.safeParse(bad).success, false, `must reject ${JSON.stringify(bad)}`);
  }
});

test('legacy and junk channel values coerce to something usable, never to a bad URL', () => {
  // The upgrade path: what ≤0.48.x actually wrote.
  assert.equal(ch.coerceChannel('stable'), 'main');
  assert.equal(ch.coerceChannel('beta'), 'dev');
  // Pass-through.
  assert.equal(ch.coerceChannel('main'), 'main');
  assert.equal(ch.coerceChannel('dev'), 'dev');
  // Anything else falls back to the TESTED channel — the safe answer to "I can't
  // tell what you wanted" is not "run untested software".
  for (const junk of [undefined, null, '', 'nightly', 'MASTER', 42, {}, []]) {
    assert.equal(ch.coerceChannel(junk), 'main', `${JSON.stringify(junk)} → main`);
  }
  // And whatever comes out is always a valid channel, by construction.
  for (const v of ['stable', 'beta', 'nonsense', undefined]) {
    assert.equal(ch.channelSchema.safeParse(ch.coerceChannel(v)).success, true);
  }
});

// ── the settings store's migration, against a real file ───────────────────────

function loadSettingsWith(json: string | null): typeof import('../src/settings/store') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-chan-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  if (json !== null) fs.writeFileSync(path.join(dir, 'config', 'settings.json'), json);
  process.env.OPENMASJID_DATA_DIR = dir;
  for (const m of ['../src/config', '../src/settings/store']) delete req.cache[req.resolve(m)];
  return req('../src/settings/store') as typeof import('../src/settings/store');
}

test("an upgraded masjid's persisted 'stable' does not become a 404 catalog URL", () => {
  // This is the migration bug in its real shape: withDefaults spreads the persisted
  // value over the default, so the old word would win.
  const s = loadSettingsWith(JSON.stringify({ updateChannel: 'stable', allowCustomApps: true }));
  assert.equal(s.getSettings().updateChannel, 'main');
  assert.equal(s.getSettings().allowCustomApps, true, 'the rest of the file still applies');
  // Prove the consequence, not just the value.
  assert.match(ch.catalogUrl(s.getSettings().updateChannel), /\/main\/catalog\.json$/);
});

test('a legacy beta install lands on Development, and a fresh install on Stable', () => {
  assert.equal(loadSettingsWith(JSON.stringify({ updateChannel: 'beta' })).getSettings().updateChannel, 'dev');
  assert.equal(loadSettingsWith(null).getSettings().updateChannel, 'main', 'default is Stable');
  assert.equal(loadSettingsWith('{}').getSettings().updateChannel, 'main');
  // A corrupt/hostile value must not reach a URL builder.
  assert.equal(
    loadSettingsWith(JSON.stringify({ updateChannel: '../../etc/passwd' })).getSettings().updateChannel,
    'main',
  );
});

test('a channel survives a restart', () => {
  // Acceptance criterion: persists across restart. Write via the store, then reload
  // the module against the same dir, which is what a restart actually does.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-chan-p-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  process.env.OPENMASJID_DATA_DIR = dir;
  for (const m of ['../src/config', '../src/settings/store']) delete req.cache[req.resolve(m)];
  const first = req('../src/settings/store') as typeof import('../src/settings/store');
  first.updateSettings({ updateChannel: 'dev' });

  for (const m of ['../src/config', '../src/settings/store']) delete req.cache[req.resolve(m)];
  const second = req('../src/settings/store') as typeof import('../src/settings/store');
  assert.equal(second.getSettings().updateChannel, 'dev', 'the channel must survive a restart');
});

test('an explicit catalog override is not bypassed by switching channel', () => {
  // An operator who pinned a catalog (air-gapped install, local mirror) must keep it:
  // reaching past their pin to GitHub because the channel changed would be worse than
  // refusing the switch.
  const prev = process.env.OPENMASJID_CATALOG_URL;
  process.env.OPENMASJID_CATALOG_URL = 'http://mirror.masjid.lan/catalog.json';
  try {
    assert.equal(ch.catalogUrl('main'), 'http://mirror.masjid.lan/catalog.json');
    assert.equal(ch.catalogUrl('dev'), 'http://mirror.masjid.lan/catalog.json');
  } finally {
    if (prev === undefined) delete process.env.OPENMASJID_CATALOG_URL;
    else process.env.OPENMASJID_CATALOG_URL = prev;
  }
});

test('the channel is not settable through settings.update', () => {
  // Structural, and load-bearing: switching has to go through
  // system.setUpdateChannel, which reads the target catalog BEFORE persisting so a
  // failure cannot leave the masjid pointing at a channel it cannot resolve. If the
  // plain settings field came back, the UI could persist a channel unchecked.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'trpc', 'routers', 'settings.ts'),
    'utf8',
  );
  assert.doesNotMatch(src, /updateChannel:\s*z\./, 'settings.update must not accept updateChannel');
});

test('the switch reads the target catalog before persisting anything', () => {
  // Pins the ORDER, which is the graceful-failure guarantee: requireCatalog must be
  // awaited before updateSettings, or a dead dev catalog half-switches the masjid.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'trpc', 'routers', 'system.ts'), 'utf8');
  const requireAt = src.indexOf('requireCatalog(');
  const persistAt = src.indexOf('updateSettings({ updateChannel');
  assert.ok(requireAt > 0, 'the switch must verify the target catalog');
  assert.ok(persistAt > 0, 'the switch must persist the channel');
  assert.ok(requireAt < persistAt, 'the catalog must be verified BEFORE the channel is persisted');
  // And the caches must be dropped, or a switch serves the old channel's entries.
  assert.match(src, /clearCatalogCache\(\)/);
  assert.match(src, /clearChangelogCache\(\)/);
});

test('the build publishes a dev image AND a per-version tag, or Development is inert', () => {
  const wf = fs.readFileSync(path.join(__dirname, '..', '..', '..', '.github', 'workflows', 'docker-build.yml'), 'utf8');
  assert.match(wf, /branches:\s*\[master,\s*dev\]/, 'dev must trigger a build');
  assert.match(wf, /type=ref,event=branch/, 'which is what tags the image :dev');
  // The version tag is what the channel actually PULLS (coreTargetTag). Without it,
  // Development can detect an update and then fail to install it — worse than silence,
  // because the box says a version is available that cannot be fetched.
  assert.match(wf, /tr -d[^\n]*< VERSION/, 'the VERSION file must be read');
  assert.match(
    wf,
    /type=raw,value=\$\{\{ steps\.ver\.outputs\.version \}\}/,
    'and published as a tag, or the Development channel cannot pull its own build',
  );
  // :latest must stay Stable-only, or Development would overwrite what stable boxes pull.
  assert.match(wf, /type=raw,value=latest,enable=\{\{is_default_branch\}\}/);
});

test("this repo's dev VERSION is a prerelease, ahead of master", () => {
  // The bump IS the publish (CLAUDE.md §13.4). If dev/VERSION ever equals master's
  // again, a dev box has nothing to compare and goes silent — which is the exact bug
  // this change removed, reappearing as a one-line omission.
  const v = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'VERSION'), 'utf8').trim();
  assert.match(v, /^\d+\.\d+\.\d+-dev\.\d+$/, `dev/VERSION must be X.Y.Z-dev.N, got "${v}"`);
  // And the version check's own regex must accept it, or the channel reads its own
  // VERSION file as unusable.
  assert.match(v, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
});

// ── the bug that made channel switching mean delete-and-reinstall ─────────────

test('a pending channel switch is offered as an update, even at the same version', () => {
  // THE REGRESSION. A channel move is required regardless of what the versions say,
  // and its target can legitimately be OLDER (going back to Stable). When this was
  // semver-only, a pending switch compared equal, the card said "up to date", the
  // Update button never appeared, and removing + reinstalling the app was the only way
  // across. Pinned at the decision level, since the executor could always do the move.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'apps', 'manager.ts'), 'utf8');
  const fn = src.slice(src.indexOf('export async function checkCatalogUpdate'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));

  // It must consider the app's channel, not just the version.
  assert.match(body, /appChannel !== channel/, 'a channel mismatch must count as an update');
  assert.match(body, /'channel'/, 'and must be reported as such, so the UI can word it');
  // …and the channel check must come FIRST, or a same-version switch is missed again.
  assert.ok(
    body.indexOf('appChannel !== channel') < body.indexOf('isNewerVersion'),
    'the channel check must precede the version check',
  );
  // The Development-only third branch must NOT come back: dev entries are versioned.
  assert.doesNotMatch(body, /usesMovingTags|dev-refresh|catalogImageDiffers|certain/);
});

test('the Development channel reports updates exactly like Stable', () => {
  // Development used to be pinned to `updateAvailable: false`, because dev/VERSION held
  // the same string as master's — so the only options were permanent silence or a
  // permanent nag. Versioned dev builds make the comparison meaningful, so there must be
  // ONE expression for both channels and no channel test near it.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'system', 'system.ts'), 'utf8');
  assert.match(
    src,
    /updateAvailable: latest != null && isNewerVersion\(VERSION, latest\),/,
    'one semver comparison, both channels',
  );
  assert.doesNotMatch(src, /movingTag/, 'the moving-tag special case must stay deleted');
  // A prerelease must survive the VERSION-file sanity check, or dev reads its own
  // version file as junk and goes quiet — silently, since the check fails soft.
  const re = /if \(\/(\^.*?)\/\.test\(raw\)\) latest = raw;/.exec(src);
  assert.ok(re, 'the VERSION sanity regex must still be there');
  assert.match('0.50.0-dev.12', new RegExp(re[1]!), 'a prerelease must be accepted');
  assert.match('0.50.0', new RegExp(re[1]!), 'and so must a plain release');
});

test('the digest-comparison subsystem is gone, not merely unused', () => {
  // It existed only to fake a version axis for Development. Left in place it is a
  // second, contradictory source of truth for "is there an update?" — and the one that
  // was wrong. Deleting the module is what keeps it from being wired back in.
  assert.equal(
    fs.existsSync(path.join(__dirname, '..', 'src', 'docker', 'image-ref.ts')),
    false,
    'docker/image-ref.ts must be deleted',
  );
  const mgr = fs.readFileSync(path.join(__dirname, '..', 'src', 'apps', 'manager.ts'), 'utf8');
  for (const dead of [
    'runningRepoDigests',
    'catalogImageDiffers',
    'pulledImageDigests',
    'runningImageDigests',
    'sameDigests',
    'imageDigests',
  ]) {
    assert.doesNotMatch(mgr, new RegExp(dead), `${dead} must be gone from the manager`);
  }
  const types = fs.readFileSync(path.join(__dirname, '..', 'src', 'apps', 'types.ts'), 'utf8');
  assert.doesNotMatch(types, /imageDigests\?:/, 'the catalogue contract must not ask for digests');
});

test('returning to Stable moves apps back automatically; going to Development does not', () => {
  // The asymmetry Hasan asked for: Development is opt-in per app (you chose to
  // experiment), Stable is the home state (one decision, not one per app).
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'ui', 'src', 'components', 'UpdateChannel.tsx'),
    'utf8',
  );
  assert.match(src, /res\.channel === 'main' && res\.pending\.length > 0/, 'auto-revert only towards Stable');
  assert.doesNotMatch(src, /res\.channel === 'dev'[^\n]*onUpdateAll/, 'never auto-migrate towards Development');
});
