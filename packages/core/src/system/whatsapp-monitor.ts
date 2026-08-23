// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Notices when the WhatsApp link has died, holds the queue, and tells the admin.
 *
 * ── WHY THIS EXISTS, AND WHY IT DOES NOT JUST POLL `gatewayStatus()` ─────────────
 *
 * A masjid's session expired the way WhatsApp Desktop signs itself out. Nothing noticed:
 * apps kept getting `202 {queued}`, the pump kept handing messages to OpenWA, OpenWA kept
 * accepting them, and every one was recorded `sent`. In OpenWA's own UI they showed as sent
 * to the right chat and undelivered.
 *
 * The obvious fix — a background poll of `gatewayStatus()` — would NOT have caught it. The
 * pump refuses to send unless it sees `status === 'ready'`, and messages went out, so the
 * session row was reporting `ready` throughout. A status poll reads the same cached field
 * the sender reads, so the detector and the sender would have agreed with each other and
 * both been wrong. The admin would have had a green dot for the whole outage.
 *
 * So the probe has to ask a question that actually goes through to WhatsApp:
 * `notify/whatsapp.ts` `probeLink()` calls `/chats`, whose 503 is OpenWA saying the engine's
 * WhatsApp connection is gone. `gatewayStatus()` is still consulted, but only for the states
 * it genuinely does catch (`no-session`, `pending`, `problem`, `unreachable`) — its `ready`
 * is never treated as proof of health.
 *
 * ── RULES THAT MUST NOT REGRESS ─────────────────────────────────────────────────
 *
 * - **Two consecutive agreeing ticks before acting** (as `system/address-monitor.ts` does).
 *   A session that blips for one poll must not email anyone or pause the queue.
 * - **"Could not ask" is never an answer.** An inconclusive probe records nothing and never
 *   alerts — the same rule CLAUDE.md §13.2d states for Stripe. Treating an unreachable
 *   gateway as a dead link would pause a masjid's queue over a momentary network fault.
 * - **Persist before alerting**, so a crash mid-send cannot re-alert the same incident.
 * - **Never touches WhatsApp as a channel.** The alert goes out over email and the webhook;
 *   see `notify/alerts.ts`, where this alert id is marked unavailable for WhatsApp.
 */
import path from 'node:path';
import { CONFIG_DIR } from '../config';
import { log } from '../logger';
import { readJson, writeJson } from '../util/json-store';
import { deliverAlert } from '../notify/alerts';
import { whatsappLinkLost } from '../notify/alert-copy';
import {
  probeLink,
  gatewayStatus,
  sendPathSignals,
  pauseQueue,
  isQueuePaused,
  queueDepth,
  outcomesInWindow,
} from '../notify/whatsapp';
import { getWhatsAppConfig, isWhatsAppConfigured } from '../store/whatsapp';

const CHECK_MS = 5 * 60_000;
/** Long enough for the gateway container to be up after a reboot. */
const FIRST_CHECK_MS = 60_000;
/** A run of send-side auth rejections is itself evidence, without waiting for a probe. */
const AUTH_FAILS_MEAN_DEAD = 3;

const STATE_PATH = path.join(CONFIG_DIR, 'whatsapp-health.json');

/**
 * A machine-readable cause, so an app can word its own message accurately instead of
 * inferring one from prose. Requested by the Donations app. `unknown` exists so a future
 * cause never breaks a consumer's switch.
 */
export type LinkFailureCause = 'session-expired' | 'needs-relink' | 'key-rejected' | 'unknown';

/**
 * A finished or ongoing outage, kept AFTER it is fixed.
 *
 * This is the Kiosk app's finding, and it was a real design fault: the suspect route
 * originally answered only while `down` was true, and relinking clears that — so the
 * evidence disappeared at exactly the moment somebody went looking for what they had
 * missed. A consumer's whole job (cross-reference, decide, act) happens AFTER recovery.
 *
 * The per-app evidence is SNAPSHOTTED when the incident is confirmed, not computed on
 * demand, for a second reason: the outcome ring only keeps 24 hours, so a window read two
 * days later would have answered "0 messages" and looked like an all-clear.
 */
export interface Incident {
  /** Last moment the link was known good — the start of the blind window. */
  from: number;
  /** When the outage was confirmed. */
  to: number;
  cause: LinkFailureCause;
  /** The human sentence, for the alert and the dashboard. */
  reason: string;
  /** Per app: how many of its messages were reported sent inside the window. */
  perSource: { source: string; count: number; ids: string[]; truncated: boolean }[];
}

/** How long a resolved incident stays queryable. Comfortably longer than every app's poll
 *  interval (the fastest is 15 min, the slowest hourly) and than the 24h outcome ring. */
const INCIDENT_RETENTION_MS = 7 * 24 * 3_600_000;
const MAX_INCIDENTS = 5;

