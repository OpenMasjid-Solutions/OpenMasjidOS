// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Integration tests for the Fabric app-to-app broker (fabric/appLink.ts). Two
 * dummy apps are simulated: `donations` (caller) → `students` (target). The broker
 * runs on a Fastify instance driven by inject(); the target is a REAL loopback
 * http server so the outbound proxy path is exercised end-to-end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAppLink, type AppLinkDeps } from '../src/fabric/appLink';
import { registerFabricTunnelGuard } from '../src/system/via-tunnel';
import { log } from '../src/logger';
import type { FabricApp } from '../src/apps/manager';

const CALLER_SECRET = 'caller-secret-abcdefghijklmnop';
const TARGET_SECRET = 'target-secret-abcdefghijklmnop';

function fab(p: Partial<FabricApp> & { id: string }): FabricApp {
  return { name: p.id, sso: false, notify: false, stripe: false, domain: false, provides: [], consumes: [], ...p };
}
const caller = fab({ id: 'donations', consumes: ['students/billing'] });
const target = fab({ id: 'students', provides: ['billing'] });

interface TargetRec {
  headers: http.IncomingHttpHeaders;
  url?: string;
  body: string;
}

/** Start a scriptable loopback "app" that records the last request it received. */
function startTarget(
  respond: (rec: TargetRec, res: http.ServerResponse) => void,
): Promise<{ port: number; last: () => TargetRec | null; close: () => Promise<void> }> {
  let last: TargetRec | null = null;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      last = { headers: req.headers, url: req.url, body: Buffer.concat(chunks).toString('utf8') };
      respond(last, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        last: () => last,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/** Build a broker app with sensible defaults + overrides for the case under test. */
function buildBroker(overrides: Partial<AppLinkDeps>, withGuard = false): FastifyInstance {
  const app = Fastify();
  if (withGuard) registerFabricTunnelGuard(app);
  registerAppLink(app, {
    resolveCaller: (s) => (s === CALLER_SECRET ? caller : null),
    getTargetApp: (id) => (id === 'students' ? target : null),
    getTargetSecret: (id) => (id === 'students' ? TARGET_SECRET : null),
    getTarget: async (id) => (id === 'students' ? { running: true, port: 0 } : null),
    targetHost: '127.0.0.1',
    timeoutMs: 10_000,
    rateMax: 60,
    now: () => Date.now(),
    ...overrides,
  });
  return app;
}

function callBroker(app: FastifyInstance, opts: { path: string; secret?: string; body?: unknown; headers?: Record<string, string> }) {
  return app.inject({
    method: 'POST',
    url: opts.path,
    headers: {
      'content-type': 'application/json',
      ...(opts.secret ? { 'x-openmasjid-app-secret': opts.secret } : {}),
      ...(opts.headers ?? {}),
    },
    payload: JSON.stringify(opts.body ?? {}),
  });
}

test('happy path: authorized caller → target 200 passthrough, platform-set identity headers', async () => {
  const t = await startTarget((_rec, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, balance: 4200 }));
  });
  const app = buildBroker({ getTarget: async () => ({ running: true, port: t.port }) });
  const r = await callBroker(app, { path: '/api/fabric/app/students/billing/lookup', secret: CALLER_SECRET, body: { family: 'ismail' } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true, balance: 4200 });
  const seen = t.last()!;
  assert.equal(seen.headers['x-openmasjid-app-secret'], TARGET_SECRET, 'target gets its OWN secret');
  assert.equal(seen.headers['x-openmasjid-caller-app'], 'donations', 'platform sets the caller id');
  assert.deepEqual(JSON.parse(seen.body), { family: 'ismail' }, 'body forwarded verbatim');
  await t.close();
});

test('unauthorized: unknown/missing secret → 401', async () => {
  const app = buildBroker({});
  const r = await callBroker(app, { path: '/api/fabric/app/students/billing/lookup', secret: 'nope-but-long-enough-1234' });
  assert.equal(r.statusCode, 401);
  assert.equal(r.json().fabric_error.code, 'unauthorized');
  const r2 = await callBroker(app, { path: '/api/fabric/app/students/billing/lookup' }); // no secret
  assert.equal(r2.statusCode, 401);
});

test('not_granted: caller lacks the consume grant → 403 (and target existence not revealed)', async () => {
  const app = buildBroker({});
  const r = await callBroker(app, { path: '/api/fabric/app/students/attendance/mark', secret: CALLER_SECRET });
  assert.equal(r.statusCode, 403);
  assert.equal(r.json().fabric_error.code, 'not_granted');
});

