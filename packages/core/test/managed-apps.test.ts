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

test('dialogs are portalled to the body, so a page animation cannot clip them', () => {
  // `position: fixed; inset: 0` does NOT mean "the viewport" when any ancestor has a
  // transform — that ancestor becomes the containing block. Every route is wrapped in a
  // motion.div that animates `y` (Page.tsx `fadeRise`), so dialogs opened from a page
  // were sized and clipped to the page's content box: backdrop over part of the screen,
  // dialog off-centre and half hidden. A portal is the only fix that does not depend on
  // knowing every animated ancestor.
  const src = codeOf('ui/src/components/Modal.tsx');
  assert.match(src, /createPortal\(/, 'the modal must render through a portal');
  assert.match(src, /document\.body,?\s*\)/, 'and specifically into document.body');
  // Every dialog in the app builds on this one component, so this covers all of them.
  const shared = codeOf('ui/src/components/ConfirmDialog.tsx');
  assert.match(shared, /from '\.\/Modal'/, 'ConfirmDialog must keep building on Modal');
});

test('the store gate is applied to BOTH the cached read and the forced refresh', () => {
  // Refresh bypasses the cache; if it also bypassed the filter, pressing it would make
  // the hidden app appear.
  const src = codeOf('core/src/trpc/routers/store.ts');
  const catalogLine = src.slice(src.indexOf('catalog:'), src.indexOf('install:'));
  assert.match(catalogLine, /catalog: protectedProcedure\.query\(async \(\) => visibleToAdmin\(/);
  assert.match(catalogLine, /refresh: protectedProcedure\.mutation\(async \(\) => visibleToAdmin\(/);
});

test('hiding the gateway must not take away its only Start button', () => {
  // The gateway is deliberately absent from the dashboard grid and the dock, and that
  // is also where every other app's Start/Restart lives. So hiding it removed the only
  // way to start it in the whole product: a masjid whose gateway stopped — which is
  // exactly when WhatsApp is unavailable — had no route back short of a root terminal.
  // Reported from a real install after a gateway update refused to boot.
  const router = codeOf('core/src/trpc/routers/whatsapp.ts');
  assert.match(router, /restartGateway: protectedProcedure\.mutation/, 'the gateway needs its own start control');
  // It must RECREATE, not just bounce: this is the recovery path after a settings fix,
  // and `compose start` would reuse the old container with the old environment.
  assert.match(router, /startApp\(OPENWA_APP_ID\)/);
  // And it must verify rather than assume — `compose up` exits 0 the moment a
  // container is created, so a gateway that boots and dies would report success.
  const fn = router.slice(router.indexOf('restartGateway:'));
  const body = fn.slice(0, fn.indexOf('\n  /**'));
  assert.match(body, /verifyStayedUp\(OPENWA_APP_ID\)/, 'it must check the container stayed up');
  assert.ok(
    body.indexOf('verifyStayedUp') > body.indexOf('startApp('),
    'the check must come after the start, not before',
  );

  const ui = codeOf('ui/src/routes/Settings.tsx');
  assert.match(ui, /trpc\.whatsapp\.restartGateway\.useMutation/, 'the panel must expose it');
  assert.match(ui, /whatsappGatewayCrashed/, 'a failed start must show the reason inline');
});
