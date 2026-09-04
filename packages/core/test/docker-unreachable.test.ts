// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * "Could not ask Docker" must never be reported as "there is nothing there".
 *
 * THE OUTAGE THIS EXISTS FOR: a masjid's public site intermittently answered
 * `{"error":"Not found."}` to every visitor for a few seconds at a time, on every app at
 * once, then healed itself. The cause was one line: `discoverApps()` caught a Docker
 * failure and returned an EMPTY MAP, indistinguishable from a healthy daemon reporting no
 * containers.
 *
 * From there it fanned out. `listInstalled()` still listed every app — from meta.json —
 * but with `ports: []` and `running: false`, because that was all it knew. `ingress.ts`
 * rebuilt its routing table, dropped every app for having no port, and 404'd the public
 * site until the next tick ten seconds later. Its `catch` was written to prevent exactly
 * that and never fired: nothing threw. `alert-monitor.ts` had the same shape of guard and
 * the same hole, and would have emailed an "app went offline" alert for every installed
 * app on the same hiccup.
 *
 * The rule is CLAUDE.md §13.2d's, the one the Stripe and WhatsApp monitors already follow:
 * a failure to ask records nothing and decides nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.OPENMASJID_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-docker-'));

const req = createRequire(__filename);
const client = req('../src/docker/client') as { docker: { listContainers: unknown } };
const discovery = req('../src/docker/discovery') as typeof import('../src/docker/discovery');

const SRC = path.join(__dirname, '..', 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

/** Swap Docker's container list for the duration of one call. */
async function withDocker<T>(impl: () => Promise<unknown>, fn: () => Promise<T>): Promise<T> {
  const original = client.docker.listContainers;
  client.docker.listContainers = impl;
  try {
    return await fn();
  } finally {
    client.docker.listContainers = original;
  }
}

const RUNNING_APP = [
  {
    Labels: { 'com.docker.compose.project': 'omos-donations' },
    State: 'running',
    Ports: [{ PublicPort: 8081, PrivatePort: 80, Type: 'tcp' }],
  },
];

test('AN UNREACHABLE DOCKER IS REPORTED AS SUCH, not as an empty machine', async () => {
  const r = await withDocker(
    () => Promise.reject(new Error('connect ENOENT /var/run/docker.sock')),
    () => discovery.discoverAppsResult(),
  );
  assert.equal(r.ok, false, 'a daemon that could not be asked must say so');
  assert.equal(r.apps.size, 0);
});

test('a healthy daemon with no containers is a real answer, and says ok', async () => {
  const r = await withDocker(
    () => Promise.resolve([]),
    () => discovery.discoverAppsResult(),
  );
  // The whole point: this is the SAME empty map as above, and it means something
  // completely different.
  assert.equal(r.ok, true);
  assert.equal(r.apps.size, 0);
});

test('a healthy daemon with an app reports it, and says ok', async () => {
  const r = await withDocker(
    () => Promise.resolve(RUNNING_APP),
    () => discovery.discoverAppsResult(),
  );
  assert.equal(r.ok, true);
  const app = r.apps.get('omos-donations');
  assert.ok(app, 'the app must be discovered');
  assert.equal(app!.running, true);
  assert.deepEqual(app!.ports, [8081]);
});

test('listInstalledWithHealth passes the failure through, rather than hiding it', async () => {
  const manager = req('../src/apps/manager') as typeof import('../src/apps/manager');
  const bad = await withDocker(
    () => Promise.reject(new Error('docker is busy')),
    () => manager.listInstalledWithHealth(),
  );
  assert.equal(bad.discoveryOk, false);
  const good = await withDocker(
    () => Promise.resolve([]),
    () => manager.listInstalledWithHealth(),
  );
  assert.equal(good.discoveryOk, true);
});

// ── the two consumers that must not act on an unknown ────────────────────────────

test('INGRESS KEEPS ITS ROUTES when Docker cannot be read', () => {
  // Behavioural coverage of the rebuild loop needs a live Fastify front door; what matters
  // and what regressed is the decision, so that is what is pinned.
  const src = read('system', 'ingress.ts');
  const rebuild = src.slice(src.indexOf('async function rebuild'), src.indexOf('/** Is the OS actually routing'));
  assert.match(rebuild, /listInstalledWithHealth/, 'the rebuild must ask whether Docker was readable');
  const guard = rebuild.indexOf('if (!discoveryOk)');
  const assign = rebuild.indexOf('routes = next');
  assert.ok(guard > 0, 'there must be an explicit guard');
  assert.ok(guard < assign, 'and it must return BEFORE the table is replaced');
  assert.match(rebuild.slice(guard, assign), /return;/, 'keeping the previous table means returning early');
});

test('THE OFFLINE ALERT DOES NOT FIRE for every app because Docker blinked', () => {
  const src = read('system', 'alert-monitor.ts');
  const tick = src.slice(src.indexOf('async function tick'), src.indexOf('export function startAlertMonitor'));
  assert.match(tick, /discoveryOk/, 'the monitor must know whether the reading is real');
  const guard = tick.indexOf('if (!r.discoveryOk) return;');
  const loop = tick.indexOf('for (const a of apps)');
  assert.ok(guard > 0 && loop > 0 && guard < loop, 'bail out before deciding anything is offline');
});

test('the lossy helper is still available, but only for display', () => {
  // `runningProjectCount` and the app list can tolerate a blank moment; routing and
  // alerting cannot. Keeping both, with the difference documented, is the point.
  const src = read('docker', 'discovery.ts');
  assert.match(src, /export async function discoverApps\(/);
  assert.match(src, /export async function discoverAppsResult\(/);
  assert.match(src, /couldn't ask" is never an answer|could not be ASKED/i, 'the reason must be recorded at the site');
});
