// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The public surface of `@openmasjid/ui` — the OpenMasjid design system.
 *
 * Another app imports from HERE and from `@openmasjid/ui/styles.css`, and from
 * nowhere else. Deep imports into `src/` are not supported and are refused by a
 * gate: they would couple an app to our file layout, so a rename here would
 * break six repos silently.
 *
 * WHAT IS AND IS NOT EXPORTED. This package is two things living in one folder:
 * the OpenMasjidOS dashboard (`main.tsx`, `App.tsx`, `routes/`) and the design
 * system every app shares. Only the second is exported. The dashboard's own
 * screens, its tRPC client, its window manager and its preference store stay
 * internal — they are OpenMasjidOS features, not a design system, and exporting
 * them would make every other app inherit a desktop metaphor it does not want.
 *
 * It is deliberately thin right now: the primitives land in Slices 5–10 and the
 * motion vocabulary in Slice 11, and each is added here as it lands. A barrel
 * that re-exports things which do not exist yet is worse than a short one.
 *
 * Everything listed here is mirrored in `ui-manifest.json`, which a gate checks
 * against reality — so this file and the published contract cannot drift.
 */

export { cn } from './lib/cn';

// Primitives. Exported one at a time as each is added and checked in all four
// panes of /design-system (light+dark x LTR+RTL), never in a batch — the RTL
// bug in the very first one shipped was invisible in review.
export { Switch } from './components/ui/switch';
export { Checkbox } from './components/ui/checkbox';
export { Label } from './components/ui/label';
export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu';
