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
 * HOW OPENWA'S REAL-TIME API ACTUALLY WORKS. None of this is in its public docs; it
 * was read out of the gateway source after a first attempt connected cleanly and then
 * received nothing at all, forever. Three things, and getting any one wrong produces
 * exactly that symptom:
 *
 *   1. The gateway lives on the `/events` NAMESPACE. Connecting to the default root
 *      namespace succeeds and joins a socket nothing ever emits to.
 *   2. Delivery is entirely ROOM-SCOPED (`session:<id>:<event>`), and rooms are joined
 *      only by sending a subscribe frame. There is no firehose and no auto-join, so a
 *      connected-but-unsubscribed client is in zero rooms and hears nothing.
 *   3. Every server frame arrives on the single Socket.IO channel `'message'`. The
 *      WhatsApp event name is INSIDE the payload, at `payload.event`. Listening for a
 *      channel called `message.received` can therefore never fire.
 *
 * The same channel also carries ERROR frames (`UNAUTHORIZED`, `FORBIDDEN_SESSION`, …).
 * A bad key is not refused at the handshake — the connection is accepted, an error
 * frame is sent, and the socket is closed. So not listening on `'message'` also meant
 * silently discarding the one message that would have explained the silence.
 *
 * This module NEVER sends. Replies go out through notify/whatsapp.ts, which owns the
 * one queue and the budget.
 */
import type { Socket } from 'socket.io-client';
import { log } from '../logger';
import { areCommandsEnabled, listCommandPeople, onCommandConfigChange } from '../store/commands';
import { getWhatsAppConfig, isWhatsAppConfigured } from '../store/whatsapp';
import { maskDigits } from '../util/phone';
import { gate, gateMessage, type GateOutcome } from '../commands/gate';
import { normaliseInbound } from '../commands/normalise';
import { resetConversations } from '../commands/conversation';
import { gatewayStatus, resolveBaseUrl, resolveLidPhone } from './whatsapp';

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
  /**
   * The last raw transport packet, set below the application layer entirely.
   *
   * Packets flowing with no events means the server is not emitting to our room;
   * no packets at all means the socket is not really carrying anything despite
   * reporting connected. Those need opposite fixes and look identical without this.
   */
  lastPacketAt: string | null;
  retryInMs: number | null;
  /** Volume only, no content. */
  counters: { seen: number; ran: number; ignoredUnknown: number; unparseable: number };
  /**
   * Distinct event NAMES the gateway has emitted, most recent first.
   *
   * Names only — never a payload, never a body. This exists because OpenWA does not
   * document its real-time event names, so "the socket is up but nothing is arriving"
   * has two very different causes that look identical from outside: the gateway is
   * genuinely emitting nothing, or it is emitting something our filter does not
   * recognise. An empty list distinguishes them in one glance, and a non-empty one
   * hands over the exact string the filter needs to match.
   */
  eventNames: string[];
  /** How the subscribe went. Three outcomes a single boolean used to collapse. */
  subscribeAck: AckState;
  /** The gateway's code when it refused us, e.g. FORBIDDEN_SESSION. */
  subscribeAckCode: string;
  /**
   * Why messages were discarded, counted by reason.
   *
   * The single most useful diagnostic here, because most of the gate's fourteen drops
   * are debug-level only — so a message that DID arrive and was thrown away looked
   * exactly like nothing arriving at all. These are reason words and integers; no
   * content of any kind.
   */
  dropped: Record<string, number>;
}

/** The namespace the gateway's Socket.IO server is mounted on. Not the root. */
const EVENTS_NAMESPACE = '/events';
/** Every server frame — events, subscribe acks and errors — arrives on this channel. */
const FRAME_CHANNEL = 'message';
/** The one `payload.event` we act on. */
const INBOUND_EVENT = 'message.received';

// ── event-name filtering ─────────────────────────────────────────────────────────

