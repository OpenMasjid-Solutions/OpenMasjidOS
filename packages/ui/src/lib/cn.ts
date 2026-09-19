// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import clsx, { type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Combine class names, with later Tailwind utilities beating earlier ones.
 *
 * `clsx` alone is not enough once components carry their own utilities. Given
 * `cn('px-4', props.className)` where the caller passes `px-2`, plain clsx emits
 * BOTH — and which one wins is then decided by their order in the generated
 * stylesheet, not by the caller. That is the bug where a wrapper's override
 * silently does nothing, and it is unfixable from the call site.
 *
 * `twMerge` resolves conflicts by Tailwind's own group semantics, so the last
 * value for a given property wins and a wrapper can always override the
 * component it wraps. This is the whole reason shadcn ships the two together.
 *
 * Non-Tailwind class names (our hand-written BEM-ish ones, e.g. `glass-raised`,
 * `app-card`) are passed through untouched — twMerge only reasons about classes
 * it recognises, so the two systems coexist during the migration.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
