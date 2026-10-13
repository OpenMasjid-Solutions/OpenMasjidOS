// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { useTranslation } from 'react-i18next';
import { Heart } from 'lucide-react';

/** Easter egg — shown when the "Check for updates" button is spam-clicked. */
export function EagerNote({ sourceUrl }: { sourceUrl?: string }) {
  const { t } = useTranslation();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: '0.85rem', padding: '0.5rem 0.25rem' }}>
      <Heart size={40} style={{ color: 'var(--color-primary)' }} />
      <h3 style={{ margin: 0, fontFamily: 'var(--font-display)' }}>{t('settings.eagerTitle')}</h3>
      <p style={{ color: 'var(--color-ink-muted)', maxWidth: '30rem', lineHeight: 1.55 }}>{t('settings.eagerBody')}</p>
      <a className="btn btn--primary" href={sourceUrl ?? 'https://github.com/OpenMasjid-Solutions/OpenMasjidOS'} target="_blank" rel="noopener noreferrer">
        <Heart size={15} /> {t('settings.eagerDonate')}
      </a>
    </div>
  );
}
