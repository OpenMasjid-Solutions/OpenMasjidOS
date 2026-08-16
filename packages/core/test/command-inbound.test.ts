// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The inbound path: reading a message off the gateway, and the ordered gate that
 * decides whether it is allowed to do anything.
 *
 * OpenWA's real-time event payload is NOT in its public API docs, so the normaliser
 * is written to accept several plausible shapes and to fail closed on the rest. These
 * tests are the specification of "fail closed" — each one is a way a partially
 * understood payload could otherwise have been treated as a valid command.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-inb-'));
process.env.OPENMASJID_DATA_DIR = dataDir;

const req = createRequire(__filename);
const store = req('../src/store/commands') as typeof import('../src/store/commands');
const { normaliseInbound } = req('../src/commands/normalise') as typeof import('../src/commands/normalise');
const { gate, __resetGateForTests, REPLAY_QUIET_MS, MAX_AGE_MS } =
  req('../src/commands/gate') as typeof import('../src/commands/gate');
const convo = req('../src/commands/conversation') as typeof import('../src/commands/conversation');
const { isMessageEvent } = req('../src/notify/whatsapp-inbound') as typeof import('../src/notify/whatsapp-inbound');

const ALICE = '15550101234';
const NOW = 1_700_000_000_000;
/** Far enough after connect that the replay window and the no-timestamp rule pass. */
const CONNECTED = NOW - 10 * 60_000;

function enable(): void {
  fs.rmSync(path.join(dataDir, 'config', 'commands.json'), { force: true });
  store.__reloadCommandConfigForTests();
  store.setCommandsEnabled(true);
  store.addCommandPerson(ALICE, 'Alice', [store.OS_READ, store.OS_CONTROL]);
  __resetGateForTests();
  convo.resetConversations();
}

/** A well-formed 1:1 text message from Alice. */
function msg(over: Record<string, unknown> = {}): unknown[] {
  return [{ id: `m${Math.random()}`, chatId: `${ALICE}@c.us`, body: '!os stats', fromMe: false, timestamp: Math.floor(NOW / 1000), type: 'chat', ...over }];
}

const run = (args: unknown[], now = NOW) => gate(args, { now, connectedAt: CONNECTED });

// ── event-name filtering ─────────────────────────────────────────────────────────

test('the event filter takes messages and rejects everything that only sounds like one', () => {
  for (const e of ['message', 'messages', 'message.received', 'wa:new-message', 'session.message', 'onMessage']) {
    assert.equal(isMessageEvent(e), true, `${e} should be a message`);
  }
  // message.ack matters most: treating it as a message would re-execute a command on
  // every delivery receipt of our own reply.
  for (const e of ['message.ack', 'message.status', 'message.reaction.add', 'message.edited', 'presence.update', 'call.incoming', 'group.participant.add', 'session.status']) {
    assert.equal(isMessageEvent(e), false, `${e} must NOT be a message`);
  }
});

// ── the normaliser ───────────────────────────────────────────────────────────────

test('several plausible payload shapes all read the same', () => {
  const shapes: unknown[][] = [
    [{ chatId: `${ALICE}@c.us`, body: 'hi', fromMe: false }],
    [{ from: `${ALICE}@c.us`, text: 'hi', fromMe: false }],
    [{ data: { chatId: `${ALICE}@c.us`, body: 'hi', fromMe: false } }],
    [{ key: { remoteJid: `${ALICE}@c.us`, fromMe: false }, message: { conversation: 'hi' } }],
    [[{ chatId: `${ALICE}@c.us`, body: 'hi', fromMe: false }]],
  ];
  for (const s of shapes) {
    const r = normaliseInbound(s);
    assert.equal(r.ok, true, `shape not understood: ${JSON.stringify(s)}`);
    if (r.ok) {
      assert.equal(r.msg.body, 'hi');
      assert.equal(r.msg.fromDigits, ALICE);
      assert.equal(r.msg.isDirect, true);
    }
  }
});

test('an absent fromMe means OURS, so a reply can never loop back in', () => {
  const r = normaliseInbound([{ chatId: `${ALICE}@c.us`, body: '!os stats' }]);
  assert.equal(r.ok && r.msg.fromMe, true, 'unknown must read as our own message');
});

test('a device suffix on the sender is still the same person', () => {
  const r = normaliseInbound([{ chatId: `${ALICE}:12@c.us`, body: 'hi', fromMe: false }]);
  assert.equal(r.ok && r.msg.fromDigits, ALICE);
  assert.equal(r.ok && r.msg.isDirect, true);
});

