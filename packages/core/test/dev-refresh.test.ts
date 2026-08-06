// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The Development channel's "did anything actually change?" check.
 *
 * On `dev` an app tracks a moving `:dev` tag, so the version string never moves and semver
 * can never report an update. The update path therefore re-pulls and compares the image the
 * container is running against what the reference resolves to afterwards.
 *
 * That comparison was reading `listContainers().Image`, which is not dependably the image
 * NAME: moby resolves it lazily (`daemon/list.go`, `refreshImage`) and substitutes the image
 * **ID** as soon as the recorded name resolves to something else. Moving a tag is exactly
 * what pulling `:dev` does — so the field flipped from `repo:dev` to a bare ID precisely
 * when a new build HAD arrived. Resolving that ID handed back the old image, before and
 * after matched, and every Development update answered:
 *
 *     "… is already running the latest Development build. Nothing was changed."
 *
 * permanently, for every app on the channel. Verified against Docker 29.6.2 on the same
 * container either side of a re-tag:
 *
 *   before:  listContainers().Image = localhost/movetest:dev   Config.Image = localhost/movetest:dev
 *   after:   listContainers().Image = 8a27b25386b7             Config.Image = localhost/movetest:dev
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const req = createRequire(__filename);
const { containerImageRef, looksLikeImageId, composeImageRefs, sameImageRefs } = req(
  '../src/docker/image-ref',
) as typeof import('../src/docker/image-ref');

test('an image ID is told apart from a reference', () => {
  // Both forms the daemon substitutes.
  assert.equal(looksLikeImageId('8a27b25386b7'), true, 'short id');
  assert.equal(
    looksLikeImageId('sha256:8a27b25386b7485e335b403acfc03c5be1154032c399fe22497bc6bf991f9f33'),
    true,
    'full id',
  );
  assert.equal(looksLikeImageId('8a27b25386b7485e335b403acfc03c5be1154032c399fe22497bc6bf991f9f33'), true);

  // Real references must never be mistaken for one, or we would resolve nothing.
  for (const ref of [
    'ghcr.io/openmasjid-solutions/openmasjidkiosk:dev',
    'ghcr.io/openmasjid-solutions/openmasjidkiosk:0.10.2@sha256:05e3aefa0112028d79c8d853dd82a72ea30858d9b321e231d9723d8998de92a0',
    'alpine',
    'alpine:3.20',
    'localhost/movetest:dev',
    'deadbeef/app:1.0', // hex-looking, but it has a slash and a tag
  ]) {
    assert.equal(looksLikeImageId(ref), false, `${ref} is a reference`);
  }

  assert.equal(looksLikeImageId(''), false);
  assert.equal(looksLikeImageId('   '), false);
  // Too short to be an id, and a plausible repo name.
  assert.equal(looksLikeImageId('abc'), false);
});

test('THE REGRESSION: after a pull moves :dev, the tag is still the reference we resolve', () => {
  const tag = 'ghcr.io/openmasjid-solutions/openmasjidkiosk:dev';
  // Exactly the state observed after a genuine new build was pulled.
  assert.equal(containerImageRef('8a27b25386b7', tag), tag);
  // …and before it, where both agree.
  assert.equal(containerImageRef(tag, tag), tag);
});

test('the whole before/after comparison now moves when the bytes move', () => {
  // A miniature of runningImageDigests() vs pulledImageDigests(): the container keeps
  // running OLD, while the tag has been re-pointed at NEW.
  const OLD = 'sha256:8a27b25386b7485e335b403acfc03c5be1154032c399fe22497bc6bf991f9f33';
  const NEW = 'sha256:bf886f3f5f3141e71ee9c9b7955a80d03bfb9d6b87300d16ad8d9bafe7d7d353';
  const tag = 'ghcr.io/openmasjid-solutions/openmasjidkiosk:dev';
  const localImages: Record<string, string> = { [tag]: NEW, [OLD]: OLD, '8a27b25386b7': OLD };
  const resolve = (ref: string) => localImages[ref];

  // What the daemon reports for that container once the tag has moved.
  const listImage = '8a27b25386b7';

  const digestBefore = [OLD];
  const digestAfter = [resolve(containerImageRef(listImage, tag))];
  assert.notDeepEqual(digestAfter, digestBefore, 'a new build must be seen as a change');

  // The old code resolved the list value directly — this is the bug, kept as the contrast.
  const buggyAfter = [resolve(listImage)];
  assert.deepEqual(buggyAfter, digestBefore, 'demonstrates the false "nothing was changed"');
});

