// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Alert registry defaults (read-only — no config writes). Every alert type is ON by
 * default (only the disabled set is persisted), and the OS built-ins are always in
 * the granular list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAlertChannels, listAlertTypes } from '../src/notify/alerts';

test('alerts default to BOTH channels on', () => {
  assert.deepEqual(getAlertChannels('os', 'app-offline'), { email: true, webhook: true });
  assert.deepEqual(getAlertChannels('some-app', 'anything'), { email: true, webhook: true });
});

test('OS built-in alert types are always listed with both channels on by default', () => {
  const types = listAlertTypes();
  const offline = types.find((x) => x.source === 'os' && x.id === 'app-offline');
  assert.ok(offline, 'app-offline is registered');
  assert.deepEqual(offline!.channels, { email: true, webhook: true });
  assert.ok(types.some((x) => x.source === 'os' && x.id === 'core-update'));
});
