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
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const req = createRequire(__filename);

// Loaded once — pure functions with no data-dir dependency.
const ch = req('../src/system/channel') as typeof import('../src/system/channel');
const { isNewerVersion } = req('../src/util/version') as typeof import('../src/util/version');

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

test('an update pulls the EXACT version on BOTH channels, never the moving alias', () => {
  // An alias can point at different bytes than the version just announced, and every
  // failure that produces is silent: you pull, you recreate, you are still on the old
  // build, and the check offers the same update forever.
  assert.equal(ch.coreTargetTag('dev', '0.50.0-dev.2'), '0.50.0-dev.2');
  // Stable used to return 'latest' here on the claim that it was "equivalent by
  // construction" to the release tag. It was not: `:latest` was written by BOTH the
  // master-branch build and the release-tag build, so it held different bytes from
  // `:X.Y.Z` (v0.50.1: latest 5eaf997 vs 0.50.1 23696bb).
  assert.equal(ch.coreTargetTag('main', '0.50.1'), '0.50.1');
  // Offline / unreadable VERSION → fall back to the alias rather than pulling nothing.
  for (const v of [null, undefined, '', '   ']) {
    assert.equal(ch.coreTargetTag('dev', v), 'dev', `${JSON.stringify(v)} falls back to :dev`);
    assert.equal(ch.coreTargetTag('main', v), 'latest');
  }
});