test('address spaces that are not a phone are refused, not guessed at', () => {
  // A negative "not @g.us" test would let every one of these through.
  for (const jid of [`${ALICE}@g.us`, '123456@lid', '999@newsletter', 'status@broadcast', `${ALICE}@broadcast`]) {
    const r = normaliseInbound([{ chatId: jid, body: 'hi', fromMe: false }]);
    assert.equal(r.ok && r.msg.isDirect, false, `${jid} must not be direct`);
    assert.equal(r.ok && r.msg.fromDigits, null, `${jid} must not yield a number`);
  }
});

test('a separate author means a group shape, whatever the chat id looks like', () => {
  const r = normaliseInbound([{ chatId: `${ALICE}@c.us`, author: '447700900123@c.us', body: 'hi', fromMe: false }]);
  assert.equal(r.ok && r.msg.isDirect, false);
});

test('seconds and milliseconds are both understood', () => {
  const secs = normaliseInbound([{ chatId: `${ALICE}@c.us`, body: 'hi', fromMe: false, timestamp: 1_700_000_000 }]);
  const ms = normaliseInbound([{ chatId: `${ALICE}@c.us`, body: 'hi', fromMe: false, timestamp: 1_700_000_000_000 }]);
  assert.equal(secs.ok && secs.msg.timestampMs, 1_700_000_000_000);
  assert.equal(ms.ok && ms.msg.timestampMs, 1_700_000_000_000);
});

test('an unreadable payload reports its KEY NAMES only, never its values', () => {
  const r = normaliseInbound([{ mystery: 'a secret', other: 42 }]);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.deepEqual(r.keys, ['mystery', 'other']);
    assert.ok(!JSON.stringify(r).includes('a secret'), 'values must never travel to the log');
  }
  assert.equal(normaliseInbound([]).ok, false);
  assert.equal(normaliseInbound(['just a string']).ok, false);
});

// ── the gate, in order ───────────────────────────────────────────────────────────

test('the master switch is re-read per message', () => {
  enable();
  assert.equal(run(msg()).pass, true);
  store.setCommandsEnabled(false);
  const r = run(msg());
  assert.equal(r.pass, false);
  assert.equal(r.pass === false && r.drop, 'commands-off');
});

test('our own messages are dropped', () => {
  enable();
  const r = run(msg({ fromMe: true }));
  assert.equal(r.pass === false && r.drop, 'from-me');
});

test('a group message is dropped even from an authorised sender', () => {
  enable();
  // The single most important drop: a command in a group would hand the restart
  // button to every member of a 200-person announcement group.
  const r = gate(
    [{ id: 'g1', chatId: '120363012345678901@g.us', author: `${ALICE}@c.us`, body: '!os stats', fromMe: false, timestamp: Math.floor(NOW / 1000) }],
    { now: NOW, connectedAt: CONNECTED },
  );
  assert.equal(r.pass === false && r.drop, 'not-direct');
});

test('media and non-text types are dropped', () => {
  enable();
  assert.equal(run(msg({ hasMedia: true }))['drop' as never], 'not-text');
  assert.equal(run(msg({ mimetype: 'image/png' }))['drop' as never], 'not-text');
  assert.equal(run(msg({ type: 'image' }))['drop' as never], 'not-text');
  assert.equal(run(msg({ type: 'sticker' }))['drop' as never], 'not-text');
  // A gateway that omits `type` entirely must still work.
  assert.equal(run(msg({ type: undefined })).pass, true);
});

test('the replay quiet window swallows a reconnect backlog', () => {
  enable();
  const justConnected = { now: NOW, connectedAt: NOW - (REPLAY_QUIET_MS - 500) };
  assert.equal(gate(msg(), justConnected)['drop' as never], 'replay-window');
  assert.equal(gate(msg(), { now: NOW, connectedAt: NOW - (REPLAY_QUIET_MS + 500) }).pass, true);
});

test('a stale or future-dated message is dropped', () => {
  enable();
  // This morning's `!os restart`, replayed after a six-hour outage.
  assert.equal(run(msg({ timestamp: Math.floor((NOW - MAX_AGE_MS - 5000) / 1000) }))['drop' as never], 'stale');
  assert.equal(run(msg({ timestamp: Math.floor((NOW + 5 * 60_000) / 1000) }))['drop' as never], 'future');
  // No timestamp is only trusted once the socket has outlived the staleness window.
  __resetGateForTests();
  assert.equal(gate(msg({ timestamp: undefined }), { now: NOW, connectedAt: NOW - 5_000 })['drop' as never], 'stale');
  __resetGateForTests();
  assert.equal(gate(msg({ timestamp: undefined }), { now: NOW, connectedAt: CONNECTED }).pass, true);
});

