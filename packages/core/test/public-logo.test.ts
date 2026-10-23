// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * `GET /api/public/logo` — the masjid logo.
 *
 * One of only TWO routes intentionally reachable over the Cloudflare tunnel
 * (CLAUDE.md §15), because Slack/Discord fetch it from the internet as the webhook
 * avatar and apps embed it on public pages. So it has to keep working over the
 * tunnel while everything else secret-gated stays LAN-only, it must stay
 * raster-only (an admin-uploaded SVG served same-origin is stored XSS), and it
 * must not 500 when no logo is set.
 *
 * Covered here alongside the @fastify/static v10 upgrade because it is the other
 * asset-serving path in the product — though note it streams a Buffer through
 * `reply.send`, NOT through @fastify/static.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Fastify, { type FastifyInstance } from 'fastify';

const req = createRequire(__filename);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-logo-'));
process.env.OPENMASJID_DATA_DIR = DATA_DIR;
const BRANDING_DIR = path.join(DATA_DIR, 'config', 'branding');

// Loaded after DATA_DIR is set (config.ts reads it at import time).
const branding = req('../src/store/branding') as typeof import('../src/store/branding');
const { registerFabric } = req('../src/api/fabric') as typeof import('../src/api/fabric');
const { registerFabricTunnelGuard } = req('../src/system/via-tunnel') as typeof import('../src/system/via-tunnel');

