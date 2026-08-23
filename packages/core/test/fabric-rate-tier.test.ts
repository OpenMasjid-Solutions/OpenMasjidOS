// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The Fabric's read-only rate tier must never price a SEND as a read.
 *
 * `GET /api/fabric/whatsapp/status/:id` gets a larger budget than the send route, because
 * polling it is an in-memory lookup the platform explicitly asks apps to do, while a send
 * messages a real phone and carries the ban risk the tight limit exists for.
 *
 * The danger is the classifier. A raw-text `startsWith` on the URL grants the loose budget
 * to `POST /api/fabric/whatsapp/status/..`, which Fastify resolves to the SEND route — so
 * the tighter limit is bypassed by spelling. That is the same raw-vs-decoded class of bug
 * as CLAUDE.md §15's `/api/%66abric/` walk-past, and this file exists so it cannot come
 * back through the rate limiter.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(import.meta.dirname, '..', 'src', 'api', 'fabric.ts');
const src = fs.readFileSync(SRC, 'utf8');

test('the read tier is decided from the method AND both path spellings', () => {
  const fn = src.slice(
    src.indexOf('function isReadOnlyFabricRoute'),
    src.indexOf('const fabricHits'),
  );
  assert.ok(fn.length > 0, 'isReadOnlyFabricRoute not found');

  // GET-only is the load-bearing half: every sending route is a POST.
  assert.ok(/method\.toUpperCase\(\)\s*!==\s*'GET'/.test(fn), 'the read tier must be GET-only');

  // And the path must match under the resolved spelling too, not just the raw text.
  assert.ok(fn.includes('resolveDotSegments'), 'the read tier must resolve dot segments');
  assert.ok(fn.includes('decodedPath'), 'the read tier must test the decoded path');
});

test('the read and send tiers use separate counters', () => {
  // Sharing the key would let a polling burst refuse a send even under the larger ceiling,
  // which is the cross-app denial the per-app tier was added to prevent.
  assert.ok(src.includes('appread:'), 'the read tier must use its own bucket key');
  assert.ok(
    src.includes('RATE_MAX_APP_READ'),
    'the read tier must have its own ceiling, not reuse RATE_MAX_APP',
  );
});

test('only bounded in-memory reads are on the read allow-list', () => {
  // An allow-list, never a verb test: a future GET that triggers real work (a gateway probe,
  // an outbound fetch) must not inherit the loose budget just for being a GET.
  const list = src.slice(src.indexOf('READ_ONLY_ROUTES = ['), src.indexOf(']', src.indexOf('READ_ONLY_ROUTES = [')));
  const routes = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  // `/suspect` qualifies for the same reason `/status/` does: it answers from the
  // in-memory incident state and the in-memory outcome ring. It does NOT probe the gateway
  // — if it ever did, it would have to come off this list.
  assert.deepEqual(routes, ['/api/fabric/whatsapp/suspect', '/api/fabric/whatsapp/status/']);
});
