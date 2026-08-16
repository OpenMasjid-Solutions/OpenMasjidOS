// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Shared shapes for admin commands over WhatsApp.
 *
 * The vocabulary, because two words here are easy to confuse:
 *   - a NAMESPACE is the word typed after `!` — `os`, or an app id.
 *   - a SCOPE is what an admin grants a person — `os:read`, `os:control`, or an
 *     app id. The `os` namespace has two scopes; an app namespace has one.
 */
import type { DeclaredCommand } from '../apps/types';

/** How a command reads the text after its name. */
export type ArgKind =
  /** Takes nothing. Text after it is a mistake, and is refused rather than dropped. */
  | 'none'
  /** Free text, passed to the app verbatim. */
  | 'text'
  /** An installed app — by id, or by a number from the app list. OS verbs only. */
  | 'app';

/** A command as the platform sees it: the declaration plus who may run it. */
export interface CommandEntry extends DeclaredCommand {
  /** The scope key that grants it. */
  scope: string;
  argKind: ArgKind;
  /** True when the argument must be present. */
  argRequired: boolean;
}

/** One `!word` namespace, holding only the commands a given sender may run. */
export interface CommandNamespace {
  /** The word typed after `!`. */
  word: string;
  /** Display name — 'OpenMasjidOS', or the app's name. */
  label: string;
  commands: CommandEntry[];
}

/** One row of the Settings permission matrix: one thing an admin can grant. */
export interface CommandGrantInfo {
  /** The stored scope key. */
  key: string;
  /** Group heading — 'OpenMasjidOS' or the app's name. */
  group: string;
  /** Row label within the group. Empty for an app: the group already names it. */
  label: string;
  /** The namespace word a person types to reach it. */
  word: string;
  /**
   * False when there is nothing to grant — an app that declares no commands. The UI
   * shows why instead of a dead toggle, and `namespacesFor` enforces it on READ, so
   * a stale grant in the file confers nothing.
   */
  available: boolean;
  reason?: 'no-commands';
  /** Command labels, so a grant is legible before it is ticked. */
  commands: { id: string; label: string }[];
}

/** What a bare number resolves against: the menu this sender was actually shown. */
export interface MenuSnapshot {
  /** The namespace word the menu was for. */
  word: string;
  at: number;
  /** Command ids, in the order they were numbered. */
  ids: string[];
}

/** The numbered app list, consumable only as an OS verb's argument. */
export interface AppListSnapshot {
  at: number;
  ids: string[];
}
