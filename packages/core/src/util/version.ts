// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Semver precedence, including PRERELEASES.
 *
 * Prereleases are what make the Development channel work at all. Before them, a dev
 * build carried the same version string as the stable release it came from and pointed
 * at a moving `:dev` tag — so nothing observable changed when a new build was
 * published, no update could be detected, and no-one could be notified. The platform
 * grew a whole parallel mechanism (compare image digests, ask the catalogue to publish
 * them, a "check for a new Development build" button) purely to fake a version axis
 * that wasn't there. Giving dev builds real versions — `0.50.0-dev.1` — deleted all of
 * it and let Development use the same code path as Stable.
 *
 * So the ordering below is load-bearing, and it is the semver spec's, not an
 * approximation:
 *
 *   0.49.3  <  0.50.0-dev.1  <  0.50.0-dev.2  <  0.50.0
 *
 * A prerelease sorts ABOVE the last release and BELOW the release it precedes, which
 * is exactly true of a dev build: ahead of what's shipped, not yet shipped itself.
 * The naive dotted-numeric compare this replaces got the right-hand end backwards —
 * it read `0.50.0-dev.4` as `[0,50,0,4]` and so called it *newer* than `0.50.0`,
 * which would offer a masjid a "downgrade" to the release they should be moving to.
 *
 * Note `-dev.10 > -dev.9`: prerelease numbers compare NUMERICALLY, not as text.
 * Lexically "10" < "9", so a text compare silently stops offering updates at the
 * tenth dev build of a version — quiet, and very hard to notice.
 */

interface Parsed {
  /** major, minor, patch — always three entries. */
  core: number[];
  /** Dot-separated prerelease identifiers; empty for a real release. */
  pre: string[];
}

function parse(version: string): Parsed {
  // Tolerant on input: these strings come from a VERSION file, a catalog entry and a
  // meta.json written by an older build. A malformed one must sort predictably rather
  // than throw in the middle of an update check.
  const s = String(version ?? '')
    .trim()
    .replace(/^v/i, '');
  const noBuild = s.split('+')[0] ?? ''; // build metadata is ignored for precedence
  const dash = noBuild.indexOf('-');
  const coreText = dash === -1 ? noBuild : noBuild.slice(0, dash);
  const preText = dash === -1 ? '' : noBuild.slice(dash + 1);
  const core = coreText.split('.').map((n) => Number.parseInt(n, 10) || 0);
  while (core.length < 3) core.push(0); // "0.50" and "0.50.0" are the same version
  return { core, pre: preText ? preText.split('.').filter((p) => p.length > 0) : [] };
}

/** Semver prerelease precedence. Returns <0, 0 or >0 for a vs b. */
function comparePre(a: string[], b: string[]): number {
  // A release outranks any prerelease of the same core version. This is the rule the
  // old numeric-only compare got wrong.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    // All preceding identifiers equal: fewer fields sorts lower (`-dev` < `-dev.1`).
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1; // numeric identifiers sort below alphanumeric ones
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
