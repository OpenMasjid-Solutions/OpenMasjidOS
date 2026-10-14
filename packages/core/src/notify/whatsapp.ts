// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * WhatsApp sending, via a self-hosted OpenWA gateway.
 *
 * ── WHY THIS IS A QUEUE, AND WHY THE PLATFORM OWNS IT ───────────────────────────
 *
 * OpenWA is an UNOFFICIAL WhatsApp client. Its own README is unambiguous: there is a
 * real, non-zero chance of the linked number being restricted or banned, and the way
 * to reduce it is to behave like a person rather than a program. That is a property of
 * the NUMBER, not of any one caller — so it cannot be enforced per app.
 *
 * If the students app and a donations app each send "politely" at the same moment, the
 * number still emits a burst; WhatsApp sees a phone number, not our request
 * boundaries. So every message the whole platform sends — OS alerts and every app's
 * Fabric call alike — goes through the ONE serialised queue below, one at a time. The
 * only sends beside it are the admin's own (`sendImmediate`: the test button and command
 * replies), each an answer to something the admin just did.
 *
 * This is also why we do NOT use OpenWA's `POST .../messages/send-bulk`. It paces
 * within a single request (3s default + jitter), which is fine in isolation and useless
 * across callers: two bulk requests still overlap. One queue is the only place the
 * real constraint can live.
 *
 * ── WHAT "HUMAN SENDING BEHAVIOUR" MEANS HERE ──────────────────────────────────
 *
 * READ THIS LIST AS THE CURRENT CONTRACT. It was written when the pacer had a full set
 * of brakes; almost all of them have since been removed at the maintainer's direction,
 * and for a while this header still advertised four that no longer existed — which is
 * the most dangerous kind of stale comment, because it is the first thing anyone reads
 * before deciding whether a change here is safe.
 *
 *  1. **Serialised.** The queue sends one message at a time, whoever asked. This is the
 *     one that still carries real weight: ban risk attaches to the NUMBER, so two callers
 *     each sending "politely" at once is still a burst.
 *  2. **Typing indicator**, for a duration scaled to the message length (people take
 *     longer over longer messages), then `paused`, then the send. With everything below
 *     gone, this is now the ONLY delay between two messages — a few seconds.
 *  3. **Presence.** Appear online while working, offline once idle. A number that is
 *     permanently online and never reads anything looks like what it is.
 *  4. **Validate before first contact.** `contacts/check` confirms the number is on
 *     WhatsApp. Sending to numbers that aren't is a documented ban signal.
 *  5. **Bounded retry** with widening backoff on a transient failure, and a per-item
 *     `notBefore` so one failing message never stalls the queue behind it.
 *  6. **Never auth-critical.** This queues; it does not deliver. Callers are told so.
 *
 * ── WHAT IS GONE, AND MUST NOT BE ASSUMED ──────────────────────────────────────
 *
 * There is **no inter-message gap**, **no per-recipient or per-group cooldown**, **no
 * hourly or daily cap** (individual or group), **no warm-up ramp**, and **no
 * time-of-day hold**. `blockedReason` returns `null` unconditionally; `capExceeded`,
 * `warmupFactor` and `nextGapMs` are inert and kept only for the reasoning written
 * beside them, plus tests that assert their absence.
 *
 * So NOTHING here limits how much an app sends. An app looping over a 200-family roster
 * sends 200 messages, back to back, as fast as the typing indicator allows. That
 * residual risk is ACCEPTED, not overlooked (CLAUDE.md §13.2b-ii) — the callers bound
 * their own volume. If a ceiling is ever wanted again it belongs HERE, on the shared
 * queue, never per-app: an app-level limiter cannot see the number's total traffic,
 * which is the only figure WhatsApp cares about.
 *
 * None of this makes a ban impossible, and the module must not pretend otherwise —
 * `docs/WHATSAPP.md` states the residual risk plainly for the admin.
 */
import crypto from 'node:crypto';
import { log } from '../logger';
import {
  loadQueueState,
  saveQueueState,
  trimOutcomes,
  bankPausedTime,
  effectiveHeldMs,
  MAX_HELD_MS,
  type ItemRef,
  type OutcomeRecord,
  type OutcomeState,
} from './whatsapp-queue-store';
import { chatIdFor, toDigits } from '../util/phone';
import {
  getWhatsAppConfig,
  isWhatsAppConfigured,
  isApprovedGroup,
  type WhatsAppConfig,
  type WhatsAppLimits,
} from '../store/whatsapp';
// The gateway client — everything that only talks to OpenWA — lives in its own module.
import { call, ensureSession, ensureStarted, gatewayStatus, clearGatewayCaches } from './whatsapp-gateway';

/** How long to wait on a send, which may be carrying a 2 MB image out to WhatsApp. */
const SEND_TIMEOUT_MS = 120_000;
/** Cap the queue so a looping app can't grow it without bound. */
const MAX_QUEUE = 500;
/** A text longer than this is refused: WhatsApp's own limit is far higher, but a
 *  multi-thousand-character blast is neither human nor useful. */
const MAX_TEXT = 4096;
/** Retries for a transient failure before the message is dropped (and logged). */
const MAX_ATTEMPTS = 5;

/**
 * Who a message is for.
 *
 * A group is not "a recipient with a funny number": it has its own address space
 * (`@g.us` rather than `@c.us`), only a group the admin approved may be named, and
 * `contacts/check` is meaningless for it. Making the distinction a type rather than a
 * string test means every place that treats the two differently has to say so.
 */
export type Target = { kind: 'person'; digits: string } | { kind: 'group'; groupId: string };

/**
 * An image to send with the message. Images only, deliberately.
 *
 * `send-image` is the gateway route this maps to, and handing it a PDF would fail at the
 * gateway rather than here. Documents, video and audio are each a different route with
 * different rules (a document REQUIRES a filename; audio has a voice-note format that
 * silently produces an unplayable bubble if you get it wrong), so they are separate
 * decisions rather than something that falls out of a permissive mime check.
 */
export interface OutgoingMedia {
  /** Base64 of the image bytes. No `data:` prefix. */
  data: string;
  /** `image/png`, `image/jpeg` or `image/webp`. */
  mimeType: string;
  /** Optional; shown by some clients when the image is saved. */
  filename?: string;
}

/** What we will put in front of WhatsApp. Anything else is refused before queueing. */
const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
/** Decoded image bytes. A 1080×1350 poster is 150–400 KB, so this is ~5× headroom. */
export const MAX_MEDIA_BYTES = 2 * 1024 * 1024;
/** OpenWA's own limit on a media caption. Enforced here so it fails at the door with a
 *  clear message rather than as a gateway 400 after the app was told 202. */
export const MAX_CAPTION = 1024;
/**
 * How many image messages may sit in the queue at once.
 *
 * A queued image is held in memory until it goes, and an outage can hold it for days — on a
 * Raspberry Pi that matters. Four at the 2 MB cap is ~11 MB held worst case (base64 is 4/3
 * the bytes). Beyond that an app is REFUSED with a clear message rather than the platform
 * quietly growing; a refusal it can retry is better than an out-of-memory kill that takes
 * the masjid's whole dashboard with it.
 */