/** A 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

let app: FastifyInstance;

before(async () => {
  app = Fastify();
  registerFabricTunnelGuard(app);
  registerFabric(app);
  await app.ready();
});

after(async () => {
  await app.close();
});

test('with no logo set it 404s cleanly instead of erroring', async () => {
  branding.removeLogo();
  const res = await app.inject({ method: 'GET', url: '/api/public/logo' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.headers['cache-control'], 'no-store'); // don't cache the absence
  assert.deepEqual(res.json(), { error: 'No logo set.' });
});

test('appearance reports no logo when none is set', async () => {
  branding.removeLogo();
  const res = await app.inject({ method: 'GET', url: '/api/public/appearance' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().logo, '');
});

test('an uploaded PNG is served with its real bytes, type and a short cache', async () => {
  branding.saveLogo(PNG, 'image/png');
  const res = await app.inject({ method: 'GET', url: '/api/public/logo' });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /image\/png/);
  assert.equal(res.headers['cache-control'], 'public, max-age=300');
  assert.ok(res.rawPayload.equals(PNG), 'served bytes differ from what was uploaded');
});

test('it is CORS-open, so an app page and a webhook avatar can load it', async () => {
  branding.saveLogo(PNG, 'image/png');
  const res = await app.inject({ method: 'GET', url: '/api/public/logo' });
  assert.equal(res.headers['access-control-allow-origin'], '*');
});

test('appearance advertises the logo path once one is set', async () => {
  branding.saveLogo(PNG, 'image/png');
  const res = await app.inject({ method: 'GET', url: '/api/public/appearance' });
  assert.equal(res.json().logo, '/api/public/logo');
});

test('it stays reachable OVER THE TUNNEL — that is the whole point of it', async () => {
  // §15: /api/public/logo and /api/public/appearance are the only two routes the
  // tunnel guard must NOT block. Slack/Discord fetch this from the internet.
  branding.saveLogo(PNG, 'image/png');
  for (const headers of [{ 'cf-ray': 'abc123-LHR' }, { 'x-forwarded-proto': 'https' }]) {
    const res = await app.inject({ method: 'GET', url: '/api/public/logo', headers });
    assert.equal(res.statusCode, 200, JSON.stringify(headers));
    const appearance = await app.inject({ method: 'GET', url: '/api/public/appearance', headers });
    assert.equal(appearance.statusCode, 200, JSON.stringify(headers));
  }
});

test('a secret Fabric route on the SAME server is still blocked over the tunnel', async () => {
  // Guards against "made the logo public" turning into "made /api/fabric public".
  const res = await app.inject({
    method: 'GET',
    url: '/api/fabric/site',
    headers: { 'cf-ray': 'abc123-LHR' },
  });
  assert.equal(res.statusCode, 404);
});

test('SVG is refused at the store, so no script-in-SVG can ever be served', async () => {
  assert.equal(branding.isAllowedLogoMime('image/svg+xml'), false);
  assert.equal(branding.isAllowedLogoMime('text/html'), false);
  for (const ok of ['image/png', 'image/jpeg', 'image/webp']) {
    assert.equal(branding.isAllowedLogoMime(ok), true, ok);
  }
});

test('replacing the logo serves the new bytes, not a stale file', async () => {
  branding.saveLogo(PNG, 'image/png');
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16, 7)]);
  branding.saveLogo(jpeg, 'image/jpeg');
  const res = await app.inject({ method: 'GET', url: '/api/public/logo' });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /image\/jpeg/);
  assert.ok(res.rawPayload.equals(jpeg));
  // And the old PNG must not linger as a second file the route could pick up.
  branding.removeLogo();
  assert.equal((await app.inject({ method: 'GET', url: '/api/public/logo' })).statusCode, 404);
});

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16, 7)]);

test('a new logo that cannot be written leaves the previous one in place', () => {
  // saveLogo deleted the existing files first, so a write that then failed (a full SD
  // card) left no logo at all, and a record naming a file that was gone.
  branding.saveLogo(PNG, 'image/png');
  const blocker = path.join(BRANDING_DIR, 'logo.jpg');
  fs.mkdirSync(blocker); // the new file cannot take its place
  try {
    assert.throws(() => branding.saveLogo(JPEG, 'image/jpeg'));
    const logo = branding.getLogo();
    assert.ok(logo?.buf.equals(PNG), 'the previous logo must still be served');
    assert.equal(logo?.mime, 'image/png');
  } finally {
    fs.rmSync(blocker, { recursive: true, force: true });
  }
  // Once it can be written, the old file goes — after the new one is in place.
  branding.saveLogo(JPEG, 'image/jpeg');
  assert.ok(branding.getLogo()?.buf.equals(JPEG));
  assert.equal(fs.existsSync(path.join(BRANDING_DIR, 'logo.png')), false, 'the old logo lingers');
});

test('serving the logo costs a stat, not a read, until it changes', () => {
  // Every /api/public/logo request and root icon read branding.json and the whole logo
  // (up to 1 MB) synchronously, on the daemon's only thread.
  branding.saveLogo(PNG, 'image/png');
  const realRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (String(file).startsWith(BRANDING_DIR)) reads += 1;
    return (realRead as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.readFileSync;
  try {
    for (let i = 0; i < 5; i++) assert.ok(branding.getLogo()?.buf.equals(PNG));
    assert.equal(branding.hasLogo(), true);
    assert.ok(reads <= 2, `the logo was read ${reads} times for six asks`);
  } finally {
    fs.readFileSync = realRead;
  }
});

test('a restore that brings back a different logo is served without being told', () => {
  // A restore swaps config/ whole, behind the store's back. What the store remembers is
  // keyed on branding.json as it is on disk, which that replaces.
  branding.saveLogo(PNG, 'image/png');
  assert.ok(branding.getLogo()?.buf.equals(PNG));
  const restored = Buffer.concat([PNG, Buffer.from('restored')]);
  const staging = path.join(DATA_DIR, 'restore-staging-branding');
  fs.mkdirSync(staging);
  fs.writeFileSync(path.join(staging, 'logo.png'), restored);
  fs.writeFileSync(path.join(staging, 'branding.json'), JSON.stringify({ logo: { ext: 'png', mime: 'image/png' } }));
  fs.rmSync(BRANDING_DIR, { recursive: true });
  fs.renameSync(staging, BRANDING_DIR);
  assert.ok(branding.getLogo()?.buf.equals(restored), 'the logo from before the restore is still served');
});
