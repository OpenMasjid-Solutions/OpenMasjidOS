// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * WhatsApp admin commands end to end — the real gate, parser, executor and replies —
 * with the apps, the WhatsApp sender, the alerts and the app calls replaced by
 * stand-ins, so every answer can be read and every app action counted.
 *
 * Each test is one way the executor used to say or do the wrong thing.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-cmdfix-'));
process.env.OPENMASJID_DATA_DIR = dataDir;

const req = createRequire(__filename);

/** Put a stand-in in the require cache before anything loads the real module. */
function stub(rel: string, exports: Record<string, unknown>): void {
  const file = req.resolve(rel);
  const m = new Module(file);
  m.filename = file;
  m.loaded = true;
  m.exports = exports;
  req.cache[file] = m;
}

interface App {
  id: string;
  name: string;
  kind: 'catalog' | 'community' | 'custom';
  running: boolean;
  managed: boolean;
}
interface Check {
  updateAvailable: boolean;
  latest: string | null;
  reason: 'version' | 'channel' | null;
}

/** What the stand-ins answer, and what they were asked to do. */
const world = {
  apps: [] as App[],
  checks: new Map<string, Check>(),
  updateOutcome: 'updated' as 'updated' | 'unchanged' | 'not-running',
  /** App actions, in order: `stop:donations`, `verify:donations`, … */
  calls: [] as string[],
  replies: [] as string[],
  alerts: [] as string[],
  appCommands: [] as { appId: string; appName: string; commands: { id: string; label: string }[] }[],
  appAnswer: async (): Promise<unknown> => ({ ok: true, text: 'Done.' }),
};

class AppNeedsReviewError extends Error {}

stub('../src/apps/manager', {
  AppNeedsReviewError,
  listInstalled: async () => world.apps.map((a) => ({ ...a, ports: [] })),
  checkCatalogUpdate: async (id: string) => ({
    current: '1.0.0',
    appChannel: 'main',
    channel: 'main',
    ...(world.checks.get(id) ?? { updateAvailable: false, latest: null, reason: null }),
  }),
  updateCatalogApp: async (id: string) => {
    world.calls.push(`update:${id}`);
    return world.updateOutcome;
  },
  verifyStayedUp: async (id: string) => {
    world.calls.push(`verify:${id}`);
    return null;
  },
  startApp: async (id: string) => void world.calls.push(`start:${id}`),
  stopApp: async (id: string) => void world.calls.push(`stop:${id}`),
  restartApp: async (id: string) => void world.calls.push(`restart:${id}`),
  listAppCommands: () => world.appCommands,
  listMetaSummaries: () => world.apps.map((a) => ({ id: a.id, name: a.name, kind: a.kind })),
});
stub('../src/notify/whatsapp', {
  replyTo: async (_digits: string, text: string) => {
    world.replies.push(text);
    return { ok: true };
  },
});
stub('../src/notify/alerts', {
  deliverAlert: async (a: { title: string }) => void world.alerts.push(a.title),
});
stub('../src/stats/collector', {
  collectStats: async () => ({
    cpuPercent: 5,
    memUsed: 1,
    memTotal: 2,
    diskUsed: 1,
    diskTotal: 2,
    cpuTempC: null,
    uptimeSec: 60,
    appsRunning: 1,
  }),
});
stub('../src/fabric/appCommands', { runAppCommand: () => world.appAnswer() });

const store = req('../src/store/commands') as typeof import('../src/store/commands');
const convo = req('../src/commands/conversation') as typeof import('../src/commands/conversation');
const { gateMessage, __resetGateForTests } = req('../src/commands/gate') as typeof import('../src/commands/gate');
const { handleInboundCommand } = req('../src/commands/execute') as typeof import('../src/commands/execute');
const { say } = req('../src/commands/reply') as typeof import('../src/commands/reply');

const ALICE = '15550101234';
const DISPLAY = { appId: 'display', appName: 'Notice Board', commands: [{ id: 'schedule', label: 'Schedule a notice' }] };
let seq = 0;
let lastDrop: string | null = null;

/** One message from `from`, through the gate and the executor. Returns what came back. */
async function send(body: string, from = ALICE): Promise<string[]> {
  const before = world.replies.length;
  const now = Date.now();
  const outcome = gateMessage(
    {
      id: `m${++seq}`,
      chatId: `${from}@c.us`,
      authorId: null,
      fromDigits: from,
      fromMe: false,
      isDirect: true,
      timestampMs: now,
      body,
      type: 'chat',
      hasMedia: false,
      shape: 'c.us',
      senderJid: null,
    },
    { now, connectedAt: now - 10 * 60_000 },
  );
  lastDrop = outcome.pass ? null : outcome.drop;
  await handleInboundCommand(outcome);
  return world.replies.slice(before);
}

