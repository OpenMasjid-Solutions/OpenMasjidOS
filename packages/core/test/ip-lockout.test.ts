// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The per-IP sign-in lockout, which exists for tunnel traffic and nothing else.
 *
 * The dashboard's older lockout is global and off by default because behind
 * Docker's port publishing every LAN client is SNATed to the bridge gateway, so
 * locking "an IP" would lock everyone including the real admin (`util/net.ts`,
 * `test/ip-private.test.ts`). Cloudflare's `CF-Connecting-IP` is the one address
 * this platform can believe — set at their edge, unforgeable by a tunnel client
 * — so remote sign-ins get the better control.
 *
 * The rule the tests below exist to hold: **an address is only ever trusted when
 * the request came through the tunnel.** That is enforced in `trpc/context.ts`,
 * which passes `null` off-tunnel, and `null` must do nothing here — because if
 * a LAN client's typed header reached this module it would be both a bypass
 * (vary the header, dodge the counter) and a weapon (claim to be someone else's
 * address and fail ten sign-ins to lock them out).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const req = createRequire(__filename);
const L = req('../src/auth/ip-lockout') as typeof import('../src/auth/ip-lockout');

const T = 1_700_000_000_000;
const IP = '203.0.113.7';

test('null is never locked out and is never recorded', () => {
  // Off the tunnel there is no address worth believing, so this module must be
  // inert rather than quietly counting every LAN attempt into one bucket.
  L.clearAllIpFailures();
  for (let i = 0; i < L.IP_MAX_FAILURES * 3; i++) L.noteIpFailure(null, T);
  assert.equal(L.ipLockedOut(null, T), false);
  assert.equal(L.trackedIpCount(), 0, 'null must not create an entry');
});

test('an address is locked out only at the threshold', () => {
  L.clearAllIpFailures();
  for (let i = 0; i < L.IP_MAX_FAILURES - 1; i++) {
    L.noteIpFailure(IP, T);
    assert.equal(L.ipLockedOut(IP, T), false, `after ${i + 1} failures`);
  }
  L.noteIpFailure(IP, T);
  assert.equal(L.ipLockedOut(IP, T), true, `after ${L.IP_MAX_FAILURES} failures`);
  assert.ok(L.ipLockoutRemaining(IP, T) > 0);
});

test('the lockout lifts on its own', () => {
  L.clearAllIpFailures();
  for (let i = 0; i < L.IP_MAX_FAILURES; i++) L.noteIpFailure(IP, T);
  assert.equal(L.ipLockedOut(IP, T + L.IP_LOCKOUT_MS - 1), true);
  assert.equal(L.ipLockedOut(IP, T + L.IP_LOCKOUT_MS + 1), false);
});

test('ONE ADDRESS CANNOT LOCK OUT ANOTHER', () => {
  // The whole reason a per-IP counter is acceptable here and a global one is
  // not. If this failed, a guesser could deny the admin rather than only
  // themselves — which is the objection that keeps the global lockout off.
  L.clearAllIpFailures();
  for (let i = 0; i < L.IP_MAX_FAILURES * 2; i++) L.noteIpFailure('198.51.100.9', T);
  assert.equal(L.ipLockedOut('198.51.100.9', T), true);
  assert.equal(L.ipLockedOut(IP, T), false, "the admin's address must be untouched");
});

test('failures spread thinly never accumulate into a lockout', () => {
  // Ten typos over a week is a real admin, not an attack.
  L.clearAllIpFailures();
  let now = T;
  for (let i = 0; i < L.IP_MAX_FAILURES * 2; i++) {
    L.noteIpFailure(IP, now);
    assert.equal(L.ipLockedOut(IP, now), false, `attempt ${i + 1}`);
    now += L.IP_WINDOW_MS + 1;
  }
});

test('a successful sign-in clears the history', () => {
  L.clearAllIpFailures();
  for (let i = 0; i < L.IP_MAX_FAILURES - 1; i++) L.noteIpFailure(IP, T);
  L.clearIpFailures(IP);
  assert.equal(L.trackedIpCount(), 0);
  L.noteIpFailure(IP, T);
  assert.equal(L.ipLockedOut(IP, T), false, 'the count must start again from one');
});

test('THE MAP IS BOUNDED — a spray cannot grow memory without limit', () => {
  // Keyed by something the internet chooses, on a daemon running as root. The
  // same class of unauthenticated resource lever that `system/ingress.ts`
  // destroys abandoned WebSocket upgrades to avoid.
  L.clearAllIpFailures();
  for (let i = 0; i < L.IP_MAX_TRACKED * 2; i++) {
    L.noteIpFailure(`203.0.113.${i}`, T + i);
  }
  assert.ok(
    L.trackedIpCount() <= L.IP_MAX_TRACKED,
    `tracked ${L.trackedIpCount()} addresses, cap is ${L.IP_MAX_TRACKED}`,
  );
});

test('a locked-out address survives the sweep that bounds the map', () => {
  // Eviction must not be a way to clear your own lockout by spraying. The most
  // recently seen entries are kept, and a live lockout was by definition seen
  // recently — so the entry that matters is the last one dropped, not the first.
  L.clearAllIpFailures();
  for (let i = 0; i < L.IP_MAX_FAILURES; i++) L.noteIpFailure(IP, T + L.IP_MAX_TRACKED + i);
  assert.equal(L.ipLockedOut(IP, T + L.IP_MAX_TRACKED), true);
  // Now spray from older timestamps: these are less recent, so they go first.
  for (let i = 0; i < L.IP_MAX_TRACKED; i++) L.noteIpFailure(`198.51.100.${i}`, T + i);
  assert.equal(L.ipLockedOut(IP, T + L.IP_MAX_TRACKED), true, 'the lockout was evicted by a spray');
});
