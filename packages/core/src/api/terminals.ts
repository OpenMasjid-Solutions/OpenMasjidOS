/**
 * WebSocket terminal endpoints. Off by default and gated server-side by the
 * webTerminal / rootTerminal settings (CLAUDE.md §13). Authenticated by the
 * session cookie. Binary frames carry terminal output/input; a small JSON
 * control message carries resize events.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { COOKIE_NAME, getSessionUser } from '../auth/sessions';
import { getSettings } from '../settings/store';
import { rootTerminal, appTerminal, type TermSession } from '../docker/terminal';
import { log } from '../logger';

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

function isAuthed(req: FastifyRequest): boolean {
  const token =
    (req.cookies && req.cookies[COOKIE_NAME]) ?? parseCookie(req.headers?.cookie, COOKIE_NAME);
  return Boolean(getSessionUser(token));
}

function bridge(socket: WebSocket, session: TermSession): void {
  session.stream.on('data', (chunk: Buffer) => {
    if (socket.readyState === socket.OPEN) socket.send(chunk);
  });
  session.stream.on('end', () => {
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  });
  socket.on('message', (data: Buffer) => {
    const str = data.toString();
    if (str.startsWith('{')) {
      try {
        const msg = JSON.parse(str) as { __resize?: [number, number] };
        if (msg && Array.isArray(msg.__resize)) {
          session.resize(msg.__resize[0], msg.__resize[1]);
          return;
        }
      } catch {
        /* not a control message — treat as keystrokes */
      }
    }
    session.stream.write(data);
  });
  socket.on('close', () => session.close());
}

export function registerTerminals(server: FastifyInstance): void {
  server.get('/api/terminal/root', { websocket: true }, async (socket: WebSocket, req: FastifyRequest) => {
    if (!isAuthed(req)) return socket.close(4401, 'Please sign in.');
    if (!getSettings().rootTerminal) return socket.close(4403, 'Root terminal is turned off.');
    try {
      bridge(socket, await rootTerminal());
    } catch (err) {
      log.error('root terminal failed', err);
      try {
        socket.send(`\r\nCould not open a terminal: ${(err as Error).message}\r\n`);
      } catch {
        /* ignore */
      }
      socket.close();
    }
  });

  server.get(
    '/api/terminal/app/:id',
    { websocket: true },
    async (socket: WebSocket, req: FastifyRequest) => {
      if (!isAuthed(req)) return socket.close(4401, 'Please sign in.');
      if (!getSettings().webTerminal) return socket.close(4403, 'The web terminal is turned off.');
      const id = (req.params as { id: string }).id;
      try {
        bridge(socket, await appTerminal(id));
      } catch (err) {
        try {
          socket.send(`\r\n${(err as Error).message}\r\n`);
        } catch {
          /* ignore */
        }
        socket.close();
      }
    },
  );
}
