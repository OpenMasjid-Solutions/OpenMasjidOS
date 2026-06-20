import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { trpc } from './lib/trpc';
import { makeTrpcClient } from './lib/trpcClient';
import { SceneBackground } from './components/SceneBackground';
import { ToastProvider } from './components/ToastProvider';
import { WindowsProvider } from './components/Windows';
import { Root } from './Root';

export function App() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
      }),
  );
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
