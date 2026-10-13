// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * An app's logs, rendered inside a floating window (opened from the app card's
 * "View logs"). Auto-refreshes and sticks to the bottom, like a live tail.
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { useWindowVisible } from './Windows';

export function AppLogs({ id }: { id: string }) {
  const { t } = useTranslation();
  // Polled only while the window is showing — each fetch runs `docker compose logs` —
  // and read once straight away when it comes back from the dock.
  const visible = useWindowVisible();
  const logs = trpc.apps.logs.useQuery({ id, tail: 400 }, { refetchInterval: visible ? 3000 : false });
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisible.current) void logs.refetch();
    wasVisible.current = visible;
    // `logs.refetch` is stable; this is about the visibility changing, nothing else.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
  const ref = useRef<HTMLPreElement>(null);
  const prevData = useRef<string | undefined>(undefined);

  useEffect(() => {
    // A 3s poll often returns byte-identical logs; skip the scroll write when
    // nothing changed so we don't touch the DOM on every idle refetch.
    if (logs.data === prevData.current) return;
    prevData.current = logs.data;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.data]);

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.55rem' }}>
        <button className="btn btn--sm" onClick={() => logs.refetch()} disabled={logs.isFetching}>
          <RefreshCw size={14} /> {t('appDetail.refreshLogs')}
        </button>
      </div>
      <pre ref={ref} className="logs glass-inset" style={{ minHeight: '24rem', maxHeight: '62vh', margin: 0 }}>
        {logs.data?.trim() || t('appDetail.noLogs')}
      </pre>
    </>
  );
}