/**
 * Does this `payload.event` name carry an inbound message?
 *
 * Applied to the name INSIDE the frame, never to the Socket.IO channel (which is
 * always `message`). The reject-list is checked first and matters most: `message.ack`
 * is emitted for every message we ourselves send, so treating one as inbound would
 * re-run a command on the delivery receipt of its own reply.
 */
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
/** Raw engine traffic, set independently of anything the application layer parses. */
let lastPacketAt = 0;
/** True once the gateway has acked our subscribe. Until then we are in no rooms. */
let subscribed = false;
/** How the subscribe went — three outcomes that a single boolean collapsed into one. */
export type AckState = 'pending' | 'confirmed' | 'timed-out' | 'refused';
let ackState: AckState = 'pending';
let ackCode = '';
/** Generous: this is one round trip on a LAN, but a busy gateway can be slow to boot. */
const SUBSCRIBE_ACK_MS = 10_000;
let lastProbeAt = 0;
let stopped = true;
let state: InboundState = 'off';
let detail = 'Commands are switched off.';
let retryAt = 0;
const counters = { seen: 0, ran: 0, ignoredUnknown: 0, unparseable: 0 };
/** Drop reason → count. Reason words and integers only, never content. */
const dropped: Record<string, number> = {};
/** Distinct event names seen, newest first. Names are schema, not content. */
const eventNames: string[] = [];
const MAX_EVENT_NAMES = 12;

function noteEventName(event: string): void {
  const name = String(event).slice(0, 60);
  const at = eventNames.indexOf(name);
  if (at === 0) return;
  if (at > 0) eventNames.splice(at, 1);
  eventNames.unshift(name);
  if (eventNames.length > MAX_EVENT_NAMES) eventNames.length = MAX_EVENT_NAMES;
}

/**
 * Record the SHAPE of a frame we are about to discard — key names only, never values.
 *
 * Groundwork, not a feature. WhatsApp delivery receipts would let the platform say a
 * message actually ARRIVED instead of "the gateway accepted it", which is the difference
 * that let an outage go unnoticed with everything recorded as sent. Those receipts plausibly
 * already reach this socket: it subscribes to `'*'`, and `handleFrame` drops every non-message
 * frame unread. But OpenWA does not document its event names or payloads, and this codebase
 * has been burned once by gateway client code written from memory — so the shape gets
 * OBSERVED on real gateways before anything is built on it.
 *
 * KEYS ONLY, and that is a hard rule. An ack frame plausibly carries a phone number or a
 * chat id; this is a diagnostic surfaced in the dashboard, so it must not become a place
 * where recipients quietly accumulate. Capped, truncated, and no nested values.
 */
const eventShapes = new Map<string, string>();
const MAX_EVENT_SHAPES = 12;

function noteEventShape(event: string, data: unknown): void {
  const name = String(event).slice(0, 60);
  if (eventShapes.has(name)) return;
  if (eventShapes.size >= MAX_EVENT_SHAPES) return;
  let shape = typeof data;
  if (data && typeof data === 'object') {
    const keys = Object.keys(data as Record<string, unknown>).slice(0, 12).join(', ');
    shape = `{ ${keys} }` as unknown as typeof shape;
  }
  eventShapes.set(name, String(shape).slice(0, 200));
}

/** The observed frame shapes, for the Commands diagnostics panel. Keys, never values. */
export function observedEventShapes(): { event: string; shape: string }[] {
  return [...eventShapes.entries()].map(([event, shape]) => ({ event, shape }));
}
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
    lastPacketAt: lastPacketAt ? new Date(lastPacketAt).toISOString() : null,
    retryInMs: retryAt ? Math.max(0, retryAt - Date.now()) : null,
    counters: { ...counters },
    eventNames: [...eventNames],
    subscribeAck: ackState,
    subscribeAckCode: ackCode,
    dropped: { ...dropped },
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
  subscribed = false;
}