test('arm64 is built natively, never under emulation', () => {
  // THE HANG. Under QEMU the arm64 leg sat on `RUN npm ci` for 1h47m emitting nothing,
  // while every amd64 step finished inside a minute; it ended only by being cancelled.
  // It had been latent for weeks because the layer cache meant `npm ci` rarely re-ran,
  // so the first dependency change since exposed it — and meanwhile a masjid was told a
  // version was available that could never be pulled.
  const wf = fs.readFileSync(path.join(__dirname, '..', '..', '..', '.github', 'workflows', 'docker-build.yml'), 'utf8');
  assert.doesNotMatch(wf, /setup-qemu/, 'no QEMU: emulated arm64 npm ci hangs');
  assert.match(wf, /ubuntu-24\.04-arm/, 'arm64 must build on a native arm64 runner');
  assert.match(wf, /platform: linux\/arm64/, 'and arm64 must still be built at all');
  assert.match(wf, /platform: linux\/amd64/);

  // Every job that builds or publishes needs a deadline. The hang was invisible because
  // silence is indistinguishable from progress, and GitHub's default would have let it
  // hold a runner for six hours.
  const jobs = wf.split(/\n {2}(?=[a-z-]+:\n)/);
  for (const name of ['build', 'merge']) {
    const job = jobs.find((j) => j.startsWith(`${name}:`));
    assert.ok(job, `the ${name} job must exist`);
    assert.match(job, /timeout-minutes:\s*\d+/, `${name} must have a timeout`);
  }

  // The per-architecture caches must not share a scope, or the two runners evict each
  // other's layers every run and the build is randomly cold.
  assert.match(wf, /scope=\$\{\{ matrix\.platform \}\}/, 'cache scope must be per-platform');

  // And what ships must actually contain both architectures. A list missing arm64
  // installs fine on a mini-PC and fails on every Raspberry Pi.
  assert.match(wf, /is missing linux\/\$want/, 'the merge job must verify both arches');

  // Every hand-written image reference must be lowercased. `github.repository_owner` is
  // `OpenMasjid-Solutions`, and registries reject an uppercase repository name — which
  // failed the first native-runner run outright. metadata-action lowercases whatever goes
  // through `images:`, so only references built by hand are at risk.
  assert.match(wf, /ref=\$\{REGISTRY,,\}\/\$\{IMAGE_NAME,,\}/, 'the ref must be lowercased once');
  for (const [what, re] of [
    ['the digest push', /outputs: type=image,name=[^\n]*/],
    ['the manifest list', /printf '[^\n]*@sha256/],
    ['the verification', /ref='[^\n]*steps\.meta\.outputs\.version/],
  ] as const) {
    const line = re.exec(wf);
    assert.ok(line, `${what} must exist`);
    assert.doesNotMatch(line[0], /env\.IMAGE_NAME/, `${what} must not use the raw (cased) name`);
  }
});

test(':latest is published from exactly one place — a non-prerelease release tag', () => {
  // `is_default_branch` reads like "only master pushes", but it is ALSO true on a tag
  // push, so `:latest` was written twice per release from two independent builds of the
  // same commit. That is how a Stable masjid ended up running an image its release tag
  // did not name.
  const wf = fs.readFileSync(path.join(__dirname, '..', '..', '..', '.github', 'workflows', 'docker-build.yml'), 'utf8');
  const line = /type=raw,value=latest[^\n]*/.exec(wf);
  assert.ok(line, ':latest must still be published');
  assert.doesNotMatch(line[0], /is_default_branch/, 'is_default_branch also fires on tag pushes');
  assert.match(line[0], /ref_type == 'tag'/, ':latest must come from the tag build only');
  // And never from a prerelease tag, or one `v*-dev.*` push drags every Stable box
  // onto a Development build.
  assert.match(line[0], /!contains\(github\.ref_name, '-'\)/, 'prerelease tags must not move :latest');
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
  // To end of line: the enable expression contains spaces inside `${{ … }}`.
  const raw = /type=raw,value=\$\{\{ steps\.ver\.outputs\.version \}\}[^\n]*/.exec(wf);
  assert.ok(raw, 'and published as a tag, or the Development channel cannot pull its own build');
  // Scoped to dev. Enabled for every branch, a master push republishes `:X.Y.Z` over
  // what the release tag already published — same source, but a rebuild is not
  // byte-identical, so a release tag people treat as pinned quietly starts moving.
  assert.match(raw[0], /ref_name == 'dev'/, 'the per-version tag must be dev-branch only');
  // Development must never be able to move `:latest` — asserted in full by the
  // ':latest is published from exactly one place' test above.
  assert.doesNotMatch(raw[0], /value=latest/);
});

/**
 * Which branch this checkout is FOR, or null if it can't be told.
 *
 * The target branch, not the source: a release is a dev→master merge, so its content
 * is dev's but the version it must carry is master's. `GITHUB_BASE_REF` is set on a
 * pull_request (the base), `GITHUB_REF_NAME` on a branch push. A tag push and a
 * detached checkout are genuinely unknown, and get the shape check only.
 */
function targetBranch(): 'master' | 'dev' | null {
  const fromEnv = process.env.GITHUB_BASE_REF || (process.env.GITHUB_REF_TYPE === 'tag' ? '' : process.env.GITHUB_REF_NAME);
  const name =
    fromEnv ||
    (() => {
      try {
        return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: path.join(__dirname, '..', '..', '..'),
          encoding: 'utf8',
        }).trim();
      } catch {
        return '';
      }
    })();
  return name === 'master' || name === 'dev' ? name : null;
}

test("VERSION matches the branch it's on: a prerelease on dev, a release on master", () => {
  // The bump IS the publish (CLAUDE.md §13.4). Two ways to get this wrong, both quiet:
  //   dev carrying a plain release  → dev/VERSION can equal master's, so a dev box has
  //                                  nothing to compare and goes silent. That is exactly
  //                                  the bug this change removed, back as an omission.
  //   master carrying a prerelease → every Stable masjid is offered a dev build.
  const v = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'VERSION'), 'utf8').trim();

  // Always: a shape both branches must satisfy, and one the update check will accept.
  // A version the check's own regex rejects is read as "no version published" — which
  // fails soft and therefore silently.
  assert.match(v, /^\d+\.\d+\.\d+(-dev\.\d+)?$/, `VERSION must be X.Y.Z or X.Y.Z-dev.N, got "${v}"`);
  assert.match(v, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);

  const branch = targetBranch();
  if (branch === 'dev') {
    assert.match(v, /-dev\.\d+$/, `on dev, VERSION must be a prerelease, got "${v}"`);
  } else if (branch === 'master') {
    assert.doesNotMatch(v, /-/, `on master, VERSION must be a release, got "${v}"`);
  }
  // Unknown branch (tag push / detached / worktree): the shape check above still ran.
});

