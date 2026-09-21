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
const PKG = path.join(__dirname, '..', '..', 'ui');

/**
 * `ui-manifest.json` is the authoritative contract, and the budgets below are
 * read FROM it rather than duplicated here. Two copies of the same number is two
 * places to update and one place to forget — and the manifest is the file a
 * downstream app reads to learn what this design system guarantees, so it is
 * the one that has to be right.
 */
const manifest = JSON.parse(fs.readFileSync(path.join(PKG, 'ui-manifest.json'), 'utf8'));
const budget: Record<string, number> = manifest.gateBudgets;

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
        `Lower it to ${n} in packages/ui/ui-manifest.json (gateBudgets) so it cannot creep back.`,
    );
  }
}

// ── RTL ────────────────────────────────────────────────────────────────────

test('no physical-direction Tailwind utilities, ever', () => {
  // Zero today and must stay zero: nothing is grandfathered, so every hit is new.
  // `translate-x` and friends were NOT in the first version of this list, and
  // the very first primitive installed slipped past because of it: shadcn's
  // Switch moves its thumb with `translate-x-[calc(100%-2px)]`. In RTL the
  // track mirrors (flex follows `dir`) so the thumb starts at the right edge,
  // and a positive translateX then walks it straight out of the track. Nothing
  // about that reads as wrong in the source — which is the whole argument for
  // checking utilities mechanically rather than by eye.
  // The `:` in the prefix set is load-bearing. Tailwind variants prefix the
  // utility (`hover:ml-4`, `data-[state=checked]:translate-x-2`), so a pattern
  // that only accepts whitespace or a quote before the utility misses every
  // conditional one — which is most of them in a generated component. The first
  // version of this regex did exactly that and reported a clean zero on a file
  // containing two physical translates.
  const PHYSICAL =
    /(?:^|[\s"'`{(:])(-?(?:ml|mr|pl|pr|border-l|border-r|rounded-l|rounded-r|rounded-tl|rounded-tr|rounded-bl|rounded-br|translate-x|inset-x|space-x|divide-x|scroll-ml|scroll-mr|scroll-pl|scroll-pr)-[a-z0-9.[\]()%+*/_-]+|-?(?:left|right)-[a-z0-9.[\]/-]+|text-left|text-right|float-left|float-right)(?=[\s"'`})]|$)/g;
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
    budget.physicalTailwindUtilities,
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
    budget.physicalCssProperties,
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
    budget.rawHexOutsideTokens,
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
    budget.fontStacksOutsideTokens,
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
    budget.keyframes,
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
  // BEHAVIOURAL, not structural. This used to grep for `twMerge(clsx(...))`,
  // which stopped being true the moment the implementation changed to shadcn's
  // `cn` package — and a gate that breaks when you swap an implementation is
  // testing the implementation, not the guarantee. What actually matters is
  // that a later utility beats an earlier one: with plain concatenation
  // `cn('px-4', props.className)` emits BOTH and stylesheet order picks the
  // winner, so a wrapper's override silently does nothing.
  const { cn } = require('../../ui/src/lib/cn') as { cn: (...a: unknown[]) => string };

  assert.equal(cn('px-4', 'px-2'), 'px-2', 'a later utility must win outright');
  assert.equal(cn('p-2', 'px-4').split(' ').length, 2, 'non-conflicting utilities both survive');
  // Our hand-written BEM names are not Tailwind and must pass through untouched
  // — the two systems coexist for the whole migration.
  assert.match(cn('glass-raised', 'app-card'), /glass-raised/);
  assert.match(cn('glass-raised', 'app-card'), /app-card/);
  // Conditionals, the clsx half of the contract.
  assert.equal(cn('a', false && 'b', undefined, 'c'), 'a c');
});

test('every Tailwind theme name resolves to a real token', () => {
  // The failure this prevents is silent and ugly. `@theme inline` maps a
  // Tailwind utility onto a var() reference; if the target does not exist,
  // Tailwind still emits the utility and the browser resolves the var to
  // nothing — so `bg-card` paints TRANSPARENT rather than erroring. A typo here
  // is invisible in code review and only shows up as an unstyled component.
  const index = code(fs.readFileSync(path.join(UI, 'index.css'), 'utf8'));
  const tokens = code(fs.readFileSync(path.join(UI, 'styles', 'tokens.css'), 'utf8'));

  const themeBlock = /@theme inline\s*\{([\s\S]*?)\n\}/.exec(index);
  assert.ok(themeBlock, 'index.css must carry an @theme inline block');

  // Everything the bridge in tokens.css defines, at any nesting level.
  const defined = new Set([...tokens.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]));

  const unresolved: string[] = [];
  for (const m of themeBlock[1].matchAll(/^\s*(--[\w-]+)\s*:\s*var\((--[\w-]+)\)/gm)) {
    if (!defined.has(m[2])) unresolved.push(`${m[1]} -> ${m[2]} (not defined in tokens.css)`);
  }
  assert.deepEqual(unresolved, [], 'every @theme inline target must exist');

  // `inline` is the whole reason runtime theming survives. Without it Tailwind
  // bakes the value in at build time, light mode stops switching, and a
  // user-chosen accent can never reach a shadcn component.
  assert.match(index, /@theme inline/, '@theme must be `inline`, not plain @theme');
  // And no literal colour may appear here — values belong in tokens.css.
  assert.doesNotMatch(themeBlock[1], /#[0-9a-fA-F]{3,8}\b|rgb|oklch|hsl/, 'no literal colours in @theme');
});

test('the shadcn bridge covers every name a primitive will ask for', () => {
  // A missing name has the same transparent-render failure as above, but shows
  // up later — when someone adds the first component that happens to use it.
  const tokens = code(fs.readFileSync(path.join(UI, 'styles', 'tokens.css'), 'utf8'));
  const REQUIRED = [
    'background', 'foreground', 'card', 'card-foreground', 'popover', 'popover-foreground',
    'primary', 'primary-foreground', 'secondary', 'secondary-foreground',
    'muted', 'muted-foreground', 'accent', 'accent-foreground',
    'destructive', 'destructive-foreground', 'border', 'input', 'ring', 'radius',
  ];
  const missing = REQUIRED.filter((n) => !new RegExp(`^\\s*--${n}\\s*:`, 'm').test(tokens));
  assert.deepEqual(missing, [], 'shadcn semantic names missing from the bridge');

  // Each must be an indirection, never a literal — one source of truth for values.
  for (const n of REQUIRED) {
    const decl = new RegExp(`^\\s*--${n}\\s*:\\s*([^;]+);`, 'm').exec(tokens);
    assert.match(decl![1], /var\(--/, `--${n} must point at a token, not hold a value`);
  }
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

// ── The package contract ───────────────────────────────────────────────────

test('a bare directional slide utility is caught; a side-paired one is not', () => {
  // GATE GAP. The main regex requires the physical token to be preceded by
  // whitespace, a quote, a brace or a colon — so in `slide-in-from-left-2` the
  // `left-2` sits behind a hyphen and is invisible to it. A whole family of
  // direction-named utilities could therefore land unnoticed.
  //
  // But they are not all wrong. shadcn pairs them with Radix's `data-side`,
  // which Radix computes from MEASURED placement — so
  // `data-[side=left]:slide-in-from-right-2` is geometrically correct in both
  // writing directions and must not be "fixed". A bare `slide-in-from-left-2`
  // with no side pairing is a real RTL bug. This gate distinguishes the two
  // rather than raising the budget or renaming something that was right.
  const found: string[] = [];
  for (const f of walk(UI, ['.tsx'])) {
    const src = code(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/(\S*)slide-in-from-(left|right)-[\w.[\]]+/g)) {
      if (/data-\[side=(left|right|top|bottom)\]:$/.test(m[1])) continue; // resolved side — correct
      found.push(`${rel(f)}:${src.slice(0, m.index).split('\n').length}  ${m[0]}`);
    }
  }
  assert.deepEqual(found, [], 'an unpaired directional slide utility will mirror wrongly in RTL');
});

test('no animation utility is used while no animation plugin is installed', () => {
  // `animate-in`, `fade-in-0`, `zoom-in-95` and the slide family come from
  // tw-animate-css / tailwindcss-animate. Neither is installed here, so those
  // class names compile to NOTHING — the component renders with a hard cut and
  // the source reads as though it animates. That is live inert code, and it has
  // been sitting in the tree since the DropdownMenu landed.
  //
  // Either declare a plugin or delete the classes. This gate refuses the state
  // where the classes are present and the plugin is not, in both directions.
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const hasPlugin = Object.keys(deps).some((d) => /tw-animate-css|tailwindcss-animate/.test(d));

  const users: string[] = [];
  for (const f of walk(UI, ['.tsx'])) {
    const src = code(fs.readFileSync(f, 'utf8'));
    if (/\banimate-(in|out)\b/.test(src)) users.push(rel(f));
  }
  if (!hasPlugin) {
    assert.deepEqual(
      users,
      [],
      'these use animate-in/animate-out with no plugin declared, so the classes do nothing',
    );
  }
});

test("Tailwind's dark: variant is wired to our theme, not the OS preference", () => {
  // Out of the box `dark:` means `prefers-color-scheme`. We theme with
  // `data-theme` on <html>. Without the remap, every shadcn component that
  // ships a `dark:` utility follows the OPERATING SYSTEM and ignores the choice
  // the admin made in Settings — a masjid on a light laptop who picks Dark gets
  // light switches on a dark dashboard, and nothing in the source looks wrong.
  // Deleting the remap is therefore a silent, whole-product regression, which
  // is why it is pinned rather than left to review.
  const index = code(fs.readFileSync(path.join(UI, 'index.css'), 'utf8'));
  const variant = /@custom-variant\s+dark\s*\(([^;]*)\);/.exec(index);
  assert.ok(variant, 'index.css must redefine the dark variant');
  assert.match(variant[1], /data-theme/, 'it must key off data-theme');
  assert.match(variant[1], /light/, 'and mirror tokens.css: dark unless explicitly light');
  assert.doesNotMatch(variant[1], /prefers-color-scheme/, 'never the OS preference');

  // Belt and braces: if a primitive ships `dark:` utilities, the remap has to
  // be there. Counting them makes the dependency explicit rather than implied.
  const dir = path.join(UI, 'components', 'ui');
  if (!fs.existsSync(dir)) return;
  const usesDark = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.tsx'))
    .filter((f) => /\bdark:/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  if (usesDark.length > 0) {
    assert.ok(variant, `${usesDark.join(', ')} ship dark: utilities and depend on the remap`);
  }
});

test('the manifest describes the real stylesheet order', () => {
  // Order is load-bearing and silent when wrong: tokens.css must come AFTER
  // Tailwind or its :root output wins, and the app renders the wrong theme with
  // no error anywhere. The manifest is what a downstream app reads, so it has to
  // match the file OpenMasjidOS actually loads.
  const css = fs.readFileSync(path.join(UI, 'styles', 'design-system.css'), 'utf8');
  const actual = [...css.matchAll(/@import\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(actual, manifest.stylesheetOrder, 'design-system.css order must match the manifest');
});

test('OpenMasjidOS loads the same stylesheet it asks other apps to load', () => {
  // An export nobody dogfoods is an export nobody tests. If the dashboard kept
  // its own list of stylesheets, the aggregate could rot for months and the
  // first app to adopt it would find out.
  const main = code(fs.readFileSync(path.join(UI, 'main.tsx'), 'utf8'));
  assert.match(main, /import '\.\/styles\/design-system\.css'/, 'main.tsx must import the aggregate');
  for (const sheet of ['tokens.css', 'glass.css', 'app.css']) {
    assert.doesNotMatch(
      main,
      new RegExp(`import '\\./styles/${sheet.replace('.', '\\.')}'`),
      `main.tsx must not import ${sheet} separately — the aggregate owns the order`,
    );
  }
});

test('the manifest lists exactly the semantic tokens the bridge defines', () => {
  const tokens = code(fs.readFileSync(path.join(UI, 'styles', 'tokens.css'), 'utf8'));
  const missing = manifest.theme.semanticTokens.filter(
    (n: string) => !new RegExp(`^\\s*--${n}\\s*:`, 'm').test(tokens),
  );
  assert.deepEqual(missing, [], 'manifest names a semantic token the bridge does not define');
});

test('the manifest lists exactly what index.ts exports', () => {
  // Drift here is how a downstream app imports something that is not there, or
  // stops importing something we still maintain. Both are cheap to prevent.
  const index = code(fs.readFileSync(path.join(UI, 'index.ts'), 'utf8'));
  const named = new Set<string>();
  for (const m of index.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()!.trim();
      if (name) named.add(name);
    }
  }
  assert.deepEqual([...named].sort(), [...manifest.exports].sort(), 'index.ts and manifest.exports disagree');
});

test('the manifest lists exactly the primitives on disk', () => {
  // Empty until Slice 5. From then on this is what stops a component being
  // installed by the CLI and never recorded in the contract.
  const dir = path.join(UI, 'components', 'ui');
  const onDisk = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.tsx')).map((f) => f.replace(/\.tsx$/, '')).sort()
    : [];
  assert.deepEqual(onDisk, [...manifest.primitives].sort(), 'components/ui and manifest.primitives disagree');
});

test('the package exports a surface, not its internals', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@openmasjid/ui');
  assert.equal(pkg.exports['.'], manifest.entry.index);
  assert.equal(pkg.exports['./styles.css'], manifest.entry.styles);
  // The dashboard's own entry points must never become importable: they are
  // OpenMasjidOS features, and exporting them would hand every other app a
  // desktop metaphor, a window manager and a tRPC client it did not ask for.
  const surface = JSON.stringify(pkg.exports);
  for (const internal of ['main.tsx', 'App.tsx', 'routes/', 'lib/trpc', 'components/Windows']) {
    assert.doesNotMatch(surface, new RegExp(internal.replace('/', '\/')), `${internal} must stay internal`);
  }
  // No wildcard subpath: `"./*": "./src/*"` would re-open every deep import and
  // make our file layout part of six other repos' build.
  assert.ok(!Object.keys(pkg.exports).some((k) => k.includes('*')), 'no wildcard export subpaths');
});
