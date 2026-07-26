// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The secret-gated Fabric routes are LAN-only (CLAUDE.md §15). Registered routes
 * skip the front door's notFoundHandler, so the ONLY thing keeping them off the
 * internet is registerFabricTunnelGuard — and it has to be on EVERY listener that
 * serves them, not just the one the tunnel happens to point at today. These tests
 * pin the guard's behaviour and the "both listeners" wiring.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { registerFabricTunnelGuard } from '../src/system/via-tunnel';

async function guarded() {
  const app = Fastify();
  registerFabricTunnelGuard(app);
  app.get('/api/fabric/site', async () => ({ ok: true }));
  app.get('/api/fabric/app/students/billing/lookup', async () => ({ ok: true }));
  app.get('/api/auth/session', async () => ({ ok: true }));
  app.get('/api/public/appearance', async () => ({ ok: true }));
  await app.ready();
  return app;
}

test('LAN requests reach the secret Fabric routes', async () => {
  const app = await guarded();
  for (const url of ['/api/fabric/site', '/api/fabric/app/students/billing/lookup', '/api/auth/session']) {
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 200, url);
  }
  await app.close();
});

test('tunnel-origin requests get 404 on every secret Fabric route', async () => {
  const app = await guarded();
  const tunnelHeaders = [{ 'cf-ray': 'abc123-LHR' }, { 'x-forwarded-proto': 'https' }];
  for (const headers of tunnelHeaders) {
    for (const url of [
      '/api/fabric/site',
      '/api/fabric/app/students/billing/lookup', // the app-to-app broker
      '/api/auth/session',
    ]) {
      const res = await app.inject({ method: 'GET', url, headers });
      assert.equal(res.statusCode, 404, `${url} with ${JSON.stringify(headers)}`);
    }
  }
  await app.close();
});

test('the intentionally-public appearance route still works over the tunnel', async () => {
  const app = await guarded();
  const res = await app.inject({ method: 'GET', url: '/api/public/appearance', headers: { 'cf-ray': 'abc' } });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test('a query string cannot smuggle a secret route past the guard', async () => {
  const app = await guarded();
  const res = await app.inject({ method: 'GET', url: '/api/fabric/site?x=1', headers: { 'cf-ray': 'abc' } });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('index.ts applies the guard to BOTH listeners, not just the HTTP front door', () => {
  // A structural check on purpose: the bug this pins (the TLS server registering
  // the Fabric routes WITHOUT the guard) is invisible to a unit test of the guard
  // itself, and only becomes exploitable when someone points a Cloudflare route
  // at :443. Both `registerFabric(...)` calls must be matched by a guard call.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  const registrations = src.match(/registerFabric\(/g)?.length ?? 0;
  const guards = src.match(/registerFabricTunnelGuard\(/g)?.length ?? 0;
  assert.ok(registrations >= 2, `expected the Fabric routes on both listeners, found ${registrations}`);
  assert.ok(
    guards >= registrations,
    `every listener serving /api/fabric must also carry the LAN-only guard (${guards} guards for ${registrations} registrations)`,
  );
});
