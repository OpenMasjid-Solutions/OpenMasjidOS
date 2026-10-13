// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { Toggle } from '../../components/Toggle';
import { useToast } from '../../components/ToastProvider';
import { cn } from '../../lib/cn';
import { errorText } from '../../lib/errors';

type NotifType = 'slack' | 'discord' | 'generic';

export function NotificationsPanel() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const settings = trpc.settings.get.useQuery();
  // URL/label are edited locally and saved on blur; enabled/type save immediately. Each
  // holds what was typed, or null while its box still shows what is stored — the server
  // takes all four fields at once, and re-sending what the page opened with put back a
  // webhook another device had changed since.
  const [url, setUrl] = useState<string | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const save = trpc.settings.update.useMutation({
    onSuccess: async (_r, vars) => {
      await utils.settings.get.invalidate();
      // Back to showing what is stored — but only for an edit that was saved as it
      // stands, so a box being typed in while this was in flight keeps its text.
      setUrl((u) => (u === vars.notifications?.url ? null : u));
      setLabel((l) => (l === vars.notifications?.label ? null : l));
    },
    // Without this a refused save (an address that is not http(s), any change while a
    // backup is being restored) said nothing at all.
    onError: (e) => toast(errorText(e, t('errors.generic')), 'error'),
  });
  const test = trpc.notifications.test.useMutation({
    onSuccess: () => toast(t('settings.notificationsTestSent'), 'success'),
    onError: (e) => toast(errorText(e, t('settings.notificationsTestFailed')), 'error'),
  });

  const n = settings.data?.notifications;
  if (!n) return null;

  const shownUrl = url ?? n.url;
  const shownLabel = label ?? n.label;
  const edited = shownUrl !== n.url || shownLabel !== n.label;
  const config = (next: { enabled?: boolean; type?: NotifType; url?: string; label?: string }) => ({
    enabled: n.enabled,
    type: n.type,
    url: shownUrl,
    label: shownLabel,
    ...next,
  });
  const patch = (next: Parameters<typeof config>[0]) => save.mutate({ notifications: config(next) });
  const saveIfEdited = () => {
    if (edited) patch({});
  };

  const types: Array<{ id: NotifType; label: string }> = [
    { id: 'slack', label: t('settings.notificationsSlack') },
    { id: 'discord', label: t('settings.notificationsDiscord') },
    { id: 'generic', label: t('settings.notificationsGeneric') },
  ];

  return (
    <section className="glass-raised panel">
      <h2 className="panel-title">{t('settings.notifications')}</h2>
      <p className="setting-row__hint" style={{ marginBlockEnd: '0.5rem' }}>{t('settings.notificationsHint')}</p>

      <div className="setting-row">
        <div className="setting-row__text"><div className="setting-row__title">{t('settings.notificationsEnable')}</div></div>
        <Toggle checked={n.enabled} onChange={(v) => patch({ enabled: v })} label={t('settings.notificationsEnable')} />
      </div>

      {n.enabled && (
        <>
          <div className="setting-row">
            <div className="setting-row__text"><div className="setting-row__title">{t('settings.notificationsService')}</div></div>
            <div className="segmented glass-inset">
              {types.map((ty) => (
                <button
                  key={ty.id}
                  className={cn(n.type === ty.id && 'is-active')}
                  aria-pressed={n.type === ty.id}
                  onClick={() => patch({ type: ty.id })}
                >
                  {ty.label}
                </button>
              ))}
            </div>
          </div>

          <div className="setting-row">
            <div className="setting-row__text">
              <div className="setting-row__title">{t('settings.notificationsUrl')}</div>
              <div className="setting-row__hint">{t('settings.notificationsUrlHint')}</div>
            </div>
            <input
              className="input glass-inset"
              style={{ maxWidth: '18rem' }}
              type="url"
              placeholder="https://hooks.slack.com/…"
              aria-label={t('settings.notificationsUrl')}
              value={shownUrl}
              onChange={(e) => setUrl(e.target.value.trim())}
              onBlur={saveIfEdited}
            />
          </div>

          <div className="setting-row">
            <div className="setting-row__text">
              <div className="setting-row__title">{t('settings.notificationsLabel')}</div>
              <div className="setting-row__hint">{t('settings.notificationsLabelHint')}</div>
            </div>
            <input
              className="input glass-inset"
              style={{ maxWidth: '14rem' }}
              aria-label={t('settings.notificationsLabel')}
              value={shownLabel}
              onChange={(e) => setLabel(e.target.value)}
              onBlur={saveIfEdited}
            />
          </div>

          <div className="setting-row">
            <div className="setting-row__text"><div className="setting-row__title">{t('settings.notificationsTest')}</div></div>
            <button
              className="btn"
              disabled={test.isPending || !shownUrl}
              // Keeps focus in the box being edited, so its own save-on-blur does not run
              // as well: one save (below), then the test.
              onMouseDown={(e) => e.preventDefault()}
              onClick={async () => {
                // Persist what is in the boxes first so the test uses them — and stop if
                // that was refused: the test would otherwise go to the webhook stored
                // before, and say "sent".
                if (edited) {
                  try {
                    await save.mutateAsync({ notifications: config({}) });
                  } catch {
                    return; // the save has already said why
                  }
                }
                test.mutate();
              }}
            >
              <Bell size={15} /> {test.isPending ? t('settings.notificationsTesting') : t('settings.notificationsTest')}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
