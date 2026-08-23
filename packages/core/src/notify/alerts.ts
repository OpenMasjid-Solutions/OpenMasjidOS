// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Admin alerts + a granular per-alert × per-channel matrix (UniFi-style). An alert
 * is a message the ADMIN cares about — an app going offline, an app-declared event
 * (a camera/reader offline, a failed payment). For EACH alert type the admin
 * chooses which channels it goes to: the admin **email**, the **webhook**, the admin's
 * **WhatsApp** number, any combination, or none. Email and webhook default ON; WhatsApp
 * defaults OFF, because it runs through an unofficial client whose linked number can be
 * restricted — that is a risk an admin takes deliberately, not one that starts the
 * moment a gateway is configured.
 *
 * (End-user mail — a receipt to a donor, a notice to a parent/teacher — is NOT an
 * alert and is handled entirely by the app via POST /api/fabric/email. The matrix
 * here is admin-only.)
 *
 * Alert types come from OS built-ins (below) + each installed app's manifest
 * `alerts:` list (via apps/manager). We persist only NON-default channel choices, so
 * a newly-installed app's alerts (and new OS alerts) default to both-channels-on
 * without migration.
 */
import path from 'node:path';
import { CONFIG_DIR } from '../config';
import { readJson, writeJson } from '../util/json-store';
import { getAdminEmail, getAdminPhone } from '../auth/store';
import { listAppAlerts } from '../apps/manager';
import { sendBrandedEmail } from './email';
import { sendNotification, type NotifyInput } from './notify';
import { enqueue as enqueueWhatsApp } from './whatsapp';

// OS built-in alert types (source = 'os').
const OS_ALERTS: { id: string; label: string; description: string }[] = [
  {
    id: 'app-offline',
    label: 'An app goes offline',
    description: "An installed app's container stopped unexpectedly.",
  },
  {
    id: 'core-update',
    label: 'OpenMasjidOS update available',
    description: 'A new version of the platform can be installed.',
  },
  {
    id: 'app-update',
    label: 'An app update is available',
    description: 'An installed app can be updated to a newer version.',
  },
  {
    id: 'stripe-chargeback',
    label: 'A card payment is disputed',
    description:
      'Someone asked their bank to reverse a payment (a chargeback). Usually needs a reply before a deadline.',
  },
  {
    id: 'whatsapp-link-lost',
    label: 'WhatsApp needs linking again',
    description:
      "WhatsApp signed the masjid's phone out, so messages have stopped going out. They are held until you link it again.",
  },
  {
    id: 'command-run',
    label: 'Something was changed from WhatsApp',
    description:
      'Someone on your commands list started, stopped or updated an app by sending a message. There is one admin account, so this is the record of who did what.',
  },
];

export interface AlertChannels {
  email: boolean;
  webhook: boolean;
  /**
   * WhatsApp, via the admin's own OpenWA gateway. Defaults to OFF, unlike the other
   * two — it is an unofficial client and the linked number carries a real risk of
   * being restricted, so it is a channel an admin opts into rather than one that
   * starts sending because they configured a gateway.
   */
  whatsapp: boolean;
}
const DEFAULT_CHANNELS: AlertChannels = { email: true, webhook: true, whatsapp: false };
const isDefault = (c: AlertChannels) => c.email && c.webhook && !c.whatsapp;

const ALERTS_PATH = path.join(CONFIG_DIR, 'alerts.json');
interface AlertsFile {
  /** Only NON-default channel choices, keyed by "<source>:<alertId>". */
  channels?: Record<string, AlertChannels>;
  /** Legacy (v0.41.0–0.41.5): a fully-disabled set. Migrated to channels on load. */
  disabled?: string[];
}

const key = (source: string, id: string) => `${source}:${id}`;

function load(): Map<string, AlertChannels> {
  const file = readJson<AlertsFile>(ALERTS_PATH, {});
  const map = new Map<string, AlertChannels>();
  if (file.channels) {
    for (const [k, v] of Object.entries(file.channels)) {
      // Email/webhook: absent means ON (their default). WhatsApp: absent means OFF —
      // which is also what every file written before WhatsApp existed says, so an
      // upgrade never silently starts messaging phones.
      map.set(k, { email: v.email !== false, webhook: v.webhook !== false, whatsapp: v.whatsapp === true });
    }
  }
  // Migrate a legacy fully-disabled set → every channel off.
  if (Array.isArray(file.disabled)) {
    for (const k of file.disabled) {
      if (!map.has(k)) map.set(k, { email: false, webhook: false, whatsapp: false });
    }
  }
  return map;
}

const channels = load();

function persist(): void {
  writeJson(ALERTS_PATH, { channels: Object.fromEntries(channels) });
}

