// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * An installed-app tile. The whole card launches the app in a new tab (or opens
 * its detail page when stopped). The ⋮ menu holds the controls. Cards are
 * draggable onto the dock to pin them.
 */
import { memo, useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
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
} from 'lucide-react';
import { trpc } from '../lib/trpc';
import { usePrefs, prefsStore } from '../lib/prefs';
import { openApp } from '../lib/apps';
import { AppIcon } from './AppIcon';
import { useToast } from './ToastProvider';
import { Modal } from './Modal';
import { LazyTerminal } from './LazyTerminal';
import { AppLogs } from './AppLogs';
import { AppUpdate } from './AppUpdate';
import { useWindows } from './Windows';
import { staggerItem } from '../lib/motion';
import type { InstalledApp } from '../lib/types';

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

  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteData, setDeleteData] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{ current: string; latest: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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
    windows.open({
      title: t('appUpdate.title', { name: app.name }),
      dedupeKey: `update:${app.id}`,
      wide: true,
      icon: <RefreshCw size={15} />,
      node: <AppUpdate id={app.id} name={app.name} />,
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

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [menuOpen]);

  const refresh = () => utils.apps.list.invalidate();
  const start = trpc.apps.start.useMutation({ onSuccess: refresh });
  const stop = trpc.apps.stop.useMutation({ onSuccess: refresh });
  const restart = trpc.apps.restart.useMutation({ onSuccess: refresh });
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

  const close = useCallback(() => setMenuOpen(false), []);

  return (
    <>
      <motion.div
        className="app-card glass fx-glint"
        variants={staggerItem}
        draggable
        // While the ⋮ menu is open, lift the card above the dock (it has a Motion
        // transform = stacking context) AND drop content-visibility's paint
        // containment, which would otherwise clip the menu where it overflows the
        // card's box. Closed cards keep content-visibility:auto (offscreen skip).
        style={menuOpen ? { zIndex: 200, contentVisibility: 'visible' } : undefined}
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
            </div>
          </div>

          <div className="app-card__menu-wrap" ref={menuRef} onClick={(e) => e.stopPropagation()}>
            <button className="icon-btn" aria-label={t('actions.options')} onClick={() => setMenuOpen((o) => !o)}>
              <MoreVertical size={18} />
            </button>
            {menuOpen && (
              <div className="menu glass-raised app-card__menu">
                {app.running && (
                  <button className="menu-item" onClick={() => { close(); openApp(app); }}>
                    <ExternalLink size={16} /> {t('actions.open')}
                  </button>
                )}
                {app.running ? (
                  <>
                    <button className="menu-item" onClick={() => { close(); restart.mutate({ id: app.id }); }}>
                      <RotateCw size={16} /> {t('actions.restart')}
                    </button>
                    <button className="menu-item" onClick={() => { close(); stop.mutate({ id: app.id }); }}>
                      <Power size={16} /> {t('actions.shutdown')}
                    </button>
                  </>
                ) : (
                  <button className="menu-item" onClick={() => { close(); start.mutate({ id: app.id }); }}>
                    <Play size={16} /> {t('actions.start')}
                  </button>
                )}
                {webTerminal && app.running && (
                  <button className="menu-item" onClick={() => { close(); openShell(); }}>
                    <SquareTerminal size={16} /> {t('actions.shell')}
                  </button>
                )}
                <button className="menu-item" onClick={() => { close(); openLogs(); }}>
                  <ScrollText size={16} /> {t('actions.viewLogs')}
                </button>
                {app.kind === 'catalog' && (
                  <button className="menu-item" disabled={checkingUpdate} onClick={() => { close(); void checkForUpdate(); }}>
                    <RefreshCw size={16} /> {t('appCard.checkUpdate')}
                  </button>
                )}
                <button className="menu-item" onClick={() => { close(); prefsStore.togglePin(app.id); }}>
                  {pinned ? <PinOff size={16} /> : <Pin size={16} />}
                  {pinned ? t('actions.unpin') : t('actions.pin')}
                </button>
                <div className="menu-sep" />
                <button className="menu-item" style={{ color: 'var(--color-danger)' }} onClick={() => { close(); setConfirmOpen(true); }}>
                  <Trash2 size={16} /> {t('actions.uninstall')}
                </button>
              </div>
            )}
          </div>
        </div>
      </motion.div>

      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title={t('appCard.removeTitle', { name: app.name })}>
        <p>{t('appCard.removeBody')}</p>
        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', margin: '1rem 0' }}>
          <input type="checkbox" checked={deleteData} onChange={(e) => setDeleteData(e.target.checked)} />
          {t('appCard.removeData')}
        </label>
        {remove.isPending ? (
          <p style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <span className="spinner" /> {t('appCard.removing')}
          </p>
        ) : (
          <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setConfirmOpen(false)}>{t('common.cancel')}</button>
            <button
              className="btn btn--danger"
              onClick={() => remove.mutate({ id: app.id, deleteData }, { onSuccess: () => setConfirmOpen(false) })}
            >
              {t('appCard.removeConfirm')}
            </button>
          </div>
        )}
      </Modal>

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
