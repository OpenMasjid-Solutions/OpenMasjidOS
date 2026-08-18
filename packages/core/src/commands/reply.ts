// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Every word the platform says back over WhatsApp. Pure — strings in, strings out.
 *
 * Rules, all of them enforced by test/command-reply.test.ts:
 *
 *   - PLAIN TEXT. No *bold*, no backticks, no tables, no links, no emoji. A message
 *     that looks templated is the thing that gets a number flagged, and the whole
 *     pacing policy exists to avoid exactly that.
 *   - At most MAX_REPLY_CHARS, truncated on a line boundary. One message, never a
 *     thread.
 *   - Never a secret, a session id, a filesystem path, the LAN address, or another
 *     person's number. A WhatsApp message lives on the recipient's phone and in their
 *     cloud backup, for good.
 *
 * ENGLISH ONLY. The core has no i18n — the same limitation the alert emails already
 * have. When the core gets i18n, this is one of the two files that need it. Do not
 * paper over it with a hand-rolled string table here.
 */
import type { CommandEntry, CommandNamespace } from './types';
import { channelLabel, type Channel } from '../system/channel';

export const MAX_REPLY_CHARS = 900;

export interface AppRow {
  id: string;
  name: string;
  running: boolean;
  updateAvailable?: boolean;
}

export interface UpdateRow {
  id: string;
  name: string;
  from?: string;
  to: string;
  /** A channel move can target an OLDER number, so it must never render as
   *  "1.4.0 to 1.3.9". The dashboard already learned this. */
  reason: 'version' | 'channel';
  /**
   * WHICH channel the app would move TO. Required when `reason` is 'channel', because
   * the move runs in both directions and the wording used to be hardcoded to
   * "Development" — so a masjid switching back to Stable was told its apps were moving
   * to Development, the exact opposite of what pressing update would do. The dashboard
   * words both directions; this is the same information reaching the WhatsApp reply.
   */
  channel?: Channel;
}

export interface StatsRow {
  cpuPercent: number;
  memUsed: number;
  memTotal: number;
  diskUsed: number;
  diskTotal: number;
  cpuTempC: number | null;
  uptimeSec: number;
  appsRunning: number;
}

// ── helpers ──────────────────────────────────────────────────────────────────────

/** Trim to the cap on a line boundary, so a reply never ends mid-word. */
export function cap(text: string, limit = MAX_REPLY_CHARS): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const nl = cut.lastIndexOf('\n');
  return (nl > limit * 0.5 ? cut.slice(0, nl) : cut.trimEnd()).trimEnd();
}

function gb(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    const v = bytes / 1024 ** 3;
    // One decimal only where it says something: "41 GB", not "41.0 GB".
    const shown = v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '');
    return `${shown} GB`;
  }
  return `${Math.max(0, Math.round(bytes / 1024 ** 2))} MB`;
}

function uptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  if (d >= 1) return d === 1 ? '1 day' : `${d} days`;
  const h = Math.floor(sec / 3600);
  if (h >= 1) return h === 1 ? '1 hour' : `${h} hours`;
  const m = Math.max(1, Math.floor(sec / 60));
  return m === 1 ? '1 minute' : `${m} minutes`;
}

/** Numbered lines that stop before the cap and say how many were left out, rather
 *  than trailing off. Silent truncation reads as "that's all of them". */
function numbered(intro: string, lines: string[], outro: string): string {
  const head = `${intro}\n\n`;
  const budget = MAX_REPLY_CHARS - head.length - outro.length - 40;
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  const more = lines.length - kept.length;
  const tail = more > 0 ? `\n...and ${more} more. The dashboard has the full list.` : '';
  return `${head}${kept.join('\n')}${tail}\n\n${outro}`;
}

// ── the replies ──────────────────────────────────────────────────────────────────

