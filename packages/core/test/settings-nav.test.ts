// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Settings is split into sections, and the two ways that can silently break.
 *
 * It used to be eleven panels stacked on one scrolling page. Splitting them into
 * addressable sections is a better page, but it introduces a failure the old layout
 * could not have: a panel can now be **orphaned** — still defined, still compiling, just
 * never rendered because no section gates it in. Nothing catches that. `tsc` sees a used
 * component, the tests pass, the build is clean, and a masjid simply cannot find their
 * Stripe keys any more.
 *
 * So this reads the source and checks the wiring end to end: every section in the nav
 * renders something, every section has a label, and every panel that existed is still
 * reachable from somewhere.
 *
 * Structural, like `theme-tokens.test.ts` and `i18n-keys.test.ts`, and in the core's
 * suite for the same reason — it is the only suite that runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const UI = path.join(__dirname, '..', '..', 'ui', 'src');
const settings = fs.readFileSync(path.join(UI, 'routes', 'Settings.tsx'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.join(UI, 'lib', 'i18n', 'en.json'), 'utf8')) as {
  settings: { nav?: Record<string, string>; whatsappTab?: Record<string, string> };
};

/** The ids declared in the SECTIONS table, read from the source itself. */
function sectionIds(): string[] {
  const block = settings.slice(settings.indexOf('const SECTIONS = ['), settings.indexOf('] as const;'));
  return [...block.matchAll(/id:\s*'([a-z]+)'/g)].map((m) => m[1]!);
}

test('the section table is not empty (the test below is worthless if it is)', () => {
  const ids = sectionIds();
  assert.ok(ids.length >= 5, `expected the SECTIONS table to parse, got ${JSON.stringify(ids)}`);
});

test('EVERY section in the nav actually renders something', () => {
  // The orphan case: an entry in the nav whose pane is empty, because nothing is gated
  // on it. You can click it, the URL changes, and you get a blank page.
  for (const id of sectionIds()) {
    assert.match(
      settings,
      new RegExp(`show\\('${id}'\\)`),
      `the nav offers "${id}" but nothing is rendered under show('${id}') — that section would be blank`,
    );
  }
});

test('every section has a label, and there are no labels for sections that do not exist', () => {
  const ids = sectionIds();
  const nav = en.settings.nav ?? {};
  for (const id of ids) {
    assert.ok(nav[id], `settings.nav.${id} is missing from en.json — the nav would show the raw key`);
  }
  // The other direction, so a removed section does not leave a dead string behind.
  for (const key of Object.keys(nav)) {
    assert.ok(ids.includes(key), `settings.nav.${key} has no matching section`);
  }
});

test('NO PANEL WAS ORPHANED by the split', () => {
  // Each of these was reachable on the old single page. If a future reshuffle drops one
  // out of every section gate, the setting disappears from the product with nothing
  // failing — this is the only thing that would notice.
  const panels = [
    'BrandingPanel',
    'ChangePassword',
    'NotificationsPanel',
    'EmailPanel',
    'WhatsAppPanel',
    'AlertsPanel',
    'StripePanel',
    'CloudflarePanel',
    'ScheduledBackupPanel',
    'UpdateChannel',
    'NetworkRow',
    'SslSection',
    'SshAccess',
  ];
  for (const p of panels) {
    assert.match(settings, new RegExp(`<${p}[\\s/>]`), `${p} is defined but no longer rendered anywhere`);
  }
});