test('nothing new pulled still reports unchanged, so we never recreate for nothing', () => {
  // The behaviour worth preserving: an unnecessary recreate is a real outage for a
  // wall-mounted display.
  const SAME = 'sha256:8a27b25386b7485e335b403acfc03c5be1154032c399fe22497bc6bf991f9f33';
  const tag = 'ghcr.io/openmasjid-solutions/openmasjiddisplay:dev';
  const resolve = (ref: string) => ({ [tag]: SAME })[ref];
  // Tag never moved, so the daemon still reports the name.
  assert.deepEqual([resolve(containerImageRef(tag, tag))], [SAME]);
});

// --- Retargeting: the other way the same silence can happen -------------------------------
//
// The digest short-circuit asks the reference the RUNNING containers were created with. That
// is only meaningful while a dev entry tracks a MOVING tag. As soon as one publishes immutable
// per-build tags (`:0.11.0-dev.1`, the versioning discipline the platform wants so it can
// detect and NOTIFY about dev builds at all), the old reference resolves to the old image for
// ever — before and after match every time and the recreate is skipped permanently. So a
// changed set of image references must bypass the short-circuit outright.

test('image references are read out of a compose file', () => {
  const compose = `
services:
  app:
    image: ghcr.io/openmasjid-solutions/openmasjidkiosk:0.11.0-dev.1   # the versioned dev tag
    restart: unless-stopped
  sidecar:
    image: "alpine:3.20"
volumes:
  data:
`;
  assert.deepEqual(composeImageRefs(compose), [
    'alpine:3.20',
    'ghcr.io/openmasjid-solutions/openmasjidkiosk:0.11.0-dev.1',
  ]);
  // EVERY service counts, not just the primary one — a sidecar left on an old tag is a
  // half-applied update.
  assert.equal(composeImageRefs(compose).length, 2);
});

test('an unreadable or empty compose is treated as retargeted, never as unchanged', () => {
  // "I could not tell" must fall through to applying the update, not skipping it.
  assert.deepEqual(composeImageRefs(''), []);
  assert.equal(sameImageRefs([], []), false);
  assert.equal(sameImageRefs([], ['alpine']), false);
});

test('THE SECOND REGRESSION: an immutable per-build dev tag counts as a change', () => {
  const before = 'services:\n  app:\n    image: ghcr.io/x/kiosk:0.11.0-dev.1\n';
  const after = 'services:\n  app:\n    image: ghcr.io/x/kiosk:0.11.0-dev.2\n';
  assert.equal(
    sameImageRefs(composeImageRefs(before), composeImageRefs(after)),
    false,
    'a new versioned tag must bypass the digest short-circuit',
  );
  // A moving `:dev` tag is genuinely the same reference, so that case still relies on the
  // digest comparison and still avoids a pointless recreate.
  assert.equal(sameImageRefs(composeImageRefs(before), composeImageRefs(before)), true);
});

test('a sidecar left behind is still a retarget', () => {
  const before = 'services:\n  app:\n    image: r/app:1\n  db:\n    image: r/db:1\n';
  const after = 'services:\n  app:\n    image: r/app:2\n  db:\n    image: r/db:1\n';
  assert.equal(sameImageRefs(composeImageRefs(before), composeImageRefs(after)), false);
});

test('a container with no usable Config.Image falls back rather than resolving nothing', () => {
  const tag = 'ghcr.io/openmasjid-solutions/openmasjidstudents:dev';
  assert.equal(containerImageRef(tag, undefined), tag, 'inspect failed — use the list value');
  assert.equal(containerImageRef(tag, ''), tag);
  // Genuinely created from a bare ID: there is no better answer, and returning it keeps the
  // caller's "resolves to the same thing → unchanged" path working.
  assert.equal(containerImageRef('8a27b25386b7', '8a27b25386b7'), '8a27b25386b7');
  assert.equal(containerImageRef('', ''), '');
});
