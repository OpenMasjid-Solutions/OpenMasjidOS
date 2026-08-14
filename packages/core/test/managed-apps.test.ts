// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Platform-managed apps (`apps/managed.ts`).
 *
 * OpenWA is a WhatsApp engine the OS drives — it creates the session, starts it, requests
 * the pairing code and sends everything through one paced queue that is the whole defence
 * against the number being banned. Every one of those guarantees is broken by an admin
 * using the gateway directly, so it is not a card on the dashboard, not pinnable, and not
 * even listed in the App Store until WhatsApp is switched on and the risk accepted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(__filename);
const managed = req('../src/apps/managed') as typeof import('../src/apps/managed');

function codeOf(rel: string): string {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const CATALOG = [{ id: 'prayer-times' }, { id: 'openwa' }, { id: 'donations' }];

test('the gateway is hidden from the store until WhatsApp is switched on', () => {
  const off = managed.visibleCatalog(CATALOG, { whatsappEnabled: false }).map((a) => a.id);
  assert.deepEqual(off, ['prayer-times', 'donations'], 'installing a WhatsApp client must not be a browsing accident');

  const on = managed.visibleCatalog(CATALOG, { whatsappEnabled: true }).map((a) => a.id);
  assert.deepEqual(on, ['prayer-times', 'openwa', 'donations'], 'and appears once the admin has opted in');
});

test('ordinary apps are never affected by the gate', () => {
  const apps = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(managed.visibleCatalog(apps, { whatsappEnabled: false }), apps);
});

test('a managed app with no gate wired up stays hidden', () => {
  // Fail closed: adding an id to the managed set must never leave it visible by default,
  // because "managed" means the platform has an invariant to protect.
  assert.equal(managed.isPlatformManaged('openwa'), true);
  assert.equal(managed.isPlatformManaged('prayer-times'), false);
  const src = codeOf('core/src/apps/managed.ts');
  const fn = src.slice(src.indexOf('export function visibleCatalog'));
  assert.match(fn.slice(0, fn.indexOf('\n}')), /return false/, 'the default branch must hide, not show');
});

test('the dashboard and the dock both drop managed apps', () => {
  // Two independent surfaces list installed apps; hiding it from one is not hiding it.
  for (const rel of ['ui/src/routes/Dashboard.tsx', 'ui/src/components/Dock.tsx']) {
    assert.match(codeOf(rel), /filter\(\(a\) => !a\.managed\)/, `${rel} must not show managed apps`);
  }
});

test('the store gate is applied to BOTH the cached read and the forced refresh', () => {
  // Refresh bypasses the cache; if it also bypassed the filter, pressing it would make
  // the hidden app appear.
  const src = codeOf('core/src/trpc/routers/store.ts');
  const catalogLine = src.slice(src.indexOf('catalog:'), src.indexOf('install:'));
  assert.match(catalogLine, /catalog: protectedProcedure\.query\(async \(\) => visibleToAdmin\(/);
  assert.match(catalogLine, /refresh: protectedProcedure\.mutation\(async \(\) => visibleToAdmin\(/);
});