test('an unknown sender is dropped and gets NO reply', () => {
  enable();
  const r = run(msg({ chatId: '447700900999@c.us' }));
  assert.equal(r.pass, false);
  assert.equal(r.pass === false && r.drop, 'unknown-sender');
  // The whole outcome must carry nothing that could become a reply.
  assert.equal(r.pass === false && r.notice, undefined);
});

test('the same message twice runs once', () => {
  enable();
  const m = msg({ id: 'fixed-id' });
  assert.equal(run(m).pass, true);
  assert.equal(run(m)['drop' as never], 'duplicate');
  // Without an id, the content is the key — a redelivery still collides.
  const noId = msg({ id: undefined, body: '!os apps' });
  assert.equal(run(noId).pass, true);
  assert.equal(run(noId)['drop' as never], 'duplicate');
});

test('duplicate suppression sits AFTER the whitelist', () => {
  // If a stranger could fill the dedupe table, their flood would evict the entries
  // that stop a real command running twice.
  enable();
  for (let i = 0; i < 600; i++) run(msg({ id: `stranger-${i}`, chatId: '447700900999@c.us' }));
  const mine = msg({ id: 'mine' });
  assert.equal(run(mine).pass, true);
  assert.equal(run(mine)['drop' as never], 'duplicate', 'my entry was not evicted by the flood');
});

test('ordinary conversation is untouched, and does not cost a rate-limit token', () => {
  enable();
  // Five chatty messages — more than the bucket holds — then a real command.
  for (let i = 0; i < 8; i++) {
    const r = run(msg({ id: `chat-${i}`, body: `Assalamu alaikum, message ${i}` }));
    assert.equal(r.pass === false && r.drop, 'no-prefix');
  }
  assert.equal(run(msg({ id: 'cmd' })).pass, true, 'the bucket was never touched by conversation');
});

test('too many commands in a row is throttled, with one notice', () => {
  enable();
  let throttled = 0;
  let notices = 0;
  for (let i = 0; i < 10; i++) {
    const r = run(msg({ id: `c-${i}` }));
    if (r.pass === false && r.drop === 'rate-limited') {
      throttled += 1;
      if (r.notice) notices += 1;
    }
  }
  assert.ok(throttled > 0, 'the bucket must run out');
  assert.equal(notices, 1, 'exactly one "slow down", never one per message');
});

// ── conversation state ───────────────────────────────────────────────────────────

test('a confirmation code is single-use and expires', () => {
  convo.resetConversations();
  const action = { kind: 'os', command: { id: 'restart' }, appId: 'a', appName: 'A' } as never;
  const code = convo.setPending(ALICE, action, NOW);
  assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/, 'no 0/O/1/I to mistype');

  assert.equal(convo.takePending(ALICE, 'ZZZZ', NOW).ok, false, 'wrong code does nothing');
  assert.equal(convo.takePending(ALICE, code.toLowerCase(), NOW).ok, true, 'case-insensitive');
  assert.deepEqual(convo.takePending(ALICE, code, NOW), { ok: false, why: 'none' }, 'single use');

  const c2 = convo.setPending(ALICE, action, NOW);
  assert.deepEqual(convo.takePending(ALICE, c2, NOW + convo.CONFIRM_TTL_MS + 1), { ok: false, why: 'expired' });
});

test('asking a second question kills the first code', () => {
  // Two live codes is how the wrong one gets confirmed.
  convo.resetConversations();
  const action = { kind: 'os', command: { id: 'stop' }, appId: 'a', appName: 'A' } as never;
  const first = convo.setPending(ALICE, action, NOW);
  convo.setPending(ALICE, action, NOW);
  assert.equal(convo.takePending(ALICE, first, NOW).ok, false);
});

test('the reply window is what makes a reply structurally safe', () => {
  convo.resetConversations();
  assert.equal(convo.recentlyInbound(ALICE, NOW), false, 'never messaged us');
  convo.touch(ALICE, NOW);
  assert.equal(convo.recentlyInbound(ALICE, NOW + 60_000), true);
  assert.equal(convo.recentlyInbound(ALICE, NOW + convo.REPLY_WINDOW_MS + 1), false);
});

test('idle senders are evicted, and the map is bounded', () => {
  convo.resetConversations();
  for (let i = 0; i < 80; i++) convo.touch(`1555010${1000 + i}`, NOW + i);
  assert.ok(convo.__conversationSizeForTests() <= 64, 'hard cap holds');
  convo.touch(ALICE, NOW + 60 * 60_000);
  assert.equal(convo.__conversationSizeForTests(), 1, 'everything idle was swept');
});
