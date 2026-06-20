/**
 * Interactive shells via the Docker Engine API exec with a TTY — no native PTY
 * module needed. Docker allocates the pseudo-terminal on the container side; we
 * bridge the hijacked duplex stream to a WebSocket (see api/terminals.ts).
 *
 * Two targets: the core itself (root terminal) and an installed app's container
 * (per-app shell). Both are gated by settings + auth at the WS route.
 */
import os from 'node:os';
import type { Duplex } from 'node:stream';
import { docker } from './client';

const CORE_CONTAINER = process.env.OPENMASJID_CONTAINER_NAME ?? 'openmasjid-core';

export interface TermSession {
  stream: Duplex;
  resize: (cols: number, rows: number) => void;
  close: () => void;
}

async function startExec(containerId: string): Promise<TermSession> {
  const container = docker.getContainer(containerId);
  const exec = await container.exec({
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    // Prefer bash if present, otherwise sh — works on Alpine and Debian alike.
    Cmd: ['/bin/sh', '-c', 'exec "$(command -v bash || command -v sh)"'],
    Env: ['TERM=xterm-256color'],
  });
  // With Tty:true the stream is raw (not stdout/stderr multiplexed).
  const stream = (await exec.start({ hijack: true, stdin: true, Tty: true })) as unknown as Duplex;
  return {
    stream,
    resize: (cols, rows) => {
      exec.resize({ w: cols, h: rows }).catch(() => {});
    },
    close: () => {
      try {
        stream.end();
      } catch {
        /* already closed */
      }
    },
  };
}

/** Root shell into the OpenMasjidOS core container. */
export function rootTerminal(): Promise<TermSession> {
  // The container_name set by the installer is the most reliable handle; fall
  // back to this process's hostname (the container id) if that ever changes.
  const target = CORE_CONTAINER || os.hostname();
  return startExec(target);
}

/** Shell into an installed app's first running container. */
export async function appTerminal(appId: string): Promise<TermSession> {
  const project = `omos-${appId}`;
  const list = await docker.listContainers({
    filters: { label: [`com.docker.compose.project=${project}`] },
  });
  const id = list[0]?.Id;
  if (!id) throw new Error('That app has no running container to open a shell in.');
  return startExec(id);
}
