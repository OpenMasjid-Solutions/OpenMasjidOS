// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Regression tests for a review of the Fabric, mail, alerts and their monitors — each
 * one pinned against the real code path rather than a description of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-fabric-fixes-'));
process.env.OPENMASJID_DATA_DIR = DATA;

const req = createRequire(__filename);
const Fastify = req('fastify') as typeof import('fastify').default;
const fabric = req('../src/api/fabric') as typeof import('../src/api/fabric');
const manager = req('../src/apps/manager') as typeof import('../src/apps/manager');

const BUS = '172.17.0.1'; // what EVERY app presents, behind Docker's published port

function installApp(id: string, secret: string, caps: Record<string, boolean>): void {
  const dir = path.join(DATA, 'apps', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, name: id, kind: 'catalog', ssoSecret: secret, ...caps }));
  manager.invalidateFabricIndex();
}

const POLLER = `poller-secret-${'p'.repeat(40)}`;
const SENDER = `sender-secret-${'s'.repeat(40)}`;
installApp('poller', POLLER, { whatsapp: true });
installApp('sender', SENDER, { notify: true });

async function fabricServer() {
  const app = Fastify();
  fabric.registerFabric(app);
  await app.ready();
  return app;
}

const notify = (app: Awaited<ReturnType<typeof fabricServer>>, secret: string | null) =>
  app.inject({
    method: 'POST',
    url: '/api/fabric/notify',
    remoteAddress: BUS,
    headers: { 'content-type': 'application/json', ...(secret ? { 'x-openmasjid-app-secret': secret } : {}) },
    payload: { text: 'hello' },
  });

// ── the per-IP bucket every app shares ───────────────────────────────────────────

test("ONE APP'S ALLOWED TRAFFIC CANNOT REFUSE ANOTHER APP'S CALLS", async () => {
  // Every route charged identified apps to the per-IP bucket too, and every app arrives
  // from the same address: one app polling its message outcomes at its allowed rate
  // emptied it, and every other app's email, WhatsApp, alerts and Stripe calls got 429.
  fabric.__resetFabricRateForTests();
  const app = await fabricServer();
  try {
    let polled = 0;
    for (let i = 0; i < 605; i++) {
      const r = await app.inject({
        method: 'GET',
        url: '/api/fabric/whatsapp/status/no-such-message',
        remoteAddress: BUS,
        headers: { 'x-openmasjid-app-secret': POLLER },
      });
      if (r.statusCode === 404) polled++;
    }
    assert.ok(polled >= 600, `precondition: the poller used its whole read budget (${polled})`);
    const r = await notify(app, SENDER);
    assert.notEqual(r.statusCode, 429, "another app's polling refused this app's notification");
  } finally {
    await app.close();
  }
});

test('a caller with no valid secret is still bounded by the shared tier', async () => {
  fabric.__resetFabricRateForTests();
  const app = await fabricServer();
  try {
    let last = 0;
    for (let i = 0; i < 605; i++) last = (await notify(app, null)).statusCode;
    assert.equal(last, 429, 'an unidentified flood must still be refused');
    // ...and an identified app is not refused by that flood.
    assert.notEqual((await notify(app, SENDER)).statusCode, 429);
  } finally {
    await app.close();
  }
});
