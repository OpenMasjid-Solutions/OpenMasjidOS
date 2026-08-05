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

test('only Development uses moving tags, and labels are for humans', () => {
  assert.equal(ch.usesMovingTags('dev'), true);
  assert.equal(ch.usesMovingTags('main'), false);
  // A volunteer reads "Stable", not a branch name.
  assert.equal(ch.channelLabel('main'), 'Stable');
  assert.equal(ch.channelLabel('dev'), 'Development');
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

test('the build publishes a dev image, or the Development channel is inert', () => {
  // The channel pulls `:dev`. That tag only exists if the workflow builds the dev
  // branch — otherwise selecting Development leaves the box unable to update at all.
  const wf = fs.readFileSync(path.join(__dirname, '..', '..', '..', '.github', 'workflows', 'docker-build.yml'), 'utf8');
  assert.match(wf, /branches:\s*\[master,\s*dev\]/, 'dev must trigger a build');
  assert.match(wf, /type=ref,event=branch/, 'which is what tags the image :dev');
  // :latest must stay Stable-only, or Development would overwrite what stable boxes pull.
  assert.match(wf, /type=raw,value=latest,enable=\{\{is_default_branch\}\}/);
});