export const MAX_QUEUED_MEDIA = 4;

export interface SendRequest {
  /** Recipient in international format. Punctuation is tolerated and stripped. */
  to?: string;
  /** …or an APPROVED group's JID. Exactly one of `to` / `groupId`. */
  groupId?: string;
  /** The message, or the image's CAPTION when `media` is present. */
  text?: string;
  /** Optional image. With it, `text` becomes the caption and may be omitted. */
  media?: OutgoingMedia;
  /** Who asked — an app id, or 'os' for platform alerts. Logged, never sent. */
  source: string;
}

interface QueueItem {
  /** Opaque handle returned to the caller, so it can ask what happened later. */
  id: string;
  text: string;
  source: string;
  target: Target;
  media?: OutgoingMedia;
  enqueuedAt: number;
  /** Transient-failure retries so far. */
  attempts: number;
  /**
   * Earliest time this item may be tried again after a transient failure.
   *
   * Per-ITEM rather than a sleep in the pump loop, because sleeping the loop is a
   * head-of-line block: one failing message would hold up every other app for its whole
   * backoff. Now it steps aside and the rest of the queue keeps moving.
   */
  notBefore?: number;
}

/**
 * Decoded size of a base64 string, and whether it is base64 at all.
 *
 * Computed from the length rather than by decoding: the string is already the largest
 * thing in the request, and materialising a second copy just to measure it is exactly the
 * wrong move on a Pi. Returns null when the input is not valid base64 — better caught
 * here than as a gateway error after the caller was told 202.
 */
