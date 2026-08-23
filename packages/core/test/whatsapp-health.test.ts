// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Noticing that WhatsApp signed the masjid's phone out, and not losing the backlog.
 *
 * THE REGRESSION THIS EXISTS FOR: a session expired, and every message after that was
 * accepted by OpenWA, recorded `sent`, and never delivered. The obvious detector — polling
 * `gatewayStatus()` — would not have caught it, because the pump only sends when it sees
 * `status === 'ready'` and messages DID go out, so the session row was still saying `ready`.
 * The detector and the sender read the same cached field, so they would have agreed with
 * each other and both been wrong.
 *
 * So the first test below is the important one: a gateway whose session row says `ready`
 * while the link is actually dead must still be detected. Everything else guards the
 * consequences — a blip must not page anyone, an outage must not destroy the queue, and the
 * platform must not claim it can resend messages whose contents it deleted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { StoredItem } from '../src/notify/whatsapp-queue-store';

process.env.OPENMASJID_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-wa-health-'));

const req = createRequire(__filename);
const store = req('../src/store/whatsapp') as typeof import('../src/store/whatsapp');
const qstore = req('../src/notify/whatsapp-queue-store') as typeof import('../src/notify/whatsapp-queue-store');

const SRC = path.join(__dirname, '..', 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const item = (id: string, enqueuedAt: number, extra: Partial<StoredItem> = {}): StoredItem => ({
  id,
  text: 'Fees are due on Friday.',
  source: 'students',
  target: { kind: 'person', digits: '15550101234' },
  enqueuedAt,
  attempts: 0,
  ...extra,
});

// ── the held clock ───────────────────────────────────────────────────────────────

test('A MULTI-DAY OUTAGE DOES NOT DESTROY THE QUEUE — the held clock stops while paused', () => {
  const now = Date.now();
  const threeDays = 3 * 24 * 3_600_000;
  const old = item('a', now - threeDays);

  // Wall-clock, this is far past the 24h bound. Paused for the whole time, none of it counts.
  assert.equal(qstore.effectiveHeldMs(old, now, now - threeDays), 0);
  // Which is the entire fix: the bound means "24 hours of WORKING connection", so an outage
  // can no longer silently mark a weekend's messages `expired` on the next restart.
  assert.ok(qstore.effectiveHeldMs(old, now, now - threeDays) <= qstore.MAX_HELD_MS);
});

test('an item that arrived mid-outage is only credited from its own arrival', () => {
  const now = Date.now();
  const pausedSince = now - 10 * 3_600_000; // outage began 10h ago
  const arrived = item('b', now - 4 * 3_600_000); // this one arrived 4h ago
  // Crediting it the whole 10h would let it outlive the bound by the 6h before it existed.
  assert.equal(qstore.effectiveHeldMs(arrived, now, pausedSince), 0);
});

test('with the queue running, the clock runs normally', () => {
  const now = Date.now();
  const waiting = item('c', now - 2 * 3_600_000);
  assert.equal(qstore.effectiveHeldMs(waiting, now, null), 2 * 3_600_000);
});

test('banking a pause is cumulative, so two outages both count', () => {
  const now = Date.now();
  const it = item('d', now - 6 * 3_600_000, { heldWhilePausedMs: 3_600_000 });
  qstore.bankPausedTime([it], now, now - 3_600_000);
  assert.equal(it.heldWhilePausedMs, 2 * 3_600_000, 'the earlier hour plus this one');
});

test('a paused queue survives a restart — it must not drain itself at boot', () => {
  const now = Date.now();
  qstore.saveQueueState({
    queue: [item('e', now)],
    sends: [],
    groupSends: [],
    lastPerRecipient: new Map(),
    outcomes: [],
    paused: true,
    pausedSince: now,
  });
  const loaded = qstore.loadQueueState(now);
  assert.equal(loaded.paused, true, 'forgetting the pause would release the backlog in one burst');
  assert.equal(loaded.queue.length, 1);
});

test('a pause timestamp is only trusted when the queue is actually paused', () => {
  const now = Date.now();
  qstore.saveQueueState({
    queue: [item('f', now - 48 * 3_600_000)],
    sends: [],
    groupSends: [],
    lastPerRecipient: new Map(),
    outcomes: [],
    paused: false,
    pausedSince: now - 48 * 3_600_000,
  });
  const loaded = qstore.loadQueueState(now);
  // Not paused, so the 48h counts and the item expires. A stale `pausedSince` must not be
  // able to grant unlimited holding time.
  assert.equal(loaded.pausedSince, null);
  assert.equal(loaded.expired.length, 1);
});

// ── the detector ─────────────────────────────────────────────────────────────────

test('THE PROBE ASKS WHATSAPP, NOT THE CACHED SESSION ROW', () => {
  const wa = read('notify', 'whatsapp.ts');
  const probe = wa.slice(wa.indexOf('export async function probeLink'));
  // `/chats` is a question that has to reach WhatsApp; `GET /api/sessions/:id` is a field
  // OpenWA can go on reporting as `ready` long after the link is gone.
  assert.match(probe, /\/chats\?limit=1/, 'the probe must exercise the link');
  assert.match(probe, /status === 503/, '503 is OpenWA saying the WhatsApp connection died');
  // Anything else is inconclusive and must return null, never false.
  assert.match(probe, /alive: null/, 'an inconclusive probe must not claim the link is dead');
});

test('the monitor never treats a healthy-looking session row as proof', () => {
  const mon = read('system', 'whatsapp-monitor.ts');
  // gatewayStatus is consulted only for BAD news; the positive signal comes from the probe.
  assert.match(mon, /probe\.alive === true/, 'only a successful probe means alive');
  assert.doesNotMatch(
    mon,
    /status\.state === 'ready'\s*\)?\s*return \{ alive: true/,
    "a `ready` status row must never be accepted as proof the link works",
  );
});

test('TWO AGREEING TICKS are required before anything happens', () => {
  const mon = read('system', 'whatsapp-monitor.ts');
  assert.match(mon, /lastVerdict/, 'the previous verdict must be remembered');
  assert.match(mon, /if \(!agreed\)/, 'a single bad reading must not act');
});

test('"could not ask" is never recorded as an answer', () => {
  const mon = read('system', 'whatsapp-monitor.ts');
  const tick = mon.slice(mon.indexOf('async function tick'));
  // Same rule CLAUDE.md §13.2d states for Stripe: an unreachable service must not be
  // stored as "fine", must not alert, and must not count towards the two-tick rule.
  assert.match(tick, /alive === null/);
  const inconclusive = tick.slice(tick.indexOf('alive === null'), tick.indexOf('const state = load()'));
  assert.doesNotMatch(inconclusive, /deliverAlert/, 'an inconclusive probe must never alert');
  assert.doesNotMatch(inconclusive, /pauseQueue/, 'nor pause a masjid\'s queue over a network blip');
});

test('the queue is held BEFORE the alert, and state persisted before sending it', () => {
  const mon = read('system', 'whatsapp-monitor.ts');
  const pause = mon.indexOf('pauseQueue(reason)');
  const save = mon.indexOf('save({ down: true');
  const alert = mon.indexOf('deliverAlert(');
  assert.ok(pause > 0 && save > 0 && alert > 0);
  assert.ok(pause < alert, 'every message sent after detection is another one reported sent and lost');
  assert.ok(save < alert, 'a crash mid-send must not re-alert the same incident on the next boot');
});

test('no phone ever linked means the monitor does nothing at all', () => {
  const mon = read('system', 'whatsapp-monitor.ts');
  assert.match(mon, /!cfg\.linkedPhone/, 'a masjid that never linked must never be told anything');
});

// ── the alert ────────────────────────────────────────────────────────────────────

test('THE ALERT CANNOT BE ROUTED OVER WHATSAPP — the channel it is reporting broken', () => {
  const alerts = req('../src/notify/alerts') as typeof import('../src/notify/alerts');
  // Enforced on READ, not merely hidden in the UI: the matrix is reachable outside it, and
  // routing this alert to WhatsApp puts it into a gateway that cannot deliver, where
  // `enqueue` returns {queued:false} and it vanishes with no log and no fallback.
  assert.equal(alerts.whatsappAllowed('os', 'whatsapp-link-lost'), false);
  assert.equal(alerts.whatsappAllowed('os', 'core-update'), true, 'other OS alerts are unaffected');

  alerts.setAlertChannel('os', 'whatsapp-link-lost', 'whatsapp', true);
  assert.equal(
    alerts.getAlertChannels('os', 'whatsapp-link-lost').whatsapp,
    false,
    'even a config that says otherwise must not route it there',
  );
});

test('the alert is listed in the matrix, and shows WhatsApp as unavailable', () => {
  const alerts = req('../src/notify/alerts') as typeof import('../src/notify/alerts');
  const row = alerts.listAlertTypes().find((a) => a.source === 'os' && a.id === 'whatsapp-link-lost');
  assert.ok(row, 'the monitor must not fire into a type the matrix does not list');
  assert.equal(row!.whatsappAvailable, false);
  assert.equal(row!.channels.email, true, 'email and webhook are on by default');
  assert.equal(row!.channels.webhook, true);
});

test('the alert copy fits an inbox, and admits what cannot be resent', () => {
  const copy = req('../src/notify/alert-copy') as typeof import('../src/notify/alert-copy');
  const c = copy.whatsappLinkLost({
    reason: 'the gateway lost its WhatsApp connection',
    held: 14,
    since: Date.now() - 3 * 3_600_000,
    detectedAt: Date.now(),
    suspect: [
      { source: 'students', count: 9 },
      { source: 'donations', count: 4 },
    ],
  });
  // Constraints from test/email-render.test.ts.
  assert.ok(c.summary.length <= 90, `summary is the inbox snippet: ${c.summary.length}`);
  assert.ok(c.title.length <= 78);
  assert.doesNotMatch(JSON.stringify(c), /[⋯…→⇒]/, 'those glyphs render badly in mail clients');
  assert.equal(c.alertId, 'whatsapp-link-lost');
  // The honest part: it must say the unconfirmed ones cannot be resent from here.
  assert.match(JSON.stringify(c), /cannot be resent|does not keep their contents/i);
  assert.match(c.action?.path ?? '', /^\/settings\/whatsapp$/);
});

// ── holding and releasing ────────────────────────────────────────────────────────

test('the pump refuses to run while paused, and stops mid-drain if paused', () => {
  const wa = read('notify', 'whatsapp.ts');
  const pump = wa.slice(wa.indexOf('async function pump'));
  assert.match(pump, /if \(paused\) return;/, 'a paused queue must not start draining');
  assert.match(pump, /if \(paused\) break;/, 'and must stop if paused part-way through');
});

test('RELEASE IS EXPLICIT — the queue does not drain itself when the link returns', () => {
  const mon = read('system', 'whatsapp-monitor.ts');
  const recovery = mon.slice(mon.indexOf('if (alive) {'), mon.indexOf('if (state.down) return;'));
  assert.doesNotMatch(
    recovery,
    /releaseQueue|pump\(/,
    'a two-day backlog going out back-to-back from a freshly relinked number is the clearest ban signal there is',
  );
});

test('releasing banks the paused time first, or everything expires the moment it is freed', () => {
  const wa = read('notify', 'whatsapp.ts');
  const release = wa.slice(wa.indexOf('export function releaseQueue'), wa.indexOf('export function discardHeldMessages'));
  const bank = release.indexOf('bankPausedTime');
  const clear = release.indexOf('paused = false');
  assert.ok(bank > 0 && clear > 0 && bank < clear, 'bank the pause before clearing it');
});

test('discarding tells the apps, rather than leaving them a 404', () => {
  const wa = read('notify', 'whatsapp.ts');
  const discard = wa.slice(wa.indexOf('export function discardHeldMessages'));
  assert.match(discard, /noteOutcome\(item, 'failed'/, 'an app that asks must get a real answer');
});

// ── privacy ──────────────────────────────────────────────────────────────────────

test('THE ADMIN VIEW CARRIES COUNTS AND APP IDS, NEVER A BODY OR A RECIPIENT', () => {
  const wa = read('notify', 'whatsapp.ts');
  const summary = wa.slice(wa.indexOf('export function heldSummary'), wa.indexOf('export function outcomesInWindow'));
  // The queue holds bodies and numbers — it has to, or resending would be impossible — but
  // showing "14 messages are waiting" needs neither.
  assert.doesNotMatch(summary, /\.text\b/, 'no message text');
  assert.doesNotMatch(summary, /digits|groupId/, 'no recipient');
  assert.match(summary, /bySource/);
});

test('the suspect-window route is GET-only, on the read budget, and scoped to the caller', () => {
  const fabric = read('api', 'fabric.ts');
  assert.match(fabric, /'\/api\/fabric\/whatsapp\/suspect'/);
  // On READ_ONLY_ROUTES so polling it cannot eat an app's send allowance — the same reason
  // the per-id status route is there.
  const routes = fabric.slice(fabric.indexOf('const READ_ONLY_ROUTES'), fabric.indexOf('const READ_ONLY_ROUTES') + 300);
  assert.match(routes, /whatsapp\/suspect/);
  const route = fabric.slice(fabric.indexOf("server.get('/api/fabric/whatsapp/suspect'"));
  assert.match(route, /outcomesInWindow\([^)]*app\.id\)/, "an app may only see its own traffic");
  assert.match(route, /app\.whatsapp/, 'and must hold the whatsapp capability');
});

test('the send path no longer claims a message was "delivered"', () => {
  const wa = read('notify', 'whatsapp.ts');
  // A 2xx from OpenWA is an accept receipt from the gateway process — not from WhatsApp,
  // and not from the recipient's phone. Saying "delivered" is what made the outage look
  // like success in the logs too.
  assert.doesNotMatch(wa, /WhatsApp: delivered \$\{/, 'the log must not overstate what happened');
  assert.match(wa, /the gateway accepted/);
});
