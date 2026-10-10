// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The backup download from OUTSIDE: the response starts before the backup does.
 *
 * Making a backup copies every app's data first, and only then starts the file.
 * On the masjid's network that wait is invisible. Through Cloudflare it is not:
 * Cloudflare gives up on an address that has not started answering in 100 seconds
 * and shows its own error page, so on any install whose data takes that long to
 * copy, a remote download failed every time. So the headers go now and the file
 * follows when it is ready. A failure after that cannot be a tidy message any more
 * — the download is broken off instead, which the browser reports as failed rather
 * than saving a partial file the admin would trust. "Already running" is still
 * answered properly, because it is known before anything is sent.
 */
import type { ServerResponse } from 'node:http';
import type { FastifyReply } from 'fastify';
import { backupFilename, backupRefusal, backupStream, type BackupHandle } from '../system/backup';
import { NO_STORE_HEADERS } from '../system/tunnel-refusals';
import { log } from '../logger';

/** Starts a backup — `backupStream`, or a stand-in in a test. */
export type StartBackup = () => Promise<BackupHandle>;

/**
 * Send a backup's bytes, and END the response only once tar has said it succeeded.
 *
 * tar's output ends BEFORE tar itself exits, so a response ended with the output — by a
 * pipe, or by Fastify's `reply.send(stream)` — was delivered whole and clean for a backup
 * tar had FAILED: a file it could not read left out, an archive cut short. The browser
 * said "done", the log said "Backup failed", and the admin found out at the restore. Now
 * the bytes go as they come, and the end waits for both: the output finished AND tar
 * reported success (`done.ok`). Anything else breaks the download off, which a browser
 * reports as failed. Used by the download on the masjid's network and from outside alike.
 */
export function sendBackup(res: ServerResponse, backup: BackupHandle): void {
  // Already gone — a browser that left while the app data was being copied. Its 'close'
  // has fired and will not fire again, so piping into it would leave tar blocked for ever
  // with "a backup is already running" set. End the backup now instead.
  if (res.destroyed || res.socket == null || res.socket.destroyed) {
    backup.stream.destroy();
    return;
  }
  // The browser left: end tar, which is what clears "a backup is already running".
  res.once('close', () => backup.stream.destroy());
  backup.stream.on('error', () => res.destroy());
  const ended = new Promise<boolean>((resolve) => {
    backup.stream.once('end', () => resolve(true));
    backup.stream.once('close', () => resolve(false)); // after 'end' this is a no-op
  });
  backup.stream.pipe(res, { end: false });
  void Promise.all([ended, backup.done]).then(([finished, result]) => {
    if (finished && result.ok) res.end();
    else res.destroy();
  });
}

export function remoteBackupDownload(reply: FastifyReply): FastifyReply | undefined {
  // Refused while the answer can still be a proper 409 — after the headers, it would be a
  // download that just breaks off.
  const refused = backupRefusal();
  if (refused) return reply.code(409).send({ error: refused });
  reply.hijack();
  sendBackupEarly(reply.raw, backupStream);
  return undefined;
}

/**
 * Send the headers now and the backup when `start` has made it.
 *
 * THE BROWSER CAN LEAVE BEFORE THERE IS ANYTHING TO SEND, and that must end the
 * backup. Leaving was only noticed once the backup existed, by a listener attached
 * then — but the 'close' had already fired during the minutes spent copying app
 * data, and fires once. The backup was then piped into a dead response: the pipe
 * paused for ever, tar blocked on a full pipe and never exited, and the "one backup
 * at a time" flag it clears on exit stayed set. Every later backup, the nightly
 * off-site one included, was refused as "already running" until the next restart,
 * with a copy of every app's data left on disk. Cancelling a download stuck at
 * 0 bytes was enough, and so was Cloudflare dropping a silent connection.
 *
 * So the listener goes on first, and the backup is handed to `sendBackup`, which tears
 * the source down whichever side fails — ending tar, which is what clears the flag —
 * and ends the download only if tar succeeded.
 */
export function sendBackupEarly(res: ServerResponse, start: StartBackup = backupStream): void {
  let gone = false;
  res.once('close', () => {
    gone = true;
  });
  res.writeHead(200, {
    'content-type': 'application/gzip',
    'content-disposition': `attachment; filename="${backupFilename()}"`,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...NO_STORE_HEADERS,
  });
  res.flushHeaders();
  start().then(
    (backup) => {
      if (gone || res.destroyed) {
        backup.stream.destroy();
        return;
      }
      sendBackup(res, backup);
    },
    (err: unknown) => {
      log.warn(`A backup download from outside could not start: ${(err as Error).message}`);
      res.destroy();
    },
  );
}
