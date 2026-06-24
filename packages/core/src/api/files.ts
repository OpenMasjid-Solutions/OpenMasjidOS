/**
 * File download + upload over HTTP (they stream binary, so they aren't tRPC).
 * Authenticated by the session cookie, like the backup route. Sandboxed via the
 * file manager.
 */
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { COOKIE_NAME, getSessionUser } from '../auth/sessions';
import { requestCsrfOk } from './ws-auth';
import { isAllowedOrigin } from '../util/origin';
import { resolveFile, uploadPath, rawMime, FileError } from '../files/manager';

function authed(req: FastifyRequest): boolean {
  return Boolean(getSessionUser(req.cookies?.[COOKIE_NAME]));
}

// Open flags for a binary upload that NEVER follows a symlink at the final
// component: O_NOFOLLOW makes open() fail with ELOOP if the destination is a
// symlink, so a symlink planted by a malicious app/backup can't redirect the
// write outside the sandbox (security audit). O_NOFOLLOW is 0 on platforms that
// lack it (e.g. Windows dev) — harmless there; production is Linux.
// `flags` is typed string, but createWriteStream forwards it to fs.open, which
// accepts a numeric flag set — cast so we can OR in O_NOFOLLOW.
const NOFOLLOW_WRITE = (fs.constants.O_WRONLY |
  fs.constants.O_CREAT |
  fs.constants.O_TRUNC |
  (fs.constants.O_NOFOLLOW ?? 0)) as unknown as string;

export function registerFiles(server: FastifyInstance): void {
  // Download a file as an attachment.
  server.get('/api/files/download', async (req, reply) => {
    if (!isAllowedOrigin(req)) return reply.code(403).send({ error: 'Bad origin.' });
    if (!authed(req)) return reply.code(401).send({ error: 'Please sign in.' });
    if (!requestCsrfOk(req)) return reply.code(403).send({ error: 'This request came from an unexpected place.' });
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
    if (!requestCsrfOk(req)) return reply.code(403).send({ error: 'This request came from an unexpected place.' });
    const dir = (req.query as { path?: string }).path ?? '/';
    try {
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: 'No file was uploaded.' });
      const dest = uploadPath(dir, file.filename);
      // O_NOFOLLOW: never write THROUGH a pre-existing symlink at the destination
      // (which could point outside the sandbox at e.g. the credential store).
      await pipeline(file.file, fs.createWriteStream(dest, { flags: NOFOLLOW_WRITE }));
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
