// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * A refused tunnel request must be explicable to the masjid and opaque to everyone else.
 *
 * Five guards answered tunnel traffic with a byte-identical `{"error":"Not found."}` and
 * no log line anywhere. Three completely different situations produced it — nothing is
 * published at that path, the path is a LAN-only platform route, or it is an app's own
 * LAN-only `/fabric` space — and from outside they were indistinguishable, which is
 * correct, and from INSIDE they were also indistinguishable, which is not.
 *
 * Both halves are pinned here, because it is easy to fix the second by breaking the first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(__filename);
const refusals = req('../src/system/tunnel-refusals') as typeof import('../src/system/tunnel-refusals');

const SRC = path.join(__dirname, '..', 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

test('a refusal is recorded with its reason', () => {
  refusals.__clearRefusalsForTests();
  refusals.noteRefusal('/donate', 'masjid.example.org', 'no-app-at-path');
  const [r] = refusals.recentRefusals();
  assert.equal(r!.path, '/donate');
  assert.equal(r!.host, 'masjid.example.org');
  assert.equal(r!.reason, 'no-app-at-path');
  assert.equal(r!.count, 1);
});

test('repeats collapse, so one retrying phone cannot evict everything else', () => {
  refusals.__clearRefusalsForTests();
  for (let i = 0; i < 12; i++) refusals.noteRefusal('/donate', 'a.org', 'no-app-at-path');
  refusals.noteRefusal('/kiosk', 'a.org', 'no-app-at-path');
  const all = refusals.recentRefusals();
  assert.equal(all.length, 2, 'twelve retries are one line, not twelve');
  assert.equal(all.find((r) => r.path === '/donate')!.count, 12);
});

test('THE QUERY STRING IS NEVER KEPT — that is where tokens and ids live', () => {
  refusals.__clearRefusalsForTests();
  refusals.noteRefusal('/donate/pay?token=secret-abc&id=42', 'a.org', 'no-app-at-path');
  const [r] = refusals.recentRefusals();
  assert.equal(r!.path, '/donate/pay');
  assert.doesNotMatch(JSON.stringify(refusals.recentRefusals()), /secret-abc/);
});

test('the list is bounded', () => {
  refusals.__clearRefusalsForTests();
  for (let i = 0; i < 200; i++) refusals.noteRefusal(`/p${i}`, 'a.org', 'no-app-at-path');
  assert.ok(refusals.recentRefusals().length <= 25);
});

test('a very long path cannot flood the record', () => {
  refusals.__clearRefusalsForTests();
  refusals.noteRefusal('/' + 'x'.repeat(5000), 'a.org', 'no-app-at-path');
  assert.ok(refusals.recentRefusals()[0]!.path.length <= 120);
});

// ── the disclosure rule ──────────────────────────────────────────────────────────

test('THE RESPONSE STAYS IDENTICAL for every reason — the internet learns nothing', () => {
  // A discriminating 404 would let a stranger map which paths are real platform routes on
  // this box and which are nothing. That is exactly what the tunnel guard withholds, and
  // it is the easy thing to break while making the failure diagnosable.
  const index = read('index.ts');
  const ingress = read('system', 'ingress.ts');
  const viaTunnel = read('system', 'via-tunnel.ts');
  for (const [name, src] of [['index', index], ['ingress', ingress], ['via-tunnel', viaTunnel]] as const) {
    for (const m of src.matchAll(/code\(404\)[\s\S]{0,120}?send\(\{([^}]*)\}\)/g)) {
      const body = m[1]!;
      assert.doesNotMatch(body, /reason|code:/, `${name}: a 404 body must not name the guard that fired`);
    }
  }
});

test('every guard that refuses tunnel traffic records why', () => {
  for (const [file, src] of [
    ['index.ts', read('index.ts')],
    ['ingress.ts', read('system', 'ingress.ts')],
    ['via-tunnel.ts', read('system', 'via-tunnel.ts')],
  ] as const) {
    const refusalCount = [...src.matchAll(/error: 'Not found\.'/g)].length;
    const noteCount = [...src.matchAll(/noteRefusal\(/g)].length;
    assert.ok(
      noteCount >= refusalCount,
      `${file}: ${refusalCount} tunnel 404(s) but only ${noteCount} recorded — an unexplained refusal is what made this undiagnosable`,
    );
  }
});

test('the record is only readable over the LAN-only dashboard', () => {
  const router = read('trpc', 'routers', 'cloudflare.ts');
  assert.match(router, /refusals: protectedProcedure/, 'behind a session');
  // And never over the Fabric, which apps reach.
  const fabric = read('api', 'fabric.ts');
  assert.doesNotMatch(fabric, /recentRefusals/, 'apps must not be able to read a masjid\'s refused paths');
});

test('a browser navigation gets a sentence, not a JSON object', () => {
  const index = read('index.ts');
  const handler = index.slice(index.indexOf('front.setNotFoundHandler'));
  assert.match(handler, /text\/html/, 'a person typing an address deserves words');
  // But it must still say nothing about what IS published here.
  const page = handler.slice(0, handler.indexOf('return reply.code(404).send'));
  assert.doesNotMatch(page, /listInstalled|routes\.|getAppPath/, 'the page must not enumerate apps');
});
