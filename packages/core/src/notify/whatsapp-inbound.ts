// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The inbound half of WhatsApp: a Socket.IO connection to the OpenWA gateway, so an
 * authorised phone can run admin commands.
 *
 * WHY A SOCKET AND NOT A WEBHOOK. Both exist upstream. A webhook would need the
 * gateway container to reach the CORE, which reverses the direction everything else
 * runs in: it needs the core's LAN address baked into the gateway, a new inbound
 * route, raw-body HMAC handling, and — because OpenWA's SSRF guard blocks private
 * addresses by default — the masjid's OpenWA compose relaxed to allow it. A socket
 * runs the SAME direction as the send path already does (core → appOrigin(port), the
 * one address rule in system/app-host.ts), so it adds no inbound surface at all and
 * works on an install that was set up before this feature existed.
 *
 * THE EVENT NAME IS NOT IN OPENWA'S PUBLIC DOCS. So this does not bet on one: it
 * subscribes with onAny() and filters. `lastEventAt` records ANY event, which is what
 * lets the Settings panel distinguish "connected and hearing nothing" from
 * "connected and working" — the exact failure an undocumented API makes likely.
 *
 * This module NEVER sends. Replies go out through notify/whatsapp.ts, which owns the
 * one queue and the budget.
 */
import type { Socket } from 'socket.io-client';
import { log } from '../logger';
import { areCommandsEnabled, listCommandPeople, onCommandConfigChange } from '../store/commands';
import { getWhatsAppConfig, isWhatsAppConfigured } from '../store/whatsapp';
import { maskDigits } from '../util/phone';
import { gate, type GateOutcome } from '../commands/gate';
import { resetConversations } from '../commands/conversation';
import { gatewayStatus, resolveBaseUrl } from './whatsapp';

const RECONCILE_MS = 30_000;
const STATUS_PROBE_MS = 60_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 300_000;
/** A connection must survive this long before we call it healthy and reset the
 *  backoff — resetting on `connect` alone turns a flapping gateway into a hot loop. */
const STABLE_MS = 60_000;
const AUTH_FAIL_LIMIT = 5;
const SILENT_AFTER_MS = 90_000;
const UNPARSEABLE_LOG_CAP = 10;

export type InboundState =
  | 'off'
  | 'no-senders'
  | 'unconfigured'
  | 'gateway-down'
  | 'not-linked'
  | 'connecting'
  | 'connected'
  | 'silent'
  | 'bad-key'
  | 'error';

export interface InboundStatus {
  state: InboundState;
  /** Plain language for the admin. Never a key, never a message body. */
  detail: string;
  connectedAt: string | null;
  /** The last event of ANY name — proves the wiring independently of parsing. */
  lastEventAt: string | null;
  retryInMs: number | null;
  /** Volume only, no content. */
  counters: { seen: number; ran: number; ignoredUnknown: number; unparseable: number };
}

// ── event-name filtering ─────────────────────────────────────────────────────────

/** Checked FIRST. These contain "message" but are NOT one — parsing a `message.ack`
 *  as a command would re-execute on every reply we send. */
const NOT_A_MESSAGE = /(ack|status|update|revoke|delete|edit|reaction|receipt|presence|typing|call|group|state)/i;
const MESSAGE_NAME =
  /^(on)?(message|messages|messagecreate|newmessage|messagereceived|incomingmessage|chatmessage)$/;

/** Letters only, so `wa:new-message`, `message.received` and `onMessage` all reduce to
 *  something comparable. */
const letters = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

export function isMessageEvent(event: string): boolean {
  if (NOT_A_MESSAGE.test(event)) return false;
  // Test the WHOLE name and the last segment. `message.received` means something only
  // as a whole (its tail is just "received"), while `wa:new-message` means something
  // only as a tail. Neither spelling can be assumed, so accept either.
  const tail = event.split(/[.:/]/).pop() ?? '';
  return MESSAGE_NAME.test(letters(event)) || MESSAGE_NAME.test(letters(tail));
}

// ── supervisor state ─────────────────────────────────────────────────────────────

let socket: Socket | null = null;
let timer: NodeJS.Timeout | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let fingerprint = '';
let attempt = 0;
let authFailures = 0;
let connectedAt = 0;
let lastEventAt = 0;
let lastProbeAt = 0;
let stopped = true;
let state: InboundState = 'off';
let detail = 'Commands are switched off.';
let retryAt = 0;
const counters = { seen: 0, ran: 0, ignoredUnknown: 0, unparseable: 0 };
const unparseableSeen = new Set<string>();
/** Rate-limit the "a stranger tried a command" line so it cannot flood the log. */
const strangerLogged = new Map<string, number>();

/** Set by whoever owns execution, so this module never imports the executor and
 *  Phase 3 can ship with nothing wired to it at all. */
type Handler = (outcome: GateOutcome) => void | Promise<void>;
let handler: Handler | null = null;
export function setInboundHandler(fn: Handler | null): void {
  handler = fn;
}

