// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Settings → Advanced → Update channel (CLAUDE.md §13.4).
 *
 * One segmented control governing the OS, the App Store catalogue and every
 * installed app together. Both directions are confirmed, for different reasons:
 *   → Development: untested software on a box a masjid depends on.
 *   → Stable: a DOWNGRADE. Dev may be ahead in ways that don't reverse cleanly,
 *     so this warns about data rather than pretending it's symmetrical.
 *
 * After a switch the apps do not move on their own — the platform lists what is
 * still on the old channel and offers "Update all", reusing the existing per-app
 * update stream. That is deliberate: recreating every container the instant a
 * toggle flips would take a masjid's displays down with no warning.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GitBranch, Beaker, ShieldCheck } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { ConfirmDialog } from './ConfirmDialog';
import { useToast } from './ToastProvider';
import { cn } from '../lib/cn';

type Channel = 'main' | 'dev';

export function UpdateChannel({ onUpdateAll }: { onUpdateAll?: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const status = trpc.system.channel.useQuery();
  // Which channel the open dialog would switch to; null = no dialog.
  const [pendingTarget, setPendingTarget] = useState<Channel | null>(null);

  const setChannel = trpc.system.setUpdateChannel.useMutation({
    onSuccess: (res) => {
      setPendingTarget(null);
      utils.system.channel.invalidate();
      utils.system.checkUpdate.invalidate();
      utils.system.changelog.invalidate();
      utils.apps.list.invalidate();
      // The store's catalogue is now a different channel's file.
      utils.store.catalog.invalidate();
      toast(t('settings.channelSwitched', { label: label(res.channel) }), 'success');

      // Asymmetric on purpose, and this is the behaviour Hasan asked for:
      //   → Development is OPT-IN per app. You switched to try something; you decide
      //     which apps come with you, and an app you never update stays untouched.
      //   → Stable is the HOME state. Coming back should restore everything without
      //     a checklist, because "get me back to working software" is one decision,
      //     not one per app.
      // Data is preserved either way — an update rewrites the compose and recreates
      // the container; named volumes and the app's .env are never touched.
      if (res.channel === 'main' && res.pending.length > 0 && onUpdateAll) {
        onUpdateAll();
      }
    },
    // The mutation refuses rather than half-switching, so the message is the
    // useful thing to show — it already says the masjid stayed where it was.
    onError: (e) => {
      setPendingTarget(null);
      toast(e.message || t('errors.generic'), 'error');
    },
  });

  const label = (c: Channel) => (c === 'dev' ? t('settings.channelDev') : t('settings.channelStable'));
  const current = status.data?.channel ?? 'main';
  const pending = status.data?.pending ?? [];
  const busy = setChannel.isPending;

  function choose(target: Channel) {
    if (target === current || busy) return;
    setPendingTarget(target); // both directions confirm
  }

  return (
    <div style={{ paddingBlock: '0.9rem', borderBlockStart: '1px solid var(--color-border)' }}>
      <div className="setting-row__title" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <GitBranch size={16} /> {t('settings.channel')}
      </div>
      <div className="setting-row__hint" style={{ marginBlock: '0.2rem 0.7rem' }}>
        {t('settings.channelHint')}
      </div>

      {/* `.segmented glass-inset` + `.is-active` is this repo's existing segmented
          control (the theme picker above uses it), so this matches rather than
          introducing a new paradigm. */}
      <div className="segmented glass-inset" role="group" aria-label={t('settings.channel')}>
        <button
          className={cn(current === 'main' && 'is-active')}
          aria-pressed={current === 'main'}
          disabled={busy}
          onClick={() => choose('main')}
        >
          <ShieldCheck size={14} /> {t('settings.channelStable')}
        </button>
        <button
          className={cn(current === 'dev' && 'is-active')}
          aria-pressed={current === 'dev'}
          disabled={busy}
          onClick={() => choose('dev')}
        >
          <Beaker size={14} /> {t('settings.channelDev')}
        </button>
      </div>

      {/* What's actually running. On Development the version number is meaningless
          (it moves with the branch), so name the branch instead of implying a release. */}
      {status.data && (
        <div className="setting-row__hint" style={{ marginBlockStart: '0.6rem' }}>
          {busy
            ? t('settings.channelSwitching')
            : status.data.movingTag
              ? t('settings.channelDevRunning', { label: status.data.label, branch: status.data.branch })
              : t('settings.channelRunning', { label: status.data.label, version: status.data.version })}
        </div>
      )}
      {status.data?.movingTag && (
        <div className="setting-row__hint" style={{ marginBlockStart: '0.35rem' }}>
          {t('settings.channelDevNote')}
        </div>
      )}

      {/* Apps left behind by a switch. Shown until every one has been moved. */}
      {pending.length > 0 && (
        <div
          className="glass-inset panel"
          style={{
            marginBlockStart: '0.8rem',
            borderInlineStart: '3px solid var(--color-warning)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
          }}
        >
          <div className="setting-row__title">
            {t('settings.channelPendingTitle', { count: pending.length })}
          </div>
          <div className="setting-row__hint">{t('settings.channelPendingBody')}</div>
          <div className="setting-row__hint">{pending.map((p) => p.name).join(', ')}</div>
          {onUpdateAll && (
            <button className="btn btn--sm btn--primary" style={{ alignSelf: 'flex-start' }} onClick={onUpdateAll}>
              {t('settings.channelUpdateAll', { label: label(current) })}
            </button>
          )}
        </div>
      )}

      <ConfirmDialog
        open={pendingTarget !== null}
        onClose={() => setPendingTarget(null)}
        onConfirm={() => pendingTarget && setChannel.mutate({ channel: pendingTarget })}
        pending={busy}
        title={
          pendingTarget === 'dev'
            ? t('settings.channelDevConfirmTitle')
            : t('settings.channelStableConfirmTitle')
        }
        body={
          pendingTarget === 'dev'
            ? t('settings.channelDevConfirmBody')
            : t('settings.channelStableConfirmBody')
        }
        cost={
          pendingTarget === 'dev'
            ? t('settings.channelDevConfirmCost')
            : t('settings.channelStableConfirmCost')
        }
        confirmLabel={
          pendingTarget === 'dev' ? t('settings.channelDevConfirm') : t('settings.channelStableConfirm')
        }
      />
    </div>
  );
}
