// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The command parser — the bulk of the behaviour, and pure, so it can be tested
 * exhaustively without a gateway.
 *
 * Two properties matter more than the rest and are asserted from several angles:
 *   - the `!` prefix is absolute, so ordinary conversation with the masjid's number
 *     is never touched;
 *   - a menu number resolves against the menu THAT SENDER WAS SHOWN, not a positional
 *     index into the current list, which moves when an app update adds a command.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, MENU_TTL_MS, type ParseContext } from '../src/commands/parse';
import type { CommandEntry, CommandNamespace } from '../src/commands/types';

const cmd = (id: string, extra: Partial<CommandEntry> = {}): CommandEntry => ({
  id,
  label: id,
  scope: 'display',
  argKind: 'none',
  argRequired: false,
  ...extra,
});

const OS: CommandNamespace = {
  word: 'os',
  label: 'OpenMasjidOS',
  commands: [
    cmd('stats', { scope: 'os:read' }),
    cmd('apps', { scope: 'os:read' }),
    cmd('restart', { scope: 'os:control', argKind: 'app', argRequired: true, confirm: true }),
  ],
};

const DISPLAY: CommandNamespace = {
  word: 'display',
  label: 'Notice Board',
  commands: [
    cmd('whats-on'),
    cmd('post-notice', { argKind: 'text', argRequired: true, argument: { label: 'message' } }),
    cmd('clear', { confirm: true }),
  ],
};

const NOW = 1_000_000;
function ctx(over: Partial<ParseContext> = {}): ParseContext {
  return { now: NOW, namespaces: [OS, DISPLAY], allWords: ['os', 'display', 'donations'], menu: null, ...over };
}

// ── the prefix rule ──────────────────────────────────────────────────────────────

test('anything without the prefix is ignored completely', () => {
  for (const body of [
    'Assalamu alaikum, is the hall free on Saturday?',
    'yes',
    'y',
    '2',
    'os apps',
    'stop',
    '',
    '   ',
    'help',
  ]) {
    assert.deepEqual(parseCommand(body, ctx()), { kind: 'ignore' }, `"${body}" must be ignored`);
  }
});

test('a leading invisible space does not break the prefix', () => {
  // Phone keyboards insert non-breaking and zero-width spaces; the sender cannot see
  // them and would have no idea why nothing happened.
  assert.equal(parseCommand(' !os stats', ctx()).kind, 'run');
  assert.equal(parseCommand('​!os stats', ctx()).kind, 'run');
  assert.equal(parseCommand('  !os stats', ctx()).kind, 'run');
});

// ── help and menus ───────────────────────────────────────────────────────────────

test('bare ! and !help both ask for help', () => {
  assert.equal(parseCommand('!', ctx()).kind, 'help');
  assert.equal(parseCommand('!help', ctx()).kind, 'help');
  assert.equal(parseCommand('!HELP', ctx()).kind, 'help');
  assert.equal(parseCommand('!?', ctx()).kind, 'help');
});

test('a namespace on its own is a menu', () => {
  const r = parseCommand('!display', ctx());
  assert.equal(r.kind, 'menu');
  assert.equal(r.kind === 'menu' && r.ns.word, 'display');
});

test('the keyword is case-insensitive but an argument is left exactly as typed', () => {
  const r = parseCommand("!DISPLAY Post-Notice Jumu'ah is at 1:30 — bring the KIDS", ctx());
  assert.equal(r.kind, 'run');
  assert.equal(r.kind === 'run' && r.command.id, 'post-notice');
  assert.equal(
    r.kind === 'run' && r.text,
    "Jumu'ah is at 1:30 — bring the KIDS",
    'the curly apostrophe, the dash and the capitals all survive',
  );
});

// ── exact matching only ──────────────────────────────────────────────────────────

test('a near miss is suggested, never run', () => {
  const r = parseCommand('!displya', ctx());
  assert.equal(r.kind, 'unknown-namespace');
  assert.equal(r.kind === 'unknown-namespace' && r.suggestion, 'display');

  const c = parseCommand('!display clera', ctx());
  assert.equal(c.kind, 'unknown-command');
  assert.equal(c.kind === 'unknown-command' && c.suggestion, 'clear');
});

test('a namespace that exists but is not granted says so', () => {
  // Distinct from "no such thing" — and safe, because the sender is already on the
  // list. An unknown sender never reaches the parser at all.
  const r = parseCommand('!donations', ctx());
  assert.deepEqual(r, { kind: 'not-allowed', word: 'donations' });
});

// ── menu numbers ─────────────────────────────────────────────────────────────────

