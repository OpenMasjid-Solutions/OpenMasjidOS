// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Design-system discipline gates for `packages/ui`.
 *
 * These land in Slice 1, BEFORE the first shadcn component, and that ordering is
 * the point. The migration audit found this codebase is already very close to
 * RTL-correct — 35 logical direction properties against 4 physical ones, and
 * ZERO physical Tailwind utilities — which is an asset that took real work to
 * build. Tailwind's defaults are physical (`ml-*`, `pl-*`, `text-left`,
 * `left-*`), and every shadcn component and every code example on the internet
 * is written with them. So the realistic outcome of adopting Tailwind without a
 * gate is that RTL correctness quietly regresses one component at a time, and
 * nobody notices until someone opens the dashboard in Arabic.
 *
 * WHY RATCHETS AND NOT ALLOWLISTS. Each budget below is the CURRENT measured
 * count. Exceeding it fails. Going UNDER it also fails, asking you to lower the
 * number — otherwise an improvement is immediately available to be spent again
 * and the count never actually reaches zero. Line-number allowlists were the
 * alternative and they rot the first time a file is edited above the marked
 * line; counts survive refactors.
 *
 * `physicalTailwind` is the one budget that is zero and must stay zero. There
 * is no legacy to grandfather: Tailwind utilities are used nowhere in this
 * codebase yet, so every future one is a deliberate choice. Use the logical
 * utilities instead — `ms-* me-* ps-* pe-* start-* end-* text-start text-end
 * border-s border-e rounded-s rounded-e`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const UI = path.join(__dirname, '..', '..', 'ui', 'src');

/** Every file under packages/ui/src with one of these extensions. */
function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

const rel = (p: string) => path.relative(UI, p).replace(/\\/g, '/');

/** Strip comments so a rule can never be satisfied — or tripped — by prose. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Assert a measured count equals its budget, in both directions.
 * `hint` is what to do when it went up; going down just means lock in the win.
 */
function ratchet(name: string, found: string[], budget: number, hint: string): void {
  const n = found.length;
  if (n > budget) {
    assert.fail(
      `${name}: ${n} occurrences, budget ${budget}. ${hint}\n` +
        found.slice(0, 12).map((f) => `    ${f}`).join('\n') +
        (n > 12 ? `\n    …and ${n - 12} more` : ''),
    );
  }
  if (n < budget) {
    assert.fail(
      `${name}: down to ${n} from a budget of ${budget} — nice. ` +
        `Lower the budget in test/ui-design-gates.test.ts to ${n} so it cannot creep back.`,
    );
  }
}

// ── RTL ────────────────────────────────────────────────────────────────────

