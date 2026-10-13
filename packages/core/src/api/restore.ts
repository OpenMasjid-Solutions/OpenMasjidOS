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
import { isConfigured } from '../auth/store';
import { isViaTunnel } from '../system/via-tunnel';
import { wasHandedOver } from '../system/remote-admin';
import { wsAuthed, requestCsrfOk, requestSessionToken, requestUser } from './ws-auth';
import { isAllowedWsOrigin, isAllowedOrigin } from '../util/origin';
import { BACKUP_RUNNING, RESTORE_PATH, quickCheckArchive, runRestore, restoreInProgress, type RestoreOutcome } from '../system/restore';
import { backupInProgress } from '../system/backup';
import { clashFor, finishing, finishingMessage } from '../system/update-lock';
import { NOFOLLOW_WRITE } from '../files/manager';
import { log } from '../logger';

/**
 * The close code for each way a restore can end (system/restore.ts `RestoreOutcome`).
 * The dashboard's RestoreModal reads it — keep the two in step.
 */
export const RESTORE_CLOSE: Readonly<Record<RestoreOutcome, [number, string]>> = {
  restarting: [1000, 'restarting'],
  'restarting-with-problems': [4003, 'restarting-with-problems'],
  unchanged: [4001, 'unchanged'],
  'not-restarted': [4002, 'not-restarted'],
  'restored-not-restarted': [4004, 'restored-not-restarted'],
};

function authed(req: FastifyRequest): boolean {
  return Boolean(requestUser(req));
}

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
    } else if (isViaTunnel(req)) {
      // The open first-run restore is for someone in the building, never the internet
      // (system/remote-admin.ts `remoteAdminEnabled` says why it can matter).
      return reply.code(403).send({ error: 'Restoring a backup onto a new box has to be done at the masjid.' });
    }
    // The running restore is reading this very file. Writing over it mid-run is how a
    // second restore used to start on top of the first (system/restore.ts says more).
    if (restoreInProgress()) {
      const error = finishing('restore') ? finishingMessage('restore') : 'A restore is already running. Please wait for it to finish.';
      return reply.code(409).send({ error });
    }
    // Nor while an update is under way, which the restore would refuse anyway — said
    // before the file is read or saved (system/update-lock.ts).
    const clash = clashFor('restore');
    if (clash) return reply.code(409).send({ error: clash });
    if (backupInProgress()) return reply.code(409).send({ error: BACKUP_RUNNING });
    try {
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: 'No backup file was uploaded.' });
      // Never THROUGH a symlink planted at RESTORE_PATH.
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
    // A refusal is said in the window too, not only in the close frame: the window shows
    // what the stream sent, and "the messages above say why" over an empty log was false.
    const refuse = (code: number, why: string) => {
      if (socket.readyState === socket.OPEN) socket.send(`${why} Nothing has been changed.\n`);
      socket.close(code, why);
    };
    if (!isAllowedWsOrigin(req)) return refuse(4403, 'This request came from an unexpected place.');
    // First-run restore is open (see the upload route); otherwise require auth + key.
    if (isConfigured()) {
      if (!wsAuthed(req)) return refuse(4401, 'Please sign in again, then start the restore once more.');
      if (!requestCsrfOk(req)) return refuse(4403, 'This request came from an unexpected place.');
    } else if (isViaTunnel(req)) {
      return refuse(4403, 'Restoring a backup onto a new box has to be done at the masjid.');
    }
    const send = (line: string) => {
      if (socket.readyState === socket.OPEN) socket.send(line + '\n');
    };
    let outcome: RestoreOutcome = 'not-restarted';
    try {
      // From outside — the remote dashboard, handed over by the front door — a restore
      // must not lock the admin out (system/restore.ts says how). Not merely "looks
      // remote": a masjid's own reverse proxy is at the masjid.
      outcome = await runRestore(send, { remote: wasHandedOver(req.raw), callerToken: requestSessionToken(req) });
    } catch (err) {
      log.error('restore failed', err);
      send(`Restore failed: ${(err as Error).message}`);
    }
    try {
      // The close code tells the window how it ended (RestoreOutcome), so it never
      // waits for a restart that is not coming and then calls it a success.
      socket.close(...RESTORE_CLOSE[outcome]);
    } catch {
      /* the core may already be restarting */
    }
  });
}