test('a number resolves against the menu the sender was SHOWN', () => {
  // The app has since reordered its commands. "2" must still mean what it meant on
  // the screen the sender is looking at.
  const reordered: CommandNamespace = { ...DISPLAY, commands: [DISPLAY.commands[2]!, DISPLAY.commands[0]!, DISPLAY.commands[1]!] };
  const r = parseCommand('!display 2', ctx({
    namespaces: [OS, reordered],
    menu: { word: 'display', at: NOW - 1000, ids: ['whats-on', 'post-notice', 'clear'] },
  }));
  assert.equal(r.kind, 'missing-argument', 'it resolved to post-notice, which needs its text');
  assert.equal(r.kind === 'missing-argument' && r.command.id, 'post-notice');
});

test('an expired menu falls back to the current order', () => {
  const r = parseCommand('!display 1', ctx({
    menu: { word: 'display', at: NOW - MENU_TTL_MS - 1, ids: ['clear', 'whats-on', 'post-notice'] },
  }));
  assert.equal(r.kind, 'run');
  assert.equal(r.kind === 'run' && r.command.id, 'whats-on', 'the stale snapshot is not used');
});

test("a menu for another namespace is not consumed", () => {
  const r = parseCommand('!display 1', ctx({
    menu: { word: 'os', at: NOW - 1000, ids: ['stats', 'apps', 'restart'] },
  }));
  assert.equal(r.kind === 'run' && r.command.id, 'whats-on', 'display numbering, not os numbering');
});

test('a snapshot naming a withdrawn command does not run something else', () => {
  const r = parseCommand('!display 1', ctx({
    menu: { word: 'display', at: NOW - 1000, ids: ['removed-in-an-update', 'whats-on'] },
  }));
  assert.equal(r.kind, 'unknown-command');
});

test('an out-of-range number never clamps or wraps', () => {
  const r = parseCommand('!display 9', ctx());
  assert.deepEqual(r, { kind: 'bad-number', ns: DISPLAY, max: 3 });
  assert.equal(parseCommand('!display 0', ctx()).kind, 'bad-number');
});

// ── arguments ────────────────────────────────────────────────────────────────────

test('text after a command that takes none is REFUSED, not dropped', () => {
  // Silently dropping it would tell a volunteer "done" when what they typed went
  // nowhere.
  const r = parseCommand('!display clear everything please', ctx());
  assert.equal(r.kind, 'unwanted-argument');
});

test('a required argument that is missing is reported', () => {
  const r = parseCommand('!display post-notice', ctx());
  assert.equal(r.kind, 'missing-argument');
});

test('an OS verb with no app asks which app, rather than erroring', () => {
  const r = parseCommand('!os restart', ctx());
  assert.equal(r.kind, 'need-app');
  assert.equal(r.kind === 'need-app' && r.command.id, 'restart');
});

test('an OS verb passes its app token straight through', () => {
  const a = parseCommand('!os restart prayer-times', ctx());
  assert.equal(a.kind === 'run' && a.text, 'prayer-times');
  // A number here is the APP list's numbering, not the OS menu's — resolved later,
  // by the executor that actually has the app list.
  const b = parseCommand('!os restart 3', ctx());
  assert.equal(b.kind === 'run' && b.text, '3');
});

test('a very long argument is truncated, a very long message is refused', () => {
  const long = parseCommand(`!display post-notice ${'x'.repeat(400)}`, ctx());
  assert.equal(long.kind === 'run' && long.text!.length, 300);
  assert.equal(parseCommand(`!display post-notice ${'x'.repeat(600)}`, ctx()).kind, 'too-long');
});

// ── confirmations ────────────────────────────────────────────────────────────────

test('confirmation is recognised only with the prefix', () => {
  const r = parseCommand('!yes K7QM', ctx());
  assert.deepEqual(r, { kind: 'confirm', code: 'k7qm' });
  assert.deepEqual(parseCommand('!y k7qm', ctx()), { kind: 'confirm', code: 'k7qm' });
  assert.deepEqual(parseCommand('!no', ctx()), { kind: 'cancel' });
  assert.deepEqual(parseCommand('!cancel', ctx()), { kind: 'cancel' });
  // Without the prefix these are just words in a conversation.
  assert.deepEqual(parseCommand('yes K7QM', ctx()), { kind: 'ignore' });
});

test('a confirmable command parses as a run — the caller decides to ask', () => {
  // The parser reports what was asked for; whether it needs confirming is read off
  // the command's own `confirm` flag by execute.ts, which owns the pending state.
  const r = parseCommand('!display clear', ctx());
  assert.equal(r.kind, 'run');
  assert.equal(r.kind === 'run' && r.command.confirm, true);
});

// ── purity ───────────────────────────────────────────────────────────────────────

test('the parser reads no clock: same input and ctx, same result', () => {
  const a = parseCommand('!display 2', ctx());
  const b = parseCommand('!display 2', ctx());
  assert.deepEqual(a, b);
});
