// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Per-sender state: the menu they were shown, the app list they were shown, a pending
 * confirmation, and their inbound rate-limit bucket.
 *
 * One map, one eviction policy, one place to clear — because every one of these has
 * to die the moment a person's access is removed, and three separate stores would
 * eventually forget one.
 *
 * Swept on every inbound message rather than on a timer. The list is at most ten
 * people, so the sweep is free, and there is no interval to leak or forget to unref.
 */
import crypto from 'node:crypto';
import type { AppListSnapshot, CommandEntry, MenuSnapshot } from './types';
import { MENU_TTL_MS } from './parse';

/** Deliberately much shorter than the menu TTL: this is the window in which a risky
 *  action actually fires. Ninety seconds is ample to read a prompt and type a code. */
export const CONFIRM_TTL_MS = 90_000;
/** How long "they just messaged us" holds — the reply lane's structural guard. */
export const REPLY_WINDOW_MS = 15 * 60_000;
const APP_LIST_TTL_MS = MENU_TTL_MS;
const IDLE_EVICT_MS = 30 * 60_000;
const MAX_TRACKED = 64;

const BUCKET_CAP = 5;
const BUCKET_REFILL_MS = 15_000;
const THROTTLE_NOTICE_MS = 10 * 60_000;

/** An action already resolved and validated. Nothing is re-parsed on confirmation —
 *  the sender is answering THIS question, not re-issuing a command. */
export type PendingAction =
  | { kind: 'os'; command: CommandEntry; appId: string; appName: string }
  | { kind: 'app'; word: string; appLabel: string; command: CommandEntry; text?: string };

export interface PendingConfirm {
  code: string;
  askedAt: number;
  action: PendingAction;
}

/**
 * An app is mid-question with this sender.
 *
 * The ONLY thing that relaxes the `!` prefix rule, and deliberately the narrowest
 * relaxation that works: the platform has just asked something on the app's behalf,
 * so the next message is unambiguously an answer. A prefix is only needed where a
 * message could be either a command or ordinary conversation, and here it cannot.
 *
 * Bounded three ways, because a session that outlives the exchange is exactly how
 * ordinary chat starts getting read as input: idle timeout, absolute lifetime, and a
 * turn cap. Any of them expiring closes it silently — the sender is back to needing
 * a prefix, which is the safe state.
 */
export interface AppSession {
  /** The namespace word — the app id. Re-authorised on every turn. */
  word: string;
  appLabel: string;
  commandId: string;
  /** Opaque to us; the app's own handle on the conversation it is running. */
  token: string;
  turns: number;
  openedAt: number;
  lastAt: number;
}

/** Idle. Short: an abandoned exchange must stop capturing conversation quickly. */
export const SESSION_IDLE_MS = 3 * 60_000;
/** Absolute, however chatty. */
const SESSION_MAX_MS = 15 * 60_000;
/** A question-and-answer flow, not an interface. */
const SESSION_MAX_TURNS = 12;

interface Entry {
  menu: MenuSnapshot | null;
  apps: AppListSnapshot | null;
  pending: PendingConfirm | null;
  session: AppSession | null;
  lastInboundAt: number;
  tokens: number;
  tokensAt: number;
  throttledAt: number;
}

const state = new Map<string, Entry>();

function fresh(now: number): Entry {
  return {
    menu: null,
    apps: null,
    pending: null,
    session: null,
    lastInboundAt: now,
    tokens: BUCKET_CAP,
    tokensAt: now,
    throttledAt: 0,
  };
}

function sweep(now: number): void {
  for (const [k, e] of state) if (now - e.lastInboundAt > IDLE_EVICT_MS) state.delete(k);
  if (state.size <= MAX_TRACKED) return;
  const oldest = [...state.entries()].sort((a, b) => a[1].lastInboundAt - b[1].lastInboundAt);
  for (const [k] of oldest.slice(0, state.size - MAX_TRACKED)) state.delete(k);
}

function entry(digits: string, now: number): Entry {
  let e = state.get(digits);
  if (!e) {
    e = fresh(now);
    state.set(digits, e);
  }
  return e;
}

/** Record that this authorised sender just messaged us, and sweep.
 *  Insert BEFORE sweeping, or the cap is always overshot by the new entry — and the
 *  entry just touched is the newest, so it is never the one evicted. */
export function touch(digits: string, now: number): void {
  entry(digits, now).lastInboundAt = now;
  sweep(now);
}

/** The reply lane's guard: we only ever reply to someone who just messaged us, so a
 *  bug that passed the wrong digits still cannot message a stranger. */
export function recentlyInbound(digits: string, now: number): boolean {
  const e = state.get(digits);
  return Boolean(e && now - e.lastInboundAt <= REPLY_WINDOW_MS);
}

// ── inbound rate limiting ────────────────────────────────────────────────────────

/** Spend a token. False means "too many commands", not "not allowed". */
export function takeToken(digits: string, now: number): boolean {
  const e = entry(digits, now);
  const refill = Math.floor((now - e.tokensAt) / BUCKET_REFILL_MS);
  if (refill > 0) {
    e.tokens = Math.min(BUCKET_CAP, e.tokens + refill);
    e.tokensAt = now;
  }
  if (e.tokens <= 0) return false;
  e.tokens -= 1;
  return true;
}

/** At most one "slow down" per sender per ten minutes — the notice must not itself
 *  become the flood. */
