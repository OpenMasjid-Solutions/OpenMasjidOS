// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * What the platform says back over WhatsApp.
 *
 * Two classes of assertion here. The literal-string ones are about voice: a masjid
 * volunteer reads these, so no "container", no "exited(0)", no status codes
 * (CLAUDE.md §14). The sweep at the bottom is about ban risk: a message that looks
 * templated — bold runs, links, emoji — is the shape that gets a number flagged, and
 * the whole pacing policy exists to avoid exactly that.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appFailureText,
  appListText,
  confirmText,
  helpText,
  MAX_REPLY_CHARS,
  menuText,
  pickAppText,
  say,
  statsText,
  updatesText,
  type AppRow,
  type StatsRow,
} from '../src/commands/reply';
import type { CommandEntry, CommandNamespace } from '../src/commands/types';

const cmd = (id: string, label: string, extra: Partial<CommandEntry> = {}): CommandEntry => ({
  id,
  label,
  scope: 'display',
  argKind: 'none',
  argRequired: false,
  ...extra,
});

const DISPLAY: CommandNamespace = {
  word: 'notice-board',
  label: 'Notice Board',
  commands: [
    cmd('whats-on', "What's on the screen now"),
    cmd('post-notice', 'Put a message on the screen', {
      argKind: 'text',
      argRequired: true,
      argument: { label: 'message' },
    }),
    cmd('clear', 'Clear the screen', { confirm: true }),
  ],
};

const OS: CommandNamespace = { word: 'os', label: 'OpenMasjidOS', commands: [cmd('stats', 'How the server is doing')] };

const GB = 1024 ** 3;
const STATS: StatsRow = {
  cpuPercent: 12.4,
  memUsed: 1.8 * GB,
  memTotal: 4 * GB,
  diskUsed: 41 * GB,
  diskTotal: 220 * GB,
  cpuTempC: 47,
  uptimeSec: 6 * 86400 + 3600,
  appsRunning: 5,
};

test('stats reads like a sentence, not a dashboard', () => {
  assert.equal(
    statsText(STATS),
    [
      'OpenMasjidOS looks healthy.',
      '',
      'Processor: 12% busy',
      'Memory: 1.8 GB of 4 GB used',
      'Storage: 41 GB of 220 GB used',
      'Temperature: 47C',
      'Up and running for 6 days',
      '5 apps running',
    ].join('\n'),
  );
});

test('an absent temperature is omitted, not printed as unavailable', () => {
  // Most hardware has no sensor. A permanent "n/a" line trains people to skip the
  // whole block, including the lines that do matter.
  const out = statsText({ ...STATS, cpuTempC: null });
  assert.ok(!/Temperature/.test(out));
  assert.ok(/Processor/.test(out) && /Storage/.test(out));
});

test('the lead line changes when something is actually wrong', () => {
  assert.match(statsText({ ...STATS, diskUsed: 215 * GB }), /^OpenMasjidOS is running, but storage is nearly full\./);
  assert.match(statsText({ ...STATS, memUsed: 3.9 * GB }), /memory is nearly full/);
  assert.match(statsText({ ...STATS, cpuTempC: 85 }), /getting hot/);
});

test('the app list is numbered and says what to do next', () => {
  const apps: AppRow[] = [
    { id: 'prayer-times', name: 'Prayer Times', running: true },
    { id: 'donations', name: 'Donations', running: true },
    { id: 'notice-board', name: 'Notice Board', running: false },
    { id: 'madrasah', name: 'Madrasah', running: true, updateAvailable: true },
  ];
  assert.equal(
    appListText(apps),
    [
      'Your apps:',
      '',
      '1. Prayer Times - running',
      '2. Donations - running',
      '3. Notice Board - stopped',
      '4. Madrasah - running, an update is waiting',
      '',
      'To start or stop one, send !os start 1 or !os stop 1.',
    ].join('\n'),
  );
  assert.equal(appListText([]), "You don't have any apps installed yet.");
});

