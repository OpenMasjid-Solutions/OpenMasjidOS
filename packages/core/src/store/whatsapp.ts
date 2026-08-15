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
 * the platform then resolves it at its published host port (`system/app-host.ts`), the
 * same way the Fabric broker reaches any app. `baseUrl` here is the OVERRIDE, for a masjid running
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
  /**
   * Group caps, tracked SEPARATELY from individual messages.
   *
   * One message to a group of 200 is a single outbound message that reaches everyone, so
   * it must not consume the allowance that fee reminders need — and equally it must not
   * be unlimited, because posting to a big group every few minutes is its own kind of
   * spam, and the one people actually complain about.
   */
  groupPerHour: number;
  groupPerDay: number;
  /** Minimum seconds before the SAME group may be posted to again. */
  perGroupCooldownSeconds: number;
}

/**
 * A group the admin has approved for apps to post into.
 *
 * The approval step is the whole security model here. OpenWA's group list contains every
 * group the linked number belongs to — the imam's family chat, a friends group — so an
 * app that could enumerate or freely target groups would be able to read those names and
 * post into them. Apps only ever see this list.
 */
export interface ApprovedGroup {
  /** The WhatsApp group JID, e.g. `120363012345678901@g.us`. The identity. */
  id: string;
  /**
   * The admin's NICKNAME for this group, and the only name apps ever see.
   *
   * Separate from `name` because the two serve different people: WhatsApp's own subject
   * might be "Proffesionalism" or "MASJID GRP 2 (new)", while an app wants to show
   * something a parent would recognise. Renaming here never touches the group in
   * WhatsApp — this is the masjid's private label for it.
   */
  label: string;
  /** The group's own subject in WhatsApp, snapshotted so the admin can tell which group
   *  a nickname refers to. Informational; refreshed when the picker is used. */
  name?: string;
  /** Snapshot for the Settings list only — never authoritative, refreshed on demand. */
  participants?: number;
  approvedAt: string;
}

export interface WhatsAppConfig {
  provider: WhatsAppProvider;
  /** Base URL of the OpenWA gateway, e.g. http://openwa.lan:3000 (no trailing slash). */
  baseUrl: string;
  /** OpenWA's `X-API-Key`. SECRET — never returned to the UI. */
  apiKey: string;
  /**
   * The OpenWA session UUID this masjid sends from. MACHINE-MANAGED: OpenWA mints it
   * (every session route is `@Param('id', ParseUUIDPipe)`) and `POST /api/sessions`
   * accepts only a NAME, so there is no env var an app entry could seed and no value an
   * admin could sensibly type. The platform creates the session itself and records the
   * id here, which removes the only manual step in the whole flow — the alternative was
   * sending a volunteer into another app's admin panel to copy a UUID back.
   */
  sessionId: string;
  /** The human label used when creating the session. Alphanumeric and hyphens only. */
  sessionName: string;
  /** When the session was first linked — the warm-up ramp counts from here. */
  linkedAt: string | null;
  limits: WhatsAppLimits;
  /** Groups the admin has approved for apps to post into. Empty by default. */
  groups: ApprovedGroup[];
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
  // A masjid announcement is an occasional thing; four an hour is already generous,
  // and a group that hears from you ten times a day starts muting you.
  groupPerHour: 4,
  groupPerDay: 10,
  perGroupCooldownSeconds: 1800,
};

const DEFAULT_CONFIG: WhatsAppConfig = {
  provider: 'none',
  baseUrl: '',
  apiKey: '',
  sessionId: '',
  sessionName: 'openmasjid',
  linkedAt: null,
  limits: { ...DEFAULT_LIMITS },
  groups: [],
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
    // Group ceilings are deliberately far tighter than the individual ones: the blast
    // radius of one message is the whole group, so "20 an hour" is already well past
    // anything a masjid has to say.
    groupPerHour: clamp(n(l?.groupPerHour, d.groupPerHour), 1, 20),
    groupPerDay: clamp(n(l?.groupPerDay, d.groupPerDay), 1, 50),
    perGroupCooldownSeconds: clamp(n(l?.perGroupCooldownSeconds, d.perGroupCooldownSeconds), 0, 86_400),
  };
}

function withDefaults(w: Partial<WhatsAppConfig> | undefined): WhatsAppConfig {
  return {
    ...DEFAULT_CONFIG,
    ...(w ?? {}),
    limits: clampLimits(w?.limits),
    // A file written before groups existed has no `groups` key, and the spread would
    // leave it undefined — every later `.some()` would then throw. Absence means none
    // approved, which is also the safe answer.
    groups: sanitizeGroups(w?.groups),
  };
}

/**
 * A group JID as OpenWA addresses it, e.g. `120363012345678901@g.us`.
 *
 * Validated wherever it enters — this string is interpolated into a gateway URL path and
 * arrives from a request body, so it gets the same treatment as every other path segment
 * in the platform. Anchored, digits and hyphens only, and it must be a GROUP: a `@c.us`
 * address slipping through here would turn "post to the parents group" into "message one
 * person", silently.
 */
const GROUP_JID_RE = /^[0-9][0-9-]{0,63}@g\.us$/;

export function isGroupJid(id: unknown): id is string {
  return typeof id === 'string' && GROUP_JID_RE.test(id);
}

