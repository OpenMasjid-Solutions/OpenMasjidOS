// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { useTranslation } from 'react-i18next';
import { trpc } from '../../lib/trpc';
import { Toggle } from '../../components/Toggle';
import { useToast } from '../../components/ToastProvider';
import { errorText } from '../../lib/errors';

/** Granular alert matrix (UniFi-style): OS built-ins + each app's declared alerts,
 *  each routable to Email and/or Webhook (both on by default; both off = muted). */
export function AlertsPanel() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const list = trpc.alerts.list.useQuery();
  const setChannel = trpc.alerts.setChannel.useMutation({
    onSuccess: () => utils.alerts.list.invalidate(),
    onError: (e) => toast(errorText(e, t('errors.generic')), 'error'),
  });

  const rows = list.data ?? [];
  // Group by source for a tidy list.
  const groups = new Map<string, { label: string; items: typeof rows }>();
  for (const r of rows) {
    const g = groups.get(r.source) ?? { label: r.sourceLabel, items: [] as typeof rows };
    g.items.push(r);
    groups.set(r.source, g);
  }

  const colHead = { width: '4.5rem', textAlign: 'center' as const, color: 'var(--color-ink-muted)', fontSize: '0.8rem', paddingInlineStart: '0.4rem' };

  return (
    <section className="glass-raised panel">
      <h2 className="panel-title">{t('settings.alerts')}</h2>
      <p className="setting-row__hint" style={{ marginBlockEnd: '0.5rem' }}>{t('settings.alertsHint')}</p>
      {rows.length === 0 && <p className="setting-row__hint">{t('settings.alertsNone')}</p>}
      {[...groups.entries()].map(([source, g]) => (
        <div key={source} style={{ marginBlockStart: '0.7rem' }}>
          <div style={{ display: 'flex', alignItems: 'end', marginBlockEnd: '0.15rem' }}>
            <div className="setting-row__title" style={{ flex: 1, color: 'var(--color-ink-muted)' }}>{g.label}</div>
            <div style={colHead}>{t('settings.alertsEmail')}</div>
            <div style={colHead}>{t('settings.alertsWebhook')}</div>
            <div style={colHead}>{t('settings.alertsWhatsapp')}</div>
          </div>
          {g.items.map((r) => (
            <div className="setting-row" key={`${r.source}:${r.id}`}>
              <div className="setting-row__text" style={{ flex: 1 }}>
                <div className="setting-row__title">{r.label}</div>
                {r.description && <div className="setting-row__hint">{r.description}</div>}
              </div>
              <div style={{ width: '4.5rem', display: 'flex', justifyContent: 'center', paddingInlineStart: '0.4rem' }}>
                <Toggle
                  checked={r.channels.email}
                  onChange={(v) => setChannel.mutate({ source: r.source, id: r.id, channel: 'email', enabled: v })}
                  label={`${r.label} — ${t('settings.alertsEmail')}`}
                />
              </div>
              <div style={{ width: '4.5rem', display: 'flex', justifyContent: 'center', paddingInlineStart: '0.4rem' }}>
                <Toggle
                  checked={r.channels.webhook}
                  onChange={(v) => setChannel.mutate({ source: r.source, id: r.id, channel: 'webhook', enabled: v })}
                  label={`${r.label} — ${t('settings.alertsWebhook')}`}
                />
              </div>
              {/* WhatsApp is only for the platform's own alerts. An app that messages
                  people over WhatsApp is reaching a parent or a donor, not the admin's
                  phone — so who it messages, and what it says, belongs in that app's own
                  settings. A toggle here would have implied the platform could route an
                  app's messages to the right people, when it only knows one number. */}
              <div
                style={{
                  width: '4.5rem',
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                  paddingInlineStart: '0.4rem',
                }}
              >
                {r.whatsappAvailable ? (
                  <Toggle
                    checked={r.channels.whatsapp}
                    onChange={(v) => setChannel.mutate({ source: r.source, id: r.id, channel: 'whatsapp', enabled: v })}
                    label={`${r.label} — ${t('settings.alertsWhatsapp')}`}
                  />
                ) : (
                  <span className="hint" style={{ textAlign: 'center', lineHeight: 1.2 }}>
                    {t('settings.alertsWhatsappInApp')}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
