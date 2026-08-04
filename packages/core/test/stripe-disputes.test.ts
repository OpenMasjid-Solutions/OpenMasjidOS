// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Chargeback alerts: parsing, money formatting, and the dedup/first-run rule.
 *
 * These carry more weight than usual because the input comes from an API we cannot
 * integration-test in CI — that needs live Stripe credentials. So the contract is
 * pinned from the other direction: every field is treated as untrusted, and the tests
 * assert that a malformed, partial or unexpected response degrades the alert instead
 * of throwing or printing "undefined" at a volunteer.
 *
 * The endpoint path itself WAS verified against the real API, by differential probe:
 * `GET /v1/disputes` with a bad key returns "Invalid API Key provided" (the route
 * exists and authenticated), whereas a made-up path returns "Unrecognized request
 * URL". No credentials needed, and it rules out the one thing a unit test can't:
 * having written the wrong URL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDispute,
  parseDisputeList,
  needsResponse,
  currencyDecimals,
  formatAmount,
  formatDueBy,
  reasonText,
} from '../src/stripe/disputes';
import { selectNewDisputes } from '../src/system/stripe-monitor';
import { stripeChargeback, stripeChargebacksMany } from '../src/notify/alert-copy';

/** A realistically-shaped dispute, per Stripe's documented fields. */
const RAW = {
  id: 'dp_1NkTest',
  object: 'dispute',
  amount: 4500,
  currency: 'gbp',
  reason: 'fraudulent',
  status: 'needs_response',
  created: 1_754_000_000,
  charge: 'ch_1NkTest',
  evidence_details: { due_by: 1_755_000_000, has_evidence: false },
};

test('a well-formed dispute parses to exactly the fields the alert needs', () => {
  const d = parseDispute(RAW);
  assert.deepEqual(d, {
    id: 'dp_1NkTest',
    amount: 4500,
    currency: 'gbp',
    reason: 'fraudulent',
    status: 'needs_response',
    created: 1_754_000_000,
    dueBy: 1_755_000_000,
  });
});

test('a malformed or hostile response degrades instead of throwing', () => {
  // Every one of these is something a changed/broken API could return. None may throw.
  const cases: unknown[] = [
    null,
    undefined,
    'a string',
    42,
    [],
    {},
    { id: '' },
    { id: '   ' },
    { id: 'dp_1', amount: 'not a number', currency: 42, status: null, evidence_details: 'nope' },
    { id: 'dp_2', amount: Number.NaN, created: Infinity, evidence_details: { due_by: 'soon' } },
    { id: 'dp_3', evidence_details: null },
  ];
  for (const c of cases) {
    assert.doesNotThrow(() => parseDispute(c), `must not throw on ${JSON.stringify(c)}`);
  }
  // No usable id → skipped entirely rather than becoming a nameless alert.
  assert.equal(parseDispute({}), null);
  assert.equal(parseDispute({ id: '  ' }), null);
  assert.equal(parseDispute('a string'), null);
  // Bad field types are dropped, not coerced into nonsense.
  const partial = parseDispute({ id: 'dp_1', amount: 'not a number', currency: 42, evidence_details: 'nope' });
  assert.equal(partial?.id, 'dp_1');
  assert.equal(partial?.amount, null);
  assert.equal(partial?.currency, null);
  assert.equal(partial?.dueBy, null);
});

test('the list parser skips unusable entries and never throws', () => {
  for (const body of [null, {}, { data: null }, { data: 'nope' }, { data: {} }, 'string']) {
    assert.doesNotThrow(() => parseDisputeList(body));
    assert.deepEqual(parseDisputeList(body), []);
  }
  const mixed = parseDisputeList({ data: [RAW, null, { nope: true }, { id: 'dp_2' }, 'junk'] });
  assert.deepEqual(mixed.map((d) => d.id), ['dp_1NkTest', 'dp_2']);
});

