// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * A failed app update must leave NOTHING new on disk.
 *
 * `updateCatalogApp` writes the refreshed `compose.yml` and `.env` before it pulls, then
 * pulls, then recreates, then saves `meta.json`. Both middle steps can fail and return
 * early — and until this was fixed, that early return left the NEW compose beside the OLD
 * meta.
 *
 * That combination is specifically dangerous here, because `startApp` runs
 * `docker compose up` against whatever is on disk and is deliberately NOT compose-gated
 * (CLAUDE.md §15). The gap is documented as acceptable only because "every write vector
 * into that file is closed" — a half-applied update is exactly such a write vector. So a
 * volunteer pressing Start on an app whose update had failed would silently get the new
 * stack, while the dashboard still reported the old version, and the install-time risk
 * gate would never have vetted the compose that actually ran.
 *
 * Structural rather than behavioural: driving the real function needs Docker, a catalog
 * and a running gateway. What is worth pinning is the ORDER and the presence of the undo,
 * because that is what regressed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..', 'src');
const manager = fs.readFileSync(path.join(SRC, 'apps', 'manager.ts'), 'utf8');

/** The body of updateCatalogAppInner, where the ordering matters. */
function updateBody(): string {
  const start = manager.indexOf('async function updateCatalogAppInner');
  assert.ok(start > 0, 'updateCatalogAppInner must exist');
  const end = manager.indexOf('\nexport ', start);
  return manager.slice(start, end > start ? end : undefined);
}

test('the previous compose and .env are snapshotted BEFORE the new ones are written', () => {
  const body = updateBody();
  const snap = body.indexOf('const prevCompose');
  const write = body.indexOf('fs.writeFileSync(composePath(id), app.compose');
  assert.ok(snap > 0, 'the update must snapshot the existing compose');
  assert.ok(write > 0, 'the update must write the new compose');
  assert.ok(snap < write, 'snapshotting after the overwrite would capture the NEW file, undoing nothing');
});

test('BOTH failure paths roll back — a pull failure and a failed recreate', () => {
  const body = updateBody();
  // The two early returns that can leave a half-applied update on disk.
  for (const marker of ['Could not download the update', 'The update could not start']) {
    const at = body.indexOf(marker);
    assert.ok(at > 0, `expected the "${marker}" failure path`);
    // The rollback must come before that path's `return`, or the new files survive.
    const ret = body.indexOf('return;', at);
    const rb = body.indexOf('rollback()', at);
    assert.ok(rb > 0 && rb < ret, `the "${marker}" path must roll back before returning`);
  }
});

test('rollback runs BEFORE meta.json is saved, never after', () => {
  const body = updateBody();
  const lastRollback = body.lastIndexOf('rollback()');
  const saveMeta = body.indexOf('saveMeta({');
  assert.ok(saveMeta > 0, 'the update must save meta on success');
  assert.ok(
    lastRollback < saveMeta,
    'a rollback after saveMeta would restore the old compose under the NEW recorded version — the same mismatch reversed',
  );
});

test('a compose that did not exist restores to absent, not to an empty file', () => {
  const body = updateBody();
  // `null` is the "there was no file" sentinel; restoring it as '' would leave an empty
  // compose that `docker compose up` reads as a valid, service-less project.
  assert.match(body, /prevCompose === null\s*\)?\s*fs\.rmSync/, 'a missing compose must restore to deleted');
  assert.match(body, /prevEnv === null\s*\)?\s*fs\.rmSync/, 'a missing .env must restore to deleted');
});

test('rollback cannot itself throw and replace the real error message', () => {
  const body = updateBody();
  const at = body.indexOf('const rollback');
  const fnEnd = body.indexOf('\n  };', at);
  const fn = body.slice(at, fnEnd);
  assert.match(fn, /try\s*\{/, 'rollback must be wrapped');
  assert.match(fn, /catch/, 'a failure restoring is already the unhappy path — it must not throw over the reason');
});

test('startApp is still the reason this matters — it reads the compose from disk', () => {
  // If this ever stops being true the fix is still correct, but the severity changes, and
  // the comment explaining why would go stale. Pin the assumption the fix rests on.
  const at = manager.indexOf('export async function startApp');
  assert.ok(at > 0, 'startApp must exist');
  const body = manager.slice(at, at + 900);
  assert.match(body, /composePath\(id\)/, 'startApp reads the on-disk compose');
  assert.doesNotMatch(body, /checkCompose\(/, 'startApp is documented as NOT compose-gated (CLAUDE.md §15)');
});
