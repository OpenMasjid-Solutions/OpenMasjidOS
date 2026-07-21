// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Admin alerts + a granular per-alert × per-channel matrix (UniFi-style). An alert
 * is a message the ADMIN cares about — an app going offline, an app-declared event
 * (a camera/reader offline, a failed payment). For EACH alert type the admin
 * chooses which channels it goes to: the admin **email**, the **webhook**, both, or
 * neither (off). Default: both channels on.
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
import { getAdminEmail } from '../auth/store';
import { listAppAlerts } from '../apps/manager';
import { sendEmail } from './email';
import { sendNotification, type NotifyInput } from './notify';

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
];

export interface AlertChannels {
  email: boolean;
  webhook: boolean;
}
const DEFAULT_CHANNELS: AlertChannels = { email: true, webhook: true };
const isDefault = (c: AlertChannels) => c.email && c.webhook;

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
      map.set(k, { email: v.email !== false, webhook: v.webhook !== false });
    }
  }
  // Migrate a legacy fully-disabled set → both channels off.
  if (Array.isArray(file.disabled)) {
    for (const k of file.disabled) if (!map.has(k)) map.set(k, { email: false, webhook: false });
  }
  return map;
}

const channels = load();

function persist(): void {
  writeJson(ALERTS_PATH, { channels: Object.fromEntries(channels) });
}

/** The channel routing for an alert type — defaults to both channels on. */
export function getAlertChannels(source: string, id: string): AlertChannels {
  return channels.get(key(source, id)) ?? { ...DEFAULT_CHANNELS };
}

/** Turn a single channel on/off for an alert type. Non-default choices are
 *  persisted; a return to the default (both on) drops the entry to keep the file lean. */
export function setAlertChannel(source: string, id: string, channel: keyof AlertChannels, enabled: boolean): void {
  const next: AlertChannels = { ...getAlertChannels(source, id), [channel]: enabled };
  if (isDefault(next)) channels.delete(key(source, id));
  else channels.set(key(source, id), next);
  persist();
}

export interface AlertTypeInfo {
  source: string; // 'os' or an app id
  sourceLabel: string; // display name of the source
  id: string;
  label: string;
  description?: string;
  channels: AlertChannels;
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
}

export type AlertResult = { delivered: boolean; email: boolean; webhook: boolean; reason?: string };

/**
 * Deliver an admin alert to the channels the admin routed it to (email and/or
 * webhook), each fail-soft. Returns which channels succeeded. If the admin turned
 * both channels off, nothing is sent.
 */
export async function deliverAlert(input: AlertInput): Promise<AlertResult> {
  const ch = getAlertChannels(input.source, input.alertId);
  if (!ch.email && !ch.webhook) {
    return { delivered: false, email: false, webhook: false, reason: 'disabled_by_admin' };
  }
  const label = (input.sourceName || (input.source === 'os' ? 'OpenMasjidOS' : input.source)).trim();

  // Email channel → the admin's address (if configured + routed here).
  let email = false;
  if (ch.email) {
    const to = getAdminEmail();
    if (to) {
      const subject = `[${label}] ${input.title || input.text}`.slice(0, 200);
      const body = `${input.title ? input.title + '\n\n' : ''}${input.text}\n\n— ${label} · OpenMasjidOS alert`;
      const r = await sendEmail({ to, subject, text: body }, 'os');
      email = r.sent;
    }
  }

  // Webhook channel → the existing Fabric notifications path (attribution server-resolved).
  let webhook = false;
  if (ch.webhook) {
    const w = await sendNotification({ title: input.title, text: input.text, level: input.level }, input.source, label);
    webhook = w.delivered;
  }

  return { delivered: email || webhook, email, webhook };
}
