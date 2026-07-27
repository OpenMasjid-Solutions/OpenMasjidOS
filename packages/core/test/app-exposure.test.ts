// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Per-app internet exposure defaults (apps/manager.ts `isExposedMeta`).
 *
 * §15: nothing is public without the admin's explicit toggle. A missing
 * `exposed` key means two different things, and conflating them published the
 * least-vetted apps by default:
 *   - catalog  → predates per-app exposure (v0.40.0); grandfathered EXPOSED so
 *                an upgrade never takes a masjid's working public app offline.
 *   - custom / community → `installStack` simply never wrote the key, so it was
 *                never a decision. PRIVATE.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExposedMeta } from '../src/apps/manager';

test('an explicit choice always wins, for every kind', () => {
  for (const kind of ['catalog', 'custom', 'community'] as const) {
    assert.equal(isExposedMeta({ kind, exposed: true }), true, `${kind} true`);
    assert.equal(isExposedMeta({ kind, exposed: false }), false, `${kind} false`);
  }
});

test('an unset value is grandfathered exposed for a CATALOG app', () => {
  // Pre-0.40 installs must not go dark on upgrade (the golden rule).
  assert.equal(isExposedMeta({ kind: 'catalog' }), true);
  assert.equal(isExposedMeta({ kind: 'catalog', exposed: undefined }), true);
});

test('an unset value is PRIVATE for custom and community apps', () => {
  // The regression this pins: `meta.exposed !== false` read the key installStack
  // never wrote as "public", so every pasted/community stack was internet-facing
  // — on ports[0], which in a CasaOS stack is usually a database.
  assert.equal(isExposedMeta({ kind: 'custom' }), false);
  assert.equal(isExposedMeta({ kind: 'community' }), false);
  assert.equal(isExposedMeta({ kind: 'custom', exposed: undefined }), false);
});
