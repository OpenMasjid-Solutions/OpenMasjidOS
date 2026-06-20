/**
 * An installed-app tile. The whole card launches the app in a new tab (or opens
 * its detail page when stopped). The ⋮ menu holds the controls. Cards are
 * draggable onto the dock to pin them.
 */
import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  MoreVertical,
  ExternalLink,
  Play,
  Power,
  RotateCw,
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
import { useWindows } from './Windows';
import { staggerItem } from '../lib/motion';
import type { InstalledApp } from '../lib/types';

const TAG: Record<InstalledApp['kind'], { cls: string; key: string }> = {
  catalog: { cls: 'tag--official', key: 'tags.official' },
  community: { cls: 'tag--community', key: 'tags.community' },
  custom: { cls: 'tag--custom', key: 'tags.custom' },
};

export function AppCard({ app }: { app: InstalledApp }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const { toast } = useToast();
  const prefs = usePrefs();
  const settings = trpc.settings.get.useQuery();
  const windows = useWindows();
  const pinned = prefs.pinnedApps.includes(app.id);

  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteData, setDeleteData] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  function openShell() {
    windows.open({
      title: t('settings.appShellTitle', { name: app.name }),
      dedupeKey: `shell:${app.id}`,
      wide: true,
      icon: <SquareTerminal size={15} />,
      node: <LazyTerminal wsPath={`/api/terminal/app/${encodeURIComponent(app.id)}`} />,
    });
  }

  function openLogs() {
    windows.open({
      title: `${t('appDetail.logs')} — ${app.name}`,
      dedupeKey: `logs:${app.id}`,
      wide: true,
      icon: <ScrollText size={15} />,
      node: <AppLogs id={app.id} />,
    });
  }

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

  function launch() {
    if (app.running) {
      if (!openApp(app)) navigate(`/apps/${encodeURIComponent(app.id)}`);
    } else {
      navigate(`/apps/${encodeURIComponent(app.id)}`);
    }
  }

  const close = () => setMenuOpen(false);

  return (
    <>
      <motion.div
        className="app-card glass fx-glint"
        variants={staggerItem}
        draggable
        // The card has a Motion transform (a stacking context), which traps the
        // ⋮ menu below the dock; lift the whole card above the dock while open.
        style={menuOpen ? { zIndex: 200 } : undefined}
        onDragStart={(e) => e.dataTransfer.setData('application/omos-app', app.id)}
        onClick={launch}
      >
        <div className="app-card__top">
          <AppIcon app={app} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="app-name" title={app.name}>{app.name}</div>
            <div className="app-meta">
              <span className={`status-dot ${app.running ? '' : 'status-dot--idle'}`} />
              <span className={`tag ${tag.cls}`}>{t(tag.key)}</span>
            </div>
          </div>

          <div style={{ position: 'relative' }} ref={menuRef} onClick={(e) => e.stopPropagation()}>
            <button className="icon-btn" aria-label={t('actions.options')} onClick={() => setMenuOpen((o) => !o)}>
              <MoreVertical size={18} />
            </button>
            {menuOpen && (
              <div className="menu glass-raised" style={{ position: 'absolute', insetInlineEnd: 0, insetBlockStart: '2.4rem', minWidth: '10.5rem' }}>
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
                {settings.data?.webTerminal && app.running && (
                  <button className="menu-item" onClick={() => { close(); openShell(); }}>
                    <SquareTerminal size={16} /> {t('actions.shell')}
                  </button>
                )}
                <button className="menu-item" onClick={() => { close(); openLogs(); }}>
                  <ScrollText size={16} /> {t('actions.viewLogs')}
                </button>
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
    </>
  );
}
