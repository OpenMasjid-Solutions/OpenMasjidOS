/** Shared session-cookie auth for the raw WebSocket / streaming HTTP routes. */
import type { FastifyRequest } from 'fastify';
import { COOKIE_NAME, getSessionUser } from '../auth/sessions';

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx !== -1 && part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

export function wsAuthed(req: FastifyRequest): boolean {
  const token =
    (req.cookies && req.cookies[COOKIE_NAME]) ?? parseCookie(req.headers?.cookie, COOKIE_NAME);
  return Boolean(getSessionUser(token));
}
