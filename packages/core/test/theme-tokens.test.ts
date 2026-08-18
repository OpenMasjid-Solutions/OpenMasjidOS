// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Light mode has to survive the wallpaper picker.
 *
 * It did not, and the reason was a cascade accident rather than a colour choice. Every
 * `[data-wallpaper]` block is a DARK gradient, they sit after `[data-theme="light"]`
 * with the SAME specificity, and `data-wallpaper` is always set (prefs.ts defaults it
 * to "aurora"). So light theme never got its own light scene: white glass at 55% alpha
 * over a near-black wallpaper composites to mid-grey, and then dark-blue ink went on
 * top of that — well under AA, on every screen at once, with nothing in the
 * light-theme block itself wrong.
 *
 * A new wallpaper added without its light counterpart reintroduces it silently and
 * only in one theme, which is exactly the kind of thing nobody checks. Hence a test
 * rather than a comment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const UI = path.join(__dirname, '..', '..', 'ui', 'src');
const tokens = fs.readFileSync(path.join(UI, 'styles', 'tokens.css'), 'utf8');
const prefs = fs.readFileSync(path.join(UI, 'lib', 'prefs.ts'), 'utf8');

/** Wallpaper ids that have a (dark) scene block. */
function darkWallpapers(): string[] {
  return [...tokens.matchAll(/^\[data-wallpaper="([a-z]+)"\]/gm)].map((m) => m[1]!);
}
/** Wallpaper ids that have a light-theme counterpart. */
function lightWallpapers(): string[] {
  return [...tokens.matchAll(/^\[data-theme="light"\]\[data-wallpaper="([a-z]+)"\]/gm)].map((m) => m[1]!);
}

test('every wallpaper has a light-theme counterpart', () => {
  const dark = darkWallpapers();
  const light = lightWallpapers();
  assert.ok(dark.length >= 9, `expected the wallpaper set, found ${dark.length}`);
  const missing = dark.filter((w) => !light.includes(w));
  assert.deepEqual(
    missing,
    [],
    `these wallpapers have no light-theme scene, so light mode paints its glass over a dark ` +
      `gradient and its ink becomes unreadable: ${missing.join(', ')}`,
  );
});

test('the picker offers exactly the wallpapers the stylesheet defines', () => {
  // A wallpaper offered but not styled falls back to whatever the previous one set; a
  // wallpaper styled but not offered is dead weight. Either way the two lists drifting
  // is how a theme ends up half-applied.
  // Scoped to the WALLPAPERS object. A looser match also caught the ACCENTS list,
  // which is a different set with the same shape.
  const from = prefs.indexOf('export const WALLPAPERS');
  assert.ok(from > 0, 'WALLPAPERS must still be exported from prefs.ts');
  const block = prefs.slice(from, prefs.indexOf('\n};', from));
  const offered = [...block.matchAll(/^\s{2}([a-z]+): \{ label:/gm)].map((m) => m[1]!);
  assert.ok(offered.length >= 9, `expected the picker list, found ${offered.length}`);
  assert.deepEqual([...offered].sort(), [...darkWallpapers()].sort());
});

test('the light counterparts win on specificity, not on file order', () => {
  // Order is what caused the bug. Relying on order again would only hide it: the fix
  // has to be a two-attribute selector so it wins wherever it sits.
  for (const w of lightWallpapers()) {
    assert.ok(
      tokens.includes(`[data-theme="light"][data-wallpaper="${w}"]`),
      `${w} must be selected by BOTH attributes together`,
    );
  }
});

test('a light wallpaper is actually light, and keeps its hue', () => {
  // The point is not "make it pale" — the picker has to mean the same thing in both
  // themes, so ocean stays blue and forest stays green. What must change is lightness.
  const blocks = [...tokens.matchAll(/\[data-theme="light"\]\[data-wallpaper="([a-z]+)"\]\s*\{([^}]*)\}/g)];
  assert.equal(blocks.length, lightWallpapers().length, 'every counterpart must parse');
  for (const [, name, body] of blocks) {
    const base = /--scene-base:\s*#([0-9A-Fa-f]{6})/.exec(body!);
    assert.ok(base, `${name} must set --scene-base`);
    const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(base![1]!.slice(i, i + 2), 16));
    // Rec. 601 luma; a light scene needs to be genuinely light for dark ink to read.
    const luma = (0.299 * r! + 0.587 * g! + 0.114 * b!) / 255;
    assert.ok(luma > 0.85, `${name}'s scene base is too dark for light mode (luma ${luma.toFixed(2)})`);
    assert.match(body!, /--scene-gradient:\s*linear-gradient/, `${name} must set a gradient too`);
  }
});
