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
const NOON = 12; // a safely non-quiet hour

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

test('quiet hours hold overnight, across midnight', () => {
  // Default window is 21:00–07:00, which wraps — the easy bug is treating start<end.
  const q = (h: number) => wa.inQuietHours(h, L);
  for (const h of [21, 22, 23, 0, 3, 6]) assert.equal(q(h), true, `${h}:00 is quiet`);
  for (const h of [7, 9, 12, 17, 20]) assert.equal(q(h), false, `${h}:00 is not quiet`);
});

test('a non-wrapping window and an empty window both behave', () => {
  const daytimeQuiet = { ...L, quietStartHour: 9, quietEndHour: 17 };
  assert.equal(wa.inQuietHours(12, daytimeQuiet), true);
  assert.equal(wa.inQuietHours(8, daytimeQuiet), false);
  // start === end means "no quiet hours", not "quiet for 24 hours" — getting this
  // backwards would silently stop every message for ever.
  const none = { ...L, quietStartHour: 0, quietEndHour: 0 };
  for (let h = 0; h < 24; h++) assert.equal(wa.inQuietHours(h, none), false, `${h}:00 must be allowed`);
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

test('quiet hours DELAY, they never discard', () => {
  // The queue must wait and re-evaluate, not drop the item: a fee reminder should
  // arrive in the morning, not vanish overnight. Asserted POSITIONALLY — a fixed-size
  // window around the branch ran past `continue` into the ordinary send path below it,
  // so the test failed on code that was already correct.
  const body = codeOf('notify/whatsapp.ts');
  const at = body.indexOf('if (reason)');
  assert.ok(at > 0, 'the pump must consult the policy');
  const continueAt = body.indexOf('continue;', at);
  const shiftAt = body.indexOf('queue.shift()', at);
  assert.ok(continueAt > at, 'a blocked send must be retried');
  assert.ok(shiftAt > continueAt, 'and must NOT be removed from the queue before that retry');
});

// ── caps ─────────────────────────────────────────────────────────────────────────

test('the hourly cap counts only the last hour, and the daily cap the last day', () => {
  const now = 1_000_000_000_000;
  const hist = noHistory();
  // 12 sends, all within the last hour → at the default cap of 12.
  for (let i = 0; i < L.perHour; i++) hist.sends.push(now - i * 60_000);
  assert.equal(blocked(now, hist), 'hourly limit reached');
  // Move them to two hours ago: the hour cap frees up, the day cap still counts them.
  const older = noHistory();
  for (let i = 0; i < L.perHour; i++) older.sends.push(now - 2 * 3_600_000 - i * 60_000);
  assert.equal(blocked(now, older), null, 'an hour later, sending resumes');
});

test('the daily cap holds even when the hour is quiet', () => {
  const now = 1_000_000_000_000;
  const hist = noHistory();
  // Spread the full day's allowance across the day, so no single hour is near its cap.
  for (let i = 0; i < L.perDay; i++) hist.sends.push(now - (i + 1) * 20 * 60_000);
  const reason = blocked(now, hist);
  assert.equal(reason, 'daily limit reached');
});

function blocked(now: number, hist: ReturnType<typeof noHistory>, linkedAt: string | null = null): string | null {
  return wa.blockedReason(now, NOON, who('15550101234'), L, linkedAt, hist);
}

// ── per-recipient cooldown ───────────────────────────────────────────────────────

test('one person is never hammered, even by different apps', () => {
  // Two apps each having something to say to the same parent is exactly the case a
  // per-app limiter cannot see.
  const now = 1_000_000_000_000;
  const hist = noHistory();
  hist.lastPerRecipient.set('15550101234', now - 5_000);
  assert.equal(blocked(now, hist), 'this recipient was messaged very recently');
  // A different recipient is unaffected.
  assert.equal(wa.blockedReason(now, NOON, who('447700900123'), L, null, hist), null);
  // And once the cooldown expires, they can be messaged again.
  hist.lastPerRecipient.set('15550101234', now - (L.perRecipientCooldownSeconds + 1) * 1000);
  assert.equal(blocked(now, hist), null);
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

test('the warm-up ramp still allows at least one message', () => {
  // `Math.floor(perHour * 0.25)` on a tightened config could reach 0, which would be a
  // silent total outage rather than a slow start.
  const tiny = { ...L, perHour: 1, perDay: 1 };
  const linkedToday = new Date().toISOString();
  const r = wa.blockedReason(Date.now(), NOON, who('15550101234'), tiny, linkedToday, noHistory());
  assert.equal(r, null, 'a brand-new number on a tight cap can still send one message');
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
    perHour: 100_000,
    perDay: 1_000_000,
    minGapSeconds: 0,
    jitterSeconds: 0,
    perRecipientCooldownSeconds: -5,
    quietStartHour: 99,
    quietEndHour: -3,
    warmupDays: 9999,
  });
  assert.ok(wild.perHour <= 60, `perHour clamped, got ${wild.perHour}`);
  assert.ok(wild.perDay <= 500, `perDay clamped, got ${wild.perDay}`);
  assert.ok(wild.minGapSeconds >= 3, 'never below a 3s gap');
  assert.ok(wild.jitterSeconds >= 1, 'always some jitter');
  assert.ok(wild.perRecipientCooldownSeconds >= 0);
  assert.ok(wild.quietStartHour >= 0 && wild.quietStartHour <= 23);
  assert.ok(wild.quietEndHour >= 0 && wild.quietEndHour <= 23);
  assert.ok(wild.warmupDays <= 90);
  // Junk and omissions fall back to the conservative defaults rather than to zero.
  const empty = store.clampLimits(undefined);
  assert.deepEqual(empty, store.DEFAULT_LIMITS);
  // @ts-expect-error deliberately wrong types — this arrives from a JSON file
  assert.equal(store.clampLimits({ perHour: 'lots', minGapSeconds: null }).perHour, store.DEFAULT_LIMITS.perHour);
});

test('the defaults are far below what OpenWA calls sustainable', () => {
  // Their guidance is "a few messages per minute is sustainable; thousands an hour is
  // not". A masjid needs neither — it needs the number to still work next term.
  const d = store.DEFAULT_LIMITS;
  assert.ok(d.perHour <= 20, `default perHour should be modest, got ${d.perHour}`);
  assert.ok(d.minGapSeconds >= 5, 'a human does not reply instantly');
  assert.ok(d.jitterSeconds >= 5, 'and not on a metronome');
  assert.ok(d.warmupDays >= 3, 'a new number must be eased in');
  assert.ok(d.quietStartHour !== d.quietEndHour, 'quiet hours are on by default');
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
  const shiftAt = body.indexOf('queue.shift()');
  assert.ok(retryAt > 0, 'the pump must classify the failure');
  assert.ok(retryAt < shiftAt, 'and must decide BEFORE removing the message from the queue');
  assert.match(body.slice(retryAt, shiftAt), /continue/, 'a retryable failure keeps its place');
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
  const at = code.indexOf("server.post('/api/fabric/whatsapp'");
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
