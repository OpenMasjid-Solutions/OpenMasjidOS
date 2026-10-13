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
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { isPrerelease } from '../lib/version';
import { appUpdateEnding } from '../lib/update-endings';
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
  // migration replay itself for ever. Updating the OS restarted the core, which then
  // dropped every session (they were held in memory); the dashboard fell back to the
  // sign-in screen, which unmounted AppShell — where the windows render — so THIS
  // component unmounted while the window itself survived in WindowsProvider, then above
  // the router. Signing back in remounted it with `index` reset to 0 and the original,
  // now-stale list, so it updated every app again and finished by updating the OS again,
  // which signed you out again. Sessions now survive a restart and the windows close on
  // sign-out (WindowsProvider lives in AppShell), but a remount must still not replay.
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
  // What each stream said, not that it ended (lib/update-endings.ts): "All your apps are
  // now on Stable" was shown over a run in which one had been refused or put back — and
  // "Now updating OpenMasjidOS itself" over an OS step that changed nothing.
  const [moved, setMoved] = useState(0);
  const [osUnchanged, setOsUnchanged] = useState(false);
  const allMoved = moved === apps.length;
  const appsSummary = allMoved
    ? t('settings.channelMigrateDone', { label: channelLabel })
    : t('settings.channelMigratePartial', { moved, total: apps.length, label: channelLabel });

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
            ? osUnchanged
              ? `${allMoved ? '' : `${appsSummary} `}${t('settings.channelMigrateOsUnchanged')}`
              : allMoved
                ? t('settings.channelMigrateOs', { label: channelLabel })
                : `${appsSummary} ${t('settings.channelMigrateOsNow')}`
            : appsSummary
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
          onClosed={(code, opened) => {
            if (appUpdateEnding(code, opened) === 'updated') setMoved((n) => n + 1);
            utils.apps.get.invalidate({ id: current.id });
            setIndex((i) => i + 1);
          }}
        />
      )}

      {/* The OS last: this stream ends with the dashboard restarting under us. A close
          that says nothing was changed (any 4xxx — refused from outside, already there,
          a download that failed), or one that never connected, is said so. */}
      {appsDone && osStarted && (
        <LogStream
          wsPath="/api/update"
          onClosed={(code, opened) => {
            if (!opened || (code >= 4000 && code <= 4999)) setOsUnchanged(true);
          }}
        />
      )}

      {appsDone && !plan?.os && (
        <p style={{ marginBlockStart: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {allMoved ? (
            <CheckCircle2 size={16} style={{ color: 'var(--color-success)' }} />
          ) : (
            <AlertTriangle size={16} style={{ color: 'var(--color-warning)' }} />
          )}
          {appsSummary}
        </p>
      )}
    </div>
  );
}