const codeIn = (prompt: string | undefined): string => /!yes (\w{4})/.exec(prompt ?? '')?.[1] ?? 'none';

beforeEach(() => {
  fs.rmSync(path.join(dataDir, 'config', 'commands.json'), { force: true });
  store.reloadCommandConfig();
  store.setCommandsEnabled(true);
  store.addCommandPerson(ALICE, 'Alice', [store.OS_READ, store.OS_CONTROL]);
  convo.resetConversations();
  __resetGateForTests();
  world.apps = [{ id: 'donations', name: 'Donations', kind: 'catalog', running: true, managed: false }];
  world.checks.clear();
  world.updateOutcome = 'updated';
  world.calls.length = 0;
  world.replies.length = 0;
  world.alerts.length = 0;
  world.appCommands = [];
  world.appAnswer = async () => ({ ok: true, text: 'Done.' });
});

// First in the file on purpose: the last-used stamp is written at most once a minute,
// so only the first command of the run is sure to try the write.
test('a full or read-only disk does not cost the sender their answer', async () => {
  const blocker = path.join(dataDir, 'config', 'commands.json.tmp');
  fs.mkdirSync(blocker); // every write of commands.json now fails
  try {
    const replies = await send('!os apps');
    assert.equal(replies.length, 1);
    assert.match(replies[0]!, /^Your apps:/);
  } finally {
    fs.rmSync(blocker, { recursive: true, force: true });
  }
});

test('a held confirmation dies when another command is sent, so a later "ok" runs nothing', async () => {
  const [prompt] = await send('!os stop donations');
  assert.match(prompt!, /Stop "Donations"\?/);
  await send('!os apps');
  assert.equal(convo.hasPending(ALICE, Date.now()), false, 'the stop prompt was abandoned');
  assert.deepEqual(await send('ok'), [], 'a bare "ok" is ordinary conversation again');
  assert.equal(lastDrop, 'no-prefix');
  assert.ok(!world.calls.includes('stop:donations'), 'Donations was not stopped');
});

test('"!os update 1" after "!os updates" means the first app THAT list showed', async () => {
  world.apps = [
    { id: 'attendance', name: 'Attendance', kind: 'catalog', running: true, managed: false },
    { id: 'donations', name: 'Donations', kind: 'catalog', running: true, managed: false },
  ];
  world.checks.set('attendance', { updateAvailable: false, latest: '1.0.0', reason: null });
  world.checks.set('donations', { updateAvailable: true, latest: '1.1.0', reason: 'version' });
  const [list] = await send('!os updates');
  assert.match(list!, /1\. Donations - 1\.0\.0 to 1\.1\.0/);
  const [prompt] = await send('!os update 1');
  assert.match(prompt!, /Update "Donations"\?/, 'not Attendance, the first app installed');
});

