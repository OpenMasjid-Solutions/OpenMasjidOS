// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
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
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { docker } from './client';
import { DATA_DIR } from '../config';
import { log } from '../logger';
import { getSettings } from '../settings/store';
import { coreImageTag, coreTargetTag } from '../system/channel';
import { checkForUpdate } from '../system/system';
import { isPrerelease } from '../util/version';
import { withUpdateLock } from '../system/update-lock';

const CORE_CONTAINER = process.env.OPENMASJID_CONTAINER_NAME ?? 'openmasjid-core';
const CORE_PROJECT = process.env.OPENMASJID_PROJECT ?? 'openmasjid';
const CORE_REPO = 'ghcr.io/openmasjid-solutions/openmasjid-core';

/**
 * Retarget an image reference at a specific tag.
 *
 * The platform updates by pulling its OWN image (not by pulling git), so the update
 * target is expressed as a tag. We rewrite only the tag and keep whatever
 * repo/registry the container was actually started from, so a masjid running a private
 * mirror keeps their registry and just changes what they pull.
 *
 * A digest-pinned reference (`repo@sha256:…`) is left ALONE: the operator pinned it
 * deliberately, and silently converting that to a moving tag would undo the pin.
 */
function retarget(image: string, tag: string): string {
  if (image.includes('@')) return image;
  // Split off the tag without mangling a registry port (host:5000/repo:tag).
  const slash = image.lastIndexOf('/');
  const colon = image.lastIndexOf(':');
  const repo = colon > slash ? image.slice(0, colon) : image;
  return `${repo}:${tag}`;
}

/**
 * Point the core's OWN compose file at a specific image tag.
 *
 * This is the other half of a channel switch, and without it the platform could never
 * actually run a Development build. `recreateCore` recreates the core with
 * `docker compose -f /data/docker-compose.yml up -d --force-recreate`, and the
 * installer writes that file with a hardcoded `image: …/openmasjid-core:latest`
 * (`IMAGE=` in install.sh). So we pulled `:dev`, then started `:latest` again — the
 * pull was wasted and the box stayed on Stable while the dashboard said Development.
 * That is exactly the "I'm on the latest and have dev mode on" report.
 *
 * Rewrites ONLY the core service's image line, in place, leaving the rest of the
 * file byte-identical: it carries the mounts, ports and env a masjid depends on, and
 * regenerating it here would be a second source of truth alongside the installer.
 *
 * Leaves a digest-pinned reference alone, for the same reason `retarget` does — an
 * operator who pinned it meant it.
 *
 * Returns true if the file now names the wanted tag (including "already did").
 */
export function alignComposeImage(want: string): boolean {
  const file = path.join(DATA_DIR, 'docker-compose.yml');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    // No compose file: local dev, or an install that never wrote one. Nothing to do
    // — `recreateCore` will fail visibly on its own rather than us guessing.
    return false;
  }
  // Match the core image line specifically: our repo name, optional tag, at the
  // start of a line's value. Anchored to the repo so nothing else in the file can
  // be caught (an app's image, a comment, a volume path).
  // Group 3 captures the reference suffix as written: `:tag`, `@sha256:…`, or absent.
  // Matching BOTH forms matters — an earlier version only matched `:tag`, so a
  // digest-pinned line failed to match at all and was reported as "image line not
  // found", which is both wrong and alarming in the log.
  const re = /^(\s*image:\s*)(\S*openmasjid-core)(:[^\s@]+|@\S+)?(\s*)$/m;
  const m = re.exec(text);
  if (!m) {
    log.warn('Could not find the core image line in docker-compose.yml — leaving it alone.');
    return false;
  }
  const suffix = m[3] ?? '';
  if (suffix.startsWith('@')) {
    log.info('The core image is pinned to a digest — leaving it as the operator set it.');
    return true;
  }
  if (suffix === `:${want}`) return true; // already correct
  const next = text.replace(re, `$1$2:${want}$4`);
  try {
    fs.writeFileSync(file, next, 'utf8');
    log.info(`Pointed the core's compose file at :${want}.`);
    return true;
  } catch (err) {
    log.error('Could not update docker-compose.yml with the wanted image tag.', err);
    return false;
  }
}