export function inboundStatus(): InboundStatus {
  return {
    state,
    detail,
    connectedAt: connectedAt ? new Date(connectedAt).toISOString() : null,
    lastEventAt: lastEventAt ? new Date(lastEventAt).toISOString() : null,
    retryInMs: retryAt ? Math.max(0, retryAt - Date.now()) : null,
    counters: { ...counters },
  };
}

function setState(next: InboundState, why: string): void {
  if (state !== next || detail !== why) log.info(`WhatsApp commands: ${next} — ${why}`);
  state = next;
  detail = why;
}

// ── what we want to be doing ─────────────────────────────────────────────────────

type Desire = { want: false; state: InboundState; detail: string } | { want: true; origin: string; key: string; sessionId: string };

async function desired(): Promise<Desire> {
  if (!areCommandsEnabled()) return { want: false, state: 'off', detail: 'Commands are switched off.' };
  // Fail-closed made physical: with nobody authorised there is nothing to listen for,
  // so we do not even open a socket.
  if (listCommandPeople().length === 0) {
    return { want: false, state: 'no-senders', detail: 'Nobody is on the list yet.' };
  }
  if (!isWhatsAppConfigured()) {
    return { want: false, state: 'unconfigured', detail: 'WhatsApp is not set up yet.' };
  }
  const cfg = getWhatsAppConfig();
  const addr = await resolveBaseUrl(cfg);
  if (!addr.url) return { want: false, state: 'gateway-down', detail: addr.reason ?? 'The gateway is not reachable.' };
  // A typed baseUrl is admin input; never hand something that is not http(s) to io().
  let origin: string;
  try {
    const u = new URL(addr.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
    origin = u.origin;
  } catch {
    return { want: false, state: 'error', detail: 'The gateway address is not a valid http(s) URL.' };
  }
  if (!cfg.sessionId) return { want: false, state: 'not-linked', detail: 'No phone is linked yet.' };

  // The status probe costs an HTTP call, so only while disconnected and at most once
  // a minute. Once connected, the socket itself is the liveness signal.
  const now = Date.now();
  if (!socket && now - lastProbeAt > STATUS_PROBE_MS) {
    lastProbeAt = now;
    const s = await gatewayStatus();
    if (s.restriction) {
      return { want: false, state: 'error', detail: `WhatsApp has restricted this number (${s.restriction}).` };
    }
    if (s.state === 'bad-key') return { want: false, state: 'bad-key', detail: 'The gateway rejected the API key.' };
    if (s.state !== 'ready') return { want: false, state: 'not-linked', detail: s.detail };
  }
  return { want: true, origin, key: cfg.apiKey, sessionId: cfg.sessionId };
}

// ── connecting ───────────────────────────────────────────────────────────────────

function teardown(): void {
  if (socket) {
    try {
      socket.removeAllListeners();
      socket.close();
    } catch {
      /* already gone */
    }
  }
  socket = null;
  connectedAt = 0;
}

async function connect(d: Extract<Desire, { want: true }>): Promise<void> {
  // Loaded on demand: the overwhelming majority of masjids never turn this on, and
  // "runs comfortably on a Pi" is a stated value (CLAUDE.md §19).
  const { io } = await import('socket.io-client');
  setState('connecting', 'Connecting to the gateway…');

  const s = io(d.origin, {
    path: process.env.OPENMASJID_OPENWA_SOCKET_PATH ?? '/socket.io',
    auth: { apiKey: d.key },
    // Not websocket-only: socket.io-client only guarantees extraHeaders on the
    // polling handshake, and X-API-Key is half of the authentication.
    extraHeaders: { 'X-API-Key': d.key },
    // WE own the backoff — socket.io's own retry knows nothing about the other four
    // preconditions and would hammer a deliberately stopped gateway.
    reconnection: false,
    timeout: 20_000,
    forceNew: true,
    autoConnect: false,
  });
  socket = s;

  s.on('connect', () => {
    connectedAt = Date.now();
    authFailures = 0;
    setState('connected', 'Listening for commands.');
  });

  s.on('connect_error', (err: Error) => {
    const msg = err?.message ?? 'connection failed';
    if (/unauthor|forbidden|invalid.*key|401|403/i.test(msg)) authFailures += 1;
    teardown();
    if (authFailures >= AUTH_FAIL_LIMIT) {
      setState('bad-key', 'The gateway rejected the API key. Check it in Settings.');
      return;
    }
    scheduleRetry(`Could not reach the gateway (${msg}).`);
  });

  s.on('disconnect', (reason: string) => {
    teardown();
    scheduleRetry(`The gateway connection dropped (${reason}).`);
  });

  s.onAny((event: string, ...args: unknown[]) => {
    lastEventAt = Date.now();
    if (!isMessageEvent(event)) return;
    void handleInbound(event, args);
  });

  s.connect();
}

function scheduleRetry(why: string): void {
  if (stopped) return;
  attempt += 1;
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  const wait = Math.round(base * (0.8 + 0.4 * Math.random()));
  retryAt = Date.now() + wait;
  setState('error', why);
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void reconcile();
  }, wait);
  retryTimer.unref?.();
}