test('a long list truncates on a line boundary and says how many were left', () => {
  // Silent truncation reads as "that is all of them", which is worse than a short list.
  const many: AppRow[] = Array.from({ length: 60 }, (_, i) => ({
    id: `app-${i}`,
    name: `A Masjid Application Number ${i}`,
    running: i % 2 === 0,
  }));
  const out = appListText(many);
  assert.ok(out.length <= MAX_REPLY_CHARS, `too long: ${out.length}`);
  assert.match(out, /\.\.\.and \d+ more\. The dashboard has the full list\./);
  assert.ok(!/\n\s*$/.test(out.split('...and')[0]!.replace(/\n$/, '')), 'no dangling partial line');
});

test('a channel move never renders as a version downgrade', () => {
  // Going back to Stable targets an OLDER number, so "1.4.0 to 1.3.9" would read as a
  // mistake. The dashboard already learned this one.
  const out = updatesText([
    { id: 'madrasah', name: 'Madrasah', from: '1.4.0', to: '1.3.9', reason: 'channel', channel: 'dev' },
    { id: 'donations', name: 'Donations', from: '0.9.1', to: '0.10.0', reason: 'version' },
  ]);
  assert.match(out, /Madrasah - moving to the Development version/);
  assert.ok(!/1\.4\.0 to 1\.3\.9/.test(out));
  assert.match(out, /Donations - 0\.9\.1 to 0\.10\.0/);
});

test('a channel move names the direction it is actually going', () => {
  // The wording used to be hardcoded to "Development", so a masjid returning to Stable
  // was told the opposite of what pressing update would do. Both directions, asserted,
  // because only one of them was ever wrong and it was the less-travelled one.
  const toStable = updatesText([
    { id: 'madrasah', name: 'Madrasah', from: '1.4.0-dev.2', to: '1.3.9', reason: 'channel', channel: 'main' },
  ]);
  assert.match(toStable, /Madrasah - moving to the Stable version/);
  assert.ok(!/Development/.test(toStable), 'must not name the channel it is leaving');

  const toDev = updatesText([
    { id: 'madrasah', name: 'Madrasah', from: '1.3.9', to: '1.4.0-dev.2', reason: 'channel', channel: 'dev' },
  ]);
  assert.match(toDev, /Madrasah - moving to the Development version/);

  // No channel: say something true rather than guessing a direction.
  const unknown = updatesText([{ id: 'madrasah', name: 'Madrasah', to: '1.3.9', reason: 'channel' }]);
  assert.ok(!/Development|Stable/.test(unknown));
});

test('nothing to update says so, rather than showing an empty list', () => {
  assert.equal(updatesText([]), 'Everything is up to date.');
  assert.match(updatesText([{ id: 'a', name: 'A', from: '1', to: '2', reason: 'version' }]), /^One app has an update/);
});

test('a menu tells you how to answer it', () => {
  assert.equal(
    menuText(DISPLAY),
    [
      'Notice Board can do these:',
      '',
      "1. What's on the screen now",
      '2. Put a message on the screen - add your message after the number',
      '3. Clear the screen',
      '',
      'Send the number, like !notice-board 1.',
    ].join('\n'),
  );
});

test('help lists only what this sender may run', () => {
  const out = helpText('Yusuf', [OS, DISPLAY]);
  assert.match(out, /^Hello Yusuf\./);
  assert.match(out, /!os - the server itself/);
  assert.match(out, /!notice-board - Notice Board/);
  assert.ok(!/donations/i.test(out), 'a namespace they lack must not be mentioned');
  // Someone on the list with nothing granted gets a plain explanation, not an empty list.
  assert.match(helpText('Yusuf', []), /nothing has been shared with you yet/);
});

test('a confirmation states the consequence and how to answer', () => {
  const out = confirmText('Restart "Prayer Times"?', 'The screen in the hall will go blank for about a minute.', 'K7QM');
  assert.match(out, /Reply {2}!yes K7QM {2}to go ahead\./);
  assert.match(out, /expires in 90 seconds/);
});

