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
 * READ THIS LIST AS THE CURRENT CONTRACT. It was written when the pacer had a full set
 * of brakes; almost all of them have since been removed at the maintainer's direction,
 * and for a while this header still advertised four that no longer existed — which is
 * the most dangerous kind of stale comment, because it is the first thing anyone reads
 * before deciding whether a change here is safe.
 *
 *  1. **Serialised.** One message in flight, ever. This is the one that still carries
 *     real weight: ban risk attaches to the NUMBER, so two callers each sending
 *     "politely" at once is still a burst.
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
  MAX_HELD_MS,
  type OutcomeRecord,
  type OutcomeState,
  type StoredItem,
} from './whatsapp-queue-store';
import { getInstalled } from '../apps/manager';
import { OPENWA_APP_ID } from '../apps/managed';
import { appOrigin } from '../system/app-host';
import { chatIdFor, toDigits } from '../util/phone';
import {
  getWhatsAppConfig,
  isWhatsAppConfigured,
  recordSessionId,
  recordLinkedPhone,
  isApprovedGroup,
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

/**
 * Who a message is for.
 *
 * A group is not "a recipient with a funny number": it has its own address space
 * (`@g.us` rather than `@c.us`), its own rate budget (one message reaches everyone, so
 * it must not spend the allowance individual reminders need), and `contacts/check` is
 * meaningless for it. Making the distinction a type rather than a string test means
 * every place that treats the two differently has to say so.
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
 * Queued items are persisted, and a cap or the warm-up ramp can hold them — on a Raspberry
 * Pi that matters. Four at the 2 MB cap is ~11 MB held worst case (base64 is 4/3 the
 * bytes). Beyond that an app is REFUSED with a clear message rather than the platform
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

/** The pacing key for a target — also the cooldown map's key, so a person and a group
 *  can never collide (`@g.us` cannot appear in a digits-only string). */
function targetKey(t: Target): string {
  return t.kind === 'person' ? t.digits : `group:${t.groupId}`;
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

// ── the gateway client ───────────────────────────────────────────────────────────

/** The catalog app id the platform looks for when no gateway URL was typed in. Defined
 *  in `apps/managed.ts`, which is also what hides it from the dashboard and the store. */
export { OPENWA_APP_ID };

/**
 * Where the gateway lives.
 *
 * Prefers an OpenWA installed from the App Store: the admin installs it with one click
 * and the platform finds it at its published host port via `appHost()` — the same target
 * the Fabric broker and the reverse proxies use, and for the same reason (the URL is
 * built only from the registry plus a fixed host name, never from anything a request
 * supplied, so there is no SSRF surface).
 *
 * The address MUST come from `appHost()`. The first version hardcoded `127.0.0.1`, which
 * inside the core container is the core itself — so the gateway was unreachable on every
 * install, no matter how correctly OpenWA was set up. See `system/app-host.ts`.
 *
 * An explicitly configured `baseUrl` still wins, for a masjid running OpenWA on another
 * machine, or one big enough to share a gateway between sites.
 *
 * Returns a REASON rather than a bare null: "not installed", "installed but stopped" and
 * "running but publishing no port" have three different fixes, and collapsing them into
 * one "cannot reach the gateway" is what made this bug take a round-trip to diagnose.
 */
export type GatewayAddress = { url: string; reason?: undefined } | { url: null; reason: string };

export async function resolveBaseUrl(cfg: WhatsAppConfig): Promise<GatewayAddress> {
  if (cfg.baseUrl) return { url: cfg.baseUrl };
  let app;
  try {
    app = await getInstalled(OPENWA_APP_ID);
  } catch {
    return { url: null, reason: 'could not read the list of installed apps' };
  }
  if (!app) return { url: null, reason: 'OpenWA is not installed — install it from the App Store' };
  if (!app.running) return { url: null, reason: 'OpenWA is installed but not running' };
  const port = app.ports[0];
  if (!port) return { url: null, reason: 'OpenWA is running but is not publishing a port' };
  return { url: appOrigin(port) };
}

/**
 * Turn a `fetch` rejection into something an admin can act on.
 *
 * undici reports every transport failure as the same useless `TypeError: fetch failed`
 * and hides the real cause one level down in `.cause`. That is exactly what a masjid saw
 * when this module was pointed at the wrong host: "fetch failed", with no hint that the
 * address was the problem.
 */
function describeFetchError(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  if (e?.name === 'TimeoutError') return 'the gateway did not answer in time';
  switch (e?.cause?.code) {
    case 'ECONNREFUSED':
      return 'nothing is listening at the gateway address';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'the gateway address could not be found';
    case 'ECONNRESET':
      return 'the gateway closed the connection';
    case 'ETIMEDOUT':
      return 'the gateway did not answer in time';
    default:
      return 'the gateway could not be reached';
  }
}

async function call(
  cfg: WhatsAppConfig,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; json: unknown; error?: string }> {
  const addr = await resolveBaseUrl(cfg);
  if (!addr.url) {
    return { ok: false, status: 0, json: null, error: addr.reason };
  }
  const base = addr.url;
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
      // The status and the path are useful for support; the body may quote the message
      // text, so it is never logged.
      log.warn(`WhatsApp: gateway ${method} ${path} returned ${res.status} (${base}).`);
      return { ok: false, status: res.status, json, error: `the gateway returned ${res.status}` };
    }
    return { ok: true, status: res.status, json };
  } catch (err) {
    // Log the ADDRESS as well as the reason. Without it, a misconfigured (or, as in
    // 0.50.4-dev.2, a wrongly-derived) gateway address is indistinguishable in the log
    // from a gateway that is simply down.
    const reason = describeFetchError(err);
    log.warn(`WhatsApp: gateway ${method} ${path} failed — ${reason} (${base}).`);
    return { ok: false, status: 0, json: null, error: reason };
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

export type SessionState =
  | 'unconfigured'
  | 'unreachable'
  | 'bad-key'
  | 'no-session'
  | 'pending'
  | 'ready'
  | 'problem';

export interface GatewayStatus {
  state: SessionState;
  /** Kept for the UI's existing shape: reachable = the gateway answered at all. */
  reachable: boolean;
  connected: boolean;
  /** OpenWA's own status word, or our reason — shown to the admin verbatim. */
  detail: string;
  /**
   * A limit WhatsApp itself has placed on the number, when the gateway reports one. This
   * is the risk the whole feature is hedged against actually materialising, so it must
   * reach the admin rather than being swallowed — `reachout_timelock` still allows
   * existing chats, while `tos_block` and `proxy_block` mean the number is finished.
   */
  restriction?: string | null;
  /** The number currently linked, when the gateway knows it. Confirms which phone is in use. */
  phone?: string | null;
}

/**
 * Reachability is "something answered", NOT "the request succeeded".
 *
 * Any HTTP status — including 401 and 404 — proves a server is there, so only a
 * transport failure (`status === 0`) means unreachable. Requiring a 200 made the state
 * depend on OpenWA's exact routes: a renamed listing endpoint would have reported a
 * perfectly healthy gateway as down.
 */
function transportFailed(r: { ok: boolean; status: number }): boolean {
  return !r.ok && r.status === 0;
}

/** A rejected key is its own fix ("re-paste it"), so it gets its own state. */
function keyRejected(r: { ok: boolean; status: number }): boolean {
  return !r.ok && (r.status === 401 || r.status === 403);
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
    if (transportFailed(probe)) {
      return { state: 'unreachable', reachable: false, connected: false, detail: probe.error ?? 'unreachable' };
    }
    if (keyRejected(probe)) {
      return { state: 'bad-key', reachable: true, connected: false, detail: 'the gateway rejected the API key' };
    }
    return { state: 'no-session', reachable: true, connected: false, detail: 'no session created yet' };
  }
  const r = await call(cfg, 'GET', `/api/sessions/${encodeURIComponent(cfg.sessionId)}`);
  if (!r.ok) {
    if (transportFailed(r)) {
      return { state: 'unreachable', reachable: false, connected: false, detail: r.error ?? 'unreachable' };
    }
    if (keyRejected(r)) {
      return { state: 'bad-key', reachable: true, connected: false, detail: 'the gateway rejected the API key' };
    }
    // A 404 here means the session we recorded is gone (deleted in OpenWA, or the volume
    // was wiped) — recoverable by creating another, so don't call the gateway unreachable.
    if (r.status === 404) {
      return { state: 'no-session', reachable: true, connected: false, detail: 'the session no longer exists' };
    }
    return { state: 'problem', reachable: true, connected: false, detail: r.error ?? 'unknown state' };
  }
  const s = r.json as { status?: unknown; phone?: unknown; restriction?: { kind?: unknown } | null } | null;
  const word = String(s?.status ?? '').toLowerCase();
  const extra = {
    restriction: typeof s?.restriction?.kind === 'string' ? s.restriction.kind : null,
    phone: typeof s?.phone === 'string' ? s.phone : null,
  };
  // Remember which number we are linked to, so `enqueue` can refuse a message addressed
  // to ourselves without making a network call.
  if (extra.phone) recordLinkedPhone(extra.phone);
  if (word === READY) return { state: 'ready', reachable: true, connected: true, detail: word, ...extra };
  if (PENDING_STATUSES.has(word)) {
    return { state: 'pending', reachable: true, connected: false, detail: word, ...extra };
  }
  // disconnected / action_required / failed, or anything OpenWA adds later.
  return { state: 'problem', reachable: true, connected: false, detail: word || 'unknown state', ...extra };
}

/** A group the linked phone belongs to, as OpenWA reports it. */
export interface GatewayGroup {
  id: string;
  name: string;
  participants?: number;
  /** Whether the linked number is an admin — required to post in an announcement group. */
  isAdmin?: boolean;
  /** Set when this group belongs to a WhatsApp Community (it is the Community's JID). */
  community?: boolean;
}

/**
 * List the groups the linked phone is in, for the ADMIN to choose from.
 *
 * Never exposed to apps. This is the masjid's whole group membership — personal chats
 * included — and the entire point of the approval step is that an app sees only what an
 * admin deliberately put in front of it.
 */
export async function listGatewayGroups(): Promise<{ ok: boolean; groups?: GatewayGroup[]; error?: string }> {
  const cfg = getWhatsAppConfig();
  if (!isWhatsAppConfigured()) return { ok: false, error: 'WhatsApp is not set up yet.' };
  if (!cfg.sessionId) return { ok: false, error: 'No phone is linked yet.' };
  const r = await call(cfg, 'GET', `/api/sessions/${encodeURIComponent(cfg.sessionId)}/groups?limit=200`);
  if (!r.ok) return { ok: false, error: r.error };
  const rows = Array.isArray(r.json) ? (r.json as Record<string, unknown>[]) : [];
  const groups = rows
    .filter((g) => typeof g.id === 'string')
    .map((g) => ({
      id: g.id as string,
      name: typeof g.name === 'string' && g.name.trim() ? g.name : (g.id as string),
      participants: typeof g.participantsCount === 'number' ? g.participantsCount : undefined,
      isAdmin: typeof g.isAdmin === 'boolean' ? g.isAdmin : undefined,
      community: typeof g.linkedParentJID === 'string' && g.linkedParentJID.length > 0,
    }));
  return { ok: true, groups };
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

/**
 * Bring the session's engine up, because a created session is not a started one.
 *
 * OpenWA's lifecycle is create → **start** → pair. A session that was only created has no
 * engine at all, and every engine route answers `400 Session is not started` — which is
 * exactly the "the gateway returned 400" a masjid hit when trying to link: the status
 * panel said "gateway running, no phone linked yet" (true — the session existed) while
 * linking could never work, because nothing had ever started it.
 *
 * Idempotent, three ways, since this runs before every link attempt:
 *   - already `ready` → linked; nothing to do, and starting again would be wrong
 *   - `engineLoaded` → an engine is already live, which `start` explicitly refuses
 *   - `400` from start → "already started", which is the outcome we wanted anyway
 */
async function ensureStarted(cfg: WhatsAppConfig): Promise<{ ok: boolean; ready?: boolean; error?: string }> {
  const r = await call(cfg, 'GET', `/api/sessions/${encodeURIComponent(cfg.sessionId)}`);
  // The recorded id can outlive the session it names: OpenWA's volume was wiped, the
  // session was deleted in its UI, or the gateway was reinstalled. Every later call then
  // 404s forever with nothing to click, so forget the id and let the caller create
  // another — the id is ours to manage, which means ours to re-mint.
  if (r.status === 404) {
    log.warn('WhatsApp: the recorded session no longer exists at the gateway; creating a new one.');
    recordSessionId('');
    return { ok: false, error: 'stale-session' };
  }
  if (!r.ok) return { ok: false, error: r.error ?? 'could not read the session' };
  const s = r.json as { status?: unknown; engineLoaded?: unknown } | null;
  const status = String(s?.status ?? '').toLowerCase();
  if (status === READY) return { ok: true, ready: true };
  if (s?.engineLoaded === true) return { ok: true };

  const started = await call(cfg, 'POST', `/api/sessions/${encodeURIComponent(cfg.sessionId)}/start`);
  // 400 here is OpenWA's "session already started" — the state we were aiming for.
  if (started.ok || started.status === 400) return { ok: true };
  if (started.status === 409) {
    // A teardown from a previous session is still settling, or another node holds the
    // engine. Documented as retryable, so say so rather than reporting a hard failure.
    return { ok: false, error: 'The gateway is still finishing a previous operation. Try again in a moment.' };
  }
  return { ok: false, error: started.error ?? 'could not start the session' };
}

/**
 * Ask the gateway for a pairing code so the admin can link the phone without a QR.
 *
 * Creates the session if needed, starts it, then asks — the exact order OpenWA documents.
 */
export async function requestPairingCode(phone: string): Promise<{ ok: boolean; code?: string; error?: string }> {
  const cfg0 = getWhatsAppConfig();
  if (!isWhatsAppConfigured()) return { ok: false, error: 'WhatsApp is not set up yet.' };
  const digits = toDigits(phone);
  if (!digits) return { ok: false, error: 'That phone number needs a country code.' };

  void cfg0;
  // Two passes at most: if the id we hold turns out to name a session the gateway no
  // longer has, `ensureStarted` clears it and the second pass creates a fresh one. A
  // masjid should never have to know that happened, let alone fix it by hand.
  let cfg = getWhatsAppConfig();
  let started: { ok: boolean; ready?: boolean; error?: string } = { ok: false };
  for (let pass = 0; pass < 2; pass += 1) {
    const session = await ensureSession();
    if (!session.ok) return { ok: false, error: session.error };
    // ensureSession may have just recorded a new id, so re-read rather than reusing cfg0.
    cfg = getWhatsAppConfig();
    started = await ensureStarted(cfg);
    if (started.error !== 'stale-session') break;
  }
  if (!started.ok) {
    return { ok: false, error: started.error === 'stale-session' ? 'Could not create a WhatsApp session.' : started.error };
  }
  if (started.ready) {
    return { ok: false, error: 'A phone is already linked. Unlink it in OpenWA first if you want to change it.' };
  }

  // Starting is asynchronous: the engine exists moments before it can talk to WhatsApp,
  // and in that window OpenWA answers 409 ("wait for ready and retry"). A few short
  // waits turn a race the admin would see as a failure into a code on screen.
  for (let attempt = 1; ; attempt += 1) {
    const r = await call(cfg, 'POST', `/api/sessions/${encodeURIComponent(cfg.sessionId)}/pairing-code`, {
      phoneNumber: digits,
    });
    if (r.ok) {
      const j = r.json as { pairingCode?: unknown; code?: unknown; data?: { code?: unknown } } | null;
      const code = j?.pairingCode ?? j?.code ?? j?.data?.code;
      return { ok: true, code: typeof code === 'string' ? code : undefined };
    }
    if (r.status === 409 && attempt < 6) {
      await sleep(2000);
      continue;
    }
    if (r.status === 409) {
      return { ok: false, error: 'The gateway is still connecting. Wait a few seconds and press the button again.' };
    }
    if (r.status === 400) {
      // Everything we can pre-empt has been; a remaining 400 is the number itself.
      return { ok: false, error: 'The gateway would not accept that number. Check the country code and try again.' };
    }
    if (r.status === 404) {
      // The session existed a moment ago (we just read and started it), so a 404 here is
      // about the ROUTE, not the session: this build of OpenWA has no pairing-code
      // endpoint. Say that, rather than leaving a bare status code on screen.
      return {
        ok: false,
        error: "This version of OpenWA doesn't support linking by code. Update it, or link by QR in OpenWA itself.",
      };
    }
    return { ok: false, error: r.error };
  }
}

/**
 * Unlink the phone: ask WhatsApp to remove this device from the account.
 *
 * `logout` is the ONLY route that does this. Verified against OpenWA's own source, whose
 * comment on the method is explicit that `stop()` and `delete()` "only release things
 * locally", so the device stays listed under Linked Devices on the handset until someone
 * removes it there by hand. Deleting the session — or removing the whole container —
 * without logging out first therefore strands a device entry the masjid can no longer
 * revoke from anywhere in this dashboard. That is the trap this function exists to avoid.
 *
 * It is a live network round-trip to WhatsApp, so it needs a STARTED engine: without one
 * the gateway answers the same 400 that `start` does. Hence `ensureStarted` first.
 *
 * Three outcomes worth telling apart, because they need different words on screen:
 *   - `ok`                     — the gateway acknowledged the unlink
 *   - `ok:false, stillLinked`  — 502 SESSION_LOGOUT_INCOMPLETE: stopped locally but the
 *                                unlink did not complete, so the phone may STILL list it.
 *                                Never report this as unlinked.
 *   - `ok:false`               — could not reach it at all
 *
 * A 200 is an acknowledgement, not an observation of the handset. The wording the admin
 * sees says the unlink was requested and accepted; it must not claim their phone's list
 * is now clear, because nothing here can see that list.
 */
export async function unlinkSession(): Promise<{ ok: boolean; stillLinked?: boolean; error?: string }> {
  const cfg = getWhatsAppConfig();
  if (!cfg.sessionId) return { ok: true }; // nothing was ever linked
  const started = await ensureStarted(cfg);
  if (!started.ok) {
    // A session the gateway no longer has is already as unlinked as we can make it.
    if (started.error === 'stale-session') return { ok: true };
    return { ok: false, error: started.error ?? 'could not start the session to unlink it' };
  }
  const r = await call(cfg, 'POST', `/api/sessions/${encodeURIComponent(cfg.sessionId)}/logout`);
  if (r.ok) {
    // The gateway has cleared its own idea of the number; ours must not linger, or the
    // panel keeps saying "sending from …" for a phone that is no longer attached.
    recordLinkedPhone('');
    return { ok: true };
  }
  if (r.status === 502) {
    return {
      ok: false,
      stillLinked: true,
      error: 'The gateway stopped the connection but could not confirm WhatsApp released it.',
    };
  }
  if (r.status === 404) return { ok: true }; // no such session at the gateway
  return { ok: false, error: r.error ?? 'the gateway would not unlink the number' };
}

/**
 * Delete the session record and its stored credentials at the gateway.
 *
 * Only ever AFTER `unlinkSession` — on its own this purges local auth data while leaving
 * the device linked on the phone (see above). OpenWA answers 204 with no body, which
 * `call` already tolerates, and 409 `SESSION_NAME_TEARDOWN_PENDING` while the logout's
 * own credential cleanup is still running. That 409 is the normal case in a
 * logout-then-delete sequence, not a failure, so it is retried rather than surfaced.
 */
export async function deleteGatewaySession(): Promise<{ ok: boolean; error?: string }> {
  const cfg = getWhatsAppConfig();
  if (!cfg.sessionId) return { ok: true };
  for (let attempt = 1; ; attempt += 1) {
    const r = await call(cfg, 'DELETE', `/api/sessions/${encodeURIComponent(cfg.sessionId)}`);
    if (r.ok || r.status === 404) return { ok: true };
    if (r.status === 409 && attempt < 5) {
      await sleep(1500);
      continue;
    }
    return { ok: false, error: r.error ?? 'the gateway would not delete the session' };
  }
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

/**
 * Note a `contacts/check` that could not answer. Proceeding anyway is right — a
 * hiccup must not stop all sending.
 *
 * The counter is recorded and surfaced for diagnostics, and is deliberately NOT read
 * by the health monitor as a dead-link verdict. An unanswerable check is exactly the
 * "could not ask" case (CLAUDE.md §13.2d): it is inconclusive, so it must not decide
 * anything on its own. This comment previously promised the monitor consumed it,
 * which it never has — and a signal documented as load-bearing but wired to nothing
 * is worse than no signal, because it stops anyone looking for the real one.
 */
function noteCheckFailure(ok: boolean): void {
  if (ok) sendSignals.checkFailures = 0;
  else sendSignals.checkFailures += 1;
}

async function checkRegistered(cfg: WhatsAppConfig, digits: string): Promise<boolean | null> {
  const now = Date.now();
  const cached = cachedRegistration(digits, now);
  if (cached !== undefined) return cached;
  const r = await call(cfg, 'GET', `/api/sessions/${encodeURIComponent(cfg.sessionId)}/contacts/check/${digits}`);
  noteCheckFailure(r.ok);
  if (!r.ok) return null;
  const j = r.json as { exists?: unknown; isRegistered?: unknown; registered?: unknown; numberExists?: unknown } | null;
  const yes = j?.exists ?? j?.isRegistered ?? j?.registered ?? j?.numberExists;
  if (typeof yes !== 'boolean') return null;
  rememberRegistration(digits, yes, now);
  return yes;
}

// ── pacing ───────────────────────────────────────────────────────────────────────

/** Individual sends within the last rolling day, newest last. Used for both caps. */
const sentAt: number[] = [];
/**
 * Group posts within the last rolling day. SEPARATE from `sentAt` on purpose: one group
 * message reaches everyone, so it must not consume the allowance that fee reminders need
 * — and equally it needs a brake of its own, since a group posted to every few minutes is
 * the kind of spam people actually complain about.
 */
const groupSentAt: number[] = [];
/** target key → last send, for the per-recipient / per-group cooldown. */
const lastToRecipient = new Map<string, number>();

function prune(now: number): void {
  const dayAgo = now - 86_400_000;
  while (sentAt.length > 0 && sentAt[0]! < dayAgo) sentAt.shift();
  while (groupSentAt.length > 0 && groupSentAt[0]! < dayAgo) groupSentAt.shift();
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
 * The hour/day caps alone, warm-up applied. Split out of `blockedReason` so the cap
 * arithmetic exists in ONE place and the reply lane can ask the cap question without
 * also asking about the per-recipient cooldown, which does not
 * applies to answering someone who just messaged us (see `replyTo`).
 */
export function capExceeded(
  now: number,
  target: Target,
  limits: WhatsAppLimits,
  linkedAt: string | null,
  history: { sends: number[]; groupSends: number[] },
): 'hour' | 'day' | null {
  // INDIVIDUAL messages are deliberately uncapped. Spacing is the whole brake for them:
  // the randomised 6-20s gap plus the per-recipient cooldown. Removed at the maintainer's
  // decision after the caps repeatedly blocked ordinary use — with the warm-up ramp they
  // came to 3/hour on a freshly linked number, which is unusable even for testing, and a
  // masjid messaging parents one at a time is not the threat the caps were written for.
  //
  // Known trade-off, recorded because it is not the admin's mistake if it bites: the queue
  // is shared, so an app looping over 200 parents will now send all 200, spaced but
  // unbounded. Ban risk attaches to the NUMBER and a ban is terminal, so if this proves
  // too loose the fix is a cap here, not a per-app one — a per-app limiter cannot see the
  // number's total traffic.
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
  // `lastToRecipient` is still WRITTEN, deliberately. It costs nothing, `sendImmediate`
  // documents relying on the write, and it is what any future per-recipient policy would
  // need. Nothing READS it as a brake any more.
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
 * The monitor's own probe is the primary detector, but these two are things only the
 * sender sees, and both used to be discarded: a 401/403 is classed non-retryable so the
 * message is dropped after one attempt with a single log line, and a `contacts/check` that
 * cannot answer returns null and the send proceeds regardless. Neither should be the last
 * anyone hears of it.
 */
const sendSignals = { authFailures: 0, checkFailures: 0, lastAuthFailAt: 0 };
let presenceOn = false;

/**
 * Recent per-message outcomes, so an app can find out what became of a `202`.
 *
 * Bounded and persisted alongside the queue. Deliberately holds NO message text and no
 * recipient — an app polls by the id it was given, and `whatsappOutcome` refuses a record
 * belonging to another app, so this cannot become a way to read someone else's traffic.
 */
const outcomes: OutcomeRecord[] = [];

/** Persist queue + pacing history + outcomes. Called after every mutation. */
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

function noteOutcome(item: QueueItem, state: OutcomeState, reason?: string): void {
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
  for (const stale of state.expired) {
    noteOutcome(
      stale as QueueItem,
      'expired',
      'It waited more than 24 hours of working connection, so it was not sent.',
    );
  }
  if (state.expired.length > 0) {
    log.warn(
      `WhatsApp: dropped ${state.expired.length} message(s) held longer than ` +
        `${Math.round(MAX_HELD_MS / 3_600_000)}h — releasing a backlog at once is what gets a number restricted.`,
    );
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
  if (state.expired.length > 0 || queue.length > 0) persist();
  return { restored: queue.length, expired: state.expired.length };
}

export function queueDepth(): number {
  return queue.length;
}

/** Evidence the SEND path has gathered that the link may be dead. Read by the monitor. */
export function sendPathSignals(): { authFailures: number; checkFailures: number; lastAuthFailAt: number } {
  return { ...sendSignals };
}

export function isQueuePaused(): boolean {
  return paused;
}

/**
 * Probe whether the gateway can still reach WhatsApp.
 *
 * THE POINT: this asks a question that has to go through to WhatsApp, instead of reading
 * OpenWA's cached session row. `gatewayStatus()` reports whatever `status` word the session
 * holds, and a session logged out at WhatsApp's end can go on saying `ready` -- which is why
 * the outage that prompted this was invisible: the sender gates on that same field, so the
 * detector and the sender agreed with each other and both were wrong.
 *
 * A 503 from `/chats` is OpenWA telling us the engine's WhatsApp connection is gone. Any
 * other failure is inconclusive and must NOT be reported as a dead link -- "could not ask"
 * is never an answer (CLAUDE.md §13.2d).
 */
export async function probeLink(): Promise<{ alive: boolean | null; detail?: string }> {
  const cfg = getWhatsAppConfig();
  if (!isWhatsAppConfigured() || !cfg.sessionId) return { alive: null, detail: 'not configured' };
  // limit=1: this is a liveness question, not a data fetch.
  const r = await call(cfg, 'GET', `/api/sessions/${encodeURIComponent(cfg.sessionId)}/chats?limit=1`);
  if (r.ok) return { alive: true };
  if (r.status === 503) return { alive: false, detail: "the gateway's connection to WhatsApp has died" };
  if (r.status === 401 || r.status === 403) return { alive: false, detail: 'the gateway rejected our key' };
  // 409 = still starting, 0 = transport, 5xx = restarting: all inconclusive.
  return { alive: null, detail: r.error ?? `the gateway answered ${r.status}` };
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
  for (const item of queue) {
    noteOutcome(item, 'failed', 'It was discarded by an admin after the WhatsApp link was lost.');
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
 * Enqueue a message. Returns immediately — this is a QUEUE, not a send. Human pacing
 * means delivery is seconds to hours away (a cap, the warm-up ramp), so nothing auth-critical may
 * depend on it. That contract is stated to apps in `docs/WHATSAPP.md`.
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
 * Drain the queue, one message at a time, pausing for whatever the policy says. Never
 * runs twice concurrently — `running` is the whole point of this module.
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

      // Find the first SENDABLE item, rather than stalling on the head of the queue.
      //
      // This was a head-of-line block, and it is the mechanism behind "one app's message
      // never arrives while another app's later messages do". The loop read `queue[0]`, and
      // if that item could not go yet it slept and `continue`d — re-reading the SAME item.
      // So one message that was waiting held up every message behind it, from every app, for
      // as long as its own wait lasted. With the 30-minute per-group cooldown that meant a
      // single group post stopped all WhatsApp traffic for half an hour.
      //
      // Skipping keeps the property that matters — a blocked message is DELAYED, never
      // dropped; it stays on the persisted queue and is reconsidered every pass — and drops
      // the one that never made sense: one target's limit applying to every other target.
      let index = -1;
      let firstReason: string | null = null;
      let soonest = Infinity;
      for (let i = 0; i < queue.length; i++) {
        const waitUntil = queue[i]!.notBefore ?? 0;
        if (waitUntil > now) {
          soonest = Math.min(soonest, waitUntil);
          firstReason ??= 'a previous attempt failed; backing off';
          continue;
        }
        const reason = blockedReason(now, queue[i]!.target, cfg.limits, cfg.linkedAt, {
          sends: sentAt,
          groupSends: groupSentAt,
          lastPerRecipient: lastToRecipient,
        });
        if (!reason) {
          index = i;
          break;
        }
        firstReason ??= reason;
      }
      if (index < 0) {
        // Nothing can go right now. Sleep only until the soonest item is due, so a short
        // backoff is not rounded up to a whole minute — with a floor so this can never
        // become a busy loop.
        const nap = Number.isFinite(soonest) ? Math.min(60_000, Math.max(1_000, soonest - now)) : 60_000;
        log.info(
          `WhatsApp: ${queue.length} message(s) waiting — ${firstReason ?? 'rate limited'}. ` +
            `Retrying in ${Math.round(nap / 1000)}s.`,
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
          log.warn(`WhatsApp: no usable session yet (${s.error ?? 'unknown'}); will retry.`);
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
        log.warn(`WhatsApp: session not ready to send (${live.error ?? 'not linked yet'}); waiting.`);
        await setPresence(cfg, false);
        await sleep(60_000);
        continue;
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
        // Count against the budget the target actually spends.
        (item.target.kind === 'group' ? groupSentAt : sentAt).push(Date.now());
        lastToRecipient.set(targetKey(item.target), Date.now());
        noteOutcome(item, 'sent');
      } else {
        noteOutcome(item, 'failed', outcome.error ?? 'The gateway would not accept it.');
      }
      // The queue and the pacing history both just changed. Persisting here is what makes
      // the caps real across a restart: without it a box in a restart loop would forget
      // every send it had made and could blow through its daily allowance repeatedly.
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
    ? await call(cfg, 'POST', `/api/sessions/${encodeURIComponent(cfg.sessionId)}/messages/send-image`, {
        chatId,
        base64: item.media.data,
        // OpenWA spells this all-lowercase; our own API uses `mimeType`. Deliberate — do
        // not "fix" either side to match the other.
        mimetype: item.media.mimeType,
        ...(item.media.filename ? { filename: item.media.filename } : {}),
        ...(item.text ? { caption: item.text } : {}),
      })
    : await call(cfg, 'POST', `/api/sessions/${encodeURIComponent(cfg.sessionId)}/messages/send-text`, {
        chatId,
        text: item.text,
        // No link preview: fetching one is an extra outbound request from the number and
        // makes an automated message look more like a broadcast.
        linkPreview: false,
      });
  if (!r.ok) {
    // A 401/403 is classed non-retryable, so this message is about to be dropped after a
    // single attempt. Record it: on its own it looks like a config mistake, but a run of
    // them is how a dead link presents on the send path, and the monitor is what turns
    // that into something the admin actually hears about.
    if (r.status === 401 || r.status === 403) {
      sendSignals.authFailures += 1;
      sendSignals.lastAuthFailAt = Date.now();
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
  const cfg = getWhatsAppConfig();
  if (!isWhatsAppConfigured()) return { ok: false, error: 'WhatsApp is not set up yet.' };
  const digits = toDigits(to);
  if (!digits) return { ok: false, error: 'That phone number needs a country code.' };
  return sendTestTo({ kind: 'person', digits }, text);
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
  return sendTestTo({ kind: 'group', groupId }, text);
}

/**
 * Turn a `@lid` privacy id into a phone number, using the gateway's own lookup.
 *
 * WhatsApp is migrating chats to privacy ids, which carry no number — so for those
 * senders this is the ONLY way to get an identity to check against the commands list.
 * The gateway can attach it to every message itself, but only when the operator sets
 * `RESOLVE_LID_TO_PHONE=true`, which is off by default and is not something a masjid
 * should have to know about. Asking over REST works on an install as it stands today,
 * with no app update.
 *
 * Cached, INCLUDING misses: an unmapped sender is usually permanently unmapped, and
 * re-asking on every message would spend the gateway's rate limit to keep learning
 * the same nothing.
 *
 * Best-effort by design — never throws, returns null on anything unexpected. A null
 * means "cannot identify", which the caller must treat as "not authorised".
 */
const lidPhones = new Map<string, string | null>();
const LID_CACHE_MAX = 500;

export async function resolveLidPhone(jid: string): Promise<string | null> {
  if (!jid) return null;
  const cached = lidPhones.get(jid);
  if (cached !== undefined) return cached;

  const cfg = getWhatsAppConfig();
  if (!isWhatsAppConfigured() || !cfg.sessionId) return null;

  let phone: string | null = null;
  try {
    const r = await call(
      cfg,
      'GET',
      `/api/sessions/${encodeURIComponent(cfg.sessionId)}/contacts/${encodeURIComponent(jid)}/phone`,
    );
    if (r.ok) {
      const raw = (r.json as { phone?: unknown })?.phone;
      phone = typeof raw === 'string' ? toDigits(raw) : null;
    }
  } catch {
    /* best effort — an unresolvable sender is simply unauthorised */
  }

  if (lidPhones.size >= LID_CACHE_MAX) lidPhones.clear();
  lidPhones.set(jid, phone);
  return phone;
}

/** What the gateway itself has received from WhatsApp. Counts and times only. */
export interface GatewayTraffic {
  ok: boolean;
  /** Why we could not ask, in words an admin can act on. */
  error?: string;
  /** Messages the gateway has recorded, by direction. */
  incoming: number;
  outgoing: number;
  /** When the newest INCOMING message reached the gateway. */
  newestIncomingAt: string | null;
  /** When the newest message of any direction reached it. */
  newestAt: string | null;
  /**
   * WhatsApp's OWN view of recent activity, read live from the engine rather than
   * from the gateway's database.
   *
   * This is what separates the two failures that otherwise look identical. The engine
   * can end up alive-but-DEAF: WhatsApp Web reloads its page, the socket recovers but
   * the page→Node event bridge does not, and from then on the session reports `ready`,
   * sending still works, and not one inbound message is ever handed up. When that
   * happens the CHAT LIST still advances — the engine can see the conversation — while
   * no incoming message is ever recorded. Chat activity newer than the newest recorded
   * message is the signature.
   */
  chatsOk: boolean;
  /** A transport fault reading the chat list. NOT the same as "no activity" — the
   *  gateway answers 503 when the page itself died, and reporting that as quiet would
   *  hide the very thing we are looking for. */
  chatsError?: string;
  newestChatActivityAt: string | null;
}

/**
 * Ask the gateway what it has actually received from WhatsApp.
 *
 * This is the one question that separates the two halves of "commands don't work":
 * if the gateway has recorded an inbound message, it heard the phone and the failure
 * is downstream of it (the emit, our socket, our gate). If it has recorded nothing,
 * the engine is deaf and no amount of fixing our side will help.
 *
 * Deliberately reads the DB-backed list rather than the live engine: it answers "did
 * this ever arrive" rather than "is the browser healthy right now", and it works even
 * while the engine is mid-reload.
 *
 * NOTE the trap: this endpoint takes a bare path parameter with no UUID validation,
 * so passing the session NAME returns 200 with an empty list — which reads exactly
 * like "the gateway has received nothing". The session id we hold is the UUID, which
 * is the correct one; do not "helpfully" switch this to the name.
 *
 * Counts and timestamps only. Message bodies are never read out of the response.
 */
export async function gatewayTraffic(limit = 50): Promise<GatewayTraffic> {
  const empty = {
    incoming: 0,
    outgoing: 0,
    newestIncomingAt: null,
    newestAt: null,
    chatsOk: false,
    newestChatActivityAt: null,
  };
  const cfg = getWhatsAppConfig();
  if (!isWhatsAppConfigured()) return { ok: false, error: 'WhatsApp is not set up yet.', ...empty };
  if (!cfg.sessionId) return { ok: false, error: 'No phone is linked yet.', ...empty };
  const sid = encodeURIComponent(cfg.sessionId);

  // WhatsApp's own view first. A 503 here means the page died — a transport fault, and
  // explicitly not "no activity".
  const chats = await call(cfg, 'GET', `/api/sessions/${sid}/chats?limit=50`);
  let newestChat = 0;
  let chatsOk = false;
  let chatsError: string | undefined;
  if (chats.ok) {
    chatsOk = true;
    const list = Array.isArray(chats.json) ? (chats.json as Record<string, unknown>[]) : [];
    for (const c of list) {
      // `timestamp` is unix SECONDS of last activity.
      const ts = typeof c.timestamp === 'number' && c.timestamp > 0 ? c.timestamp * 1000 : 0;
      if (ts > newestChat) newestChat = ts;
    }
  } else {
    chatsError =
      chats.status === 503
        ? "The gateway's connection to WhatsApp has died — it needs restarting or re-linking."
        : chats.status === 409
          ? 'The gateway is still starting up.'
          : (chats.error ?? `The gateway answered ${chats.status}.`);
  }

  const r = await call(cfg, 'GET', `/api/sessions/${sid}/messages?limit=${Math.min(100, Math.max(1, limit))}`);
  if (!r.ok) {
    return {
      ok: false,
      error: r.error ?? `The gateway answered ${r.status}.`,
      ...empty,
      chatsOk,
      chatsError,
      newestChatActivityAt: newestChat ? new Date(newestChat).toISOString() : null,
    };
  }

  const rows = Array.isArray((r.json as { messages?: unknown })?.messages)
    ? ((r.json as { messages: unknown[] }).messages as Record<string, unknown>[])
    : [];

  let incoming = 0;
  let outgoing = 0;
  let newestIncoming = 0;
  let newest = 0;
  for (const m of rows) {
    // `timestamp` is unix SECONDS; `createdAt` is an ISO string. Prefer the former.
    const ts =
      typeof m.timestamp === 'number' && m.timestamp > 0
        ? m.timestamp * 1000
        : typeof m.createdAt === 'string'
          ? Date.parse(m.createdAt)
          : 0;
    const inbound = m.direction === 'incoming';
    if (inbound) incoming += 1;
    else outgoing += 1;
    if (Number.isFinite(ts) && ts > newest) newest = ts;
    if (inbound && Number.isFinite(ts) && ts > newestIncoming) newestIncoming = ts;
  }

  return {
    ok: true,
    incoming,
    outgoing,
    newestIncomingAt: newestIncoming ? new Date(newestIncoming).toISOString() : null,
    newestAt: newest ? new Date(newest).toISOString() : null,
    chatsOk,
    chatsError,
    newestChatActivityAt: newestChat ? new Date(newestChat).toISOString() : null,
  };
}

/**
 * Send one message and WAIT — the ONE non-queued path, shared by the admin's test
 * button and the command reply lane.
 *
 * Bypasses the queue. There is no longer any budget to bypass: the hour/day caps this
 * used to be metered against are gone (see the header), so `sentAt` / `groupSentAt` are
 * now a record of what was sent, not an allowance being spent. Kept because the history
 * is what any future ceiling would have to be built on, and because it is the honest
 * answer to "how much has this number sent recently?".
 *
 * It also writes `lastToRecipient`, which nothing reads any more — the per-recipient
 * cooldown that consumed it was removed. Kept for the same reason.
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
    // Persisted so the send history survives a restart. Not a budget any more (there
    // are no caps), but it is the record any future ceiling would have to be built on,
    // and a box in a restart loop that forgets what it sent has no history at all.
    persist();
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
 * Why this is allowed to skip the pacing at all: a solicited reply to a known contact
 * is the LOWEST-risk traffic this number can emit — it is the same shape WhatsApp's
 * own commercial API models as a customer-service window. What gets a number flagged
 * is unsolicited volume to non-contacts, which is the opposite. And a reply that
 * arrives forty minutes later, behind a backlog, is not a reply;
 * it is a bug. The cooldown protects a recipient from noise they did not
 * ask for — someone who typed a command at 23:00 is not being woken by the answer.
 *
 * The per-recipient cooldown is deliberately NOT consulted: it exists to stop three
 * apps independently messaging one parent, and applied here it would make a
 * back-and-forth impossible (`!os stats`, answer, then 55 seconds of silence).
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
 * is in flight would let a second pump start alongside the first.
 */
export function clearWhatsAppRuntime(): void {
  queue.length = 0;
  sentAt.length = 0;
  groupSentAt.length = 0;
  outcomes.length = 0;
  lastToRecipient.clear();
  onWhatsApp.clear();
  lidPhones.clear();
  presenceOn = false;
}