// ── the message path ─────────────────────────────────────────────────────────────

async function handleInbound(event: string, args: unknown[]): Promise<void> {
  const outcome = gate(args, { now: Date.now(), connectedAt: connectedAt || Date.now() });

  if (outcome.pass) {
    counters.seen += 1;
    // Phase 3 ships with no handler attached: it connects, reads, gates and logs,
    // which is a complete slice with zero execution surface.
    if (!handler) {
      log.info(`WhatsApp commands: a command from ${maskDigits(outcome.digits)} was read (nothing runs yet).`);
      return;
    }
    counters.ran += 1;
    try {
      await handler(outcome);
    } catch (err) {
      // Only the message. Passing the error object as `extra` would print whatever it
      // closed over, which is how a body leaks into a log that ends up in a backup.
      log.error(`WhatsApp commands: handling a command failed — ${(err as Error).message}`);
    }
    return;
  }

  switch (outcome.drop) {
    case 'unparseable': {
      counters.unparseable += 1;
      // Key NAMES are schema, not content. Deduped and capped so an unknown payload
      // shape cannot fill the log.
      const sig = `${event}|${(outcome.keys ?? []).join(',')}`;
      if (!unparseableSeen.has(sig) && unparseableSeen.size < UNPARSEABLE_LOG_CAP) {
        unparseableSeen.add(sig);
        log.warn(
          `WhatsApp commands: could not read an inbound "${event}" event (keys: ${(outcome.keys ?? []).join(', ') || 'none'}). Ignored.`,
        );
      }
      return;
    }
    case 'unknown-sender': {
      counters.ignoredUnknown += 1;
      return;
    }
    case 'rate-limited': {
      if (outcome.digits) log.warn(`WhatsApp commands: too many commands from ${maskDigits(outcome.digits)}.`);
      if (outcome.notice && handler) void handler(outcome);
      return;
    }
    default:
      // Everything else — ordinary conversation, our own echoes, group chatter — is
      // silent by design. No log line: otherwise this quietly becomes a record of
      // every number that ever messaged the masjid, which did not exist before.
      log.debug(`WhatsApp commands: dropped (${outcome.drop}).`);
  }
}

/** Called by the executor when a message from an unlisted number LOOKED like a
 *  deliberate command. That one is worth telling the admin about; ordinary
 *  conversation from a stranger is not. */
export function noteStrangerAttempt(digits: string): void {
  const now = Date.now();
  const last = strangerLogged.get(digits) ?? 0;
  if (now - last < 10 * 60_000) return;
  strangerLogged.set(digits, now);
  if (strangerLogged.size > 64) strangerLogged.clear();
  log.warn(`WhatsApp commands: a command from ${maskDigits(digits)} was ignored — that number is not on your list.`);
}

// ── lifecycle ────────────────────────────────────────────────────────────────────

async function reconcile(): Promise<void> {
  if (stopped) return;
  const d = await desired();

  if (!d.want) {
    if (socket) teardown();
    retryAt = 0;
    attempt = 0;
    setState(d.state, d.detail);
    return;
  }

  // A changed gateway, key or session must rebuild the connection. This is also what
  // handles stale-session recovery for free: recordSessionId('') changes the
  // fingerprint, we tear down, and desire drops to not-linked until a session exists.
  const fp = `${d.origin}|${d.sessionId}|${d.key.length}:${d.key.slice(-4)}`;
  if (socket && fp !== fingerprint) {
    log.info('WhatsApp commands: the gateway settings changed, reconnecting.');
    teardown();
  }
  fingerprint = fp;

  if (socket) {
    if (connectedAt && Date.now() - connectedAt > STABLE_MS) attempt = 0;
    if (state === 'connected' && !lastEventAt && Date.now() - connectedAt > SILENT_AFTER_MS) {
      setState('silent', 'Connected, but the gateway has not sent anything yet.');
    }
    return;
  }
  if (retryTimer) return; // a backoff is already pending
  await connect(d);
}

/** Poke the supervisor now — called from every settings mutation so the panel reacts
 *  immediately rather than up to 30 seconds later. */
export function reconcileWhatsAppInbound(): void {
  if (stopped) return;
  void reconcile();
}

export function startWhatsAppInbound(): void {
  if (!stopped) return;
  stopped = false;
  // Any change to who is allowed in tears down half-answered confirmations and
  // re-evaluates whether we should be connected at all.
  onCommandConfigChange(() => {
    resetConversations();
    reconcileWhatsAppInbound();
  });
  void reconcile();
  timer = setInterval(() => void reconcile(), RECONCILE_MS);
  timer.unref?.();
}

export function stopWhatsAppInbound(): void {
  stopped = true;
  if (timer) clearInterval(timer);
  if (retryTimer) clearTimeout(retryTimer);
  timer = null;
  retryTimer = null;
  teardown();
  resetConversations();
  setState('off', 'Commands are switched off.');
}