async function inspectSelf(tag: string): Promise<{ image: string; hostDataDir: string | null }> {
  const fallback = `${CORE_REPO}:${tag}`;
  try {
    const info = await docker.getContainer(CORE_CONTAINER).inspect();
    const running = info.Config?.Image;
    const mount = (info.Mounts ?? []).find((m) => m.Destination === '/data');
    return {
      image: running ? retarget(running, tag) : fallback,
      hostDataDir: mount?.Source ?? null,
    };
  } catch {
    return { image: fallback, hostDataDir: null };
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
 *
 * `tag` is the image tag to come back on. Omitted (restore) it defaults to the
 * channel's moving alias, which is what restore has always done: a restored box has
 * no particular build in mind, and the alias resolves to the newest one on its
 * channel. The live update passes the exact version it just pulled.
 */
export async function recreateCore(onLine: (s: string) => void, tag?: string): Promise<boolean> {
  const want = tag ?? coreImageTag(getSettings().updateChannel);
  const { image, hostDataDir } = await inspectSelf(want);
  // Must happen BEFORE the compose up below, or it recreates from the old tag.
  alignComposeImage(want);
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
 *  has been launched (the core will then be restarted under us).
 *
 *  Single-flight: a second call while one is in flight is REFUSED, not queued. Two
 *  helpers each running `compose up --force-recreate` against the same container is how
 *  a box ends up not coming back — see `system/update-lock.ts`. */
export async function runUpdate(onLine: (s: string) => void): Promise<void> {
  return withUpdateLock('core', 'An update is already running. It will finish on its own.', () =>
    runUpdateInner(onLine),
  );
}

async function runUpdateInner(onLine: (s: string) => void): Promise<void> {
  const channel = getSettings().updateChannel;

  onLine('Checking for the latest version…');
  // Ask which version we're going to, and pull THAT — on Development, `:dev` is a
  // moving alias that can still point at the previous build while a new one publishes,
  // so pulling it can install different bytes from the version just announced.
  // Offline, `latest` is null and this falls back to the channel alias.
  const info = await checkForUpdate().catch(() => null);

  // Refuse to "update" to what is already running. Without this, every connection to
  // /api/update performs a full pull + recreate, and the recreate restarts the core —
  // which drops every in-memory session, signs the dashboard out, and unmounts the
  // window that opened the stream. Signing back in remounted it and started the whole
  // thing again: an endless revert loop after returning to Stable, escapable only by
  // closing the window in the seconds before the restart landed.
  //
  // A CHANNEL MOVE still has to proceed even when the version says otherwise, and the
  // running build states its own channel exactly: a Development build's version is a
  // prerelease and a Stable one is not. dev→main is prerelease→release (which semver
  // already calls an upgrade), but main→dev is release→prerelease, which it does not —
  // so without this the platform would refuse to follow its own channel switch.
  if (info) {
    const runningIsDev = isPrerelease(info.current);
    const wrongChannel = runningIsDev !== (channel === 'dev');
    if (!info.updateAvailable && !wrongChannel) {
      onLine('');
      onLine(`OpenMasjidOS is already up to date (v${info.current}). Nothing was changed.`);
      return;
    }
  }
  const tag = coreTargetTag(channel, info?.latest ?? null);
  const pinned = tag !== coreImageTag(channel);
  const { image } = await inspectSelf(tag);

  onLine(`Downloading ${image}`);
  const pullCode = await streamSpawn('docker', ['pull', image], onLine);
  if (pullCode !== 0) {
    onLine('');
    if (pinned) {
      // Distinguish the two real causes. A version we were told about but whose image
      // isn't in the registry yet is a build still in flight, not a broken network,
      // and telling someone to check their internet sends them after the wrong thing.
      onLine(`Could not download version ${tag}.`);
      // Deliberately no duration. This said "wait a few minutes" and a real build once
      // hung for nearly two hours, so the message sent someone back to retry repeatedly
      // against something that was never going to appear.
      onLine("That version hasn't finished publishing yet. Try again a little later.");
    } else {
      onLine('Could not download the update. Please check the internet connection and try again.');
    }
    return;
  }

  onLine('');
  onLine('Download complete. Applying the update and restarting…');
  if (!(await recreateCore(onLine, tag))) {
    onLine('Could not start the updater. You can update by re-running the installer.');
    return;
  }

  onLine('');
  onLine('The dashboard is restarting now — this page will reconnect automatically.');
}
