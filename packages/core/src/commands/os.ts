// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The platform's own commands — the `!os` namespace.
 *
 * Declared as data, the same way OS_ALERTS is in notify/alerts.ts, so the registry,
 * the menu and the Settings matrix all read one list.
 *
 * ── What is deliberately NOT here, and must not be added ─────────────────────────
 *
 * `reboot` — a wall-mounted box that does not come back needs someone to drive to the
 *   masjid, and there is no way to tell from a chat whether it came back. The one
 *   command whose failure mode cannot be reported through the channel that issued it.
 *
 * `logs` — container logs routinely carry tokens, personal data and payment details.
 *   A chat window is a bad log viewer and a permanent copy of it lives on someone's
 *   phone and in their cloud backup. The dashboard already shows logs, safely.
 *
 * `update` for the OS itself — it replaces the very process holding the conversation,
 *   so the "done" message can never arrive, and a half-applied core update is the
 *   failure that needs the installer. Updating one APP is fine and is offered below:
 *   it recreates only that app's container, so the core survives to report back.
 *
 * `remove` — irreversible data loss, from a channel whose strongest confirmation is a
 *   four-character code typed into a chat.
 */
import { OS_CONTROL, OS_READ, OS_SCOPE_WORD } from '../store/commands';
import type { CommandEntry } from './types';

export const OS_LABEL = 'OpenMasjidOS';
export { OS_SCOPE_WORD };

const read = (id: string, label: string, description: string): CommandEntry => ({
  id,
  label,
  description,
  scope: OS_READ,
  argKind: 'none',
  argRequired: false,
});

const control = (id: string, label: string, description: string, confirm: boolean): CommandEntry => ({
  id,
  label,
  description,
  scope: OS_CONTROL,
  argKind: 'app',
  argRequired: true,
  confirm: confirm || undefined,
});

/** In menu order. The numbering a volunteer sees comes from this array, so adding a
 *  command in the middle renumbers the menu — which is exactly why a number is only
 *  ever resolved against the menu that sender was shown (commands/parse.ts). */
export const OS_COMMANDS: CommandEntry[] = [
  read('stats', 'How the server is doing', 'Processor, memory, storage and how long it has been up.'),
  read('apps', 'List your apps', 'Which apps are installed, and which are running.'),
  read('updates', 'Which apps have an update waiting', 'Nothing is changed — it only looks.'),
  control('start', 'Start an app', 'Brings a stopped app back.', false),
  control('stop', 'Stop an app', 'Turns an app off until it is started again.', true),
  control('restart', 'Restart an app', 'Turns it off and on again — the usual fix for a stuck screen.', true),
  control('update', 'Update one app', 'Downloads and applies the latest version of one app.', true),
];
