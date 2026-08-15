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
 *     all have something to say to them. A group has its own, much longer cooldown.
 *  6. **Caps** per rolling hour and day, platform-wide — and a SEPARATE, tighter pair
 *     for groups. One group message is a single outbound message that reaches everyone,
 *     so it must not spend the allowance individual reminders need; but its blast radius
 *     is the whole group, so it needs a stricter brake of its own.
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
import { OPENWA_APP_ID } from '../apps/managed';
import { appOrigin } from '../system/app-host';
import {
  getWhatsAppConfig,
  isWhatsAppConfigured,
  recordSessionId,
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
 * Queued items live in memory, and quiet hours can hold them for hours — on a Raspberry
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
  text: string;
  source: string;
  target: Target;
  media?: OutgoingMedia;
  enqueuedAt: number;
  /** Transient-failure retries so far. */
  attempts: number;
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
  method: 'GET' | 'POST' | 'PUT',
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
  target: Target,
  limits: WhatsAppLimits,
  linkedAt: string | null,
  history: { sends: number[]; groupSends: number[]; lastPerRecipient: Map<string, number> },
): string | null {
  // Quiet hours apply to BOTH, and more so to a group: a 03:00 fee reminder annoys one
  // person, a 03:00 group post wakes two hundred.
  if (inQuietHours(hour, limits)) return 'quiet hours';

  const factor = warmupFactor(linkedAt, limits, now);
  const isGroup = target.kind === 'group';
  // The warm-up ramp applies to groups too. A number linked yesterday posting to a
  // 200-member group is a strong signal, not a gentle start.
  // At least 1, so a warm-up ramp can never mean "send nothing at all".
  const hourCap = Math.max(1, Math.floor((isGroup ? limits.groupPerHour : limits.perHour) * factor));
  const dayCap = Math.max(1, Math.floor((isGroup ? limits.groupPerDay : limits.perDay) * factor));
  const sends = isGroup ? history.groupSends : history.sends;

  const inLastHour = sends.filter((t) => t > now - 3_600_000).length;
  if (inLastHour >= hourCap) return isGroup ? 'hourly group limit reached' : 'hourly limit reached';
  if (sends.length >= dayCap) return isGroup ? 'daily group limit reached' : 'daily limit reached';

  const cooldown = isGroup ? limits.perGroupCooldownSeconds : limits.perRecipientCooldownSeconds;
  const last = history.lastPerRecipient.get(targetKey(target));
  if (last !== undefined && now - last < cooldown * 1000) {
    return isGroup ? 'this group was posted to very recently' : 'this recipient was messaged very recently';
  }
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

  queue.push({ text, source: req.source, target, media, enqueuedAt: Date.now(), attempts: 0 });
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
      const reason = blockedReason(now, new Date(now).getHours(), item.target, cfg.limits, cfg.linkedAt, {
        sends: sentAt,
        groupSends: groupSentAt,
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
          await sleep(backoff);
          continue; // keep it at the head of the queue
        }
        log.error(`WhatsApp: giving up on a message for ${item.source} after ${MAX_ATTEMPTS} attempts.`);
      }

      queue.shift();
      if (outcome.ok) {
        // Count against the budget the target actually spends.
        (item.target.kind === 'group' ? groupSentAt : sentAt).push(Date.now());
        lastToRecipient.set(targetKey(item.target), Date.now());
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
  log.info(`WhatsApp: delivered ${item.media ? 'an image' : 'a message'} for ${item.source}.`);
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

async function sendTestTo(target: Target, text: string): Promise<SendOutcome> {
  const cfg = getWhatsAppConfig();
  const outcome = await sendOne(cfg, { text, source: 'os:test', target, enqueuedAt: Date.now(), attempts: 0 });
  if (outcome.ok) {
    // A test bypasses the QUEUE, not the BUDGET. It is a real message from the real
    // number, so it counts against the same allowance — otherwise pressing the button
    // repeatedly would be the one way to send unpaced traffic from this platform.
    (target.kind === 'group' ? groupSentAt : sentAt).push(Date.now());
    lastToRecipient.set(targetKey(target), Date.now());
  }
  return outcome;
}

/** Test seam: forget pacing history so a test starts from a known state. */
export function __resetPacingForTests(): void {
  sentAt.length = 0;
  groupSentAt.length = 0;
  lastToRecipient.clear();
  onWhatsApp.clear();
  queue.length = 0;
  presenceOn = false;
}
