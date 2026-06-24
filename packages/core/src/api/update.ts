/**
 * Live update endpoint. Streams the update process (pull → apply → restart) to
 * the dashboard over a WebSocket so a non-technical admin can update with one
 * click and watch it happen — never needing a terminal.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { wsAuthed, requestCsrfOk } from './ws-auth';
import { isAllowedWsOrigin } from '../util/origin';
import { runUpdate } from '../docker/update';
import { log } from '../logger';

export function registerUpdate(server: FastifyInstance): void {
  server.get('/api/update', { websocket: true }, async (socket: WebSocket, req: FastifyRequest) => {
    if (!isAllowedWsOrigin(req)) return socket.close(4403, 'Bad origin.');
    if (!wsAuthed(req)) return socket.close(4401, 'Please sign in.');
    if (!requestCsrfOk(req)) return socket.close(4403, 'This request came from an unexpected place.');

    const send = (line: string) => {
      if (socket.readyState === socket.OPEN) socket.send(line + '\n');
    };
    try {
      await runUpdate(send);
    } catch (err) {
      log.error('update failed', err);
      send(`Update failed: ${(err as Error).message}`);
    }
    try {
      socket.close();
    } catch {
      /* the core may already be restarting */
    }
  });
}
