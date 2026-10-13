// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { useTranslation } from 'react-i18next';
import { Wifi } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { useToast } from '../../components/ToastProvider';
import { errorText } from '../../lib/errors';

/**
 * Network row. Shows the address the CORE believes this machine has, not
 * `window.location.host` — the browser's URL bar is what the admin typed and told
 * us nothing about what the platform hands to apps, which is exactly how a stale
 * address went unnoticed after a subnet move.
 */
export function NetworkRow() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const info = trpc.system.info.useQuery();
  const reconnect = trpc.system.reconnectApps.useMutation({
    onSuccess: (r) => toast(t('settings.reconnectDone', { count: r.updated.length }), 'success'),
    onError: (e) => toast(errorText(e, t('errors.generic')), 'error'),
  });
  const net = info.data?.network;
  return (
    <div className="setting-row">
      <div className="setting-row__text">
        <div className="setting-row__title">{t('settings.network')}</div>
        <div className="setting-row__hint">
          {`${t('settings.address')}: ${net?.addresses?.[0] ?? window.location.host}`}
          {/* The machine's name, not `<name>.local`: nothing answers to that name yet
              (mDNS is not built — CLAUDE.md §4), so showing it sent people to an address
              that goes nowhere. */}
          {net?.hostname ? ` · ${net.hostname}` : ''}
        </div>
        <div className="setting-row__hint">{t('settings.reconnectHint')}</div>
      </div>
      <button className="btn" onClick={() => reconnect.mutate()} disabled={reconnect.isPending}>
        <Wifi size={15} /> {reconnect.isPending ? t('settings.reconnecting') : t('settings.reconnect')}
      </button>
    </div>
  );
}