test("dev's VERSION must be a prerelease of the NEXT release, not the current one", () => {
  // THE BUG THIS EXISTS TO CATCH, which reached a masjid. After 0.50.4 was released,
  // dev kept counting `0.50.4-dev.5`, `-dev.6`… — and by semver a prerelease sorts BELOW
  // its release, so `0.50.4-dev.6 < 0.50.4`. A box on Stable 0.50.4 that switched to
  // Development was therefore offered NOTHING: the channel's newest build was older than
  // what it was already running. No banner, no alert, no error — the dashboard said
  // Development and ran Stable for ever.
  //
  // The rule is CLAUDE.md §18: a dev VERSION names the release it is HEADING TOWARD.
  // After releasing 0.50.4, dev goes to 0.50.5-dev.1, never 0.50.4-dev.N.
  if (targetBranch() !== 'dev') return;
  const root = path.join(__dirname, '..', '..', '..');
  const v = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();

  // master's VERSION is the released number. If the ref isn't in this checkout (a shallow
  // CI clone), the shape check above still ran — but locally, where the bump happens,
  // this is exactly where the mistake gets made and caught.
  let released = '';
  for (const ref of ['master', 'origin/master']) {
    try {
      released = execFileSync('git', ['show', `${ref}:VERSION`], { cwd: root, encoding: 'utf8' }).trim();
      break;
    } catch {
      /* try the next ref */
    }
  }
  if (!released) return;

  assert.ok(
    isNewerVersion(released, v),
    `dev's VERSION (${v}) must be NEWER than the released ${released}. ` +
      `A prerelease sorts below its own release, so ${v} would offer a Development masjid ` +
      `nothing at all — bump the base version, not just the -dev counter.`,
  );
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
    /const newerAvailable = latest != null && isNewerVersion\(VERSION, latest\);/,
    'one semver comparison, both channels',
  );
  assert.doesNotMatch(src, /movingTag/, 'the moving-tag special case must stay deleted');
  // The ONE thing besides the version comparison that may offer an update is a running
  // build from the other channel, and it must be SYMMETRIC — a test written as
  // "if channel is dev then…" is the old special-casing coming back in a new shape.
  assert.match(
    src,
    /const channelMismatch = isPrerelease\(VERSION\) !== \(channel === 'dev'\);/,
    'the channel check must be a symmetric comparison, not a per-channel branch',
  );
  // And it must never claim an update it cannot perform: a move needs a target version.
  assert.match(src, /channelMismatch && latest != null/, 'a channel move still needs a version to move to');
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

test('a box running the OTHER channel is offered the way back, whatever the numbers say', () => {
  // THE TRAP, reported from a real install. An interrupted update was repaired with the
  // installer, the repair pulled `:latest`, and the box ended up running a Stable build
  // while Settings still said Development. `runUpdate` knew how to fix that
  // (`wrongChannel`) — but the DETECTOR only compared versions, so nothing ever told the
  // masjid: no banner, no alert, no error. The dashboard said Development and ran Stable
  // for ever, with no way out from the UI.
  //
  // Decided here at the expression level, because the detector and the executor
  // disagreeing is exactly what produced a dead end.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'system', 'system.ts'), 'utf8');
  const fn = src.slice(src.indexOf('export async function checkForUpdate'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));

  // The mismatch must feed updateAvailable, not merely be reported alongside it.
  const availableLine = /updateAvailable: newerAvailable \|\| \(channelMismatch && latest != null\)/;
  assert.match(body, availableLine, 'a channel mismatch must make an update available');

  // And it must be distinguishable, because a channel move is not "a new version" — its
  // target is often an OLDER number (going back to Stable always is), and calling that an
  // upgrade in the UI reads as a mistake.
  assert.match(body, /reason: newerAvailable \? 'version' :/, 'the reason must say which it is');
  assert.match(
    fs.readFileSync(path.join(__dirname, '..', '..', 'ui', 'src', 'routes', 'Dashboard.tsx'), 'utf8'),
    /reason === 'channel'/,
    'and the dashboard must word the two differently',
  );
});
