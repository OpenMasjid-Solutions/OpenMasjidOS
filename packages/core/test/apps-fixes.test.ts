// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Fixes to the apps manager (apps/manager.ts). Each test says what it holds the manager
 * to; the ones that reach `docker` use a stand-in that runs nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-apps-fixes-'));
process.env.OPENMASJID_DATA_DIR = DATA;

// A stand-in docker: runs nothing, and exits with FAKE_DOCKER_EXIT (0 unless a test says).
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-fake-docker-'));
fs.writeFileSync(
  path.join(BIN, 'docker'),
  '#!/bin/sh\n[ "${FAKE_DOCKER_EXIT:-0}" = 0 ] || echo "Error response from daemon: refused" >&2\nexit "${FAKE_DOCKER_EXIT:-0}"\n',
  { mode: 0o755 },
);
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;
const needsShell = { skip: process.platform === 'win32' && 'needs a POSIX shell for the stand-in docker' };

const req = createRequire(__filename);
const manager = req('../src/apps/manager') as typeof import('../src/apps/manager');
const settings = req('../src/settings/store') as typeof import('../src/settings/store');
const { log } = req('../src/logger') as typeof import('../src/logger');
const { isOfflineSuppressed } = req('../src/system/offline-suppress') as typeof import('../src/system/offline-suppress');
const client = req('../src/docker/client') as { docker: { listContainers: unknown } };

const APPS = path.join(DATA, 'apps');
const envOf = (id: string) => fs.readFileSync(path.join(APPS, id, '.env'), 'utf8');
const metaOf = (id: string) => JSON.parse(fs.readFileSync(path.join(APPS, id, 'meta.json'), 'utf8'));

/** Lay down an installed app's files. */
function seed(id: string, meta: Record<string, unknown> = {}, env?: string): void {
  fs.mkdirSync(path.join(APPS, id), { recursive: true });
  fs.writeFileSync(path.join(APPS, id, 'compose.yml'), 'services: {}\n');
  fs.writeFileSync(
    path.join(APPS, id, 'meta.json'),
    JSON.stringify({ id, name: id, kind: 'catalog', createdAt: '2026-01-01T00:00:00.000Z', ...meta }),
  );
  if (env !== undefined) fs.writeFileSync(path.join(APPS, id, '.env'), env);
}

// ── Reading one app costs one app ─────────────────────────────────────────────

test("ONE APP'S ROW IS THE ROW THE FULL LISTING GIVES — without reading every app", async () => {
  seed('running-app', { icon: 'https://example.org/i.png', category: 'displays', sso: true });
  seed('stopped-app', { kind: 'custom' });
  seed('https-app', { https: true, httpsPort: 9443, exposed: false });
  seed('held-app', { review: { kind: 'danger', reasons: ['It asks for privileged mode.'], at: '2026-01-01T00:00:00.000Z' } });
  seed('pathed-app', { path: 'give' });
  seed('cloudflared');
  const containers = [
    { Labels: { 'com.docker.compose.project': 'omos-running-app' }, State: 'running', Ports: [{ PublicPort: 8443 }, { PublicPort: 8081 }] },
    { Labels: { 'com.docker.compose.project': 'omos-stopped-app' }, State: 'exited', Ports: [] },
    { Labels: { 'com.docker.compose.project': 'omos-https-app' }, State: 'running', Ports: [{ PublicPort: 8090 }] },
    { Labels: { 'com.docker.compose.project': 'omos-orphan-app' }, State: 'running', Ports: [{ PublicPort: 8070 }] },
    { Labels: { 'com.docker.compose.project': 'omos-cloudflared' }, State: 'running', Ports: [] },
  ];
  const original = client.docker.listContainers;
  client.docker.listContainers = () => Promise.resolve(containers);
  try {
    await manager.listInstalled(); // recovers the orphan, as the dashboard's first listing would
    const all = await manager.listInstalled();
    for (const id of ['running-app', 'stopped-app', 'https-app', 'held-app', 'pathed-app', 'orphan-app', 'cloudflared', 'nothing']) {
      assert.deepEqual(await manager.getInstalled(id), all.find((a) => a.id === id) ?? null, id);
    }
    assert.equal(await manager.getInstalled('cloudflared'), null, "the platform's own tunnel is never an app");
    assert.deepEqual((await manager.getInstalled('running-app'))?.ports, [8081, 8443]);
  } finally {
    client.docker.listContainers = original;
  }
});

