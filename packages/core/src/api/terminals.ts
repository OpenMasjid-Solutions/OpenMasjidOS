/**
 * WebSocket terminal endpoints. Off by default and gated server-side by the
 * webTerminal / rootTerminal settings (CLAUDE.md §13). Authenticated by the
 * session cookie. Binary frames carry terminal output/input; a small JSON
 * control message carries resize events.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { getSettings } from '../settings/store';
import { rootTerminal, appTerminal, type TermSession } from '../docker/terminal';
import { isAllowedWsOrigin } from '../util/origin';
import { isValidAppId } from '../util/id';
import { wsAuthed } from './ws-auth';
import { log } from '../logger';

function clampDim(n: unknown): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return 80;
  return Math.max(1, Math.min(1000, v));
}

function bridge(socket: WebSocket, session: TermSession): void {
  const closeSocket = () => {
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  };
  session.stream.on('data', (chunk: Buffer) => {
    if (socket.readyState === socket.OPEN) socket.send(chunk);
  });
  session.stream.on('end', closeSocket);
  // Without an 'error' handler a hijacked-stream error (e.g. the app container
  // is killed while the shell is open) would throw and crash the root daemon.
  session.stream.on('error', (err) => {
    log.warn('terminal stream error', err);
    closeSocket();
  });
  socket.on('message', (data: Buffer) => {
    const str = data.toString();
    if (str.startsWith('{')) {
      try {
        const msg = JSON.parse(str) as { __resize?: [number, number] };
        if (msg && Array.isArray(msg.__resize)) {
          session.resize(clampDim(msg.__resize[0]), clampDim(msg.__resize[1]));
          return;
        }
      } catch {
        /* not a control message — treat as keystrokes */
      }
    }
    try {
      session.stream.write(data);
    } catch (err) {
      log.warn('terminal write error', err);
      closeSocket();
    }
  });
  socket.on('close', () => session.close());
}

export function registerTerminals(server: FastifyInstance): void {
  server.get('/api/terminal/root', { websocket: true }, async (socket: WebSocket, req: FastifyRequest) => {
    if (!isAllowedWsOrigin(req)) return socket.close(4403, 'Bad origin.');
    if (!wsAuthed(req)) return socket.close(4401, 'Please sign in.');
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
      if (!isAllowedWsOrigin(req)) return socket.close(4403, 'Bad origin.');
      if (!wsAuthed(req)) return socket.close(4401, 'Please sign in.');
      if (!getSettings().webTerminal) return socket.close(4403, 'The web terminal is turned off.');
      const id = (req.params as { id: string }).id;
      if (!isValidAppId(id)) return socket.close(4400, 'Invalid app id.');
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
