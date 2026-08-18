// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * One rule, three times learned: a security check that compares a request URL must see
 * every spelling the router will accept.
 *
 *   v0.46.0  `/api/%66abric/…` walked past the Fabric LAN-only guard, because the guard
 *            compared `req.url` verbatim while Fastify dispatches on the DECODED path.
 *   this one  `/%74rpc/…` walked past the tRPC cross-origin check the same way, and
 *            `/donate/./fabric/x` walked past the ingress refusal that keeps an app's
 *            own /fabric routes off the public tunnel — that one needed dot segments
 *            resolved, not just escapes.
 *
 * So the tests here are deliberately about SPELLINGS rather than about any one route:
 * the next guard someone adds should fail here if it compares raw text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decodedPath, matchesSecretRoute, urlHasPrefix } from '../src/system/via-tunnel';
import { isFabricSubpath } from '../src/system/ingress';

test('urlHasPrefix sees the decoded spelling as well as the raw one', () => {
  assert.ok(urlHasPrefix('/trpc/auth.setup', '/trpc'), 'the plain spelling');
  // %74 is 't'. Fastify routes this to the tRPC handler, so the origin check must see it.
  assert.ok(urlHasPrefix('/%74rpc/auth.setup', '/trpc'), 'first character escaped');
  assert.ok(urlHasPrefix('/tr%70c/auth.setup', '/trpc'), 'a character in the middle escaped');
  assert.ok(urlHasPrefix('/trpc/auth.setup?batch=1', '/trpc'), 'query stripped before comparing');
  assert.ok(!urlHasPrefix('/api/health', '/trpc'), 'and it does not over-match');
  // A malformed escape must not throw the whole comparison away.
  assert.ok(urlHasPrefix('/trpc/%zz', '/trpc'));
});

test('decodedPath survives a malformed escape instead of losing the path', () => {
  assert.equal(decodedPath('/api/%66abric/app/x'), '/api/fabric/app/x');
  assert.equal(decodedPath('/api/fabric/%zz'), '/api/fabric/%zz');
  assert.equal(decodedPath('/api/fabric/x?q=%2F#frag'), '/api/fabric/x');
});

test('the secret-route guard still fails closed on both spellings', () => {
  for (const url of [
    '/api/fabric/app/students/billing/lookup',
    '/api/%66abric/app/students/billing/lookup',
    '/api/auth/session',
    '/api/fabric/whatsapp',
  ]) {
    assert.ok(matchesSecretRoute(url), url);
  }
  // The two intentionally-public routes must NOT be caught by it.
  assert.ok(!matchesSecretRoute('/api/public/appearance'));
  assert.ok(!matchesSecretRoute('/api/public/logo'));
});

test("an app's /fabric space is refused however the path is spelled", () => {
  const seg = 'donate';
  for (const url of [
    '/donate/fabric/billing',
    '/donate/%66abric/billing',
    // Dot segments: the far end may resolve these before routing, so we must too.
    '/donate/./fabric/billing',
    '/donate/x/../fabric/billing',
    '/donate/.%2ffabric/billing',
    '//donate/fabric/billing',
  ]) {
    assert.ok(isFabricSubpath(url, seg), url);
  }
  // Ordinary app paths are untouched — this guard must not break a real app.
  for (const url of ['/donate/', '/donate/checkout', '/donate/fabrics/wool', '/donate/api/fabric-ish']) {
    assert.ok(!isFabricSubpath(url, seg), url);
  }
});

test('no security check in src compares a raw request URL with startsWith', () => {
  // Structural, in the shape of test/app-host.test.ts: the mistake is easy to reintroduce
  // and invisible in review, so it is pinned rather than commented.
  const SRC = path.join(__dirname, '..', 'src');
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) {
        fs.readFileSync(p, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;
            // `req.url.startsWith(` / `request.url.startsWith(` — the exact shape that
            // bypassed both guards. Comparing a DECODED path is fine, hence the narrow
            // pattern.
            if (/\breq(uest)?\.url\.startsWith\(/.test(line)) {
              offenders.push(`${path.relative(SRC, p).replace(/\\/g, '/')}:${i + 1}`);
            }
          });
      }
    }
  };
  walk(SRC);
  assert.deepEqual(
    offenders,
    [],
    'compare the decoded path too (system/via-tunnel.ts: urlHasPrefix / decodedPath) — ' +
      `raw-text URL comparison found at: ${offenders.join(', ')}`,
  );
});
