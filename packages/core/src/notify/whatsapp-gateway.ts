// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The OpenWA gateway client: finding the gateway, calling it, and the session it holds.
 *
 * What lives here is everything that only TALKS to OpenWA — `call`, the session lifecycle
 * (create → start → pair, unlink, delete), its status, the group list, the link check
 * (`probeLink`), the `@lid` privacy-id lookup and the traffic counts the diagnostics read.
 * None of it depends on the queue.
 *
 * It is separate from `notify/whatsapp.ts` because that file is the queue — the one place
 * the platform's sending is serialised and paced — and the gateway client is a different
 * job that the queue, the inbound socket, the health monitor and Settings all use. The
 * dependency runs one way: the queue imports this module; this module never imports the
 * queue.
 */
import { log } from '../logger';
import { getInstalled } from '../apps/manager';
import { appOrigin } from '../system/app-host';
import { toDigits } from '../util/phone';
import {
  getWhatsAppConfig,
  isWhatsAppConfigured,
  recordSessionId,
  recordLinkedPhone,
  type WhatsAppConfig,
} from '../store/whatsapp';
// The catalog app id the platform looks for when no gateway URL was typed in. Defined
// in `apps/managed.ts`, which is also what hides it from the dashboard and the store.
import { OPENWA_APP_ID } from '../apps/managed';

/** How long to wait on a gateway call. */
const HTTP_TIMEOUT_MS = 15_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

/**
 * The last address found, reused for a few seconds. Finding it asks Docker and reads every
 * app's meta.json, and one queued message makes about five gateway calls. Forgotten the
 * moment a call cannot reach it.
 */
let foundGateway: { url: string; at: number } | null = null;
const GATEWAY_ADDRESS_TTL_MS = 5_000;

export async function resolveBaseUrl(cfg: WhatsAppConfig): Promise<GatewayAddress> {
  if (cfg.baseUrl) return { url: cfg.baseUrl };
  if (foundGateway && Date.now() - foundGateway.at < GATEWAY_ADDRESS_TTL_MS) return { url: foundGateway.url };
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
  foundGateway = { url: appOrigin(port), at: Date.now() };
  return { url: foundGateway.url };
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

export async function call(
  cfg: WhatsAppConfig,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  timeoutMs = HTTP_TIMEOUT_MS,
): Promise<{ ok: boolean; status: number; json: unknown; error?: string; timedOut?: boolean }> {
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
      signal: AbortSignal.timeout(timeoutMs),
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
    foundGateway = null; // it may have moved; look it up again next time
    return { ok: false, status: 0, json: null, error: reason, timedOut: (err as Error)?.name === 'TimeoutError' };
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
export async function ensureStarted(cfg: WhatsAppConfig): Promise<{ ok: boolean; ready?: boolean; error?: string }> {
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
  if (!isWhatsAppConfigured()) return { ok: false, error: 'WhatsApp is not set up yet.' };
  const digits = toDigits(phone);
  if (!digits) return { ok: false, error: 'That phone number needs a country code.' };

  // Two passes at most: if the id we hold turns out to name a session the gateway no
  // longer has, `ensureStarted` clears it and the second pass creates a fresh one. A
  // masjid should never have to know that happened, let alone fix it by hand.
  let cfg = getWhatsAppConfig();
  let started: { ok: boolean; ready?: boolean; error?: string } = { ok: false };
  for (let pass = 0; pass < 2; pass += 1) {
    const session = await ensureSession();
    if (!session.ok) return { ok: false, error: session.error };
    // ensureSession may have just recorded a new id, so re-read the config.
    cfg = getWhatsAppConfig();
    started = await ensureStarted(cfg);
    if (started.error !== 'stale-session') break;
  }
  if (!started.ok) {
    return { ok: false, error: started.error === 'stale-session' ? 'Could not create a WhatsApp session.' : started.error };
  }
  if (started.ready) {
    // Never "in OpenWA": the platform owns the session, and OpenWA's own screen is off-limits for it.
    return {
      ok: false,
      error: 'A phone is already linked. To use a different one, press "Unlink this number" in Settings → WhatsApp first.',
    };
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
 *
 * `cause` is what apps are told (the monitor's `LinkFailureCause`), so it is decided here
 * from the status code, never read back out of the wording.
 */
export async function probeLink(): Promise<{
  alive: boolean | null;
  detail?: string;
  cause?: 'session-expired' | 'key-rejected';
}> {
  const cfg = getWhatsAppConfig();
  if (!isWhatsAppConfigured() || !cfg.sessionId) return { alive: null, detail: 'not configured' };
  // limit=1: this is a liveness question, not a data fetch.
  const r = await call(cfg, 'GET', `/api/sessions/${encodeURIComponent(cfg.sessionId)}/chats?limit=1`);
  if (r.ok) return { alive: true };
  if (r.status === 503) {
    return { alive: false, detail: "the gateway's connection to WhatsApp has died", cause: 'session-expired' };
  }
  if (r.status === 401 || r.status === 403) {
    return { alive: false, detail: 'the gateway rejected our key', cause: 'key-rejected' };
  }
  // 409 = still starting, 0 = transport, 5xx = restarting: all inconclusive.
  return { alive: null, detail: r.error ?? `the gateway answered ${r.status}` };
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
 * Cached, INCLUDING a sender the gateway answers has no number: an unmapped sender is
 * usually permanently unmapped, and re-asking on every message would spend the gateway's
 * rate limit to keep learning the same nothing. A lookup that FAILED is not an answer,
 * though, and is asked again — caching one shut a trustee out until the core restarted.
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

  let path: string;
  try {
    // encodeURIComponent throws on a malformed string (a lone surrogate) from the frame.
    path = `/api/sessions/${encodeURIComponent(cfg.sessionId)}/contacts/${encodeURIComponent(jid)}/phone`;
  } catch {
    return null;
  }
  const r = await call(cfg, 'GET', path);
  if (!r.ok && r.status !== 404) return null; // the gateway restarting, a 409, a 5xx: ask again next time
  const raw = r.ok ? (r.json as { phone?: unknown } | null)?.phone : null;
  const phone = typeof raw === 'string' ? toDigits(raw) : null;

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
 * Forget what this module holds in memory: the gateway address and the `@lid` → phone
 * cache. For `clearWhatsAppRuntime` (the "delete it all" path in Settings) only — the
 * pacing reset used by tests deliberately leaves the privacy-id cache alone.
 */
export function clearGatewayCaches(): void {
  lidPhones.clear();
  foundGateway = null;
}
