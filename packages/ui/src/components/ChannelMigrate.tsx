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
import { isPrerelease } from '../lib/version';
import { LogStream } from './LogStream';

interface PendingApp {
  id: string;
  name: string;
}

export function ChannelMigrate({
  channelLabel,
  /** True when returning to Stable, where the OS should follow the apps back. */
  revertOs,
}: {
  channelLabel: string;
  revertOs: boolean;
}) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const [index, setIndex] = useState(0);
  const [osStarted, setOsStarted] = useState(false);

  // What still needs moving, read LIVE and then snapshotted once.
  //
  // It used to arrive as a prop captured when the window was opened, and that made the
  // migration replay itself for ever. Updating the OS restarts the core, which drops
  // every in-memory session; the dashboard falls back to the sign-in screen, which
  // unmounts AppShell — and the window layer renders inside the Dock, so THIS component
  // unmounts while the window itself survives in WindowsProvider above the router.
  // Signing back in remounted it with `index` reset to 0 and the original, now-stale
  // list, so it updated every app again and finished by updating the OS again, which
  // signed you out again. The only escape was closing the window in the seconds before
  // the restart landed.
  //
  // Reading live state means a remount after a completed migration sees nothing pending
  // and simply reports done. Snapshotting it means the list can't shift under the index
  // while we iterate — invalidating the query mid-run is exactly what would do that.
  const channelQ = trpc.system.channel.useQuery();
  const [plan, setPlan] = useState<{ apps: PendingApp[]; os: boolean } | null>(null);
  useEffect(() => {
    if (plan || !channelQ.data) return;
    const d = channelQ.data;
    // The running build states its own channel exactly: a Development build's version
    // is a prerelease, a Stable one is not. So "is the platform still on the wrong
    // channel?" needs no extra endpoint.
    const osWrongChannel = isPrerelease(d.version) !== (d.channel === 'dev');
    setPlan({ apps: d.pending, os: revertOs && osWrongChannel });
  }, [plan, channelQ.data, revertOs]);

  const apps = plan?.apps ?? [];
  const current = apps[index];
  const appsDone = plan !== null && index >= apps.length;

  // Once every app has moved, bring the OS across too. Automatic rather than
  // another button: the admin already confirmed the channel change, and leaving the
  // platform on the other channel's image is exactly the "mixed channel" state the
  // whole feature exists to prevent.
  useEffect(() => {
    if (appsDone && plan?.os && !osStarted) setOsStarted(true);
  }, [appsDone, plan, osStarted]);

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

      {appsDone && !plan?.os && (
        <p style={{ marginBlockStart: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <CheckCircle2 size={16} style={{ color: 'var(--color-success)' }} />
          {t('settings.channelMigrateDone', { label: channelLabel })}
        </p>
      )}
    </div>
  );
}
