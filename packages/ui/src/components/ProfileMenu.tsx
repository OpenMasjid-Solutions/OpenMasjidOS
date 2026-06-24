/**
 * Top-right account button + menu: dark/light toggle, Settings, Sign out.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Moon, Sun, Settings as SettingsIcon, LogOut, User } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { clearCsrf } from '../lib/session';
import { usePrefs, prefsStore } from '../lib/prefs';

export function ProfileMenu({ onSignedOut }: { onSignedOut: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const prefs = usePrefs();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  const logout = trpc.auth.logout.useMutation({
    onSettled: () => {
      clearCsrf();
      onSignedOut();
    },
  });
  const sysInfo = trpc.system.info.useQuery();

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="profile-btn" aria-label={t('profile.menu')} onClick={() => setOpen((o) => !o)}>
        <User size={20} />
      </button>
      {open && (
        <div className="menu glass-raised" role="menu">
          <button
            className="menu-item"
            onClick={() => prefsStore.patch({ theme: isDark ? 'light' : 'dark' })}
          >
            {isDark ? <Sun size={16} /> : <Moon size={16} />}
            {isDark ? t('profile.lightMode') : t('profile.darkMode')}
          </button>
          <button className="menu-item" onClick={() => { setOpen(false); navigate('/settings'); }}>
            <SettingsIcon size={16} /> {t('profile.settings')}
          </button>
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => logout.mutate()}>
            <LogOut size={16} /> {t('profile.signOut')}
          </button>
          {sysInfo.data?.version && (
            <div className="menu-version">OpenMasjidOS v{sysInfo.data.version}</div>
          )}
        </div>
      )}
    </div>
  );
}
