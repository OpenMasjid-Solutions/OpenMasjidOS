/**
 * A tiny window manager for in-dashboard windows (modals/terminals). Minimized
 * windows are surfaced in the dock (see Dock.tsx) so they can be restored —
 * the "minimize to the dock" behind the yellow traffic-light button.
 */
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

export interface MinimizedWindow {
  id: number;
  title: string;
  restore: () => void;
}

interface WindowsApi {
  windows: MinimizedWindow[];
  add: (w: MinimizedWindow) => void;
  remove: (id: number) => void;
}

const WindowsCtx = createContext<WindowsApi>({ windows: [], add: () => {}, remove: () => {} });

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

  return <WindowsCtx.Provider value={{ windows, add, remove }}>{children}</WindowsCtx.Provider>;
}
