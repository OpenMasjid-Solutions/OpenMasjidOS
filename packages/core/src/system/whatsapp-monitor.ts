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

interface HealthState {
  /** Whether we are currently in a declared incident. */
  down?: boolean;
  /** When the incident was confirmed. */
  detectedAt?: number | null;
  /** The last moment the link was positively known good — the start of the blind window. */
  lastKnownGood?: number | null;
  /** Short reason, for the alert and the UI. */
  reason?: string | null;
}

const EMPTY: HealthState = { down: false, detectedAt: null, lastKnownGood: null, reason: null };

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
async function assess(): Promise<{ alive: boolean | null; reason: string }> {
  // 1. The send path's own evidence. A run of 401/403s means messages are being dropped
  //    right now, which is worth acting on without waiting for the probe to agree.
  const signals = sendPathSignals();
  if (signals.authFailures >= AUTH_FAILS_MEAN_DEAD) {
    return { alive: false, reason: 'the gateway kept rejecting our key while sending' };
  }

  // 2. The real probe — a question that has to reach WhatsApp.
  const probe = await probeLink();
  if (probe.alive === false) return { alive: false, reason: probe.detail ?? 'the link is down' };

  // 3. The session row, for the states it genuinely detects. Its `ready` proves nothing,
  //    so it is only ever read for BAD news.
  const status = await gatewayStatus();
  if (status.state === 'no-session') return { alive: false, reason: 'the WhatsApp session no longer exists' };
  if (status.state === 'pending') return { alive: false, reason: 'the gateway is asking to be linked again' };
  if (status.state === 'bad-key') return { alive: false, reason: 'the gateway rejected our key' };
  if (status.state === 'problem') {
    return { alive: false, reason: `the gateway reports "${status.detail || 'a problem'}"` };
  }

  // A successful probe is the only positive signal worth anything.
  if (probe.alive === true) return { alive: true, reason: 'ok' };
  return { alive: null, reason: probe.detail ?? 'could not tell' };
}

async function tick(): Promise<void> {
  const cfg = getWhatsAppConfig();
  // Nothing to lose: WhatsApp off, or a phone was never linked. Say nothing, store nothing.
  if (!isWhatsAppConfigured() || !cfg.linkedPhone) {
    lastVerdict = null;
    return;
  }

  const { alive, reason } = await assess();

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
      save({ down: false, detectedAt: null, lastKnownGood: Date.now(), reason: null });
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

  // Persist BEFORE alerting: a crash mid-send must not re-alert on the next boot.
  save({ down: true, detectedAt, lastKnownGood, reason });

  const suspect = lastKnownGood ? outcomesInWindow(lastKnownGood, detectedAt) : [];
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
  };
}

/** Clear a declared incident — used when the admin relinks or releases the queue, so the
 *  banner does not outlive the fix while waiting for the next tick. */
export function clearWhatsAppIncident(): void {
  const s = load();
  if (!s.down) return;
  save({ down: false, detectedAt: null, lastKnownGood: Date.now(), reason: null });
  lastVerdict = null;
}

export function startWhatsAppMonitor(): void {
  setTimeout(() => void checkWhatsAppHealthNow(), FIRST_CHECK_MS).unref?.();
  setInterval(() => void checkWhatsAppHealthNow(), CHECK_MS).unref?.();
  log.info('WhatsApp health monitor started.');
}
