// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Durable storage for the WhatsApp send queue, its pacing history, and the outcome of
 * recent messages.
 *
 * WHY THIS EXISTS. The queue was a module-level array and nothing else. That is fine
 * until something holds a message — a cap, the warm-up ramp, or (until v0.51.1) a
 * time-of-day window — because a held message lives only in the process. Restart the
 * container and it is gone: the caller was told `202 {queued:true}`, the message was
 * logged as queued, and then it simply never existed again. No error, no log line, no
 * way for the app that sent it to ever learn otherwise.
 *
 * That is not a hypothetical. It is the reported failure on a live install: messages
 * accepted for over 24 hours, none delivered, nothing in any log, while `!os` commands
 * worked perfectly — because a command reply goes out through `sendImmediate`, which
 * bypasses the queue entirely. "Commands work but messages do not" is exactly the
 * signature of a broken queue and a working transport.
 *
 * The pacing HISTORY is persisted for a different and equally important reason: it is the
 * ban-risk budget. If `sentAt` empties on every restart then the hourly and daily caps are
 * not really caps, and a box in a restart loop could send its daily allowance many times
 * over — the precise behaviour the whole pacer exists to prevent.
 *
 * WHERE. `config/whatsapp-queue.json`. Not because it is a credential, but because a
 * queued message body routinely carries a child's name and a family's fees. `CONFIG_DIR`
 * is 0700, `writeJson` makes the file 0600, and `files/manager.ts` refuses `config/**` to
 * the File Explorer — so the same protection the secrets get, for the same reason.
 *
 * SIZE. Bounded by limits that already existed: at most `MAX_QUEUE` items, of which at
 * most `MAX_QUEUED_MEDIA` (4) carry an image of at most 2 MB decoded. Base64 inflates by
 * about a third, so the worst case is roughly 11 MB, written a few times per message
 * rather than continuously. That is acceptable on an SD card at this frequency; a
 * continuously-rewritten file of that size would not be.
 */
import path from 'node:path';
import fs from 'node:fs';
import { CONFIG_DIR } from '../config';
import { readJson, writeJson } from '../util/json-store';
import { log } from '../logger';

const STORE_PATH = path.join(CONFIG_DIR, 'whatsapp-queue.json');

/**
 * A message held longer than this is dropped rather than sent on load.
 *
 * Two reasons. A fee reminder that has been waiting a day is no longer the message anyone
 * wanted sent, and — more importantly — releasing a long backlog all at once is a burst,
 * which is the single behaviour most likely to get the number restricted. The pacer would
 * still space them out, but the intent here is to not have a day's worth to space out in
 * the first place.
 */
export const MAX_HELD_MS = 24 * 60 * 60 * 1000;

/**
 * IMPORTANT: this measures time the link was USABLE, not wall-clock.
 *
 * It used to be wall-clock, and that turned a WhatsApp outage into data loss: a session
 * that expired on a Friday meant every message enqueued over the weekend was silently
 * marked `expired` on the next restart, having never had a chance to send. The reason for
 * the bound is "a fee reminder that waited a day is stale, and releasing a day's backlog
 * at once is a burst" — both of which are about time we COULD have sent and did not, so
 * paused time must not count. See `effectiveHeldMs`.
 */

/**
 * How many recent outcomes to remember PER SENDING APP, so an app can ask what happened
 * after the 202.
 *
 * Per source, not one shared ring, and that is the whole point. A single global bound is a
 * resource every app shares, so the app that sends most evicts everyone else's records —
 * exactly the cross-app denial the per-app rate tier in `api/fabric.ts` exists to prevent,
 * in a different resource. The case that proved it: a student-billing app messaging a
 * 200-family roster filled a 200-record global ring by itself, wiping the reader-offline
 * and refund outcomes of every other app on the box, and then its own earliest records —
 * the ones most likely to have failed and be worth reporting.
 *
 * 500 is sized for the realistic worst case (a roster run on a large madrasah) with room
 * over it. A source that exceeds it is evicting only its own history.
 */
export const MAX_OUTCOMES_PER_SOURCE = 500;

/**
 * Total backstop across all sources, so a pathological number of app ids cannot grow the
 * store without bound. Reached only if many apps are each near their own cap.
 */
export const MAX_OUTCOMES_TOTAL = 5_000;

/**
 * Age at which an outcome is forgotten.
 *
 * Matches `MAX_HELD_MS`: a record must outlive the message it describes, and a message can
 * be held for up to a day. Beyond that nobody is still asking — the apps that poll settle
 * within minutes — and keeping it only grows the file that is rewritten on every send.
 */
export const OUTCOME_MAX_AGE_MS = MAX_HELD_MS;

export type OutcomeState = 'queued' | 'sent' | 'failed' | 'expired';

export interface OutcomeRecord {
  /** Opaque id handed back to the caller at enqueue time. */
  id: string;
  /** The app id that sent it, or 'os'. Scopes who may read this record. */
  source: string;
  state: OutcomeState;
  /** Plain-language reason, for `failed` / `expired`. Never a stack trace. */
  reason?: string;
  /** When the state was last set. */
  at: number;
  /** 'person' | 'group'. Deliberately NOT the number or the group id. */
  targetKind: string;
}

