// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Everything an inbound message must survive before any command is considered.
 *
 * This is the security boundary for a channel that can stop and update a masjid's
 * apps, on a daemon running as root with the Docker socket, authenticated by nothing
 * stronger than possession of a phone. Order matters and is asserted in the tests.
 *
 * Pure: `now` and the connection time are injected, nothing here does I/O beyond
 * reading the (already in-memory) config, so every rule below is unit-testable.
 */
import crypto from 'node:crypto';
import { authoriseSender, areCommandsEnabled, COMMAND_PREFIX, type CommandPerson } from '../store/commands';
import { normaliseInbound, type InboundMessage } from './normalise';
import { shouldNoticeThrottle, takeToken, touch } from './conversation';

/** Backlog replays land in the moments after a socket comes up. Nobody types a
 *  command in the same three seconds, so this costs a real admin nothing. */
export const REPLAY_QUIET_MS = 3_000;
/** A reconnect after a six-hour outage must not run this morning's `!os restart`. */
export const MAX_AGE_MS = 120_000;
/** Future-dating is clock skew or forgery; a little slack for the former. */
const FUTURE_SKEW_MS = 60_000;
const MAX_BODY_CHARS = 512;
const DEDUPE_MAX = 512;
const DEDUPE_TTL_MS = 10 * 60_000;
/** Types we will read as text. Absent is allowed — many gateways omit it entirely. */
const TEXT_TYPES = new Set(['chat', 'text', 'extendedtext', 'extendedtextmessage', 'conversation']);

/**
 * Why a message was discarded.
 *
 * Two of these carry the chat's address SHAPE in brackets — `not-direct(lid)`,
 * `no-sender-number(lid)`. The bare words were ambiguous on a real install: they said
 * a message had been rejected without saying whether the problem was the chat, the
 * address space, or a missing identity, and those have three different fixes. The
 * shape is the domain half of a JID; it is never a number.
 */
export type DropReason =
  | 'commands-off'
  | 'unparseable'
  | 'from-me'
  | 'not-direct'
  | `not-direct(${string})`
  | `no-sender-number(${string})`
  | 'not-text'
  | 'empty'
  | 'too-long'
  | 'replay-window'
  | 'stale'
  | 'future'
  | 'unknown-sender'
  | 'duplicate'
  | 'no-prefix'
  | 'rate-limited';

export type GateOutcome =
  | { pass: true; person: CommandPerson; msg: InboundMessage; digits: string }
  /** `notice` is set ONLY for 'rate-limited' — the one drop that may answer. */
  | { pass: false; drop: DropReason; notice?: boolean; keys?: string[]; digits?: string };

export interface GateContext {
  now: number;
  /** When the current socket connected, for the replay quiet window. */
  connectedAt: number;
}

// ── duplicate suppression ────────────────────────────────────────────────────────
// At-least-once delivery, a reconnect replay, and a gateway that emits both `message`
// and `message_create` all mean the same command can arrive twice. Deliberately
// AFTER the whitelist check: if a stranger's flood could fill this, it would evict
// the very entries that stop a real command running twice.
const seen = new Map<string, number>();

function isDuplicate(key: string, now: number): boolean {
  for (const [k, t] of seen) if (now - t > DEDUPE_TTL_MS) seen.delete(k);
  if (seen.has(key)) return true;
  if (seen.size >= DEDUPE_MAX) {
    const oldest = [...seen.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest) seen.delete(oldest[0]);
  }
  seen.set(key, now);
  return false;
}

export function __resetGateForTests(): void {
  seen.clear();
}

export function gate(args: unknown[], ctx: GateContext): GateOutcome {
  // 1. Re-read the master switch per message: turning it off must stop execution NOW,
  //    not at the next supervisor tick.
  if (!areCommandsEnabled()) return { pass: false, drop: 'commands-off' };

  // 2. A message we cannot read cannot be authorised.
  const parsed = normaliseInbound(args);
  if (!parsed.ok) return { pass: false, drop: 'unparseable', keys: parsed.keys };
  return gateMessage(parsed.msg, ctx);
}

/**
 * The checks, against an already-normalised message.
 *
 * Split out so a caller can enrich the message first — specifically, resolve a `@lid`
 * sender to a phone number over the gateway's REST lookup, which is async while this
 * is not. It must happen BEFORE the gate rather than as a retry: steps 11 and 13 have
 * side effects (the duplicate LRU, the rate-limit bucket), so running the gate twice
 * for one message would double-count both.
 */