test('an app the store cannot answer for is never called up to date', async () => {
  world.apps.push({ id: 'my-board', name: 'My Board', kind: 'custom', running: true, managed: false });
  // Donations' store entry could not be read; a custom app has none at all.
  world.checks.set('donations', { updateAvailable: false, latest: null, reason: null });
  const [list] = await send('!os updates');
  assert.doesNotMatch(list!, /up to date/);
  assert.match(list!, /couldn't check one app/);

  const [prompt] = await send('!os update my-board');
  const [answer] = await send(`!yes ${codeIn(prompt)}`);
  assert.match(answer!, /couldn't check My Board for an update/);
  assert.doesNotMatch(answer!, /up to date/);
  assert.ok(!world.calls.some((c) => c.startsWith('update:')), 'no update was attempted');
});

test('someone who may only look is told a control command is not theirs', async () => {
  store.setCommandScope(ALICE, store.OS_CONTROL, false);
  const [list] = await send('!os apps');
  assert.doesNotMatch(list!, /!os start/, 'not invited to send what they cannot run');
  const [answer] = await send('!os start 1');
  assert.equal(answer, "You don't have access to !os start. Ask whoever looks after the server.");
});

test('a confirmation re-checks the grant, so one removed since the prompt runs nothing', async () => {
  const [prompt] = await send('!os stop donations');
  assert.match(prompt!, /Stop "Donations"\?/);
  // A restore puts back a list on which Alice may only look — and fires no change hook,
  // so the prompt is still held.
  const file = path.join(dataDir, 'config', 'commands.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.commands.people[0].scopes = [store.OS_READ];
  fs.writeFileSync(file, JSON.stringify(saved));
  store.reloadCommandConfig();
  assert.ok(convo.hasPending(ALICE, Date.now()));

  const [answer] = await send('yes');
  assert.match(answer!, /You don't have access to !os stop/);
  assert.ok(!world.calls.includes('stop:donations'), 'Donations was not stopped');
});

test('naming the WhatsApp gateway gets the managed-app answer, not "I can\'t find it"', async () => {
  world.apps.push({ id: 'openwa', name: 'WhatsApp Gateway', kind: 'catalog', running: true, managed: true });
  const [answer] = await send('!os restart openwa');
  assert.equal(answer, say.managedApp('WhatsApp Gateway'));
  const [list] = await send('!os apps');
  assert.doesNotMatch(list!, /WhatsApp Gateway/, 'and it is still not numbered with the rest');
  assert.ok(!world.calls.some((c) => c.endsWith(':openwa')));
});

test("an update reports the update's own verdict, and checks the app only once", async () => {
  world.checks.set('donations', { updateAvailable: true, latest: '1.1.0', reason: 'version' });
  world.updateOutcome = 'not-running';
  const [prompt] = await send('!os update donations');
  const replies = await send(`!yes ${codeIn(prompt)}`);
  assert.equal(replies.length, 2);
  assert.match(replies[0]!, /^Updating Donations now/);
  assert.match(replies[1]!, /Donations was updated, but it isn't staying running/);
  assert.deepEqual(world.calls, ['update:donations'], 'no second stayed-up check after the update made its own');
  assert.equal(world.alerts.length, 1, 'still reported out of band');

  world.updateOutcome = 'updated';
  world.calls.length = 0;
  const [again] = await send('!os update donations');
  const [, done] = await send(`!yes ${codeIn(again)}`);
  assert.equal(done, 'Donations is updated and running.');
  assert.deepEqual(world.calls, ['update:donations']);
});

test('the answer to a long-running command is not refused for the time it took', async () => {
  world.appCommands = [DISPLAY];
  store.setCommandScope(ALICE, 'display', true);
  const realNow = Date.now;
  world.appAnswer = async () => {
    // The app answers after the reply window has passed.
    const later = realNow() + convo.REPLY_WINDOW_MS + 60_000;
    Date.now = () => later;
    return { ok: true, text: 'Your notice is scheduled.' };
  };
  try {
    assert.deepEqual(await send('!display schedule'), ['Your notice is scheduled.']);
  } finally {
    Date.now = realNow;
  }
});

test('"stop" said to a "Stop …?" prompt reads as left alone, and a bare "!yes" asks for the code', async () => {
  const [prompt] = await send('!os stop donations');
  assert.match(prompt!, /Stop "Donations"\?/);
  assert.deepEqual(await send('!yes'), [say.needCode()]);
  assert.ok(convo.hasPending(ALICE, Date.now()), 'the prompt is still waiting');
  assert.deepEqual(await send('stop'), [say.cancelled()]);
  assert.ok(!world.calls.includes('stop:donations'));
});

test('"!cancel" and "!exit" in the middle of an app\'s question say the exchange ended', async () => {
  world.appCommands = [DISPLAY];
  store.setCommandScope(ALICE, 'display', true);
  world.appAnswer = async () => ({ ok: true, text: 'Which prayer?', followUpToken: 't1' });
  assert.deepEqual(await send('!display schedule'), ['Which prayer?']);
  assert.deepEqual(await send('!cancel'), [say.sessionEnded()]);
  await send('!display schedule');
  assert.deepEqual(await send('!exit'), [say.sessionEnded()]);
});

test('the question that reaches the turn cap says to finish on the dashboard', async () => {
  world.appCommands = [DISPLAY];
  store.setCommandScope(ALICE, 'display', true);
  world.appAnswer = async () => ({ ok: true, text: 'And then?', followUpToken: 't1' });
  // Twelve questions already asked in this exchange — the most one may hold.
  for (let i = 0; i < 12; i++) {
    convo.openSession(ALICE, { word: 'display', appLabel: 'Notice Board', commandId: 'schedule', token: 't1' }, Date.now());
  }
  const [last] = await send('Maghrib');
  assert.equal(last, `And then?\n\n${say.finishOnDashboard()}`);
  assert.deepEqual(await send('Isha'), [], 'nothing is waiting any more, so this is ordinary conversation');
  assert.equal(lastDrop, 'no-prefix');
});
