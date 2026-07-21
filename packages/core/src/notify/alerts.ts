// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Admin alerts + granular controls (UniFi-style). An alert is a message the admin
 * cares about — an app going offline, an app-declared event (a camera/reader
 * offline, a failed payment), etc. Every alert TYPE has an on/off in Settings →
 * Alerts (all ON by default). When an alert fires, if its type is enabled it is
 * delivered to the admin's email AND the configured webhook (both fail-soft; the
 * webhook path — POST /api/fabric/notify — stays fully working on its own).
 *
 * Alert types come from two sources: OS built-ins (below) and each installed app's
 * manifest `alerts:` list (via apps/manager). We persist only the DISABLED set, so
 * a newly-installed app's alerts (and new OS alerts) default on without migration.
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

const ALERTS_PATH = path.join(CONFIG_DIR, 'alerts.json');
interface AlertsFile {
  disabled: string[];
}
const disabled = new Set<string>(readJson<AlertsFile>(ALERTS_PATH, { disabled: [] }).disabled);

const key = (source: string, id: string) => `${source}:${id}`;

/** Is this alert type on? Default ON — we only persist the disabled ones. */
export function isAlertEnabled(source: string, id: string): boolean {
  return !disabled.has(key(source, id));
}

export function setAlertEnabled(source: string, id: string, enabled: boolean): void {
  if (enabled) disabled.delete(key(source, id));
  else disabled.add(key(source, id));
  writeJson(ALERTS_PATH, { disabled: [...disabled] });
}

export interface AlertTypeInfo {
  source: string; // 'os' or an app id
  sourceLabel: string; // display name of the source
  id: string;
  label: string;
  description?: string;
  enabled: boolean;
}

/** All known alert types (OS built-ins + every installed app's declared alerts),
 *  each with its current on/off — for the granular Settings → Alerts list. */
export function listAlertTypes(): AlertTypeInfo[] {
  const out: AlertTypeInfo[] = OS_ALERTS.map((a) => ({
    source: 'os',
    sourceLabel: 'OpenMasjidOS',
    id: a.id,
    label: a.label,
    description: a.description,
    enabled: isAlertEnabled('os', a.id),
  }));
  for (const app of listAppAlerts()) {
    for (const a of app.alerts) {
      out.push({
        source: app.appId,
        sourceLabel: app.appName,
        id: a.id,
        label: a.label,
        description: a.description,
        enabled: isAlertEnabled(app.appId, a.id),
      });
    }
  }
  return out;
}

export interface AlertInput extends NotifyInput {
  /** 'os' or the raising app's id. */
  source: string;
  /** The alert type id (must be enabled to deliver). */
  alertId: string;
  /** Display name of the source (server-resolved for apps). */
  sourceName?: string;
}

export type AlertResult = { delivered: boolean; email: boolean; webhook: boolean; reason?: string };

/**
 * Deliver an admin alert: gated by the granular toggle, then sent to the admin
 * email AND the webhook (both fail-soft). Returns which channels succeeded.
 */
export async function deliverAlert(input: AlertInput): Promise<AlertResult> {
  if (!isAlertEnabled(input.source, input.alertId)) {
    return { delivered: false, email: false, webhook: false, reason: 'disabled_by_admin' };
  }
  const label = (input.sourceName || (input.source === 'os' ? 'OpenMasjidOS' : input.source)).trim();

  // Email to the admin (if an email + provider are configured).
  let email = false;
  const to = getAdminEmail();
  if (to) {
    const subject = `[${label}] ${input.title || input.text}`.slice(0, 200);
    const body = `${input.title ? input.title + '\n\n' : ''}${input.text}\n\n— ${label} · OpenMasjidOS alert`;
    const r = await sendEmail({ to, subject, text: body }, 'os');
    email = r.sent;
  }

  // Webhook (the existing Fabric notifications path; attribution server-resolved).
  const w = await sendNotification(
    { title: input.title, text: input.text, level: input.level },
    input.source,
    label,
  );
  const webhook = w.delivered;

  return { delivered: email || webhook, email, webhook };
}
