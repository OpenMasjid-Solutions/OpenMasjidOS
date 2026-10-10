// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * One address, one app.
 *
 * Two installed apps could answer to the same path and nothing said so: the routing table kept
 * whichever it met last. Once every app with a web port was in that table (so the admin can open
 * private apps from outside), an app nobody had shared could take a SHARED app's public page —
 * the masjid's donations page a 404 for every donor, with Settings still showing it as shared.
 * `setAppPath` refuses the duplicate up front; system/ingress.ts `placeRoute` keeps a shared app's
 * path for installs that already have one (pinned in remote-apps.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-app-paths-'));
process.env.OPENMASJID_DATA_DIR = DATA;

// Installing reaches `docker compose up`; this docker says yes and runs nothing.
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-fake-docker-'));
fs.writeFileSync(path.join(BIN, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;
const POSIX = process.platform !== 'win32';

const req = createRequire(__filename);
const manager = req('../src/apps/manager') as typeof import('../src/apps/manager');
const settings = req('../src/settings/store') as typeof import('../src/settings/store');

for (const id of ['donations', 'old-donations', 'display']) {
  fs.mkdirSync(path.join(DATA, 'apps', id), { recursive: true });
  fs.writeFileSync(
    path.join(DATA, 'apps', id, 'meta.json'),
    JSON.stringify({ id, name: id, kind: 'catalog', createdAt: '2026-01-01T00:00:00.000Z' }),
  );
}

test('TWO APPS CANNOT ANSWER TO ONE ADDRESS', () => {
  assert.equal(manager.setAppPath('donations', 'donate'), 'donate');
  assert.throws(() => manager.setAppPath('old-donations', 'Donate'), /Another app already uses \/donate/, 'the same path in another spelling');
  assert.throws(() => manager.setAppPath('old-donations', 'display'), /Another app already uses \/display/, "another app's DEFAULT path (its id)");
  assert.equal(manager.getAppPath('old-donations'), 'old-donations', 'a refused path must not be saved');
});

test('an app may keep, change, or reset its own path', () => {
  assert.equal(manager.setAppPath('donations', 'donate'), 'donate', 'setting the path it already has');
  assert.equal(manager.setAppPath('donations', 'give'), 'give');
  assert.equal(manager.setAppPath('old-donations', 'donate'), 'donate', 'a path freed by another app can be taken');
  assert.equal(manager.setAppPath('donations', ''), 'donations', 'blank resets to its id');
});

test('AN APP CANNOT BE GIVEN AN ADDRESS THE PLATFORM KEEPS FOR ITSELF', () => {
  // Accepted without a word, an app at /api had no public page at all — the ingress
  // never routes those — and opening it from outside landed on a 404.
  for (const p of ['api', 'API', 'trpc', 'assets', '/assets/']) {
    assert.throws(() => manager.setAppPath('donations', p), /used by OpenMasjidOS itself/, p);
  }
  assert.equal(manager.getAppPath('donations'), 'donations', 'a refused address must not be saved');
  // ONE list, read by the router and by Settings — not two that can drift.
  const ingress = fs.readFileSync(path.join(__dirname, '..', 'src', 'system', 'ingress.ts'), 'utf8');
  assert.match(ingress, /isReservedPathSegment\(seg\)/);
  assert.doesNotMatch(ingress, /new Set\(\['api'/, 'the ingress keeps its own copy of the list again');
});

test('ONLY THE SHAPE OF AN APP PATH IS EVER ROUTED — never the platform’s own /_omos', () => {
  // An app is recovered from any `omos-*` project Docker reports, and Docker allows "_"
  // in a project's name: one started by hand as `omos-_omos` was routed at /_omos, where
  // the platform opens apps from outside.
  const { isAppPathShape } = req('../src/apps/paths') as typeof import('../src/apps/paths');
  for (const ok of ['donations', 'prayer-times', 'a1', 'donations-2']) assert.equal(isAppPathShape(ok), true, ok);
  for (const bad of ['_omos', 'Donations', '-x', 'a_b', 'a.b', '', 'a/b', 'x'.repeat(81)]) {
    assert.equal(isAppPathShape(bad), false, JSON.stringify(bad));
  }
  const ingress = fs.readFileSync(path.join(__dirname, '..', 'src', 'system', 'ingress.ts'), 'utf8');
  assert.match(ingress, /if \(seg && isAppPathShape\(seg\) && !isReservedPathSegment\(seg\)\) \{\s*placeRoute\(/);
});

const install = (id: string, opts: { expose?: boolean } = {}) =>
  manager.installCustomApp({ id, name: id, composeText: 'services: {}\n', env: {}, ...opts });

test(
  'AN INSTALL NEVER TAKES AN ADDRESS ANOTHER APP ANSWERS TO — it gets the next free one',
  { skip: !POSIX && 'needs a POSIX shell for the stand-in docker' },
  async () => {
    // Give display the address /kiosk, then install an app CALLED kiosk. Installs used
    // to take their id regardless: two apps on one address, the newer one serving it,
    // and Settings listing both as published there.
    assert.equal(manager.setAppPath('display', 'kiosk'), 'kiosk');
    await install('kiosk');
    assert.equal(manager.getAppPath('kiosk'), 'kiosk-2', 'the new app took an address display answers to');
    assert.equal(manager.getAppPath('display'), 'kiosk', 'display keeps its address');
    await install('kiosk-3'); // its own id is free: it keeps following its id
    assert.equal(manager.getAppPath('kiosk-3'), 'kiosk-3');
    // An id that is a word the platform keeps gets a number too.
    await install('assets');
    assert.equal(manager.getAppPath('assets'), 'assets-2');
  },
);

test(
  "the address an install is given is the one in the app's own settings",
  { skip: !POSIX && 'needs a POSIX shell for the stand-in docker' },
  async () => {
    settings.updateCloudflare({ enabled: true, domain: 'omos.example.org' });
    manager.setAppPath('old-donations', 'give');
    await manager.installCatalogApp(
      { id: 'give', name: 'Give', version: '1.0.0', compose: 'services: {}\n' } as never,
      {},
      null,
      true,
    );
    assert.equal(manager.getAppPath('give'), 'give-2');
    const env = fs.readFileSync(path.join(DATA, 'apps', 'give', '.env'), 'utf8');
    assert.match(env, /^OPENMASJID_PUBLIC_URL=https:\/\/omos\.example\.org\/give-2$/m, 'the app was told an address it does not have');
  },
);