async function connect(d: Extract<Desire, { want: true }>): Promise<void> {
  // Loaded on demand: the overwhelming majority of masjids never turn this on, and
  // "runs comfortably on a Pi" is a stated value (CLAUDE.md §19).
  const { io } = await import('socket.io-client');
  setState('connecting', 'Connecting to the gateway…');

  // The NAMESPACE is part of the URL for socket.io-client. Connecting to `d.origin`
  // alone lands on the root namespace, which this gateway never emits to.
  const s = io(`${d.origin}${EVENTS_NAMESPACE}`, {
    path: process.env.OPENMASJID_OPENWA_SOCKET_PATH ?? '/socket.io',
    auth: { apiKey: d.key },
    // Not websocket-only: socket.io-client only guarantees extraHeaders on the
    // polling handshake, and X-API-Key is the fallback the gateway reads.
    extraHeaders: { 'X-API-Key': d.key },
    // WE own the backoff — socket.io's own retry knows nothing about the other four
    // preconditions and would hammer a deliberately stopped gateway.
    reconnection: false,
    timeout: 20_000,
    forceNew: true,
    autoConnect: false,
  });
  socket = s;
  const sessionId = d.sessionId;

  s.on('connect', () => {
    connectedAt = Date.now();
    // Otherwise retryInMs keeps counting down a retry that already happened.
    retryAt = 0;
    authFailures = 0;
    subscribed = false;
    ackState = 'pending';
    setState('connected', 'Connected — subscribing…');

    // Rooms are the ONLY delivery path, and they are joined here or not at all.
    // Subscribing to this session explicitly rather than to '*': a key scoped to
    // particular sessions is refused the wildcard (FORBIDDEN_SESSION).
    //
    // THE CALLBACK IS LOAD-BEARING. The gateway's subscribe handler RETURNS its reply
    // rather than emitting it, and NestJS's socket.io adapter routes a returned value
    // as `if (response.event) socket.emit(...) else ack(response)`. The reply carries
    // `type`, not `event` — so without a callback here the adapter simply drops it.
    // The subscribe itself still works (the room join happens before the return),
    // which is exactly what makes this easy to miss: messages arrive fine while we
    // report "unconfirmed" forever. A REFUSAL rides the same ack, so dropping it also
    // discards the one frame that would explain a real failure.
    // Subscribing to EVERY event for this session, not just message.received.
    //
    // The emitter unions `session:<id>:<event>` with `session:<id>:*`, so the wildcard
    // is a superset — and on the install this was debugged against, a socket confirmed
    // in the exact `message.received` room still received nothing at all while the
    // gateway was demonstrably recording inbound messages. A wildcard room removes the
    // event name as a variable, and makes every other event the session emits visible
    // to the diagnostic, which is what turns the next failure into a fact.
    //
    // The extra traffic is a handful of frames on a LAN, all of which `isMessageEvent`
    // discards. Note this is the EVENT wildcard, not the session one: a key scoped to
    // particular sessions is refused `sessionId: '*'`, but `events: ['*']` is
    // explicitly allowed.
    s.timeout(SUBSCRIBE_ACK_MS).emit(
      FRAME_CHANNEL,
      { type: 'subscribe', sessionId, events: ['*'] },
      (err: Error | null, reply: unknown) => {
        if (err) {
          // No ack inside the window. The rooms may well be joined anyway, so this is
          // reported as unconfirmed — never as a failure that stops us listening.
          ackState = 'timed-out';
          log.warn('WhatsApp commands: the gateway did not acknowledge our subscription.');
          return;
        }
        // Shared with the channel listener on purpose: if a future gateway emits the
        // ack instead of returning it, both routes set `subscribed`.
        handleFrame(reply);
      },
    );
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

  // Everything the gateway says arrives here: subscribe acks, errors, and events.
  s.on(FRAME_CHANNEL, (frame: unknown) => {
    lastEventAt = Date.now();
    handleFrame(frame);
  });

  // Raw transport activity, independent of anything the application layer does with
  // it. This is the one signal that separates "the server is not emitting to us" from
  // "the socket is not really carrying anything" — two states that look identical
  // from a `connected` flag and an empty event list.
  s.io.engine?.on('packet', () => {
    lastPacketAt = Date.now();
  });

  // Kept purely as a diagnostic. If the gateway ever moves to another channel, this
  // is what shows the new name instead of leaving us with silence to interpret.
  s.onAny((event: string) => {
    if (event !== FRAME_CHANNEL) {
      lastEventAt = Date.now();
      noteEventName(`channel:${event}`);
    }
  });

  s.connect();
}

/** One frame from the gateway. Names and types only ever reach the log — never data. */
function handleFrame(frame: unknown): void {
  const f = frame && typeof frame === 'object' ? (frame as Record<string, unknown>) : null;
  if (!f) return;
  const type = typeof f.type === 'string' ? f.type : '';

  // Record EVERY frame by type, before any branch can discard it. Without this,
  // "the gateway sent nothing" and "the gateway sent something I didn't recognise"
  // are the same empty list — and they need completely different fixes.
  noteEventName(`frame:${type || 'untyped'}`);

  if (type === 'subscribed') {
    subscribed = true;
    ackState = 'confirmed';
    setState('connected', 'Listening for commands.');
    return;
  }

  if (type === 'error') {
    // A bad key is NOT a handshake rejection here — it is one of these, followed by a
    // disconnect. Surfacing the code is the difference between "commands are broken"
    // and "the key is wrong" / "that key may not watch this session".
    const code = typeof f.code === 'string' ? f.code : 'unknown';
    // A refusal of the SUBSCRIBE arrives the same way, and is the difference between
    // "the gateway is unhappy with us" and "that key may not watch this session".
    if (!subscribed) {
      ackState = 'refused';
      ackCode = code;
    }
    noteEventName(`error:${code}`);
    if (/UNAUTHORIZED|FORBIDDEN/i.test(code)) authFailures += 1;
    setState('error', `The gateway refused the connection (${code}).`);
    log.warn(`WhatsApp commands: the gateway sent an error frame (${code}).`);
    return;
  }

  if (type !== 'event') return; // 'pong' and anything else we do not act on

  const payload = f.payload && typeof f.payload === 'object' ? (f.payload as Record<string, unknown>) : null;
  const name = payload && typeof payload.event === 'string' ? payload.event : '';
  if (!payload || !name) return;
  noteEventName(name);

  // Filter on the INNER name. `message.ack` fires for every message we send, so
  // treating one as inbound would re-run a command on its own reply's receipt.
  if (!isMessageEvent(name)) {
    // Record what it looked like before dropping it. See `noteEventShape` — this is how we
    // find out whether delivery receipts are reachable, without guessing at a payload.
    noteEventShape(name, payload.data);
    log.debug(`WhatsApp commands: ignoring gateway event "${name}".`);
    return;
  }
  void handleInbound(name, [payload.data]);
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
    kick();
  }, wait);
  retryTimer.unref?.();
}

