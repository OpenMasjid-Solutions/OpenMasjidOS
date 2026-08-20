// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * WhatsApp anti-ban pacing.
 *
 * OpenWA is an unofficial client, and its own README says plainly that the linked
 * number can be restricted or banned. The mitigation is behavioural, so the policy
 * below IS the feature — if it regresses, a masjid loses the number their parents are
 * reachable on, and no error message will have warned them.
 *
 * The policy functions are pure on purpose (`blockedReason`, `warmupFactor`,
 * `inQuietHours`, `nextGapMs`, `typingMs`, `toDigits`): a rule that can only be tested
 * by watching real traffic for a week is a rule nobody will ever verify again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(__filename);
const wa = req('../src/notify/whatsapp') as typeof import('../src/notify/whatsapp');
const store = req('../src/store/whatsapp') as typeof import('../src/store/whatsapp');

const L = store.DEFAULT_LIMITS;
const noHistory = () => ({
  sends: [] as number[],
  groupSends: [] as number[],
  lastPerRecipient: new Map<string, number>(),
});
/** A person target. `blockedReason` takes a Target now, so groups get their own budget
 *  without a second copy of the policy — see whatsapp-groups.test.ts. */
const who = (digits: string) => ({ kind: 'person' as const, digits });

// ── phone numbers ────────────────────────────────────────────────────────────────

test('a number is never given a country code we guessed', () => {
  // The dangerous failure is a "repair": prefixing our best guess would send a
  // masjid's fee reminder to a stranger who happens to own that number elsewhere.
  assert.equal(wa.toDigits('5550123'), null, 'too short to carry a country code');
  assert.equal(wa.toDigits('555 0123'), null);
  assert.equal(wa.toDigits(''), null);
  assert.equal(wa.toDigits('not a phone'), null);
  // Long enough to be E.164, punctuation tolerated.
  assert.equal(wa.toDigits('+1 (555) 010-1234'), '15550101234');
  assert.equal(wa.toDigits('+44 7700 900123'), '447700900123');
  assert.equal(wa.toDigits('  15550101234  '), '15550101234');
  // Past E.164's 15-digit maximum is a typo, not a number.
  assert.equal(wa.toDigits('1234567890123456'), null);
  assert.equal(wa.chatIdFor('15550101234'), '15550101234@c.us');
});

// ── quiet hours ──────────────────────────────────────────────────────────────────

test('there is no time-of-day hold, at any hour', () => {
  // Quiet hours were removed in v0.51.1 and must not come back in this shape. Two reasons,
  // both load-bearing:
  //
  //   1. The queue is SHARED by the OS and every app, and there is no per-message urgency
  //      flag — so a window that holds a parent's receipt (fine) also holds a staff alert
  //      about a declined card (not fine, and the reason a treasurer carries a phone).
  //   2. It was evaluated against the CONTAINER's clock, which is UTC because nothing sets
  //      TZ. The "21:00-07:00" window therefore fell at 17:00-03:00 for a US Eastern
  //      masjid and swallowed the whole evening.
  assert.equal(
    (wa as Record<string, unknown>).inQuietHours,
    undefined,
    'inQuietHours must stay deleted — see the note in notify/whatsapp.ts',
  );
  // And nothing else may sneak a local-hour test back in: the pacer must be clock-agnostic
  // beyond `now` as an instant.
  const code = codeOf('notify/whatsapp.ts');
  assert.ok(!/getHours()/.test(code), 'the pacer must not read the local hour');

  // Behaviourally: with a clean history, every hour of the day is sendable.
  for (let h = 0; h < 24; h++) {
    const at = Date.UTC(2026, 0, 15, h, 30);
    assert.equal(wa.blockedReason(at, who('15550101234'), L, null, noHistory()), null, `${h}:00 must send`);
  }
});

/**
 * The module source with comments stripped.
 *
 * Every structural assertion below runs against CODE, never prose. A first pass asserted
 * `send-bulk` never appears in the file — and matched the comment explaining why we
 * refuse to use it. A test that polices its own documentation fails for being right.
 */
