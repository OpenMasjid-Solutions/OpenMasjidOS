// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Branding upload — the admin sets/clears the masjid logo (Settings → Customize).
 * These are admin-only, cookie-authenticated routes registered on the dashboard
 * listener only (never the front door), so the logo can only be changed from the
 * dashboard: on the masjid's network, or from outside through the remote-administration
 * hand-over, behind the second factor. The PUBLIC read endpoint (GET /api/public/logo)
 * lives in the Fabric module so it is reachable over the tunnel for webhook avatars.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requestCsrfOk, requestUser } from './ws-auth';
import { isAllowedOrigin } from '../util/origin';
import { saveLogo, removeLogo, isAllowedLogoMime, MAX_LOGO_BYTES } from '../store/branding';
import { finishing, finishingMessage, isUpdating } from '../system/update-lock';
import { log } from '../logger';

function authed(req: FastifyRequest): boolean {
  return Boolean(requestUser(req));
}

// Cookie-only routes need an Origin check + the dashboard key, so a same-site app
// on another port (which shares the cookie) can't upload on the admin's behalf.
function guard(req: FastifyRequest): { code: number; error: string } | null {
  if (!isAllowedOrigin(req)) return { code: 403, error: 'Bad origin.' };
  if (!authed(req)) return { code: 401, error: 'Please sign in.' };
  if (!requestCsrfOk(req)) return { code: 403, error: 'This request came from an unexpected place.' };
  // The logo lives in config/, which a restore replaces whole: a change made meanwhile was
  // written over, as every other change is refused then (trpc/trpc.ts noChangesDuringRestore).
  if (isUpdating('restore')) {
    return {
      code: 409,
      error: finishing('restore')
        ? finishingMessage('restore')
        : 'A backup is being restored right now. Please try this again once it has finished.',
    };
  }
  return null;
}

export function registerBranding(server: FastifyInstance): void {
  server.post('/api/branding/logo', async (req, reply) => {
    const bad = guard(req);
    if (bad) return reply.code(bad.code).send({ error: bad.error });
    try {
      const file = await req.file({ limits: { fileSize: MAX_LOGO_BYTES } });
      if (!file) return reply.code(400).send({ error: 'No image was uploaded.' });
      if (!isAllowedLogoMime(file.mimetype)) {
        // Drain the stream so the connection closes cleanly, then reject.
        await file.toBuffer().catch(() => undefined);
        return reply.code(415).send({ error: 'Please upload a PNG, JPG, or WebP image.' });
      }
      const buf = await file.toBuffer();
      if (file.file.truncated) {
        return reply.code(413).send({ error: 'That image is too large (max 1 MB).' });
      }
      saveLogo(buf, file.mimetype);
      log.info('Masjid logo updated.');
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  server.delete('/api/branding/logo', async (req, reply) => {
    const bad = guard(req);
    if (bad) return reply.code(bad.code).send({ error: bad.error });
    removeLogo();
    log.info('Masjid logo removed.');
    return { ok: true };
  });
}
