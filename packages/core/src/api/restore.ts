// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
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
import { isConfigured } from '../auth/store';
import { wsAuthed, requestCsrfOk } from './ws-auth';
import { isAllowedWsOrigin, isAllowedOrigin } from '../util/origin';
import { RESTORE_PATH, quickCheckArchive, runRestore } from '../system/restore';
import { log } from '../logger';

function authed(req: FastifyRequest): boolean {
  return Boolean(getSessionUser(req.cookies?.[COOKIE_NAME]));
}

// Never write the uploaded archive THROUGH a symlink planted at RESTORE_PATH.
// (cast: createWriteStream types `flags` as string but forwards it to fs.open,
// which accepts a numeric flag set, so we can OR in O_NOFOLLOW.)
const NOFOLLOW_WRITE = (fs.constants.O_WRONLY |
  fs.constants.O_CREAT |
  fs.constants.O_TRUNC |
  (fs.constants.O_NOFOLLOW ?? 0)) as unknown as string;

export function registerRestore(server: FastifyInstance): void {
  // Upload + sanity-check the backup. Kept separate from the run step so the
  // user gets immediate feedback if the file is bad, before anything is touched.
  server.post('/api/restore/upload', async (req, reply) => {
    // Cookie-only routes need an Origin check, or a same-site app on another
    // port could CSRF an upload (see util/origin.ts).
    if (!isAllowedOrigin(req)) return reply.code(403).send({ error: 'Bad origin.' });
    // First-run (no admin yet) restore is OPEN — same trust model as first-run
    // setup: a fresh, unconfigured box belongs to whoever reaches it first, and
    // restoring is the intended way to migrate onto a new machine. Once an admin
    // exists, restore requires a session + the dashboard key.
    if (isConfigured()) {
      if (!authed(req)) return reply.code(401).send({ error: 'Please sign in.' });
      if (!requestCsrfOk(req)) return reply.code(403).send({ error: 'This request came from an unexpected place.' });
    }
    try {
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: 'No backup file was uploaded.' });
      await pipeline(file.file, fs.createWriteStream(RESTORE_PATH, { flags: NOFOLLOW_WRITE }));
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
    // First-run restore is open (see the upload route); otherwise require auth + key.
    if (isConfigured()) {
      if (!wsAuthed(req)) return socket.close(4401, 'Please sign in.');
      if (!requestCsrfOk(req)) return socket.close(4403, 'This request came from an unexpected place.');
    }
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
