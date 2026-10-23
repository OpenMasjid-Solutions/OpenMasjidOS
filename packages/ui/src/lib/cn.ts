// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Combine class names, with later Tailwind utilities beating earlier ones.
 *
 * WHY THIS IS A RE-EXPORT AND NOT AN IMPLEMENTATION. The shadcn CLI writes
 * `import { cn } from "cn"` into every component it generates — it no longer
 * honours `aliases.utils` for this — so the `cn` package is on the critical
 * path whether we use it or not. Keeping our own `clsx` + `tailwind-merge`
 * version beside it would mean two class-merging implementations that could
 * disagree, and the only way to avoid that would be hand-editing every
 * generated primitive, which is the one thing that must stay re-runnable.
 *
 * So `cn` is the implementation, and `clsx` + `tailwind-merge` were dropped:
 * the package bundles compiled equivalents of both (486 KB unpacked against
 * their combined 1,147 KB), which also suits a design system that has to stay
 * light on a Raspberry Pi.
 *
 * This file stays as the SEAM. Six modules and the public `index.ts` import
 * `cn` from here rather than from the package, so swapping the implementation
 * back — if `cn`, still young at 0.3.x, ever disappoints — is a one-line change
 * here instead of an edit in every call site and every generated primitive.
 *
 * What it must do is pinned by a behavioural test rather than by reading this
 * source: `cn('px-4', 'px-2')` has to yield `px-2`. Plain concatenation returns
 * both and lets stylesheet order pick the winner, which is the bug where a
 * wrapper's override silently does nothing.
 */
export { cn } from 'cn';
export type { ClassValue } from 'cn';
