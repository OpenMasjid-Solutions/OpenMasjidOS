// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Streams a catalog app's update (download → apply) into a window, then marks it
 * done and refreshes the app list. Opened from the app card's "Check for update"
 * once the user confirms.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../lib/trpc';
import { LogStream } from './LogStream';

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
  const [done, setDone] = useState(false);

  return (
    <>
      <LogStream
        wsPath={`/api/apps/update?id=${encodeURIComponent(id)}`}
        onClosed={() => {
          setDone(true);
          utils.apps.list.invalidate();
          utils.apps.get.invalidate({ id });
          onDone?.();
        }}
      />
      {!done && (
        <p className="hint" style={{ marginTop: '0.6rem' }}>
          {t('update.dontClose')}
        </p>
      )}
      {done && (
        <p style={{ marginTop: '0.7rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span className="status-dot" /> {t('appUpdate.done', { name })}
        </p>
      )}
    </>
  );
}