export function shouldNoticeThrottle(digits: string, now: number): boolean {
  const e = entry(digits, now);
  if (now - e.throttledAt < THROTTLE_NOTICE_MS) return false;
  e.throttledAt = now;
  return true;
}

// ── menus ────────────────────────────────────────────────────────────────────────

export function setMenu(digits: string, word: string, ids: string[], now: number): void {
  entry(digits, now).menu = { word, ids, at: now };
}

export function getMenu(digits: string): MenuSnapshot | null {
  return state.get(digits)?.menu ?? null;
}

export function setAppList(digits: string, ids: string[], now: number): void {
  entry(digits, now).apps = { ids, at: now };
}

/** The numbered app list, only while it is the one they are looking at. */
export function getAppList(digits: string, now: number): AppListSnapshot | null {
  const a = state.get(digits)?.apps;
  return a && now - a.at <= APP_LIST_TTL_MS ? a : null;
}

// ── confirmations ────────────────────────────────────────────────────────────────

/**
 * Four characters from an alphabet with no 0/O/1/I, so a code read off a phone screen
 * cannot be mistyped into a different valid one.
 *
 * Why a code at all, when the sender is already authorised: the confirmation is not
 * authentication. Its job is to stop the WRONG message executing — a typo, a stale
 * menu number, a forwarded screenshot, a second trustee answering a prompt they never
 * saw. A fixed word like "yes" gets typed reflexively; a code has to be read off that
 * specific prompt.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode(): string {
  const bytes = crypto.randomBytes(4);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** Ask for confirmation. Replaces any previous pending action — two live codes is how
 *  the wrong one gets confirmed. */
export function setPending(digits: string, action: PendingAction, now: number): string {
  const code = makeCode();
  entry(digits, now).pending = { code, askedAt: now, action };
  return code;
}

export type TakePending =
  | { ok: true; action: PendingAction }
  | { ok: false; why: 'none' | 'expired' | 'wrong-code' };

/** Consume a pending confirmation. Single-use: matched or not, a correct code is
 *  spent, so a re-sent message cannot run the action twice. */
export function takePending(digits: string, code: string, now: number): TakePending {
  const e = state.get(digits);
  const p = e?.pending;
  if (!e || !p) return { ok: false, why: 'none' };
  if (now - p.askedAt > CONFIRM_TTL_MS) {
    e.pending = null;
    return { ok: false, why: 'expired' };
  }
  if (p.code !== code.toUpperCase()) return { ok: false, why: 'wrong-code' };
  e.pending = null;
  return { ok: true, action: p.action };
}

/**
 * Consume a pending confirmation answered with a plain "yes".
 *
 * Legitimate only because the platform asked THIS question moments ago and is holding
 * exactly one — the ambiguity the code guards against (a stale prompt, the wrong one
 * of two) cannot arise inside a live exchange. `!yes CODE` still works everywhere,
 * including with no exchange open, which is the only path available then.
 */
export function takeConfirmed(digits: string, now: number): TakePending {
  const e = state.get(digits);
  const p = e?.pending;
  if (!e || !p) return { ok: false, why: 'none' };
  if (now - p.askedAt > CONFIRM_TTL_MS) {
    e.pending = null;
    return { ok: false, why: 'expired' };
  }
  e.pending = null;
  return { ok: true, action: p.action };
}

export function hasPending(digits: string): boolean {
  return Boolean(state.get(digits)?.pending);
}

// ── app sessions ─────────────────────────────────────────────────────────────────

export function openSession(
  digits: string,
  s: Omit<AppSession, 'turns' | 'openedAt' | 'lastAt'>,
  now: number,
): void {
  const e = entry(digits, now);
  const existing = e.session && e.session.word === s.word ? e.session : null;
  e.session = {
    ...s,
    // Turns accumulate across the whole exchange, not per question — the cap is on
    // the conversation, and resetting it each turn would make it meaningless.
    turns: (existing?.turns ?? 0) + 1,
    openedAt: existing?.openedAt ?? now,
    lastAt: now,
  };
}

/** The live session, or null. Expiry is checked on READ so a stale one can never be
 *  used, whatever ran or did not run in the meantime. */
export function getSession(digits: string, now: number): AppSession | null {
  const e = state.get(digits);
  const s = e?.session;
  if (!e || !s) return null;
  if (now - s.lastAt > SESSION_IDLE_MS || now - s.openedAt > SESSION_MAX_MS || s.turns > SESSION_MAX_TURNS) {
    e.session = null;
    return null;
  }
  return s;
}

export function clearSession(digits: string): void {
  const e = state.get(digits);
  if (e) e.session = null;
}

/**
 * Are we waiting on this person for something?
 *
 * The single question the gate asks before enforcing the `!` prefix. True only when
 * the platform has actually asked them something — an app mid-question, or a
 * confirmation it is holding — so ordinary conversation is untouched at every other
 * moment.
 */
export function awaitingReply(digits: string, now: number): boolean {
  return getSession(digits, now) !== null || hasPending(digits);
}

export function clearPending(digits: string): void {
  const e = state.get(digits);
  if (e) e.pending = null;
}

/** Everything, for a listener teardown or any change to who is allowed in. A removed
 *  person's half-answered confirmation must die with their access. */
export function resetConversations(): void {
  state.clear();
}

/** Test seam. */
export function __conversationSizeForTests(): number {
  return state.size;
}