/**
 * A queue item as stored. Structurally the runtime `QueueItem` plus its id.
 *
 * Declared here rather than imported to keep the dependency one-way (whatsapp.ts imports
 * this module, never the reverse) and to make it obvious that changing the runtime shape
 * means thinking about what is already on disk.
 */
export interface StoredItem {
  id: string;
  text: string;
  source: string;
  target: { kind: 'person'; digits: string } | { kind: 'group'; groupId: string };
  media?: { data: string; mimeType: string; filename?: string };
  enqueuedAt: number;
  attempts: number;
  /** Earliest retry time after a transient failure; see QueueItem.notBefore. */
  notBefore?: number;
  /**
   * Milliseconds this item spent on a PAUSED queue, accumulated when each pause ends.
   *
   * Per item rather than one global total, because an item enqueued halfway through an
   * outage was only held for the remainder of it — crediting it the whole outage would let
   * it outlive the bound by however long the outage ran before it arrived.
   */
  heldWhilePausedMs?: number;
}

interface PersistedState {
  queue: StoredItem[];
  /** Individual send timestamps within the rolling day. */
  sends: number[];
  /** Group post timestamps within the rolling day. */
  groupSends: number[];
  /** `targetKey` → last send, as pairs because a Map is not JSON. */
  lastPerRecipient: [string, number][];
  outcomes: OutcomeRecord[];
  /**
   * The queue is holding everything and will not send until an admin releases it.
   *
   * Set only by the health monitor, on a CONFIRMED lost link — never by a transient blip,
   * which the pump's own wait already absorbs. Persisted because an outage outlives a
   * restart, and a box that forgot it was paused would drain a two-day backlog at boot,
   * which is the burst this whole mechanism exists to avoid.
   */
  paused?: boolean;
  /** When the current pause began, for `effectiveHeldMs`. Null when running. */
  pausedSince?: number | null;
}

const EMPTY: PersistedState = {
  queue: [],
  sends: [],
  groupSends: [],
  lastPerRecipient: [],
  outcomes: [],
  paused: false,
  pausedSince: null,
};

/**
 * How long an item has been waiting, counting only time the queue was RUNNING.
 *
 * `pausedSince` covers the pause in progress; `heldWhilePausedMs` covers earlier ones. The
 * `Math.max` is what keeps an item enqueued mid-outage honest — it is only credited from
 * its own arrival, not from the start of the pause.
 */
export function effectiveHeldMs(item: StoredItem, now: number, pausedSince: number | null): number {
  const banked = item.heldWhilePausedMs ?? 0;
  const current = pausedSince == null ? 0 : Math.max(0, now - Math.max(item.enqueuedAt, pausedSince));
  return Math.max(0, now - item.enqueuedAt - banked - current);
}

/**
 * Close out a pause: bank each item's share of it. Mutates in place, then the caller
 * persists. Called when an admin releases the queue, or when the link recovers.
 */
export function bankPausedTime(items: StoredItem[], now: number, pausedSince: number | null): void {
  if (pausedSince == null) return;
  for (const item of items) {
    const share = Math.max(0, now - Math.max(item.enqueuedAt, pausedSince));
    item.heldWhilePausedMs = (item.heldWhilePausedMs ?? 0) + share;
  }
}

/**
 * The COUNT bounds: newest N per source, then the global backstop. No clock involved.
 *
 * Per-source before global is what makes this isolation rather than mere size-limiting — the
 * app that sends most can only evict its own history. Relative order is preserved so callers
 * can keep treating the array as oldest-first.
 */
export function capOutcomes(all: OutcomeRecord[]): OutcomeRecord[] {
  // Keep the newest N per source. Walk backwards so "newest" needs no sort.
  const perSource = new Map<string, number>();
  const keep = new Set<OutcomeRecord>();
  for (let i = all.length - 1; i >= 0; i--) {
    const rec = all[i]!;
    const seen = perSource.get(rec.source) ?? 0;
    if (seen >= MAX_OUTCOMES_PER_SOURCE) continue;
    perSource.set(rec.source, seen + 1);
    keep.add(rec);
  }

  const kept = all.filter((o) => keep.has(o));
  return kept.length > MAX_OUTCOMES_TOTAL ? kept.slice(-MAX_OUTCOMES_TOTAL) : kept;
}

/**
 * The age bound plus the count bounds. `now` is injected, never read from the clock here.
 *
 * Split from `capOutcomes` because the write path must NOT age-prune: `saveQueueState` is a
 * serialiser, and giving it its own `Date.now()` made it silently discard any record whose
 * timestamp was not close to the wall clock — which is every record in a test fixture, and
 * would also be every record on a box whose clock had just been corrected by NTP. Age is a
 * question for the reader (and for `noteOutcome`, which has a real `now`); the writer only
 * enforces the count caps that stop the file growing.
 */
