/**
 * File download + upload over HTTP (they stream binary, so they aren't tRPC).
 * Authenticated by the session cookie, like the backup route. Sandboxed via the
 * file manager.
 */
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { COOKIE_NAME, getSessionUser } from '../auth/sessions';
import { isAllowedOrigin } from '../util/origin';
import { resolveFile, uploadPath, rawMime, FileError } from '../files/manager';

function authed(req: FastifyRequest): boolean {
  return Boolean(getSessionUser(req.cookies?.[COOKIE_NAME]));
}

export function registerFiles(server: FastifyInstance): void {
  // Download a file as an attachment.
  server.get('/api/files/download', async (req, reply) => {
    if (!isAllowedOrigin(req)) return reply.code(403).send({ error: 'Bad origin.' });
    if (!authed(req)) return reply.code(401).send({ error: 'Please sign in.' });
    const p = (req.query as { path?: string }).path ?? '';
    try {
      const { full, name } = resolveFile(p);
      reply.header('content-disposition', `attachment; filename="${encodeURIComponent(name)}"`);
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.type('application/octet-stream');
      return reply.send(fs.createReadStream(full));
    } catch (err) {
      const code = err instanceof FileError && err.code === 'NOT_FOUND' ? 404 : 400;
      return reply.code(code).send({ error: (err as Error).message });
    }
  });

  // Serve a file inline for viewing (images, video, audio). Only known media
  // types are served with their real content-type; everything else is forced to
  // a plain download type. A strict CSP sandbox + nosniff neutralises any
  // attempt to get HTML/JS to execute same-origin from user content.
  server.get('/api/files/raw', async (req, reply) => {
    // Inline <img>/<video> loads send no Origin (allowed); a scripted cross-port
    // fetch carries one and is rejected.
    if (!isAllowedOrigin(req)) return reply.code(403).send({ error: 'Bad origin.' });
    if (!authed(req)) return reply.code(401).send({ error: 'Please sign in.' });
    const p = (req.query as { path?: string }).path ?? '';
    try {
      const { full, name } = resolveFile(p);
      const mime = rawMime(name);
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
      reply.header('Cache-Control', 'private, no-store');
      reply.header('Content-Disposition', `inline; filename="${encodeURIComponent(name)}"`);
      reply.type(mime ?? 'application/octet-stream');
      return reply.send(fs.createReadStream(full));
    } catch (err) {
      const code = err instanceof FileError && err.code === 'NOT_FOUND' ? 404 : 400;
      return reply.code(code).send({ error: (err as Error).message });
    }
  });

  // Upload a file into a directory (multipart).
  server.post('/api/files/upload', async (req, reply) => {
    if (!isAllowedOrigin(req)) return reply.code(403).send({ error: 'Bad origin.' });
    if (!authed(req)) return reply.code(401).send({ error: 'Please sign in.' });
    const dir = (req.query as { path?: string }).path ?? '/';
    try {
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: 'No file was uploaded.' });
      const dest = uploadPath(dir, file.filename);
      await pipeline(file.file, fs.createWriteStream(dest));
      if (file.file.truncated) {
        // Exceeded the configured size limit — remove the partial file.
        fs.rmSync(dest, { force: true });
        return reply.code(413).send({ error: 'That file is too large.' });
      }
      return { ok: true };
    } catch (err) {
      const code = err instanceof FileError && err.code === 'NOT_FOUND' ? 404 : 400;
      return reply.code(code).send({ error: (err as Error).message });
    }
  });
}
