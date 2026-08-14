// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * WhatsApp gateway vault (OpenWA). Deliberately the same shape as `store/email.ts`:
 * the admin configures ONE gateway here, and the platform sends on behalf of the OS
 * (admin alerts) and, over the Fabric, on behalf of apps — so no app ever handles the
 * gateway key, and no app talks to WhatsApp directly.
 *
 * The API key lives ONLY in this file under the data dir (chmod 600) — never in
 * settings.json and never in the admin-facing API, which returns a sanitized view
 * (base URL + session + "is set" flag). The full config leaves this module only to
 * the sender (`notify/whatsapp.ts`).
 *
 * HOW THE GATEWAY IS FOUND: the normal path is installing OpenWA from the App Store —
 * the platform then resolves it on 127.0.0.1 by its published port, the same way the
 * Fabric broker reaches any app. `baseUrl` here is the OVERRIDE, for a masjid running
 * OpenWA on another machine or sharing one gateway between sites. The platform does not
 * supervise OpenWA itself: on the safer `whatsapp-web.js` engine it is a headless
 * Chromium costing 300-500 MB per session, and keeping a browser alive does not belong
 * in the core boot path.
 *
 * **This is an UNOFFICIAL WhatsApp client and an account can be restricted or banned
 * for using it.** OpenWA says so itself. Every default here is chosen to be
 * conservative rather than fast; see `notify/whatsapp.ts` for the pacing that
 * enforces it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from '../config';
import { readJson, writeJson } from '../util/json-store';

export type WhatsAppProvider = 'none' | 'openwa';

/**
 * Sending limits. These are the anti-ban policy, expressed as data so an admin can
 * tighten them without a code change — but NOT loosen them past what the transport
 * will honour (`clampLimits`).
 */
export interface WhatsAppLimits {
  /** Hard ceiling per rolling hour, across every app and the OS together. */
  perHour: number;
  /** Hard ceiling per rolling 24h. */
  perDay: number;
  /** Minimum seconds between any two sends (a random extra gap is added on top). */
  minGapSeconds: number;
  /** Extra random seconds added to every gap, so the cadence is never a fixed beat. */
  jitterSeconds: number;
  /** Minimum seconds before the same recipient may be messaged again. */
  perRecipientCooldownSeconds: number;
  /** Local hour (0–23) when quiet hours begin; messages queue instead of sending. */
  quietStartHour: number;
  /** Local hour (0–23) when quiet hours end. */
  quietEndHour: number;
  /** Days after linking during which the caps are reduced (a new number is watched). */
  warmupDays: number;
}

export interface WhatsAppConfig {
  provider: WhatsAppProvider;
  /** Base URL of the OpenWA gateway, e.g. http://openwa.lan:3000 (no trailing slash). */
  baseUrl: string;
  /** OpenWA's `X-API-Key`. SECRET — never returned to the UI. */
  apiKey: string;
  /** The OpenWA session id this masjid sends from. */
  sessionId: string;
  /** When the session was first linked — the warm-up ramp counts from here. */
  linkedAt: string | null;
  limits: WhatsAppLimits;
}

interface WhatsAppFile {
  whatsapp: WhatsAppConfig;
}

const WHATSAPP_PATH = path.join(CONFIG_DIR, 'whatsapp.json');

/**
 * Conservative by design. OpenWA's own guidance is "a few messages per minute per
 * session is sustainable; thousands in an hour is not", so the defaults sit an order
 * of magnitude below even that: a masjid sending fee reminders to parents does not
 * need throughput, it needs the number to still work next term.
 */
export const DEFAULT_LIMITS: WhatsAppLimits = {
  perHour: 12,
  perDay: 60,
  minGapSeconds: 6,
  jitterSeconds: 14, // so the real gap is 6–20s, never a detectable fixed beat
  perRecipientCooldownSeconds: 60,
  quietStartHour: 21,
  quietEndHour: 7,
  warmupDays: 7,
};

const DEFAULT_CONFIG: WhatsAppConfig = {
  provider: 'none',
  baseUrl: '',
  apiKey: '',
  sessionId: '',
  linkedAt: null,
  limits: { ...DEFAULT_LIMITS },
};

/**
 * Keep an admin's edits inside safe bounds. The limits are configurable so a masjid
 * can be MORE careful; they are clamped so a stray edit (or a copied config from a
 * bulk-sending tutorial) cannot turn the platform into a blaster. A UI can't be the
 * only guard — the Fabric writes here too.
 */