export function base64Bytes(s: string): number | null {
  if (typeof s !== 'string' || s.length === 0 || s.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  const padding = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return (s.length / 4) * 3 - padding;
}

/** Why this image cannot be sent, or null if it can. Pure, so it is testable directly. */
export function mediaProblem(m: OutgoingMedia): string | null {
  const mime = String(m?.mimeType ?? '').toLowerCase().trim();
  if (!ALLOWED_IMAGE_MIME.has(mime)) {
    return `Only images are supported (${[...ALLOWED_IMAGE_MIME].join(', ')}).`;
  }
  const bytes = base64Bytes(String(m?.data ?? ''));
  if (bytes === null) return 'The image data is not valid base64.';
  if (bytes === 0) return 'The image is empty.';
  if (bytes > MAX_MEDIA_BYTES) {
    return `That image is ${Math.round(bytes / 1024)} KB; the limit is ${MAX_MEDIA_BYTES / 1024 / 1024} MB.`;
  }
  if (m.filename !== undefined && (typeof m.filename !== 'string' || m.filename.length > 255)) {
    return 'The filename is too long (max 255 characters).';
  }
  return null;
}

/** The key the send history records a target under. A person and a group can never
 *  collide (`@g.us` cannot appear in a digits-only string). */
function targetKey(t: Target): string {
  return t.kind === 'person' ? t.digits : `group:${t.groupId}`;
}

/** Outcome of a single attempt, for the caller's log and the admin's status panel. */
export interface SendOutcome {
  ok: boolean;
  /** Present when the gateway refused or was unreachable. Never includes the body. */
  error?: string;
  /**
   * True when the failure is worth retrying: rate limiting, a 5xx, or a network error —
   * but not a send that timed out, which may have gone (see `sendOne`). FALSE for a refusal
   * that will never succeed (a malformed request, a number that is not on WhatsApp) —
   * retrying those is only more traffic from the number, for nothing.
   */
  retryable?: boolean;
}

/**
 * Is an HTTP status worth trying again?
 *
 * 429 is the important one. OpenMasjidOS is the single governor of this number (the
 * gateway app ships with upstream's own pacer disabled so there is exactly one), but a
 * 429 can still arrive — a shared gateway, a hand-tuned limit, WhatsApp itself pushing
 * back. Treating it as a permanent failure discarded the message, which is the worst
 * possible reading of 'slow down'.
 */
export function isRetryableStatus(status: number): boolean {
  if (status === 0) return true; // network error / timeout — never the message's fault
  if (status === 429) return true; // slow down, not no
  if (status >= 500) return true; // gateway restarting, engine reloading
  return false; // 4xx: malformed, unauthorised, unknown session — retrying cannot help
}

// ── phone numbers ────────────────────────────────────────────────────────────────

/**
 * `toDigits` (never guesses a country code) and `chatIdFor` now live in
 * `util/phone.ts`, so a store can canonicalise a number without importing the sender.
 * Re-exported here because this is where the rest of the platform has always found
 * them.
 */
export { toDigits, chatIdFor };

/** The chat id for a target — the one place the two address spaces are resolved. */
export function chatIdOf(t: Target): string {
  return t.kind === 'person' ? chatIdFor(t.digits) : t.groupId;
}

/**
 * Is this number registered on WhatsApp? Cached, because the answer rarely changes and
 * the check itself is traffic. `null` = could not tell, which must NOT be treated as
 * "no" (that would silently stop all sending when the gateway hiccups).
 */
/**
 * Cached `contacts/check` answers, with the bounds a permanent cache was missing.
 *
 * A bare `Map<string, boolean>` kept a NEGATIVE answer for the life of the process, so a
 * family that joined WhatsApp after their first receipt bounced was refused for ever —
 * and since a masjid restarts rarely, "for ever" is the operative word. It was also
 * unbounded: one entry per distinct recipient, and a school-fees app messaging a few
 * hundred families every month never gives any of them back.
 *
 * A positive answer keeps indefinitely (numbers essentially do not deregister) but is
 * still subject to the size cap; a negative one expires, because it is the answer that
 * can become wrong.
 */
const onWhatsApp = new Map<string, { yes: boolean; at: number }>();
const CONTACT_CACHE_MAX = 2000;
const CONTACT_NEGATIVE_TTL_MS = 24 * 60 * 60_000;

/** Cached answer, or undefined when we should ask again. */
function cachedRegistration(digits: string, now: number): boolean | undefined {
  const hit = onWhatsApp.get(digits);
  if (!hit) return undefined;
  if (!hit.yes && now - hit.at > CONTACT_NEGATIVE_TTL_MS) {
    onWhatsApp.delete(digits);
    return undefined;
  }
  return hit.yes;
}

function rememberRegistration(digits: string, yes: boolean, now: number): void {
  // Map iterates in insertion order, so the first key is the oldest write.
  if (onWhatsApp.size >= CONTACT_CACHE_MAX) {
    const oldest = onWhatsApp.keys().next();
    if (!oldest.done) onWhatsApp.delete(oldest.value);
  }
  onWhatsApp.set(digits, { yes, at: now });
}

async function checkRegistered(cfg: WhatsAppConfig, digits: string): Promise<boolean | null> {
  const now = Date.now();
  const cached = cachedRegistration(digits, now);
  if (cached !== undefined) return cached;
  const r = await call(cfg, 'GET', `/api/sessions/${encodeURIComponent(cfg.sessionId)}/contacts/check/${digits}`);
  // A check that could not answer proceeds, and decides nothing: "could not ask" is not a
  // dead link (CLAUDE.md §13.2d), so it is not counted as evidence of one either.
  if (!r.ok) return null;
  const j = r.json as { exists?: unknown; isRegistered?: unknown; registered?: unknown; numberExists?: unknown } | null;
  const yes = j?.exists ?? j?.isRegistered ?? j?.registered ?? j?.numberExists;
  if (typeof yes !== 'boolean') return null;
  rememberRegistration(digits, yes, now);
  return yes;
}

// ── pacing ───────────────────────────────────────────────────────────────────────
//
// What this number sent in the last day, persisted with the queue. A RECORD, not an
// allowance: nothing brakes on it any more (see the header). It is what a ceiling would be
// built on if one ever returns, so it is kept — and kept to a day, like any record of who
// the masjid messaged.

/** Individual sends within the last rolling day, newest last. */
const sentAt: number[] = [];
/** Group posts within the last rolling day — apart from `sentAt`, because one reaches everyone. */
const groupSentAt: number[] = [];
/** target key → its last send within the last rolling day. */
const lastToRecipient = new Map<string, number>();

function prune(now: number): void {
  const dayAgo = now - 86_400_000;
  while (sentAt.length > 0 && sentAt[0]! < dayAgo) sentAt.shift();
  while (groupSentAt.length > 0 && groupSentAt[0]! < dayAgo) groupSentAt.shift();
  // It names the people messaged, so it must not outlive the day the arrays above keep.
  for (const [key, at] of lastToRecipient) if (at < dayAgo) lastToRecipient.delete(key);
}

/**
 * The warm-up multiplier. INERT: the ramp it fed is gone and nothing calls this; it is
 * kept for the reasoning and its tests. A number linked today got a quarter of the
 * allowance; by the end of the ramp, all of it. 1 when the link date is unknown.
 */
export function warmupFactor(linkedAt: string | null, limits: WhatsAppLimits, now: number): number {
  if (!linkedAt || limits.warmupDays <= 0) return 1;
  const started = Date.parse(linkedAt);
  if (!Number.isFinite(started)) return 1;
  const days = (now - started) / 86_400_000;
  if (days >= limits.warmupDays) return 1;
  if (days < 0) return 1; // clock skew; don't punish
  const third = limits.warmupDays / 3;
  if (days < third) return 0.25;
  if (days < third * 2) return 0.5;
  return 0.75;
}

// `inQuietHours` used to live here and is deliberately gone. Two independent reasons, and
// the second one is why it was actively harmful rather than merely debatable:
//
//   1. It applied to EVERY message on the queue, and the queue is shared by the OS and
//      every installed app. There is no per-message urgency flag, so an app had no way to
//      say "this one must not wait". A parent's receipt held until morning is fine; a
//      staff alert about a declined card or an autopay that switched itself off, held
//      until morning, removes the whole reason a treasurer carries a phone.
//   2. It was evaluated against `new Date().getHours()` — the CONTAINER's clock. Nothing
//      sets `TZ` (not the compose file, not the Dockerfile, not the installer), so that is
//      UTC. The documented "21:00-07:00" window therefore landed at 17:00-03:00 for a US
//      Eastern masjid, swallowing the entire evening: a test sent at 6pm local was held.
//
// Per-recipient quiet time is a real want, but it belongs with the SENDER, which knows
// whether it is messaging a parent or a treasurer. This pacer deliberately knows nothing
// about who a recipient is, so it is the wrong place to make that judgement.

/**
 * Where an hourly or daily ceiling would be decided, if one is ever reinstated. INERT: it
 * always answers null, and its only caller is `blockedReason`.
 */
export function capExceeded(
  now: number,
  target: Target,
  limits: WhatsAppLimits,
  linkedAt: string | null,
  history: { sends: number[]; groupSends: number[] },
): 'hour' | 'day' | null {
  // INDIVIDUAL messages are deliberately uncapped, removed at the maintainer's decision
  // after the caps repeatedly blocked ordinary use — with the warm-up ramp they came to
  // 3/hour on a freshly linked number, which is unusable even for testing, and a masjid
  // messaging parents one at a time is not the threat the caps were written for.
  //
  // Known trade-off, recorded because it is not the admin's mistake if it bites: the queue
  // is shared, so an app looping over 200 parents will now send all 200, back to back, as
  // fast as the typing indicator allows. Ban risk attaches to the NUMBER and a ban is
  // terminal, so if this proves too loose the fix is a cap here, not a per-app one — a
  // per-app limiter cannot see the number's total traffic.
  // GROUP caps are gone too, at the maintainer's decision, and they were the LAST thing
  // that could hold a message for an hour with nothing telling the sender why. 4/hour and
  // 10/day, quartered by the warm-up ramp to as little as 1/hour on a recently linked
  // number — and a group image was exactly the case that hit it.
  //
  // The argument for keeping them was real and is recorded here rather than lost: a group
  // message reaches every member, so overuse costs two hundred recipients who did not
  // choose it, which is not the same as an over-eager fee run costing the sender. That
  // argument lost to a simpler one — an announcement that might arrive in an hour, or might
  // not, is not usable, and unpredictability was doing more damage than the cap prevented.
  //
  // `history` and the two `sends` arrays are still MAINTAINED (see `pump`), so the traffic
  // record exists for anything that wants it later. Nothing consults it as a brake.
  void now;
  void target;
  void limits;
  void linkedAt;
  void history;
  return null;
}

/**
 * Why the next send cannot happen yet, or null if it can. Pure so the whole policy is
 * testable without a gateway, a clock or a network.
 */
export function blockedReason(
  now: number,
  target: Target,
  limits: WhatsAppLimits,
  linkedAt: string | null,
  history: { sends: number[]; groupSends: number[]; lastPerRecipient: Map<string, number> },
): string | null {
  // NOTE: no time-of-day term. This function is deliberately clock-agnostic beyond `now`
  // as an instant — see the note where `inQuietHours` used to be. Nothing here may depend
  // on the local hour, because "local" is the container's timezone and that is UTC.
  const isGroup = target.kind === 'group';
  const over = capExceeded(now, target, limits, linkedAt, history);
  if (over === 'hour') return isGroup ? 'hourly group limit reached' : 'hourly limit reached';
  if (over === 'day') return isGroup ? 'daily group limit reached' : 'daily limit reached';

  // The per-recipient (60s) and per-group (30 MINUTE) cooldowns were removed at the
  // maintainer's decision. They were the single largest cause of "my message never arrived":
  // a group could not be posted to for half an hour after the previous post, and combined
  // with the head-of-line bug that used to be in `pump` one group image could hold up every
  // other app's messages for that entire window.
  //
  // `lastToRecipient` is still WRITTEN, deliberately. It is pruned to a day, and it is what
  // any future per-recipient policy would need. Nothing READS it as a brake any more.
  return null;
}

/**
 * Minimum "typing" time for an image.
 *
 * `typingMs` scales with the text, so a poster with a six-word caption would show a
 * ~2-second flicker before a half-megabyte upload appears — which reads as automated,
 * not human. Someone sending a picture spends time picking and attaching it.
 */
const MEDIA_COMPOSING_FLOOR_MS = 5000;

/** How long to appear busy before this particular message goes out. */
export function composingMs(item: { text: string; media?: unknown }): number {
  const base = typingMs(item.text);
  return item.media ? Math.max(base, MEDIA_COMPOSING_FLOOR_MS) : base;
}

/** How long to show "typing" for a message of this length. */
export function typingMs(text: string): number {
  // ~12 characters a second with a floor, capped so a long notice doesn't stall the
  // queue for a minute. Human-ish, not a simulation.
  return Math.min(8000, 1500 + Math.round((text.length / 12) * 1000));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The randomised inter-message gap. Exposed so a test can assert the spread. */
export function nextGapMs(limits: WhatsAppLimits, rand = Math.random): number {
  return (limits.minGapSeconds + rand() * limits.jitterSeconds) * 1000;
}

// ── the queue ────────────────────────────────────────────────────────────────────

const queue: QueueItem[] = [];
let running = false;

/**
 * The queue is holding everything until an admin releases it.
 *
 * Set ONLY by the health monitor on a confirmed lost link, and cleared only by an explicit
 * release. Deliberately not cleared when the session comes back: after an outage the
 * backlog is exactly the thing that must not go out on its own, because a freshly relinked
 * number sending a two-day queue back to back is the clearest ban signal there is.
 */
let paused = false;
let pausedSince: number | null = null;

/**
 * Evidence from the SEND path that the link is dead, for the health monitor to read.
 *
 * The monitor's own probe is the primary detector, but only the sender sees a run of
 * 401/403s: each is classed non-retryable, so the message is dropped after one attempt
 * with a single log line. That should not be the last anyone hears of it.
 */
const sendSignals = { authFailures: 0, lastAuthFailAt: 0 };
let presenceOn = false;
/** What the pump is waiting on, so the log says it once rather than every minute. */
let waitingFor: string | null = null;

/**
 * Recent per-message outcomes, so an app can find out what became of a `202`.
 *
 * Bounded and persisted alongside the queue. Deliberately holds NO message text and no
 * recipient — an app polls by the id it was given, and `whatsappOutcome` refuses a record
 * belonging to another app, so this cannot become a way to read someone else's traffic.
 */
const outcomes: OutcomeRecord[] = [];

/** Persist queue + send history + outcomes. Called after every mutation. */
function persist(): void {
  saveQueueState({
    queue,
    sends: sentAt,
    groupSends: groupSentAt,
    lastPerRecipient: lastToRecipient,
    outcomes,
    paused,
    pausedSince,
  });
}

function noteOutcome(item: ItemRef, state: OutcomeState, reason?: string): void {
  const existing = outcomes.find((o) => o.id === item.id);
  if (existing) {
    existing.state = state;
    existing.reason = reason;
    existing.at = Date.now();
  } else {
    outcomes.push({
      id: item.id,
      source: item.source,
      state,
      reason,
      at: Date.now(),
      targetKind: item.target.kind,
    });
    // Per-source + age bounded. NOT a global `shift()`: that let the app which sends most
    // evict every other app's records — a 200-family billing run wiped the whole ring.
    const trimmed = trimOutcomes(outcomes, Date.now());
    if (trimmed.length !== outcomes.length) outcomes.splice(0, outcomes.length, ...trimmed);
  }
}

/**
 * What happened to a message, for the app that sent it.
 *
 * Scoped to the caller's own `source`: without that check an app could enumerate ids and
 * learn when another app messaged someone, which is the sort of cross-app leak the Fabric
 * exists to prevent. An unknown id and someone else's id are the same answer, on purpose.
 */
export function whatsappOutcome(id: string, source: string): OutcomeRecord | null {
  const rec = outcomes.find((o) => o.id === id);
  return rec && rec.source === source ? rec : null;
}

/**
 * Restore the queue written by the previous run.
 *
 * Called once at boot. Without it, anything the pacer was holding when the container
 * stopped is silently destroyed — which is exactly the bug this whole store exists to fix,
 * and it presented as "accepted, never delivered, no error, for over 24 hours".
 */
export function restoreWhatsAppQueue(now = Date.now()): { restored: number; expired: number } {
  const state = loadQueueState(now);
  queue.length = 0;
  for (const item of state.queue) queue.push(item as QueueItem);
  sentAt.length = 0;
  sentAt.push(...state.sends);
  groupSentAt.length = 0;
  groupSentAt.push(...state.groupSends);
  lastToRecipient.clear();
  for (const [k, v] of state.lastPerRecipient) lastToRecipient.set(k, v);
  outcomes.length = 0;
  outcomes.push(...state.outcomes);
  // An outage outlives a restart. Forgetting the pause here would drain the whole backlog
  // at boot, which is precisely the burst the pause exists to prevent.
  paused = state.paused;
  pausedSince = state.pausedSince;

  // Anything held longer than a day is not sent. Recorded as an outcome rather than
  // vanishing, so an app that asks gets a real answer instead of silence.
  noteExpired(state.expired);
  // An image is kept in a file of its own; one that cannot be read back (a restore put an
  // older config/ in place, say) fails that message alone.
  const damaged = queue.filter((item) => item.media && mediaProblem(item.media));
  const unreadable: ItemRef[] = [...state.lost, ...damaged];
  for (const item of unreadable) {
    noteOutcome(item, 'failed', 'Its image could not be read back after a restart, so it was not sent.');
  }
  if (unreadable.length > 0) {
    log.warn(`WhatsApp: ${unreadable.length} queued image(s) could not be read back after a restart; not sent.`);
    queue.splice(0, queue.length, ...queue.filter((item) => !damaged.includes(item)));
  }
  if (queue.length > 0) {
    log.info(`WhatsApp: restored ${queue.length} queued message(s) from the previous run.`);
    if (paused) {
      log.warn(
        `WhatsApp: the queue is PAUSED (the link was lost); ${queue.length} message(s) are held ` +
          'and will not send until an admin releases them in Settings.',
      );
    } else {
      void pump();
    }
  }
  if (state.expired.length > 0 || unreadable.length > 0 || queue.length > 0) persist();
  return { restored: queue.length, expired: state.expired.length };
}

const HELD_TOO_LONG = 'It waited more than 24 hours of working connection, so it was not sent.';

/** Record messages dropped for waiting longer than `MAX_HELD_MS`. */
function noteExpired(items: ItemRef[]): void {
  if (items.length === 0) return;
  for (const item of items) noteOutcome(item, 'expired', HELD_TOO_LONG);
  log.warn(
    `WhatsApp: dropped ${items.length} message(s) held longer than ` +
      `${Math.round(MAX_HELD_MS / 3_600_000)}h — releasing a backlog at once is what gets a number restricted.`,
  );
}

/**
 * The same bound while the core stays up. Checked only at boot, it let a core that ran
 * through a long gateway outage send the whole backlog back to back once the gateway
 * returned. Only called while the queue runs, so no pause is in progress.
 */
function expireHeldTooLong(now: number): void {
  const stale = queue.filter((item) => effectiveHeldMs(item, now, null) > MAX_HELD_MS);
  if (stale.length === 0) return;
  noteExpired(stale);
  queue.splice(0, queue.length, ...queue.filter((item) => !stale.includes(item)));
  persist();
}

export function queueDepth(): number {
  return queue.length;
}

/** Evidence the SEND path has gathered that the link may be dead. Read by the monitor. */
export function sendPathSignals(): { authFailures: number; lastAuthFailAt: number } {
  return { ...sendSignals };
}

export function isQueuePaused(): boolean {
  return paused;
}

/**
 * Hold everything. Called by the health monitor once a lost link is CONFIRMED.
 *
 * Idempotent, and it does not touch the messages themselves -- they stay on the queue with
 * their bodies, which is what makes a later resend possible at all. Outcome records hold no
 * body and no recipient by design, so the live queue is the only re-sendable state there is.
 */
export function pauseQueue(reason: string): void {
  if (paused) return;
  paused = true;
  pausedSince = Date.now();
  persist();
  log.warn(`WhatsApp: queue PAUSED (${reason}); ${queue.length} message(s) held.`);
}

/**
 * Release the hold and start sending again. Only ever from an explicit admin action.
 *
 * Banks the paused time first so the 24h bound counts only working connection -- otherwise
 * releasing a two-day backlog would immediately expire all of it.
 */
export function releaseQueue(): { released: number } {
  const held = queue.length;
  if (paused) {
    bankPausedTime(queue, Date.now(), pausedSince);
    paused = false;
    pausedSince = null;
    persist();
    log.info(`WhatsApp: queue released by an admin; sending ${held} held message(s).`);
    void pump();
  }
  return { released: held };
}

/** Throw the held messages away, recording each one so an app that asks gets a real
 *  answer rather than the 404 an unknown id produces. */
export function discardHeldMessages(): { discarded: number } {
  const n = queue.length;
  // Settings offers Discard whenever anything is waiting, not only during an outage.
  const reason = paused
    ? 'It was discarded by an admin after the WhatsApp link was lost.'
    : 'It was discarded by an admin before it was sent.';
  for (const item of queue) {
    noteOutcome(item, 'failed', reason);
  }
  queue.length = 0;
  if (paused) {
    paused = false;
    pausedSince = null;
  }
  persist();
  if (n > 0) log.warn(`WhatsApp: ${n} held message(s) discarded by an admin.`);
  return { discarded: n };
}

/**
 * What is being held, for the admin. COUNTS AND APP IDS ONLY.
 *
 * No body and no recipient leaves the server here. The queue holds both (it has to, to
 * resend), but nothing about showing an admin "14 messages are waiting" requires reading a
 * child's name off a fee reminder, so it does not.
 */
export function heldSummary(): {
  paused: boolean;
  pausedSince: number | null;
  total: number;
  oldest: number | null;
  newest: number | null;
  bySource: { source: string; count: number }[];
} {
  const bySource = new Map<string, number>();
  let oldest: number | null = null;
  let newest: number | null = null;
  for (const item of queue) {
    bySource.set(item.source, (bySource.get(item.source) ?? 0) + 1);
    if (oldest == null || item.enqueuedAt < oldest) oldest = item.enqueuedAt;
    if (newest == null || item.enqueuedAt > newest) newest = item.enqueuedAt;
  }
  return {
    paused,
    pausedSince,
    total: queue.length,
    oldest,
    newest,
    bySource: [...bySource.entries()]
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count),
  };
}

/**
 * Messages reported `sent` inside a window -- the ones that may never have arrived.
 *
 * Between the link dying and the monitor confirming it, sends "succeed": OpenWA accepts
 * them, we mark them sent, and the body is deleted (the item leaves the queue before the
 * outcome is written). Those are unrecoverable HERE by construction, so the honest thing is
 * to say which apps sent how many and when, and let each app decide from its own records.
 */
export function outcomesInWindow(
  from: number,
  to: number,
  source?: string,
): { source: string; count: number; ids: string[]; truncated: boolean }[] {
  // Ids as well as counts, at the Donations app's request: an app keeping a per-message log
  // can then reconcile exactly ("these 9 invoices") rather than approximately ("9 messages
  // somewhere in this 3-hour window"). It costs no extra retention — these ids are already
  // in the outcome ring — but it is capped per source so one roster run cannot make the
  // health file enormous, and the cap is REPORTED rather than silently applied.
  const MAX_IDS = 500;
  const bySource = new Map<string, { count: number; ids: string[] }>();
  for (const o of outcomes) {
    if (o.state !== 'sent' || o.at < from || o.at > to) continue;
    if (source && o.source !== source) continue;
    let e = bySource.get(o.source);
    if (!e) {
      e = { count: 0, ids: [] };
      bySource.set(o.source, e);
    }
    e.count += 1;
    if (e.ids.length < MAX_IDS) e.ids.push(o.id);
  }
  return [...bySource.entries()]
    .map(([s2, e]) => ({ source: s2, count: e.count, ids: e.ids, truncated: e.count > e.ids.length }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Enqueue a message. Returns immediately — this is a QUEUE, not a send. Delivery is
 * seconds away on a healthy link and can be hours or days away on a broken one (a paused
 * queue, a gateway that is down), so nothing auth-critical may depend on it. That contract
 * is stated to apps in `docs/WHATSAPP.md`.
 */
export function enqueue(req: SendRequest): { queued: boolean; error?: string; id?: string } {
  if (!isWhatsAppConfigured()) return { queued: false, error: 'WhatsApp is not set up.' };

  const wantsGroup = Boolean(req.groupId);
  const wantsPerson = Boolean(req.to);
  if (wantsGroup === wantsPerson) {
    return { queued: false, error: 'Send to either a phone number or a group, not both.' };
  }

  let target: Target;
  if (wantsGroup) {
    // The authorisation boundary. An id that has not been approved by the admin never
    // becomes a target, and therefore never reaches a gateway URL — the approved list is
    // the only thing that can name a group here.
    if (!isApprovedGroup(req.groupId)) {
      return { queued: false, error: 'That group has not been approved for sending.' };
    }
    target = { kind: 'group', groupId: req.groupId! };
  } else {
    const digits = toDigits(req.to!);
    if (!digits) return { queued: false, error: 'That phone number needs a country code.' };
    // Messaging the gateway's OWN number is "message yourself" in WhatsApp. Whether the
    // gateway delivers it is not something we can verify, and an alert that lands in the
    // masjid phone's self-chat is not an alert anyone reads — so it is refused at the door
    // with something actionable, rather than accepted and then never seen. This was a real
    // candidate for the "queued but never arrives" reports: an admin testing against the
    // masjid's own number gets no message and no error.
    const linked = getWhatsAppConfig().linkedPhone;
    if (linked && digits === linked) {
      return {
        queued: false,
        error:
          'That is the number WhatsApp is linked to, so the message would only go to that ' +
          'phone’s own notes. Use a different number — an alert has to arrive somewhere ' +
          'someone reads.',
      };
    }
    target = { kind: 'person', digits };
  }

  const text = String(req.text ?? '').trim();
  const media = req.media;

  // With an image, the text is a CAPTION and may be omitted — a poster can speak for
  // itself. Without one, an empty message is nothing at all.
  if (!text && !media) return { queued: false, error: 'The message is empty.' };

  if (media) {
    const problem = mediaProblem(media);
    if (problem) return { queued: false, error: problem };
    // The caption limit is the gateway's, not ours, and it is a quarter of the text
    // limit. Checked here so it fails while the caller is still listening.
    if (text.length > MAX_CAPTION) {
      return { queued: false, error: `The caption is too long (max ${MAX_CAPTION} characters).` };
    }
    const queuedMedia = queue.reduce((n, q) => n + (q.media ? 1 : 0), 0);
    if (queuedMedia >= MAX_QUEUED_MEDIA) {
      return {
        queued: false,
        error: `${MAX_QUEUED_MEDIA} images are already waiting to send. Try again once they have gone out.`,
      };
    }
  } else if (text.length > MAX_TEXT) {
    return { queued: false, error: `The message is too long (max ${MAX_TEXT}).` };
  }

  if (queue.length >= MAX_QUEUE) return { queued: false, error: 'The WhatsApp queue is full. Try again later.' };

  // An id the caller can ask about later. Random rather than sequential so one app cannot
  // guess another's — though `whatsappOutcome` scopes by source regardless.
  const id = crypto.randomUUID();
  const item: QueueItem = { id, text, source: req.source, target, media, enqueuedAt: Date.now(), attempts: 0 };
  queue.push(item);
  noteOutcome(item, 'queued');
  // Persist BEFORE pumping. If the process dies between accepting a message and sending
  // it, the message must already be on disk — persisting afterwards would leave exactly
  // the window this store exists to close.
  persist();
  void pump();
  return { queued: true, id };
}

/**
 * The first item that may go now, or — when none may — the soonest moment one will.
 *
 * The first SENDABLE item, never simply the head. Reading `queue[0]` and waiting on it was
 * a head-of-line block: one message waiting out its backoff held up every app's traffic
 * behind it. A waiting message is DELAYED, never dropped: it stays on the persisted queue
 * and is reconsidered every pass.
 */
function nextSendable(cfg: WhatsAppConfig, now: number): { index: number; wakeAt: number } {
  const history = { sends: sentAt, groupSends: groupSentAt, lastPerRecipient: lastToRecipient };
  let wakeAt = Infinity;
  for (let i = 0; i < queue.length; i++) {
    const notBefore = queue[i]!.notBefore ?? 0;
    if (notBefore > now) {
      wakeAt = Math.min(wakeAt, notBefore);
      continue;
    }
    // Where a ceiling would be applied if one ever returns; nothing blocks today.
    if (blockedReason(now, queue[i]!.target, cfg.limits, cfg.linkedAt, history) === null) {
      return { index: i, wakeAt: now };
    }
  }
  return { index: -1, wakeAt };
}

/** Say what the pump is waiting on once, not once a minute; null when it is not waiting. */
function noteWaiting(why: string | null): void {
  if (why && why !== waitingFor) log.warn(`WhatsApp: ${why}; waiting.`);
  waitingFor = why;
}

/**
 * Drain the queue, one message at a time. Never runs twice concurrently — `running` is
 * the whole point of this module.
 */
async function pump(): Promise<void> {
  if (running) return;
  // Held, not dropped. Every item stays on the persisted queue with its body intact so the
  // admin can release it once the phone is relinked.
  if (paused) return;
  running = true;
  try {
    while (queue.length > 0) {
      // Re-checked every iteration: the monitor can pause us mid-drain, and the remaining
      // messages must stop where they are rather than finish the burst.
      if (paused) break;
      let cfg = getWhatsAppConfig();
      if (!isWhatsAppConfigured()) {
        // Configuration was removed under us; drop the backlog rather than spin.
        log.warn(`WhatsApp: gateway unconfigured, discarding ${queue.length} queued message(s).`);
        for (const dropped of queue) {
          noteOutcome(dropped, 'failed', 'WhatsApp was switched off before this could be sent.');
        }
        queue.length = 0;
        persist();
        break;
      }
      const now = Date.now();
      prune(now);
      expireHeldTooLong(now);
      if (queue.length === 0) break;

      let { index, wakeAt } = nextSendable(cfg, now);
      if (index < 0) {
        // Nothing can go right now. Sleep until the soonest item is due — at most a minute,
        // so a message enqueued meanwhile is not kept waiting behind a long backoff, and at
        // least a second, so this can never become a busy loop.
        const nap = Math.min(60_000, Math.max(1_000, wakeAt - now));
        log.info(
          `WhatsApp: ${queue.length} message(s) waiting to be retried. Next try in ${Math.round(nap / 1000)}s.`,
        );
        await setPresence(cfg, false);
        await sleep(nap);
        continue;
      }
      const item = queue[index]!;

      // A session may not exist yet (fresh install, or the gateway's volume was wiped).
      // Creating it is the platform's job, and failing is transient — wait, don't drop.
      if (!cfg.sessionId) {
        const s = await ensureSession();
        if (!s.ok) {
          noteWaiting(`no usable session yet (${s.error ?? 'unknown'})`);
          await sleep(60_000);
          continue;
        }
        // Re-read, or nothing below can send. `getWhatsAppConfig()` returns the cached
        // object BY REFERENCE, and `recordSessionId` REPLACES that object rather than
        // mutating it — so the `cfg` captured at the top of this iteration still holds
        // the default `sessionId: ''`. Every URL built from it then came out as
        // `/api/sessions//messages/send-text`, i.e. the first message after a session
        // was created on a fresh install could never go out. `requestPairingCode` has
        // carried this same re-read, with the same reason, since it was written.
        cfg = getWhatsAppConfig();
      }

      // Wait for a session that can actually send. A gateway restart leaves the session
      // stopped, and a message queued before the admin has linked a phone has simply
      // arrived early — neither is the message's fault, so neither may consume one of its
      // retry attempts. `ensureStarted` also recovers a stopped-but-credentialled session.
      const live = await ensureStarted(cfg);
      if (!live.ready) {
        noteWaiting(`session not ready to send (${live.error ?? 'not linked yet'})`);
        await setPresence(cfg, false);
        await sleep(60_000);
        continue;
      }
      noteWaiting(null);

      await setPresence(cfg, true);
      const outcome = await sendOne(cfg, item);

      // Find it again: the queue can change during the send (an admin's Discard empties it
      // while apps go on enqueueing), and the old index may now name a newer message.
      index = queue.indexOf(item);
      if (index < 0) {
        // Discarded mid-send. Its record keeps the admin's decision, unless it went out anyway.
        if (outcome.ok && outcomes.some((o) => o.id === item.id)) {
          noteOutcome(item, 'sent');
          persist();
        }
        continue;
      }

      // TRANSIENT failures must not lose the message. The first version shifted the item
      // off the queue whatever happened, so a 429 (or a restarting gateway, or a dropped
      // connection) silently discarded a parent's fee reminder. Rate limiting in
      // particular is a "not yet", not a "no" — it is the one error a paced sender should
      // expect to meet.
      if (!outcome.ok && outcome.retryable) {
        item.attempts += 1;
        if (item.attempts < MAX_ATTEMPTS) {
          // Back off further each time, so a gateway that is down for a while is not
          // hammered on our normal cadence.
          const backoff = Math.min(15 * 60_000, 30_000 * 2 ** (item.attempts - 1));
          log.warn(
            `WhatsApp: send for ${item.source} failed (${outcome.error ?? 'unknown'}); ` +
              `retry ${item.attempts}/${MAX_ATTEMPTS} in ${Math.round(backoff / 1000)}s.`,
          );
          // Step this item aside instead of sleeping the pump. Sleeping here was the SECOND
          // head-of-line block: one failing message stalled every other app's traffic for
          // its whole backoff, and with five attempts that reached three quarters of an hour
          // of total silence caused by a single bad send.
          item.notBefore = Date.now() + backoff;
          persist(); // attempts + notBefore are durable, so a restart keeps the schedule
          continue;
        }
        log.error(`WhatsApp: giving up on a message for ${item.source} after ${MAX_ATTEMPTS} attempts.`);
      }

      queue.splice(index, 1);
      if (outcome.ok) {
        // Recorded under the kind of target it was, for the send history.
        (item.target.kind === 'group' ? groupSentAt : sentAt).push(Date.now());
        lastToRecipient.set(targetKey(item.target), Date.now());
        noteOutcome(item, 'sent');
      } else {
        noteOutcome(item, 'failed', outcome.error ?? 'The gateway would not accept it.');
      }
      // The message has left the queue: on disk too, so a restart never sends it twice.
      persist();
      // No inter-message gap. There was a randomised 6-20s sleep here; it is gone at the
      // maintainer's decision. With several apps sharing one queue it made delivery
      // unpredictable, and the typing indicator before each send (`composingMs`, scaled to
      // the message with a 5s floor for an image) already provides spacing that is
      // proportional AND visible to the recipient, which is what the sleep was standing in
      // for. `nextGapMs` is kept and still tested — it is pure, and it is the thing to reach
      // for if a gap is ever wanted again — but nothing calls it.
    }
    // Idle: stop looking permanently online.
    const cfg = getWhatsAppConfig();
    if (isWhatsAppConfigured()) await setPresence(cfg, false);
  } catch (err) {
    log.error('WhatsApp queue stopped unexpectedly.', err);
  } finally {
    running = false;
    // A message enqueued during the final await would otherwise sit forever.
    if (queue.length > 0) void pump();
  }
}

async function setPresence(cfg: WhatsAppConfig, available: boolean): Promise<void> {
  if (presenceOn === available) return;
  const r = await call(cfg, 'PUT', `/api/sessions/${encodeURIComponent(cfg.sessionId)}/presence`, { available });
  // Presence is cosmetic camouflage; failing it must not stop a send.
  if (r.ok) presenceOn = available;
}

async function sendOne(cfg: WhatsAppConfig, item: QueueItem): Promise<SendOutcome> {
  const chatId = chatIdOf(item.target);

  // Don't message a number that isn't on WhatsApp — a documented ban signal. `null`
  // means "couldn't check", which proceeds: an unreachable check must not become an
  // outage.
  //
  // Skipped for groups: `contacts/check` answers "is this PHONE NUMBER on WhatsApp", so
  // asking it about a group id is meaningless — and its answer would be "no", which
  // would silently refuse every group post.
  if (item.target.kind === 'person') {
    const registered = await checkRegistered(cfg, item.target.digits);
    if (registered === false) {
      log.warn(`WhatsApp: ${item.source} addressed a number that is not on WhatsApp — skipped.`);
      return { ok: false, error: 'that number is not on WhatsApp', retryable: false };
    }
  }

  // Type, pause, then send — in that order, because that is the order a person does it.
  await call(cfg, 'POST', `/api/sessions/${encodeURIComponent(cfg.sessionId)}/chats/typing`, {
    chatId,
    state: 'typing',
  });
  await sleep(composingMs(item));
  await call(cfg, 'POST', `/api/sessions/${encodeURIComponent(cfg.sessionId)}/chats/typing`, {
    chatId,
    state: 'paused',
  });

  // An image goes to send-image, and it must NEVER fall back to send-text. Delivering the
  // caption alone would let an app report that a poster went out when only a sentence
  // did — the masjid would believe the timetable had been published.
  const r = item.media
    ? await call(
        cfg,
        'POST',
        `/api/sessions/${encodeURIComponent(cfg.sessionId)}/messages/send-image`,
        {
          chatId,
          base64: item.media.data,
          // OpenWA spells this all-lowercase; our own API uses `mimeType`. Deliberate — do
          // not "fix" either side to match the other.
          mimetype: item.media.mimeType,
          ...(item.media.filename ? { filename: item.media.filename } : {}),
          ...(item.text ? { caption: item.text } : {}),
        },
        SEND_TIMEOUT_MS,
      )
    : await call(
        cfg,
        'POST',
        `/api/sessions/${encodeURIComponent(cfg.sessionId)}/messages/send-text`,
        {
          chatId,
          text: item.text,
          // No link preview: fetching one is an extra outbound request from the number and
          // makes an automated message look more like a broadcast.
          linkPreview: false,
        },
        SEND_TIMEOUT_MS,
      );
  if (!r.ok) {
    // A 401/403 is classed non-retryable, so this message is about to be dropped after a
    // single attempt. Record it: on its own it looks like a config mistake, but a run of
    // them is how a dead link presents on the send path, and the monitor is what turns
    // that into something the admin actually hears about.
    if (r.status === 401 || r.status === 403) {
      sendSignals.authFailures += 1;
      sendSignals.lastAuthFailAt = Date.now();
    }
    if (r.timedOut) {
      // The gateway usually sends it anyway, so trying again could put a second copy in
      // front of a whole group — the worse failure, and a ban signal. Reported, not retried.
      log.warn(
        `WhatsApp: the gateway did not answer in time about ${item.media ? 'an image' : 'a message'} ` +
          `for ${item.source}; it may have been sent, so it was not sent again.`,
      );
      return {
        ok: false,
        error: 'The gateway did not answer in time, so it may or may not have arrived. It was not sent again, so nobody gets it twice.',
        retryable: false,
      };
    }
    if (item.media) {
      // Named distinctly in the log, because "the image failed" and "the message failed"
      // send someone to different places — a 404 here means the gateway is too old to
      // have send-image at all.
      log.error(
        `WhatsApp: could NOT send the image for ${item.source} (${r.error ?? 'unknown'}). ` +
          `Nothing was delivered — the caption was not sent on its own.`,
      );
    }
    return { ok: false, error: r.error, retryable: isRetryableStatus(r.status) };
  }
  // "accepted", NOT "delivered". All that has been established is that OpenWA's HTTP layer
  // returned 2xx to our POST -- an accept receipt from the gateway process, not from
  // WhatsApp and not from the recipient's phone. A session logged out at WhatsApp's end
  // still accepts, stores and displays the message, which is exactly how a masjid ended up
  // with everything marked sent and nothing arriving. Saying "delivered" here is the code
  // asserting more than it knows.
  sendSignals.authFailures = 0;
  log.info(`WhatsApp: the gateway accepted ${item.media ? 'an image' : 'a message'} for ${item.source}.`);
  return { ok: true };
}

/**
 * Send one message and WAIT for the outcome — used only by the admin's "send test
 * message" button, which needs a real answer on screen. It still goes through the same
 * gateway calls, but bypasses the queue: a test the admin is watching should not sit
 * behind a backlog.
 */
export async function sendTestMessage(to: string, text: string): Promise<SendOutcome> {
  if (!isWhatsAppConfigured()) return { ok: false, error: 'WhatsApp is not set up yet.' };
  const digits = toDigits(to);
  if (!digits) return { ok: false, error: 'That phone number needs a country code.' };
  const blocker = await testBlocker();
  if (blocker) return { ok: false, error: blocker };
  return sendTestTo({ kind: 'person', digits }, text);
}

/**
 * Why a test cannot go out right now, or null. Asked first: a test before a phone was
 * linked showed seconds of "typing" and then a bare "the gateway returned 404".
 */
async function testBlocker(): Promise<string | null> {
  const s = await gatewayStatus();
  if (s.state === 'ready') return null;
  if (s.state === 'unreachable') return `Couldn't reach the WhatsApp gateway (${s.detail}).`;
  if (s.state === 'bad-key') return 'The WhatsApp gateway turned down the API key. Paste it again in Settings → WhatsApp.';
  return 'Link a phone first (Settings → WhatsApp), then send the test again.';
}

/**
 * The same, to a GROUP the admin approved.
 *
 * Still approval-gated, even though this is an admin action: the id comes from a request
 * body, and "the admin asked" is not a reason to skip the one check that decides which
 * groups this platform may write to.
 *
 * Everyone in the group receives it, which is why the UI confirms first — a test message
 * cannot be unsent from two hundred phones.
 */
export async function sendTestToGroup(groupId: string, text: string): Promise<SendOutcome> {
  if (!isWhatsAppConfigured()) return { ok: false, error: 'WhatsApp is not set up yet.' };
  if (!isApprovedGroup(groupId)) return { ok: false, error: 'That group has not been approved for sending.' };
  const blocker = await testBlocker();
  if (blocker) return { ok: false, error: blocker };
  return sendTestTo({ kind: 'group', groupId }, text);
}

/**
 * Send one message and WAIT — the ONE non-queued path, shared by the admin's test
 * button and the command reply lane.
 *
 * Bypasses the queue. There is no budget to bypass: the hour/day caps are gone (see the
 * header), so what it adds to `sentAt` / `groupSentAt` / `lastToRecipient` is a record of
 * what was sent, not an allowance spent. NOT persisted from here: nothing reads that
 * record, the next queue write saves it, and rewriting the whole store for every command
 * reply cost an SD card a full write for nothing.
 *
 * What bounds this path is therefore NOT a cap. It is that a reply is only ever sent in
 * answer to an inbound message from an already-authorised sender, and the inbound rate
 * limit in `commands/gate.ts` (5, refill 1/15s) is what makes "message yourself in a
 * loop" impossible. Don't add a send-side allowance check back here: one existed, it
 * protected nothing because this function calls `sendOne` directly, and it locked admins
 * out of the very commands they were testing.
 */
export async function sendImmediate(target: Target, text: string, source: string): Promise<SendOutcome> {
  const cfg = getWhatsAppConfig();
  // A throwaway item: this path does not touch the queue, so the id is never handed out
  // and no outcome record is kept. The caller is awaiting the real answer.
  const outcome = await sendOne(cfg, {
    id: `immediate:${crypto.randomUUID()}`,
    text,
    source,
    target,
    enqueuedAt: Date.now(),
    attempts: 0,
  });
  if (outcome.ok) {
    (target.kind === 'group' ? groupSentAt : sentAt).push(Date.now());
    lastToRecipient.set(targetKey(target), Date.now());
  }
  return outcome;
}

async function sendTestTo(target: Target, text: string): Promise<SendOutcome> {
  return sendImmediate(target, text, 'os:test');
}

/**
 * Reply to someone who just messaged us.
 *
 * Takes DIGITS, never a JID, so it is structurally incapable of posting into a group.
 *
 * Why it skips the queue: a solicited reply to a known contact is the LOWEST-risk
 * traffic this number can emit — it is the same shape WhatsApp's own commercial API
 * models as a customer-service window. What gets a number flagged is unsolicited volume
 * to non-contacts, which is the opposite. And a reply that arrives forty minutes later,
 * behind a backlog, is not a reply; it is a bug. What bounds it is the inbound rate limit
 * in commands/gate.ts (see `sendImmediate`).
 */
export async function replyTo(digits: string, text: string): Promise<SendOutcome> {
  if (!isWhatsAppConfigured()) return { ok: false, error: 'WhatsApp is not set up yet.' };
  return sendImmediate({ kind: 'person', digits }, text, 'os:command');
}

// `replyBudget()` used to live here and is deliberately gone. It backed a check in
// commands/execute.ts that refused a mutating command once the day's allowance was
// spent, on the reasoning that there would otherwise be no way to report the result.
// That reasoning was wrong: a reply goes out through `sendImmediate`, which calls
// `sendOne` directly and never consults the caps — so the check protected nothing and
// only locked an admin out of the commands they were testing (worst on a freshly linked
// number, whose warm-up ramp quarters the hourly cap). What bounds commands is the
// INBOUND rate limit in commands/gate.ts. Don't reintroduce either half.

/** Test seam: forget pacing history so a test starts from a known state. */
export function __resetPacingForTests(): void {
  sentAt.length = 0;
  groupSentAt.length = 0;
  lastToRecipient.clear();
  onWhatsApp.clear();
  queue.length = 0;
  presenceOn = false;
}

/**
 * Forget everything this module holds in memory. For the "delete it all" path in
 * Settings, which must leave nothing behind that a later re-enable could resurrect.
 *
 * Deliberately NOT `__resetPacingForTests`, which is a narrower thing that happens to
 * look similar: it leaves `outcomes` (message bodies are not in there, but recipients'
 * message ids and per-app history are) and `lidPhones` (a cache mapping WhatsApp privacy
 * ids to real phone numbers) untouched. Both are personal data belonging to a masjid that
 * has just asked for all of it to go, so the two must stay separate functions — merging
 * them would silently widen what a test resets, or narrow what a delete clears.
 *
 * `running` is left alone: it belongs to the pump loop, and forcing it false while a send
 * is in flight would let a second pump start alongside the first. The pause and the
 * send-path evidence are NOT left alone: kept, a fresh setup's first message saved
 * `paused: true` and every message after it was held.
 */
export function clearWhatsAppRuntime(): void {
  queue.length = 0;
  sentAt.length = 0;
  groupSentAt.length = 0;
  outcomes.length = 0;
  lastToRecipient.clear();
  onWhatsApp.clear();
  clearGatewayCaches();
  presenceOn = false;
  paused = false;
  pausedSince = null;
  sendSignals.authFailures = 0;
  sendSignals.lastAuthFailAt = 0;
  waitingFor = null;
}
