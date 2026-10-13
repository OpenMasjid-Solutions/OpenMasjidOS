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
import { HOLD_UNTIL_REPLACED_MS, withUpdateLock } from '../system/update-lock';
import { managesFromOutside } from '../system/remote-admin';
import { backupInProgress } from '../system/backup';
import { VERSION } from '../version';

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

/** The core's image line in its own compose file: our repo, then `:tag`, `@digest` or nothing. */
const CORE_IMAGE_LINE = /^(\s*image:\s*)(\S*openmasjid-core)(:[^\s@]+|@\S+)?(\s*)$/m;
const COMPOSE_FILE = path.join(DATA_DIR, 'docker-compose.yml');

/** The image reference the core's compose file names (`repo:tag` or `repo@digest`), or null. */
export function composeImageRef(): string | null {
  try {
    const m = CORE_IMAGE_LINE.exec(fs.readFileSync(COMPOSE_FILE, 'utf8'));
    return m ? `${m[2]}${m[3] ?? ''}` : null;
  } catch {
    return null;
  }
}

/**
 * Point the core's OWN compose file at a specific image tag.
 *
 * This is the other half of a channel switch, and without it the platform could never
 * actually run a Development build. `recreateCore` recreates the core with
 * `docker compose -f /data/docker-compose.yml up -d --force-recreate`, which starts the
 * image that file names, not the one just pulled. (When the installer still wrote it with
 * a hardcoded `:latest` — install.sh `resolve_image` decides now — we pulled `:dev`, then
 * started `:latest` again: the pull was wasted and the box stayed on Stable while the
 * dashboard said Development, the "I'm on the latest and have dev mode on" report.)
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
  const file = COMPOSE_FILE;
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
  const re = CORE_IMAGE_LINE;
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

/**
 * The image to run the helper from when the core must come back on EXACTLY what it is
 * running: the running container's own image, by ID — present locally for as long as
 * the container exists, whatever has happened to the tags since. If the container
 * cannot be inspected, the reference its compose file names, which is the build it was
 * last started from.
 */
