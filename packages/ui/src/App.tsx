// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { useState } from 'react';
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { MotionConfig } from 'motion/react';
import { trpc } from './lib/trpc';
import { makeTrpcClient } from './lib/trpcClient';
import { clearCsrf } from './lib/session';
import { SceneBackground } from './components/SceneBackground';
import { ToastProvider } from './components/ToastProvider';
import { WindowsProvider } from './components/Windows';
import { Root } from './Root';

// True when a tRPC error means "not signed in" (expired session, or a missing/
// stale dashboard key). We read a couple of shapes the client may expose.
function isUnauthorized(err: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TRPCClientError shape isn't statically known here
  const e = err as any;
  return e?.data?.code === 'UNAUTHORIZED' || e?.shape?.data?.code === 'UNAUTHORIZED';
}

export function App() {
  const [queryClient] = useState(() => {
    const holder: { qc?: QueryClient } = {};
    // On any "not signed in" response, drop the dashboard key and re-check auth
    // so the gate falls back to the login screen instead of showing dead data.
    const onError = (err: unknown) => {
      if (!isUnauthorized(err)) return;
      clearCsrf();
      holder.qc?.invalidateQueries({
        predicate: (q) => {
          const k = q.queryKey?.[0] as unknown;
          return Array.isArray(k) && k[0] === 'auth' && k[1] === 'me';
        },
      });
    };
    const qc = new QueryClient({
      // staleTime keeps recently-fetched data fresh across remounts so revisiting
      // a page paints from cache instead of flashing a skeleton. Per-query
      // refetchInterval still drives the live data (stats, app list).
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 } },
      queryCache: new QueryCache({ onError }),
      mutationCache: new MutationCache({ onError }),
    });
    holder.qc = qc;
    return qc;
  });
  const [trpcClient] = useState(() => makeTrpcClient());

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        {/*
          Reduced motion is non-negotiable (CLAUDE.md §14), and tokens.css alone did not
          deliver it. That stylesheet's `@media (prefers-reduced-motion: reduce)` block
          collapses CSS animation and transition durations — but Motion animates by writing
          inline styles from JavaScript, which no CSS duration override can reach. So every
          spring in the app (modal scale + blur, the splash rotate, the staggered card
          entrances in lib/motion.ts) kept running at full amplitude for someone who had
          explicitly asked the OS for less.

          Motion's own default is `reducedMotion: "never"` — it ignores the preference
          unless told, and the omission is invisible to anyone who has not set it.
          "user" honours the OS setting for transform and layout animations while still
          allowing opacity, which is exactly the "instant or opacity-only" behaviour §14
          asks for. One wrapper, at the top, so no component has to remember.
        */}
        <MotionConfig reducedMotion="user">
          <SceneBackground />
          <ToastProvider>
            <WindowsProvider>
              <BrowserRouter>
                <Root />
              </BrowserRouter>
            </WindowsProvider>
          </ToastProvider>
        </MotionConfig>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