/**
 * WhatsApp is an OS-only channel.
 *
 * The matrix routes alerts to the ADMIN. For the platform's own alerts that is the whole
 * story, so a WhatsApp column makes sense. For an app's alerts it does not: an app that
 * wants to message people over WhatsApp is almost never trying to reach the admin's phone
 * — it is reaching a parent about fees, or a donor about a receipt — and those recipients,
 * their wording and their timing are the app's own business. It configures them in its own
 * settings and sends through `POST /api/fabric/whatsapp`, which uses the same gateway and
 * the same paced queue.
 *
 * Offering an app a WhatsApp toggle here implied the platform could route its messages to
 * the right people, which it cannot: it knows one number, the admin's.
 *
 * Email and the webhook stay available to apps, because those genuinely are "tell the
 * admin something happened".
 */
export function whatsappAllowed(source: string, alertId?: string): boolean {
  if (source !== 'os') return false;
  // The one OS alert WhatsApp cannot carry: it fires BECAUSE WhatsApp is down. Routing it
  // there sends it into a gateway that cannot deliver, where `enqueue` returns
  // {queued:false} and it disappears with no log and no fallback — the same silent failure
  // documented on `clearWhatsAppChannels` below. Refused rather than merely hidden, because
  // the matrix is reachable outside the UI.
  if (alertId && WHATSAPP_IMPOSSIBLE.has(alertId)) return false;
  return true;
}

/** OS alerts that must never be routed over WhatsApp, whatever the config says. */
const WHATSAPP_IMPOSSIBLE = new Set(['whatsapp-link-lost']);

/** The channel routing for an alert type — defaults to email + webhook on. */
export function getAlertChannels(source: string, id: string): AlertChannels {
  const stored = channels.get(key(source, id)) ?? { ...DEFAULT_CHANNELS };
  // Enforced on READ, so a file written while the column existed for apps (or edited by
  // hand) cannot keep sending an app's alerts to the admin's phone. The id is passed too,
  // because one OS alert (whatsapp-link-lost) can never use that channel either.
  return whatsappAllowed(source, id) ? stored : { ...stored, whatsapp: false };
}

/** Turn a single channel on/off for an alert type. Non-default choices are
 *  persisted; a return to the default drops the entry to keep the file lean. */
export function setAlertChannel(source: string, id: string, channel: keyof AlertChannels, enabled: boolean): void {
  // The UI does not offer this, but the procedure is reachable — refuse rather than
  // storing a preference that `getAlertChannels` would then ignore.
  if (channel === 'whatsapp' && !whatsappAllowed(source, id)) return;
  const next: AlertChannels = { ...getAlertChannels(source, id), [channel]: enabled };
  if (isDefault(next)) channels.delete(key(source, id));
  else channels.set(key(source, id), next);
  persist();
}

/**
 * Turn the WhatsApp column off on every alert row, everywhere.
 *
 * Needed because the matrix outlives the gateway. A row the admin switched on is written
 * to disk (the default is off, so only the ON choices are stored), and deleting OpenWA
 * does not touch this file. Without this, `deliverAlert` keeps entering the WhatsApp
 * branch and silently getting `{queued:false}` back — no log, no error — and, far worse,
 * the moment WhatsApp is ever set up again those alerts resume messaging the phone with
 * no admin action at all. The whole reason this column defaults to off is that an upgrade
 * must never silently start messaging someone; a delete-then-reinstall has to honour the
 * same promise.
 *
 * Iterates the live map rather than a list of known ids, so a row for an app that is no
 * longer installed is cleared too. Persists once at the end.
 */
export function clearWhatsAppChannels(): void {
  let touched = false;
  for (const [k, c] of [...channels]) {
    if (!c.whatsapp) continue;
    const next: AlertChannels = { ...c, whatsapp: false };
    if (isDefault(next)) channels.delete(k);
    else channels.set(k, next);
    touched = true;
  }
  if (touched) persist();
}

export interface AlertTypeInfo {
  source: string; // 'os' or an app id
  sourceLabel: string; // display name of the source
  id: string;
  label: string;
  description?: string;
  channels: AlertChannels;
  /** False for an app's alerts — it sends its own WhatsApp messages, to its own
   *  people, from its own settings. The UI shows that instead of a dead toggle. */
  whatsappAvailable: boolean;
}

/** All known alert types (OS built-ins + every installed app's declared alerts),
 *  each with its channel routing — for the granular Settings → Alerts matrix. */
export function listAlertTypes(): AlertTypeInfo[] {
  const out: AlertTypeInfo[] = OS_ALERTS.map((a) => ({
    source: 'os',
    sourceLabel: 'OpenMasjidOS',
    id: a.id,
    label: a.label,
    description: a.description,
    channels: getAlertChannels('os', a.id),
    // Per ALERT, not just per source: whatsapp-link-lost fires because WhatsApp is down,
    // so that column must read as unavailable rather than as an option that silently fails.
    whatsappAvailable: whatsappAllowed('os', a.id),
  }));
  for (const app of listAppAlerts()) {
    for (const a of app.alerts) {
      out.push({
        source: app.appId,
        sourceLabel: app.appName,
        id: a.id,
        label: a.label,
        description: a.description,
        channels: getAlertChannels(app.appId, a.id),
        whatsappAvailable: whatsappAllowed(app.appId),
      });
    }
  }
  return out;
}