test('the alert check follows the Fabric index, which follows every change to an app', () => {
  seed('alerting', { ssoSecret: 'a'.repeat(43), appAlerts: [{ id: 'reader-offline', label: 'Reader offline' }] });
  seed('secretless', { appAlerts: [{ id: 'reader-offline', label: 'Reader offline' }] });
  manager.invalidateFabricIndex();
  assert.equal(manager.appDeclaresAlert('alerting', 'reader-offline'), true);
  assert.equal(manager.appDeclaresAlert('alerting', 'something-else'), false);
  assert.equal(manager.appDeclaresAlert('secretless', 'reader-offline'), false, 'it cannot call the route at all');
  assert.equal(manager.appDeclaresAlert('nothing', 'reader-offline'), false);

  // An update that withdraws the alert saves the record, and that drops the index.
  seed('alerting', { ssoSecret: 'a'.repeat(43), appAlerts: [] });
  manager.setExposed('alerting', false);
  assert.equal(manager.appDeclaresAlert('alerting', 'reader-offline'), false);

  // One unreadable entry must not take every app's Fabric lookups down with it.
  seed('mangled', { ssoSecret: 'm'.repeat(43), appAlerts: [null, { id: 'ok-alert' }] });
  manager.invalidateFabricIndex();
  assert.equal(manager.appDeclaresAlert('mangled', 'ok-alert'), true);
  assert.ok(manager.findFabricApp('a'.repeat(43)));
});

// ── What Docker refused is reported ───────────────────────────────────────────

test('A REFUSED START, STOP OR RESTART IS REPORTED, NEVER CALLED A SUCCESS', needsShell, async () => {
  seed('stubborn');
  const plainWords = (verb: string) => (err: Error) => {
    assert.match(err.message, new RegExp(`couldn't be ${verb}`));
    assert.doesNotMatch(err.message, /daemon/, "Docker's own words stay in the log");
    return true;
  };
  process.env.FAKE_DOCKER_EXIT = '1';
  try {
    await assert.rejects(() => manager.stopApp('stubborn'), plainWords('stopped'));
    await assert.rejects(() => manager.startApp('stubborn'), plainWords('started'));
    await assert.rejects(() => manager.restartApp('stubborn'), plainWords('restarted'));
    // An app with no compose file of ours is started with `compose start` instead.
    fs.rmSync(path.join(APPS, 'stubborn', 'compose.yml'));
    await assert.rejects(() => manager.startApp('stubborn'), plainWords('started'));
  } finally {
    delete process.env.FAKE_DOCKER_EXIT;
  }
  // And when Docker does what was asked, nothing is said.
  await manager.startApp('stubborn');
  await manager.stopApp('stubborn');
  await manager.restartApp('stubborn');
});

test('REMOVING AN APP IS NOT AN OUTAGE — no "has stopped" alert while it goes', needsShell, async () => {
  seed('leaving');
  assert.equal(isOfflineSuppressed('leaving'), false);
  await manager.removeApp('leaving');
  assert.equal(isOfflineSuppressed('leaving'), true);
  // Held from before `compose down` starts, which is when it stops.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'apps', 'manager.ts'), 'utf8');
  const body = src.slice(src.indexOf('export async function removeApp('));
  assert.ok(body.indexOf('suppressOfflineAlert(id)') < body.indexOf('composeDown('));
});
