// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Shared Motion presets so transitions feel consistent (CLAUDE.md §14). Motion does
 * NOT honour prefers-reduced-motion by itself — App.tsx's `MotionConfig
 * reducedMotion="user"` is what makes these presets respect it — and our global CSS
 * collapses CSS transitions too.
 */
import type { Variants, Transition } from 'motion/react';

export const springSoft: Transition = { type: 'spring', stiffness: 320, damping: 30, mass: 0.9 };

/** Gentle crossfade + slight rise — used for route/page entrances. */
export const fadeRise: Variants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { ...springSoft } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.18 } },
};

/** Staggered container for grids of cards. */
export const staggerContainer: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0.05, delayChildren: 0.04 } },
};

export const staggerItem: Variants = {
  initial: { opacity: 0, y: 14, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1, transition: { ...springSoft } },
};
