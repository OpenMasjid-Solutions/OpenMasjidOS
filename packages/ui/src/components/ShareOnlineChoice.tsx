// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The "share this over the internet" question, asked the same way on every install path
 * (the App Store, community apps, a pasted compose file). Ticking it only means something
 * once Remote access is set up, so it says so when it is not, rather than letting the
 * admin think the app is now reachable.
 */
import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { trpc } from '../lib/trpc';
import { CheckboxField } from './CheckboxField';

export function ShareOnlineChoice({
  id,
  value,
  onChange,
  hint,
  style,
}: {
  id: string;
  value: boolean;
  onChange: (v: boolean) => void;
  /** The line under the label: what sharing means for this app (already translated). */
  hint: string;
  style?: CSSProperties;
}) {
  const { t } = useTranslation();
  const cf = trpc.cloudflare.status.useQuery(undefined, { enabled: value });
  const remoteReady = cf.data?.enabled === true && Boolean(cf.data?.domain);
  return (
    <div className="glass-inset panel" style={style}>
      <CheckboxField id={id} checked={value} onChange={onChange} align="start" flush>
        <span>
          <span style={{ fontWeight: 600 }}>{t('store.shareOnline')}</span>
          <span className="setting-row__hint" style={{ display: 'block' }}>
            {hint}
          </span>
        </span>
      </CheckboxField>
      {value && !remoteReady && (
        <p
          className="setting-row__hint"
          style={{ marginBlockStart: '0.6rem', color: 'var(--color-gold, #F59E0B)' }}
        >
          {t('store.shareOnlineNoRemote')}{' '}
          <Link to="/settings/remote" style={{ color: 'var(--color-primary)' }}>
            {t('store.shareOnlineSettingsLink')}
          </Link>
        </p>
      )}
      <p className="setting-row__hint" style={{ marginBlockStart: '0.5rem' }}>
        {t('store.shareOnlineChangeLater')}
      </p>
    </div>
  );
}
