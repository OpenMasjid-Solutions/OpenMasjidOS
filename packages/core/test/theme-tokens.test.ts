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

// ── the ink that goes ON the accent ──────────────────────────────────────────
//
// Two separate ways a button's own icon and label become unreadable, both invisible
// to `tsc` and to the build, and both reported as "I can only see it when I hover".

const appCss = fs.readFileSync(path.join(UI, 'styles', 'app.css'), 'utf8');

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const ch = [1, 3, 5]
    .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** The accent table, parsed out of prefs.ts. */
function accents(): Array<{ id: string; primary: string; onPrimary: string }> {
  const from = prefs.indexOf('export const ACCENTS');
  assert.ok(from > 0, 'ACCENTS must still be exported from prefs.ts');
  const block = prefs.slice(from, prefs.indexOf('\n};', from));
  return [...block.matchAll(/^\s{2}(\w+): \{([^}]*)\},/gm)].map(([, id, body]) => {
    // `primary` needs a leading delimiter or it also matches `onPrimary`.
    const primary = /[\s,{]primary: '(#[0-9A-Fa-f]{6})'/.exec(body!);
    const onPrimary = /onPrimary: '(#[0-9A-Fa-f]{6})'/.exec(body!);
    assert.ok(primary, `${id} must declare a primary colour`);
    assert.ok(onPrimary, `${id} must declare the ink that goes on it`);
    return { id: id!, primary: primary[1]!, onPrimary: onPrimary[1]! };
  });
}

test('EVERY ACCENT CARRIES INK DARK ENOUGH TO READ ON ITSELF', () => {
  // `applyAccent` writes `--color-btn` as an inline custom property on the root, and
  // an inline property beats the stylesheet's own [data-theme="light"] block. So
  // picking any accent in LIGHT mode swapped the dark blue button for a bright one
  // while --color-on-primary stayed #FFFFFF: white on gold is 1.67:1 against AA's
  // 4.5:1, and it took every primary button, avatar and app-icon fallback with it.
  const all = accents();
  assert.ok(all.length >= 5, `expected the accent palette, found ${all.length}`);
  for (const a of all) {
    const ratio = contrast(a.onPrimary, a.primary);
    assert.ok(
      ratio >= 4.5,
      `${a.id}: ink ${a.onPrimary} on ${a.primary} is ${ratio.toFixed(2)}:1, below AA's 4.5:1`,
    );
  }
});

test('an accent sets its ink and its background together, or neither', () => {
  // Half-applying is the bug: a background without its ink is the light-mode failure
  // above, and ink without its background is the same failure inverted.
  const from = prefs.indexOf('export function applyAccent');
  const fn = prefs.slice(from, prefs.indexOf('\n}', from));
  assert.match(fn, /setProperty\('--color-btn',/, 'still sets the button background');
  assert.match(fn, /setProperty\('--color-on-primary', a\.onPrimary\)/, 'and its ink');
  // The default accent alone falls back to the stylesheet — light theme's default
  // button is a DARK blue that wants white ink, unlike every bright accent.
  assert.match(fn, /removeProperty\('--color-on-primary'\)/, 'the fallback must clear it too');
});

test('A BANNER NEVER REPAINTS THE ICON INSIDE ITS OWN BUTTONS', () => {
  // `.warn-banner--update svg` was meant for the banner's leading icon, but as a
  // DESCENDANT selector it also hit the icon inside the banner's "Update now" button
  // — and a rule that targets the svg directly beats the colour it would inherit from
  // .btn--primary. That painted the icon --color-primary on a --color-btn background,
  // and `applyAccent` sets both from the SAME value, so on every accent the icon was
  // exactly the button colour: perfectly invisible until :hover changed the
  // background out from under it.
  const rules = [...appCss.matchAll(/^(\.warn-banner[^{\n]*\bsvg)\s*\{([^}]*)\}/gm)];
  assert.ok(rules.length >= 2, `expected the banner icon rules, found ${rules.length}`);
  for (const [, selector, body] of rules) {
    if (!/color:/.test(body!)) continue;
    assert.match(
      selector!,
      />\s*svg$/,
      `"${selector}" colours every svg it contains, including the ones inside buttons — ` +
        `scope it to the banner's own icon with a child combinator`,
    );
  }
  // And the fallback those button icons land on has to still exist.
  assert.match(
    appCss,
    /\.btn--primary\s*\{[^}]*color: var\(--color-on-primary\)/,
    'a primary button must set the on-accent ink its icon inherits',
  );
});