async function inspectSelfAsIs(): Promise<{ image: string; hostDataDir: string | null }> {
  const fallback = composeImageRef() ?? `${CORE_REPO}:${coreImageTag(getSettings().updateChannel)}`;
  try {
    const info = await docker.getContainer(CORE_CONTAINER).inspect();
    const mount = (info.Mounts ?? []).find((m) => m.Destination === '/data');
    return { image: info.Image || info.Config?.Image || fallback, hostDataDir: mount?.Source ?? null };
  } catch {
    return { image: fallback, hostDataDir: null };
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
 * Make the core's compose file name EXACTLY the build that is running — for a restore,
 * which must come back on it.
 *
 * The file is not a reliable record of that. An update that pointed it at a new version
 * and then could not start its helper left it naming a build the core never ran (it is
 * put back now, below), and the installer's Update used to write it before pulling, so a
 * failed download left it naming the channel's alias — whatever build the installer had
 * last fetched. A restore that trusted the file brought the core back on another build:
 * from outside, possibly one with no remote dashboard. So the running image, by ID, is
 * tagged with the running VERSION and the file pointed at that tag. Left alone when the
 * line is pinned to a digest (the operator's choice) or the container cannot be
 * inspected (no Docker API: local development).
 */
async function pinComposeToRunningBuild(): Promise<void> {
  let ref: string | undefined;
  let id: string | undefined;
  try {
    const info = await docker.getContainer(CORE_CONTAINER).inspect();
    ref = info.Config?.Image;
    id = info.Image;
  } catch {
    return;
  }
  const named = composeImageRef();
  if (!ref || !id || ref.includes('@') || named === null || named.includes('@')) return;
  const tagged = retarget(named, VERSION);
  if ((await streamSpawn('docker', ['tag', id, tagged], () => undefined)) === 0) alignComposeImage(VERSION);
}

/**
 * Recreate the core via a DETACHED helper container (it survives the core's
 * restart). Used by both the live update and restore. Returns true once the
 * helper is launched; the core will then be restarted under us.
 *
 * `tag` is the image tag to come back on: the live update passes the exact version
 * it has just pulled. If the helper cannot be started, the compose file is put back
 * as it was, so "nothing was changed" stays true.
 *
 * Omitted (restore), the core comes back on EXACTLY THE BUILD IT IS RUNNING: the
 * compose file is pointed at it (`pinComposeToRunningBuild`) and the helper runs from
 * the running container's own image. A restore used to aim at the channel's alias
 * (`:latest`, `:dev`) without pulling it, and the alias names whatever build the
 * installer or a channel move whose version could not be read last fetched (every other
 * dashboard update pulls an exact version) — so
 * a restore could quietly put the box back on an older build: from outside, onto one
 * with no remote dashboard, locking the admin out of the very address the restore had
 * promised to keep.
 */
export async function recreateCore(onLine: (s: string) => void, tag?: string): Promise<boolean> {
  const { image, hostDataDir } = tag ? await inspectSelf(tag) : await inspectSelfAsIs();
  let before: string | null = null;
  try {
    before = fs.readFileSync(COMPOSE_FILE, 'utf8');
  } catch {
    /* no compose file: alignComposeImage says what that means */
  }
  // Must happen BEFORE the compose up below, or it recreates from the old reference. A file
  // that cannot be pointed at the new version would bring the old one back: stop here instead.
  if (tag) {
    if (!alignComposeImage(tag)) return false;
  } else await pinComposeToRunningBuild();
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
  if (code !== 0 && tag && before !== null) {
    // Nothing was recreated, so the file must not name the version we were going to: the
    // next restart that reads it — a restore's, or the installer's — would come back on
    // a build this core never ran.
    try {
      fs.writeFileSync(COMPOSE_FILE, before, 'utf8');
    } catch (err) {
      log.error('Could not put the core compose file back after the update could not start.', err);
    }
  }
  return code === 0;
}

/**
 * How an update ended, for the window watching it (api/update.ts turns it into the
 * socket's close code). `restarting`: the helper is replacing the core, so the window
 * waits for it to come back. `unchanged`: nothing was touched — already up to date, a
 * download that failed, a refusal — and the window says so at once. It used to treat
 * every ending as a restart, and sat locked on "restarting…" for three minutes after
 * an update that had changed nothing.
 */
export type UpdateOutcome = 'restarting' | 'unchanged';

/** Run the update, streaming progress through onLine. Resolves once the helper
 *  has been launched (the core will then be restarted under us).
 *
 *  Single-flight: a second call while one is in flight is REFUSED, not queued. Two
 *  helpers each running `compose up --force-recreate` against the same container is how
 *  a box ends up not coming back — see `system/update-lock.ts`.
 *
 *  `remote`: started from the remote dashboard, which may only move the box to a version
 *  that can itself be managed from outside (system/remote-admin.ts `managesFromOutside`). */
export async function runUpdate(onLine: (s: string) => void, opts: { remote?: boolean } = {}): Promise<UpdateOutcome> {
  // Held past the hand-off to the helper: the old core runs on for some seconds, and work
  // started then would be cut off when it is replaced (system/update-lock.ts).
  return withUpdateLock('core', 'An update is already running. It will finish on its own.', () => runUpdateInner(onLine, opts), {
    holdAfter: (outcome) => (outcome === 'restarting' ? HOLD_UNTIL_REPLACED_MS : 0),
  });
}

/** A backup being made dies with the core it runs in — off-site, leaving part of an archive
 *  on the NAS to be counted as a good one. So the update waits for it, and says so. */
function backupInTheWay(onLine: (s: string) => void): boolean {
  if (!backupInProgress()) return false;
  onLine('');
  onLine('A backup is being made right now. Please update OpenMasjidOS once it has finished. Nothing was changed.');
  return true;
}

async function runUpdateInner(onLine: (s: string) => void, opts: { remote?: boolean }): Promise<UpdateOutcome> {
  const channel = getSettings().updateChannel;
  if (backupInTheWay(onLine)) return 'unchanged';

  onLine('Checking for the latest version…');
  // Ask which version we're going to, and pull THAT — on Development, `:dev` is a
  // moving alias that can still point at the previous build while a new one publishes,
  // so pulling it can install different bytes from the version just announced.
  // Offline, `latest` is null and this falls back to the channel alias.
  const info = await checkForUpdate().catch(() => null);

  // Refuse to "update" to what is already running. Without this, every connection to
  // /api/update performs a full pull + recreate, and the recreate restarts the core —
  // which (while sessions lived only in memory) signed the dashboard out and unmounted the
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
    // The newest version could not be read. Nothing is pulled — that guard is what stops
    // the loop above — but "already up to date" would be the window asserting something
    // nobody knows, and it was what an admin read after pressing "Update now" for a
    // version found a moment earlier, when the next check happened to fail.
    if (info.latest === null && !wrongChannel) {
      onLine('');
      onLine("Couldn't check for the latest version just now, so nothing was changed.");
      onLine('Please check the internet connection and try again in a little while.');
      return 'unchanged';
    }
    if (!info.updateAvailable && !wrongChannel) {
      onLine('');
      onLine(`OpenMasjidOS is already up to date (v${info.current}). Nothing was changed.`);
      return 'unchanged';
    }
  }
  // From OUTSIDE, only to a version that can be managed from outside. Going back to
  // Stable before Stable had remote administration would otherwise bring the core back
  // with no remote dashboard at all, and this window — every window from outside — cut
  // off until someone at the masjid moved it on again. A version that could not be read
  // is refused too: from out there, nobody could put a wrong guess right.
  if (opts.remote) {
    const target = info?.latest ?? null;
    if (target === null) {
      onLine('');
      onLine("Couldn't check which version this would install, so it can't be done from outside right now.");
      onLine('Please try again in a little while. Nothing was changed.');
      return 'unchanged';
    }
    if (!managesFromOutside(target)) {
      onLine('');
      onLine(`Version ${target} can't be managed from outside the masjid, so installing it from here would cut you off.`);
      onLine('Please do this at the masjid. Nothing was changed.');
      return 'unchanged';
    }
  }
  // Pinned to one exact build (a digest on the compose line — the operator's choice, which
  // alignComposeImage leaves alone): an update would pull that same build and restart the
  // dashboard onto it, for nothing, every time it was pressed.
  if (composeImageRef()?.includes('@')) {
    onLine('');
    onLine("OpenMasjidOS is pinned to one exact build on this machine, so it can't update itself from here. Nothing was changed.");
    return 'unchanged';
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
    return 'unchanged';
  }

  // Asked again: one may have started during the download.
  if (backupInTheWay(onLine)) return 'unchanged';
  onLine('');
  onLine('Download complete. Applying the update and restarting…');
  if (!(await recreateCore(onLine, tag))) {
    onLine('Could not start the updater. You can update by re-running the installer.');
    return 'unchanged';
  }

  onLine('');
  onLine('The dashboard is restarting now — this page will reconnect automatically.');
  return 'restarting';
}
