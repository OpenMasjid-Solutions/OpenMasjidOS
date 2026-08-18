// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The reverse proxies are a hostile boundary (CLAUDE.md §15): whatever an app receives in
 * `X-Forwarded-*` is what it will rate-limit by, log, and build absolute URLs from.
 *
 * `cf-connecting-ip` was the hole. Both proxies preferred it over the socket peer
 * unconditionally, and neither stripped it — but only ONE of them ever sits behind
 * Cloudflare. So on the LAN, and on the per-app HTTPS proxy which is never tunnel-facing
 * at all, any caller could send `cf-connecting-ip: <anything>` and choose the IP every
 * app saw. Structural tests, because the fix is two lines and its absence is invisible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..', 'src', 'system');
const ingress = fs.readFileSync(path.join(SRC, 'ingress.ts'), 'utf8');
const appProxy = fs.readFileSync(path.join(SRC, 'app-proxy.ts'), 'utf8');

/** Source with comments removed — so a header named only in an explanatory comment
 *  can't satisfy an assertion about the code. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('both proxies strip client-supplied cf-connecting-ip', () => {
  for (const [name, src] of [
    ['ingress.ts', ingress],
    ['app-proxy.ts', appProxy],
  ] as const) {
    const stripList = /const STRIP_HEADERS = \[([\s\S]*?)\];/.exec(code(src));
    assert.ok(stripList, `${name} must still have a STRIP_HEADERS list`);
    assert.match(stripList[1]!, /'cf-connecting-ip'/, `${name} must strip cf-connecting-ip`);
  }
});

test('the app HTTPS proxy never honours cf-connecting-ip at all', () => {
  // This listener binds the LAN and is never behind Cloudflare, so the header is always
  // caller-supplied here. Unlike the tunnel ingress there is no legitimate case, so it
  // must not be read back out anywhere in the file.
  assert.ok(
    !/headers\['cf-connecting-ip'\]/.test(code(appProxy)),
    'app-proxy.ts must not read cf-connecting-ip — the socket peer is the only client IP it can trust',
  );
  assert.match(
    code(appProxy),
    /function clientIp\([\s\S]*?req\.socket\?\.remoteAddress/,
    'clientIp must come from the socket peer',
  );
});

test('the tunnel ingress only trusts cf-connecting-ip when the request came via the tunnel', () => {
  const c = code(ingress);
  // Both the HTTP and the WebSocket path must gate the read on the tunnel check rather
  // than reading the header directly. Two paths, and the WS one was written separately —
  // which is exactly how one of them ends up missing a guard.
  const reads = [...c.matchAll(/cfIp = ([^;]+);/g)].map((m) => m[1]!);
  assert.equal(reads.length, 2, 'expected the HTTP and WebSocket paths to each resolve a cfIp');
  for (const expr of reads) {
    assert.match(expr, /tunnel \?/, `cf-connecting-ip must be gated on the tunnel check, got: ${expr}`);
  }
  // And X-Forwarded-For must fall back to the socket peer, which cannot be forged.
  assert.match(c, /req\.socket\?\.remoteAddress/, 'the fallback must be the socket peer');
});

test('the WebSocket path drops the same headers as the HTTP path', () => {
  const c = code(ingress);
  const drop = /const drop = new Set\(\[([\s\S]*?)\]\);/.exec(c);
  assert.ok(drop, 'the WS relay must still have its drop set');
  for (const h of [
    'x-forwarded-for',
    'x-forwarded-proto',
    'x-forwarded-host',
    'x-forwarded-port',
    'forwarded',
    'cf-connecting-ip',
  ]) {
    assert.match(drop[1]!, new RegExp(`'${h}'`), `the WS relay must drop ${h}`);
  }
});
