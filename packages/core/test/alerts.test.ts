// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Alert registry defaults (read-only — no config writes). Every alert type is ON by
 * default (only the disabled set is persisted), and the OS built-ins are always in
 * the granular list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAlertEnabled, listAlertTypes } from '../src/notify/alerts';

test('unknown/OS alerts default to enabled', () => {
  assert.equal(isAlertEnabled('os', 'app-offline'), true);
  assert.equal(isAlertEnabled('some-app', 'anything'), true);
});

test('OS built-in alert types are always listed and enabled by default', () => {
  const types = listAlertTypes();
  const offline = types.find((x) => x.source === 'os' && x.id === 'app-offline');
  assert.ok(offline, 'app-offline is registered');
  assert.equal(offline!.enabled, true);
  assert.ok(types.some((x) => x.source === 'os' && x.id === 'core-update'));
});
