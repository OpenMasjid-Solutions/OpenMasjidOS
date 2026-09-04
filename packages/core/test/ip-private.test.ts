// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * `ipIsPrivate` is asked two questions that fail in OPPOSITE directions, so it has to be
 * exactly right rather than roughly right:
 *
 *   - SSRF defence: calling a private address "public" lets a community app-store URL reach
 *     127.0.0.1 or a cloud metadata endpoint.
 *   - The LAN-only guard: calling a public address "private" hands an internet client the
 *     Fabric routes.
 *
 * The predecessor got IPv4-mapped IPv6 wrong by knowing only ONE of its spellings — the
 * dotted `::ffff:127.0.0.1` — so `::ffff:7f00:1` was classified as public. Same shape as the
 * raw-vs-decoded URL bugs: one value, several spellings, a check that knew one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ipIsPrivate, normaliseIp } from '../src/util/net';

test('loopback in every spelling it can arrive in', () => {
  for (const ip of [
    '127.0.0.1',
    '127.1.2.3',
    '::1',
    '[::1]',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1', // the hex form the old version missed
    '0:0:0:0:0:ffff:127.0.0.1',
    '0:0:0:0:0:ffff:7f00:1',
    '[::ffff:7f00:1]',
    '::FFFF:7F00:1', // casing
  ]) {
    assert.equal(ipIsPrivate(ip), true, `${ip} is loopback`);
  }
});

test('the RFC1918 ranges, including the Docker bridge', () => {
  for (const ip of ['10.0.0.1', '172.17.0.1', '172.16.0.0', '172.31.255.255', '192.168.1.5']) {
    assert.equal(ipIsPrivate(ip), true, ip);
  }
  // 172.15 and 172.32 are OUTSIDE the /12 — an off-by-one here would trust a public host.
  assert.equal(ipIsPrivate('172.15.0.1'), false, '172.15 is public');
  assert.equal(ipIsPrivate('172.32.0.1'), false, '172.32 is public');
});

test('link-local, which is also the cloud metadata address', () => {
  assert.equal(ipIsPrivate('169.254.169.254'), true, 'AWS/GCP metadata');
  assert.equal(ipIsPrivate('fe80::1'), true);
  assert.equal(ipIsPrivate('fe80::1%eth0'), true, 'a zone id must not defeat it');
  assert.equal(ipIsPrivate('::ffff:169.254.169.254'), true, 'mapped metadata');
});

test('CGNAT is private — a masjid behind carrier-grade NAT is not on the internet', () => {
  // 100.64.0.0/10. Absent from the old version, and it is what many ISPs and Tailscale use.
  assert.equal(ipIsPrivate('100.64.0.1'), true);
  assert.equal(ipIsPrivate('100.127.255.255'), true);
  assert.equal(ipIsPrivate('100.63.255.255'), false, 'just below the range');
  assert.equal(ipIsPrivate('100.128.0.0'), false, 'just above the range');
});

test('IPv6 unique-local and multicast', () => {
  for (const ip of ['fc00::1', 'fd12:3456::1', 'ff02::1']) assert.equal(ipIsPrivate(ip), true, ip);
});

test('real public addresses stay public', () => {
  // If any of these came out private, the LAN-only guard would trust the internet.
  for (const ip of [
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '172.217.16.142',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
    '::ffff:808:808', // hex form of 8.8.8.8
    '104.16.0.1',
  ]) {
    assert.equal(ipIsPrivate(ip), false, `${ip} must stay public`);
  }
});

test('junk is treated as PUBLIC, never as trusted', () => {
  // The safe direction for both callers: an address we cannot parse gets no LAN trust, and
  // is not fetched by the SSRF guard either.
  for (const bad of ['', '   ', 'not-an-ip', '999.999.999.999', '10.0.0', '10.0.0.1.5', 'localhost']) {
    assert.equal(ipIsPrivate(bad), false, `${JSON.stringify(bad)} must not be trusted`);
  }
});

test('normaliseIp flattens mapped forms but does not invent one', () => {
  assert.equal(normaliseIp('::ffff:192.168.0.1'), '192.168.0.1');
  assert.equal(normaliseIp('::ffff:c0a8:1'), '192.168.0.1');
  assert.equal(normaliseIp('[2001:db8::1]'), '2001:db8::1');
  // A non-zero head is NOT an IPv4-mapped address and must not be flattened to its tail —
  // doing so would let 2001:db8::10.0.0.1 masquerade as 10.0.0.1 and gain LAN trust.
  assert.equal(ipIsPrivate('2001:db8::10.0.0.1'), false);
  assert.equal(ipIsPrivate('2001:db8::ffff:7f00:1'), false);
});

test('there is no peer-based LAN check, and there must not be', () => {
  // Measured on a real daemon: with Docker's default userland-proxy, an app container,
  // cloudflared on the host network, and a client from OUTSIDE the host ALL arrive as
  // 172.17.0.1 — docker-proxy re-originates every connection from the bridge gateway. A peer
  // check would therefore answer "private" for the internet: a guard that reads like an
  // allow-list while admitting everyone, which is worse than no guard. Pinned so that the
  // next person to have this idea reads the note in util/net.ts first.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'util', 'net.ts'), 'utf8');
  const code = stripComments(src);
  assert.ok(!/peerIsPrivate/.test(code), 'see the note in util/net.ts explaining why');
  // And the bridge gateway is genuinely private — which is exactly why it is useless here.
  assert.equal(ipIsPrivate('172.17.0.1'), true);
});

/** Source with block and line comments removed, so a prose mention cannot fail the test. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
