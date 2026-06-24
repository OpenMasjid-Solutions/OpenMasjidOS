import { useState } from 'react';
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
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
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
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
        <SceneBackground />
        <ToastProvider>
          <WindowsProvider>
            <BrowserRouter>
              <Root />
            </BrowserRouter>
          </WindowsProvider>
        </ToastProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
