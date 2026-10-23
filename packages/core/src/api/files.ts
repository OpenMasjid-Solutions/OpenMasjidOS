// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * File download + upload over HTTP (they stream binary, so they aren't tRPC).
 * Authenticated by the session cookie, like the backup route. Sandboxed via the
 * file manager.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requestCsrfOk, requestUser } from './ws-auth';
import { isAllowedOrigin } from '../util/origin';
import { resolveFile, uploadPath, rawMime, FileError, NOFOLLOW_WRITE } from '../files/manager';
import { log } from '../logger';

function authed(req: FastifyRequest): boolean {
  return Boolean(requestUser(req));
}

/** 404 when it's missing, 403 for platform-owned state the explorer may not touch
 *  [OPENMASJIDOS-004], 400 for anything else malformed. */
function statusFor(err: unknown): number {
  if (!(err instanceof FileError)) return 400;
  if (err.code === 'NOT_FOUND') return 404;
  if (err.code === 'PROTECTED') return 403;
  return 400;
}

/**
 * A Content-Disposition with the file's real name where browsers read it, `filename*`
 * (RFC 6266/5987), and a plain-ASCII stand-in for any that cannot. A percent-encoded
 * `filename="…"` was saved as it stood: "Jumuah%20notes.pdf".
 */
function contentDisposition(kind: 'attachment' | 'inline', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Why an upload failed, in words that say what to do; the detail goes to the log. */
function uploadFailure(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOSPC') return "There isn't enough free space on the server for that file.";
  if (code === 'EISDIR') return 'There is already a folder with that name here.';
  return "That file couldn't be uploaded. Please try again.";
}

export function registerFiles(server: FastifyInstance): void {
  // Download a file as an attachment.
  server.get('/api/files/download', async (req, reply) => {
    if (!isAllowedOrigin(req)) return reply.code(403).send({ error: 'Bad origin.' });
    if (!authed(req)) return reply.code(401).send({ error: 'Please sign in.' });
    if (!requestCsrfOk(req)) return reply.code(403).send({ error: 'This request came from an unexpected place.' });
    const p = (req.query as { path?: string }).path ?? '';
    try {
      const { full, name } = resolveFile(p);
      reply.header('content-disposition', contentDisposition('attachment', name));
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.type('application/octet-stream');
      return reply.send(fs.createReadStream(full));
    } catch (err) {
      return reply.code(statusFor(err)).send({ error: (err as Error).message });
    }
  });

  // Serve a file inline for viewing (images, video, audio). Only known media
  // types are served with their real content-type; everything else is forced to
  // a plain download type. A strict CSP sandbox + nosniff neutralises any
  // attempt to get HTML/JS to execute same-origin from user content.
  server.get('/api/files/raw', async (req, reply) => {
    // Inline <img>/<video> loads send no Origin (allowed); a scripted cross-port
    // fetch carries one and is rejected. The dashboard key in ?k= stops an app
    // that captured the shared cookie from reading files via a forged request.
    if (!isAllowedOrigin(req)) return reply.code(403).send({ error: 'Bad origin.' });
    if (!authed(req)) return reply.code(401).send({ error: 'Please sign in.' });
    if (!requestCsrfOk(req)) return reply.code(403).send({ error: 'This request came from an unexpected place.' });
    const p = (req.query as { path?: string }).path ?? '';
    try {
      const { full, name } = resolveFile(p);
      const mime = rawMime(name);
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
      reply.header('Cache-Control', 'private, no-store');
      // This address carries the dashboard key (?k=). From outside the apps share its
      // origin, so an image an SVG loads from an app's path would tell that app the key.
      reply.header('Referrer-Policy', 'no-referrer');
      reply.header('Content-Disposition', contentDisposition('inline', name));
      reply.type(mime ?? 'application/octet-stream');
      return reply.send(fs.createReadStream(full));
    } catch (err) {
      return reply.code(statusFor(err)).send({ error: (err as Error).message });
    }
  });

  // Upload a file into a directory (multipart).
  server.post('/api/files/upload', async (req, reply) => {
    if (!isAllowedOrigin(req)) return reply.code(403).send({ error: 'Bad origin.' });
    if (!authed(req)) return reply.code(401).send({ error: 'Please sign in.' });
    if (!requestCsrfOk(req)) return reply.code(403).send({ error: 'This request came from an unexpected place.' });
    const dir = (req.query as { path?: string }).path ?? '/';
    let temp: string | null = null;
    try {
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: 'No file was uploaded.' });
      const dest = uploadPath(dir, file.filename);
      // Into a new file beside it, renamed over the old one only once whole: a failed or
      // cancelled upload left half a file, after O_TRUNC had already emptied the one it replaced.
      // The rename replaces a symlink at `dest` itself, never what it points to.
      temp = path.join(path.dirname(dest), `.upload-${crypto.randomBytes(8).toString('hex')}.tmp`);
      await pipeline(file.file, fs.createWriteStream(temp, { flags: NOFOLLOW_WRITE }));
      if (file.file.truncated) return reply.code(413).send({ error: 'That file is too large.' });
      fs.renameSync(temp, dest);
      temp = null;
      return { ok: true };
    } catch (err) {
      if (err instanceof FileError) return reply.code(statusFor(err)).send({ error: err.message });
      log.warn('A file upload failed.', err);
      return reply.code(500).send({ error: uploadFailure(err) });
    } finally {
      try {
        if (temp) fs.rmSync(temp, { force: true });
      } catch {
        /* best effort */
      }
    }
  });
}
