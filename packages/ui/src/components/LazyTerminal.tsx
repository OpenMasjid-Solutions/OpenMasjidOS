// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Lazily loads the xterm.js terminal (a sizeable dependency) only when a shell
 * is actually opened, so it stays out of the initial bundle and the dashboard
 * loads faster. Same props as Terminal.
 */
import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';

const TerminalImpl = lazy(() => import('./Terminal').then((m) => ({ default: m.Terminal })));

export function LazyTerminal({ wsPath }: { wsPath: string }) {
  const { t } = useTranslation();
  return (
    <Suspense fallback={<div className="hint" style={{ padding: '1rem' }}>{t('common.loading')}</div>}>
      <TerminalImpl wsPath={wsPath} />
    </Suspense>
  );
}