test("the WhatsApp sub-tabs each render, and only once a phone is linked", () => {
  const tabs = en.settings.whatsappTab ?? {};
  for (const id of ['setup', 'groups', 'commands']) {
    assert.ok(tabs[id], `settings.whatsappTab.${id} is missing from en.json`);
  }
  // Groups and Commands error before a phone is linked, so both are gated on `waLinked`
  // as well as on the tab. Showing three tabs where two of them fail is worse than
  // showing none.
  assert.match(settings, /waLinked && waTab === 'groups' && <WhatsAppGroups/);
  assert.match(settings, /waLinked && waTab === 'commands' && <WhatsAppCommands/);
  // And the strip itself only appears then.
  assert.match(settings, /\{on && waLinked && \(/);
});

test('the section routes exist, or every nav link is a 404', () => {
  const root = fs.readFileSync(path.join(UI, 'Root.tsx'), 'utf8');
  assert.match(root, /path="\/settings"/, 'bare /settings must still resolve');
  assert.match(root, /path="\/settings\/:section"/, 'the per-section route is what the nav links to');
});

test('an unknown section falls back rather than showing nothing', () => {
  // A stale bookmark, or a section renamed later, must land somewhere useful. Without
  // the guard every `show()` is false and the pane renders empty.
  assert.match(settings, /isSectionId\(sectionParam\)\s*\?\s*sectionParam\s*:\s*DEFAULT_SECTION/);
});

test('the dialogs stay outside the section panes', () => {
  // Several are opened from one section and must survive navigating away — the restore
  // upload especially, which would abandon a file mid-flight if it unmounted.
  const paneEnd = settings.indexOf('</div>\n      </div>');
  const updateModal = settings.indexOf('<UpdateModal');
  assert.ok(paneEnd > 0 && updateModal > 0, 'expected to find the pane close and the modals');
  assert.ok(updateModal > paneEnd, 'UpdateModal must render outside the section panes, not inside one');
});

test('IN-PRODUCT LINKS point at the section they name, not at bare /settings', () => {
  // Splitting Settings into panes silently broke every existing cross-page link: they all
  // pointed at `/settings`, which now renders only the Appearance pane. A link whose own
  // text says "Settings → Payments" landing on theme and wallpaper is the page telling the
  // admin where it is taking them and then not doing it.
  //
  // The Dock is the deliberate exception — it is the generic way in, not a link to any
  // particular setting, so bare /settings is correct there and it lives in components/.
  const routes = path.join(UI, 'routes');
  const offenders: string[] = [];
  for (const f of fs.readdirSync(routes)) {
    if (!f.endsWith('.tsx')) continue;
    const src = fs.readFileSync(path.join(routes, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      if (line.includes('to="/settings"')) offenders.push(`routes/${f}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], 'these link to bare /settings and will land on Appearance');
});

test('every section a deep link targets actually exists', () => {
  // A link to /settings/billing when the section is called "payments" falls back to
  // Appearance silently — the same failure, just spelled differently.
  const ids = sectionIds();
  const targets = new Set<string>();
  for (const dir of ['routes', 'components']) {
    const d = path.join(UI, dir);
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.tsx')) continue;
      const src = fs.readFileSync(path.join(d, f), 'utf8');
      for (const m of src.matchAll(/to="\/settings\/([a-z]+)"/g)) targets.add(m[1]!);
    }
  }
  for (const target of targets) {
    assert.ok(ids.includes(target), `a link points at /settings/${target}, which is not a section`);
  }
  assert.ok(targets.size >= 3, 'expected the retargeted deep links to be present');
});

test('the unconfirmed-unlink notice lives OUTSIDE the linked-number block', () => {
  // It used to render inside `{linkedPhone && ...}` — and unlinking clears `linkedPhone`,
  // so the action that raises the warning unmounted it. The admin got a closed dialog, no
  // toast (suppressed on purpose, because this was meant to carry the message) and a
  // paragraph that flashed for under a second, for the one outcome where their phone may
  // still hold a device they can no longer revoke from here.
  const src = fs.readFileSync(path.join(UI, 'routes', 'Settings.tsx'), 'utf8');
  const warn = src.indexOf('{unlinkWarning && (');
  assert.ok(warn > 0, 'the warning block must exist');
  const linkedBlock = src.indexOf('{linkedPhone && showSetup && (');
  assert.ok(linkedBlock > 0, 'the linked-number block must exist');
  const linkedBlockEnd = src.indexOf('\n      )}', linkedBlock);
  assert.ok(
    warn > linkedBlockEnd,
    'the warning must render after the linked-number block closes, or unlinking unmounts it',
  );
});

test('an unconfirmed unlink is decided by `unlinked`, never by `stillLinked` alone', () => {
  // There are TWO ways to fail: a 502 (tried, could not confirm) sets `stillLinked`; not
  // reaching the gateway at all sets neither — and that is a common reason to be deleting
  // in the first place. Branching on `stillLinked` treated "we never asked" as success.
  const src = fs.readFileSync(path.join(UI, 'routes', 'Settings.tsx'), 'utf8');
  assert.match(src, /const confirmed = r\.unlinked;/, 'both handlers must key off `unlinked`');
  assert.doesNotMatch(
    src,
    /setUnlinkWarning\(r\.stillLinked\)/,
    'keying the warning off stillLinked misses the unreachable-gateway case',
  );
  assert.doesNotMatch(
    src,
    /toast\(\s*r\.stillLinked \?/,
    'the delete toast must not branch on stillLinked either',
  );
});