test('money is formatted in the right units for zero-, two- and three-decimal currencies', () => {
  // Stripe quotes the smallest unit. Dividing by 100 regardless would misreport a
  // Gulf masjid's KWD by 10x and a JPY amount by 100x — this is the bug this pins.
  assert.equal(currencyDecimals('jpy'), 0);
  assert.equal(currencyDecimals('KWD'), 3);
  assert.equal(currencyDecimals('gbp'), 2);
  assert.equal(currencyDecimals(null), 2, 'unknown currency falls back to 2');

  assert.match(formatAmount(4500, 'gbp') ?? '', /45\.00/);
  assert.match(formatAmount(50_000, 'jpy') ?? '', /50,000/);
  assert.doesNotMatch(formatAmount(50_000, 'jpy') ?? '', /500\.00/, 'JPY must not be divided by 100');
  assert.match(formatAmount(45_000, 'kwd') ?? '', /45\.000/);
  assert.doesNotMatch(formatAmount(45_000, 'kwd') ?? '', /450\.00/, 'KWD must not be divided by 100');
  // Nothing to format, and a nonsense code, both stay presentable.
  assert.equal(formatAmount(null, 'gbp'), null);
  assert.ok((formatAmount(1234, 'not-a-currency') ?? '').includes('12.34'));
  assert.ok((formatAmount(1234, null) ?? '').length > 0);
});

test('a deadline renders in words, and a missing or broken one renders as nothing', () => {
  assert.match(formatDueBy(1_755_000_000) ?? '', /\d{1,2} \w+ \d{4}/);
  assert.equal(formatDueBy(null), null);
  assert.equal(formatDueBy(Number.NaN), null);
  assert.equal(formatDueBy(Infinity), null);
});