function codeOf(file: string): string {
  return fs
    .readFileSync(path.join(__dirname, '..', 'src', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('a message that cannot go yet is DELAYED, never discarded', () => {
  // The queue must wait and reconsider, not drop the item: a fee reminder should arrive
  // late, not vanish. Asserted structurally, against the code rather than the comments.
  const body = codeOf('notify/whatsapp.ts');
  const at = body.indexOf('if (index < 0)');
  assert.ok(at > 0, 'the pump must decide whether anything is sendable');
  const continueAt = body.indexOf('continue;', at);
  const removeAt = body.indexOf('queue.splice(index, 1)', at);
  assert.ok(continueAt > at, 'when nothing can go, the pump waits and reconsiders');
  assert.ok(removeAt > continueAt, 'and nothing is removed from the queue before that');
});

test('one blocked message does not stall the rest of the queue', () => {
  // The head-of-line bug: the pump read `queue[0]` and, if that item could not go, slept and
  // re-read the SAME item — so one waiting message held up every other app's traffic for as
  // long as its own wait. With the 30-minute group cooldown that was half an hour of total
  // silence caused by one group post, which is exactly how "my image never arrives, but
  // another app's later messages do" happens.
  const code = codeOf('notify/whatsapp.ts');
  assert.ok(!code.includes('const item = queue[0]'), 'the pump must not fix on the head');
  assert.ok(code.includes('const item = queue[index]'), 'it must send the first SENDABLE item');
  // And a retry backoff must be per-item, not a sleep that holds the whole pump.
  assert.ok(!code.includes('await sleep(backoff)'), 'backoff must not stall the queue');
  assert.ok(code.includes('item.notBefore ='), 'a failing item reschedules itself instead');
});

// ── caps ─────────────────────────────────────────────────────────────────────────

test('individual messages have no hourly or daily cap', () => {
  // Removed at the maintainer's decision: with the warm-up ramp the caps came to 3/hour
  // on a freshly linked number, which blocked ordinary use and even testing, for a sending
  // pattern (one parent at a time) they were never aimed at. Spacing is the brake now —
  // the randomised 6-20s gap plus the per-recipient cooldown.
  //
  // The trade-off is recorded rather than hidden: an app looping over 200 parents will send
  // all 200, spaced but unbounded. If that ever needs a ceiling it belongs HERE, on the
  // shared queue, not in each app — a per-app limiter cannot see the number's total traffic.
  const now = 1_000_000_000_000;
  const hist = noHistory();
  for (let i = 0; i < 500; i++) hist.sends.push(now - i * 1_000);
  assert.equal(blocked(now, hist), null, '500 sends in the last few minutes is still allowed');
  assert.ok(!('perHour' in L), 'perHour must not exist in WhatsAppLimits');
  assert.ok(!('perDay' in L), 'perDay must not exist in WhatsAppLimits');
});

test('group posts DO still have caps, because the cost falls on the recipients', () => {
  // One group message reaches every member, so overuse is not "the sender's own problem"
  // in the way an over-eager fee run is. These caps stay.
  const now = 1_000_000_000_000;
  const hist = noHistory();
  for (let i = 0; i < L.groupPerHour; i++) hist.groupSends.push(now - i * 60_000);
  assert.equal(
    wa.blockedReason(now, { kind: 'group', groupId: '1@g.us' }, L, null, hist),
    'hourly group limit reached',
  );
  // And an individual message is unaffected by a spent group allowance.
  assert.equal(blocked(now, hist), null);
});

function blocked(now: number, hist: ReturnType<typeof noHistory>, linkedAt: string | null = null): string | null {
  return wa.blockedReason(now, who('15550101234'), L, linkedAt, hist);
}

// ── per-recipient cooldown ───────────────────────────────────────────────────────

test('there is no per-recipient or per-group cooldown any more', () => {
  // Removed at the maintainer's decision. The per-group one was 30 MINUTES, and together
  // with the head-of-line bug in  it meant one group post stalled every other app's
  // messages for that whole window — the reported "my image never arrives".
  const now = 1_000_000_000_000;
  const hist = noHistory();
  hist.lastPerRecipient.set('15550101234', now - 1); // messaged a millisecond ago
  assert.equal(blocked(now, hist), null, 'a person can be messaged again immediately');
  hist.lastPerRecipient.set('group:1@g.us', now - 1);
  assert.equal(
    wa.blockedReason(now, { kind: 'group', groupId: '1@g.us' }, L, null, hist),
    null,
    'and so can a group',
  );
});

test('the last-send map is still WRITTEN, though nothing reads it as a brake', () => {
  // Kept deliberately: it costs nothing, sendImmediate documents relying on the write, and
  // it is what any future per-recipient policy would need. Pinned so a tidy-up does not
  // remove the data along with the rule.
  assert.ok(codeOf('notify/whatsapp.ts').includes('lastToRecipient.set('), 'the write must remain');
});

// ── warm-up ──────────────────────────────────────────────────────────────────────

test('a freshly linked number gets a fraction of the allowance', () => {
  const now = Date.parse('2026-03-10T12:00:00Z');
  const day = 86_400_000;
  const at = (d: number) => new Date(now - d * day).toISOString();
  // 7-day ramp by default → thirds at ~2.33 days.
  assert.equal(wa.warmupFactor(at(0), L, now), 0.25, 'day 0');
  assert.equal(wa.warmupFactor(at(1), L, now), 0.25);
  assert.equal(wa.warmupFactor(at(3), L, now), 0.5, 'middle third');
  assert.equal(wa.warmupFactor(at(6), L, now), 0.75, 'final third');
  assert.equal(wa.warmupFactor(at(8), L, now), 1, 'ramp complete');
});

test('an unknown or skewed link date never locks a working masjid out', () => {
  const now = Date.parse('2026-03-10T12:00:00Z');
  assert.equal(wa.warmupFactor(null, L, now), 1, 'never linked / unknown → full');
  assert.equal(wa.warmupFactor('not a date', L, now), 1, 'unparseable → full');
  // A clock that thinks the link is in the future must not be read as "day 0 forever".
  assert.equal(wa.warmupFactor(new Date(now + 5 * 86_400_000).toISOString(), L, now), 1);
  assert.equal(wa.warmupFactor('2026-03-10T12:00:00Z', { ...L, warmupDays: 0 }, now), 1, 'ramp disabled');
});

test('the warm-up ramp still allows at least one group post', () => {
  // `Math.floor(groupPerHour * 0.25)` on a tightened config could reach 0, which would be
  // a silent total outage rather than a slow start. (The ramp no longer affects individual
  // messages, since those have no cap for it to scale.)
  const tiny = { ...L, groupPerHour: 1, groupPerDay: 1 };
  const linkedToday = new Date().toISOString();
  const r = wa.blockedReason(Date.now(), { kind: 'group', groupId: '1@g.us' }, tiny, linkedToday, noHistory());
  assert.equal(r, null, 'a brand-new number on a tight cap can still post once');
});

// ── gap + typing ─────────────────────────────────────────────────────────────────

test('the gap is randomised, never a fixed beat', () => {
  // A perfectly regular interval is itself a fingerprint, so the spread matters more
  // than the average.
  assert.equal(wa.nextGapMs(L, () => 0), L.minGapSeconds * 1000, 'floor');
  assert.equal(wa.nextGapMs(L, () => 1), (L.minGapSeconds + L.jitterSeconds) * 1000, 'ceiling');
  const seen = new Set<number>();
  for (let i = 0; i < 200; i++) seen.add(Math.round(wa.nextGapMs(L) / 1000));
  assert.ok(seen.size > 5, `gaps must vary, saw ${seen.size} distinct values`);
  // Never faster than the floor, whatever the RNG returns.
  for (const r of [0, 0.001, 0.5, 0.999, 1]) {
    assert.ok(wa.nextGapMs(L, () => r) >= L.minGapSeconds * 1000);
  }
});

test('typing time grows with the message but stays bounded', () => {
  const short = wa.typingMs('ok');
  const long = wa.typingMs('x'.repeat(2000));
  assert.ok(short >= 1500, 'even a short reply takes a moment');
  assert.ok(long > short, 'a longer message takes longer to type');
  assert.ok(long <= 8000, 'but never stalls the queue for a minute');
});

// ── the limits cannot be loosened into a blaster ─────────────────────────────────

test('clampLimits only ever lets an admin be MORE careful', () => {
  // The UI is not the only writer, so the floor lives in the store.
  const wild = store.clampLimits({
    minGapSeconds: 0,
    jitterSeconds: 0,
    perRecipientCooldownSeconds: -5,
    warmupDays: 9999,
  });
  assert.ok(wild.minGapSeconds >= 3, 'never below a 3s gap');
  assert.ok(wild.jitterSeconds >= 1, 'always some jitter');
  assert.ok(wild.perRecipientCooldownSeconds >= 0);
  assert.ok(wild.warmupDays <= 90);
  // The window is gone from the shape entirely, not merely unused.
  assert.ok(!('quietStartHour' in wild), 'quietStartHour must not exist in WhatsAppLimits');
  assert.ok(!('quietEndHour' in wild), 'quietEndHour must not exist in WhatsAppLimits');
  // Junk and omissions fall back to the conservative defaults rather than to zero.
  const empty = store.clampLimits(undefined);
  assert.deepEqual(empty, store.DEFAULT_LIMITS);
  // @ts-expect-error deliberately wrong types — this arrives from a JSON file
  assert.equal(store.clampLimits({ minGapSeconds: null }).minGapSeconds, store.DEFAULT_LIMITS.minGapSeconds);
});

test('the defaults are far below what OpenWA calls sustainable', () => {
  // Their guidance is "a few messages per minute is sustainable; thousands an hour is
  // not". A masjid needs neither — it needs the number to still work next term.
  const d = store.DEFAULT_LIMITS;
  assert.ok(d.groupPerHour <= 8, `default groupPerHour should be modest, got ${d.groupPerHour}`);
  assert.ok(d.minGapSeconds >= 5, 'a human does not reply instantly');
  assert.ok(d.jitterSeconds >= 5, 'and not on a metronome');
  assert.ok(d.warmupDays >= 3, 'a new number must be eased in');
});

// ── structural guarantees ────────────────────────────────────────────────────────

test('sending is serialised, and bulk is deliberately unused', () => {
  const code = codeOf('notify/whatsapp.ts');
  // The single in-flight guard is the whole reason this module exists: pacing belongs
  // to the NUMBER, so two callers sending politely at once still burst.
  assert.match(code, /if \(running\) return;/, 'the pump must never run twice concurrently');
  // OpenWA's send-bulk paces only within one request, which is useless across callers.
  // Checked against code, so the comment explaining this choice doesn't trip it.
  assert.doesNotMatch(code, /messages\/send-bulk/, 'send-bulk must not be called');
  // Message bodies can carry a parent's name and a child's fees.
  assert.doesNotMatch(code, /log\.(info|warn|error)\([^)]*item\.text/, 'never log a message body');
});

// ── the two defects OpenMasjidAPPS found by reading this code ────────────────────

test('a 429 is a "not yet", not a lost message', () => {
  // THE BUG. Every non-2xx was treated the same, and the queue shifted the item off
  // regardless — so a rate-limit response silently DISCARDED a parent's fee reminder.
  // Rate limiting is the one error a deliberately-paced sender should expect to meet.
  assert.equal(wa.isRetryableStatus(429), true, '429 must be retried');
  assert.equal(wa.isRetryableStatus(0), true, 'network error / timeout must be retried');
  assert.equal(wa.isRetryableStatus(500), true, 'gateway restarting must be retried');
  assert.equal(wa.isRetryableStatus(502), true);
  assert.equal(wa.isRetryableStatus(503), true);
  // Permanent refusals must NOT be retried — repeating them just burns the number's
  // allowance against a request that can never succeed.
  for (const s of [400, 401, 403, 404, 409, 422]) {
    assert.equal(wa.isRetryableStatus(s), false, `${s} is permanent`);
  }
});

test('a transient failure keeps its place in the queue, a permanent one does not', () => {
  const code = codeOf('notify/whatsapp.ts');
  const pumpAt = code.indexOf('async function pump');
  const body = code.slice(pumpAt);
  const retryAt = body.indexOf('outcome.retryable');
  const removeAt = body.indexOf('queue.splice(index, 1)');
  assert.ok(retryAt > 0, 'the pump must classify the failure');
  assert.ok(retryAt < removeAt, 'and must decide BEFORE removing the message from the queue');
  assert.match(body.slice(retryAt, removeAt), /continue/, 'a retryable failure keeps its place');
  // And it must give up eventually rather than looping on a permanently broken gateway.
  assert.match(code, /MAX_ATTEMPTS/, 'retries must be bounded');
});

test('qr_ready is NOT connected — the substring trap', () => {
  // The status test was `/connected|working|open|authenticated|ready/`, and `qr_ready`
  // contains "ready". So a session merely WAITING to be linked reported as connected —
  // exactly backwards, and it is the state a fresh install sits in longest.
  const code = codeOf('notify/whatsapp.ts');
  assert.doesNotMatch(code, /\/connected\|working\|open/, 'the substring regex must stay gone');
  // Statuses come from OpenWA's own enum, matched exactly.
  assert.match(code, /const READY = 'ready'/, 'ready is matched exactly');
  assert.match(code, /qr_ready/, "and qr_ready is listed as pending, not ready");
  const pending = code.slice(code.indexOf('PENDING_STATUSES'), code.indexOf('PENDING_STATUSES') + 200);
  for (const s of ['created', 'initializing', 'qr_ready', 'authenticating']) {
    assert.match(pending, new RegExp(s), `${s} must count as pending`);
  }
});

test('"no session yet" is reported separately from "gateway unreachable"', () => {
  // They have completely different fixes — one is "press link", the other is "is OpenWA
  // running?" — so collapsing them sent the admin hunting a network fault that was not
  // there.
  const code = codeOf('notify/whatsapp.ts');
  assert.match(code, /'no-session'/, 'the state must exist');
  const fn = code.slice(code.indexOf('export async function gatewayStatus'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /if \(!cfg\.sessionId\)/, 'a missing session is checked before being called unreachable');
  assert.match(body, /404/, 'and a session deleted at the gateway is recoverable, not unreachable');
});

test('the session id is machine-managed, never typed by an admin', () => {
  // OpenWA mints a UUID and POST /api/sessions takes only a name, so there is nothing an
  // admin could sensibly type. Accepting one from the UI would also let a typo point this
  // masjid at another masjid's session on a shared gateway.
  const store = codeOf('store/whatsapp.ts');
  assert.match(store, /export function recordSessionId/, 'the platform records what the gateway minted');
  assert.doesNotMatch(store, /input\.sessionId/, 'and never takes an id from the settings input');
  const routerSrc = codeOf('trpc/routers/whatsapp.ts');
  assert.doesNotMatch(routerSrc, /sessionId: z\./, 'the API must not accept a session id');
  assert.match(routerSrc, /sessionName: z\./, 'only a human label');
  // Create → start → pair is one action, owned by the sender (see whatsapp-link.test.ts).
  assert.match(codeOf('notify/whatsapp.ts'), /ensureSession\(\)/, 'linking creates the session itself');
});

test('the Fabric route queues rather than claiming delivery', () => {
  const code = codeOf('api/fabric.ts');
  // Anchor on the POST: a GET on the same path (the availability read) sits above it, so
  // matching the path alone selected that route instead.
  const at = code.search(/server\.post\(\s*'\/api\/fabric\/whatsapp'/);
  assert.ok(at > 0, 'the route must exist');
  // Bound the slice at the NEXT route registration. `indexOf('});')` matched the
  // route's own rate-limit reply, cutting the body off before anything worth asserting.
  const next = code.indexOf('server.post(', at + 10);
  const body = code.slice(at, next > at ? next : undefined);
  assert.match(body, /app\.whatsapp/, 'must be capability-gated');
  assert.match(body, /\.code\(result\.queued \? 202 : 400\)/, 'must answer 202 accepted, not 200 sent');
  assert.match(body, /enqueueWhatsApp/, 'must queue rather than send inline');
  // An array of recipients would invite a blast; the shape should discourage it.
  assert.doesNotMatch(body, /Array\.isArray/, 'one recipient per call');
});
