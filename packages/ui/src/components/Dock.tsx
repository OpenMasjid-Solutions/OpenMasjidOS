/**
 * The floating bottom dock (umbrelOS-style, our own implementation). Primary
 * nav + pinned apps. Drop an app card here to pin it; click a pinned app to
 * launch it in a new tab.
 */
import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Store as StoreIcon, Settings as SettingsIcon, FolderOpen, AppWindow } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { usePrefs, prefsStore } from '../lib/prefs';
import { useWindows } from './Windows';
import { cn } from '../lib/cn';
import { openApp, appInitial } from '../lib/apps';
import { MasjidMark } from './Glyphs';

export function Dock() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const prefs = usePrefs();
  const { windows } = useWindows();
  const [dropHint, setDropHint] = useState(false);
  const appsQuery = trpc.apps.list.useQuery(undefined, { refetchInterval: 8000 });
  const apps = appsQuery.data ?? [];

  const pinnedApps = prefs.pinnedApps
    .map((id) => apps.find((a) => a.id === id))
    .filter((a): a is NonNullable<typeof a> => Boolean(a));

  return (
    <nav
      className={cn('dock glass-dock', dropHint && 'dock-drop-hint')}
      aria-label={t('nav.aria.primary')}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/omos-app')) {
          e.preventDefault();
          setDropHint(true);
        }
      }}
      onDragLeave={() => setDropHint(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropHint(false);
        const id = e.dataTransfer.getData('application/omos-app');
        if (id) prefsStore.pin(id);
      }}
    >
      <NavLink to="/" end className={({ isActive }) => cn('dock-item', isActive && 'is-active')} title={t('nav.dashboard')} aria-label={t('nav.dashboard')}>
        <MasjidMark size={22} />
      </NavLink>
      <NavLink to="/store" className={({ isActive }) => cn('dock-item', isActive && 'is-active')} title={t('nav.store')} aria-label={t('nav.store')}>
        <StoreIcon size={20} />
      </NavLink>
      <NavLink to="/files" className={({ isActive }) => cn('dock-item', isActive && 'is-active')} title={t('nav.files')} aria-label={t('nav.files')}>
        <FolderOpen size={20} />
      </NavLink>
      <NavLink to="/settings" className={({ isActive }) => cn('dock-item', isActive && 'is-active')} title={t('nav.settings')} aria-label={t('nav.settings')}>
        <SettingsIcon size={20} />
      </NavLink>

      {pinnedApps.length > 0 && <span className="dock-divider" aria-hidden="true" />}

      {pinnedApps.map((app) => (
        <button
          key={app.id}
          className="dock-item"
          title={app.name}
          aria-label={app.name}
          onClick={() => openApp(app)}
        >
          {app.icon ? (
            <span className="app-initial" style={{ background: 'transparent' }}>
              <img src={app.icon} alt="" style={{ width: '100%', height: '100%', borderRadius: '0.85rem', objectFit: 'cover' }} />
            </span>
          ) : (
            <span className="app-initial">{appInitial(app.name)}</span>
          )}
        </button>
      ))}

      {windows.length > 0 && <span className="dock-divider" aria-hidden="true" />}

      {windows.map((w) => (
        <button
          key={w.id}
          className="dock-item dock-item--window"
          title={w.title}
          aria-label={w.title}
          onClick={() => w.restore()}
        >
          <AppWindow size={20} />
          <span className="dock-dot" aria-hidden="true" />
        </button>
      ))}
    </nav>
  );
}
