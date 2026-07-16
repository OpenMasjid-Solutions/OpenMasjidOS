// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Unit tests for the Fabric grant parsing + the "does this app need a per-app
 * secret?" decision — so a fabric-only app (no sso) is issued a secret, and a
 * malformed fabric block is rejected with a friendly error.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsFabricSecret, parseFabric } from '../src/apps/manager';

test('needsFabricSecret: a fabric-only app (no sso) still needs a secret', () => {
  assert.equal(needsFabricSecret({ provides: ['billing'] }), true);
  assert.equal(needsFabricSecret({ consumes: ['students/billing'] }), true);
  assert.equal(needsFabricSecret({ sso: true }), true);
  assert.equal(needsFabricSecret({ stripe: true }), true);
  assert.equal(needsFabricSecret({}), false);
  assert.equal(needsFabricSecret({ provides: [], consumes: [] }), false);
});

test('parseFabric: accepts a valid block and flattens it', () => {
  const r = parseFabric({ provides: [{ capability: 'billing' }], consumes: ['students/billing'] }, 'donations');
  assert.deepEqual(r, { provides: ['billing'], consumes: ['students/billing'] });
});

test('parseFabric: a missing block is empty grants', () => {
  assert.deepEqual(parseFabric(undefined, 'x'), { provides: [], consumes: [] });
  assert.deepEqual(parseFabric(null, 'x'), { provides: [], consumes: [] });
});

test('parseFabric: rejects malformed shapes with a friendly error', () => {
  assert.throws(() => parseFabric(42, 'x'), /fabric section must be an object/);
  assert.throws(() => parseFabric({ provides: 'nope' }, 'x'), /provides must be a list/);
  assert.throws(() => parseFabric({ provides: [{ capability: 'Bad_Caps' }] }, 'x'), /kebab-case/);
  assert.throws(() => parseFabric({ consumes: ['no-slash'] }, 'x'), /<app-id>\/<capability>/);
  assert.throws(() => parseFabric({ consumes: ['students/Bad_Cap'] }, 'x'), /<app-id>\/<capability>/);
});
