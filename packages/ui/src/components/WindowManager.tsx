/**
 * Renders every open window (terminals, logs, file viewers). Mounted once in
 * AppShell, above the routed page, so windows persist across navigation. Each
 * frame is a floating, draggable macOS-style window with traffic lights;
 * minimized ones stay mounted but hidden (their dock entry restores them).
 */
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Minus, Maximize2 } from 'lucide-react';
import { useWindows, type WindowState } from './Windows';
import { ErrorBoundary } from './ErrorBoundary';

export function WindowManager() {
  const { windows, close } = useWindows();
  // Stack by focus order so the most-recently-focused window is on top.
  const ordered = [...windows].sort((a, b) => a.z - b.z);

  // Escape closes only the front-most (highest-z) non-minimized window — one
  // listener here, not one per frame (which would close them all at once).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const visible = windows.filter((w) => !w.minimized);
      if (visible.length === 0) return;
      const front = visible.reduce((a, b) => (b.z > a.z ? b : a));
      close(front.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [windows, close]);

  return (
    <>
      {ordered.map((w, i) => (
        <WindowFrame key={w.id} win={w} zIndex={110 + i} />
      ))}
    </>
  );
}

function WindowFrame({ win, zIndex }: { win: WindowState; zIndex: number }) {
  const { t } = useTranslation();
  const { close, minimize, focus, toggleFullscreen } = useWindows();
  const frameRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  // Tear down any in-flight drag listeners if the window unmounts mid-drag,
  // so a closed window can't leak a pointermove handler.
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanup.current?.(), []);

  function startDrag(e: ReactPointerEvent) {
    if (win.fullscreen) return;
    // Don't start a drag from the traffic-light buttons.
    if ((e.target as HTMLElement).closest('.tl')) return;
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return;
    const start = pos ?? { x: rect.left, y: rect.top };
    const offX = e.clientX - start.x;
    const offY = e.clientY - start.y;
    setPos(start);

    const onMove = (ev: PointerEvent) => {
      const x = Math.max(0, Math.min(window.innerWidth - 120, ev.clientX - offX));
      const y = Math.max(0, Math.min(window.innerHeight - 60, ev.clientY - offY));
      setPos({ x, y });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      dragCleanup.current = null;
    };
    dragCleanup.current = onUp;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    e.preventDefault();
  }

  const positionStyle: CSSProperties = win.fullscreen
    ? { left: '2vw', top: '4vh', width: '96vw', height: '92vh', transform: 'none' }
    : pos
      ? { left: pos.x, top: pos.y, transform: 'none' }
      : {};

  return (
    <div
      ref={frameRef}
      className={`win-pos${win.fullscreen || pos ? '' : ' win-pos--center'}`}
      style={{ ...positionStyle, zIndex, display: win.minimized ? 'none' : undefined }}
      onPointerDown={() => focus(win.id)}
    >
      <div className={`win glass-raised win-enter${win.wide ? ' win--wide' : ''}`} style={win.fullscreen ? { width: '100%', height: '100%', maxHeight: 'none' } : undefined}>
        <header className="win-head" onPointerDown={startDrag} onDoubleClick={() => toggleFullscreen(win.id)}>
          <div className="traffic" role="group" aria-label="Window controls">
            <button className="tl tl-close" aria-label={t('common.close')} onClick={() => close(win.id)}>
              <X size={9} strokeWidth={3.5} />
            </button>
            <button className="tl tl-min" aria-label="Minimize" onClick={() => minimize(win.id)}>
              <Minus size={9} strokeWidth={3.5} />
            </button>
            <button className="tl tl-full" aria-label="Fullscreen" onClick={() => toggleFullscreen(win.id)}>
              <Maximize2 size={8} strokeWidth={3.5} />
            </button>
          </div>
          <h2 className="win-title">
            {win.icon}
            <span>{win.title}</span>
          </h2>
        </header>
        <div className="win-body">
          <ErrorBoundary>{win.node}</ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
