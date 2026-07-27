// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Serving the dashboard (api/static-ui.ts) and the public logo route.
 *
 * Written for the @fastify/static v8 -> v10 upgrade, which cleared four HIGH
 * advisories — two of them path traversal, two route-guard bypass via encoded
 * separators / non-canonical paths. That is exactly the class of bug that is
 * invisible on a casual click-through, so the escape attempts below are the point
 * of this file: nothing may be served from outside the UI directory, and an API
 * path must never answer with the dashboard shell.
 *
 * v10 also changed the `setHeaders` callback's first argument from a raw
 * ServerResponse to a FastifyReply, so the cache-control assertions double as a
 * check that the caching behaviour survived the bump.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerStaticUI } from '../src/api/static-ui';

let uiDir: string;
let secretDir: string;
let app: FastifyInstance;

before(async () => {
  // A fake Vite build, plus a secret file OUTSIDE the served root that the
  // traversal attempts below try to reach.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-ui-'));
  uiDir = path.join(base, 'dist');
  secretDir = base;
  fs.mkdirSync(path.join(uiDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><title>OpenMasjidOS</title>');
  fs.writeFileSync(path.join(uiDir, 'assets', 'index-abc123.js'), 'console.log(1)');
  fs.writeFileSync(path.join(uiDir, 'favicon.svg'), '<svg/>');
  fs.writeFileSync(path.join(secretDir, 'secret.txt'), 'TOP-SECRET-CONFIG');

  app = Fastify();
  await registerStaticUI(app, uiDir);
  // Stand in for the real /api routes, so we can prove an unmatched /api path
  // 404s as JSON instead of falling back to the SPA.
  app.get('/api/health', async () => ({ status: 'ok' }));
  await app.ready();
});

after(async () => {
  await app.close();
});

test('the dashboard is served at / and always revalidates', async () => {
  const res = await app.inject({ method: 'GET', url: '/' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /OpenMasjidOS/);
  // index.html must never be cached, or a new build is invisible until a hard
  // reload — this is the half of setHeaders that v10's signature change broke.
  assert.equal(res.headers['cache-control'], 'no-cache');
});

test('fingerprinted assets are cached immutably', async () => {
  const res = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'console.log(1)');
  assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
});

test('a non-asset file at the root is served but not cached', async () => {
  const res = await app.inject({ method: 'GET', url: '/favicon.svg' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-cache');
});

test('an unknown path falls back to the SPA so client routing works', async () => {
  for (const url of ['/settings', '/apps/prayer-times-display', '/store/custom']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 200, url);
    assert.match(res.body, /OpenMasjidOS/, url);
    assert.match(String(res.headers['content-type']), /text\/html/, url);
  }
});

test('registered API routes still work through the static plugin', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });
});

test('an unmatched API path 404s as JSON, never as the dashboard shell', async () => {
  for (const url of ['/api/nope', '/trpc/nope', '/api/', '/trpc']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 404, url);
    assert.deepEqual(res.json(), { error: 'Not found' }, url);
  }
});

test('a percent-encoded API path is still treated as an API path', async () => {
  // Same raw-vs-decoded class as the Fabric guard: `startsWith('/api')` does not
  // recognise `/%61pi/…`, so this used to answer with index.html.
  for (const url of ['/%61pi/nope', '/%74rpc/nope', '/api/%6eope']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 404, url);
    assert.deepEqual(res.json(), { error: 'Not found' }, url);
  }
});

// ── Escape attempts. Each must NOT return the file outside the UI root. ───────

test('nothing outside the UI directory can be reached', async () => {
  const attempts = [
    '/../secret.txt',
    '/../../secret.txt',
    '/assets/../../secret.txt',
    '/%2e%2e/secret.txt',
    '/%2e%2e%2fsecret.txt',
    '/..%2fsecret.txt',
    '/assets/..%2f..%2fsecret.txt',
    '/.%2e/secret.txt',
    '/%252e%252e/secret.txt', // double-encoded
    '/..\\secret.txt',
    '/%5c..%5csecret.txt',
    '/assets/%2e%2e/%2e%2e/secret.txt',
  ];
  for (const url of attempts) {
    const res = await app.inject({ method: 'GET', url });
    assert.ok(
      !res.body.includes('TOP-SECRET-CONFIG'),
      `${url} leaked a file from outside the UI root (status ${res.statusCode})`,
    );
  }
});

test('an absolute-path probe cannot read the filesystem', async () => {
  for (const url of ['/etc/passwd', '/C:/Windows/win.ini', '//etc/passwd']) {
    const res = await app.inject({ method: 'GET', url });
    // These are unknown paths, so the SPA fallback answering with index.html is
    // correct. What matters is that no real file content comes back.
    assert.ok(!/root:|\[fonts\]/i.test(res.body), `${url} returned host file content`);
  }
});

test('a directory listing is never produced', async () => {
  // `index: false`/no `list` option, so /assets/ must not enumerate the build.
  const res = await app.inject({ method: 'GET', url: '/assets/' });
  assert.ok(!res.body.includes('index-abc123.js'), 'directory listing leaked the asset names');
});

test('HEAD on the dashboard works (health checkers and proxies use it)', async () => {
  const res = await app.inject({ method: 'HEAD', url: '/' });
  assert.equal(res.statusCode, 200);
});

test('a non-GET request to an unknown path does not get the SPA', async () => {
  // Only GET may fall back to index.html; a POST to a client route is a 404.
  const res = await app.inject({ method: 'POST', url: '/settings' });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: 'Not found' });
});

test('the daemon still boots with no UI build present (local dev)', async () => {
  const bare = Fastify();
  const haveUI = await registerStaticUI(bare, path.join(os.tmpdir(), 'omos-does-not-exist'));
  await bare.ready();
  assert.equal(haveUI, false);
  // No SPA to fall back to, so everything 404s as JSON rather than throwing.
  const res = await bare.inject({ method: 'GET', url: '/settings' });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: 'Not found' });
  await bare.close();
});
