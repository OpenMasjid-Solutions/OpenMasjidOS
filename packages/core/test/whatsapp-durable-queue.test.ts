// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The send queue has to survive a restart.
 *
 * It did not, and that is the whole bug behind a real report: a masjid's messages were
 * accepted (`202 {queued:true}`), logged as queued, and never delivered — for more than a
 * day, with nothing in any log. The queue was a module-level array, so anything the pacer
 * was holding died with the process, and a dev-channel box restarts often.
 *
 * The tell was that `!os` commands worked perfectly the whole time, because a command
 * reply goes out through `sendImmediate`, which never touches the queue. "Commands work
 * but messages do not" is precisely the signature of a working transport and a broken
 * queue, and these tests pin the fix from both ends.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-wa-queue-'));
process.env.OPENMASJID_DATA_DIR = dataDir;

const req = createRequire(__filename);
const store = req('../src/notify/whatsapp-queue-store') as typeof import('../src/notify/whatsapp-queue-store');

const STORE = path.join(dataDir, 'config', 'whatsapp-queue.json');
const NOW = 1_760_000_000_000;

function item(over: Partial<import('../src/notify/whatsapp-queue-store').StoredItem> = {}) {
  return {
    id: 'id-1',
    text: 'Fees are due on Friday.',
    source: 'students',
    target: { kind: 'person' as const, digits: '15550101234' },
    enqueuedAt: NOW,
    attempts: 0,
    ...over,
  };
}

function write(state: Parameters<typeof store.saveQueueState>[0]): void {
  store.saveQueueState(state);
}

function emptyState() {
  return { queue: [], sends: [], groupSends: [], lastPerRecipient: new Map<string, number>(), outcomes: [] };
}

test('a held message survives a restart', () => {
  // The core of it. Write the state, then load it as a fresh process would.
  write({ ...emptyState(), queue: [item()] });
  const loaded = store.loadQueueState(NOW + 1000);
  assert.equal(loaded.queue.length, 1, 'the message must still be there');
  assert.equal(loaded.queue[0]!.text, 'Fees are due on Friday.');
  assert.equal(loaded.queue[0]!.source, 'students');
  assert.deepEqual(loaded.expired, []);
});

test('the pacing history survives too, so the caps are real across a restart', () => {
  // Not cosmetic: if `sends` empties on every boot then the hourly and daily caps are not
  // caps at all, and a box in a restart loop could send its daily allowance repeatedly —
  // the exact burst the pacer exists to prevent.
  const lastPerRecipient = new Map([['15550101234', NOW - 5_000]]);
  write({ ...emptyState(), sends: [NOW - 1000, NOW - 2000], groupSends: [NOW - 3000], lastPerRecipient });
  const loaded = store.loadQueueState(NOW);
  assert.deepEqual(loaded.sends, [NOW - 1000, NOW - 2000]);
  assert.deepEqual(loaded.groupSends, [NOW - 3000]);
  assert.equal(loaded.lastPerRecipient.get('15550101234'), NOW - 5_000);
});

test('a message held longer than a day is dropped, not released in a burst', () => {
  // Releasing a day's backlog at once is the single behaviour most likely to get the
  // number restricted. And a fee reminder from yesterday is not the message anyone wanted
  // sent — so it is dropped, and the drop is reported rather than silent.
  const fresh = item({ id: 'fresh', enqueuedAt: NOW - 60_000 });
  const stale = item({ id: 'stale', enqueuedAt: NOW - store.MAX_HELD_MS - 1 });
  write({ ...emptyState(), queue: [stale, fresh] });
  const loaded = store.loadQueueState(NOW);
  assert.deepEqual(
    loaded.queue.map((q) => q.id),
    ['fresh'],
  );
  assert.deepEqual(
    loaded.expired.map((q) => q.id),
    ['stale'],
  );
});

test('a damaged store degrades to empty instead of stopping the daemon', () => {
  // Same rule as the TLS cert (CLAUDE.md §15): a masjid with a corrupt queue file loses
  // queued messages, which is bad; a masjid whose dashboard will not boot has no way to
  // fix anything, which is worse.
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, '{ this is not json');
  const loaded = store.loadQueueState(NOW);
  assert.deepEqual(loaded.queue, []);
  assert.deepEqual(loaded.outcomes, []);
});

test('junk entries are discarded individually, keeping the valid ones', () => {
  // A partially-written or hand-edited file must not take the whole queue with it.
  fs.writeFileSync(
    STORE,
    JSON.stringify({
      queue: [
        item({ id: 'good' }),
        { id: 'no-target', text: 'x', source: 'a', enqueuedAt: NOW, attempts: 0 },
        { id: 'bad-target', text: 'x', source: 'a', target: { kind: 'channel' }, enqueuedAt: NOW, attempts: 0 },
        { text: 'no id', source: 'a', target: { kind: 'person', digits: '1' }, enqueuedAt: NOW, attempts: 0 },
        'not an object',
      ],
      sends: [NOW, 'nope', null],
      lastPerRecipient: [['a', 1], 'junk', ['b']],
    }),
  );
  const loaded = store.loadQueueState(NOW);
  assert.deepEqual(
    loaded.queue.map((q) => q.id),
    ['good'],
  );
  assert.deepEqual(loaded.sends, [NOW], 'non-numbers dropped');
  assert.deepEqual([...loaded.lastPerRecipient.entries()], [['a', 1]]);
});

test('the store file is not world-readable', () => {
  // It holds message bodies, which routinely carry a child's name and a family's fees.
  // Same treatment as the secrets, for the same reason.
  write({ ...emptyState(), queue: [item()] });
  const mode = fs.statSync(STORE).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

test('outcomes are bounded so the file cannot grow without limit', () => {
  const many = Array.from({ length: store.MAX_OUTCOMES + 50 }, (_, i) => ({
    id: `id-${i}`,
    source: 'students',
    state: 'sent' as const,
    at: NOW,
    targetKind: 'person',
  }));
  write({ ...emptyState(), outcomes: many });
  const loaded = store.loadQueueState(NOW);
  assert.equal(loaded.outcomes.length, store.MAX_OUTCOMES);
  // The NEWEST are kept — the oldest are the ones nobody is still asking about.
  assert.equal(loaded.outcomes[loaded.outcomes.length - 1]!.id, `id-${store.MAX_OUTCOMES + 49}`);
});

test('an outcome record carries no message text and no recipient', () => {
  // An app polls it, and the platform must not turn "what happened to my message" into a
  // way to read the message back — or worse, someone else's.
  write({
    ...emptyState(),
    outcomes: [{ id: 'x', source: 'students', state: 'sent', at: NOW, targetKind: 'person' }],
  });
  const raw = fs.readFileSync(STORE, 'utf8');
  const rec = store.loadQueueState(NOW).outcomes[0]!;
  assert.deepEqual(Object.keys(rec).sort(), ['at', 'id', 'source', 'state', 'targetKind']);
  assert.ok(!/digits|15550101234/.test(JSON.stringify(rec)), 'no recipient in the record');
  // And the queue half of the same file is the only place text lives.
  assert.ok(raw.includes('"outcomes"'));
});