// ── the message path ─────────────────────────────────────────────────────────────

async function handleInbound(event: string, args: unknown[]): Promise<void> {
  const ctx = { now: Date.now(), connectedAt: connectedAt || Date.now() };

  // Resolve a privacy-id sender BEFORE gating, not as a retry: the gate's duplicate
  // suppression and rate-limit bucket have side effects, so running it twice for one
  // message would double-count both.
  const parsed = normaliseInbound(args);
  let outcome: GateOutcome;
  if (!parsed.ok) {
    outcome = gate(args, ctx);
  } else {
    let msg = parsed.msg;
    if (msg.senderJid) {
      const phone = await resolveLidPhone(msg.senderJid);
      if (phone) msg = { ...msg, fromDigits: phone };
    }
    outcome = gateMessage(msg, ctx);
  }

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

  // Counted before the switch, so every reason is recorded — including the six that
  // are otherwise debug-only and therefore invisible on a real install.
  dropped[outcome.drop] = (dropped[outcome.drop] ?? 0) + 1;

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
      // The log line CLAUDE.md §13.2b-iii promises. It never actually happened:
      // `noteStrangerAttempt` existed, was documented as "called by the executor",
      // and had no callers — so someone probing a masjid's server with `!os` left
      // no trace anywhere. Still no reply, ever; only a rate-limited warning in the
      // masjid's own log.
      if (outcome.prefixed && outcome.digits) noteStrangerAttempt(outcome.digits);
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

/**
 * Run reconcile without letting a failure vanish.
 *
 * `desired()` shells to Docker and makes an HTTP call, and every caller used a bare
 * `void reconcile()` — so a throw became an unhandled rejection with no log line and
 * no state change, leaving the panel frozen on its last value and indistinguishable
 * from a healthy connection.
 */
function kick(): void {
  void reconcile().catch((err) => {
    log.warn(`WhatsApp commands: a connection check failed — ${(err as Error).message}`);
  });
}

let reconciling = false;
let reconcilePending = false;

async function reconcile(): Promise<void> {
  if (stopped) return;
  // Reentrancy guard: reconcileWhatsAppInbound() fires on every settings mutation
  // while this function awaits twice, and two concurrent entries can each build a
  // socket — leaving one orphaned with its listeners still attached.
  if (reconciling) {
    reconcilePending = true;
    return;
  }
  reconciling = true;
  try {
    await reconcileInner();
  } finally {
    reconciling = false;
    if (reconcilePending) {
      reconcilePending = false;
      kick();
    }
  }
}

async function reconcileInner(): Promise<void> {
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
    // 'silent' means "we have reason to think this is broken", NOT "nothing arrived".
    // A subscribed socket with no traffic is the normal state of a masjid nobody has
    // messaged yet — flagging that as a fault trains an admin to ignore the dot, and
    // it was wrong on the one install it ran on.
    //
    // Not latching, either: a late ack must be able to clear it, which the old
    // `state === 'connected'` guard made impossible.
    if (state === 'silent' && subscribed) setState('connected', 'Listening for commands.');
    if (!subscribed && state === 'connected' && connectedAt && Date.now() - connectedAt > SILENT_AFTER_MS) {
      setState(
        'silent',
        ackState === 'refused'
          ? `The gateway refused our subscription (${ackCode}).`
          : 'Connected, but the gateway did not confirm the subscription.',
      );
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
  kick();
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
  kick();
  timer = setInterval(() => kick(), RECONCILE_MS);
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