export function gateMessage(msg: InboundMessage, ctx: GateContext): GateOutcome {
  if (!areCommandsEnabled()) return { pass: false, drop: 'commands-off' };

  // 3. Our own sends echo back; a reply containing a command would loop forever.
  if (msg.fromMe) return { pass: false, drop: 'from-me' };

  // 4. One-to-one only. A command in a group would hand the restart button to every
  //    member of a 200-person announcement group.
  if (!msg.isDirect) return { pass: false, drop: `not-direct(${msg.shape})` as DropReason };

  // 4b. Direct, but we cannot say WHO from. A `@lid` privacy id carries no phone
  //     number, so unless the gateway resolves it (RESOLVE_LID_TO_PHONE) there is no
  //     identity to check against the list — and an unidentifiable sender must never
  //     be authorised. Reported separately from 'not-direct' because the fix is
  //     completely different: this one is a gateway setting, not a wrong chat.
  if (!msg.fromDigits) return { pass: false, drop: `no-sender-number(${msg.shape})` as DropReason };

  // 5. Text only. An image caption is a plausible place to hide `!os stop x`.
  if (msg.hasMedia) return { pass: false, drop: 'not-text' };
  if (msg.type && !TEXT_TYPES.has(msg.type.toLowerCase().replace(/[^a-z]/g, ''))) {
    return { pass: false, drop: 'not-text' };
  }

  const body = msg.body.trim();
  if (!body) return { pass: false, drop: 'empty' };
  if (body.length > MAX_BODY_CHARS) return { pass: false, drop: 'too-long', digits: msg.fromDigits };

  // 7. The replay quiet window.
  if (ctx.now - ctx.connectedAt < REPLAY_QUIET_MS) return { pass: false, drop: 'replay-window' };

  // 8. Age. A timestamp-less message is only trusted once the socket has been up
  //    longer than the staleness window — past that point, no backlog can be arriving.
  if (msg.timestampMs != null) {
    if (msg.timestampMs > ctx.now + FUTURE_SKEW_MS) return { pass: false, drop: 'future' };
    if (ctx.now - msg.timestampMs > MAX_AGE_MS) return { pass: false, drop: 'stale' };
  } else if (ctx.now - ctx.connectedAt < MAX_AGE_MS) {
    return { pass: false, drop: 'stale' };
  }

  // 9/10. THE authorisation check. A non-whitelisted sender gets SILENCE: a reply
  //       confirms to a stranger that this number runs a masjid's server, spends the
  //       budget fee reminders need, and replying to unknown numbers is the strongest
  //       spam signal this account can emit. The caller logs it only if it looked like
  //       a deliberate command attempt.
  const person = authoriseSender(msg.fromDigits);
  if (!person) return { pass: false, drop: 'unknown-sender', digits: msg.fromDigits };

  // 11. Duplicate suppression, recorded before execution and kept regardless of
  //     outcome. Without an id we key on the content so a redelivery still collides.
  const key = msg.id
    ? `id:${msg.id}`
    : `h:${crypto.createHash('sha256').update(`${msg.chatId}|${msg.timestampMs ?? 0}|${body}`).digest('hex').slice(0, 32)}`;
  if (isDuplicate(key, ctx.now)) return { pass: false, drop: 'duplicate', digits: msg.fromDigits };

  touch(msg.fromDigits, ctx.now);

  // 12. The prefix. MUST come before the rate limiter: otherwise an admin having an
  //     ordinary conversation with the masjid's number drains their own bucket and is
  //     then told "too many commands" — and ordinary chat would be metered at all,
  //     which it must not be.
  if (!body.startsWith(COMMAND_PREFIX)) return { pass: false, drop: 'no-prefix', digits: msg.fromDigits };

  // 13. Per-sender rate limit. Only command ATTEMPTS are metered.
  if (!takeToken(msg.fromDigits, ctx.now)) {
    return {
      pass: false,
      drop: 'rate-limited',
      digits: msg.fromDigits,
      // The one drop that may answer: the sender IS authorised, and silence here
      // reads as the feature being broken.
      notice: shouldNoticeThrottle(msg.fromDigits, ctx.now),
    };
  }

  return { pass: true, person, msg: { ...msg, body }, digits: msg.fromDigits };
}