test('not_granted: target does not provide the capability → 403', async () => {
  const app = buildBroker({ getTargetApp: () => fab({ id: 'students', provides: [] }) });
  const r = await callBroker(app, { path: '/api/fabric/app/students/billing/lookup', secret: CALLER_SECRET });
  assert.equal(r.statusCode, 403);
  assert.equal(r.json().fabric_error.code, 'not_granted');
});

test('target_not_installed: unknown target → 503', async () => {
  const app = buildBroker({
    getTargetApp: (id) => (id === 'students' ? target : null),
    getTarget: async () => null,
  });
  const r = await callBroker(app, { path: '/api/fabric/app/students/billing/lookup', secret: CALLER_SECRET });
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().fabric_error.code, 'target_not_installed');
});

test('target_unreachable: installed but not running → 503', async () => {
  const app = buildBroker({ getTarget: async () => ({ running: false, port: null }) });
  const r = await callBroker(app, { path: '/api/fabric/app/students/billing/lookup', secret: CALLER_SECRET });
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().fabric_error.code, 'target_unreachable');
});

test('timeout: target too slow → 504 timeout', async () => {
  const t = await startTarget(() => {
    /* never respond */
  });
  const app = buildBroker({ getTarget: async () => ({ running: true, port: t.port }), timeoutMs: 150 });
  const r = await callBroker(app, { path: '/api/fabric/app/students/billing/lookup', secret: CALLER_SECRET });
  assert.equal(r.statusCode, 504);
  assert.equal(r.json().fabric_error.code, 'timeout');
  await t.close();
});

test('payload_too_large: body over 256 KB → 413', async () => {
  const app = buildBroker({});
  const big = { blob: 'x'.repeat(300 * 1024) };
  const r = await callBroker(app, { path: '/api/fabric/app/students/billing/lookup', secret: CALLER_SECRET, body: big });
  assert.equal(r.statusCode, 413);
  assert.equal(r.json().fabric_error.code, 'payload_too_large');
});

test('rate_limited: over the per-caller limit → 429', async () => {
  const t = await startTarget((_rec, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const app = buildBroker({ getTarget: async () => ({ running: true, port: t.port }), rateMax: 1 });
  const ok = await callBroker(app, { path: '/api/fabric/app/students/billing/lookup', secret: CALLER_SECRET });
  assert.equal(ok.statusCode, 200);
  const limited = await callBroker(app, { path: '/api/fabric/app/students/billing/lookup', secret: CALLER_SECRET });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().fabric_error.code, 'rate_limited');
  await t.close();
});

test('tunnel-origin request is blocked by the LAN-only guard → 404', async () => {
  const app = buildBroker({}, /* withGuard */ true);
  const r = await callBroker(app, {
    path: '/api/fabric/app/students/billing/lookup',
    secret: CALLER_SECRET,
    headers: { 'cf-ray': 'abc123-LHR' },
  });
  assert.equal(r.statusCode, 404);
});

test('caller-supplied identity headers aimed at the target are stripped', async () => {
  const t = await startTarget((_rec, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const app = buildBroker({ getTarget: async () => ({ running: true, port: t.port }) });
  await callBroker(app, {
    path: '/api/fabric/app/students/billing/lookup',
    secret: CALLER_SECRET,
    headers: {
      'x-openmasjid-caller-app': 'kiosk-IMPERSONATION',
      'x-forwarded-for': '9.9.9.9',
    },
  });
  const seen = t.last()!;
  assert.equal(seen.headers['x-openmasjid-caller-app'], 'donations', 'caller cannot spoof its id');
  assert.equal(seen.headers['x-openmasjid-app-secret'], TARGET_SECRET, 'caller cannot inject the target secret');
  assert.equal(seen.headers['x-forwarded-for'], undefined, 'client X-Forwarded-* is not relayed');
  await t.close();
});

test('broker never logs request/response bodies', async () => {
  const secretMarker = 'TOP_SECRET_PII_' + 'z'.repeat(20);
  const captured: string[] = [];
  const orig = { info: log.info, warn: log.warn, error: log.error, debug: log.debug };
  for (const k of ['info', 'warn', 'error', 'debug'] as const) {
    (log as unknown as Record<string, (...a: unknown[]) => void>)[k] = (...a: unknown[]) => captured.push(a.map(String).join(' '));
  }
  try {
    const t = await startTarget((_rec, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ echo: secretMarker }));
    });
    const app = buildBroker({ getTarget: async () => ({ running: true, port: t.port }) });
    await callBroker(app, { path: '/api/fabric/app/students/billing/lookup', secret: CALLER_SECRET, body: { note: secretMarker } });
    await t.close();
  } finally {
    Object.assign(log, orig);
  }
  assert.ok(captured.length > 0, 'the broker logged at least once');
  assert.ok(!captured.some((line) => line.includes(secretMarker)), 'no log line contains the body');
});
