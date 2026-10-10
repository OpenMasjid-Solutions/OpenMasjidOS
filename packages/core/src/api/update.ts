// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Live update endpoint. Streams the update process (pull → apply → restart) to
 * the dashboard over a WebSocket so a non-technical admin can update with one
 * click and watch it happen — never needing a terminal.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { wsAuthed, requestCsrfOk } from './ws-auth';
import { isAllowedWsOrigin } from '../util/origin';
import { runUpdate, type UpdateOutcome } from '../docker/update';
import type { UpdateBusyError } from '../system/update-lock';
import { wasHandedOver } from '../system/remote-admin';
import { log } from '../logger';

/**
 * How the stream closes says how the update ended (ui/src/components/UpdateModal.tsx).
 * 1000: the core is restarting — wait for it. 4001: nothing was changed — say so now,
 * instead of waiting minutes for a restart that is not coming.
 */
export const UPDATE_CLOSE: Record<UpdateOutcome, [number, string]> = {
  restarting: [1000, 'Restarting.'],
  unchanged: [4001, 'Nothing was changed.'],
};

export function registerUpdate(server: FastifyInstance): void {
  server.get('/api/update', { websocket: true }, async (socket: WebSocket, req: FastifyRequest) => {
    // A refusal says why, as a line, before closing: the window reads any 4xxx close as
    // "nothing was changed — the messages above say why", so there must be one.
    const refuse = (code: number, why: string) => {
      if (socket.readyState === socket.OPEN) socket.send(`${why} Nothing was changed.\n`);
      socket.close(code, why);
    };
    if (!isAllowedWsOrigin(req)) return refuse(4403, 'This request came from an unexpected place.');
    if (!wsAuthed(req)) return refuse(4401, 'Please sign in again, then start the update once more.');
    if (!requestCsrfOk(req)) return refuse(4403, 'This request came from an unexpected place.');

    const send = (line: string) => {
      if (socket.readyState === socket.OPEN) socket.send(line + '\n');
    };
    let outcome: UpdateOutcome = 'unchanged';
    try {
      // From outside, only to a version that can itself be managed from outside.
      outcome = await runUpdate(send, { remote: wasHandedOver(req.raw) });
    } catch (err) {
      // "Already running" is not a failure — it is the safety net doing its job, and
      // calling it a failure would push an admin into retrying, which is the very thing
      // that breaks the box. That other update may well restart the core, so the window
      // watches for it as for its own (and says so if it never comes). Refused because
      // something ELSE is under way — a restore, an app's update — nothing is coming.
      if ((err as Error).name === 'UpdateBusyError') {
        send((err as Error).message);
        outcome = (err as UpdateBusyError).clash ? 'unchanged' : 'restarting';
      } else {
        log.error('update failed', err);
        send(`Update failed: ${(err as Error).message}`);
      }
    }
    try {
      socket.close(...UPDATE_CLOSE[outcome]);
    } catch {
      /* the core may already be restarting */
    }
  });
}
