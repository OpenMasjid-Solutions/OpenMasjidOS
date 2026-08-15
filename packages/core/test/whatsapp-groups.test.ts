// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Posting to a WhatsApp group.
 *
 * One message to a group reaches everyone in it, which is why this exists: reaching 200
 * parents one at a time costs 200 outbound messages paced over hours, and is the highest
 * ban-risk shape of traffic there is. A group post is one message.
 *
 * That power is why the approval step is the security model rather than a convenience.
 * OpenWA's group list contains EVERY group the linked phone is in — the imam's family
 * chat, a friends group — so an app that could name a group freely could read those and
 * post into them. `isApprovedGroup` is the only thing that can authorise a target.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.OPENMASJID_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-wa-groups-'));

const req = createRequire(__filename);
const store = req('../src/store/whatsapp') as typeof import('../src/store/whatsapp');
const wa = req('../src/notify/whatsapp') as typeof import('../src/notify/whatsapp');

const GROUP = '120363012345678901@g.us';
const OTHER = '120363099999999999@g.us';

function configure(): void {
  store.saveWhatsAppConfig({ provider: 'openwa', apiKey: 'k', baseUrl: 'http://127.0.0.1:1' });
}

const codeOf = (rel: string) =>
  fs
    .readFileSync(path.join(__dirname, '..', '..', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

// ── what may be named as a group ─────────────────────────────────────────────────

test('only a real group JID is accepted, and only a GROUP one', () => {
  assert.equal(store.isGroupJid(GROUP), true);
  // A person's address must never pass: it would silently turn "post to the parents
  // group" into "message one person".
  assert.equal(store.isGroupJid('15550101234@c.us'), false);
  for (const bad of ['', '   ', '@g.us', 'abc@g.us', '../etc@g.us', '120363@g.us/../x', 'x'.repeat(200) + '@g.us']) {
    assert.equal(store.isGroupJid(bad), false, `must reject ${JSON.stringify(bad)}`);
  }
  // Not a string at all.
  for (const bad of [null, undefined, 42, {}, []]) {
    assert.equal(store.isGroupJid(bad), false);
  }
});

test('approval is the only thing that authorises a group', () => {
  configure();
  assert.equal(store.isApprovedGroup(GROUP), false, 'nothing is approved by default');

  store.approveGroup(GROUP, 'Parents — Hifz');
  assert.equal(store.isApprovedGroup(GROUP), true);
  assert.equal(store.isApprovedGroup(OTHER), false, 'approving one must not approve another');

  // Withdrawing approval takes effect immediately — no restart, no cache to bust.
  store.unapproveGroup(GROUP);
  assert.equal(store.isApprovedGroup(GROUP), false);
});

test('a malformed id can never be approved, so it can never be sent to', () => {
  configure();
  assert.throws(() => store.approveGroup('15550101234@c.us', 'sneaky'), /not a WhatsApp group/);
  assert.throws(() => store.approveGroup('../../etc/passwd', 'sneaky'));
  assert.equal(store.listApprovedGroups().some((g) => g.id.includes('..')), false);
});

test('approving twice re-labels rather than duplicating', () => {
  configure();
  store.approveGroup(GROUP, 'First name');
  store.approveGroup(GROUP, 'Better name');
  const list = store.listApprovedGroups().filter((g) => g.id === GROUP);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.label, 'Better name');
  store.unapproveGroup(GROUP);
});

// ── enqueueing ───────────────────────────────────────────────────────────────────

test('an unapproved group is refused at the door', () => {
  configure();
  wa.__resetPacingForTests();
  const r = wa.enqueue({ groupId: OTHER, text: 'hello', source: 'students' });
  assert.equal(r.queued, false);
  assert.match(String(r.error), /not been approved/i);
});

test('an approved group is accepted', () => {
  configure();
  wa.__resetPacingForTests();
  store.approveGroup(GROUP, 'Parents');
  const r = wa.enqueue({ groupId: GROUP, text: 'Madrasa is closed tomorrow.', source: 'students' });
  assert.equal(r.queued, true, r.error);
  wa.__resetPacingForTests();
});

test('a caller must choose exactly one target', () => {
  configure();
  wa.__resetPacingForTests();
  store.approveGroup(GROUP, 'Parents');
  // Both: ambiguous, and the wrong guess sends a private message to a whole group.
  const both = wa.enqueue({ to: '+15550101234', groupId: GROUP, text: 'hi', source: 'students' });
  assert.equal(both.queued, false);
  const neither = wa.enqueue({ text: 'hi', source: 'students' });
  assert.equal(neither.queued, false);
  wa.__resetPacingForTests();
});

// ── pacing ───────────────────────────────────────────────────────────────────────

const L = store.DEFAULT_LIMITS;
const NOON = 12;
const person = { kind: 'person' as const, digits: '15550101234' };
const group = { kind: 'group' as const, groupId: GROUP };
const history = (over: Partial<{ sends: number[]; groupSends: number[]; last: Map<string, number> }> = {}) => ({
  sends: over.sends ?? [],
  groupSends: over.groupSends ?? [],
  lastPerRecipient: over.last ?? new Map<string, number>(),
});

test('the two budgets are independent in BOTH directions', () => {
  const now = Date.now();
  // Spread across the day, so it is the DAILY cap being exhausted and not the hourly one
  // — otherwise this passes for the wrong reason.
  const overADay = (n: number) => Array.from({ length: n }, (_, i) => now - Math.round((i * 86_400_000) / (n + 1)));

  // A day of individual reminders must not silence an announcement…
  const individualsSpent = overADay(L.perDay);
  assert.equal(wa.blockedReason(now, NOON, group, L, null, history({ sends: individualsSpent })), null);
  assert.equal(
    wa.blockedReason(now, NOON, person, L, null, history({ sends: individualsSpent })),
    'daily limit reached',
  );

  // …and a day of announcements must not stop a parent being told their fees are due.
  const groupsSpent = overADay(L.groupPerDay);
  assert.equal(wa.blockedReason(now, NOON, person, L, null, history({ groupSends: groupsSpent })), null);
  assert.equal(
    wa.blockedReason(now, NOON, group, L, null, history({ groupSends: groupsSpent })),
    'daily group limit reached',
  );
});

test('the group cap is far tighter than the individual one', () => {
  // The blast radius of one group message is the whole group, so the brake is stricter.
  assert.ok(L.groupPerHour < L.perHour, 'hourly');
  assert.ok(L.groupPerDay < L.perDay, 'daily');
  assert.ok(L.perGroupCooldownSeconds > L.perRecipientCooldownSeconds, 'cooldown');
});

test('quiet hours and the warm-up ramp apply to groups too', () => {
  const now = Date.now();
  // 03:00 — a fee reminder annoys one person; a group post wakes two hundred.
  assert.equal(wa.blockedReason(now, 3, group, L, null, history()), 'quiet hours');

  // Linked minutes ago: a brand-new number posting to a big group is a strong signal.
  const justLinked = new Date(now - 60_000).toISOString();
  const factor = wa.warmupFactor(justLinked, L, now);
  assert.ok(factor < 1, 'the ramp must actually reduce the allowance');
  const rampedCap = Math.max(1, Math.floor(L.groupPerDay * factor));
  const spent = Array.from({ length: rampedCap }, (_, i) => now - i * 1000);
  assert.match(String(wa.blockedReason(now, NOON, group, L, justLinked, history({ groupSends: spent }))), /group/);
});

test('the per-group cooldown is keyed separately from a person', () => {
  const now = Date.now();
  // A person and a group could otherwise collide in the same map; the key must not.
  const last = new Map<string, number>([[`group:${GROUP}`, now - 1000]]);
  assert.match(String(wa.blockedReason(now, NOON, group, L, null, history({ last }))), /recently/);
  assert.equal(wa.blockedReason(now, NOON, person, L, null, history({ last })), null, 'the person is unaffected');
});

test('clampLimits only ever tightens the group limits', () => {
  const loosened = store.clampLimits({ groupPerHour: 9999, groupPerDay: 9999, perGroupCooldownSeconds: -5 });
  assert.ok(loosened.groupPerHour <= 20, `groupPerHour escaped: ${loosened.groupPerHour}`);
  assert.ok(loosened.groupPerDay <= 50, `groupPerDay escaped: ${loosened.groupPerDay}`);
  assert.ok(loosened.perGroupCooldownSeconds >= 0);
  // Stricter is always allowed.
  assert.equal(store.clampLimits({ groupPerHour: 1, groupPerDay: 1 }).groupPerHour, 1);
});

// ── structure ────────────────────────────────────────────────────────────────────

test('one queue still owns everything — groups did not get their own sender', () => {
  // The single serialised pump is the whole anti-ban defence. Group support changes the
  // BUDGET, never the serialisation.
  const code = codeOf('core/src/notify/whatsapp.ts');
  assert.equal((code.match(/async function pump\(/g) ?? []).length, 1, 'exactly one pump');
  assert.match(code, /if \(running\) return;/, 'and it still refuses to run twice');
  assert.doesNotMatch(code, /send-bulk/, 'upstream bulk sending must stay unused');
});

test('contacts/check is skipped for groups but still runs for people', () => {
  // It answers "is this PHONE NUMBER on WhatsApp", so asking it about a group id is
  // meaningless — and its "no" would silently refuse every group post.
  const code = codeOf('core/src/notify/whatsapp.ts');
  const fn = code.slice(code.indexOf('async function sendOne'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  const guardAt = body.indexOf("item.target.kind === 'person'");
  const checkAt = body.indexOf('checkRegistered(');
  assert.ok(guardAt > 0 && checkAt > guardAt, 'the check must sit inside the person-only branch');
});

test('the app-facing group list exposes only approved groups', () => {
  // The raw gateway list is the masjid's entire group membership. It must never cross
  // the Fabric boundary — apps see the admin's approved list and nothing else.
  const code = codeOf('core/src/api/fabric.ts');
  const at = code.indexOf("server.get('/api/fabric/whatsapp/groups'");
  assert.ok(at > 0, 'the route must exist');
  const body = code.slice(at, code.indexOf('server.post(', at));
  assert.match(body, /listApprovedGroups\(\)/, 'it must read the approved list');
  assert.doesNotMatch(body, /listGatewayGroups/, 'and must never proxy the gateway list');
  assert.match(body, /app\.whatsapp/, 'capability-gated like the send');

  // The admin-only route is the one allowed to see everything.
  assert.match(codeOf('core/src/trpc/routers/whatsapp.ts'), /listGatewayGroups\(\)/);
});

test('the send route refuses an unapproved group with 403, not a vague 400', () => {
  // It is an authorisation answer. A 400 would send an app author hunting for a typo in
  // their payload instead of asking the admin to approve the group.
  const code = codeOf('core/src/api/fabric.ts');
  const at = code.search(/server\.post\(\s*'\/api\/fabric\/whatsapp'/);
  assert.ok(at > 0, 'the send route must exist');
  // Bounded by the next route registration, not a character count: the handler grew when
  // image support landed and a fixed 2000-char window stopped reaching the guard.
  const next = code.indexOf('server.', at + 10);
  const body = code.slice(at, next > at ? next : undefined);
  const guardAt = body.indexOf('isApprovedGroup(group)');
  const enqueueAt = body.indexOf('enqueueWhatsApp(');
  assert.ok(guardAt > 0, 'the route must check approval');
  assert.ok(guardAt < enqueueAt, 'and must check BEFORE queueing anything');
  assert.match(body.slice(guardAt, enqueueAt), /code\(403\)/, 'an unapproved group is a 403');
});

test('the platform never manages group membership', () => {
  // Bulk-adding people to a group is both a top-tier ban signal and a consent failure: a
  // parent who gave a number for fee reminders did not agree to be placed where two
  // hundred strangers can see it. People join by invite link, which is not ours to send.
  const code = codeOf('core/src/notify/whatsapp.ts') + codeOf('core/src/store/whatsapp.ts');
  for (const forbidden of ['/participants', 'promote', 'demote', '/leave', 'addParticipants']) {
    assert.ok(!code.includes(forbidden), `the platform must never call ${forbidden}`);
  }
});

test('a group test is still approval-gated and still spends the group budget', () => {
  // "The admin asked" is not a reason to skip the one check that decides which groups
  // this platform may write to — the id still arrives in a request body.
  const code = codeOf('core/src/notify/whatsapp.ts');
  const fn = code.slice(code.indexOf('export async function sendTestToGroup'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /isApprovedGroup\(groupId\)/, 'an unapproved group must be refused');

  // A test bypasses the QUEUE, not the BUDGET. It is a real message from the real number,
  // so repeatedly pressing the button must not be a way to send unpaced traffic.
  const helper = code.slice(code.indexOf('async function sendTestTo('));
  assert.match(helper.slice(0, helper.indexOf('\n}\n')), /groupSentAt : sentAt\)\.push/, 'it must count against a cap');
});
