// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Which image reference to trust for a container.
 *
 * This exists because of one specific, silent Docker behaviour that broke the entire
 * Development channel: **`listContainers()` does not reliably return the image NAME.**
 *
 * The daemon resolves that field lazily (moby `daemon/list.go`, `refreshImage`): it starts
 * from the name the container was created with, and if that name no longer resolves to the
 * same image ID it substitutes the image **ID** instead. Moving a tag is exactly what a pull
 * of `:dev` does — so the field flips from `repo:dev` to `a1b2c3d4e5f6` precisely when a new
 * build has arrived, i.e. exactly when we need it most.
 *
 * Observed directly (Docker 29.6.2), same container either side of a re-tag:
 *
 *   before:  listContainers().Image = localhost/movetest:dev   Config.Image = localhost/movetest:dev
 *   after:   listContainers().Image = 8a27b25386b7             Config.Image = localhost/movetest:dev
 *
 * The consequence: resolving that value back through `getImage(...).inspect()` returned the
 * OLD image the container is already running, the before/after comparison found them equal,
 * and the update reported "already running the latest Development build. Nothing was
 * changed." — forever, for every app on the channel.
 *
 * `Config.Image` is the reference the container was created with and is never rewritten, so
 * it is the one to resolve against. This module is pure so the rule is pinned by tests
 * rather than by a comment.
 */

/**
 * True when a string looks like a bare Docker image ID rather than a reference — a hex
 * digest, optionally `sha256:`-prefixed, with no repository or tag. Docker's short form is
 * 12 hex chars and the long form 64, but any all-hex run of 12+ is treated as an ID: a real
 * repository name that happens to be 12+ hex characters and nothing else does not occur, and
 * guessing "reference" for one would reintroduce the bug this file exists to prevent.
 */
export function looksLikeImageId(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  const bare = v.startsWith('sha256:') ? v.slice('sha256:'.length) : v;
  return /^[0-9a-f]{12,64}$/.test(bare);
}

/**
 * The reference to resolve for a container, given both sources.
 *
 * Prefers `Config.Image` (stable) and falls back to the `listContainers()` value only when
 * config is absent or is itself just an ID — a container really created from a bare ID has
 * no better answer, and returning it keeps the caller's "can't tell → recreate" path intact.
 */
export function containerImageRef(listImage: string | undefined, configImage: string | undefined): string {
  const config = (configImage ?? '').trim();
  const listed = (listImage ?? '').trim();
  if (config && !looksLikeImageId(config)) return config;
  if (listed && !looksLikeImageId(listed)) return listed;
  return config || listed;
}

/**
 * Every `image:` reference in a compose file, sorted so two files can be compared.
 *
 * Used to answer "did this update RETARGET the app at different images?", which decides
 * whether the Development digest short-circuit may run at all. That short-circuit resolves
 * the reference the RUNNING containers were created with — fine while an app tracks a moving
 * `:dev` tag (the same reference now points somewhere new), but wrong the moment a dev entry
 * starts publishing immutable per-build tags like `:0.11.0-dev.1`. There the old reference
 * keeps resolving to the old image forever, so before and after always match and the update
 * would skip the recreate every single time — the same silent no-op, arrived at from the
 * opposite direction.
 *
 * Deliberately a line scan and not a YAML parse: this runs on a compose we have already
 * validated (apps/compose-validate.ts), it must never throw, and "I could not read it" has to
 * degrade to "assume retargeted" — which an empty list does, since it can't equal the new one.
 */
export function composeImageRefs(compose: string): string[] {
  const out: string[] = [];
  for (const line of String(compose ?? '').split(/\r?\n/)) {
    const m = /^\s*image:\s*(.+)$/.exec(line);
    if (!m) continue;
    const value = m[1]
      .replace(/\s+#.*$/, '') // trailing comment
      .trim()
      .replace(/^["']|["']$/g, '')
      .trim();
    if (value && !value.startsWith('#')) out.push(value);
  }
  return out.sort();
}

/** Same set of image references, order-independent. Empty on either side means "different". */
export function sameImageRefs(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}
