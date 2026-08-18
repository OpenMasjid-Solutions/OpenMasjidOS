// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * A small window manager for in-dashboard windows (terminals, logs, file
 * viewers). Windows are owned at the top level (see WindowManager, mounted in
 * AppShell) so they survive route changes — minimizing a shell and walking to
 * Settings keeps it alive in the dock. Window content stays mounted while
 * minimized (hidden with CSS) so live connections (a terminal, a log stream)
 * are never dropped.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

export interface OpenWindowOptions {
  title: string;
  node: ReactNode;
  /** Wider frame (terminals, logs, file editors). */
  wide?: boolean;
  /** Icon shown on the dock item + hover preview. */
  icon?: ReactNode;
  /** Reopening with the same key focuses the existing window instead of duplicating it. */
  dedupeKey?: string;
  /**
   * Hide the close control: the window cannot be dismissed until `setLocked(id, false)`.
   *
   * ONLY for work that must not be interrupted or repeated — an update in progress.
   * Closing an update window and pressing the button again used to start a second update
   * over the first, which is how an app stopped coming back. Minimizing is still allowed:
   * the work is unaffected and the dock brings it back, so it is not a way "out".
   */
  locked?: boolean;
}

export interface WindowState {
  id: number;
  title: string;
  node: ReactNode;
  wide: boolean;
  icon?: ReactNode;
  dedupeKey?: string;
  locked: boolean;
  minimized: boolean;
  fullscreen: boolean;
  /** Monotonic focus order — higher is more recently focused (front). */
  z: number;
}

interface WindowsApi {
  windows: WindowState[];
  open: (opts: OpenWindowOptions) => number;
  close: (id: number) => void;
  minimize: (id: number) => void;
  restore: (id: number) => void;
  focus: (id: number) => void;
  toggleFullscreen: (id: number) => void;
  /** Release a locked window once its work is finished. */
  setLocked: (id: number, locked: boolean) => void;
}

const noop = () => {};
const WindowsCtx = createContext<WindowsApi>({
  windows: [],
  open: () => -1,
  close: noop,
  minimize: noop,
  restore: noop,
  focus: noop,
  toggleFullscreen: noop,
  setLocked: noop,
});

export function useWindows(): WindowsApi {
  return useContext(WindowsCtx);
}

export function WindowsProvider({ children }: { children: ReactNode }) {
  const [windows, setWindows] = useState<WindowState[]>([]);
  // A ref mirror so open()/dedupe can read the current list synchronously.
  const ref = useRef<WindowState[]>([]);
  const idRef = useRef(1);
  const zRef = useRef(1);

  const setWins = useCallback((updater: (list: WindowState[]) => WindowState[]) => {
    setWindows((list) => {
      const next = updater(list);
      ref.current = next;
      return next;
    });
  }, []);

  const focus = useCallback(
    (id: number) => {
      const z = ++zRef.current;
      setWins((list) => list.map((w) => (w.id === id ? { ...w, z, minimized: false } : w)));
    },
    [setWins],
  );

  const open = useCallback(
    (opts: OpenWindowOptions) => {
      if (opts.dedupeKey) {
        const existing = ref.current.find((w) => w.dedupeKey === opts.dedupeKey);
        if (existing) {
          focus(existing.id);
          return existing.id;
        }
      }
      const id = idRef.current++;
      const z = ++zRef.current;
      setWins((list) => [
        ...list,
        {
          id,
          title: opts.title,
          node: opts.node,
          wide: opts.wide ?? false,
          icon: opts.icon,
          dedupeKey: opts.dedupeKey,
          locked: opts.locked ?? false,
          minimized: false,
          fullscreen: false,
          z,
        },
      ]);
      return id;
    },
    [focus, setWins],
  );

  // A locked window ignores close() entirely, wherever it is called from — the frame's
  // control, the Escape handler, or any future caller. Enforcing it here rather than only
  // hiding the button means there is one rule, not one per entry point.
  const close = useCallback(
    (id: number) => setWins((list) => (list.find((w) => w.id === id)?.locked ? list : list.filter((w) => w.id !== id))),
    [setWins],
  );
  const setLocked = useCallback(
    (id: number, locked: boolean) => setWins((list) => list.map((w) => (w.id === id ? { ...w, locked } : w))),
    [setWins],
  );
  const minimize = useCallback(
    (id: number) => setWins((list) => list.map((w) => (w.id === id ? { ...w, minimized: true } : w))),
    [setWins],
  );
  const toggleFullscreen = useCallback(
    (id: number) => setWins((list) => list.map((w) => (w.id === id ? { ...w, fullscreen: !w.fullscreen } : w))),
    [setWins],
  );

  // Stable context value: the callbacks are useCallback-stable, so this only
  // changes when the window list does — consumers don't re-render every render.
  const value = useMemo(
    () => ({ windows, open, close, minimize, restore: focus, focus, toggleFullscreen, setLocked }),
    [windows, open, close, minimize, focus, toggleFullscreen, setLocked],
  );

  return <WindowsCtx.Provider value={value}>{children}</WindowsCtx.Provider>;
}
