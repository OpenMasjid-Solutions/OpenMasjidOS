// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * What commands exist, and which of them a given person may run.
 *
 * `namespacesFor()` is the single place membership and scope are turned into a
 * concrete list, and availability is enforced HERE, on read — never merely hidden in
 * the UI. That is the lesson from `getAlertChannels` in notify/alerts.ts: a grant to
 * an app that has since withdrawn its commands, or been uninstalled, must confer
 * nothing, whatever the config file still says.
 */
import { listAppCommands, listMetaSummaries } from '../apps/manager';
import { authoriseSender, OS_CONTROL, OS_READ } from '../store/commands';
import { isPlatformManaged } from '../apps/managed';
import { OS_COMMANDS, OS_LABEL, OS_SCOPE_WORD } from './os';
import type { CommandEntry, CommandGrantInfo, CommandNamespace } from './types';

/** Turn one app's declarations into entries. The app id IS the scope key. */
function appEntries(appId: string, commands: { id: string; label: string; description?: string; argument?: { label: string; required?: boolean }; confirm?: boolean }[]): CommandEntry[] {
  return commands.map((c) => ({
    ...c,
    scope: appId,
    argKind: c.argument ? ('text' as const) : ('none' as const),
    // An argument is required unless the manifest explicitly says otherwise.
    argRequired: Boolean(c.argument) && c.argument?.required !== false,
  }));
}

/** Every namespace that exists right now, with all of its commands. Unfiltered — for
 *  the Settings matrix and the admin preview, never for dispatch. */
export function listNamespaces(): CommandNamespace[] {
  const out: CommandNamespace[] = [{ word: OS_SCOPE_WORD, label: OS_LABEL, commands: OS_COMMANDS }];
  for (const app of listAppCommands()) {
    // The WhatsApp gateway is platform-managed and hidden everywhere else; it has no
    // business appearing as a namespace either.
    if (isPlatformManaged(app.appId)) continue;
    out.push({ word: app.appId, label: app.appName, commands: appEntries(app.appId, app.commands) });
  }
  return out;
}

/**
 * The namespaces THIS sender may use, holding only the commands they may run.
 *
 * Returns [] for anyone not on the list and for everyone when the feature is off.
 * An empty result must be treated as silence, not as a refusal message.
 */
export function namespacesFor(rawFrom: string | null | undefined): CommandNamespace[] {
  const person = authoriseSender(rawFrom);
  if (!person) return [];
  const granted = new Set(person.scopes);
  const out: CommandNamespace[] = [];
  for (const ns of listNamespaces()) {
    const commands = ns.commands.filter((c) => granted.has(c.scope));
    if (commands.length) out.push({ ...ns, commands });
  }
  return out;
}

/** Every row of the Settings permission matrix, including the ones that cannot be
 *  granted because the app declares nothing — the UI needs to say WHY. */
export function listGrants(): CommandGrantInfo[] {
  const label = (c: CommandEntry) => ({ id: c.id, label: c.label });
  const out: CommandGrantInfo[] = [
    {
      key: OS_READ,
      group: OS_LABEL,
      label: 'View',
      word: OS_SCOPE_WORD,
      available: true,
      commands: OS_COMMANDS.filter((c) => c.scope === OS_READ).map(label),
    },
    {
      key: OS_CONTROL,
      group: OS_LABEL,
      label: 'Control',
      word: OS_SCOPE_WORD,
      available: true,
      commands: OS_COMMANDS.filter((c) => c.scope === OS_CONTROL).map(label),
    },
  ];

  const declared = new Map(listAppCommands().map((a) => [a.appId, a]));
  for (const app of listMetaSummaries()) {
    if (isPlatformManaged(app.id)) continue;
    const d = declared.get(app.id);
    out.push({
      key: app.id,
      group: app.name,
      label: '',
      word: app.id,
      available: Boolean(d?.commands.length),
      reason: d?.commands.length ? undefined : 'no-commands',
      commands: (d?.commands ?? []).map((c) => ({ id: c.id, label: c.label })),
    });
  }
  return out;
}

/** Is this scope key something that can actually be granted right now? Used to refuse
 *  storing a grant nobody would ever read. */
export function isGrantable(scope: string): boolean {
  return listGrants().some((g) => g.key === scope && g.available);
}