interface HealthState {
  /** Whether we are currently in a declared incident. */
  down?: boolean;
  /** When the incident was confirmed. */
  detectedAt?: number | null;
  /** The last moment the link was positively known good — the start of the blind window. */
  lastKnownGood?: number | null;
  /** Short reason, for the alert and the UI. */
  reason?: string | null;
  cause?: LinkFailureCause | null;
  /** Recent outages, newest last. Kept after recovery — see `Incident`. */
  incidents?: Incident[];
}

const EMPTY: HealthState = {
  down: false,
  detectedAt: null,
  lastKnownGood: null,
  reason: null,
  cause: null,
  incidents: [],
};

/** Drop incidents that are too old, and cap how many are kept. */
function pruneIncidents(list: Incident[], now: number): Incident[] {
  return list.filter((i) => now - i.to <= INCIDENT_RETENTION_MS).slice(-MAX_INCIDENTS);
}

/**
 * Held in memory, not re-read per call.
 *
 * `whatsAppHealth()` is on a Fabric route an app may poll up to 600 times a minute, and
 * `test/fabric-rate-tier.test.ts` only allows a route onto that loose budget if it is a
 * BOUNDED IN-MEMORY read — a file read per request would not qualify, and would be 600
 * reads a minute off an SD card besides. Disk is the durable copy; this is the live one.
 */
let cached: HealthState | null = null;

function load(): HealthState {
  if (cached) return cached;
  const f = readJson<HealthState>(STATE_PATH, EMPTY);
  cached = f && typeof f === 'object' ? f : { ...EMPTY };
  return cached;
}

function save(state: HealthState): void {
  cached = state;
  writeJson(STATE_PATH, state);
}

/** The previous tick's verdict, for the two-agreeing-ticks rule. In memory on purpose: a
 *  restart should re-observe rather than act on a verdict from before it. */
let lastVerdict: 'alive' | 'dead' | null = null;

/** `true` = link is good, `false` = link is dead, `null` = could not tell. */
async function assess(): Promise<{ alive: boolean | null; reason: string; cause: LinkFailureCause }> {
  // 1. The send path's own evidence. A run of 401/403s means messages are being dropped
  //    right now, which is worth acting on without waiting for the probe to agree.
  const signals = sendPathSignals();
  if (signals.authFailures >= AUTH_FAILS_MEAN_DEAD) {
    return {
      alive: false,
      reason: 'the gateway kept rejecting our key while sending',
      cause: 'key-rejected',
    };
  }

  // 2. The real probe — a question that has to reach WhatsApp.
  const probe = await probeLink();
  if (probe.alive === false) {
    return {
      alive: false,
      reason: probe.detail ?? 'the link is down',
      cause: probe.detail?.includes('key') ? 'key-rejected' : 'session-expired',
    };
  }

  // 3. The session row, for the states it genuinely detects. Its `ready` proves nothing,
  //    so it is only ever read for BAD news.
  const status = await gatewayStatus();
  if (status.state === 'no-session') {
    return { alive: false, reason: 'the WhatsApp session no longer exists', cause: 'session-expired' };
  }
  if (status.state === 'pending') {
    return { alive: false, reason: 'the gateway is asking to be linked again', cause: 'needs-relink' };
  }
  if (status.state === 'bad-key') {
    return { alive: false, reason: 'the gateway rejected our key', cause: 'key-rejected' };
  }
  if (status.state === 'problem') {
    return {
      alive: false,
      reason: `the gateway reports "${status.detail || 'a problem'}"`,
      cause: 'session-expired',
    };
  }

  // A successful probe is the only positive signal worth anything.
  if (probe.alive === true) return { alive: true, reason: 'ok', cause: 'unknown' };
  return { alive: null, reason: probe.detail ?? 'could not tell', cause: 'unknown' };
}

