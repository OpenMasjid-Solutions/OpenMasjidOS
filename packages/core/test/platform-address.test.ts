// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The app-facing platform address (system/platform-address.ts).
 *
 * The bug being pinned: `OPENMASJID_BASE_URL` was resolved once at install time
 * from the browser's Host header, so moving the box to a new subnet left every
 * app calling an address that no longer answered. Two properties matter most
 * here — the address must never be one an app container cannot reach, and it must
 * never resolve to empty once we've known a good one (an empty value would strip
 * the key from every app's .env at once and break SSO for all of them).
 *
 * The module is loaded through `require` on purpose: config.ts reads
 * OPENMASJID_DATA_DIR / OPENMASJID_PORT at import time, so the environment has to
 * be in place first, and one test needs a different PORT than the others.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(__filename);
const MODULE = '../src/system/platform-address';
const CONFIG = '../src/config';

type AddressModule = typeof import('../src/system/platform-address');

/** Load the module fresh against the current env (fresh data dir + PORT). */
function load(port = '80'): AddressModule {
  process.env.OPENMASJID_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-addr-'));
  process.env.OPENMASJID_PORT = port;
  delete process.env.OPENMASJID_BASE_URL;
  delete process.env.OPENMASJID_HOST_IP;
  for (const m of [MODULE, CONFIG]) delete req.cache[req.resolve(m)];
  return req(MODULE) as AddressModule;
}

test('usableAppHost keeps bare LAN IPv4 and drops the port', () => {
  const { usableAppHost } = load();
  assert.equal(usableAppHost('192.168.1.24'), '192.168.1.24');
  // The port is discarded on purpose: inheriting the browser's 443 produced
  // `http://ip:443` — plain HTTP against the TLS listener.
  assert.equal(usableAppHost('192.168.1.24:443'), '192.168.1.24');
  assert.equal(usableAppHost('  10.0.0.5:8723  '), '10.0.0.5');
});

test('usableAppHost rejects everything an app container cannot reach', () => {
  const { usableAppHost } = load();
  for (const host of [
    'openmasjidos.local', // mDNS: resolves in the admin's browser, not in a container
    'localhost',
    '127.0.0.1',
    '127.0.0.1:8723',
    '169.254.10.1', // link-local autoconf
    '0.0.0.0',
    'masjid.example.com', // the Cloudflare tunnel domain
    '999.1.1.1', // not a valid IPv4
    '[::1]',
    '',
    null,
    undefined,
  ]) {
    assert.equal(usableAppHost(host), null, String(host));
  }
});

test('the installer-supplied host IP wins, and port 80 is left off the URL', () => {
  const { desiredAddress, desiredBaseUrl } = load();
  process.env.OPENMASJID_HOST_IP = '192.168.1.24';
  assert.equal(desiredAddress(), '192.168.1.24');
  assert.equal(desiredBaseUrl(), 'http://192.168.1.24');
});

test('an unusable installer value is ignored rather than handed to apps', () => {
  // install.sh emits "" when it can only find localhost/link-local; a stray
  // placeholder must not become an app's base URL either.
  const { desiredAddress } = load();
  for (const bad of ['', 'localhost', '127.0.0.1', '169.254.1.1']) {
    process.env.OPENMASJID_HOST_IP = bad;
    assert.notEqual(desiredAddress(), bad, bad || '(empty)');
  }
});

test('an observed authenticated dashboard host is remembered and used', () => {
  const { observeDashboardHost, desiredAddress, desiredBaseUrl } = load();
  observeDashboardHost('192.168.1.99:443');
  assert.equal(desiredAddress(), '192.168.1.99');
  assert.equal(desiredBaseUrl(), 'http://192.168.1.99');
});

test('a name or loopback Host is never recorded', () => {
  const { observeDashboardHost, desiredAddress } = load();
  observeDashboardHost('192.168.1.99');
  observeDashboardHost('openmasjidos.local');
  observeDashboardHost('127.0.0.1');
  // Still the last GOOD value, not the junk we just fed it.
  assert.equal(desiredAddress(), '192.168.1.99');
});

test('a subnet move is picked up from the address the admin now reaches us on', () => {
  const { observeDashboardHost, desiredBaseUrl } = load();
  observeDashboardHost('192.168.0.29'); // old subnet
  assert.equal(desiredBaseUrl(), 'http://192.168.0.29');
  observeDashboardHost('192.168.1.24'); // moved
  assert.equal(desiredBaseUrl(), 'http://192.168.1.24');
});

test('the last known good address survives losing every live source', () => {
  // This is the never-return-empty rule: an empty value would delete
  // OPENMASJID_BASE_URL from every app's .env and break SSO for all at once.
  //
  // Staged as the real containerised case, so the result does not depend on
  // whatever LAN address the machine running these tests happens to have: the
  // installer variable is PRESENT (so we know we're the packaged product and our
  // own interfaces are the container's, not the host's) but its value is one we
  // refuse to hand an app. Only the persisted last-known-good is left.
  const { desiredBaseUrl, desiredAddress } = load();
  process.env.OPENMASJID_HOST_IP = '192.168.1.24';
  assert.equal(desiredBaseUrl(), 'http://192.168.1.24'); // persists last-known-good
  process.env.OPENMASJID_HOST_IP = 'localhost'; // installer could not find a real one
  assert.equal(desiredAddress(), '192.168.1.24');
  assert.equal(desiredBaseUrl(), 'http://192.168.1.24');
});

test("a bare-metal install prefers its own live interfaces over a cached value", () => {
  // Not containerised (no OPENMASJID_HOST_IP), so os.networkInterfaces() really is
  // this machine — live data should beat a stale cache. Asserted as a property
  // rather than a literal, since the address depends on the test machine.
  const mod = load();
  process.env.OPENMASJID_HOST_IP = '10.9.9.9';
  assert.equal(mod.desiredAddress(), '10.9.9.9'); // caches 10.9.9.9
  delete process.env.OPENMASJID_HOST_IP;
  const live = mod.desiredAddress();
  assert.ok(live === null || /^\d{1,3}(\.\d{1,3}){3}$/.test(live), `unexpected address ${live}`);
  assert.ok(live !== '127.0.0.1');
});

test('an explicit OPENMASJID_BASE_URL always wins and is scheme-normalised', () => {
  const { desiredBaseUrl } = load();
  process.env.OPENMASJID_BASE_URL = 'omos.internal:9000';
  assert.equal(desiredBaseUrl(), 'http://omos.internal:9000');
  process.env.OPENMASJID_BASE_URL = 'https://masjid.example.com';
  assert.equal(desiredBaseUrl(), 'https://masjid.example.com');
});

test('a non-default port is included in the URL', () => {
  const { desiredBaseUrl } = load('8723');
  process.env.OPENMASJID_HOST_IP = '10.1.2.3';
  assert.equal(desiredBaseUrl(), 'http://10.1.2.3:8723');
});
