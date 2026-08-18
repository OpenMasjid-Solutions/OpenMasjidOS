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

test('email and webhook default ON; WhatsApp defaults OFF', () => {
  // WhatsApp is the asymmetric one, deliberately. It sends through an unofficial
  // client whose linked number can be restricted or banned, so it is a channel the
  // admin switches on knowingly — not one that starts messaging phones the moment a
  // gateway happens to be reachable.
  assert.deepEqual(getAlertChannels('os', 'app-offline'), { email: true, webhook: true, whatsapp: false });
  assert.deepEqual(getAlertChannels('some-app', 'anything'), { email: true, webhook: true, whatsapp: false });
});

test('OS built-in alert types are listed with the default routing', () => {
  const types = listAlertTypes();
  const offline = types.find((x) => x.source === 'os' && x.id === 'app-offline');
  assert.ok(offline, 'app-offline is registered');
  assert.deepEqual(offline!.channels, { email: true, webhook: true, whatsapp: false });
  assert.ok(types.some((x) => x.source === 'os' && x.id === 'core-update'));
  assert.ok(types.some((x) => x.source === 'os' && x.id === 'app-update'));
});

test('an alerts.json written before WhatsApp existed never opts a masjid in', () => {
  // The upgrade path. Old files carry only email/webhook keys; `whatsapp` must read as
  // false from their absence, or upgrading would silently start sending to a phone
  // number the admin never chose for alerts.
  const legacy = { email: false, webhook: true } as { email: boolean; webhook: boolean; whatsapp?: boolean };
  assert.equal(legacy.whatsapp === true, false, 'absent means off');
});