export function helpText(name: string, namespaces: CommandNamespace[]): string {
  if (namespaces.length === 0) {
    return "You're on the list, but nothing has been shared with you yet. Ask whoever looks after the server.";
  }
  const lines = namespaces.map((ns) =>
    ns.word === 'os' ? `!os - the server itself: how it's doing, your apps, updates` : `!${ns.word} - ${ns.label}`,
  );
  return cap(
    `Hello ${name}. Here's what you can ask me.\n\n${lines.join('\n')}\n\n` +
      'Send one of those on its own to see what it can do.',
  );
}

export function menuText(ns: CommandNamespace): string {
  const lines = ns.commands.map((c, i) => {
    const arg = c.argKind === 'text' && c.argument ? ` - add your ${c.argument.label} after the number` : '';
    const app = c.argKind === 'app' ? ' - say which app' : '';
    return `${i + 1}. ${c.label}${arg}${app}`;
  });
  return cap(numbered(`${ns.label} can do these:`, lines, `Send the number, like !${ns.word} 1.`));
}

export function statsText(s: StatsRow): string {
  const memPct = s.memTotal > 0 ? (s.memUsed / s.memTotal) * 100 : 0;
  const diskPct = s.diskTotal > 0 ? (s.diskUsed / s.diskTotal) * 100 : 0;
  let lead = 'OpenMasjidOS looks healthy.';
  if (diskPct >= 90) lead = 'OpenMasjidOS is running, but storage is nearly full.';
  else if (memPct >= 90) lead = 'OpenMasjidOS is running, but memory is nearly full.';
  else if (s.cpuTempC != null && s.cpuTempC >= 80) lead = "OpenMasjidOS is running, but it's getting hot.";

  const lines = [
    `Processor: ${Math.round(s.cpuPercent)}% busy`,
    `Memory: ${gb(s.memUsed)} of ${gb(s.memTotal)} used`,
    `Storage: ${gb(s.diskUsed)} of ${gb(s.diskTotal)} used`,
    // Omitted rather than printed as "n/a": most hardware has no temperature sensor,
    // and a permanent "unavailable" line trains people to ignore the whole block.
    ...(s.cpuTempC != null ? [`Temperature: ${Math.round(s.cpuTempC)}C`] : []),
    `Up and running for ${uptime(s.uptimeSec)}`,
    `${s.appsRunning} ${s.appsRunning === 1 ? 'app' : 'apps'} running`,
  ];
  return cap(`${lead}\n\n${lines.join('\n')}`);
}

export function appListText(apps: AppRow[]): string {
  if (apps.length === 0) return "You don't have any apps installed yet.";
  const lines = apps.map((a, i) => {
    const state = a.running ? 'running' : 'stopped';
    return `${i + 1}. ${a.name} - ${state}${a.updateAvailable ? ', an update is waiting' : ''}`;
  });
  return cap(numbered('Your apps:', lines, 'To start or stop one, send !os start 1 or !os stop 1.'));
}

export function pickAppText(command: CommandEntry, apps: AppRow[]): string {
  if (apps.length === 0) return "You don't have any apps installed yet.";
  const lines = apps.map((a, i) => `${i + 1}. ${a.name} - ${a.running ? 'running' : 'stopped'}`);
  return cap(numbered(`Which app should I ${command.id}?`, lines, `Send !os ${command.id} 1.`));
}

export function updatesText(rows: UpdateRow[]): string {
  if (rows.length === 0) return 'Everything is up to date.';
  const lines = rows.map((r, i) =>
    r.reason === 'channel'
      ? // Name the direction. `channelLabel` is the same "Stable"/"Development" wording
        // the dashboard and Settings use, so the three agree. An absent channel falls
        // back to the direction-free phrasing rather than guessing one.
        `${i + 1}. ${r.name} - ${r.channel ? `moving to the ${channelLabel(r.channel)} version` : 'moving to your selected version'}`
      : `${i + 1}. ${r.name} - ${r.from ?? '?'} to ${r.to}`,
  );
  const intro = rows.length === 1 ? 'One app has an update waiting:' : `${rows.length} apps have an update waiting:`;
  return cap(numbered(intro, lines, 'To update one, send !os update 1.'));
}

