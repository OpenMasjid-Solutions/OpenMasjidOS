// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Moves every app onto the selected update channel, one at a time, then the OS.
 *
 * Reuses the existing per-app update stream (`/api/apps/update`) rather than adding
 * a bulk endpoint: that path already rewrites the compose, re-pulls, recreates the
 * container and preserves the named volumes and the app's `.env`, and it has been
 * exercised by every ordinary update. A new "migrate" endpoint would be a second
 * implementation of the risky part.
 *
 * SEQUENTIAL, deliberately. Pulling four images at once on a Raspberry Pi with one
 * uplink is slower than doing them in turn, and it would take every app down
 * simultaneously — a masjid would lose its prayer display, its donations page and
 * its kiosk in the same moment instead of one for a few seconds each.
 *
 * The OS is LAST, because updating it restarts the dashboard and would kill this
 * window mid-run.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2 } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { LogStream } from './LogStream';

interface PendingApp {
  id: string;
  name: string;
}

export function ChannelMigrate({
  apps,
  channelLabel,
  /** True when returning to Stable, where the OS should follow the apps back. */
  revertOs,
}: {
  apps: PendingApp[];
  channelLabel: string;
  revertOs: boolean;
}) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const [index, setIndex] = useState(0);
  const [osStarted, setOsStarted] = useState(false);

  const current = apps[index];
  const appsDone = index >= apps.length;

  // Once every app has moved, bring the OS across too. Automatic rather than
  // another button: the admin already confirmed the channel change, and leaving the
  // platform on the other channel's image is exactly the "mixed channel" state the
  // whole feature exists to prevent.
  useEffect(() => {
    if (appsDone && revertOs && !osStarted) setOsStarted(true);
  }, [appsDone, revertOs, osStarted]);

  useEffect(() => {
    if (appsDone) {
      utils.apps.list.invalidate();
      utils.system.channel.invalidate();
    }
  }, [appsDone, utils]);

  return (
    <div>
      <p className="setting-row__hint" style={{ marginBlockEnd: '0.7rem' }}>
        {appsDone
          ? osStarted
            ? t('settings.channelMigrateOs', { label: channelLabel })
            : t('settings.channelMigrateDone', { label: channelLabel })
          : t('settings.channelMigrateProgress', {
              current: index + 1,
              total: apps.length,
              name: current?.name ?? '',
              label: channelLabel,
            })}
      </p>

      {/* One app at a time. `key` forces a fresh stream per app — without it React
          would reuse the socket and the next app's output would never arrive. */}
      {!appsDone && current && (
        <LogStream
          key={current.id}
          wsPath={`/api/apps/update?id=${encodeURIComponent(current.id)}`}
          onClosed={() => {
            utils.apps.get.invalidate({ id: current.id });
            setIndex((i) => i + 1);
          }}
        />
      )}

      {/* The OS last: this stream ends with the dashboard restarting under us, which
          LogStream's reconnect already handles for the ordinary update path. */}
      {appsDone && osStarted && <LogStream wsPath="/api/update" />}

      {appsDone && !revertOs && (
        <p style={{ marginBlockStart: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <CheckCircle2 size={16} style={{ color: 'var(--color-success)' }} />
          {t('settings.channelMigrateDone', { label: channelLabel })}
        </p>
      )}
    </div>
  );
}
