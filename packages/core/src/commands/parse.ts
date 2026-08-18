// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Turn a WhatsApp message into a resolved action. Pure: no clock, no I/O, no store,
 * and it returns no user-facing text — every string a phone sees comes from
 * commands/reply.ts. That is what makes it exhaustively testable.
 *
 * TWO RULES THAT MUST NOT SOFTEN:
 *
 * 1. Every command starts with `!`. No exemptions — not for a menu number, not for a
 *    confirmation. The masjid's number is a real number that real people message, and
 *    the prefix is the only thing keeping an ordinary conversation ordinary. A carve-
 *    out for bare words is a carve-out in the gate, and that is where gates rot.
 *
 * 2. Matching is exact. A near miss is SUGGESTED and never run. `!stpo display` must
 *    not become `!stop display` because the platform thought it knew best.
 */
import type { CommandEntry, CommandNamespace, MenuSnapshot } from './types';
import { COMMAND_PREFIX } from '../store/commands';

/** A menu older than this is not what the sender is looking at. */
export const MENU_TTL_MS = 5 * 60_000;
/** Longer than any command; the gate already caps the whole body at 512. */
const MAX_ARG_CHARS = 300;
const MAX_BODY_CHARS = 512;

export interface ParseContext {
  now: number;
  /** Already filtered to this sender by registry.namespacesFor(). The parser never
   *  re-decides authorisation; it only reports when a word exists but is not here. */
  namespaces: CommandNamespace[];
  /** Every namespace that exists, for telling "you may not" from "no such thing". */
  allWords: string[];
  /** The last menu this sender was shown, if any. */
  menu: MenuSnapshot | null;
}

export type ParseResult =
  /** Not a command at all. Say nothing, store nothing, log nothing. */
  | { kind: 'ignore' }
  | { kind: 'help' }
  | { kind: 'menu'; ns: CommandNamespace }
  | { kind: 'confirm'; code: string }
  | { kind: 'cancel' }
  | { kind: 'run'; ns: CommandNamespace; command: CommandEntry; text?: string }
  /** An OS verb that needs an app, with none named — the reply is the app list. */
  | { kind: 'need-app'; ns: CommandNamespace; command: CommandEntry }
  | { kind: 'unknown-namespace'; word: string; suggestion?: string }
  | { kind: 'unknown-command'; ns: CommandNamespace; word: string; suggestion?: string }
  | { kind: 'not-allowed'; word: string }
  | { kind: 'bad-number'; ns: CommandNamespace; max: number }
  | { kind: 'missing-argument'; ns: CommandNamespace; command: CommandEntry }
  | { kind: 'unwanted-argument'; ns: CommandNamespace; command: CommandEntry }
  | { kind: 'too-long' };

/** Words the platform owns at the top level, so no app can shadow them. Mirrored by
 *  the reserved-id check in apps/manager.ts parseCommands. */
const HELP_WORDS = new Set(['help', '?']);
const YES_WORDS = new Set(['yes', 'y']);
const NO_WORDS = new Set(['no', 'n', 'cancel']);

export function parseCommand(raw: string, ctx: ParseContext): ParseResult {
  const body = String(raw ?? '')
    // A leading non-breaking space (phone keyboards insert them) would otherwise
    // stop the prefix ever matching.
    .replace(/^[\s ​﻿]+/, '')
    .trimEnd();

  if (!body.startsWith(COMMAND_PREFIX)) return { kind: 'ignore' };
  if (body.length > MAX_BODY_CHARS) return { kind: 'too-long' };

  const rest = body.slice(COMMAND_PREFIX.length).trim();
  if (!rest) return { kind: 'help' };

  const [firstRaw, ...tailParts] = rest.split(/\s+/);
  const first = normaliseWord(firstRaw!);
  const tail = rest.slice(firstRaw!.length).trim();

  if (HELP_WORDS.has(first)) return { kind: 'help' };
  if (YES_WORDS.has(first)) {
    // The code is what makes a confirmation refer to ONE prompt. Recognised here;
    // matched against the pending action by the caller, which owns that state.
    const code = normaliseWord(tailParts[0] ?? '');
    return { kind: 'confirm', code };
  }
  if (NO_WORDS.has(first)) return { kind: 'cancel' };

  const ns = ctx.namespaces.find((n) => n.word === first);
  if (!ns) {
    // "You may not" and "no such thing" are different answers, and only the first is
    // safe to give — but both go to someone already on the list, so both are fine.
    if (ctx.allWords.includes(first)) return { kind: 'not-allowed', word: first };
    return { kind: 'unknown-namespace', word: first, suggestion: suggest(first, ctx.namespaces.map((n) => n.word)) };
  }

  if (!tail) return { kind: 'menu', ns };

  const [selectorRaw, ...argParts] = tail.split(/\s+/);
  const selector = normaliseWord(selectorRaw!);
  const argText = tail.slice(selectorRaw!.length).trim();

  let command: CommandEntry | undefined;
  if (/^\d{1,3}$/.test(selector)) {
    const n = Number.parseInt(selector, 10);
    // Resolve against the menu this sender was SHOWN. A positional index into the
    // current list would silently move when an app update inserts a command — so
    // "2" would stop meaning what it meant when they read it. Only when there is no
    // live menu do we fall back to the current order.
    const live = ctx.menu && ctx.menu.word === ns.word && ctx.now - ctx.menu.at <= MENU_TTL_MS ? ctx.menu : null;
    const ids = live ? live.ids : ns.commands.map((c) => c.id);
    if (n < 1 || n > ids.length) return { kind: 'bad-number', ns, max: ns.commands.length };
    // Re-validate against what exists NOW: a snapshot can name a command the app has
    // since withdrawn, and a stale number must not run something else.
    command = ns.commands.find((c) => c.id === ids[n - 1]);
    if (!command) return { kind: 'unknown-command', ns, word: selector };
  } else {
    command = ns.commands.find((c) => c.id === selector);
    if (!command) {
      const known = ns.commands.map((c) => c.id);
      // Distinguish "that command exists but is not yours" from "no such command".
      return { kind: 'unknown-command', ns, word: selector, suggestion: suggest(selector, known) };
    }
  }

  const text = argText.slice(0, MAX_ARG_CHARS) || undefined;
  void argParts;

  if (command.argKind === 'none') {
    // Refused, never silently dropped: a volunteer who typed a notice must not be
    // told "done" when the notice went nowhere.
    if (text) return { kind: 'unwanted-argument', ns, command };
    return { kind: 'run', ns, command };
  }
  if (command.argKind === 'app' && !text) return { kind: 'need-app', ns, command };
  if (command.argRequired && !text) return { kind: 'missing-argument', ns, command };
  return { kind: 'run', ns, command, text };
}

/** Lowercase and strip the smart punctuation phone keyboards insert. Applied to the
 *  KEYWORD only — an argument keeps whatever the sender typed, apostrophes, RTL and
 *  all, because it is the app's text and not ours to tidy. */
function normaliseWord(w: string): string {
  const base = w.toLowerCase().replace(/[‘’“”]/g, '');
  // Trailing punctuation is a slip ("!display."), so drop it — unless that would
  // leave nothing, which is how a bare "!?" asks for help.
  const trimmed = base.replace(/[.,;:!?]+$/, '');
  return trimmed || base;
}

/** The closest known word within edit distance 2 — printed as a hint, never run. */
function suggest(word: string, known: string[]): string | undefined {
  let best: string | undefined;
  let bestD = 3;
  for (const k of known) {
    const d = distance(word, k);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length]!;
}
