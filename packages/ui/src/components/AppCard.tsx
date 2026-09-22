// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * An installed-app tile. The whole card launches the app in a new tab (or opens
 * its detail page when stopped). The ⋮ menu holds the controls. Cards are
 * draggable onto the dock to pin them.
 */
import { memo, useCallback, useState, type DragEvent } from 'react';
import { motion } from 'motion/react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  MoreVertical,
  ExternalLink,
  Play,
  Power,
  RotateCw,
  RefreshCw,
  Pin,
  PinOff,
  Trash2,
  ScrollText,
  SquareTerminal,
  ShieldAlert,
} from 'lucide-react';
import { trpc } from '../lib/trpc';
import { usePrefs, prefsStore } from '../lib/prefs';
import { openApp } from '../lib/apps';
import { AppIcon } from './AppIcon';
import { useToast } from './ToastProvider';
import { Modal } from './Modal';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { AppReviewDialog } from './AppReviewDialog';
import { LazyTerminal } from './LazyTerminal';
import { AppLogs } from './AppLogs';
import { AppUpdate } from './AppUpdate';
import { useWindows } from './Windows';
import { staggerItem } from '../lib/motion';
import type { InstalledApp } from '../lib/types';
import { CheckboxField } from './CheckboxField';

const TAG: Record<InstalledApp['kind'], { cls: string; key: string }> = {
  catalog: { cls: 'tag--official', key: 'tags.official' },
  community: { cls: 'tag--community', key: 'tags.community' },
  custom: { cls: 'tag--custom', key: 'tags.custom' },
};