test('an app failure explains itself in plain words with a next step', () => {
  assert.equal(
    appFailureText('Notice Board', 'target_unreachable', 'notice-board'),
    "Notice Board isn't running at the moment, so I couldn't ask it. Send !os apps to see what's running.",
  );
  assert.match(appFailureText('Notice Board', 'timeout', 'notice-board'), /didn't answer in time/);
  assert.match(appFailureText('Notice Board', 'unknown_command', 'notice-board'), /Send !notice-board for its current list/);
  // An unmapped code must never leak the code itself.
  const weird = appFailureText('Notice Board', 'rate_limited', 'notice-board');
  assert.ok(!/rate_limited/.test(weird), weird);
});

test('a refused update is information, never "failed"', () => {
  // Calling a refusal a failure is what pushes an admin into retrying the very thing
  // that is already running.
  const msg = say.busy('An update is already running. Wait for it to finish, then try again.');
  assert.ok(!/fail/i.test(msg), msg);
});

test('EVERY reply is plain text: no markdown, no links, no emoji, within the cap', () => {
  const outputs: string[] = [
    statsText(STATS),
    statsText({ ...STATS, cpuTempC: null, appsRunning: 1 }),
    appListText([{ id: 'a', name: 'Prayer Times', running: true, updateAvailable: true }]),
    appListText([]),
    pickAppText(DISPLAY.commands[0]!, [{ id: 'a', name: 'Prayer Times', running: false }]),
    updatesText([{ id: 'a', name: 'A', from: '1.0.0', to: '1.1.0', reason: 'version' }]),
    updatesText([]),
    menuText(DISPLAY),
    menuText(OS),
    helpText('Yusuf', [OS, DISPLAY]),
    helpText('Yusuf', []),
    confirmText('Stop "Donations"?', 'Nobody will be able to give until it is started again.', 'K7QM'),
    say.notAllowed('kiosk'),
    say.unknownNamespace('displya', 'display'),
    say.unknownNamespace('zzz'),
    say.unknownCommand(DISPLAY, 'clera', 'clear'),
    say.unknownCommand(DISPLAY, 'zzz'),
    say.badNumber(DISPLAY, 3),
    say.badNumber(DISPLAY, 0),
    say.missingArgument(DISPLAY, DISPLAY.commands[1]!),
    say.unwantedArgument(DISPLAY, DISPLAY.commands[2]!),
    say.unknownApp('prayr'),
    say.tooLong(),
    say.throttled(),
    say.expiredConfirm(),
    say.expiredMenu('display'),
    say.cancelled(),
    say.nothingToCancel(),
    say.managedApp('WhatsApp Gateway'),
    ...['target_not_installed', 'target_unreachable', 'timeout', 'response_too_large', 'unknown_command', 'not_ready', 'payload_too_large', 'no_secret', 'anything-else'].map(
      (c) => appFailureText('Notice Board', c, 'notice-board'),
    ),
  ];

  // Bold/italic/strike/monospace runs, links, and pictographs. `!` and `-` are fine;
  // an underscore inside a word is not a formatting run in WhatsApp, so the pattern
  // looks for paired markers.
  const forbidden = /\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|```|`[^`\n]+`|https?:\/\/|\p{Extended_Pictographic}/u;
  for (const out of outputs) {
    assert.ok(out.length > 0, 'every reply says something');
    assert.ok(out.length <= MAX_REPLY_CHARS, `over the cap (${out.length}): ${out.slice(0, 60)}`);
    assert.ok(!forbidden.test(out), `not plain text: ${JSON.stringify(out.slice(0, 120))}`);
    // Never a secret, a path, or an address.
    assert.ok(!/\/data\/|\/opt\/|[0-9]{1,3}(\.[0-9]{1,3}){3}/.test(out), `leaks a path or address: ${out.slice(0, 80)}`);
  }
});
