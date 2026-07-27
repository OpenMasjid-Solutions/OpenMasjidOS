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
import { isFabricSubpath } from '../src/system/ingress';

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

test('a percent-encoded path cannot smuggle a secret route past the guard', async () => {
  // The router matches the DECODED path, so comparing the raw `req.url` let
  // `/api/%66abric/...` walk straight through the guard and into the app-to-app
  // broker. Every escaped spelling of a secret route must still be refused.
  const app = await guarded();
  for (const url of [
    '/api/%66abric/site',
    '/api/%66abric/app/students/billing/lookup',
    '/api/%61uth/session',
    '/api/fabric/%73ite',
    '/api/%66%61bric/site',
  ]) {
    const res = await app.inject({ method: 'GET', url, headers: { 'cf-ray': 'abc' } });
    assert.equal(res.statusCode, 404, `${url} must not be reachable over the tunnel`);
  }
  await app.close();
});

test('a malformed percent-escape does not throw away the rest of the path', async () => {
  // `decodeURIComponent('/api/%zz/fabric')` throws; if that killed the whole
  // comparison the guard would fall open. Decoding is per-escape for this reason.
  const app = await guarded();
  const res = await app.inject({ method: 'GET', url: '/api/fabric/site?bad=%zz', headers: { 'cf-ray': 'abc' } });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('every real spelling of x-forwarded-proto: https counts as tunnel traffic', async () => {
  // Node joins duplicated headers with ", " and a chained proxy appends its own
  // hop, so an exact === 'https' comparison was evadable.
  const app = await guarded();
  for (const proto of ['https', 'HTTPS', 'https,http', 'https, http', ' https ']) {
    const res = await app.inject({
      method: 'GET',
      url: '/api/fabric/site',
      headers: { 'x-forwarded-proto': proto },
    });
    assert.equal(res.statusCode, 404, `x-forwarded-proto: ${JSON.stringify(proto)}`);
  }
  // ...but a plain LAN request over http is still allowed through.
  const lan = await app.inject({ method: 'GET', url: '/api/fabric/site', headers: { 'x-forwarded-proto': 'http' } });
  assert.equal(lan.statusCode, 200);
  await app.close();
});

test("an app's own /fabric space is refused over the tunnel, encoded or not", async () => {
  // Same decoding gap on the ingress path: we forward req.url verbatim, so the
  // app would resolve %66 itself and serve a LAN-only route publicly.
  for (const url of ['/donate/fabric', '/donate/fabric/billing', '/donate/%66abric/billing', '//donate/fabric/x']) {
    assert.equal(isFabricSubpath(url, 'donate'), true, url);
  }
  for (const url of ['/donate', '/donate/checkout', '/donate/fabrications', '/donate/api/fabric']) {
    assert.equal(isFabricSubpath(url, 'donate'), false, url);
  }
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