export function clampLimits(l: Partial<WhatsAppLimits> | undefined): WhatsAppLimits {
  const n = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));
  const d = DEFAULT_LIMITS;
  return {
    perHour: clamp(n(l?.perHour, d.perHour), 1, 60),
    perDay: clamp(n(l?.perDay, d.perDay), 1, 500),
    // Never below 3s between sends, whatever the config says.
    minGapSeconds: clamp(n(l?.minGapSeconds, d.minGapSeconds), 3, 600),
    jitterSeconds: clamp(n(l?.jitterSeconds, d.jitterSeconds), 1, 600),
    perRecipientCooldownSeconds: clamp(n(l?.perRecipientCooldownSeconds, d.perRecipientCooldownSeconds), 0, 86_400),
    quietStartHour: clamp(n(l?.quietStartHour, d.quietStartHour), 0, 23),
    quietEndHour: clamp(n(l?.quietEndHour, d.quietEndHour), 0, 23),
    warmupDays: clamp(n(l?.warmupDays, d.warmupDays), 0, 90),
  };
}

function withDefaults(w: Partial<WhatsAppConfig> | undefined): WhatsAppConfig {
  return {
    ...DEFAULT_CONFIG,
    ...(w ?? {}),
    limits: clampLimits(w?.limits),
  };
}

let cache: WhatsAppConfig = withDefaults(
  readJson<WhatsAppFile>(WHATSAPP_PATH, { whatsapp: DEFAULT_CONFIG }).whatsapp,
);

function persist(): void {
  writeJson(WHATSAPP_PATH, { whatsapp: cache });
  try {
    fs.chmodSync(WHATSAPP_PATH, 0o600);
  } catch {
    /* best effort (non-POSIX dev) */
  }
}

/** Full config incl. the API key — ONLY for the sender (notify/whatsapp.ts). */
export function getWhatsAppConfig(): WhatsAppConfig {
  return cache;
}

/**
 * True when a usable gateway is configured.
 *
 * `baseUrl` is deliberately NOT required: the normal path is installing OpenWA from
 * the App Store, and the platform then finds it on 127.0.0.1 by its published port
 * (notify/whatsapp.ts `resolveBaseUrl`). A typed URL is the override for a gateway
 * living elsewhere. The API key and session id ARE required — without them there is
 * nothing to authenticate with and no session to send from.
 */
export function isWhatsAppConfigured(): boolean {
  return cache.provider === 'openwa' && Boolean(cache.apiKey && cache.sessionId);
}

/** Non-secret view for the admin UI — the API key is only ever an "is set" flag. */
export interface WhatsAppConfigPublic {
  provider: WhatsAppProvider;
  baseUrl: string;
  sessionId: string;
  hasApiKey: boolean;
  linkedAt: string | null;
  configured: boolean;
  limits: WhatsAppLimits;
}

export function getWhatsAppConfigPublic(): WhatsAppConfigPublic {
  return {
    provider: cache.provider,
    baseUrl: cache.baseUrl,
    sessionId: cache.sessionId,
    hasApiKey: Boolean(cache.apiKey),
    linkedAt: cache.linkedAt,
    configured: isWhatsAppConfigured(),
    limits: cache.limits,
  };
}

export interface WhatsAppUpsert {
  provider?: WhatsAppProvider;
  baseUrl?: string;
  /** Blank/omitted = keep the existing key, so a settings tweak never re-pastes it. */
  apiKey?: string;
  sessionId?: string;
  limits?: Partial<WhatsAppLimits>;
}

/**
 * Normalise a base URL: trim, drop a trailing slash. Rejecting anything that isn't
 * http(s) here keeps a typo from becoming an outbound request to a `file:` or
 * `gopher:` URL later.
 */
export function normaliseBaseUrl(raw: string): string {
  const s = raw.trim().replace(/\/+$/, '');
  if (!s) return '';
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error('That does not look like a web address. It should start with http:// or https://');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('The gateway address must start with http:// or https://');
  }
  return s;
}

function computeNext(input: WhatsAppUpsert): WhatsAppConfig {
  const next: WhatsAppConfig = withDefaults(cache);
  if (input.provider) next.provider = input.provider;
  if (input.baseUrl !== undefined) next.baseUrl = normaliseBaseUrl(input.baseUrl);
  if (input.sessionId !== undefined) next.sessionId = input.sessionId.trim();
  if (input.apiKey !== undefined && input.apiKey.trim()) next.apiKey = input.apiKey.trim();
  if (input.limits) next.limits = clampLimits({ ...next.limits, ...input.limits });
  return next;
}

/** The exact config a save WOULD persist — for verify-before-save. */
export function previewWhatsAppConfig(input: WhatsAppUpsert): WhatsAppConfig {
  return computeNext(input);
}

export function saveWhatsAppConfig(input: WhatsAppUpsert): WhatsAppConfigPublic {
  cache = computeNext(input);
  persist();
  return getWhatsAppConfigPublic();
}

/**
 * Record that the session was (re)linked, which restarts the warm-up ramp. Called
 * when a pairing code is issued: a freshly linked number is exactly the one WhatsApp
 * watches hardest, so it must not inherit an old number's earned allowance.
 */
export function markLinked(when: string): void {
  cache = { ...cache, linkedAt: when };
  persist();
}
