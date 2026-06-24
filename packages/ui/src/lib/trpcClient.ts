/**
 * Builds the tRPC client links: subscriptions ride a WebSocket (live stats),
 * everything else uses batched HTTP. All same-origin — the core serves both the
 * UI and the API, and in dev Vite proxies /trpc (http + ws) to the daemon.
 */
import { createWSClient, wsLink, splitLink, httpBatchLink } from '@trpc/client';
import { trpc } from './trpc';
import { getCsrf } from './session';

function wsUrl(): string {
  const { protocol, host } = window.location;
  const wsProto = protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProto}//${host}/trpc`;
}

export function makeTrpcClient() {
  const wsClient = createWSClient({ url: wsUrl() });
  return trpc.createClient({
    links: [
      splitLink({
        condition: (op) => op.type === 'subscription',
        true: wsLink({ client: wsClient }),
        // Every cookie-authenticated HTTP call carries the dashboard key so the
        // platform can tell a real dashboard request from a replay of the shared
        // session cookie by an installed app on another port.
        false: httpBatchLink({
          url: '/trpc',
          headers: () => {
            const key = getCsrf();
            return key ? { 'x-omos-csrf': key } : {};
          },
        }),
      }),
    ],
  });
}
