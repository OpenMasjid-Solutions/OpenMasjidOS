/**
 * The floating bottom dock (umbrelOS-style, our own implementation). Primary
 * nav + pinned apps + open/minimized windows. Drag an app card here to pin it;
 * drag pinned apps to push them around and reorder; hover any item for its name,
 * or a live window's preview. The dock lives in AppShell, so it (and minimized
 * windows) persist across every route.
 *
 * Reorder uses native HTML5 drag (reliable + works through the dock's transform)
 * for the interaction, and a Motion `layout` wrapper per item for the smooth
 * "push around" slide. We deliberately do NOT use Motion's <Reorder>: on motion
 * components `onDragStart`/`onDragEnd` are Framer's own gesture callbacks, which
 * fought the click-to-open + native drag and broke reordering.
 */
import { useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { Store as StoreIcon, Settings as SettingsIcon, FolderOpen, AppWindow } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { usePrefs, prefsStore } from '../lib/prefs';
import { useWindows } from './Windows';
import { cn } from '../lib/cn';
import { openApp, appInitial } from '../lib/apps';
import { MasjidMark } from './Glyphs';

const APP_MIME = 'application/omos-app';
const reorderSpring = { type: 'spring' as const, stiffness: 600, damping: 38 };

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function Dock() {
  const { t } = useTranslation();
  const prefs = usePrefs();
  const { windows, restore } = useWindows();
  const [dropHint, setDropHint] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const appsQuery = trpc.apps.list.useQuery(undefined, { refetchInterval: 8000 });
  const apps = appsQuery.data ?? [];

  const pinnedApps = prefs.pinnedApps
    .map((id) => apps.find((a) => a.id === id))
    .filter((a): a is NonNullable<typeof a> => Boolean(a));

  // Move `srcId` to before/after `targetId` in the persisted pin order. The
  // midpoint rule + no-op guard keep it stable (no oscillation while hovering).
  function reorderPins(srcId: string, targetId: string, after: boolean) {
    if (srcId === targetId) return;
    const order = [...prefs.pinnedApps];
    const from = order.indexOf(srcId);
    if (from === -1) return;
    order.splice(from, 1);
    let to = order.indexOf(targetId);
    if (to === -1) return;
    if (after) to += 1;
    order.splice(to, 0, srcId);
    if (!sameOrder(order, prefs.pinnedApps)) prefsStore.setPins(order);
  }

  return (
    <nav
      className={cn('dock glass-dock', dropHint && 'dock-drop-hint')}
      aria-label={t('nav.aria.primary')}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(APP_MIME)) {
          e.preventDefault();
          setDropHint(true);
        }
      }}
      onDragLeave={() => setDropHint(false)}
      onDrop={(e) => {
        const appId = e.dataTransfer.getData(APP_MIME);
        if (!appId) return;
        e.preventDefault();
        setDropHint(false);
        prefsStore.pin(appId);
      }}
    >
      <DockLink to="/" end icon={<MasjidMark size={22} />} label={t('nav.dashboard')} />
      <DockLink to="/store" icon={<StoreIcon size={20} />} label={t('nav.store')} />
      <DockLink to="/files" icon={<FolderOpen size={20} />} label={t('nav.files')} />
      <DockLink to="/settings" icon={<SettingsIcon size={20} />} label={t('nav.settings')} />

      {pinnedApps.length > 0 && <span className="dock-divider" aria-hidden="true" />}

      {pinnedApps.map((app) => (
        <motion.div key={app.id} layout transition={reorderSpring} className="dock-pin">
          <button
            className={cn('dock-item', dragId === app.id && 'dock-item--dragging')}
            aria-label={app.name}
            draggable
            onDragStart={(e) => {
              setDragId(app.id);
              e.dataTransfer.effectAllowed = 'move';
              try {
                e.dataTransfer.setData('text/plain', app.id);
              } catch {
                /* some browsers require data to be set */
              }
            }}
            onDragOver={(e) => {
              if (!dragId || dragId === app.id) return;
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              reorderPins(dragId, app.id, e.clientX > r.left + r.width / 2);
            }}
            onDragEnd={() => setDragId(null)}
            onDrop={(e) => {
              e.preventDefault();
              setDragId(null);
            }}
            onClick={() => openApp(app)}
          >
            {app.icon ? (
              <span className="app-initial" style={{ background: 'transparent' }}>
                <img src={app.icon} alt="" style={{ width: '100%', height: '100%', borderRadius: '0.85rem', objectFit: 'cover' }} />
              </span>
            ) : (
              <span className="app-initial">{appInitial(app.name)}</span>
            )}
            <span className="dock-pop"><span className="dock-tip glass-raised">{app.name}</span></span>
          </button>
        </motion.div>
      ))}

      {windows.length > 0 && <span className="dock-divider" aria-hidden="true" />}

      {windows.map((w) => (
        <button
          key={w.id}
          className="dock-item dock-item--window"
          aria-label={w.title}
          onClick={() => restore(w.id)}
        >
          <AppWindow size={20} />
          {w.minimized && <span className="dock-dot" aria-hidden="true" />}
          <span className="dock-pop">
            <span className="dock-preview glass-raised">
              <span className="dock-preview__bar">
                <span className="dock-preview__dots">
                  <i style={{ background: '#FF5F57' }} />
                  <i style={{ background: '#FEBC2E' }} />
                  <i style={{ background: '#28C840' }} />
                </span>
                <span className="dock-preview__title">{w.title}</span>
              </span>
              <span className="dock-preview__body">
                {w.icon}
                <span>{w.minimized ? t('windows.minimized') : t('windows.open')}</span>
              </span>
            </span>
          </span>
        </button>
      ))}
    </nav>
  );
}

function DockLink({ to, end, icon, label }: { to: string; end?: boolean; icon: ReactNode; label: string }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => cn('dock-item', isActive && 'is-active')} aria-label={label}>
      {icon}
      <span className="dock-pop"><span className="dock-tip glass-raised">{label}</span></span>
    </NavLink>
  );
}
