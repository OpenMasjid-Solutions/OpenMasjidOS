// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
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
import { updateCatalogApp, type AppUpdateOutcome } from '../apps/manager';
import { log } from '../logger';

/**
 * How the stream closes says how the update ended (ui/src/components/AppUpdate.tsx). 1000:
 * updated. 4003: updated, but the new version does not stay up. 4002: it stopped part-way.
 * Any other 4xxx: nothing was changed — already current, refused, put back, or never begun.
 * The window used to say "<app> is up to date now." however it had ended.
 */
export const APP_UPDATE_CLOSE: Record<AppUpdateOutcome | 'failed', [number, string]> = {
  updated: [1000, 'Updated.'],
  unchanged: [4001, 'Nothing was changed.'],
  'not-running': [4003, 'Updated, but not staying up.'],
  failed: [4002, 'Stopped part-way.'],
};

export function registerAppUpdate(server: FastifyInstance): void {
  server.get('/api/apps/update', { websocket: true }, async (socket: WebSocket, req: FastifyRequest) => {
    // A refusal says why, as a line, before closing (the window points at "the messages above").
    const refuse = (code: number, why: string) => {
      if (socket.readyState === socket.OPEN) socket.send(`${why} Nothing was changed.\n`);
      socket.close(code, why);
    };
    if (!isAllowedWsOrigin(req)) return refuse(4403, 'This request came from an unexpected place.');
    if (!wsAuthed(req)) return refuse(4401, 'Please sign in again, then start the update once more.');
    if (!requestCsrfOk(req)) return refuse(4403, 'This request came from an unexpected place.');

    const id = (req.query as { id?: string }).id ?? '';
    const send = (line: string) => {
      if (socket.readyState === socket.OPEN) socket.send(line + '\n');
    };
    if (!isValidAppId(id)) return refuse(4400, 'That app could not be found.');

    let outcome: AppUpdateOutcome | 'failed' = 'unchanged';
    try {
      outcome = await updateCatalogApp(id, send);
    } catch (err) {
      // Same as the core updater: a refused second run is the guard working, not a fault.
      if ((err as Error).name === 'UpdateBusyError') {
        send((err as Error).message);
      } else {
        log.error('app update failed', err);
        send(`Update failed: ${(err as Error).message}`);
        outcome = 'failed';
      }
    }
    try {
      socket.close(...APP_UPDATE_CLOSE[outcome]);
    } catch {
      /* ignore */
    }
  });
}