export function confirmText(question: string, consequence: string, code: string): string {
  return cap(
    `${question}\n${consequence}\n\nReply  !yes ${code}  to go ahead.\n` +
      'Ignore this to cancel. It expires in 90 seconds.',
  );
}

export const say = {
  notAllowed: (word: string) => `You don't have access to !${word}. Ask whoever looks after the server.`,
  unknownNamespace: (word: string, suggestion?: string) =>
    suggestion
      ? `I don't know !${word}. Did you mean !${suggestion}? Send !help to see everything.`
      : `I don't know !${word}. Send !help to see everything.`,
  unknownCommand: (ns: CommandNamespace, word: string, suggestion?: string) =>
    suggestion
      ? `${ns.label} has no "${word}". Did you mean "${suggestion}"? Send !${ns.word} for the list.`
      : `${ns.label} has no "${word}". Send !${ns.word} for the list.`,
  badNumber: (ns: CommandNamespace, max: number) =>
    max === 0
      ? `${ns.label} has nothing you can run.`
      : `Pick a number between 1 and ${max}. Send !${ns.word} for the list.`,
  missingArgument: (ns: CommandNamespace, c: CommandEntry) =>
    `That one needs your ${c.argument?.label ?? 'message'} after it, like !${ns.word} ${c.id} something.`,
  unwantedArgument: (ns: CommandNamespace, c: CommandEntry) =>
    `"${c.label}" doesn't take anything after it, so I've not run it. Send !${ns.word} ${c.id} on its own.`,
  unknownApp: (word: string) => `I can't find an app called "${word}". Send !os apps to see the list.`,
  tooLong: () => "That's longer than I can read. Send just the command.",
  throttled: () => 'Too many commands at once. Try again in a minute.',
  expiredConfirm: () => 'That has expired. Send the command again if you still want to.',
  expiredMenu: (word: string) => `That list has expired. Send !${word} for a fresh one.`,
  cancelled: () => "Alright, I've left it alone.",
  sessionEnded: () => "Alright, we're done. Send a command starting with ! whenever you need me.",
  answerYesOrNo: () => "Just reply yes or no — or send exit to leave it.",
  sessionLost: (appName: string) =>
    `${appName} can't carry on with that. Start again when you're ready.`,
  nothingToCancel: () => "There's nothing waiting for an answer.",
  // Deliberately NOT "Update failed": a refusal is information, and calling it a
  // failure is what pushes an admin into retrying the thing that is already running.
  busy: (message: string) => message,
  managedApp: (name: string) =>
    `${name} is managed from Settings, because changing it here would disconnect WhatsApp.`,
  // There is no `budgetSpent` message any more. It said "I've hit today's WhatsApp
  // limit, so I've not run that" and was shown for every mutating command — including
  // `!os update`, which is how it was found — because the allowance it reported on is
  // one that replies never spend. The check is gone (see notify/whatsapp.ts), so the
  // sentence must go with it: a reply that explains a rule the code no longer applies is
  // worse than no reply.
};

/** What the admin sees when an app cannot be asked, or answers badly. Plain language,
 *  always a next step, never a status code. */
export function appFailureText(appName: string, code: string, appId: string): string {
  switch (code) {
    case 'target_not_installed':
      return `${appName} isn't installed on this server any more.`;
    case 'target_unreachable':
      return `${appName} isn't running at the moment, so I couldn't ask it. Send !os apps to see what's running.`;
    case 'timeout':
      return `${appName} didn't answer in time. It may be busy - try again in a minute.`;
    case 'response_too_large':
      return `${appName} sent back more than fits in a message. Have a look on the dashboard instead.`;
    case 'unknown_command':
      return `${appName} doesn't have that any more - it was probably changed in an update. Send !${appId} for its current list.`;
    case 'not_ready':
      return `${appName} is still starting up. Give it a minute and try again.`;
    case 'payload_too_large':
      return 'That message was too long to pass on. Try saying it more briefly.';
    case 'no_secret':
      return `${appName} isn't set up to take commands on this server. Updating it should fix it.`;
    default:
      return `${appName} answered in a way I didn't understand. Nothing was changed.`;
  }
}