/** Drop anything malformed rather than trusting the file on disk. */
function sanitizeGroups(list: unknown): ApprovedGroup[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: ApprovedGroup[] = [];
  for (const raw of list) {
    const g = raw as Partial<ApprovedGroup>;
    if (!isGroupJid(g?.id) || seen.has(g.id)) continue;
    seen.add(g.id);
    out.push({
      id: g.id,
      label: typeof g.label === 'string' && g.label.trim() ? g.label.trim().slice(0, 80) : g.id,
      name: typeof g.name === 'string' && g.name.trim() ? g.name.trim().slice(0, 120) : undefined,
      participants: typeof g.participants === 'number' ? g.participants : undefined,
      approvedAt: typeof g.approvedAt === 'string' ? g.approvedAt : new Date(0).toISOString(),
    });
  }
  return out;
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
 * the App Store, and the platform then finds it at its published host port
 * (notify/whatsapp.ts `resolveBaseUrl`). A typed URL is the override for a gateway
 * living elsewhere. The API key and session id ARE required — without them there is
 * nothing to authenticate with and no session to send from.
 */
export function isWhatsAppConfigured(): boolean {
  return cache.provider === 'openwa' && Boolean(cache.apiKey);
}

/** Non-secret view for the admin UI — the API key is only ever an "is set" flag. */
export interface WhatsAppConfigPublic {
  provider: WhatsAppProvider;
  baseUrl: string;
  sessionId: string;
  sessionName: string;
  hasApiKey: boolean;
  linkedAt: string | null;
  configured: boolean;
  limits: WhatsAppLimits;
  /** Approved groups, for the Settings list. Not secret — the admin chose them. */
  groups: ApprovedGroup[];
}

export function getWhatsAppConfigPublic(): WhatsAppConfigPublic {
  return {
    provider: cache.provider,
    baseUrl: cache.baseUrl,
    sessionId: cache.sessionId,
    sessionName: cache.sessionName,
    hasApiKey: Boolean(cache.apiKey),
    linkedAt: cache.linkedAt,
    configured: isWhatsAppConfigured(),
    limits: cache.limits,
    groups: cache.groups,
  };
}

export interface WhatsAppUpsert {
  provider?: WhatsAppProvider;
  baseUrl?: string;
  /** Blank/omitted = keep the existing key, so a settings tweak never re-pastes it. */
  apiKey?: string;
  sessionName?: string;
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
  // Only the NAME is settable. OpenWA mints the id, so accepting one from the UI would
  // let a typo point the platform at another masjid's session on a shared gateway.
  if (input.sessionName !== undefined) next.sessionName = input.sessionName.trim().replace(/[^A-Za-z0-9-]/g, '-');
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
/**
 * Record the session UUID OpenWA minted for us. Separate from `saveWhatsAppConfig`
 * because it is not an admin edit — it is the platform remembering what the gateway
 * told it, and it must not be reachable from the settings input.
 */
export function recordSessionId(id: string): void {
  cache = { ...cache, sessionId: id };
  persist();
}

export function markLinked(when: string): void {
  cache = { ...cache, linkedAt: when };
  persist();
}

// ── approved groups ──────────────────────────────────────────────────────────────

/** The groups apps may post into. Safe to hand to the UI; never includes anything the
 *  admin has not explicitly approved. */
export function listApprovedGroups(): ApprovedGroup[] {
  return cache.groups;
}

/**
 * THE authorisation check for a group send.
 *
 * Everything else about group messaging is convenience; this is the security boundary. A
 * group id arriving in a Fabric request is untrusted until it has passed here, and it is
 * never used to build a gateway URL before that.
 */
export function isApprovedGroup(id: unknown): boolean {
  return isGroupJid(id) && cache.groups.some((g) => g.id === id);
}

/** Approve a group, or refresh the details of one already approved. */
export function approveGroup(id: string, label: string, participants?: number, name?: string): ApprovedGroup[] {
  if (!isGroupJid(id)) throw new Error('That is not a WhatsApp group.');
  const clean = label.trim().slice(0, 80) || id;
  const existing = cache.groups.find((g) => g.id === id);
  const next = existing
    ? // Re-approving refreshes the WhatsApp details but KEEPS the admin's nickname —
      // renaming is a deliberate act (`renameGroup`), not something that happens as a
      // side effect of opening the picker again.
      cache.groups.map((g) => (g.id === id ? { ...g, participants, name: name ?? g.name } : g))
    : [...cache.groups, { id, label: clean, name, participants, approvedAt: new Date().toISOString() }];
  cache = { ...cache, groups: next };
  persist();
  return cache.groups;
}

/**
 * Set the admin's nickname for an approved group.
 *
 * Apps read this (and nothing else) as the group's name, so it is worth them being able
 * to show "Parents — Hifz" rather than whatever the group is actually called in WhatsApp.
 * Renaming here does NOT rename the group in WhatsApp; the platform never edits a group.
 */
export function renameGroup(id: string, label: string): ApprovedGroup[] {
  const clean = label.trim().slice(0, 80);
  if (!clean) throw new Error('A group needs a name.');
  cache = { ...cache, groups: cache.groups.map((g) => (g.id === id ? { ...g, label: clean } : g)) };
  persist();
  return cache.groups;
}

/** Withdraw approval. Apps lose the ability to post there immediately — no restart. */
export function unapproveGroup(id: string): ApprovedGroup[] {
  cache = { ...cache, groups: cache.groups.filter((g) => g.id !== id) };
  persist();
  return cache.groups;
}
