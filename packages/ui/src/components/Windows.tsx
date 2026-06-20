/**
 * A tiny window manager for in-dashboard windows (modals/terminals). It tracks
 * minimized windows and renders a tray above the dock so they can be restored —
 * the "minimize to taskbar" behind the yellow traffic-light button.
 */
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';

export interface MinimizedWindow {
  id: number;
  title: string;
  restore: () => void;
}

interface WindowsApi {
  add: (w: MinimizedWindow) => void;
  remove: (id: number) => void;
}

const WindowsCtx = createContext<WindowsApi>({ add: () => {}, remove: () => {} });

export function useWindows(): WindowsApi {
  return useContext(WindowsCtx);
}

let nextWindowId = 1;
export function newWindowId(): number {
  return nextWindowId++;
}

export function WindowsProvider({ children }: { children: ReactNode }) {
  const [windows, setWindows] = useState<MinimizedWindow[]>([]);

  const add = useCallback((w: MinimizedWindow) => {
    setWindows((list) => (list.some((x) => x.id === w.id) ? list : [...list, w]));
  }, []);
  const remove = useCallback((id: number) => {
    setWindows((list) => list.filter((x) => x.id !== id));
  }, []);

  return (
    <WindowsCtx.Provider value={{ add, remove }}>
      {children}
      <div className="min-tray" aria-live="polite">
        <AnimatePresence>
          {windows.map((w) => (
            <motion.button
              key={w.id}
              className="min-chip glass-raised"
              initial={{ opacity: 0, y: 12, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.9 }}
              onClick={() => w.restore()}
              title={w.title}
            >
              <span className="min-chip-dot" />
              <span className="min-chip-label">{w.title}</span>
            </motion.button>
          ))}
        </AnimatePresence>
      </div>
    </WindowsCtx.Provider>
  );
}