test('every Stripe reason becomes a sentence, including ones we have never seen', () => {
  assert.match(reasonText('fraudulent'), /didn't recognise|authorise/i);
  assert.match(reasonText('product_not_received'), /receive/i);
  // The case that matters for the future: Stripe adds a code we don't know.
  const unknown = reasonText('some_brand_new_reason');
  assert.match(unknown, /some brand new reason/, 'an unknown code is still readable');
  assert.doesNotMatch(unknown, /undefined|_/, 'and never leaks a raw snake_case token or undefined');
  assert.ok(reasonText(null).length > 0, 'a missing reason still yields a sentence');
});

test('needsResponse identifies exactly the states with a deadline', () => {
  for (const s of ['needs_response', 'warning_needs_response']) assert.equal(needsResponse(s), true, s);
  for (const s of ['under_review', 'won', 'lost', 'warning_closed', 'warning_under_review', null, '', 'nonsense']) {
    assert.equal(needsResponse(s), false, String(s));
  }
});

// ── the dedup / first-run rule ────────────────────────────────────────────────

const d = (id: string, status = 'needs_response'): Parameters<typeof selectNewDisputes>[0][number] => ({
  id,
  amount: 1000,
  currency: 'gbp',
  reason: 'fraudulent',
  status,
  created: 1,
  dueBy: 2,
});

test('first run absorbs settled history silently but still reports anything open', () => {
  // Both halves matter. Emailing a masjid about disputes from last year that are
  // already closed is noise; silently swallowing one that still needs a reply loses
  // them real money, because doing nothing means the dispute is lost by default.
  const fetched = [d('dp_open'), d('dp_lost', 'lost'), d('dp_won', 'won'), d('dp_closed', 'warning_closed')];
  const r = selectNewDisputes(fetched, undefined);
  assert.equal(r.firstRun, true);
  assert.deepEqual(r.toAlert.map((x) => x.id), ['dp_open'], 'only the one awaiting a reply alerts');
  assert.deepEqual(r.seen.sort(), ['dp_closed', 'dp_lost', 'dp_open', 'dp_won'], 'all are recorded');
});

test('after the first run, every new dispute alerts regardless of status', () => {
  const state = { seen: ['dp_old'], initialised: true };
  const r = selectNewDisputes([d('dp_new'), d('dp_settled', 'lost'), d('dp_old')], state);
  assert.equal(r.firstRun, false);
  assert.deepEqual(r.toAlert.map((x) => x.id).sort(), ['dp_new', 'dp_settled']);
});

test('a dispute is never alerted twice', () => {
  // The whole point of persisting state: polling every 30 minutes must not re-send.
  let state = { seen: [] as string[], initialised: false };
  const fetched = [d('dp_1')];
  const first = selectNewDisputes(fetched, state);
  assert.deepEqual(first.toAlert.map((x) => x.id), ['dp_1']);
  state = { seen: first.seen, initialised: true };
  for (let i = 0; i < 5; i++) {
    const again = selectNewDisputes(fetched, state);
    assert.deepEqual(again.toAlert, [], `poll ${i + 2} must be silent`);
    state = { seen: again.seen, initialised: true };
  }
});

test('the seen list is bounded and keeps the newest ids', () => {
  // Stripe returns newest first, so the newest must survive the cap.
  const many = Array.from({ length: 600 }, (_, i) => d(`dp_${i}`));
  const r = selectNewDisputes(many, { seen: ['dp_ancient'], initialised: true });
  assert.ok(r.seen.length <= 500, `capped, got ${r.seen.length}`);
  assert.ok(r.seen.includes('dp_0'), 'the newest id is kept');
  assert.equal(r.seen.includes('dp_ancient'), false, 'the oldest is dropped first');
});

// ── the words a volunteer actually reads ──────────────────────────────────────

test('the chargeback alert leads with the money and the deadline', () => {
  const copy = stripeChargeback({
    accountLabel: 'Masjid Donations',
    amount: '£45.00',
    reason: reasonText('fraudulent'),
    dueBy: '14 August 2026',
    needsResponse: true,
    reference: 'dp_1NkTest',
  });
  assert.equal(copy.alertId, 'stripe-chargeback');
  assert.equal(copy.level, 'error');
  assert.match(copy.title, /£45\.00/);
  assert.match(copy.summary, /disputed/);
  assert.match(copy.summary, /14 August 2026/, 'the deadline belongs in the inbox snippet');
  // §14 voice + the alert-copy rules that came from a real bug report.
  assert.ok(copy.summary.length <= 120, `snippet must survive untruncated: ${copy.summary.length}`);
  assert.doesNotMatch(`${copy.title}${copy.summary}${copy.detail}`, /[⋯→]/, 'no glyphs email fonts lack');
  assert.doesNotMatch(`${copy.title}${copy.summary}${copy.detail}`, /chargeback/i, 'plainer word in the body');
  assert.doesNotMatch(JSON.stringify(copy), /undefined|null/, 'no placeholder text can reach the admin');
  // No button: the action is in Stripe, and the email builds URLs relative to the
  // dashboard, so any button here would lead somewhere useless.
  assert.equal(copy.action, undefined);
  assert.ok(copy.facts?.some((f) => f.value === 'dp_1NkTest'), 'the Stripe reference is findable');
});

test('an alert with no amount or deadline still reads as a sentence', () => {
  // Exactly what a partial API response produces — assert the copy survives it.
  const copy = stripeChargeback({
    accountLabel: 'Donations',
    amount: null,
    reason: reasonText(null),
    dueBy: null,
    needsResponse: false,
    reference: 'dp_x',
  });
  assert.doesNotMatch(JSON.stringify(copy), /undefined|null|NaN/);
  assert.match(copy.title, /A payment has been disputed/);
  assert.ok(!copy.facts?.some((f) => f.label === 'Amount'), 'an unknown amount is omitted, not blank');
  assert.ok(!copy.facts?.some((f) => f.label === 'Reply by'));
});

test('a burst of disputes becomes one grouped alert, not a flooded inbox', () => {
  const copy = stripeChargebacksMany({ count: 12, accountLabel: 'Donations', total: '£540.00', soonest: '1 September 2026' });
  assert.equal(copy.alertId, 'stripe-chargeback', 'shares the admin’s on/off switch');
  assert.match(copy.title, /12 card payments/);
  assert.match(copy.summary, /£540\.00/);
  assert.doesNotMatch(JSON.stringify(copy), /undefined|null/);
});

test('the alert type is registered so it appears in Settings → Alerts', () => {
  // Without this the monitor would fire into a type the matrix doesn't list, and the
  // admin would have no way to route or silence it.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'notify', 'alerts.ts'),
    'utf8',
  ) as string;
  assert.match(src, /id: 'stripe-chargeback'/, 'must be in OS_ALERTS');
});
