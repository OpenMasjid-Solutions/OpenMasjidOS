// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * WP-B tunnel-uplink guards: the /fabric-over-tunnel refusal predicate and the
 * viaTunnel detection. These encode the LAN-only invariant for an app's own
 * /fabric/* space (app↔platform + app↔app broker) — never reachable publicly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFabricSubpath } from '../src/system/ingress';
import { isViaTunnelHeaders } from '../src/system/via-tunnel';

test('isFabricSubpath: flags an app-relative /fabric path after the segment', () => {
  assert.equal(isFabricSubpath('/donate/fabric/billing/lookup', 'donate'), true);
  assert.equal(isFabricSubpath('/donate/fabric', 'donate'), true);
  assert.equal(isFabricSubpath('/donate/fabric/', 'donate'), true);
  assert.equal(isFabricSubpath('/donate/fabric/x?y=1', 'donate'), true);
});

test('isFabricSubpath: does NOT flag ordinary app paths', () => {
  assert.equal(isFabricSubpath('/donate', 'donate'), false);
  assert.equal(isFabricSubpath('/donate/', 'donate'), false);
  assert.equal(isFabricSubpath('/donate/checkout', 'donate'), false);
  // A path that merely CONTAINS "fabric" later, or an app literally named fabricy,
  // must not be mistaken for the app's /fabric/* space.
  assert.equal(isFabricSubpath('/donate/fabrications/list', 'donate'), false);
  assert.equal(isFabricSubpath('/fabricy/home', 'fabricy'), false);
});

test('isViaTunnelHeaders: cf-ray or x-forwarded-proto=https marks tunnel origin', () => {
  assert.equal(isViaTunnelHeaders({ 'cf-ray': 'abc-LHR' }), true);
  assert.equal(isViaTunnelHeaders({ 'x-forwarded-proto': 'https' }), true);
  assert.equal(isViaTunnelHeaders({}), false);
  assert.equal(isViaTunnelHeaders({ 'x-forwarded-proto': 'http' }), false);
});
