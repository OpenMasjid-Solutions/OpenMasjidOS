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
 * Fabric call alike — goes through the ONE serialised queue below. Nothing is ever in
 * flight concurrently.
 *
 * This is also why we do NOT use OpenWA's `POST .../messages/send-bulk`. It paces
 * within a single request (3s default + jitter), which is fine in isolation and useless
 * across callers: two bulk requests still overlap. One queue is the only place the
 * real constraint can live.
 *
 * ── WHAT "HUMAN SENDING BEHAVIOUR" MEANS HERE ──────────────────────────────────
 *
 *  1. **Serialised.** One message in flight, ever.
 *  2. **Randomised gap.** `minGapSeconds` + up to `jitterSeconds` of noise. A FIXED
 *     interval is itself a fingerprint — a person does not reply every 6.00 seconds.
 *  3. **Typing indicator**, for a duration scaled to the message length (people take
 *     longer over longer messages), then `paused`, then the send.
 *  4. **Presence.** Appear online while working, offline once idle. A number that is
 *     permanently online and never reads anything looks like what it is.
 *  5. **Per-recipient cooldown.** One person is never hammered, even if three apps
 *     all have something to say to them.
 *  6. **Caps** per rolling hour and day, platform-wide.
 *  7. **Warm-up ramp.** A freshly linked number gets a fraction of the caps for
 *     `warmupDays` — the period WhatsApp watches hardest, per OpenWA's guidance.
 *  8. **Quiet hours.** Queued, never dropped. Also simply correct for a masjid: a fee
 *     reminder at 03:00 is a complaint waiting to happen.
 *  9. **Validate before first contact.** `contacts/check` confirms the number is on
 *     WhatsApp. Sending to numbers that aren't is a documented ban signal.
 * 10. **Never auth-critical.** This queues; it does not deliver. Callers are told so.
 *
 * None of this makes a ban impossible, and the module must not pretend otherwise —
 * `docs/WHATSAPP.md` states the residual risk plainly for the admin.
 */
import { log } from '../logger';
import { getInstalled } from '../apps/manager';
import {
  getWhatsAppConfig,
  isWhatsAppConfigured,
  recordSessionId,
  type WhatsAppConfig,
  type WhatsAppLimits,
} from '../store/whatsapp';

/** How long to wait on any single gateway call. */
const HTTP_TIMEOUT_MS = 15_000;
/** Cap the queue so a looping app can't grow it without bound. */
const MAX_QUEUE = 500;
/** A text longer than this is refused: WhatsApp's own limit is far higher, but a
 *  multi-thousand-character blast is neither human nor useful. */
const MAX_TEXT = 4096;
/** Retries for a transient failure before the message is dropped (and logged). */
const MAX_ATTEMPTS = 5;

export interface SendRequest {
  /** Recipient in international format. Punctuation is tolerated and stripped. */
  to: string;
  text: string;
  /** Who asked — an app id, or 'os' for platform alerts. Logged, never sent. */
  source: string;
}

interface QueueItem extends SendRequest {
  digits: string;
  enqueuedAt: number;
  /** Transient-failure retries so far. */
  attempts: number;
}

