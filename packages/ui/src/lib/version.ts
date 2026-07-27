// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Dotted-numeric version comparison for the browser.
 *
 * Intentionally a local copy of `packages/core/src/util/version.ts` rather than
 * an import: CLAUDE.md §7 lets the UI take TYPES from the core but never runtime
 * code, and this is a pure function with no server coupling. Keep the two in step
 * — the semantics (missing/non-numeric parts count as 0) are what the changelog's
 * "newer than you're running" badge depends on.
 */

/** True if `latest` is strictly newer than `current` (e.g. "1.2.0" vs "1.3.0"). */
export function isNewerVersion(current: string, latest: string): boolean {
  const a = String(current ?? '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const b = String(latest ?? '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (y > x) return true;
    if (y < x) return false;
  }
  return false;
}