export const AppCard = memo(function AppCard({ app, webTerminal }: { app: InstalledApp; webTerminal: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const { toast } = useToast();
  const prefs = usePrefs();
  const windows = useWindows();
  const pinned = prefs.pinnedApps.includes(app.id);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [riskAck, setRiskAck] = useState(false);
  const [deleteData, setDeleteData] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{ current: string; latest: string } | null>(null);

  // Catalog apps can be updated from the store. Check on demand, then confirm.
  const checkForUpdate = useCallback(async () => {
    setCheckingUpdate(true);
    toast(t('appCard.checking'), 'info');
    try {
      const res = await utils.apps.checkUpdate.fetch({ id: app.id });
      if (res.updateAvailable && res.latest) {
        setUpdateInfo({ current: res.current, latest: res.latest });
      } else {
        toast(t('appCard.upToDate'), 'success');
      }
    } catch {
      toast(t('errors.generic'), 'error');
    } finally {
      setCheckingUpdate(false);
    }
  }, [app.id, t, toast, utils]);

  const startUpdate = useCallback(() => {
    setUpdateInfo(null);
    // Locked until the update finishes: closing this and pressing Update again started a
    // second update over the first, and the app could stop coming back. `winId` is
    // assigned before the stream can ever finish, so the closure always sees it.
    let winId = -1;
    winId = windows.open({
      title: t('appUpdate.title', { name: app.name }),
      dedupeKey: `update:${app.id}`,
      wide: true,
      locked: true,
      icon: <RefreshCw size={15} />,
      node: <AppUpdate id={app.id} name={app.name} onDone={() => windows.setLocked(winId, false)} />,
    });
  }, [app.id, app.name, t, windows]);

  const openShell = useCallback(() => {
    windows.open({
      title: t('settings.appShellTitle', { name: app.name }),
      dedupeKey: `shell:${app.id}`,
      wide: true,
      icon: <SquareTerminal size={15} />,
      node: <LazyTerminal wsPath={`/api/terminal/app/${encodeURIComponent(app.id)}`} />,
    });
  }, [app.id, app.name, t, windows]);

  const openLogs = useCallback(() => {
    windows.open({
      title: `${t('appDetail.logs')} — ${app.name}`,
      dedupeKey: `logs:${app.id}`,
      wide: true,
      icon: <ScrollText size={15} />,
      node: <AppLogs id={app.id} />,
    });
  }, [app.id, app.name, t, windows]);

  // Warm the detail page + logs caches on hover/focus so opening a card is
  // instant (the data is usually already there by the time the click lands).
  const prefetch = useCallback(() => {
    void utils.apps.get.prefetch({ id: app.id });
    void utils.apps.logs.prefetch({ id: app.id, tail: 300 });
  }, [app.id, utils]);

  // The hand-rolled click-outside listener that used to live here is gone —
  // Radix dismisses on outside pointerdown, on Escape, and on focus leaving,
  // which the document-level click listener never did.

  const refresh = () => utils.apps.list.invalidate();
  const start = trpc.apps.start.useMutation({
    onSuccess: () => {
      refresh();
      setReviewOpen(false);
      setRiskAck(false);
    },
    onError: (e) => toast(e.message || t('errors.generic'), 'error'),
  });
  const stop = trpc.apps.stop.useMutation({ onSuccess: refresh });
  const restart = trpc.apps.restart.useMutation({ onSuccess: refresh });

  // An app held for review after a restore never starts from a plain click. Its
  // compose was written to disk by the restore WITHOUT passing the risk gate, so
  // this is the point at which a person has to read what it asks for and agree.
  const held = app.review;
  const startOrReview = useCallback(() => {
    if (held) setReviewOpen(true);
    else start.mutate({ id: app.id });
  }, [held, start, app.id]);
  const remove = trpc.apps.remove.useMutation({
    onSuccess: () => {
      refresh();
      toast(t('common.saved'), 'success');
    },
    onError: (e) => toast(e.message || t('errors.generic'), 'error'),
  });

  const tag = TAG[app.kind] ?? TAG.custom;

  const launch = useCallback(() => {
    if (app.running) {
      if (!openApp(app)) navigate(`/apps/${encodeURIComponent(app.id)}`);
    } else {
      navigate(`/apps/${encodeURIComponent(app.id)}`);
    }
  }, [app, navigate]);


  return (
    <>
      <motion.div
        className="app-card glass fx-glint"
        variants={staggerItem}
        draggable
        // Motion TYPES onDragStart as its own pan-gesture handler, but at runtime
        // filterProps forwards every `onDrag*` straight to the DOM whenever
        // `draggable` is set — so this really does receive a React drag event and
        // dock pinning works. Cast rather than restructure: dropping `draggable`
        // or the motion wrapper would break the drag-to-pin, and motion's types
        // simply don't model that escape hatch.
        onDragStart={(e) =>
          (e as unknown as DragEvent<HTMLDivElement>).dataTransfer.setData('application/omos-app', app.id)
        }
        onClick={launch}
        onMouseEnter={prefetch}
        onFocus={prefetch}
      >
        <div className="app-card__top">
          <AppIcon app={app} />
          <div className="app-card__body">
            <div className="app-name" title={app.name}>{app.name}</div>
            <div className="app-meta">
              <span className={`status-dot ${app.running ? '' : 'status-dot--idle'}`} />
              <span className={`tag ${tag.cls}`}>{t(tag.key)}</span>
              {/* A held app looks exactly like an ordinary stopped one without
                  this, which is precisely how its Start button became a way to
                  run an unvetted compose. Say so on the card face. */}
              {held && (
                <span className="tag tag--review" title={held.reasons.join('\n')}>
                  {t(held.kind === 'refusal' ? 'appReview.badgeRefused' : 'appReview.badge')}
                </span>
              )}
            </div>
          </div>

          {/* The whole card is clickable (it launches the app), so every event
              from the menu trigger has to stop short of it. Radix renders the
              CONTENT in a portal at the document root, which is why the old
              `contentVisibility: 'visible'` and `zIndex: 200` workarounds on the
              card are gone: the menu is no longer a descendant that the card's
              paint containment could clip, or that the dock could cover. */}
          <div className="app-card__menu-wrap" onClick={(e) => e.stopPropagation()}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="icon-btn" aria-label={t('actions.options')}>
                  <MoreVertical size={18} />
                </button>
              </DropdownMenuTrigger>
              {/* No `close()` on any item: Radix closes on select and returns
                  focus to the trigger, which the hand-rolled version never did. */}
              <DropdownMenuContent align="end" className="glass-raised" sideOffset={6}>
                {app.running && (
                  <DropdownMenuItem onSelect={() => openApp(app)}>
                    <ExternalLink size={16} /> {t('actions.open')}
                  </DropdownMenuItem>
                )}
                {app.running ? (
                  <>
                    <DropdownMenuItem onSelect={() => restart.mutate({ id: app.id })}>
                      <RotateCw size={16} /> {t('actions.restart')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => stop.mutate({ id: app.id })}>
                      <Power size={16} /> {t('actions.shutdown')}
                    </DropdownMenuItem>
                  </>
                ) : (
                  <DropdownMenuItem onSelect={startOrReview}>
                    {held ? <ShieldAlert size={16} /> : <Play size={16} />}
                    {/* A refusal can never be agreed to, so offering "Start
                        anyway" would promise something the server will refuse.
                        Offer the explanation instead. */}
                    {!held
                      ? t('actions.start')
                      : held.kind === 'refusal'
                        ? t('appReview.whyBlocked')
                        : t('appReview.startAnyway')}
                  </DropdownMenuItem>
                )}
                {webTerminal && app.running && (
                  <DropdownMenuItem onSelect={openShell}>
                    <SquareTerminal size={16} /> {t('actions.shell')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={openLogs}>
                  <ScrollText size={16} /> {t('actions.viewLogs')}
                </DropdownMenuItem>
                {app.kind === 'catalog' && (
                  <DropdownMenuItem disabled={checkingUpdate} onSelect={() => void checkForUpdate()}>
                    <RefreshCw size={16} /> {t('appCard.checkUpdate')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => prefsStore.togglePin(app.id)}>
                  {pinned ? <PinOff size={16} /> : <Pin size={16} />}
                  {pinned ? t('actions.unpin') : t('actions.pin')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setConfirmOpen(true)}>
                  <Trash2 size={16} /> {t('actions.uninstall')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </motion.div>

      {/* Closing must also clear `deleteData`. Without that the checkbox stayed
          ticked from a previous removal in the same session, so reopening this
          dialog put permanent destruction of the app's data one click away in a
          dialog the admin reasonably believes they are seeing fresh. */}
      <Modal
        open={confirmOpen}
        onClose={() => {
          setConfirmOpen(false);
          setDeleteData(false);
        }}
        title={t('appCard.removeTitle', { name: app.name })}
      >
        <p>{t('appCard.removeBody')}</p>
        <CheckboxField id={`rm-data-${app.id}`} checked={deleteData} onChange={setDeleteData}>
          {t('appCard.removeData')}
        </CheckboxField>
        {remove.isPending ? (
          <p style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <span className="spinner" /> {t('appCard.removing')}
          </p>
        ) : (
          <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => { setConfirmOpen(false); setDeleteData(false); }}>{t('common.cancel')}</button>
            <button
              className="btn btn--danger"
              onClick={() => remove.mutate({ id: app.id, deleteData }, { onSuccess: () => setConfirmOpen(false) })}
            >
              {t('appCard.removeConfirm')}
            </button>
          </div>
        )}
      </Modal>

      {/* Closing must clear the tick, exactly as the removal dialog does — a
          checkbox left on from a previous app would put an unvetted, root-capable
          stack one click away in a dialog the admin believes they see fresh. */}
      <AppReviewDialog
        open={reviewOpen}
        appName={app.name}
        review={held}
        pending={start.isPending}
        acknowledged={riskAck}
        onAcknowledgedChange={setRiskAck}
        onConfirm={() => start.mutate({ id: app.id, acknowledgeRisk: true })}
        onClose={() => {
          setReviewOpen(false);
          setRiskAck(false);
        }}
      />

      <Modal open={!!updateInfo} onClose={() => setUpdateInfo(null)} title={t('appCard.updateTitle', { name: app.name })}>
        <p>{t('appCard.updateBody', { current: updateInfo?.current ?? '', latest: updateInfo?.latest ?? '' })}</p>
        <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
          <button className="btn" onClick={() => setUpdateInfo(null)}>{t('common.cancel')}</button>
          <button className="btn btn--primary" onClick={startUpdate}>{t('appCard.updateNow')}</button>
        </div>
      </Modal>
    </>
  );
});
