/**
 * Restore endpoints: an HTTP upload for the backup file (multipart, streamed to
 * disk + validated), and a WebSocket that streams the actual restore so the
 * admin watches it happen and the page reconnects when the core comes back —
 * the same UX as the live update.
 */
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { COOKIE_NAME, getSessionUser } from '../auth/sessions';
import { wsAuthed } from './ws-auth';
import { isAllowedWsOrigin, isAllowedOrigin } from '../util/origin';
import { RESTORE_PATH, quickCheckArchive, runRestore } from '../system/restore';
import { log } from '../logger';

function authed(req: FastifyRequest): boolean {
  return Boolean(getSessionUser(req.cookies?.[COOKIE_NAME]));
}

export function registerRestore(server: FastifyInstance): void {
  // Upload + sanity-check the backup. Kept separate from the run step so the
  // user gets immediate feedback if the file is bad, before anything is touched.
  server.post('/api/restore/upload', async (req, reply) => {
    // Cookie-only routes need an Origin check, or a same-site app on another
    // port could CSRF an upload (see util/origin.ts).
    if (!isAllowedOrigin(req)) return reply.code(403).send({ error: 'Bad origin.' });
    if (!authed(req)) return reply.code(401).send({ error: 'Please sign in.' });
    try {
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: 'No backup file was uploaded.' });
      await pipeline(file.file, fs.createWriteStream(RESTORE_PATH));
      if (file.file.truncated) {
        fs.rmSync(RESTORE_PATH, { force: true });
        return reply.code(413).send({ error: 'That backup file is too large.' });
      }
      const err = await quickCheckArchive();
      if (err) {
        fs.rmSync(RESTORE_PATH, { force: true });
        return reply.code(400).send({ error: err });
      }
      return { ok: true };
    } catch (e) {
      try {
        fs.rmSync(RESTORE_PATH, { force: true });
      } catch {
        /* ignore */
      }
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // Stream the restore (extract → restart apps → recreate core).
  server.get('/api/restore/run', { websocket: true }, async (socket: WebSocket, req: FastifyRequest) => {
    if (!isAllowedWsOrigin(req)) return socket.close(4403, 'Bad origin.');
    if (!wsAuthed(req)) return socket.close(4401, 'Please sign in.');
    const send = (line: string) => {
      if (socket.readyState === socket.OPEN) socket.send(line + '\n');
    };
    try {
      await runRestore(send);
    } catch (err) {
      log.error('restore failed', err);
      send(`Restore failed: ${(err as Error).message}`);
    }
    try {
      socket.close();
    } catch {
      /* the core may already be restarting */
    }
  });
}