async function tick(): Promise<void> {
  const cfg = getWhatsAppConfig();
  // Nothing to lose: WhatsApp off, or a phone was never linked. Say nothing, store nothing.
  if (!isWhatsAppConfigured() || !cfg.linkedPhone) {
    lastVerdict = null;
    return;
  }

  const { alive, reason, cause } = await assess();

  // "Could not ask" is not an answer. Do not alert, do not clear an incident, do not let it
  // count towards the two agreeing ticks — otherwise a flaky uplink pauses a real queue.
  if (alive === null) {
    lastVerdict = null;
    log.debug(`WhatsApp health: inconclusive (${reason}).`);
    return;
  }

  const state = load();
  const verdict = alive ? 'alive' : 'dead';
  const agreed = lastVerdict === verdict;
  lastVerdict = verdict;

  if (alive) {
    // Recovery. Clear the incident so the NEXT one alerts again. The queue stays paused on
    // purpose — a backlog must be released deliberately, not the moment the link returns.
    if (state.down && agreed) {
      // The incident stays in `incidents` — recovery is when apps come looking, so erasing
      // it here is what made the endpoint answer "nothing happened" to everyone who asked.
      save({
        ...state,
        down: false,
        detectedAt: null,
        lastKnownGood: Date.now(),
        reason: null,
        cause: null,
      });
      log.info('WhatsApp health: the link is back. The held queue still needs releasing in Settings.');
    } else if (!state.down) {
      // Keep the last-known-good moving so the blind window stays tight when it does break.
      save({ ...state, down: false, lastKnownGood: Date.now() });
    }
    return;
  }

  if (state.down) return; // already alerted for this incident
  if (!agreed) {
    log.warn(`WhatsApp health: a bad reading (${reason}); waiting for a second before acting.`);
    return;
  }

  // Confirmed. Hold the queue FIRST — every message that goes out from here is one more
  // that will be reported sent and never arrive.
  const detectedAt = Date.now();
  const lastKnownGood = state.lastKnownGood ?? null;
  if (!isQueuePaused()) pauseQueue(reason);

  // Snapshot the evidence NOW. The outcome ring only holds 24 hours, so computing this on
  // demand would have answered "0 messages" to anyone asking two days later — which reads
  // as an all-clear. The set is closed at this moment anyway: the queue is paused above, so
  // nothing further can be reported sent into this window.
  const suspect = lastKnownGood ? outcomesInWindow(lastKnownGood, detectedAt) : [];
  const incidents = pruneIncidents(
    [...(state.incidents ?? []), { from: lastKnownGood ?? detectedAt, to: detectedAt, cause, reason, perSource: suspect }],
    detectedAt,
  );

  // Persist BEFORE alerting: a crash mid-send must not re-alert on the next boot.
  save({ down: true, detectedAt, lastKnownGood, reason, cause, incidents });
  const copy = whatsappLinkLost({
    reason,
    held: queueDepth(),
    since: lastKnownGood,
    detectedAt,
    suspect,
  });
  // `text` is the webhook body; the monitors all pass the summary through as it.
  await deliverAlert({ source: 'os', text: copy.summary, ...copy }).catch((err) => {
    log.warn('WhatsApp health: could not deliver the alert.', err);
  });
  log.error(`WhatsApp health: link lost (${reason}); ${queueDepth()} message(s) held.`);
}

/** For tests and for a manual "check now" — runs one tick and reports nothing. */
export async function checkWhatsAppHealthNow(): Promise<void> {
  await tick().catch((err) => log.warn('WhatsApp health check failed.', err));
}

/** The declared incident, for the UI. */
export function whatsAppHealth(): Required<HealthState> {
  const s = load();
  return {
    down: s.down === true,
    detectedAt: s.detectedAt ?? null,
    lastKnownGood: s.lastKnownGood ?? null,
    reason: s.reason ?? null,
    cause: s.cause ?? null,
    incidents: s.incidents ?? [],
  };
}

/**
 * The windows in which THIS app's messages may not have arrived.
 *
 * Answers after recovery as well as during an outage — that is the whole point, and the
 * original version's failure. Scoped to the caller: an app never learns another app's
 * counts or ids.
 */
export function suspectWindowsFor(
  appId: string,
  now = Date.now(),
): { from: number; to: number; cause: LinkFailureCause; count: number; ids: string[]; truncated: boolean }[] {
  const s = load();
  const out = [];
  for (const inc of pruneIncidents(s.incidents ?? [], now)) {
    const mine = inc.perSource.find((x) => x.source === appId);
    if (!mine || mine.count === 0) continue;
    out.push({
      from: inc.from,
      to: inc.to,
      cause: inc.cause ?? 'unknown',
      count: mine.count,
      ids: mine.ids ?? [],
      truncated: mine.truncated === true,
    });
  }
  return out;
}

/** Clear a declared incident — used when the admin relinks or releases the queue, so the
 *  banner does not outlive the fix while waiting for the next tick. */
export function clearWhatsAppIncident(): void {
  const s = load();
  if (!s.down) return;
  // `incidents` is deliberately carried over: this runs when the admin RELINKS or releases
  // the queue, which is exactly when their apps start asking what they missed.
  save({
    ...s,
    down: false,
    detectedAt: null,
    lastKnownGood: Date.now(),
    reason: null,
    cause: null,
  });
  lastVerdict = null;
}

export function startWhatsAppMonitor(): void {
  setTimeout(() => void checkWhatsAppHealthNow(), FIRST_CHECK_MS).unref?.();
  setInterval(() => void checkWhatsAppHealthNow(), CHECK_MS).unref?.();
  log.info('WhatsApp health monitor started.');
}
