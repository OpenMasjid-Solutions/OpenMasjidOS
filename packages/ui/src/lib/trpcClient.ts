// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
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
  // The dashboard key goes in the query string because a WebSocket handshake
  // cannot carry a custom header — the same reason api/ws-auth.ts reads `?k=`.
  // Without it the server now rejects the subscription, which is the point: the
  // session cookie alone must not drive the API.
  const key = getCsrf();
  return `${wsProto}//${host}/trpc${key ? `?k=${encodeURIComponent(key)}` : ''}`;
}

export function makeTrpcClient() {
  // `url` MUST be a callback, not a string: the client is created once at app
  // start (App.tsx), before the user has logged in and therefore before a key
  // exists. A string would freeze the empty-key URL and every reconnect after
  // login would fail auth. The callback is re-read on each (re)connect.
  const wsClient = createWSClient({ url: () => wsUrl() });
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
