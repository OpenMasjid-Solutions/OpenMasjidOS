/**
 * Self-update of the core. A container can't cleanly recreate itself, so we:
 *   1. `docker pull` the latest image (streamed live to the UI), then
 *   2. launch a DETACHED helper container (the freshly-pulled image already has
 *      docker + compose) that recreates the core via the installer's compose
 *      file. The helper survives the core's restart and finishes the job.
 *
 * Apps are separate compose projects and are never touched (CLAUDE.md golden
 * rule): we only act on the core's own project.
 */
import { spawn } from 'node:child_process';
import { docker } from './client';

const CORE_CONTAINER = process.env.OPENMASJID_CONTAINER_NAME ?? 'openmasjid-core';
const CORE_PROJECT = process.env.OPENMASJID_PROJECT ?? 'openmasjid';
const DEFAULT_IMAGE = 'ghcr.io/openmasjid-solutions/openmasjid-core:latest';

async function inspectSelf(): Promise<{ image: string; hostDataDir: string | null }> {
  try {
    const info = await docker.getContainer(CORE_CONTAINER).inspect();
    const image = info.Config?.Image ?? DEFAULT_IMAGE;
    const mount = (info.Mounts ?? []).find((m) => m.Destination === '/data');
    return { image, hostDataDir: mount?.Source ?? null };
  } catch {
    return { image: DEFAULT_IMAGE, hostDataDir: null };
  }
}

export function streamSpawn(cmd: string, args: string[], onLine: (s: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args);
    const handle = (buf: Buffer) => {
      // docker pull uses \r to redraw progress; split on either so each update
      // is its own clean line in the log window.
      for (const line of buf.toString().split(/[\r\n]+/)) {
        if (line.trim()) onLine(line);
      }
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('error', (err) => {
      onLine(`Error: ${err.message}`);
      resolve(-1);
    });
    child.on('close', (code) => resolve(code ?? -1));
  });
}

/**
 * Recreate the core via a DETACHED helper container (it survives the core's
 * restart). Used by both the live update and restore. Returns true once the
 * helper is launched; the core will then be restarted under us.
 */
export async function recreateCore(onLine: (s: string) => void): Promise<boolean> {
  const { image, hostDataDir } = await inspectSelf();
  const args = ['run', '-d', '--rm', '-v', '/var/run/docker.sock:/var/run/docker.sock'];
  if (hostDataDir) args.push('-v', `${hostDataDir}:/data`);
  args.push(
    '--entrypoint',
    'sh',
    image,
    '-c',
    `sleep 2; docker compose -p ${CORE_PROJECT} -f /data/docker-compose.yml up -d --force-recreate`,
  );
  const code = await streamSpawn('docker', args, onLine);
  return code === 0;
}

/** Run the update, streaming progress through onLine. Resolves once the helper
 *  has been launched (the core will then be restarted under us). */
export async function runUpdate(onLine: (s: string) => void): Promise<void> {
  const { image } = await inspectSelf();

  onLine('Checking for the latest version…');
  onLine(`Downloading ${image}`);
  const pullCode = await streamSpawn('docker', ['pull', image], onLine);
  if (pullCode !== 0) {
    onLine('');
    onLine('Could not download the update. Please check the internet connection and try again.');
    return;
  }

  onLine('');
  onLine('Download complete. Applying the update and restarting…');
  if (!(await recreateCore(onLine))) {
    onLine('Could not start the updater. You can update by re-running the installer.');
    return;
  }

  onLine('');
  onLine('The dashboard is restarting now — this page will reconnect automatically.');
}
