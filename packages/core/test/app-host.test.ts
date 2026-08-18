// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * How the core reaches an app's published host port.
 *
 * This exists because of a shipped bug. The core runs in a bridge-network container, so
 * `127.0.0.1` inside it is the CORE, not the machine — an app's published port is not
 * there. Three callers had this right (the Fabric broker, the per-app TLS proxy, the
 * tunnel ingress); the WhatsApp gateway client was written from memory with `127.0.0.1`
 * and therefore could not reach OpenWA on ANY install. The reported symptom was
 * "Cannot reach the gateway" plus "fetch failed", which pointed at the masjid's setup
 * rather than at the platform.
 *
 * So the value now has one definition, and the tests below pin both that it is used and
 * that a failure to reach a gateway says something the admin can act on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';

// Must be set before the modules under test are required — the config module reads it
// at import time (same pattern as the other store-backed tests).
process.env.OPENMASJID_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-apphost-'));

const req = createRequire(__filename);
const host = req('../src/system/app-host') as typeof import('../src/system/app-host');
const wa = req('../src/notify/whatsapp') as typeof import('../src/notify/whatsapp');
const store = req('../src/store/whatsapp') as typeof import('../src/store/whatsapp');

/** Source with comments stripped — assertions must be about code, not prose. */
function codeOf(rel: string): string {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('the app host is one value, honouring the dev override', () => {
  const saved = process.env.OPENMASJID_APP_PROXY_TARGET;
  try {
    delete process.env.OPENMASJID_APP_PROXY_TARGET;
    // In a container the host is only reachable by name (extra_hosts host-gateway).
    assert.equal(host.appHost(), 'host.docker.internal');
    assert.equal(host.appOrigin(2785), 'http://host.docker.internal:2785');
    // Dev runs the core on the host itself, where apps publish to localhost.
    process.env.OPENMASJID_APP_PROXY_TARGET = '127.0.0.1';
    assert.equal(host.appOrigin(2785), 'http://127.0.0.1:2785');
  } finally {
    if (saved === undefined) delete process.env.OPENMASJID_APP_PROXY_TARGET;
    else process.env.OPENMASJID_APP_PROXY_TARGET = saved;
  }
});

test('nothing else derives an app address from a loopback literal', () => {
  // The bug in one line. Any caller that builds `http://127.0.0.1:${port}` for an app
  // port is unreachable in production, and the failure looks like the masjid's fault.
  const dir = path.join(__dirname, '..', 'src');
  const walk = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(d, e.name);
      return e.isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
    });
  for (const file of walk(dir)) {
    if (file.endsWith(`system${path.sep}app-host.ts`)) continue; // the one legitimate mention
    const code = codeOf(path.relative(dir, file));
    assert.doesNotMatch(
      code,
      /https?:\/\/(127\.0\.0\.1|localhost):\$\{/,
      `${path.relative(dir, file)} builds an address from a loopback literal — use appOrigin()`,
    );
  }
});

test('every caller that reaches an app port goes through the helper', () => {
  for (const rel of ['fabric/appLink.ts', 'system/app-proxy.ts', 'system/ingress.ts', 'notify/whatsapp.ts']) {
    assert.match(codeOf(rel), /appHost\(\)|appOrigin\(/, `${rel} must resolve the host via system/app-host`);
  }
});

test('a gateway that is not listening says so, not "fetch failed"', async () => {
  // undici collapses every transport failure into `TypeError: fetch failed` and hides
  // the real cause in `.cause`. That bare string is what a masjid saw, and it told them
  // nothing. Reachability failures must name the reason.
  const dead = http.createServer();
  await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
  const port = (dead.address() as { port: number }).port;
  await new Promise<void>((r) => dead.close(() => r())); // now a certainly-closed port

  store.saveWhatsAppConfig({ provider: 'openwa', apiKey: 'k', baseUrl: `http://127.0.0.1:${port}` });
  const s = await wa.gatewayStatus();
  assert.equal(s.state, 'unreachable');
  assert.equal(s.reachable, false);
  assert.doesNotMatch(s.detail, /fetch failed/, 'the raw undici message must never reach the admin');
  assert.match(s.detail, /listening|reached|found|time/, `unhelpful detail: ${s.detail}`);
});

test('a gateway that answers is reachable even when it refuses the call', async () => {
  // Reachability is "something answered", NOT "the request succeeded". Requiring a 200
  // made the state depend on OpenWA's exact routes, so a renamed endpoint would report a
  // healthy gateway as down. A rejected key is its own state, with its own fix.
  const server = http.createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"message":"invalid api key"}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    store.saveWhatsAppConfig({ provider: 'openwa', apiKey: 'wrong', baseUrl: `http://127.0.0.1:${port}` });
    const s = await wa.gatewayStatus();
    assert.equal(s.state, 'bad-key');
    assert.equal(s.reachable, true, 'a 401 proves a server is there');
    assert.equal(s.connected, false);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('a healthy gateway with no session asks the admin to link, not to check the network', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]'); // an empty session list
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    store.saveWhatsAppConfig({ provider: 'openwa', apiKey: 'k', baseUrl: `http://127.0.0.1:${port}` });
    const s = await wa.gatewayStatus();
    assert.equal(s.state, 'no-session');
    assert.equal(s.reachable, true);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
