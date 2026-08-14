// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Platform/system info for Settings → Advanced: network details, the AGPL
 * "Source code" link (CLAUDE.md §3 network clause), and the core update check.
 */
import os from 'node:os';
import { spawn } from 'node:child_process';
import { PORT, MACHINE_HOSTNAME } from '../config';
import { VERSION } from '../version';
import { log } from '../logger';
import { getSettings } from '../settings/store';
import { versionCheckUrl, osBranch, type Channel } from './channel';
import { isNewerVersion, isPrerelease } from '../util/version';

// A tiny image with a shell to chroot into the host. Reuses the backup image so
// it's likely already present; override for air-gapped installs.
const HOST_HELPER_IMAGE = process.env.OPENMASJID_BACKUP_IMAGE ?? 'alpine';

/**
 * Reboot the HOST machine. The core runs in a container, so it can't reboot the
 * host directly — it launches a one-shot privileged helper in the host PID
 * namespace that chroots into the host root (`/proc/1/root`) and runs the host's
 * own reboot binary. Fire-and-forget: the machine goes down before the helper
 * would report back. Requires the Docker socket (which the core already has).
 */
export function rebootHost(): void {
  log.warn('Reboot requested — rebooting the host machine.');
  const child = spawn(
    'docker',
    [
      'run', '--rm', '--privileged', '--pid=host', HOST_HELPER_IMAGE,
      'chroot', '/proc/1/root', '/bin/sh', '-c',
      '/sbin/reboot || /usr/sbin/reboot || reboot',
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.on('error', (err) => log.error('Could not start the reboot helper.', err));
  child.unref();
}

export const SOURCE_URL = 'https://github.com/OpenMasjid-Solutions/OpenMasjidOS';

// The VERSION to compare against comes from the CHANNEL's branch (system/channel.ts):
// Stable compares with master, Development with dev.

export interface NetworkInfo {
  hostname: string;
  localDomain: string; // e.g. openmasjidos.local
  addresses: string[]; // LAN IPv4 addresses
  port: number;
}

export function networkInfo(): NetworkInfo {
  const addresses: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) addresses.push(ni.address);
    }
  }
  return {
    hostname: MACHINE_HOSTNAME,
    localDomain: `${MACHINE_HOSTNAME}.local`,
    addresses,
    port: PORT,
  };
}

export interface UpdateInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  sourceUrl: string;
  /** Which channel this was checked against. */
  channel: Channel;
  /** True when the running build is a Development prerelease (`0.50.0-dev.2`). */
  prerelease: boolean;
  /**
   * WHY an update is offered.
   *
   * `'channel'` means the running build belongs to the OTHER channel — a Stable build on
   * a masjid set to Development, or the reverse. That has to be offered no matter what
   * the version numbers say, and its target can legitimately be an older number (going
   * back to Stable always is).
   */
  reason: 'version' | 'channel' | null;
}

/**
 * Is there a newer core build on this masjid's channel?
 *
 * ONE path for both channels, which is the point. Development used to be special-cased
 * to `updateAvailable: false` because its VERSION file held the same string as
 * Stable's — the branch moved but the number didn't, so a semver check could only ever
 * either say nothing (silence, forever) or say "maybe" (a permanent nag that meant
 * nothing). Neither is a usable answer, and the workaround was a separate manual
 * "pull the latest Development build" action that couldn't tell you whether there WAS
 * one.
 *
 * Development now publishes prerelease versions (`0.50.0-dev.2`) from the dev branch's
 * own VERSION file, so this comparison is meaningful on both channels and the answer
 * is the same kind of fact: a specific newer version, or nothing.
 */
export async function checkForUpdate(): Promise<UpdateInfo> {
  const channel = getSettings().updateChannel;
  let latest: string | null = null;
  try {
    const res = await fetch(versionCheckUrl(channel), {
      headers: { accept: 'text/plain' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const raw = (await res.text()).trim();
      // Accepts a prerelease suffix — `0.50.0-dev.2` must pass, or the dev channel
      // reads its own VERSION file as unusable and goes quiet again.
      if (/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(raw)) latest = raw;
    }
  } catch (err) {
    log.warn(`Update check failed against ${osBranch(channel)} (offline?).`, err);
  }
  // The build we are RUNNING belongs to the other channel. This must be offered whatever
  // the numbers say, and `runUpdate` has always acted on it (`wrongChannel`) — but the
  // DETECTOR did not, so nothing ever told the masjid. A box that had ended up on a
  // Stable image while set to Development therefore sat there for ever: no banner, no
  // alert, no update, and no explanation. That is not hypothetical — it happened, when an
  // interrupted update was repaired with the installer and the repair pulled `:latest`.
  //
  // Keeping this out of the version comparison also means it survives a numbering
  // mistake: even with `dev/VERSION` accidentally BELOW the current release (which is how
  // the box above got stuck), the mismatch alone is enough to offer the way back.
  const channelMismatch = isPrerelease(VERSION) !== (channel === 'dev');
  const newerAvailable = latest != null && isNewerVersion(VERSION, latest);
  return {
    current: VERSION,
    latest,
    // A channel move needs a target to move TO, so it still requires the channel's
    // version to have been read — offering an update we cannot perform would be worse
    // than staying quiet.
    updateAvailable: newerAvailable || (channelMismatch && latest != null),
    sourceUrl: SOURCE_URL,
    channel,
    prerelease: isPrerelease(VERSION),
    reason: newerAvailable ? 'version' : channelMismatch && latest != null ? 'channel' : null,
  };
}
