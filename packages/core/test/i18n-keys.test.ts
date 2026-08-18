// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Every string the UI asks for must exist in `en.json`.
 *
 * When it doesn't, i18next renders the KEY — so a masjid volunteer sees `common.remove`
 * on a button. That shipped once, in the WhatsApp settings panel, and nothing caught it:
 * `tsc` cannot check a string literal against a JSON file, and the panel it was in is far
 * enough down Settings that it went unnoticed through a release.
 *
 * Lives in the core's suite because that is the only suite that runs (`packages/ui` has no
 * test script), and it only needs to read two files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const UI = path.join(__dirname, '..', '..', 'ui', 'src');
const en = JSON.parse(fs.readFileSync(path.join(UI, 'lib', 'i18n', 'en.json'), 'utf8')) as Record<
  string,
  unknown
>;

/** Every leaf key in en.json, dotted. */
function leafKeys(obj: Record<string, unknown>, prefix = ''): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const nested of leafKeys(v as Record<string, unknown>, key)) out.add(nested);
    } else {
      out.add(key);
    }
  }
  return out;
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, acc);
    else if (/\.(ts|tsx)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

/**
 * i18next plural handling: a call passing `count` resolves `<key>_one` / `<key>_other`
 * (and `_zero`, which it honours for count === 0) rather than the bare key. So a bare key
 * that is absent is fine PROVIDED a plural form exists — and conversely, defining only the
 * bare key while passing `count` is not an error either. What we are looking for is a key
 * with no definition in any of its accepted spellings.
 */
const SUFFIXES = ['', '_zero', '_one', '_two', '_few', '_many', '_other'];

test('every static t() key the UI uses exists in en.json', () => {
  const defined = leafKeys(en);
  const missing: string[] = [];

  for (const file of sourceFiles(UI)) {
    const rel = path.relative(UI, file).replace(/\\/g, '/');
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        // t('a.b.c') / t("a.b.c") — a dotted literal key. Template literals and variables
        // are deliberately skipped: they cannot be resolved statically. There is a small
        // number of those and the next test bounds it.
        for (const m of line.matchAll(/\bt\(\s*(['"])([A-Za-z0-9_.$-]+)\1/g)) {
          const key = m[2]!;
          if (!SUFFIXES.some((s) => defined.has(key + s))) {
            missing.push(`${rel}:${i + 1} → ${key}`);
          }
        }
      });
  }

  assert.deepEqual(
    missing,
    [],
    'these keys are used but not defined, so i18next will render the key itself to the ' +
      `user:\n  ${missing.join('\n  ')}`,
  );
});

test('dynamically-built translation keys stay rare enough to review by hand', () => {
  // A key assembled at runtime cannot be checked by the test above, so each one is a hole.
  // This is not a ban — there are legitimate uses — but the count is pinned so adding one
  // is a deliberate act rather than a drift.
  const dynamic: string[] = [];
  for (const file of sourceFiles(UI)) {
    const rel = path.relative(UI, file).replace(/\\/g, '/');
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const _ of line.matchAll(/\bt\(\s*[`]/g)) dynamic.push(`${rel}:${i + 1}`);
      });
  }
  assert.ok(
    dynamic.length <= 2,
    `dynamic t() keys cannot be statically verified; if you added one, confirm every branch ` +
      `exists in en.json and raise this bound deliberately. Found ${dynamic.length}:\n  ${dynamic.join('\n  ')}`,
  );
});

test('en.json has no empty strings', () => {
  // An empty value renders as nothing at all, which looks like a broken layout rather than
  // a missing translation — harder to spot than the key-as-text case.
  const empty: string[] = [];
  const walk = (obj: Record<string, unknown>, prefix = ''): void => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v as Record<string, unknown>, key);
      else if (typeof v === 'string' && v.trim() === '') empty.push(key);
    }
  };
  walk(en);
  assert.deepEqual(empty, []);
});
