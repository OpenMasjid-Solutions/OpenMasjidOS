/**
 * Streams a catalog app's update (pull → recreate) over a WebSocket so the
 * dashboard can show live progress in a window — same pattern as the core
 * updater. Gated by origin + auth; the app id is validated before anything runs.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { wsAuthed, requestCsrfOk } from './ws-auth';
import { isAllowedWsOrigin } from '../util/origin';
import { isValidAppId } from '../util/id';
import { updateCatalogApp } from '../apps/manager';
import { log } from '../logger';

export function registerAppUpdate(server: FastifyInstance): void {
  server.get('/api/apps/update', { websocket: true }, async (socket: WebSocket, req: FastifyRequest) => {
    if (!isAllowedWsOrigin(req)) return socket.close(4403, 'Bad origin.');
    if (!wsAuthed(req)) return socket.close(4401, 'Please sign in.');
    if (!requestCsrfOk(req)) return socket.close(4403, 'This request came from an unexpected place.');

    const id = (req.query as { id?: string }).id ?? '';
    const send = (line: string) => {
      if (socket.readyState === socket.OPEN) socket.send(line + '\n');
    };
    if (!isValidAppId(id)) {
      send('Invalid app.');
      return socket.close();
    }

    try {
      await updateCatalogApp(id, send);
    } catch (err) {
      log.error('app update failed', err);
      send(`Update failed: ${(err as Error).message}`);
    }
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  });
}
