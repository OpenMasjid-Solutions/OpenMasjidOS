/**
 * Lazily loads the xterm.js terminal (a sizeable dependency) only when a shell
 * is actually opened, so it stays out of the initial bundle and the dashboard
 * loads faster. Same props as Terminal.
 */
import { lazy, Suspense } from 'react';

const TerminalImpl = lazy(() => import('./Terminal').then((m) => ({ default: m.Terminal })));

export function LazyTerminal({ wsPath }: { wsPath: string }) {
  return (
    <Suspense fallback={<div className="hint" style={{ padding: '1rem' }}>Loading…</div>}>
      <TerminalImpl wsPath={wsPath} />
    </Suspense>
  );
}