export interface AlertInput extends NotifyInput {
  /** 'os' or the raising app's id. */
  source: string;
  /** The alert type id. */
  alertId: string;
  /** Display name of the source (server-resolved for apps). */
  sourceName?: string;
  /**
   * Optional richer email copy. OS alerts pass these (see notify/alert-copy.ts) so
   * the email can lead with a proper snippet line and offer a button; an app
   * raising an alert over the Fabric supplies only `title` + `text`, and those are
   * used to fill these in.
   */
  summary?: string;
  detail?: string;
  facts?: { label: string; value: string }[];
  action?: { label: string; note: string; path: string };
}

/** First sentence of a blob of text, for deriving a subject an app didn't give us. */
function firstSentence(s: string, max = 78): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  const stop = flat.search(/[.!?](\s|$)/);
  const one = stop > 0 ? flat.slice(0, stop + 1) : flat;
  return one.length <= max ? one : `${one.slice(0, one.lastIndexOf(' ', max - 1)).trim()}…`;
}

/**
 * Tidy a subject line. Strips control characters and newlines (a header must be one
 * line), collapses whitespace, and cuts on a word boundary rather than mid-word.
 * 78 is the practical budget — Gmail's web list truncates around 70, and the old
 * 200-char slice guaranteed an ugly mid-word cut.
 */
function cleanSubject(s: string, max = 78): string {
  // eslint-disable-next-line no-control-regex -- header injection / stray control chars
  const flat = s.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.lastIndexOf(' ', max - 1);
  return `${flat.slice(0, cut > 20 ? cut : max - 1).trim()}…`;
}

export type AlertResult = {
  delivered: boolean;
  email: boolean;
  webhook: boolean;
  /** Whether the message was QUEUED for WhatsApp — not whether it has arrived. */
  whatsapp: boolean;
  reason?: string;
};

/**
 * Deliver an admin alert to the channels the admin routed it to (email and/or
 * webhook), each fail-soft. Returns which channels succeeded. If the admin turned
 * both channels off, nothing is sent.
 */
export async function deliverAlert(input: AlertInput): Promise<AlertResult> {
  const ch = getAlertChannels(input.source, input.alertId);
  if (!ch.email && !ch.webhook && !ch.whatsapp) {
    return { delivered: false, email: false, webhook: false, whatsapp: false, reason: 'disabled_by_admin' };
  }
  const label = (input.sourceName || (input.source === 'os' ? 'OpenMasjidOS' : input.source)).trim();

  // Email channel → the admin's address (if configured + routed here).
  let email = false;
  if (ch.email) {
    const to = getAdminEmail();
    if (to) {
      // Attribution appears ONCE. It used to appear three times over — a
      // `[OpenMasjidOS]` subject prefix, a `— OpenMasjidOS · OpenMasjidOS alert`
      // line in the body (for an OS alert, `label` IS "OpenMasjidOS", so it read
      // as that literal duplication), and the template's own footer. The footer
      // is now the only place, and an app's name rides in the subject because
      // that genuinely identifies who is telling you something.
      const title = input.title || firstSentence(input.text);
      const subject = cleanSubject(input.source === 'os' ? title : `${title} — ${label}`);
      const r = await sendBrandedEmail(
        {
          to,
          subject,
          title,
          // An app-raised alert has no `summary`, so its `text` becomes the lead
          // line — which is also what the inbox snippet is drawn from.
          summary: input.summary || input.text,
          detail: input.detail,
          facts: input.facts,
          action: input.action,
        },
        'os',
      );
      email = r.sent;
    }
  }

  // Webhook channel → the existing Fabric notifications path (attribution server-resolved).
  let webhook = false;
  if (ch.webhook) {
    const w = await sendNotification({ title: input.title, text: input.text, level: input.level }, input.source, label);
    webhook = w.delivered;
  }

  // WhatsApp channel → the admin's own number, through the paced queue. `queued` is
  // the honest word: human pacing means this can be minutes away, and a rate cap can
  // make it hours. An alert is exactly the right shape for that (it is information,
  // not a login code) — but it is why email stays on by default and this does not.
  let whatsapp = false;
  if (ch.whatsapp) {
    const to = getAdminPhone();
    if (to) {
      const title = input.title || firstSentence(input.text);
      // One plain message. No markdown, no links, no footer: a WhatsApp message that
      // looks like a templated broadcast is the thing that gets a number flagged.
      const body = input.source === 'os' ? `${title}\n\n${input.text}` : `${label}: ${title}\n\n${input.text}`;
      const r = enqueueWhatsApp({ to, text: body, source: `alert:${input.source}` });
      whatsapp = r.queued;
    }
  }

  return { delivered: email || webhook || whatsapp, email, webhook, whatsapp };
}