export function trimOutcomes(all: OutcomeRecord[], now: number): OutcomeRecord[] {
  return capOutcomes(all.filter((o) => typeof o.at !== 'number' || now - o.at <= OUTCOME_MAX_AGE_MS));
}

/** Is this a plausible stored item? A hand-edited or truncated file must not crash boot. */
function validItem(v: unknown): v is StoredItem {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.source !== 'string') return false;
  if (typeof o.text !== 'string') return false;
  if (typeof o.enqueuedAt !== 'number' || !Number.isFinite(o.enqueuedAt)) return false;
  const t = o.target as Record<string, unknown> | undefined;
  if (!t || typeof t !== 'object') return false;
  if (t.kind === 'person') return typeof t.digits === 'string' && t.digits.length > 0;
  if (t.kind === 'group') return typeof t.groupId === 'string' && t.groupId.length > 0;
  return false;
}

function numbers(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)) : [];
}

export interface LoadedState {
  queue: StoredItem[];
  sends: number[];
  groupSends: number[];
  lastPerRecipient: Map<string, number>;
  outcomes: OutcomeRecord[];
  /** Items dropped for being older than MAX_HELD_MS, so the caller can log it. */
  expired: StoredItem[];
  /** Whether the queue was paused when the process stopped. */
  paused: boolean;
  pausedSince: number | null;
}

/**
 * Read the persisted state. Never throws — a damaged file degrades to empty rather than
 * stopping the daemon, the same rule the TLS cert follows (CLAUDE.md §15). A masjid whose
 * queue file is corrupt loses queued messages, which is bad; a masjid whose dashboard will
 * not boot has no way to fix anything at all, which is worse.
 */
export function loadQueueState(now: number): LoadedState {
  let raw: PersistedState;
  try {
    raw = readJson<PersistedState>(STORE_PATH, EMPTY);
  } catch (err) {
    log.warn('WhatsApp: could not read the saved queue; starting empty.', err);
    raw = EMPTY;
  }

  const all = Array.isArray(raw.queue) ? raw.queue.filter(validItem) : [];
  const paused = raw.paused === true;
  // Only trust a pause timestamp that belongs to an actual pause, so a hand-edited or
  // half-written file cannot credit every item unlimited holding time.
  const pausedSince =
    paused && typeof raw.pausedSince === 'number' && Number.isFinite(raw.pausedSince) ? raw.pausedSince : paused ? now : null;
  const queue: StoredItem[] = [];
  const expired: StoredItem[] = [];
  for (const item of all) {
    (effectiveHeldMs(item, now, pausedSince) > MAX_HELD_MS ? expired : queue).push(item);
  }

  const pairs = Array.isArray(raw.lastPerRecipient) ? raw.lastPerRecipient : [];
  const lastPerRecipient = new Map<string, number>();
  for (const pair of pairs) {
    if (Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'number') {
      lastPerRecipient.set(pair[0], pair[1]);
    }
  }

  const outcomes = (Array.isArray(raw.outcomes) ? (raw.outcomes as unknown[]) : [])
    .filter((o): o is OutcomeRecord => {
      if (typeof o !== 'object' || o === null) return false;
      const r = o as Record<string, unknown>;
      return typeof r.id === 'string' && typeof r.source === 'string' && typeof r.state === 'string';
    });

  return {
    queue,
    sends: numbers(raw.sends),
    groupSends: numbers(raw.groupSends),
    lastPerRecipient,
    outcomes: trimOutcomes(outcomes, now),
    expired,
    paused,
    pausedSince,
  };
}

/**
 * Write the state. Best-effort by design: failing to persist must not fail a send.
 *
 * A full disk is the realistic failure, and the right behaviour then is to carry on
 * sending from memory (degrading to the old behaviour) rather than to refuse to send at
 * all. It is logged once per failure so the cause is visible, not swallowed.
 */
export function saveQueueState(state: {
  queue: StoredItem[];
  sends: number[];
  groupSends: number[];
  lastPerRecipient: Map<string, number>;
  outcomes: OutcomeRecord[];
  paused?: boolean;
  pausedSince?: number | null;
}): void {
  try {
    const out: PersistedState = {
      queue: state.queue,
      sends: state.sends,
      groupSends: state.groupSends,
      lastPerRecipient: [...state.lastPerRecipient.entries()],
      outcomes: capOutcomes(state.outcomes),
      paused: state.paused === true,
      pausedSince: state.paused === true ? (state.pausedSince ?? null) : null,
    };
    writeJson(STORE_PATH, out);
  } catch (err) {
    log.warn('WhatsApp: could not save the queue; it will not survive a restart.', err);
  }
}

/** Remove the store — used by the tests, and when WhatsApp is deconfigured. */
export function clearQueueStore(): void {
  try {
    fs.rmSync(STORE_PATH, { force: true });
  } catch {
    /* best effort */
  }
}

export { STORE_PATH as QUEUE_STORE_PATH };