/** Outcome of a single attempt, for the caller's log and the admin's status panel. */
export interface SendOutcome {
  ok: boolean;
  /** Present when the gateway refused or was unreachable. Never includes the body. */
  error?: string;
  /**
   * True when the failure is worth retrying: rate limiting, a 5xx, or a network error.
   * FALSE for a refusal that will never succeed (a malformed request, a number that is
   * not on WhatsApp) — retrying those just burns the number's allowance.
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
 * Reduce a human-typed number to the digits WhatsApp wants.
 *
 * Deliberately strict about what it will NOT do: it never guesses a country code. A
 * number stored as "555 0123" could be in any country, and quietly prefixing the
 * platform's guess would send a masjid's fee reminder to a stranger. No country code
 * (fewer than 8 digits) is a refusal, not a repair.
 */
export function toDigits(raw: string): string | null {
  const digits = String(raw ?? '').replace(/[^0-9]/g, '');
  if (digits.length < 8 || digits.length > 15) return null; // E.164 allows max 15
  return digits;
}

/** OpenWA addresses individuals as `<digits>@c.us`. */
export function chatIdFor(digits: string): string {
  return `${digits}@c.us`;
}

// ── the gateway client ───────────────────────────────────────────────────────────

/** The catalog app id the platform looks for when no gateway URL was typed in. */
export const OPENWA_APP_ID = 'openwa';

/**
 * Where the gateway lives.
 *
 * Prefers an OpenWA installed from the App Store: the admin installs it with one
 * click and the platform finds it on `127.0.0.1:<published port>` — the same way the
 * Fabric broker reaches an app, and for the same reason (the URL is built only from
 * the registry, never from anything a request supplied, so there is no SSRF surface).
 *
 * An explicitly configured `baseUrl` still wins, for a masjid running OpenWA on
 * another machine, or one big enough to share a gateway between sites. So the field
 * stays — it is just no longer the only way in.
 */
export async function resolveBaseUrl(cfg: WhatsAppConfig): Promise<string | null> {
  if (cfg.baseUrl) return cfg.baseUrl;
  try {
    const app = await getInstalled(OPENWA_APP_ID);
    if (!app || !app.running) return null;
    const port = app.ports[0];
    if (!port) return null;
    return `http://127.0.0.1:${port}`;
  } catch {
    return null;
  }
}

async function call(
  cfg: WhatsAppConfig,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; json: unknown; error?: string }> {
  const base = await resolveBaseUrl(cfg);
  if (!base) {
    return { ok: false, status: 0, json: null, error: 'no WhatsApp gateway found — install OpenWA or set its address' };
  }
  const url = `${base}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'X-API-Key': cfg.apiKey,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* some endpoints return no body; not an error by itself */
    }
    if (!res.ok) {
      // The status is useful; the body may quote the message text, so it is not logged.
      return { ok: false, status: res.status, json, error: `gateway returned ${res.status}` };
    }
    return { ok: true, status: res.status, json };
  } catch (err) {
    const e = err as Error;
    return { ok: false, status: 0, json: null, error: e.name === 'TimeoutError' ? 'gateway timed out' : e.message };
  }
}

/**
 * OpenWA's session status enum, verified against its OpenAPI spec. Only `ready` means
 * "linked and able to send".
 *
 * Matching this EXACTLY matters: the first version tested the status with
 * `/connected|working|open|authenticated|ready/`, and `qr_ready` contains "ready" — so a
 * session that was merely waiting to be scanned reported as connected. That is precisely
 * backwards, and it is the state a new install spends most of its time in.
 */
const READY = 'ready';
const PENDING_STATUSES = new Set(['created', 'initializing', 'qr_ready', 'authenticating']);

export type SessionState = 'unconfigured' | 'unreachable' | 'no-session' | 'pending' | 'ready' | 'problem';

export interface GatewayStatus {
  state: SessionState;
  /** Kept for the UI's existing shape: reachable = the gateway answered at all. */
  reachable: boolean;
  connected: boolean;
  /** OpenWA's own status word, or our reason — shown to the admin verbatim. */
  detail: string;
}

/** Where the gateway and its session actually stand. */
export async function gatewayStatus(): Promise<GatewayStatus> {
  const cfg = getWhatsAppConfig();
  if (!isWhatsAppConfigured()) {
    return { state: 'unconfigured', reachable: false, connected: false, detail: 'not configured' };
  }
  // No session yet is NOT "unreachable" — the gateway may be perfectly healthy and simply
  // have nothing created on it. Reporting the two the same way sent the admin hunting for
  // a network fault that wasn't there.
  if (!cfg.sessionId) {
    const probe = await call(cfg, 'GET', '/api/sessions');
    if (!probe.ok) {
      return { state: 'unreachable', reachable: false, connected: false, detail: probe.error ?? 'unreachable' };
    }
    return { state: 'no-session', reachable: true, connected: false, detail: 'no session created yet' };
  }
  const r = await call(cfg, 'GET', `/api/sessions/${encodeURIComponent(cfg.sessionId)}`);
  if (!r.ok) {
    // A 404 here means the session we recorded is gone (deleted in OpenWA, or the volume
    // was wiped) — recoverable by creating another, so don't call the gateway unreachable.
    if (r.status === 404) {
      return { state: 'no-session', reachable: true, connected: false, detail: 'the session no longer exists' };
    }
    return { state: 'unreachable', reachable: false, connected: false, detail: r.error ?? 'unreachable' };
  }
  const s = r.json as { status?: unknown } | null;
  const word = String(s?.status ?? '').toLowerCase();
  if (word === READY) return { state: 'ready', reachable: true, connected: true, detail: word };
  if (PENDING_STATUSES.has(word)) return { state: 'pending', reachable: true, connected: false, detail: word };
  // disconnected / action_required / failed, or anything OpenWA adds later.
  return { state: 'problem', reachable: true, connected: false, detail: word || 'unknown state' };
}

/**
 * Make sure a session exists, creating one if not, and remember its id.
 *
 * The platform does this itself because OpenWA mints the id as a UUID and
 * `POST /api/sessions` takes only a name — so there is no env var an app entry could
 * seed, and the alternative was telling a volunteer to open OpenWA's own admin panel and
 * copy a UUID back into OpenMasjidOS. For a product whose premise is "zero technical
 * knowledge", that step could not stay.
 *
 * Idempotent: a 409 means the name is already taken (we created it on a previous boot and
 * lost the id, or the volume outlived our config), so look it up by name rather than
 * creating a second session on the same number.
 */
export async function ensureSession(): Promise<{ ok: boolean; id?: string; error?: string }> {
  const cfg = getWhatsAppConfig();
  if (!isWhatsAppConfigured()) return { ok: false, error: 'WhatsApp is not set up yet.' };
  if (cfg.sessionId) return { ok: true, id: cfg.sessionId };

  const name = (cfg.sessionName || 'openmasjid').replace(/[^A-Za-z0-9-]/g, '-');
  const created = await call(cfg, 'POST', '/api/sessions', { name });
  if (created.ok) {
    const id = (created.json as { id?: unknown } | null)?.id;
    if (typeof id === 'string' && id) {
      recordSessionId(id);
      log.info('WhatsApp: created a gateway session.');
      return { ok: true, id };
    }
    return { ok: false, error: 'the gateway created a session but returned no id' };
  }
  if (created.status === 409) {
    // Already there under this name — adopt it instead of making a duplicate.
    const list = await call(cfg, 'GET', '/api/sessions');
    if (list.ok) {
      const rows = Array.isArray(list.json)
        ? (list.json as { id?: unknown; name?: unknown }[])
        : ((list.json as { sessions?: { id?: unknown; name?: unknown }[] } | null)?.sessions ?? []);
      const mine = rows.find((s) => s?.name === name);
      if (mine && typeof mine.id === 'string') {
        recordSessionId(mine.id);
        log.info('WhatsApp: adopted the existing gateway session.');
        return { ok: true, id: mine.id };
      }
    }
    return { ok: false, error: `a session named "${name}" already exists but could not be read` };
  }
  return { ok: false, error: created.error ?? 'could not create a session' };
}

/** Ask the gateway for a pairing code so the admin can link the phone without a QR. */
export async function requestPairingCode(phone: string): Promise<{ ok: boolean; code?: string; error?: string }> {
  const cfg = getWhatsAppConfig();
  if (!isWhatsAppConfigured()) return { ok: false, error: 'WhatsApp is not set up yet.' };
  const digits = toDigits(phone);
  if (!digits) return { ok: false, error: 'That phone number needs a country code.' };
  const r = await call(cfg, 'POST', `/api/sessions/${encodeURIComponent(cfg.sessionId)}/pairing-code`, {
    phoneNumber: digits,
  });
  if (!r.ok) return { ok: false, error: r.error };
  const j = r.json as { code?: unknown; pairingCode?: unknown; data?: { code?: unknown } } | null;
  const code = j?.code ?? j?.pairingCode ?? j?.data?.code;
  return { ok: true, code: typeof code === 'string' ? code : undefined };
}

/**
 * Is this number registered on WhatsApp? Cached, because the answer rarely changes and
 * the check itself is traffic. `null` = could not tell, which must NOT be treated as
 * "no" (that would silently stop all sending when the gateway hiccups).
 */
const onWhatsApp = new Map<string, boolean>();

async function checkRegistered(cfg: WhatsAppConfig, digits: string): Promise<boolean | null> {
  const cached = onWhatsApp.get(digits);
  if (cached !== undefined) return cached;
  const r = await call(cfg, 'GET', `/api/sessions/${encodeURIComponent(cfg.sessionId)}/contacts/check/${digits}`);
  if (!r.ok) return null;
  const j = r.json as { exists?: unknown; isRegistered?: unknown; registered?: unknown; numberExists?: unknown } | null;
  const yes = j?.exists ?? j?.isRegistered ?? j?.registered ?? j?.numberExists;
  if (typeof yes !== 'boolean') return null;
  onWhatsApp.set(digits, yes);
  return yes;
}

// ── pacing ───────────────────────────────────────────────────────────────────────

/** Sends within the last rolling day, newest last. Used for both caps. */
const sentAt: number[] = [];
/** digits → last send, for the per-recipient cooldown. */
const lastToRecipient = new Map<string, number>();

function prune(now: number): void {
  const dayAgo = now - 86_400_000;
  while (sentAt.length > 0 && sentAt[0]! < dayAgo) sentAt.shift();
}

/**
 * The warm-up multiplier. A number linked today gets a quarter of the allowance; by
 * the end of the ramp it gets all of it. Returns 1 when nothing is known about when
 * the link happened — an unknown link date shouldn't lock a working masjid out.
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

/** Are we inside the admin's quiet hours? Handles a window that wraps midnight. */
export function inQuietHours(hour: number, limits: WhatsAppLimits): boolean {
  const { quietStartHour: s, quietEndHour: e } = limits;
  if (s === e) return false; // an empty window means "no quiet hours"
  return s < e ? hour >= s && hour < e : hour >= s || hour < e;
}

/**
 * Why the next send cannot happen yet, or null if it can. Pure so the whole policy is
 * testable without a gateway, a clock or a network.
 */
export function blockedReason(
  now: number,
  hour: number,
  digits: string,
  limits: WhatsAppLimits,
  linkedAt: string | null,
  history: { sends: number[]; lastPerRecipient: Map<string, number> },
): string | null {
  if (inQuietHours(hour, limits)) return 'quiet hours';

  const factor = warmupFactor(linkedAt, limits, now);
  // At least 1, so a warm-up ramp can never mean "send nothing at all".
  const hourCap = Math.max(1, Math.floor(limits.perHour * factor));
  const dayCap = Math.max(1, Math.floor(limits.perDay * factor));

  const inLastHour = history.sends.filter((t) => t > now - 3_600_000).length;
  if (inLastHour >= hourCap) return 'hourly limit reached';
  if (history.sends.length >= dayCap) return 'daily limit reached';

  const last = history.lastPerRecipient.get(digits);
  if (last !== undefined && now - last < limits.perRecipientCooldownSeconds * 1000) {
    return 'this recipient was messaged very recently';
  }
  return null;
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
let presenceOn = false;

export function queueDepth(): number {
  return queue.length;
}

/**
 * Enqueue a message. Returns immediately — this is a QUEUE, not a send. Human pacing
 * means delivery is seconds to hours away (quiet hours), so nothing auth-critical may
 * depend on it. That contract is stated to apps in `docs/WHATSAPP.md`.
 */
export function enqueue(req: SendRequest): { queued: boolean; error?: string } {
  if (!isWhatsAppConfigured()) return { queued: false, error: 'WhatsApp is not set up.' };
  const digits = toDigits(req.to);
  if (!digits) return { queued: false, error: 'That phone number needs a country code.' };
  const text = String(req.text ?? '').trim();
  if (!text) return { queued: false, error: 'The message is empty.' };
  if (text.length > MAX_TEXT) return { queued: false, error: `The message is too long (max ${MAX_TEXT}).` };
  if (queue.length >= MAX_QUEUE) return { queued: false, error: 'The WhatsApp queue is full. Try again later.' };

  queue.push({ to: req.to, text, source: req.source, digits, enqueuedAt: Date.now(), attempts: 0 });
  void pump();
  return { queued: true };
}

/**
 * Drain the queue, one message at a time, pausing for whatever the policy says. Never
 * runs twice concurrently — `running` is the whole point of this module.
 */
async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const cfg = getWhatsAppConfig();
      if (!isWhatsAppConfigured()) {
        // Configuration was removed under us; drop the backlog rather than spin.
        log.warn(`WhatsApp: gateway unconfigured, discarding ${queue.length} queued message(s).`);
        queue.length = 0;
        break;
      }
      const now = Date.now();
      prune(now);
      const item = queue[0]!;
      const reason = blockedReason(now, new Date(now).getHours(), item.digits, cfg.limits, cfg.linkedAt, {
        sends: sentAt,
        lastPerRecipient: lastToRecipient,
      });
      if (reason) {
        // Wait and re-evaluate rather than dropping. Quiet hours and rate caps are
        // delays, not failures — a fee reminder should arrive in the morning, not never.
        await setPresence(cfg, false);
        await sleep(60_000);
        continue;
      }

      // A session may not exist yet (fresh install, or the gateway's volume was wiped).
      // Creating it is the platform's job, and failing is transient — wait, don't drop.
      if (!cfg.sessionId) {
        const s = await ensureSession();
        if (!s.ok) {
          log.warn(`WhatsApp: no usable session yet (${s.error ?? 'unknown'}); will retry.`);
          await sleep(60_000);
          continue;
        }
      }

      await setPresence(cfg, true);
      const outcome = await sendOne(cfg, item);

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
          await sleep(backoff);
          continue; // keep it at the head of the queue
        }
        log.error(`WhatsApp: giving up on a message for ${item.source} after ${MAX_ATTEMPTS} attempts.`);
      }

      queue.shift();
      if (outcome.ok) {
        sentAt.push(Date.now());
        lastToRecipient.set(item.digits, Date.now());
      }
      if (queue.length > 0) await sleep(nextGapMs(cfg.limits));
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
  const chatId = chatIdFor(item.digits);

  // Don't message a number that isn't on WhatsApp — a documented ban signal. `null`
  // means "couldn't check", which proceeds: an unreachable check must not become an
  // outage.
  const registered = await checkRegistered(cfg, item.digits);
  if (registered === false) {
    log.warn(`WhatsApp: ${item.source} addressed a number that is not on WhatsApp — skipped.`);
    return { ok: false, error: 'that number is not on WhatsApp', retryable: false };
  }

  // Type, pause, then send — in that order, because that is the order a person does it.
  await call(cfg, 'POST', `/api/sessions/${encodeURIComponent(cfg.sessionId)}/chats/typing`, {
    chatId,
    state: 'typing',
  });
  await sleep(typingMs(item.text));
  await call(cfg, 'POST', `/api/sessions/${encodeURIComponent(cfg.sessionId)}/chats/typing`, {
    chatId,
    state: 'paused',
  });

  const r = await call(cfg, 'POST', `/api/sessions/${encodeURIComponent(cfg.sessionId)}/messages/send-text`, {
    chatId,
    text: item.text,
    // No link preview: fetching one is an extra outbound request from the number and
    // makes an automated message look more like a broadcast.
    linkPreview: false,
  });
  if (!r.ok) {
    return { ok: false, error: r.error, retryable: isRetryableStatus(r.status) };
  }
  log.info(`WhatsApp: delivered a message for ${item.source}.`);
  return { ok: true };
}

/**
 * Send one message and WAIT for the outcome — used only by the admin's "send test
 * message" button, which needs a real answer on screen. It still goes through the same
 * gateway calls, but bypasses the queue: a test the admin is watching should not sit
 * behind a backlog or wait out quiet hours.
 */
export async function sendTestMessage(to: string, text: string): Promise<SendOutcome> {
  const cfg = getWhatsAppConfig();
  if (!isWhatsAppConfigured()) return { ok: false, error: 'WhatsApp is not set up yet.' };
  const digits = toDigits(to);
  if (!digits) return { ok: false, error: 'That phone number needs a country code.' };
  const outcome = await sendOne(cfg, { to, text, source: 'os:test', digits, enqueuedAt: Date.now(), attempts: 0 });
  if (outcome.ok) {
    sentAt.push(Date.now());
    lastToRecipient.set(digits, Date.now());
  }
  return outcome;
}

/** Test seam: forget pacing history so a test starts from a known state. */
export function __resetPacingForTests(): void {
  sentAt.length = 0;
  lastToRecipient.clear();
  onWhatsApp.clear();
  queue.length = 0;
  presenceOn = false;
}
