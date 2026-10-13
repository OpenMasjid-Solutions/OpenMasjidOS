// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Check, Trash2, Pencil } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useToast } from '../../components/ToastProvider';
import { errorText } from '../../lib/errors';

/**
 * Approved WhatsApp groups.
 *
 * The approval step is the security model, not a convenience: OpenWA's group list holds
 * EVERY group the linked phone is in — the imam's family chat included — so apps are
 * never shown it. They see only what an admin deliberately approves here.
 *
 * The list is fetched on demand rather than polled: it is a handful of clicks a masjid
 * makes once, and a background poll of someone's entire group membership every minute is
 * both wasteful and slightly grim.
 */
export function WhatsAppGroups({
  approved,
}: {
  approved: { id: string; label: string; name?: string; participants?: number }[];
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const [browsing, setBrowsing] = useState(false);
  /** The group being renamed, and the text so far. */
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);
  /** The group a test is pending for — a message to a whole group cannot be unsent. */
  const [confirmTest, setConfirmTest] = useState<{ id: string; label: string } | null>(null);

  // Fetched only while the picker is open. The error is rendered inline rather than
  // toasted: "couldn't read your groups" is about the panel you are looking at, and a
  // toast would vanish before you had finished reading the list it failed to fill.
  const groups = trpc.whatsapp.groups.useQuery(undefined, { enabled: browsing, retry: false });

  const refresh = () => {
    utils.whatsapp.get.invalidate();
    utils.whatsapp.groups.invalidate();
  };
  const approve = trpc.whatsapp.approveGroup.useMutation({
    onSuccess: refresh,
    onError: (e) => toast(errorText(e, t('errors.generic')), 'error'),
  });
  const unapprove = trpc.whatsapp.unapproveGroup.useMutation({
    onSuccess: refresh,
    onError: (e) => toast(errorText(e, t('errors.generic')), 'error'),
  });
  const rename = trpc.whatsapp.renameGroup.useMutation({
    onSuccess: () => {
      setRenaming(null);
      refresh();
    },
    onError: (e) => toast(errorText(e, t('errors.generic')), 'error'),
  });
  const testGroup = trpc.whatsapp.testGroup.useMutation({
    onSuccess: () => {
      setConfirmTest(null);
      toast(t('settings.whatsappGroupTestSent'), 'success');
    },
    onError: (e) => {
      setConfirmTest(null);
      toast(errorText(e, t('errors.generic')), 'error');
    },
  });

  const approvedIds = new Set(approved.map((g) => g.id));

  return (
    <div style={{ marginBlockStart: '1rem' }}>
      <div className="setting-row__title">{t('settings.whatsappGroups')}</div>
      <div className="setting-row__hint" style={{ marginBlockEnd: '0.5rem' }}>
        {t('settings.whatsappGroupsHint')}
      </div>

      {approved.length > 0 && (
        <div className="glass-inset panel" style={{ marginBlockEnd: '0.6rem', padding: '0.6rem 0.9rem' }}>
          {approved.map((g) => (
            <div className="setting-row" key={g.id}>
              <div className="setting-row__text" style={{ flex: 1, minWidth: 0 }}>
                {renaming?.id === g.id ? (
                  <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      className="input glass-inset"
                      style={{ maxWidth: '16rem' }}
                      autoFocus
                      aria-label={t('settings.whatsappGroupRename')}
                      value={renaming.label}
                      maxLength={80}
                      onChange={(e) => setRenaming({ id: g.id, label: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && renaming.label.trim()) rename.mutate(renaming);
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                    />
                    <button
                      className="btn btn--sm"
                      disabled={rename.isPending || !renaming.label.trim()}
                      onClick={() => rename.mutate(renaming)}
                    >
                      <Check size={14} /> {t('common.save')}
                    </button>
                    <button className="btn btn--sm" onClick={() => setRenaming(null)}>
                      {t('common.cancel')}
                    </button>
                  </div>
                ) : (
                  <div className="setting-row__title" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    {g.label}
                    <button
                      className="icon-btn"
                      aria-label={t('settings.whatsappGroupRename')}
                      title={t('settings.whatsappGroupRename')}
                      onClick={() => setRenaming({ id: g.id, label: g.label })}
                    >
                      <Pencil size={13} />
                    </button>
                  </div>
                )}
                {/* The group's real WhatsApp subject, when the nickname differs — so the
                    admin can tell which group a nickname actually refers to. */}
                {g.name && g.name !== g.label && (
                  <div className="setting-row__hint">{t('settings.whatsappGroupRealName', { name: g.name })}</div>
                )}
                <div className="setting-row__hint">
                  {g.participants != null && `${t('settings.whatsappGroupMembers', { count: g.participants })} · `}
                  {/* The id apps send to. Shown because it is the value that appears in an
                      app's own settings and its logs, and matching it up otherwise means
                      guessing. Selectable in one click, and it is not a secret. */}
                  <code style={{ userSelect: 'all', wordBreak: 'break-all' }}>{g.id}</code>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                <button
                  className="btn btn--sm"
                  disabled={testGroup.isPending}
                  onClick={() => setConfirmTest({ id: g.id, label: g.label })}
                >
                  {t('settings.whatsappGroupTest')}
                </button>
                <button
                  className="btn btn--sm"
                  disabled={unapprove.isPending}
                  onClick={() => unapprove.mutate({ id: g.id })}
                >
                  <Trash2 size={14} /> {t('settings.whatsappGroupRemove')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Confirmed, unlike the test to your own number: everyone in the group receives
          this, and a message cannot be unsent from two hundred phones. */}
      <ConfirmDialog
        open={confirmTest !== null}
        onClose={() => setConfirmTest(null)}
        onConfirm={() => confirmTest && testGroup.mutate({ id: confirmTest.id })}
        title={t('settings.whatsappGroupTestTitle', { name: confirmTest?.label ?? '' })}
        body={t('settings.whatsappGroupTestBody')}
        confirmLabel={t('settings.whatsappGroupTestConfirm')}
        pending={testGroup.isPending}
      />

      {!browsing ? (
        <button className="btn" onClick={() => setBrowsing(true)}>
          <RefreshCw size={15} /> {t('settings.whatsappGroupsFind')}
        </button>
      ) : (
        <>
          {/* Both warnings are real, non-obvious, and cheaper to read than to discover:
              a WhatsApp group shows every member's number to every other member, and a
              group that is not announcement-only lets 200 people reply to a notice. */}
          <div
            className="glass-inset panel"
            style={{ marginBlockEnd: '0.6rem', borderInlineStart: '3px solid var(--color-warning)' }}
          >
            <div className="setting-row__hint">{t('settings.whatsappGroupsWarning')}</div>
          </div>
          {groups.isLoading ? (
            <p className="setting-row__hint">{t('common.loading')}</p>
          ) : groups.error ? (
            <p className="setting-row__hint">{errorText(groups.error, t('errors.generic'))}</p>
          ) : (groups.data ?? []).length === 0 ? (
            <p className="setting-row__hint">{t('settings.whatsappGroupsNone')}</p>
          ) : (
            <div className="glass-inset panel" style={{ padding: '0.6rem 0.9rem' }}>
              {(groups.data ?? []).map((g) => (
                <div className="setting-row" key={g.id}>
                  <div className="setting-row__text" style={{ flex: 1 }}>
                    <div className="setting-row__title">
                      {g.name}
                      {g.community && <span className="tag" style={{ marginInlineStart: '0.4rem' }}>{t('settings.whatsappGroupCommunity')}</span>}
                    </div>
                    <div className="setting-row__hint">
                      {g.participants != null && t('settings.whatsappGroupMembers', { count: g.participants })}
                      {/* Posting into an announcement-only group requires being an admin
                          of it, and that is not something we can fix from here. */}
                      {g.isAdmin === false && ` · ${t('settings.whatsappGroupNotAdmin')}`}
                    </div>
                  </div>
                  <button
                    className="btn btn--sm"
                    disabled={approve.isPending || approvedIds.has(g.id)}
                    onClick={() =>
                      approve.mutate({ id: g.id, label: g.name, participants: g.participants, name: g.name })
                    }
                  >
                    {approvedIds.has(g.id) ? t('settings.whatsappGroupApproved') : t('settings.whatsappGroupApprove')}
                  </button>
                </div>
              ))}
            </div>
          )}
          <button className="btn btn--sm" style={{ marginBlockStart: '0.5rem' }} onClick={() => setBrowsing(false)}>
            {t('common.close')}
          </button>
        </>
      )}
    </div>
  );
}
