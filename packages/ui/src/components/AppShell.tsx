/**
 * The authenticated desktop shell: top-right profile menu, the page content,
 * and the floating dock. Shows a brief, skippable first-load splash.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { AnimatePresence } from 'motion/react';
import { ProfileMenu } from './ProfileMenu';
import { Dock } from './Dock';
import { Splash } from './Splash';
import { WindowManager } from './WindowManager';
import { Clock } from './Clock';
import { usePrefs } from '../lib/prefs';

const SPLASH_FLAG = 'omos-splash-shown';

export function AppShell({ children, onSignedOut }: { children: ReactNode; onSignedOut: () => void }) {
  const prefs = usePrefs();
  // Show the welcome splash at most once per tab session, so reloads and
  // navigation feel instant while a fresh visit still gets the nice intro.
  const [showSplash, setShowSplash] = useState(() => {
    if (!prefs.showSplash) return false;
    try {
      return sessionStorage.getItem(SPLASH_FLAG) !== '1';
    } catch {
      return true;
    }
  });

  useEffect(() => {
    if (!showSplash) return;
    try {
      sessionStorage.setItem(SPLASH_FLAG, '1');
    } catch {
      /* private mode — just shows each load */
    }
    const id = setTimeout(() => setShowSplash(false), 900);
    return () => clearTimeout(id);
  }, [showSplash]);

  return (
    <div className="app-shell">
      <AnimatePresence>
        {showSplash && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'var(--scene-base)' }}>
            <Splash onSkip={() => setShowSplash(false)} />
          </div>
        )}
      </AnimatePresence>

      <div className="topbar">
        <Clock />
        <div style={{ marginInlineStart: 'auto' }}>
          <ProfileMenu onSignedOut={onSignedOut} />
        </div>
      </div>
      <main className="app-main">{children}</main>
      <WindowManager />
      <Dock />
    </div>
  );
}
