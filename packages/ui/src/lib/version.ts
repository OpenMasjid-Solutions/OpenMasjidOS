// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Semver precedence for the browser, prereleases included.
 *
 * Intentionally a local copy of `packages/core/src/util/version.ts` rather than an
 * import: CLAUDE.md §7 lets the UI take TYPES from the core but never runtime code,
 * and this is a pure function with no server coupling. **Keep the two in step** — the
 * changelog's "newer than you're running" badge depends on these exact semantics, and
 * a Development build's version is a prerelease (`0.50.0-dev.1`), so getting the
 * prerelease rule wrong here shows the badge on a release the box already runs.
 *
 *   0.49.3  <  0.50.0-dev.1  <  0.50.0-dev.2  <  0.50.0
 *
 * The core file carries the full reasoning.
 */

interface Parsed {
  core: number[];
  pre: string[];
}

function parse(version: string): Parsed {
  const s = String(version ?? '')
    .trim()
    .replace(/^v/i, '');
  const noBuild = s.split('+')[0] ?? '';
  const dash = noBuild.indexOf('-');
  const coreText = dash === -1 ? noBuild : noBuild.slice(0, dash);
  const preText = dash === -1 ? '' : noBuild.slice(dash + 1);
  const core = coreText.split('.').map((n) => Number.parseInt(n, 10) || 0);
  while (core.length < 3) core.push(0);
  return { core, pre: preText ? preText.split('.').filter((p) => p.length > 0) : [] };
}

function comparePre(a: string[], b: string[]): number {
  // A release outranks any prerelease of the same core version.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      // Numerically, so -dev.10 beats -dev.9.
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Semver precedence: <0 if a is older, 0 if equal, >0 if a is newer. */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i++) {
    const x = pa.core[i] ?? 0;
    const y = pb.core[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return comparePre(pa.pre, pb.pre);
}

/** True if `latest` is strictly newer than `current`. */
export function isNewerVersion(current: string, latest: string): boolean {
  return compareVersions(current, latest) < 0;
}

/** True for a prerelease such as `0.50.0-dev.1` — i.e. a Development build. */
export function isPrerelease(version: string): boolean {
  return parse(version).pre.length > 0;
}
