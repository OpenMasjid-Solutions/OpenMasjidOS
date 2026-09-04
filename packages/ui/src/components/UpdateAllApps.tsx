// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Updates every app that has a newer version, one after another, in one window.
 *
 * Reuses the per-app update stream (`/api/apps/update`) rather than adding a bulk
 * endpoint — the same reasoning as `ChannelMigrate`. That path already re-checks the
 * refreshed compose against the install-time risk gate, re-pulls, recreates the
 * container, keeps the named volumes and the app's `.env`, and — the part that matters
 * here — **verifies the container was still up afterwards** rather than trusting
 * `compose up` exiting 0. A new bulk endpoint would be a second implementation of every
 * one of those, and the startup check is exactly the thing you would not notice was
 * missing until an app quietly failed to come back.
 *
 * SEQUENTIAL, deliberately. Pulling several images at once over a masjid's single uplink
 * is not faster, and it would take every app down in the same moment — the prayer
 * display, the donations page and the kiosk together — instead of one at a time for a
 * few seconds each.
 *
 * The OS is NOT touched. Updating the core restarts the dashboard, which would kill this
 * window mid-run; the core has its own update button that knows how to survive that.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { LogStream } from './LogStream';

export interface UpdatableApp {
  id: string;
  name: string;
}

export function UpdateAllApps({ apps, onDone }: { apps: UpdatableApp[]; onDone?: () => void }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const [index, setIndex] = useState(0);

  /**
   * The list is snapshotted on first render and never re-read.
   *
   * `ChannelMigrate` learned this the hard way in the other direction: it took a prop
   * captured at open time and replayed itself for ever. The fix there was to read live
   * state once and then freeze it, and the freezing half applies here too — each finished
   * app invalidates `apps.updates`, so a list read live would shrink underneath `index`
   * and skip whatever moved up into the slot just vacated.
   */
  const [plan] = useState<UpdatableApp[]>(() => apps);
  const current = plan[index];
  const done = index >= plan.length;

  useEffect(() => {
    if (!done) return;
    utils.apps.list.invalidate();
    utils.apps.updates.invalidate();
    onDone?.();
    // `onDone` unlocks the window; running it once on completion is the whole point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  if (plan.length === 0) {
    return (
      <p style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <CheckCircle2 size={16} style={{ color: 'var(--color-success)' }} />
        {t('updateAll.nothing')}
      </p>
    );
  }

  return (
    <div>
      <p className="setting-row__hint" style={{ marginBlockEnd: '0.7rem' }}>
        {done
          ? t('updateAll.done', { count: plan.length })
          : t('updateAll.progress', { current: index + 1, total: plan.length, name: current?.name ?? '' })}
      </p>

      {/* One app at a time. `key` forces a fresh stream per app — without it React reuses
          the socket and the next app's output never arrives (the bug ChannelMigrate hit). */}
      {!done && current && (
        <LogStream
          key={current.id}
          wsPath={`/api/apps/update?id=${encodeURIComponent(current.id)}`}
          onClosed={() => {
            utils.apps.get.invalidate({ id: current.id });
            setIndex((i) => i + 1);
          }}
        />
      )}

      {done && (
        <>
          <p style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBlockStart: '0.8rem' }}>
            <CheckCircle2 size={16} style={{ color: 'var(--color-success)' }} />
            {t('updateAll.done', { count: plan.length })}
          </p>
          {/* Said plainly, because "all done" over a stream that reported a failure would
              be the dashboard contradicting what the admin just watched scroll past. An
              app that did not come back leaves its reason in the log above, and the
              per-app check in the update path is what puts it there. */}
          <p className="setting-row__hint" style={{ display: 'flex', gap: '0.45rem', marginBlockStart: '0.5rem' }}>
            <AlertTriangle size={15} style={{ flex: '0 0 auto', marginBlockStart: '0.1rem' }} />
            <span>{t('updateAll.checkAbove')}</span>
          </p>
        </>
      )}
    </div>
  );
}
