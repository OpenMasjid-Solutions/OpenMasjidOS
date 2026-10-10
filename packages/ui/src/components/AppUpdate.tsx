// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Streams a catalog app's update (download → apply) into a window, then says how it
 * ended and refreshes the app list. Opened from the app card's "Check for update"
 * once the user confirms.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../lib/trpc';
import { appUpdateEnding, type AppUpdateEnding } from '../lib/update-endings';
import { LogStream } from './LogStream';

type Ending = AppUpdateEnding;

export function AppUpdate({
  id,
  name,
  onDone,
}: {
  id: string;
  name: string;
  /** Called once the update has finished, so the window that owns this can unlock. */
  onDone?: () => void;
}) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const [ending, setEnding] = useState<Ending | null>(null);

  const words: Record<Ending, string> = {
    updated: t('appUpdate.done', { name }),
    unchanged: t('appUpdate.unchanged'),
    notRunning: t('appUpdate.notRunning', { name }),
    stopped: t('appUpdate.stopped', { name }),
    lost: t('appUpdate.lost', { name }),
    unreachable: t('appUpdate.unreachable'),
  };

  return (
    <>
      <LogStream
        wsPath={`/api/apps/update?id=${encodeURIComponent(id)}`}
        onClosed={(code, opened) => {
          setEnding(appUpdateEnding(code, opened));
          utils.apps.list.invalidate();
          utils.apps.get.invalidate({ id });
          onDone?.();
        }}
      />
      {ending === null && (
        <p className="hint" style={{ marginTop: '0.6rem' }}>
          {t('update.dontClose')}
        </p>
      )}
      {ending !== null && (
        <p style={{ marginTop: '0.7rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {ending === 'updated' && <span className="status-dot" />} {words[ending]}
        </p>
      )}
    </>
  );
}
