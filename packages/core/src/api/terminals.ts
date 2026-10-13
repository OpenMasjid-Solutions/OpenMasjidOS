// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
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
import { wsAuthed, requestCsrfOk, requestUser } from './ws-auth';
import { log } from '../logger';

function clampDim(n: unknown): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return 80;
  return Math.max(1, Math.min(1000, v));
}

/**
 * What the browser sent, and whether it left, while its shell was being started (two
 * Docker round trips). Without this a message arriving then had no listener and was
 * dropped — the first resize, so the shell started at the wrong size — and a socket
 * closed then never reached bridge's 'close', so the started shell leaked.
 */
interface EarlyTraffic {
  messages: Buffer[];
  closed: boolean;
  release: () => void;
}
const early = new WeakMap<WebSocket, EarlyTraffic>();

export function holdUntilBridged(socket: WebSocket): void {
  const held: EarlyTraffic = { messages: [], closed: false, release: () => {} };
  const onMessage = (data: Buffer) => held.messages.push(data);
  const onClose = () => {
    held.closed = true;
  };
  socket.on('message', onMessage);
  socket.on('close', onClose);
  held.release = () => {
    socket.off('message', onMessage);
    socket.off('close', onClose);
    early.delete(socket);
  };
  early.set(socket, held);
}

/**
 * Pipe a terminal session to a socket. `stillAllowed` is asked before every keystroke
 * reaches the shell: a terminal is one request that can last all day, and checking
 * only when it opened let a root shell opened from outside go on taking input after
 * the admin turned remote administration off, signed out, or changed the password.
 */
export function bridge(socket: WebSocket, session: TermSession, stillAllowed: () => boolean): void {
  const held = early.get(socket);
  held?.release();
  if (held?.closed || socket.readyState !== socket.OPEN) {
    session.close(); // the browser left while the shell was starting
    return;
  }
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
  const onMessage = (data: Buffer) => {
    if (!stillAllowed()) {
      try {
        socket.close(4401, 'Please sign in.');
      } catch {
        /* already closed */
      }
      return;
    }
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
  };
  socket.on('message', onMessage);
  socket.on('close', () => session.close());
  // Synchronously, so nothing sent later can overtake what was held.
  for (const data of held?.messages ?? []) onMessage(data);
}

export function registerTerminals(server: FastifyInstance): void {
  server.get('/api/terminal/root', { websocket: true }, async (socket: WebSocket, req: FastifyRequest) => {
    if (!isAllowedWsOrigin(req)) return socket.close(4403, 'Bad origin.');
    if (!wsAuthed(req)) return socket.close(4401, 'Please sign in.');
    if (!requestCsrfOk(req)) return socket.close(4403, 'This request came from an unexpected place.');
    if (!getSettings().rootTerminal) return socket.close(4403, 'Root terminal is turned off.');
    holdUntilBridged(socket);
    try {
      bridge(socket, await rootTerminal(), () => Boolean(requestUser(req)) && getSettings().rootTerminal);
    } catch (err) {
      early.get(socket)?.release();
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
      if (!requestCsrfOk(req)) return socket.close(4403, 'This request came from an unexpected place.');
      if (!getSettings().webTerminal) return socket.close(4403, 'The web terminal is turned off.');
      const id = (req.params as { id: string }).id;
      if (!isValidAppId(id)) return socket.close(4400, 'Invalid app id.');
      holdUntilBridged(socket);
      try {
        bridge(socket, await appTerminal(id), () => Boolean(requestUser(req)) && getSettings().webTerminal);
      } catch (err) {
        early.get(socket)?.release();
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