test('no physical-direction Tailwind utilities, ever', () => {
  // Zero today and must stay zero: nothing is grandfathered, so every hit is new.
  const PHYSICAL =
    /(?:^|[\s"'`{(])((?:ml|mr|pl|pr|border-l|border-r|rounded-l|rounded-r|rounded-tl|rounded-tr|rounded-bl|rounded-br)-[a-z0-9.[\]/-]+|(?:left|right)-[a-z0-9.[\]/-]+|text-left|text-right|float-left|float-right)(?=[\s"'`})]|$)/g;
  const found: string[] = [];
  for (const f of walk(UI, ['.tsx', '.ts'])) {
    const src = code(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(PHYSICAL)) {
      const line = src.slice(0, m.index).split('\n').length;
      found.push(`${rel(f)}:${line}  ${m[1]}`);
    }
  }
  ratchet(
    'physical Tailwind utilities',
    found,
    0,
    'Use the logical form instead: ms-/me- (not ml-/mr-), ps-/pe- (not pl-/pr-), ' +
      'start-/end- (not left-/right-), text-start/text-end, border-s/border-e, rounded-s/rounded-e.',
  );
});

test('physical-direction CSS properties stay at their known four', () => {
  // The survivors are genuinely direction-neutral uses: a full-bleed overlay
  // (left:0) and a centring transform (left:50%) in app.css, and the draggable
  // window's stored geometry in WindowManager.tsx. The window one IS a real RTL
  // gap — a dragged window will not mirror — and is recorded in the audit.
  const CSS_PHYSICAL =
    /(?:^|[^-a-z])(?:(?:left|right)\s*:|margin-(?:left|right)|padding-(?:left|right)|border-(?:left|right)[-:]|text-align\s*:\s*(?:left|right))/g;
  const found: string[] = [];
  for (const f of walk(UI, ['.css'])) {
    const src = code(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(CSS_PHYSICAL)) {
      found.push(`${rel(f)}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  const INLINE = /\b(?:marginLeft|marginRight|paddingLeft|paddingRight|borderLeft|borderRight)\b|textAlign:\s*'(?:left|right)'|\b(?:left|right):\s*(?:pos\.|'|`|\d)/g;
  for (const f of walk(UI, ['.tsx'])) {
    const src = code(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(INLINE)) {
      found.push(`${rel(f)}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  ratchet(
    'physical-direction CSS/inline properties',
    found,
    4,
    'Use logical properties: inset-inline-start, margin-inline, padding-inline, ' +
      'border-inline, text-align: start|end.',
  );
});

// ── Style discipline ───────────────────────────────────────────────────────

test('colours are defined in tokens.css and nowhere else', () => {
  const found: string[] = [];
  for (const f of walk(UI, ['.css'])) {
    if (rel(f).endsWith('tokens.css')) continue; // the one place colours live
    const src = code(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      found.push(`${rel(f)}:${src.slice(0, m.index).split('\n').length}  ${m[0]}`);
    }
  }
  ratchet(
    'raw hex colours outside tokens.css',
    found,
    10,
    'Add a token in styles/tokens.css (both themes) and reference it with var().',
  );
});

test('the type stack is set in tokens.css and inherited everywhere else', () => {
  const found: string[] = [];
  for (const f of walk(UI, ['.css'])) {
    if (rel(f).endsWith('tokens.css')) continue;
    const src = code(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/font-family\s*:\s*([^;]+);/g)) {
      if (/var\(--font-/.test(m[1])) continue; // referencing a token is the correct form
      found.push(`${rel(f)}:${src.slice(0, m.index).split('\n').length}  ${m[1].trim().slice(0, 40)}`);
    }
  }
  ratchet(
    'hardcoded font stacks outside tokens.css',
    found,
    3,
    'Add a --font-* token in tokens.css and use var(--font-mono) / var(--font-sans).',
  );
});

test('keyframes stay where they are and do not multiply', () => {
  // CLAUDE.md §14 requires prefers-reduced-motion be honoured unconditionally.
  // A @keyframes added outside the two stylesheets that already carry the
  // reduced-motion blocks is one nobody has thought about.
  const found: string[] = [];
  for (const f of walk(UI, ['.css'])) {
    const src = code(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/@keyframes\s+([\w-]+)/g)) {
      found.push(`${rel(f)}  ${m[1]}`);
    }
  }
  ratchet(
    '@keyframes definitions',
    found,
    5,
    'Prefer a shared preset from lib/motion.ts. If a keyframe is genuinely needed, ' +
      'it must also be disabled under prefers-reduced-motion in the same file.',
  );
});

// ── The shadcn contract ────────────────────────────────────────────────────

test('the @/ alias is declared identically in tsconfig and vite', () => {
  // The shadcn CLI bakes `@/lib/cn` into every component it writes. If the two
  // declarations drift, one of the typecheck and the bundle resolves and the
  // other does not — which surfaces as a green build and a blank page.
  const ts = fs.readFileSync(path.join(UI, '..', 'tsconfig.json'), 'utf8');
  const vite = fs.readFileSync(path.join(UI, '..', 'vite.config.ts'), 'utf8');
  assert.match(ts, /"@\/\*":\s*\[\s*"\.\/src\/\*"\s*\]/, 'tsconfig must map @/* to ./src/*');
  assert.match(vite, /alias:\s*\{\s*'@':/, 'vite must alias @ to ./src');
  assert.match(vite, /new URL\('\.\/src'/, 'and it must point at the same ./src');
});

test('cn() merges Tailwind classes rather than only concatenating them', () => {
  // With plain clsx, `cn('px-4', props.className)` emits both classes and the
  // winner is decided by stylesheet order, not by the caller — so a wrapper's
  // override silently does nothing. twMerge is what makes the wrapper layer work.
  const src = code(fs.readFileSync(path.join(UI, 'lib', 'cn.ts'), 'utf8'));
  assert.match(src, /twMerge/, 'cn() must use tailwind-merge');
  assert.match(src, /twMerge\(clsx\(/, 'and it must wrap clsx, not replace it');
});

test('components.json points the shadcn CLI at our real paths', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(UI, '..', 'components.json'), 'utf8'));
  assert.equal(cfg.tsx, true);
  assert.equal(cfg.rsc, false, 'this is a Vite SPA, not a server-component app');
  assert.equal(cfg.tailwind.css, 'src/index.css');
  assert.equal(cfg.tailwind.config, '', 'Tailwind v4 has no JS config — theme lives in CSS');
  // Our helper is lib/cn.ts, not shadcn's default lib/utils.ts. If this drifts,
  // every added component imports a module that does not exist.
  assert.equal(cfg.aliases.utils, '@/lib/cn');
  assert.equal(cfg.iconLibrary, 'lucide', 'lucide-react is already a dependency');
});
